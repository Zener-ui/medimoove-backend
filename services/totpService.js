const { authenticator } = require("otplib");
const QRCode = require("qrcode");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

// Allow 1 step (±30s) of clock drift either side — phones and servers
// don't always agree on the exact second, and being too strict just
// means legitimate codes get rejected.
authenticator.options = { window: 1 };

const generateSecret = () => authenticator.generateSecret();

const buildOtpAuthUrl = (secret, accountLabel) =>
  authenticator.keyuri(accountLabel, "Fidelx Admin", secret);

const getQrCodeDataUrl = (otpauthUrl) => QRCode.toDataURL(otpauthUrl);

const verifyToken = (token, secret) => {
  if (!token || !secret) return false;
  try {
    return authenticator.verify({ token: String(token).replace(/\s/g, ""), secret });
  } catch {
    // Malformed input (non-numeric, wrong length) — treat as a failed
    // code rather than a crash.
    return false;
  }
};

// Backup codes are the escape hatch for "I lost my phone." Each is
// single-use and stored only as a bcrypt hash — same standard as
// passwords, since a leaked DB shouldn't hand these out in plaintext.
const generateBackupCodes = async (count = 8) => {
  const plain = Array.from({ length: count }, () => crypto.randomBytes(5).toString("hex"));
  const hashed = await Promise.all(plain.map((code) => bcrypt.hash(code, 10)));
  return { plain, hashed };
};

// Returns the array index of the matching hash so the caller can remove
// it (one-time use), or -1 if the code doesn't match any stored hash.
const consumeBackupCode = async (code, hashedCodes = []) => {
  for (let i = 0; i < hashedCodes.length; i++) {
    if (await bcrypt.compare(code, hashedCodes[i])) return i;
  }
  return -1;
};

module.exports = {
  generateSecret,
  buildOtpAuthUrl,
  getQrCodeDataUrl,
  verifyToken,
  generateBackupCodes,
  consumeBackupCode,
};
