import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";

const UNAUTHORIZED = (res, message = "Authentication required. Please login.") =>
  res.status(401).json({
    success: false,
    message,
  });

export default async function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || typeof authHeader !== "string") {
      return UNAUTHORIZED(res, "Missing or invalid authorization token.");
    }

    const [scheme, token] = authHeader.split(" ");

    if (scheme !== "Bearer" || !token) {
      return UNAUTHORIZED(res, "Missing or invalid authorization token.");
    }

    const secret = process.env.JWT_SECRET;

    if (!secret) {
      console.error("JWT verification error: JWT_SECRET is not configured");
      return res.status(500).json({
        success: false,
        message: "Server authentication configuration is missing.",
      });
    }

    let decoded;

    try {
      decoded = jwt.verify(token, secret, {
        issuer: "pizzahub",
        algorithms: ["HS256"],
      });
    } catch (error) {
      if (error?.name === "TokenExpiredError") {
        return UNAUTHORIZED(res, "Invalid or expired token.");
      }

      if (error?.name === "JsonWebTokenError" || error?.name === "NotBeforeError") {
        return UNAUTHORIZED(res, "Invalid or expired token.");
      }

      throw error;
    }

    const userId = decoded?.id;

    if (!userId || typeof userId !== "string" || !ObjectId.isValid(userId)) {
      return UNAUTHORIZED(res, "Invalid or expired token.");
    }

    const db = req.app.locals.db;

    if (!db) {
      console.error("JWT verification error: database is not available");
      return res.status(500).json({
        success: false,
        message: "Server authentication configuration is missing.",
      });
    }

    const user = await db.collection("user").findOne(
      { _id: new ObjectId(userId) },
      {
        projection: {
          _id: 1,
          role: 1,
          email: 1,
          name: 1,
          isBlocked: 1,
        },
      }
    );

    if (!user) {
      return UNAUTHORIZED(res, "Invalid or expired token.");
    }

    req.authUser = {
      id: String(user._id),
      role: user.role,
      email: user.email,
      name: user.name,
      isBlocked: user.isBlocked === true,
    };
    req.user = req.authUser;

    return next();
  } catch (error) {
    console.error("JWT verification error:", error);
    return res.status(500).json({
      success: false,
      message: "Unable to verify authentication.",
    });
  }
}
