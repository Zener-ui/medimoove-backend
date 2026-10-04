const express = require("express");
const router = express.Router();
const {
  register, login, getMe, changePassword, forgotPassword, resetPassword,
  verifyLogin2FA, setup2FA, enable2FA, disable2FA,
} = require("../controllers/authController");
const { protect } = require("../middleware/auth");
const { loginLimiter, registerLimiter, passwordResetLimiter, otpLimiter } = require("../middleware/security");
const { pilotGuard } = require("../middleware/pilotGuard");

router.post("/register", registerLimiter, pilotGuard, register);
router.post("/login", loginLimiter, login);

// Second step of admin login — same tight limiter as OTP/verification
// routes, since this is the actual brute-force surface for a 6-digit code.
router.post("/2fa/verify-login", otpLimiter, verifyLogin2FA);

router.post("/forgot-password", passwordResetLimiter, forgotPassword);
router.post("/reset-password", passwordResetLimiter, resetPassword);
router.get("/me", protect, getMe);
router.put("/change-password", protect, changePassword);

// Managing 2FA on your own account — all require a valid session first.
router.post("/2fa/setup", protect, setup2FA);
router.post("/2fa/enable", protect, otpLimiter, enable2FA);
router.post("/2fa/disable", protect, otpLimiter, disable2FA);

module.exports = router;
