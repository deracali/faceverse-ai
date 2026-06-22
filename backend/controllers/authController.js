import User from "../models/user.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const generateToken = (id) => {
  const secret = process.env.JWT_SECRET || "fallback_local_secret_key_123";
  return jwt.sign({ id }, secret, {
    expiresIn: "30d",
  });
};

const sendCorsError = (res, statusCode, message) => {
  res.header("Access-Control-Allow-Origin", "http://localhost:3000");
  res.header("Access-Control-Allow-Credentials", "true");
  return res.status(statusCode).json({ message });
};

// =========================================================================
// EXISTENT AUTHENTICATION CONTROLLERS
// =========================================================================

// REGISTER USER
export const registerUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    const userExists = await User.findOne({ email });
    if (userExists) {
      return sendCorsError(res, 400, "User already exists");
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const user = await User.create({
      email,
      password: hashedPassword,
    });

    const token = generateToken(user._id);

    res.cookie("token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    // 🚩 MODIFIED: Added token into the JSON body payload
    return res.status(201).json({
      _id: user._id,
      email: user.email,
      credits: user.credits,
      token: token,
      message: "User registered successfully",
    });
  } catch (error) {
    console.error("Register Error:", error.message);
    return sendCorsError(res, 500, error.message);
  }
};

// LOGIN USER
export const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return sendCorsError(res, 401, "Invalid email or password");
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return sendCorsError(res, 401, "Invalid email or password");
    }

    const token = generateToken(user._id);

    res.cookie("token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    // 🚩 MODIFIED: Added token into the JSON body payload
    return res.status(200).json({
      _id: user._id,
      email: user.email,
      token: token,
      message: "Login successful",
    });
  } catch (error) {
    console.error("Login Error:", error.message);
    return sendCorsError(res, 500, error.message);
  }
};


// GET CURRENT USER (Returns balance, histories, etc.)
export const getCurrentUser = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("-password");
    if (!user) return sendCorsError(res, 404, "User not found");
    return res.status(200).json(user);
  } catch (error) {
    return sendCorsError(res, 500, error.message);
  }
};

// LOGOUT USER
export const logoutUser = async (req, res) => {
  try {
    res.cookie("token", "", {
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      expires: new Date(0),
    });

    return res.status(200).json({
      message: "User logged out successfully",
    });
  } catch (error) {
    return sendCorsError(res, 500, error.message);
  }
};

// =========================================================================
// NEW: CREDITS & STREAMING SESSION MANAGEMENT CONTROLLERS
// =========================================================================

