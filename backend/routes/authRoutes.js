import express from "express";

import {
  registerUser,
  loginUser,
  getCurrentUser,
  logoutUser,
  // Imported new transaction and session syncing controllers
  topupCredits,
  startStreamSession,
  syncSessionUsage,
} from "../controllers/authController.js"; // Note: Adjust this path if you split auth and credits into different files

import protect from "../middleware/authMiddleware.js";

const router = express.Router();

// =========================================================================
// EXISTENT AUTHENTICATION ROUTES
// =========================================================================
router.post("/register", registerUser);

router.post("/login", loginUser);

router.get("/me", protect, getCurrentUser);

router.post("/logout", logoutUser);

// =========================================================================
// NEW: CREDITS & REALTIME STREAMING SESSION MANAGEMENT ROUTES
// =========================================================================

// Route to handle credit purchases and top-ups
router.post("/credits/topup", protect, topupCredits);

// Route to initialize a streaming instance and check starting balance
router.post("/sessions/start", protect, startStreamSession);

// Route to handle both background batch billing and final stream termination
router.post("/sessions/sync", protect, syncSessionUsage);

export default router;
