require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const crypto = require("crypto");
const https = require("https");

const app = express();
app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type","Authorization","x-admin-key"] }));
app.use(express.json({ limit: "15mb" }));

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.log("❌ Mongo Error:", err));

const PaymentSchema = new mongoose.Schema({
  orderId:       { type: String, required: true, unique: true },
  paymentId:     { type: String, default: "" },
  signature:     { type: String, default: "" },
  status:        { type: String, default: "created" },
  name:          { type: String, default: "" },
  email:         { type: String, default: "" },
  downloadToken: { type: String, default: "" },
  amount:        { type: Number, default: 900 },
  createdAt:     { type: Date, default: Date.now },
});
const Payment = mongoose.model("Payment", PaymentSchema);

const Razorpay = require("razorpay");
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_SECRET,
});

// ── RATE LIMITER ──────────────────────────────────────────
const _hits = {};
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  if (!_hits[key]) _hits[key] = [];
  _hits[key] = _hits[key].filter(t => now - t < windowMs);
  if (_hits[key].length >= max) return false;
  _hits[key].push(now);
  return true;
}

// ── HTTPS helper ──────────────────────────────────────────
function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + (urlObj.search || ""),
      method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(bodyStr) }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(new Error("Invalid JSON: " + data.slice(0,300))); }
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── GEMINI API CALL ───────────────────────────────────────
// Uses Google Gemini 1.5 Flash — FREE tier: 15 req/min, 1500/day
async function callGemini(systemPrompt, userText, base64Data, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_NOT_CONFIGURED");

  const parts = [];

  // If file data provided (PDF/image upload)
  if (base64Data && mimeType) {
    parts.push({
      inline_data: { mime_type: mimeType, data: base64Data }
    });
  }

  parts.push({ text: systemPrompt + "\n\n" + userText });

  const body = {
    contents: [{ parts }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 2000,
    }
  };

  const result = await httpsPost(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    { "Content-Type": "application/json" },
    body
  );

  if (result.status === 429) throw new Error("QUOTA_EXCEEDED");
  if (result.status !== 200) {
    const errMsg = result.body?.error?.message || "Gemini error";
    throw new Error(errMsg);
  }

  const text = result.body?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) throw new Error("Empty response from Gemini");
  return text;
}

// ── ANTHROPIC API CALL ────────────────────────────────────
async function callAnthropic(reqBody) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_NOT_CONFIGURED");

  const result = await httpsPost(
    "https://api.anthropic.com/v1/messages",
    {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    reqBody
  );

  if (result.status === 429) throw new Error("QUOTA_EXCEEDED");
  if (result.status === 401) throw new Error("ANTHROPIC_AUTH_ERROR");
  if (result.status !== 200) {
    const errMsg = result.body?.error?.message || "Anthropic error";
    throw new Error(errMsg);
  }

  // Return in Anthropic format
  return result.body;
}

// ── SMART AI ROUTER ───────────────────────────────────────
// Tries Anthropic first, falls back to Gemini if quota exceeded
// Both are FREE (Anthropic has paid credits, Gemini has true free tier)
async function smartAI(reqBody) {
  let anthropicError = null;

  // Try Anthropic first (better quality)
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const result = await callAnthropic(reqBody);
      console.log("✅ Anthropic AI used");
      // Return in standard format
      return { text: result.content?.map(b => b.text || "").join("") || "", provider: "anthropic" };
    } catch(e) {
      anthropicError = e.message;
      if (e.message === "QUOTA_EXCEEDED" || e.message === "ANTHROPIC_AUTH_ERROR") {
        console.log("⚠️ Anthropic quota/auth failed, falling back to Gemini...");
      } else {
        throw e; // Real error, don't fallback
      }
    }
  }

  // Fallback to Gemini
  if (process.env.GEMINI_API_KEY) {
    try {
      // Convert Anthropic format to Gemini format
      const system = reqBody.system || "";
      const userMsg = reqBody.messages?.[0];
      let userText = "";
      let base64Data = null;
      let mimeType = null;

      if (typeof userMsg?.content === "string") {
        userText = userMsg.content;
      } else if (Array.isArray(userMsg?.content)) {
        // Handle multipart (document/image + text)
        for (const part of userMsg.content) {
          if (part.type === "text") userText = part.text;
          if (part.type === "document" || part.type === "image") {
            base64Data = part.source?.data;
            mimeType = part.source?.media_type;
          }
        }
      }

      const text = await callGemini(system, userText, base64Data, mimeType);
      console.log("✅ Gemini AI used (fallback)");
      return { text, provider: "gemini" };
    } catch(e) {
      if (e.message === "QUOTA_EXCEEDED") {
        throw new Error("AI_QUOTA_EXCEEDED");
      }
      throw e;
    }
  }

  // Both failed
  throw new Error(anthropicError || "No AI service configured. Please set ANTHROPIC_API_KEY or GEMINI_API_KEY.");
}

// ── HEALTH ────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "ResumeMint Backend ✅",
    db: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    ai: {
      anthropic: process.env.ANTHROPIC_API_KEY ? "configured" : "not set",
      gemini: process.env.GEMINI_API_KEY ? "configured" : "not set",
    },
    time: new Date().toISOString()
  });
});

