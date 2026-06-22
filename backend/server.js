import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import connectDB from "./db/db.js";
import dns from "node:dns";
import cookieParser from "cookie-parser";
import crypto from "crypto"; // Native Node module to verify Paystack Webhook signatures
import { createDecartClient, models } from "@decartai/sdk";

// Import your user model and protection middleware
import User from "./models/user.js";
import protect from "./middleware/authMiddleware.js";
import authRoutes from "./routes/authRoutes.js";

dns.setServers(["8.8.8.8", "1.1.1.1"]);
dotenv.config();

// Connect database
connectDB();

const app = express();

// --- Paystack Configuration Elements ---
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || "sk_test_7d79cef5b6dcf1c74ffdf06fe88ee3241d1bdd8c";
const paystackHeaders = {
  Authorization: `Bearer ${PAYSTACK_SECRET}`,
  'Content-Type': 'application/json',
};

// Convert standard currency values safely to Kobo minor units
const toKobo = (amount) => Math.round(parseFloat(amount) * 100);

// --- Middleware Pipeline ---
app.use(
  cors({
    origin: "http://localhost:3000",
    credentials: true,
  })
);

// CRITICAL: We need the raw body for the webhook signature verification,
// so we configure express.json() to save it on req.rawBody
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(cookieParser());

// --- Base Status Route ---
app.get("/", (req, res) => {
  res.send("API running with MongoDB 🚀");
});

// --- Authentication & Account Routing Layouts ---
app.use("/api/auth", authRoutes);
app.use("/api/lucy", authRoutes);

// --- Decart AI Engine Integration Route ---
app.post("/session", async (req, res) => {
  try {
    if (!process.env.DECART_API_KEY) {
      return res.status(500).json({ success: false, message: "DECART_API_KEY is missing" });
    }
    const client = createDecartClient({ apiKey: process.env.DECART_API_KEY });
    const model = models.realtime("lucy-2.1");
    return res.json({
      success: true,
      model: model.id,
      message: "Lucy 2.1 initialized successfully",
    });
  } catch (error) {
    console.error("Lucy session error:", error);
    return res.status(500).json({ success: false, message: "Failed to initialize Lucy session", error: error.message });
  }
});

// --- PAYSTACK ACCEPT PAYMENT ENDPOINTS ---

/**
 * 1. INITIALIZE TRANSACTION
 * Frontend hits this when a user clicks "Buy Credits".
 * Request Body: { amountPaid: 5000, creditsAdded: 500 }
 */
 // --- Paystack Checkout Route with Detailed Logging ---
 app.post("/api/paystack/initialize", protect, async (req, res) => {
   console.log("--------------------------------------------------");
   console.log("📬 [Paystack Init] Incoming request received.");
   console.log("📦 Request Body:", req.body);
   console.log("👤 Authenticated User ID from Middleware:", req.user?.id);

   try {
     const { amountPaid, creditsAdded } = req.body;
     const userId = req.user?.id;

     if (!userId) {
       console.error("❌ [Auth Error] req.user.id is undefined. Check auth protection middleware.");
       return res.status(401).json({ success: false, message: "User context missing from auth protection middleware." });
     }

     const user = await User.findById(userId);
     if (!user) {
       console.error(`❌ [Database Error] User with ID ${userId} not found.`);
       return res.status(404).json({ success: false, message: "User not found" });
     }
     console.log(`✅ [Database Success] Found user: ${user.email}`);

     const amountInKobo = toKobo(amountPaid);
     console.log(`🪙 Computed amount in minor units (Kobo): ${amountInKobo}`);

     const body = {
       email: user.email,
       amount: amountInKobo,
       callback_url: "http://localhost:3000/Success.html",
       metadata: {
         userId: user._id.toString(),
         creditsToAdd: Number(creditsAdded),
         amountPaidOriginal: Number(amountPaid)
       }
     };

     console.log("🚀 Sending Request Payload to Paystack API...");
     console.log("🔑 Using Secret Key Prefix:", PAYSTACK_SECRET ? PAYSTACK_SECRET.substring(0, 12) + "..." : "UNDEFINED");

     const resp = await fetch("https://api.paystack.co/transaction/initialize", {
       method: "POST",
       headers: paystackHeaders,
       body: JSON.stringify(body),
     });

     console.log(`📡 Paystack Response Status Code: ${resp.status} ${resp.statusText}`);
     const data = await resp.json();
     console.log("📥 Paystack Response Data Payload:", data);

     if (!data.status) {
       console.error("❌ [Paystack API Rejection]:", data.message);
       return res.status(400).json({ success: false, message: data.message });
     }

     console.log("🎯 [Success] Authorization URL successfully fetched. Passing back to client.");
     return res.status(200).json({
       success: true,
       authorization_url: data.data.authorization_url,
       reference: data.data.reference
     });

   } catch (err) {
     console.error("💥 [Fatal Server Exception Context]:", err);
     return res.status(500).json({ success: false, message: err.message });
   }
 });
/**
 * 2. SECURE PAYSTACK WEBHOOK
 * Paystack calls this asynchronously when the user completes payment.
 * Do NOT use 'protect' middleware here; it's a direct server-to-server call.
 */
app.post("/api/paystack/webhook", async (req, res) => {
  try {
    // Validate that the request actually came from Paystack using HMAC SHA512
    const hash = crypto
      .createHmac("sha512", PAYSTACK_SECRET)
      .update(req.rawBody)
      .digest("hex");

    if (hash !== req.headers["x-paystack-signature"]) {
      return res.status(401).json({ message: "Invalid transaction signature" });
    }

    const event = req.body;

    // We only care about successful charges
    if (event.event === "charge.success") {
      const paymentData = event.data;
      const metadata = paymentData.metadata;

      if (metadata && metadata.userId) {
        // Atomic transaction: Add credits and append details directly into topupHistory array
        await User.findByIdAndUpdate(
          metadata.userId,
          {
            $inc: { credits: metadata.creditsToAdd },
            $push: {
              topupHistory: {
                amountPaid: metadata.amountPaidOriginal,
                creditsAdded: metadata.creditsToAdd,
                paymentProvider: "paystack",
                providerReference: paymentData.reference,
                status: "completed",
              },
            },
          }
        );
        console.log(`Successfully credited ${metadata.creditsToAdd} credits to user: ${metadata.userId}`);
      }
    }

    // Always tell Paystack you received the event successfully
    return res.status(200).send("Event processed");
  } catch (err) {
    console.error("Webhook processing fault:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// --- Server Allocation Init ---
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