// TOP UP CREDITS (Triggered via webhooks or verified direct internal operations)
export const topupCredits = async (req, res) => {
  try {
    const { providerReference, paymentProvider } = req.body;
    const userId = req.user.id;

    // 1. Guard against missing reference payloads from the frontend
    if (!providerReference || !paymentProvider) {
      return sendCorsError(res, 400, "Missing required verification reference elements.");
    }

    // 2. Call the Paystack Verification API using native fetch
    const paystackResponse = await fetch(`https://api.paystack.co/transaction/verify/${providerReference}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const parsedData = await paystackResponse.json();

    // 3. Confirm Paystack successfully handled the request and the user paid
    if (!paystackResponse.ok || !parsedData.status || parsedData.data.status !== 'success') {
      return sendCorsError(res, 400, parsedData.message || "Transaction verification failed: Payment was not successful.");
    }

    const txData = parsedData.data;

    // 4. Extract metrics safely from Paystack's ledger
    // Paystack returns amounts in kobo (cents), so divide by 100 to get Naira
    const amountPaid = txData.amount / 100;

    // Safely reads the custom parameter you stored inside the initialization metadata object
    const creditsAdded = txData.metadata?.creditsToAdd || txData.metadata?.creditsAdded;

    if (!creditsAdded) {
      return sendCorsError(res, 400, "Failed to resolve credits scope allocation from payload metadata.");
    }

    // 5. Commit the dynamic values directly to MongoDB
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      {
        $inc: { credits: Number(creditsAdded) },
        $push: {
          topupHistory: {
            amountPaid,
            creditsAdded: Number(creditsAdded),
            paymentProvider,
            providerReference,
            status: "completed",
          },
        },
      },
      { new: true, runValidators: true }
    ).select("-password");

    // 6. Return response values mapped to match Success.html UI keys
    return res.status(200).json({
      success: true,
      message: "Account balance successfully credited.",
      credits: updatedUser.credits,
      creditsAdded: Number(creditsAdded),
      topupHistory: updatedUser.topupHistory,
    });

  } catch (error) {
    console.error("Topup Credit Mutation Failure:", error.message);
    return sendCorsError(res, 500, error.message);
  }
};


// INITIALIZE STREAM SESSION (Fires when frontend initiates connect handshakes)
export const startStreamSession = async (req, res) => {
  try {
    // 🚩 ADDED: Accept sessionId from the request body (the 22-char string from Decart/Livekit)
    const { modelUsed, sessionId } = req.body;
    const userId = req.user.id;

    console.log("=== START STREAM SESSION STARTING ===");
    console.log(`User ID: ${userId}, Model Selected: ${modelUsed}, Incoming Stream Session ID: ${sessionId}`);

    if (!modelUsed) return sendCorsError(res, 400, "Model designation required.");
    if (!sessionId) return sendCorsError(res, 400, "External streaming session reference string required.");

    const checkUser = await User.findById(userId);
    if (!checkUser) {
      console.error(`User initialization error: User ${userId} not found.`);
      return sendCorsError(res, 404, "User profile not found.");
    }

    console.log(`User balance verified: ${checkUser.credits} credits available.`);
    if (checkUser.credits <= 0) {
      return sendCorsError(res, 403, "Insufficient credits available to start session");
    }

    // Push the new session block cleanly into subdocument list with explicit string ID
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      {
        $push: {
          sessionHistory: {
            sessionId,             // 🚩 SAVED: Store the 22-character stream string directly
            modelUsed,
            status: "connected",
            creditsConsumed: 0,     // Explicitly seed baseline numbers
            durationInSeconds: 0    // Explicitly seed baseline numbers
          },
        },
      },
      { new: true, runValidators: true }
    );

    console.log("Session successfully pushed. Current history array size:", updatedUser.sessionHistory.length);

    // Look up the specific pushed session array item using your newly configured string property
    const createdSession = updatedUser.sessionHistory.find(s => s.sessionId === sessionId);

    if (!createdSession) {
      throw new Error("Failed to retrieve the pushed subdocument block from user ledger mapping data profiles.");
    }

    console.log("Registered New Session String Reference Key:", createdSession.sessionId);
    console.log("=== START STREAM SESSION COMPLETION ===");

    return res.status(201).json({
      sessionId: createdSession.sessionId, // 🚩 RETURNED: Give the frontend its string ID back
      status: createdSession.status,
    });
  } catch (error) {
    console.error("Critical Failure in startStreamSession:", error);
    return sendCorsError(res, 500, error.message);
  }
};
// HIGH-PERFORMANCE BATCH CREDITS SYNC
export const syncSessionUsage = async (req, res) => {
  try {
    const { sessionId, secondsElapsed, creditsConsumed, isFinal, errorMessage } = req.body;
    const userId = req.user.id;

    console.log("=== BATCH SYNC TICK STARTING ===");
    console.log("Incoming Payload Data:", { sessionId, secondsElapsed, creditsConsumed, isFinal, errorMessage });

    if (!sessionId) return sendCorsError(res, 400, "Active Session ID required.");

    const debitAmount = Math.abs(creditsConsumed || 0);

    console.log(`Executing atomic findOneAndUpdate tracking payload. Filtering by User: ${userId}, Session ID String: ${sessionId}, Required Balance >= ${debitAmount}`);

    // 🚩 REMOVED MONGOOSE CASTING BLOCK COMPLETELY TO PREVENT THE TRUNCATION CRASH
    // We match 'sessionId' directly as a plain string value inside the array
    const updatedUser = await User.findOneAndUpdate(
      {
        _id: userId,
        credits: { $gte: debitAmount },
        "sessionHistory.sessionId": sessionId
      },
      {
        $inc: {
          credits: -debitAmount,
          "sessionHistory.$.creditsConsumed": debitAmount,
          "sessionHistory.$.durationInSeconds": secondsElapsed || 0
        },
        $set: {
          ...(isFinal ? {
            "sessionHistory.$.status": errorMessage ? "failed" : "disconnected",
            "sessionHistory.$.errorMessage": errorMessage || null
          } : {})
        }
      },
      { new: true, runValidators: true }
    );

    if (!updatedUser) {
      console.error("!!! SYNC DROPPED: Query match criteria failed on database ledger configuration !!!");

      const debugProfile = await User.findById(userId);
      if (!debugProfile) {
        console.log("- Diagnosis: User completely missing from the system.");
      } else {
        const matchingSession = debugProfile.sessionHistory.find(s => s.sessionId === sessionId);
        console.log("- Diagnostic Dump:");
        console.log(`  -> Current balance in database: ${debugProfile.credits}`);
        console.log(`  -> Requested debit subtraction amount: ${debitAmount}`);
        console.log(`  -> Did session history entry match query? ${matchingSession ? "YES" : "NO (Array doesn't contain this String ID)"}`);
        if (matchingSession) console.log("  -> Found Session details:", matchingSession);
      }

      return sendCorsError(res, 403, "Insufficient credits or target session profile mismatched on ledger.");
    }

    console.log(`Sync Successful. Remaining DB ledger balances: ${updatedUser.credits} credits.`);
    console.log("=== BATCH SYNC TICK ENDED SUCCESSFULLY ===");

    return res.status(200).json({
      message: "Session ledger synchronized successfully.",
      remainingCredits: updatedUser.credits
    });
  } catch (error) {
    console.error("Batch Synchronization Failure Exception:", error.message);
    return sendCorsError(res, 500, error.message);
  }
};
