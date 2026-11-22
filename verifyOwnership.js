import { ObjectId } from "mongodb";

const UNAUTHORIZED = (res) =>
  res.status(401).json({
    success: false,
    message: "Authentication required. Please login.",
  });

const FORBIDDEN = (res, message) =>
  res.status(403).json({
    success: false,
    message,
  });

const getParamFromPath = (req, paramName) => {
  if (req.params?.[paramName]) {
    return req.params[paramName];
  }

  const path = (req.originalUrl || req.url || "").split("?")[0];
  const patterns = {
    customerId: /^\/api\/(?:customer|vendor)\/([^/]+)/,
    vendorId: /^\/api\/(?:customer|vendor)\/([^/]+)/,
  };

  const pattern = patterns[paramName];
  if (!pattern) return undefined;
  const match = path.match(pattern);
  return match ? decodeURIComponent(match[1]) : undefined;
};

export default function verifyOwnership(options = {}) {
  const {
    paramName = "customerId",
    message = "You are not authorized to access this resource.",
    resource = null,
  } = options;

  return async (req, res, next) => {
    try {
      if (!req.authUser) {
        return UNAUTHORIZED(res);
      }

      if (resource === "favorite") {
        const favoriteId = req.params?.favoriteId;

        if (!favoriteId || !ObjectId.isValid(favoriteId)) {
          return next();
        }

        const db = req.app.locals.db;
        if (!db) {
          return res.status(500).json({
            success: false,
            message: "Server authentication configuration is missing.",
          });
        }

        const favorite = await db.collection("favorites").findOne({
          _id: new ObjectId(favoriteId),
        });

        if (!favorite) {
          return next();
        }

        if (String(favorite.customerId) !== String(req.authUser.id)) {
          return FORBIDDEN(res, "You are not authorized to remove this favorite.");
        }

        return next();
      }

      const ownerId = req.params?.[paramName] || getParamFromPath(req, paramName);

      if (ownerId && String(ownerId) !== String(req.authUser.id)) {
        return FORBIDDEN(res, message);
      }

      if (paramName === "customerId") {
        req.authorizedCustomerId = String(req.authUser.id);
        if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
          req.body.customerId = req.authUser.id;
        }
      }

      if (paramName === "vendorId") {
        req.authorizedVendorId = String(req.authUser.id);
        if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
          req.body.vendorId = req.authUser.id;
        }
      }

      return next();
    } catch (error) {
      console.error("Ownership verification error:", error);
      return res.status(500).json({
        success: false,
        message: "Failed to verify ownership.",
      });
    }
  };
}
