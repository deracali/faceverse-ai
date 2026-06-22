import jwt from "jsonwebtoken";
import User from "../models/user.js";

const protect = async (req, res, next) => {
  try {
    // get token from cookies
    const token = req.cookies.token;

    // check token
    if (!token) {
      return res.status(401).json({
        message: "No token provided",
      });
    }

    // verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // get user
    req.user = await User.findById(decoded.id).select("-password");

    next();
  } catch (error) {
    return res.status(401).json({
      message: "Not authorized",
    });
  }
};

export default protect;
