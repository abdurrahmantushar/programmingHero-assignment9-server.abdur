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

export default function verifyBlockedUser(req, res, next) {
  if (!req.authUser) {
    return UNAUTHORIZED(res);
  }

  if (req.authUser.isBlocked === true) {
    return FORBIDDEN(res, "Your account has been blocked.");
  }

  return next();
}
