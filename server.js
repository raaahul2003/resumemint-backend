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

const _hits = {};
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  if (!_hits[key]) _hits[key] = [];
  _hits[key] = _hits[key].filter(t => now - t < windowMs);
  if (_hits[key].length >= max) return false;
  _hits[key].push(now); return true;
}

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
    req.write(bodyStr); req.end();
  });
}

// Check if any error message indicates quota/credit issue
function isQuotaError(msg) {
  const s = (msg || "").toLowerCase();
  return s.includes("credit") || s.includes("balance") || s.includes("quota") ||
         s.includes("529") || s.includes("rate_limit") || s.includes("overloaded") ||
         s.includes("insufficient") || s.includes("billing") || s.includes("upgrade");
}

// ── GEMINI (FREE — 1500 req/day) ─────────────────────────
async function callGemini(systemPrompt, userText, base64Data, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_NOT_CONFIGURED");

  const parts = [];
  if (base64Data && mimeType) {
    parts.push({ inline_data: { mime_type: mimeType, data: base64Data } });
  }
  parts.push({ text: systemPrompt + "\n\n" + userText });

  const result = await httpsPost(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    { "Content-Type": "application/json" },
    {
      contents: [{ parts }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2048 }
    }
  );

  console.log("Gemini status:", result.status, "body keys:", Object.keys(result.body || {}));

  if (result.status === 429) throw new Error("QUOTA_EXCEEDED");
  if (result.status !== 200) {
    const errMsg = result.body?.error?.message || JSON.stringify(result.body);
    if (isQuotaError(errMsg)) throw new Error("QUOTA_EXCEEDED");
    throw new Error("Gemini error: " + errMsg);
  }

  const text = result.body?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text) {
    // Check for safety block or other finish reasons
    const reason = result.body?.candidates?.[0]?.finishReason;
    console.log("Gemini empty response, reason:", reason, JSON.stringify(result.body).slice(0,300));
    throw new Error("Gemini returned empty response. Reason: " + (reason || "unknown"));
  }
  return text;
}

// ── ANTHROPIC ─────────────────────────────────────────────
async function callAnthropic(reqBody) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_NOT_CONFIGURED");

  const result = await httpsPost(
    "https://api.anthropic.com/v1/messages",
    { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    reqBody
  );

  console.log("Anthropic status:", result.status);

  // Check body for credit/quota errors REGARDLESS of status code
  // Anthropic returns 200 with error body when credits are low!
  const bodyErr = result.body?.error?.message || "";
  if (isQuotaError(bodyErr)) throw new Error("QUOTA_EXCEEDED");

  if (result.status === 429) throw new Error("QUOTA_EXCEEDED");
  if (result.status === 401) throw new Error("ANTHROPIC_AUTH_ERROR");
  if (result.status !== 200) throw new Error(bodyErr || "Anthropic error " + result.status);

  return result.body;
}

// ── SMART AI ROUTER ───────────────────────────────────────
async function smartAI(reqBody) {
  // Try Anthropic first
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const result = await callAnthropic(reqBody);
      const text = result.content?.map(b => b.text || "").join("") || "";
      console.log("✅ Used Anthropic, text length:", text.length);
      return { text, provider: "anthropic" };
    } catch(e) {
      console.log("Anthropic failed:", e.message, "→ trying Gemini...");
      // Always fall through to Gemini on ANY Anthropic error
    }
  }

  // Gemini fallback
  if (process.env.GEMINI_API_KEY) {
    try {
      const system = reqBody.system || "";
      const userMsg = reqBody.messages?.[0];
      let userText = "", base64Data = null, mimeType = null;

      if (typeof userMsg?.content === "string") {
        userText = userMsg.content;
      } else if (Array.isArray(userMsg?.content)) {
        for (const part of userMsg.content) {
          if (part.type === "text") userText = part.text;
          if (part.type === "document" || part.type === "image") {
            base64Data = part.source?.data;
            mimeType = part.source?.media_type;
          }
        }
      }

      const text = await callGemini(system, userText, base64Data, mimeType);
      console.log("✅ Used Gemini, text length:", text.length);
      return { text, provider: "gemini" };
    } catch(e) {
      console.log("Gemini also failed:", e.message);
      if (e.message === "QUOTA_EXCEEDED") throw new Error("AI_QUOTA_EXCEEDED");
      throw new Error("AI error: " + e.message);
    }
  }

  throw new Error("No AI service configured.");
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
    const order = await razorpay.orders.create({ amount: 900, currency: "INR", receipt: "rm_" + Date.now() });
    await Payment.create({ orderId: order.id }).catch(() => {});
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: "Could not create order: " + err.message });
  }
});

// ── CHECK PAYMENT ─────────────────────────────────────────
app.post("/check-payment", async (req, res) => {
  const { order_id } = req.body;
  if (!order_id) return res.json({ paid: false });
  try {
    const payment = await Payment.findOne({ orderId: order_id });
    if (payment?.status === "paid") return res.json({ paid: true, token: payment.downloadToken });

    const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_SECRET}`).toString("base64");
    const rpResp = await new Promise((resolve, reject) => {
      const r = https.request({ hostname: "api.razorpay.com", path: `/v1/orders/${order_id}/payments`, method: "GET", headers: { "Authorization": `Basic ${auth}` } }, (res) => {
        let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
      }); r.on("error", reject); r.end();
    });
    const captured = (rpResp.items || []).find(p => p.status === "captured" || p.status === "authorized");
    if (captured) {
      const token = crypto.randomBytes(32).toString("hex");
      await Payment.findOneAndUpdate({ orderId: order_id }, { paymentId: captured.id, status: "paid", downloadToken: token }, { upsert: true }).catch(() => {});
      return res.json({ paid: true, token });
    }
    res.json({ paid: false });
  } catch (err) { res.json({ paid: false }); }
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
    { paymentId: razorpay_payment_id, signature: razorpay_signature, status: "paid", name: name || "", email: email || "", downloadToken: token },
    { upsert: true }).catch(() => {});
  res.json({ success: true, token });
});

// ── AI ENDPOINT ───────────────────────────────────────────
app.post("/ai-job-match", async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
  if (!rateLimit("ai_" + ip, 8, 60000))
    return res.status(429).json({ error: "Too many AI requests. Wait 1 minute." });
  try {
    const result = await smartAI(req.body);
    res.json({ content: [{ type: "text", text: result.text }], provider: result.provider });
  } catch (err) {
    console.error("AI endpoint error:", err.message);
    if (err.message === "AI_QUOTA_EXCEEDED") return res.status(429).json({ error: "AI_QUOTA_EXCEEDED" });
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN ─────────────────────────────────────────────────
app.get("/admin/stats", async (req, res) => {
  if (req.headers["x-admin-key"] !== process.env.ADMIN_KEY)
    return res.status(401).json({ error: "Unauthorized" });
  try {
    const total = await Payment.countDocuments({ status: "paid" });
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const today = await Payment.countDocuments({ status: "paid", createdAt: { $gte: todayStart } });
    const recent = await Payment.find({ status: "paid" }).sort({ createdAt: -1 }).limit(100).select("name email paymentId createdAt -_id");
    res.json({ total, revenue: total * 9, today, todayRevenue: today * 9, recent });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ ResumeMint Backend on port ${PORT}`);
  console.log("AI:", process.env.ANTHROPIC_API_KEY ? "Anthropic ✅" : "Anthropic ❌", "|", process.env.GEMINI_API_KEY ? "Gemini ✅" : "Gemini ❌");
});
