const jwt = require("jsonwebtoken");
const { adminClient } = require("../config/db");

const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, code: "AUTH_TOKEN_MISSING", message: "Not authorized. No token provided." });
    }
    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { data: user, error } = await adminClient
      .from("users")
      .select("id, email, phone, role, is_active, auth_token_version")
      .eq("id", decoded.id)
      .single();
    if (error || !user) return res.status(401).json({ success: false, code: "AUTH_USER_NOT_FOUND", message: "User not found." });
    if (!user.is_active) return res.status(403).json({ success: false, message: "Your account has been suspended." });
    if (decoded.auth_token_version === undefined || decoded.auth_token_version !== user.auth_token_version) {
      return res.status(401).json({ success: false, code: "AUTH_TOKEN_REVOKED", message: "Your session is no longer valid. Please log in again." });
    }
    req.user = user;
    next();
  } catch (err) {
    const code = err?.name === "TokenExpiredError" ? "AUTH_TOKEN_EXPIRED" : "AUTH_TOKEN_INVALID";
    return res.status(401).json({ success: false, code, message: err?.name === "TokenExpiredError" ? "Token expired." : "Token invalid." });
  }
};

const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) return next();
    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { data: user } = await adminClient
      .from("users")
      .select("id, email, phone, role, is_active, auth_token_version")
      .eq("id", decoded.id)
      .single();
    if (user?.is_active && decoded.auth_token_version !== undefined && decoded.auth_token_version === user.auth_token_version) req.user = user;
    next();
  } catch (err) { next(); }
};

module.exports = { protect, optionalAuth };
