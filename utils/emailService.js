const axios = require("axios");

// ============================================================
// EMAIL SERVICE
//
// Uses Resend's HTTP API directly via axios rather than adding the
// `resend` package as a dependency — one less thing to install, and
// swapping providers later just means changing the body of
// sendEmail(), not anything that calls it.
//
// Required env vars for real sending:
//   RESEND_API_KEY   — from resend.com
//   EMAIL_FROM       — e.g. "Fidelx <noreply@yourdomain.com>"
//                       (must be a domain verified in Resend)
//
// If RESEND_API_KEY is not set, emails are logged to the console
// instead of sent — this lets registration/password-reset flows be
// exercised locally without a real provider configured. This should
// never be silently relied on in production; server.js logs a
// startup warning if it's missing (see checkRequiredEnvVars).
// ============================================================

const sendEmail = async ({ to, subject, html }) => {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "Fidelx <noreply@yourdomain.com>";

  if (!apiKey) {
    // eslint-disable-next-line no-console
    console.warn(
      `[emailService] RESEND_API_KEY not set — logging email instead of sending.\n` +
      `  To: ${to}\n  Subject: ${subject}\n  Body: ${html}`
    );
    return { sent: false, reason: "no_api_key" };
  }

  try {
    await axios.post(
      "https://api.resend.com/emails",
      { from, to, subject, html },
      { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" } }
    );
    return { sent: true };
  } catch (err) {
    // Previously this only logged Resend's rejection reason, not the
    // email itself — so a failed send (e.g. Resend's free-tier
    // restriction, which only allows delivery to the account's own
    // verified address) meant the content, including a password reset
    // link, was gone with no way to recover it. Logging the full
    // content on failure means Render's logs stay a valid fallback
    // regardless of WHY the send failed, not just when no API key is
    // configured at all.
    // eslint-disable-next-line no-console
    console.error(
      `[emailService] Failed to send email — logging content as fallback:\n` +
      `  To: ${to}\n  Subject: ${subject}\n  Body: ${html}\n` +
      `  Provider error: ${JSON.stringify(err.response?.data || err.message)}`
    );
    return { sent: false, reason: "provider_error" };
  }
};

const sendPasswordResetEmail = async (toEmail, resetUrl) => {
  return sendEmail({
    to: toEmail,
    subject: "Reset your Fidelx password",
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>Reset your password</h2>
        <p>We received a request to reset your Fidelx password. This link expires in 20 minutes and can only be used once.</p>
        <p><a href="${resetUrl}" style="display:inline-block;background:#DF500C;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;">Reset Password</a></p>
        <p>If you didn't request this, you can safely ignore this email — your password won't be changed.</p>
      </div>
    `,
  });
};

module.exports = { sendEmail, sendPasswordResetEmail };
