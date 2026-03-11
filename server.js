require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const crypto = require("crypto");
const https = require("https");

const app = express();
app.use(cors({ origin: "*", methods: ["GET","POST","OPTIONS"], allowedHeaders: ["Content-Type","Authorization","x-admin-key"] }));
app.use(express.json({ limit: "10mb" }));

// MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB Connected ✅"))
  .catch(err => console.error("MongoDB Error:", err.message));

const Payment = mongoose.model("Payment", new mongoose.Schema({
  orderId:      { type: String, default: "" },
  paymentId:    { type: String, default: "" },
  status:       { type: String, default: "created" },
  name:         { type: String, default: "" },
  email:        { type: String, default: "" },
  downloadToken:{ type: String, default: "" },
  amount:       { type: Number, default: 900 },
  createdAt:    { type: Date, default: Date.now },
}));

const Razorpay = require("razorpay");
const rzp = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_SECRET });

function apiPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({ hostname, path, method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(data) }
    }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error("Bad JSON")); } });
    });
    req.on("error", reject);
    req.write(data); req.end();
  });
}

app.get("/", (req, res) => res.json({
  status: "ResumeMint Backend ✅",
  db: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
  port: process.env.PORT,
  time: new Date().toISOString()
}));

app.post("/create-order", async (req, res) => {
  try {
    const order = await rzp.orders.create({ amount: 900, currency: "INR", receipt: "rm_" + Date.now() });
    await Payment.create({ orderId: order.id }).catch(() => {});
    res.json(order);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/verify-payment", async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, name, email } = req.body;
  const expected = crypto.createHmac("sha256", process.env.RAZORPAY_SECRET)
    .update(razorpay_order_id + "|" + razorpay_payment_id).digest("hex");
  if (expected !== razorpay_signature) return res.status(400).json({ success: false, error: "Invalid signature" });
  const token = crypto.randomBytes(32).toString("hex");
  await Payment.findOneAndUpdate({ orderId: razorpay_order_id },
    { paymentId: razorpay_payment_id, status: "paid", name: name||"", email: email||"", downloadToken: token },
    { upsert: true }).catch(() => {});
  res.json({ success: true, token });
});

app.post("/ai-job-match", async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY missing" });
  try {
    const data = await apiPost("api.anthropic.com", "/v1/messages",
      { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      req.body);
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/admin/stats", async (req, res) => {
  if (req.headers["x-admin-key"] !== process.env.ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  try {
    const total = await Payment.countDocuments({ status: "paid" });
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const today = await Payment.countDocuments({ status: "paid", createdAt: { $gte: todayStart } });
    const recent = await Payment.find({ status: "paid" }).sort({ createdAt: -1 }).limit(50).select("name email paymentId createdAt -_id");
    res.json({ total, revenue: total * 9, today, todayRevenue: today * 9, recent });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// CRITICAL: Railway sets PORT env var — must use it exactly
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
