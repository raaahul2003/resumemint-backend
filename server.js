require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const crypto = require("crypto");

const app = express();

// ─── CORS ────────────────────────────────────────────────
app.use(cors({
  origin: [
    "https://resumemint-frontend.vercel.app",
    "https://atsresumemint.vercel.app",
    "http://localhost:3000"
  ],
  methods: ["GET","POST"],
  allowedHeaders: ["Content-Type","Authorization"]
}));
app.use(express.json({ limit: "2mb" }));

// ─── MONGODB ─────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB Connected ✅"))
  .catch(err => console.log("Mongo Error:", err));

const PaymentSchema = new mongoose.Schema({
  orderId:     { type: String, required: true, unique: true },
  paymentId:   { type: String },
  signature:   { type: String },
  status:      { type: String, default: "created" }, // created | paid | failed
  name:        { type: String },
  email:       { type: String },
  downloadToken: { type: String },
  amount:      { type: Number, default: 900 },
  createdAt:   { type: Date, default: Date.now },
});
const Payment = mongoose.model("Payment", PaymentSchema);

// ─── RAZORPAY ────────────────────────────────────────────
const Razorpay = require("razorpay");
const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_SECRET,
});

// ─── RATE LIMITER ────────────────────────────────────────
const attempts = {};
function rateLimit(key, max = 5, windowMs = 60000) {
  const now = Date.now();
  if (!attempts[key]) attempts[key] = [];
  attempts[key] = attempts[key].filter(t => now - t < windowMs);
  if (attempts[key].length >= max) return false;
  attempts[key].push(now);
  return true;
}

// ─── HEALTH CHECK ────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ResumeMint Backend Running ✅",
    time: new Date().toISOString(),
    db: mongoose.connection.readyState === 1 ? "connected" : "disconnected"
  });
});

// ─── CREATE ORDER ─────────────────────────────────────────
app.post("/create-order", async (req, res) => {
  const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
  if (!rateLimit(`order_${ip}`, 5, 60000)) {
    return res.status(429).json({ error: "Too many requests. Try after 1 minute." });
  }
  try {
    const options = {
      amount: 900,           // ₹9 in paise
      currency: "INR",
      receipt: "rm_" + Date.now(),
    };
    const order = await razorpay.orders.create(options);
    // Save order to DB
    await Payment.create({ orderId: order.id });
    res.json(order);
  } catch (err) {
    console.error("Create order error:", err);
    res.status(500).json({ error: "Could not create payment order" });
  }
});

// ─── VERIFY PAYMENT ──────────────────────────────────────
app.post("/verify-payment", async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, name, email } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ success: false, error: "Missing payment fields" });
  }

  // HMAC verification
  const body = razorpay_order_id + "|" + razorpay_payment_id;
  const expectedSig = crypto
    .createHmac("sha256", process.env.RAZORPAY_SECRET)
    .update(body)
    .digest("hex");

  if (expectedSig !== razorpay_signature) {
    await Payment.findOneAndUpdate(
      { orderId: razorpay_order_id },
      { status: "failed" }
    );
    return res.status(400).json({ success: false, error: "Invalid signature" });
  }

  // Generate secure download token
  const downloadToken = crypto.randomBytes(32).toString("hex");

  await Payment.findOneAndUpdate(
    { orderId: razorpay_order_id },
    {
      paymentId: razorpay_payment_id,
      signature: razorpay_signature,
      status: "paid",
      name: name || "",
      email: email || "",
      downloadToken,
    },
    { new: true }
  );

  console.log(`✅ Payment verified: ${razorpay_payment_id} | ${name} | ${email}`);
  res.json({ success: true, token: downloadToken });
});

// ─── PDF GENERATION ──────────────────────────────────────
// Uses puppeteer if available, otherwise returns HTML for browser print
app.post("/generate-pdf", async (req, res) => {
  const { token, form, templateId } = req.body;

  // Validate token
  if (!token) {
    return res.status(401).json({ error: "No download token" });
  }
  const payment = await Payment.findOne({ downloadToken: token, status: "paid" });
  if (!payment) {
    return res.status(403).json({ error: "Invalid or expired token" });
  }

  try {
    // Try to generate PDF with puppeteer if installed
    const puppeteer = require("puppeteer");
    const browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      headless: "new"
    });
    const page = await browser.newPage();

    // Build minimal HTML from form data for the selected template
    const html = buildResumeHTML(form, templateId);
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({
      format: "A4",
      margin: { top: "15mm", bottom: "15mm", left: "15mm", right: "15mm" },
      printBackground: true,
    });
    await browser.close();

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${(form.name||"resume").replace(/\s+/g,"_")}_ResumeMint.pdf"`,
    });
    res.send(pdf);
  } catch (e) {
    // Puppeteer not installed — return 501 so frontend falls back to print
    console.log("Puppeteer not available, returning 501:", e.message);
    res.status(501).json({ error: "PDF generation not configured. Use browser print." });
  }
});

