const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { adminClient } = require("../config/db");
const { sendPasswordResetEmail } = require("../utils/emailService");
const totpService = require("../services/totpService");

const generateToken = (id, authTokenVersion = 1) => {
  return jwt.sign({ id, auth_token_version: authTokenVersion }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
};

// Short-lived, single-purpose token issued after a correct password but
// before a correct 2FA code. Deliberately NOT a real session token — it
// carries a `purpose` claim that /2fa/verify-login checks, so it can't be
// reused as a Bearer token against any other route even if it leaked.
const generatePendingToken = (id) => {
  return jwt.sign({ id, purpose: "2fa_pending" }, process.env.JWT_SECRET, {
    expiresIn: "5m",
  });
};

// Canonical phone format: local "0XXXXXXXXXX". Used everywhere a phone is
// written or looked up (register, login, profile updates) so the same
// real number can never end up stored under two different string shapes
// again — that was the actual root cause of a vendor being unable to log
// in: their phone existed as "08165896780" on one account and
// "+2348165896780" on a completely different account, and the login
// query's .single() call throws when it matches more than one row. That
// error was being caught and reported as "Invalid credentials", which is
// indistinguishable from a wrong password. See normalizeEmail below for
// the same class of bug on email casing.
const normalizePhone = (raw) => {
  const digits = String(raw || "").replace(/[\s-]/g, "");
  if (digits.startsWith("+234")) return "0" + digits.slice(4);
  if (digits.startsWith("234")) return "0" + digits.slice(3);
  return digits;
};

const normalizeEmail = (raw) => String(raw || "").trim().toLowerCase();

// @route POST /api/auth/register
const register = async (req, res) => {
  try {
    const { email, phone, password, role, full_name, terms_accepted, referred_by_vendor_id, referred_by_customer_id } = req.body;

    if (!email || !phone || !password || !role || !full_name) {
      return res.status(400).json({ success: false, message: "All fields are required." });
    }

    if (!terms_accepted) {
      return res.status(400).json({ success: false, message: "You must accept the Fidelx Terms & Conditions to create an account." });
    }

    const validRoles = ["customer", "vendor", "rider"];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ success: false, message: "Invalid role." });
    }

    // Referral attribution (e.g. someone signing up from a vendor's
    // shared storefront link). Deliberately best-effort: a bad, stale,
    // or tampered vendor id here should never block someone from
    // creating an account — it just means no referral credit gets
    // recorded, which is a marketing-data loss, not a signup failure.
    let resolvedReferrer = null;
    if (referred_by_vendor_id) {
      const { data: referrerVendor } = await adminClient
        .from("vendors")
        .select("id")
        .eq("id", referred_by_vendor_id)
        .maybeSingle();
      if (referrerVendor) resolvedReferrer = referrerVendor.id;
    }

    // Customer-to-customer referral — a completely separate program
    // from the vendor one above (different column, different reward
    // mechanism). Same best-effort principle: a bad/stale referring
    // customer id never blocks signup, it just means no attribution.
    // Must specifically be an existing customer, not any user id —
    // stops someone passing a vendor/rider/admin id through this field.
    let resolvedCustomerReferrer = null;
    if (referred_by_customer_id) {
      const { data: referrerCustomer } = await adminClient
        .from("users")
        .select("id")
        .eq("id", referred_by_customer_id)
        .eq("role", "customer")
        .maybeSingle();
      if (referrerCustomer) resolvedCustomerReferrer = referrerCustomer.id;
    }

    const normalizedEmail = normalizeEmail(email);
    const normalizedPhone = normalizePhone(phone);

    // Check if user exists — normalized values only, so
    // "David@Example.com" can't slip past a check for "david@example.com",
    // and "+2348165896780" can't slip past a check for "08165896780".
    // Also now actually checks `error` instead of discarding it: previously,
    // if two existing (already-colliding) rows both matched this OR query,
    // .single() would throw, `data` would come back null either way, and
    // this duplicate check would wrongly conclude "no existing user" —
    // silently allowing a THIRD colliding account to be created on top of
    // an existing collision instead of surfacing the problem.
    const { data: existing, error: existingError } = await adminClient
      .from("users")
      .select("id")
      .or(`email.eq.${normalizedEmail},phone.eq.${normalizedPhone}`)
      .maybeSingle();

    if (existingError) {
      return res.status(409).json({ success: false, message: "This email or phone number is already registered." });
    }
    if (existing) {
      return res.status(409).json({ success: false, message: "Email or phone already registered." });
    }

    // Create the account, default onboarding records, and (when required)
    // consume the invite code in ONE database transaction.  The previous
    // flow claimed the invite before the user insert, so a later DB failure
    // could burn a valid single-use invite without creating an account.
    // The RPC also keeps the invite race protection inside the same
    // transaction as account creation.
    const userId = uuidv4();
    // Hash the password before passing it into the atomic registration RPC.
    // The pre-atomic flow created this hash locally; the transaction change
    // must not remove that step because register_user_atomic stores exactly
    // the hash it receives.
    const password_hash = await bcrypt.hash(password, 12);
    const { data: userRows, error: registrationError } = await adminClient.rpc(
      "register_user_atomic",
      {
        p_user_id: userId,
        p_email: normalizedEmail,
        p_phone: normalizedPhone,
        p_password_hash: password_hash,
        p_role: role,
        p_full_name: full_name,
        p_invite_code_id: req.invite_code?.id || null,
      }
    );

    if (registrationError) {
      if (registrationError.code === "INVITE_UNAVAILABLE") {
        return res.status(409).json({
          success: false,
          message: "This invite code was just used by someone else or has expired. Please request a new one.",
        });
      }
      if (registrationError.code === "23505") {
        return res.status(409).json({
          success: false,
          message: "Email or phone already registered.",
        });
      }
      throw registrationError;
    }

    const user = Array.isArray(userRows) ? userRows[0] : userRows;
    if (!user) throw new Error("Account creation failed.");

    // Record T&C acceptance against the account that just checked the
    // box for it — best-effort: the checkbox is the actual gate above
    // (registration already failed above if it wasn't checked), so a
    // failure here logs but doesn't block a real account from working.
    try {
      const { data: policy } = await adminClient
        .from("policies")
        .select("id, version")
        .eq("type", "terms_of_service")
        .eq("is_active", true)
        .single();
      if (policy) {
        await adminClient.from("policy_acceptances").insert({
          id: uuidv4(),
          user_id: user.id,
          policy_id: policy.id,
          policy_version: policy.version,
        });
      }
    } catch (acceptErr) {
      console.error("Failed to record T&C acceptance for", user.id, acceptErr.message);
    }

    const token = generateToken(user.id);
    res.status(201).json({ success: true, token, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/auth/login
// Accepts either "0XXXXXXXXXX" or "+234XXXXXXXXXX" input and returns
// both equivalent forms — phone numbers aren't normalized at
// registration today, so an existing account's stored phone could be
// in either format. Checking both avoids requiring a data migration.
const normalizePhoneVariants = (raw) => {
  const digits = raw.replace(/[\s-]/g, "");
  if (digits.startsWith("+234")) {
    return { local: "0" + digits.slice(4), international: digits };
  }
  if (digits.startsWith("234")) {
    return { local: "0" + digits.slice(3), international: "+" + digits };
  }
  if (digits.startsWith("0")) {
    return { local: digits, international: "+234" + digits.slice(1) };
  }
  return { local: digits, international: digits };
};

const login = async (req, res) => {
  try {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({ success: false, message: "Email or phone number, and password, are required." });
    }

    const trimmed = identifier.trim();
    const isEmail = trimmed.includes("@");

    let query = adminClient
      .from("users")
      .select("id, email, phone, role, full_name, password_hash, is_active, totp_enabled, auth_token_version");

    if (isEmail) {
      query = query.eq("email", normalizeEmail(trimmed));
    } else {
      // Registration and profile updates now always store phone in this
      // one canonical local format, so a plain equality check is enough
      // going forward — no more OR-across-two-formats query, which was
      // the actual mechanism that let two different accounts (one saved
      // as "08165896780", one as "+2348165896780") both match the same
      // login attempt.
      query = query.eq("phone", normalizePhone(trimmed));
    }

    const { data: user, error } = await query.maybeSingle();

    // A real "more than one row matched" error here means the account data
    // itself is in a bad state (e.g. leftover duplicates from before this
    // normalization fix existed) — that's a data problem, not a wrong
    // password, and deserves a message that says so rather than being
    // silently folded into "Invalid credentials" like it was before.
    if (error) {
      return res.status(500).json({ success: false, message: "Something's wrong with this account's data — contact support rather than retrying the password." });
    }
    if (!user) {
      return res.status(401).json({ success: false, message: "Invalid credentials." });
    }

    if (!user.is_active) {
      return res.status(403).json({ success: false, message: "Your account has been suspended." });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: "Invalid credentials." });
    }

    // Admins with 2FA on don't get a real session token off a password
    // alone — password proves identity, but only step one. The frontend
    // should see requires_2fa and prompt for a code, then call
    // /api/auth/2fa/verify-login with the temp_token to finish.
    if (user.role === "admin" && user.totp_enabled) {
      return res.json({
        success: true,
        requires_2fa: true,
        temp_token: generatePendingToken(user.id),
        message: "Enter your authenticator code to finish logging in.",
      });
    }

    const token = generateToken(user.id, user.auth_token_version || 1);
    const { password_hash, totp_enabled, auth_token_version, ...safeUser } = user;

    res.json({ success: true, token, user: safeUser });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/auth/2fa/verify-login
// Second step of admin login: exchanges a valid temp_token + TOTP (or
// backup) code for a real session token.
const verifyLogin2FA = async (req, res) => {
  try {
    const { temp_token, code } = req.body;
    if (!temp_token || !code) {
      return res.status(400).json({ success: false, message: "temp_token and code are required." });
    }

    let decoded;
    try {
      decoded = jwt.verify(temp_token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ success: false, message: "This 2FA session has expired. Please log in again." });
    }

    if (decoded.purpose !== "2fa_pending") {
      return res.status(401).json({ success: false, message: "Invalid session." });
    }

    const { data: user, error } = await adminClient
      .from("users")
      .select("id, email, phone, role, full_name, is_active, totp_secret, totp_enabled, totp_backup_codes, auth_token_version")
      .eq("id", decoded.id)
      .single();

    if (error || !user || !user.is_active || !user.totp_enabled) {
      return res.status(401).json({ success: false, message: "Invalid session." });
    }

    let ok = totpService.verifyToken(code, user.totp_secret);
    let usedBackup = false;
    let remainingBackupCodes = user.totp_backup_codes || [];

    if (!ok) {
      const idx = await totpService.consumeBackupCode(code, user.totp_backup_codes || []);
      if (idx !== -1) {
        ok = true;
        usedBackup = true;
        remainingBackupCodes = [...user.totp_backup_codes];
        remainingBackupCodes.splice(idx, 1);

        // Consume the backup code with an atomic compare-and-swap. Two
        // simultaneous login requests can both verify the same bcrypt hash
        // before either request writes the updated array. The database
        // function only removes the code when the stored array still exactly
        // matches the array we originally read, so only one concurrent request
        // can consume a given backup code.
        const { data: consumed, error: consumeError } = await adminClient.rpc("consume_admin_backup_code_atomic", {
          p_user_id: user.id,
          p_expected_codes: user.totp_backup_codes,
          p_remaining_codes: remainingBackupCodes,
        });
        if (consumeError) throw consumeError;
        if (!consumed) {
          return res.status(401).json({ success: false, message: "This backup code has already been used. Please use another code." });
        }
      }
    }

    if (!ok) {
      return res.status(401).json({ success: false, message: "Invalid 2FA code." });
    }

    const token = generateToken(user.id, user.auth_token_version || 1);
    const { totp_secret, totp_backup_codes, totp_enabled, auth_token_version, ...safeUser } = user;

    res.json({
      success: true,
      token,
      user: safeUser,
      ...(usedBackup && {
        warning: `You logged in with a backup code. ${remainingBackupCodes.length} backup code(s) remaining.`,
      }),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/auth/2fa/setup
// Step 1 of turning 2FA on: generate a secret + QR, but don't require
// it yet — nothing is enforced until /2fa/enable confirms the admin can
// actually generate a valid code with it.
const setup2FA = async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ success: false, message: "2FA is currently only available for admin accounts." });
    }
    if (req.user.totp_enabled) {
      return res.status(400).json({ success: false, message: "2FA is already enabled. Disable it first to generate a new secret." });
    }

    const secret = totpService.generateSecret();
    const otpauthUrl = totpService.buildOtpAuthUrl(secret, req.user.email);
    const qrCode = await totpService.getQrCodeDataUrl(otpauthUrl);

    await adminClient.from("users").update({ totp_secret: secret }).eq("id", req.user.id);

    res.json({
      success: true,
      secret,
      qr_code: qrCode,
      message: "Scan this QR code in your authenticator app (Google Authenticator, Authy, 1Password, etc.), then confirm with POST /api/auth/2fa/enable.",
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/auth/2fa/enable
// Step 2: confirm the admin's authenticator app actually produces valid
// codes before 2FA becomes enforced at login. Returns backup codes once.
const enable2FA = async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, message: "code is required." });

    const { data: user, error } = await adminClient
      .from("users")
      .select("id, totp_secret, totp_enabled")
      .eq("id", req.user.id)
      .single();

    if (error || !user || !user.totp_secret) {
      return res.status(400).json({ success: false, message: "Call /api/auth/2fa/setup first." });
    }
    if (user.totp_enabled) {
      return res.status(400).json({ success: false, message: "2FA is already enabled." });
    }
    if (!totpService.verifyToken(code, user.totp_secret)) {
      return res.status(401).json({ success: false, message: "Invalid code. Check your authenticator app and try again." });
    }

    const { plain, hashed } = await totpService.generateBackupCodes();

    await adminClient
      .from("users")
      .update({ totp_enabled: true, totp_backup_codes: hashed })
      .eq("id", user.id);

    res.json({
      success: true,
      message: "2FA is now enabled on this account.",
      backup_codes: plain,
      warning: "Save these backup codes now — they will not be shown again. Each works once, if you ever lose access to your authenticator app.",
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/auth/2fa/disable
// Requires BOTH the current password and a valid 2FA code — a stolen
// session token alone can't turn this off.
const disable2FA = async (req, res) => {
  try {
    const { password, code } = req.body;
    if (!password || !code) {
      return res.status(400).json({ success: false, message: "password and code are both required to disable 2FA." });
    }

    const { data: user, error } = await adminClient
      .from("users")
      .select("id, password_hash, totp_secret, totp_enabled")
      .eq("id", req.user.id)
      .single();

    if (error || !user) return res.status(401).json({ success: false, message: "Not authorized." });
    if (!user.totp_enabled) {
      return res.status(400).json({ success: false, message: "2FA is not currently enabled." });
    }

    const passwordOk = await bcrypt.compare(password, user.password_hash);
    if (!passwordOk) return res.status(401).json({ success: false, message: "Incorrect password." });

    if (!totpService.verifyToken(code, user.totp_secret)) {
      return res.status(401).json({ success: false, message: "Invalid 2FA code." });
    }

    await adminClient
      .from("users")
      .update({ totp_enabled: false, totp_secret: null, totp_backup_codes: [] })
      .eq("id", user.id);

    res.json({ success: true, message: "2FA has been disabled on this account." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/auth/me
const getMe = async (req, res) => {
  try {
    const { data: user, error } = await adminClient
      .from("users")
      .select("id, email, phone, role, full_name, created_at")
      .eq("id", req.user.id)
      .single();

    if (error) throw error;
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/auth/change-password
const changePassword = async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ success: false, message: "Both current and new password are required." });
    }

    if (new_password.length < 8) {
      return res.status(400).json({ success: false, message: "New password must be at least 8 characters." });
    }

    const { data: user } = await adminClient
      .from("users")
      .select("password_hash")
      .eq("id", req.user.id)
      .single();

    const isMatch = await bcrypt.compare(current_password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: "Current password is incorrect." });
    }

    const password_hash = await bcrypt.hash(new_password, 12);
    const { error: updateError } = await adminClient
      .from("users")
      .update({ password_hash, auth_token_version: (req.user.auth_token_version || 1) + 1 })
      .eq("id", req.user.id);
    if (updateError) throw updateError;

    res.json({ success: true, message: "Password updated successfully." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/auth/forgot-password
// Always returns the same generic response whether or not the email
// exists — this is the actual anti-enumeration mechanism, not a
// formality. Never branch the response body/status on whether a user
// was found.
const GENERIC_RESET_MESSAGE = "If an account exists for that email, a password reset link has been sent.";

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required." });
    }

    const { data: user } = await adminClient
      .from("users")
      .select("id, email, is_active")
      .eq("email", email.trim().toLowerCase())
      .single();

    if (user && user.is_active) {
      // Raw token is what goes in the email link — never stored.
      // Only its hash is stored, so a database read alone can't be
      // used to reset the account (the attacker would still need the
      // raw token that only exists in the email itself).
      const rawToken = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
      const expiresAt = new Date(Date.now() + 20 * 60 * 1000); // 20 minutes

      const { error: tokenSaveError } = await adminClient
        .from("users")
        .update({
          reset_token_hash: tokenHash,
          reset_token_expires_at: expiresAt.toISOString(),
          reset_token_used_at: null,
        })
        .eq("id", user.id);

      // Previously unchecked — if reset_token_hash/expires_at/used_at
      // don't exist yet (password_reset_migration.sql not run), this
      // update fails silently, the token never actually gets saved,
      // and the user later gets a misleading "invalid or expired"
      // error on a link they just clicked seconds after requesting —
      // indistinguishable from a real expiry, but actually a missing
      // migration.
      if (tokenSaveError) {
        console.error("[forgotPassword] Failed to save reset token — is password_reset_migration.sql applied?", tokenSaveError.message);
        return res.status(500).json({ success: false, message: "Something went wrong. Please try again shortly." });
      }

      const resetUrl = `${process.env.CLIENT_URL}/reset-password?token=${rawToken}`;
      await sendPasswordResetEmail(user.email, resetUrl);
    }

    // Same response whether or not `user` was found above.
    res.json({ success: true, message: GENERIC_RESET_MESSAGE });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/auth/reset-password
const resetPassword = async (req, res) => {
  try {
    const { token, new_password } = req.body;

    if (!token || !new_password) {
      return res.status(400).json({ success: false, message: "Token and new password are required." });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ success: false, message: "New password must be at least 8 characters." });
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const now = new Date().toISOString();

    // Hash before the atomic claim. The token must be consumed exactly once:
    // two concurrent reset requests may both verify the token, but only one
    // UPDATE is allowed to match reset_token_hash + unused + unexpired.
    const password_hash = await bcrypt.hash(new_password, 12);

    const { data: consumedRows, error: consumeError } = await adminClient.rpc("consume_password_reset_atomic", {
      p_token_hash: tokenHash,
      p_now: now,
      p_password_hash: password_hash,
    });

    if (consumeError) {
      console.error("[resetPassword] Atomic token consumption failed — is password_reset_migration.sql applied?", consumeError.message);
      return res.status(500).json({ success: false, message: "Something went wrong. Please try again shortly." });
    }

    // Exactly one concurrent request can consume the token. A second request
    // sees no matching hash because the winning update cleared it.
    if (!consumedRows || consumedRows.length !== 1) {
      return res.status(400).json({ success: false, message: "This reset link is invalid or has expired. Please request a new one." });
    }

    res.json({ success: true, message: "Password reset successfully. You can now log in." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  register,
  login,
  getMe,
  changePassword,
  forgotPassword,
  resetPassword,
  verifyLogin2FA,
  setup2FA,
  enable2FA,
  disable2FA,
};
