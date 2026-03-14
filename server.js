require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const crypto = require("crypto");
const https = require("https");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "15mb" }));

// ── DB ────────────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(e => console.error("❌ MongoDB:", e.message));

const Payment = mongoose.model("Payment", new mongoose.Schema({
  orderId: { type: String, unique: true }, paymentId: { type: String, default: "" },
  signature: { type: String, default: "" }, status: { type: String, default: "created" },
  name: { type: String, default: "" }, email: { type: String, default: "" },
  downloadToken: { type: String, default: "" }, amount: { type: Number, default: 900 },
  createdAt: { type: Date, default: Date.now },
}));

const Razorpay = require("razorpay");
const rzp = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_SECRET });

// ── HELPERS ───────────────────────────────────────────────
const _hits = {};
function rl(key, max, ms) {
  const now = Date.now();
  _hits[key] = (_hits[key] || []).filter(t => now - t < ms);
  if (_hits[key].length >= max) return false;
  _hits[key].push(now); return true;
}

function post(url, headers, body) {
  return new Promise((resolve, reject) => {
    const s = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + (u.search || ""), method: "POST",
        headers: { ...headers, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s) } },
      res => {
        let d = "";
        res.on("data", c => d += c);
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
          catch (e) { resolve({ status: res.statusCode, body: { raw: d.slice(0, 500) } }); }
        });
      }
    );
    req.on("error", reject);
    req.write(s); req.end();
  });
}

// ── GEMINI ────────────────────────────────────────────────
// FREE: 1500 req/day via aistudio.google.com key
// Correct endpoint for AI Studio keys: v1beta + gemini-2.0-flash-exp OR gemini-1.5-flash
async function gemini(system, userText, b64, mime) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("NO_GEMINI_KEY");

  const parts = [];
  if (b64 && mime) parts.push({ inline_data: { mime_type: mime, data: b64 } });
  parts.push({ text: (system ? system + "\n\n" : "") + userText });

  // Try multiple models in order until one works
  const models = ["gemini-2.0-flash-exp", "gemini-1.5-flash", "gemini-1.0-pro"];

  for (const model of models) {
    try {
      const r = await post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        {},
        { contents: [{ role: "user", parts }], generationConfig: { temperature: 0.3, maxOutputTokens: 2048 } }
      );

      console.log(`Gemini ${model}: status=${r.status}`);

      if (r.status === 200) {
        const text = r.body?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) { console.log(`✅ Gemini ${model} worked, chars=${text.length}`); return text; }
        // If no text, try next model
        console.log(`Gemini ${model}: empty response, trying next...`, JSON.stringify(r.body).slice(0, 200));
        continue;
      }

      const errMsg = r.body?.error?.message || JSON.stringify(r.body);
      console.log(`Gemini ${model} failed (${r.status}): ${errMsg}`);

      // If model not found, try next
      if (errMsg.includes("not found") || errMsg.includes("not supported") || r.status === 404) continue;
      // Rate limit — stop trying
      if (r.status === 429) throw new Error("GEMINI_QUOTA");
      // Other error — try next model
      continue;
    } catch (e) {
      if (e.message === "GEMINI_QUOTA") throw e;
      console.log(`Gemini ${model} threw:`, e.message);
      continue;
    }
  }

  throw new Error("All Gemini models failed");
}

// ── ANTHROPIC ─────────────────────────────────────────────
async function anthropic(body) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("NO_ANTHROPIC_KEY");

  const r = await post(
    "https://api.anthropic.com/v1/messages",
    { "x-api-key": key, "anthropic-version": "2023-06-01" },
    body
  );

  console.log(`Anthropic: status=${r.status}`);

  // Check for credit/quota error in body (Anthropic returns 200 even for credit errors!)
  const errMsg = r.body?.error?.message || "";
  if (errMsg.toLowerCase().includes("credit") || errMsg.toLowerCase().includes("balance") ||
      errMsg.toLowerCase().includes("quota") || r.status === 429) {
    throw new Error("ANTHROPIC_QUOTA");
  }
  if (r.status !== 200) throw new Error(`Anthropic error ${r.status}: ${errMsg}`);

  const text = r.body?.content?.map(b => b.text || "").join("") || "";
  console.log(`✅ Anthropic worked, chars=${text.length}`);
  return text;
}

