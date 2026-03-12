require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const crypto = require("crypto");
const https = require("https");

const app = express();

app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type","Authorization","x-admin-key"] }));
app.use(express.json({ limit: "10mb" }));

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB Connected ✅"))
  .catch(err => console.log("Mongo Error:", err));

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
const razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_SECRET });

const _hits = {};
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  if (!_hits[key]) _hits[key] = [];
  _hits[key] = _hits[key].filter(t => now - t < windowMs);
  if (_hits[key].length >= max) return false;
  _hits[key].push(now);
  return true;
}

// Helper: make HTTPS request (works on any Node version)
function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(bodyStr) }
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error("Invalid JSON from API: " + data.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

app.get("/", (req, res) => {
  res.json({ status: "ResumeMint Backend ✅", db: mongoose.connection.readyState === 1 ? "connected" : "disconnected", time: new Date().toISOString() });
});

app.post("/create-order", async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
  if (!rateLimit("order_"+ip, 10, 60000)) return res.status(429).json({ error: "Too many requests." });
  try {
    const order = await razorpay.orders.create({ amount: 900, currency: "INR", receipt: "rm_" + Date.now() });
    await Payment.create({ orderId: order.id }).catch(() => {});
    console.log("Order created:", order.id);
    res.json(order);
  } catch (err) {
    console.error("Create order error:", err.message);
    res.status(500).json({ error: "Could not create order: " + err.message });
  }
});

app.post("/verify-payment", async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, name, email } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
    return res.status(400).json({ success: false, error: "Missing fields" });
  const expected = crypto.createHmac("sha256", process.env.RAZORPAY_SECRET)
    .update(razorpay_order_id + "|" + razorpay_payment_id).digest("hex");
  if (expected !== razorpay_signature) {
    console.log("❌ Signature mismatch");
    return res.status(400).json({ success: false, error: "Invalid signature" });
  }
  const token = crypto.randomBytes(32).toString("hex");
  await Payment.findOneAndUpdate(
    { orderId: razorpay_order_id },
    { paymentId: razorpay_payment_id, signature: razorpay_signature, status: "paid", name: name||"", email: email||"", downloadToken: token },
    { upsert: true }
  ).catch(() => {});
  console.log("✅ Payment verified:", razorpay_payment_id, name, email);
  res.json({ success: true, token });
});

app.post("/ai-job-match", async (req, res) => {
  const ip = (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
  if (!rateLimit("ai_"+ip, 10, 60000)) return res.status(429).json({ error: "Too many AI requests. Wait 1 minute." });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set in environment variables" });
  try {
    const data = await httpsPost(
      "https://api.anthropic.com/v1/messages",
      { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      req.body
    );
    console.log("AI call success, stop_reason:", data.stop_reason);
    res.json(data);
  } catch (err) {
    console.error("AI error:", err.message);
    res.status(500).json({ error: "AI request failed: " + err.message });
  }
});

app.get("/admin/stats", async (req, res) => {
  if (req.headers["x-admin-key"] !== process.env.ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  try {
    const total = await Payment.countDocuments({ status: "paid" });
    const revenue = total * 9;
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const today = await Payment.countDocuments({ status: "paid", createdAt: { $gte: todayStart } });
    const recent = await Payment.find({ status: "paid" }).sort({ createdAt: -1 }).limit(50).select("name email paymentId createdAt amount -_id");
    res.json({ total, revenue, today, todayRevenue: today * 9, recent });
  } catch (err) {
    res.status(500).json({ error: "DB error: " + err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log("ENV check:", {
    MONGODB: process.env.MONGODB_URI ? "✅" : "❌ MISSING",
    RAZORPAY_KEY: process.env.RAZORPAY_KEY_ID ? "✅" : "❌ MISSING",
    RAZORPAY_SECRET: process.env.RAZORPAY_SECRET ? "✅" : "❌ MISSING",
    ANTHROPIC: process.env.ANTHROPIC_API_KEY ? "✅" : "❌ MISSING",
    ADMIN_KEY: process.env.ADMIN_KEY ? "✅" : "❌ MISSING",
  });
});
