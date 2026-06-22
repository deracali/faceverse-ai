import mongoose from "mongoose";

// --- 1. Top-up History Schema Definition ---
const topupHistorySchema = new mongoose.Schema(
  {
    amountPaid: { type: Number, required: true },
    creditsAdded: { type: Number, required: true },
    paymentProvider: { type: String, required: true },
    providerReference: { type: String, sparse: true },
    status: { type: String, enum: ["pending", "completed", "failed"], default: "completed" },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// --- 2. Session History Schema Definition ---
const sessionHistorySchema = new mongoose.Schema(
  {
    // 🚩 ADDED: Explicitly store the external string identifier from the streaming provider
    sessionId: {
      type: String,
      required: true,
      index: true // Optional: Speeds up performance since you query this field on every tick
    },
    modelUsed: {
      type: String, // e.g., 'lucy-2.1'
      required: true,
    },
    status: {
      type: String,
      enum: ["connected", "disconnected", "failed"],
      default: "connected",
    },
    creditsConsumed: {
      type: Number,
      default: 0,
    },
    durationInSeconds: {
      type: Number,
      default: 0,
    },
    errorMessage: {
      type: String, // Handy for logging things like 'Insufficient credits' or 'Websocket closed'
    }
  },
  {
    // This provides 'createdAt' (session started) and 'updatedAt' (session closed/lasted until)
    timestamps: true,
  }
);

// --- 3. Main User Schema Configuration ---
const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },

    password: {
      type: String,
      required: true,
    },

    credits: {
      type: Number,
      required: true,
      default: 0,
      min: [0, "Credit balance cannot be negative"],
    },

    // Subdocument Arrays
    topupHistory: [topupHistorySchema],
    sessionHistory: [sessionHistorySchema],
  },
  {
    timestamps: true,
  }
);

const User = mongoose.model("User", userSchema);

export default User;