// ── CREATE ORDER ──────────────────────────────────────────
app.post("/create-order", async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
  if (!rateLimit("order_" + ip, 10, 60000))
    return res.status(429).json({ error: "Too many requests. Try in 1 minute." });
  try {
    const order = await razorpay.orders.create({
      amount: 900, currency: "INR", receipt: "rm_" + Date.now()
    });
    await Payment.create({ orderId: order.id }).catch(() => {});
    console.log("✅ Order created:", order.id);
    res.json(order);
  } catch (err) {
    console.error("❌ Order error:", err.message);
    res.status(500).json({ error: "Could not create order: " + err.message });
  }
});

// ── CHECK PAYMENT (polling for QR/UPI) ───────────────────
app.post("/check-payment", async (req, res) => {
  const { order_id } = req.body;
  if (!order_id) return res.status(400).json({ paid: false });
  try {
    const payment = await Payment.findOne({ orderId: order_id });
    if (payment && payment.status === "paid") {
      return res.json({ paid: true, token: payment.downloadToken });
    }
    // Check Razorpay directly
    try {
      const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_SECRET}`).toString("base64");
      const rpResp = await new Promise((resolve, reject) => {
        const req2 = https.request({
          hostname: "api.razorpay.com",
          path: `/v1/orders/${order_id}/payments`,
          method: "GET",
          headers: { "Authorization": `Basic ${auth}` }
        }, (r) => {
          let d = ""; r.on("data", c => d += c);
          r.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
        });
        req2.on("error", reject); req2.end();
      });
      const captured = (rpResp.items || []).find(p => p.status === "captured" || p.status === "authorized");
      if (captured) {
        const token = crypto.randomBytes(32).toString("hex");
        await Payment.findOneAndUpdate({ orderId: order_id },
          { paymentId: captured.id, status: "paid", downloadToken: token },
          { upsert: true }).catch(() => {});
        console.log("✅ Payment captured via polling:", captured.id);
        return res.json({ paid: true, token });
      }
    } catch(e) { console.log("Razorpay check error:", e.message); }
    res.json({ paid: false });
  } catch (err) {
    res.json({ paid: false });
  }
});

// ── VERIFY PAYMENT ────────────────────────────────────────
app.post("/verify-payment", async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, name, email } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
    return res.status(400).json({ success: false, error: "Missing fields" });

  const expected = crypto.createHmac("sha256", process.env.RAZORPAY_SECRET)
    .update(razorpay_order_id + "|" + razorpay_payment_id).digest("hex");

  if (expected !== razorpay_signature)
    return res.status(400).json({ success: false, error: "Invalid signature" });

  const token = crypto.randomBytes(32).toString("hex");
  await Payment.findOneAndUpdate({ orderId: razorpay_order_id },
    { paymentId: razorpay_payment_id, signature: razorpay_signature,
      status: "paid", name: name || "", email: email || "", downloadToken: token },
    { upsert: true }).catch(() => {});

  console.log("✅ Payment verified:", razorpay_payment_id, name);
  res.json({ success: true, token });
});

// ── AI ENDPOINT (Anthropic + Gemini fallback) ─────────────
app.post("/ai-job-match", async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
  if (!rateLimit("ai_" + ip, 5, 60000))
    return res.status(429).json({ error: "Too many AI requests. Wait 1 minute." });

  try {
    const result = await smartAI(req.body);
    // Return in Anthropic-compatible format so frontend works unchanged
    res.json({
      content: [{ type: "text", text: result.text }],
      provider: result.provider
    });
  } catch (err) {
    console.error("❌ AI error:", err.message);
    if (err.message === "AI_QUOTA_EXCEEDED") {
      return res.status(429).json({ error: "AI_QUOTA_EXCEEDED" });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN STATS ───────────────────────────────────────────
app.get("/admin/stats", async (req, res) => {
  if (req.headers["x-admin-key"] !== process.env.ADMIN_KEY)
    return res.status(401).json({ error: "Unauthorized" });
  try {
    const total = await Payment.countDocuments({ status: "paid" });
    const revenue = total * 9;
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const today = await Payment.countDocuments({ status: "paid", createdAt: { $gte: todayStart } });
    const recent = await Payment.find({ status: "paid" })
      .sort({ createdAt: -1 }).limit(100)
      .select("name email paymentId createdAt amount -_id");
    res.json({ total, revenue, today, todayRevenue: today * 9, recent });
  } catch (err) {
    res.status(500).json({ error: "DB error: " + err.message });
  }
});

// ── START ─────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n✅ ResumeMint Backend running on port ${PORT}`);
  console.log("ENV check:", {
    MONGODB:         process.env.MONGODB_URI         ? "✅" : "❌ MISSING",
    RAZORPAY_KEY:    process.env.RAZORPAY_KEY_ID     ? "✅" : "❌ MISSING",
    RAZORPAY_SECRET: process.env.RAZORPAY_SECRET     ? "✅" : "❌ MISSING",
    ANTHROPIC:       process.env.ANTHROPIC_API_KEY   ? "✅" : "❌ not set (optional)",
    GEMINI:          process.env.GEMINI_API_KEY       ? "✅" : "❌ not set (optional)",
    ADMIN_KEY:       process.env.ADMIN_KEY            ? "✅" : "❌ MISSING",
  });
  console.log("AI: Anthropic → Gemini fallback enabled");
});