// ── SMART AI: try Anthropic → fallback Gemini ─────────────
async function ai(body) {
  // Try Anthropic
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const text = await anthropic(body);
      return { text, by: "anthropic" };
    } catch (e) {
      console.log("Anthropic failed:", e.message, "→ falling back to Gemini");
    }
  }

  // Try Gemini (always fallback, regardless of Anthropic error type)
  if (process.env.GEMINI_API_KEY) {
    try {
      const system = body.system || "";
      const msg = body.messages?.[0];
      let userText = "", b64 = null, mime = null;

      if (typeof msg?.content === "string") {
        userText = msg.content;
      } else if (Array.isArray(msg?.content)) {
        for (const p of msg.content) {
          if (p.type === "text") userText = p.text;
          if (p.type === "document" || p.type === "image") {
            b64 = p.source?.data;
            mime = p.source?.media_type;
          }
        }
      }

      const text = await gemini(system, userText, b64, mime);
      return { text, by: "gemini" };
    } catch (e) {
      console.log("Gemini failed:", e.message);
      if (e.message === "GEMINI_QUOTA") throw new Error("AI_QUOTA_EXCEEDED");
      throw new Error("AI_ERROR: " + e.message);
    }
  }

  throw new Error("No AI keys configured");
}

// ── ROUTES ────────────────────────────────────────────────
app.get("/", (_, res) => res.json({
  status: "ResumeMint Backend ✅",
  db: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  ai: { anthropic: !!process.env.ANTHROPIC_API_KEY, gemini: !!process.env.GEMINI_API_KEY },
  time: new Date().toISOString()
}));

app.post("/create-order", async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0];
  if (!rl("ord_" + ip, 10, 60000)) return res.status(429).json({ error: "Too many requests" });
  try {
    const order = await rzp.orders.create({ amount: 900, currency: "INR", receipt: "rm_" + Date.now() });
    await Payment.create({ orderId: order.id }).catch(() => {});
    res.json(order);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/check-payment", async (req, res) => {
  const { order_id } = req.body;
  if (!order_id) return res.json({ paid: false });
  try {
    const p = await Payment.findOne({ orderId: order_id });
    if (p?.status === "paid") return res.json({ paid: true });

    const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_SECRET}`).toString("base64");
    const rp = await new Promise((ok, fail) => {
      const r = https.request({ hostname: "api.razorpay.com", path: `/v1/orders/${order_id}/payments`, method: "GET", headers: { Authorization: `Basic ${auth}` } },
        res => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { ok(JSON.parse(d)); } catch { ok({}); } }); });
      r.on("error", fail); r.end();
    });
    const captured = (rp.items || []).find(x => x.status === "captured");
    if (captured) {
      const token = crypto.randomBytes(32).toString("hex");
      await Payment.findOneAndUpdate({ orderId: order_id }, { paymentId: captured.id, status: "paid", downloadToken: token }, { upsert: true }).catch(() => {});
      return res.json({ paid: true, token });
    }
    res.json({ paid: false });
  } catch { res.json({ paid: false }); }
});

app.post("/verify-payment", async (req, res) => {
  const { razorpay_order_id: oid, razorpay_payment_id: pid, razorpay_signature: sig, name, email } = req.body;
  if (!oid || !pid || !sig) return res.status(400).json({ success: false, error: "Missing fields" });
  const expected = crypto.createHmac("sha256", process.env.RAZORPAY_SECRET).update(oid + "|" + pid).digest("hex");
  if (expected !== sig) return res.status(400).json({ success: false, error: "Invalid signature" });
  const token = crypto.randomBytes(32).toString("hex");
  await Payment.findOneAndUpdate({ orderId: oid }, { paymentId: pid, signature: sig, status: "paid", name: name || "", email: email || "", downloadToken: token }, { upsert: true }).catch(() => {});
  res.json({ success: true, token });
});

app.post("/ai-job-match", async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0];
  if (!rl("ai_" + ip, 8, 60000)) return res.status(429).json({ error: "Too many requests. Wait 1 minute." });
  try {
    const result = await ai(req.body);
    res.json({ content: [{ type: "text", text: result.text }], provider: result.by });
  } catch (e) {
    console.error("AI endpoint error:", e.message);
    if (e.message === "AI_QUOTA_EXCEEDED") return res.status(429).json({ error: "AI_QUOTA_EXCEEDED" });
    res.status(500).json({ error: e.message });
  }
});

app.get("/admin/stats", async (req, res) => {
  if (req.headers["x-admin-key"] !== process.env.ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  try {
    const total = await Payment.countDocuments({ status: "paid" });
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const today = await Payment.countDocuments({ status: "paid", createdAt: { $gte: todayStart } });
    const recent = await Payment.find({ status: "paid" }).sort({ createdAt: -1 }).limit(50).select("name email paymentId createdAt -_id");
    res.json({ total, revenue: total * 9, today, todayRevenue: today * 9, recent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 ResumeMint Backend on port ${PORT}`);
  console.log(`   Anthropic: ${process.env.ANTHROPIC_API_KEY ? "✅" : "❌"}`);
  console.log(`   Gemini:    ${process.env.GEMINI_API_KEY ? "✅" : "❌"}`);
  console.log(`   MongoDB:   ${process.env.MONGODB_URI ? "✅" : "❌"}\n`);
});
