require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");

mongoose.connect(process.env.MONGODB_URI)
.then(()=>console.log("MongoDB Connected ✅"))
.catch(err=>console.log("Mongo Error:", err));


const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req,res)=>{
  res.send("ResumeMint Backend Running ✅");
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, ()=>{
  console.log("Server running on port", PORT);
});

const Razorpay = require("razorpay");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_SECRET,
});

app.post("/create-order", async (req, res) => {
  const options = {
    amount: 900, // ₹9
    currency: "INR",
    receipt: "receipt_" + Date.now(),
  };
  const order = await razorpay.orders.create(options);
  res.json(order);
});

const crypto = require("crypto");

app.post("/verify-payment", (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  const body = razorpay_order_id + "|" + razorpay_payment_id;

  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_SECRET)
    .update(body)
    .digest("hex");

  if (expectedSignature === razorpay_signature) {
    res.json({ success: true });
  } else {
    res.status(400).json({ success: false });
  }
});