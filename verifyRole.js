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

export default function verifyRole(allowedRoles = [], message = "Access denied.") {
  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];

  return (req, res, next) => {
    if (!req.authUser) {
      return UNAUTHORIZED(res);
    }

    if (!roles.includes(req.authUser.role)) {
      return FORBIDDEN(res, message);
    }

    return next();
  };
}
