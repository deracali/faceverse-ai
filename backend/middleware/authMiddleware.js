import jwt from "jsonwebtoken";
import User from "../models/user.js";

const protect = async (req, res, next) => {
  try {
    let token;

    // 🚩 1. Check if the token is passed via the standard Authorization Header
    if (req.headers.authorization && req.headers.authorization.startsWith("Bearer")) {
      token = req.headers.authorization.split(" ")[1]; // Splitting "Bearer <token>"
    }
    // 🚩 2. Fallback to reading cookies if header is missing
    else if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }

    // Check if token was found in either location
    if (!token) {
      return res.status(401).json({
        message: "No token provided, authorization denied",
      });
    }

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Get user from database (Ensure your token payload uses 'id' or '_id' matching decoded property)
    req.user = await User.findById(decoded.id || decoded._id).select("-password");

    if (!req.user) {
      return res.status(401).json({ message: "User no longer exists" });
    }

    next();
  } catch (error) {
    console.error("Middleware JWT verification failure:", error.message);
    return res.status(401).json({
      message: "Not authorized, token corrupt or expired",
    });
  }
};

export default protect;