function buildResumeHTML(form, templateId) {
  const name = form?.name || "Your Name";
  const email = form?.email || "";
  const phone = form?.phone || "";
  const location = form?.location || "";
  const linkedin = form?.linkedin || "";
  const summary = form?.summary || "";
  const edu = form?.education?.[0] || {};
  const exp = form?.experience?.[0] || {};
  const skills = form?.skills?.technical || "";
  const projects = form?.projects || [];
  const certs = form?.certifications || "";

  const bullets = exp.bullets?.split("\n").filter(Boolean)
    .map(b => `<li>${b}</li>`).join("") || "";

  const projHTML = projects.filter(p => p.name).map(p =>
    `<div style="margin-bottom:8px"><strong>${p.name}</strong>${p.tech ? ` <span style="color:#666;font-size:10px">| ${p.tech}</span>` : ""}<div style="font-size:11px">${p.description || ""}</div></div>`
  ).join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
  <style>
    body{font-family:Georgia,serif;font-size:11px;color:#1a1a2e;padding:0;margin:0;line-height:1.6}
    .name{font-family:Outfit,sans-serif;font-size:22px;font-weight:900;margin-bottom:4px}
    .contact{font-size:10px;color:#666;margin-bottom:6px;display:flex;gap:14px;flex-wrap:wrap}
    .divider{border-top:2px solid #0ea96e;margin:10px 0 8px}
    .sh{font-size:10px;font-weight:700;color:#0ea96e;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:4px;margin-top:10px}
    .thin{border-top:1px solid #eee;margin:4px 0}
    ul{margin-left:14px;list-style-type:disc}
  </style>
  </head><body>
  <div class="name">${name}</div>
  <div class="contact">
    ${email ? `<span>✉ ${email}</span>` : ""}
    ${phone ? `<span>✆ ${phone}</span>` : ""}
    ${location ? `<span>⊙ ${location}</span>` : ""}
    ${linkedin ? `<span>in ${linkedin}</span>` : ""}
  </div>
  <div class="divider"></div>
  ${summary ? `<div class="sh">Professional Summary</div><div class="thin"></div><p style="margin-bottom:10px">${summary}</p>` : ""}
  ${edu.degree ? `<div class="sh">Education</div><div class="thin"></div><div style="display:flex;justify-content:space-between;margin-bottom:8px"><div><strong>${edu.degree}</strong><div style="color:#666;font-size:10px">${edu.school||""}</div></div><div style="text-align:right;color:#666;font-size:10px">${edu.year||""}<br>${edu.gpa||""}</div></div>` : ""}
  ${exp.role ? `<div class="sh">Work Experience</div><div class="thin"></div><div style="margin-bottom:10px"><div style="display:flex;justify-content:space-between"><strong>${exp.role}${exp.company ? ` — ${exp.company}` : ""}</strong><span style="color:#666;font-size:10px">${exp.duration||""}</span></div><ul>${bullets}</ul></div>` : ""}
  ${projHTML ? `<div class="sh">Projects</div><div class="thin"></div>${projHTML}` : ""}
  ${skills ? `<div class="sh">Skills</div><div class="thin"></div><div><strong>Technical: </strong>${skills}</div>` : ""}
  ${certs ? `<div class="sh">Certifications</div><div class="thin"></div><ul>${certs.split("\n").filter(Boolean).map(c=>`<li>${c}</li>`).join("")}</ul>` : ""}
  </body></html>`;
}

// ─── AI PROXY (keeps API key server-side) ────────────────
app.post("/ai-job-match", async (req, res) => {
  const ip = req.ip || "unknown";
  if (!rateLimit(`ai_${ip}`, 5, 60000)) {
    return res.status(429).json({ error: "Too many AI requests. Try after 1 minute." });
  }
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "AI request failed" });
  }
});

// ─── ADMIN STATS ─────────────────────────────────────────
app.get("/admin/stats", async (req, res) => {
  const key = req.headers["x-admin-key"];
  if (key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const total = await Payment.countDocuments({ status: "paid" });
    const revenue = total * 9;
    const today = new Date(); today.setHours(0,0,0,0);
    const todayCount = await Payment.countDocuments({ status:"paid", createdAt:{ $gte: today } });
    const recent = await Payment.find({ status:"paid" })
      .sort({ createdAt: -1 }).limit(20)
      .select("name email paymentId createdAt amount");
    res.json({ total, revenue, today: todayCount, todayRevenue: todayCount * 9, recent });
  } catch (err) {
    res.status(500).json({ error: "DB error" });
  }
});

// ─── START ───────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));