const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { v4: uuidv4 } = require("uuid");

// ============================================================
// HELMET — Security headers
// ============================================================
const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  crossOriginEmbedderPolicy: false,
});

// ============================================================
// REQUEST ID — Attach unique ID to every request for tracing
// ============================================================
const requestId = (req, res, next) => {
  req.id = uuidv4();
  res.setHeader("X-Request-ID", req.id);
  next();
};

// ============================================================
// STRUCTURED LOGGING
// ============================================================
const logger = (req, res, next) => {
  const start = Date.now();
  const { method, originalUrl, ip } = req;

  res.on("finish", () => {
    const duration = Date.now() - start;
    const log = {
      request_id: req.id,
      method,
      url: originalUrl,
      status: res.statusCode,
      duration_ms: duration,
      ip,
      timestamp: new Date().toISOString(),
    };

    if (res.statusCode >= 500) {
      console.error("[ERROR]", JSON.stringify(log));
    } else if (res.statusCode >= 400) {
      console.warn("[WARN]", JSON.stringify(log));
    } else {
      console.log("[INFO]", JSON.stringify(log));
    }
  });

  next();
};

// ============================================================
// RATE LIMITERS
// ============================================================

// General API limit
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  message: { success: false, message: "Too many requests. Please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Login — strict. This is the actual brute-force surface (guessing a
// password against a known email/phone), so it stays tight regardless
// of how many people share an IP.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    success: false,
    message: "Too many login attempts. Please try again in 15 minutes.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Register — more forgiving. Creating an account isn't a brute-force
// vector the same way login is, and a shared IP (office Wi-Fi, campus
// network, NAT'd mobile carrier) can otherwise see several unrelated
// people signing up in the same window and get needlessly blocked.
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: {
    success: false,
    message: "Too many registration attempts from this network. Please wait a few minutes before trying again.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Password reset — its own limiter, separate from login/register.
// Tight because forgot-password is a plausible enumeration/email-spam
// target even though the response is always generic.
const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    success: false,
    message: "Too many password reset attempts. Please try again in 15 minutes.",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Payment routes — strict
const paymentLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  message: { success: false, message: "Too many payment requests. Please wait a moment." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Withdrawal routes — very strict
const withdrawalLimiter = rateLimit({
  // Five withdrawal requests per user in 15 minutes. This is still strict
  // enough to protect the money-moving endpoint without locking users out
  // for an hour after a few failed attempts.
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { success: false, message: "Too many withdrawal requests. Please try again in a few minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

// OTP / verification routes
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 5,
  message: { success: false, message: "Too many verification attempts." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Product creation — prevent spam listings
const productLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,
  message: { success: false, message: "Too many product creation requests." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ============================================================
// REQUEST SIZE LIMIT
// Prevent large payload attacks
// ============================================================
const requestSizeLimits = {
  json: "10kb",
  urlencoded: "10kb",
  multipart: "10mb", // Allow larger for image uploads
};

module.exports = {
  helmetMiddleware,
  requestId,
  logger,
  generalLimiter,
  loginLimiter,
  registerLimiter,
  passwordResetLimiter,
  paymentLimiter,
  withdrawalLimiter,
  otpLimiter,
  productLimiter,
  requestSizeLimits,
};
