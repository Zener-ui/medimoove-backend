const { adminClient } = require("../config/db");
const { v4: uuidv4 } = require("uuid");
const { sendEmail } = require("./emailService");

// Creates an in-app notification for a user — same as the existing
// scattered `.from("notifications").insert(...)` calls across the
// codebase — and, if the user has opted into this category of email
// (notification_preferences), also sends a matching email.
//
// The in-app notification ALWAYS happens, exactly as before. Email is
// purely additive: it never blocks, delays, or can fail the caller's
// already-completed operation. sendEmail() itself never throws (see
// emailService.js), and any other failure here (a lookup error, etc.)
// is caught and logged rather than propagated — callers of notifyUser
// can await it exactly like they awaited the old notification insert,
// with no new failure mode introduced.
const notifyUser = async (userId, { title, body, emailSubject, emailHtml, preferenceKey }) => {
  await adminClient.from("notifications").insert({
    id: uuidv4(),
    user_id: userId,
    title,
    body,
    is_read: false,
  });

  if (!preferenceKey || !emailSubject || !emailHtml) return;

  try {
    const [{ data: prefs }, { data: user }] = await Promise.all([
      adminClient.from("notification_preferences").select(preferenceKey).eq("user_id", userId).maybeSingle(),
      adminClient.from("users").select("email").eq("id", userId).single(),
    ]);

    // No preferences row (shouldn't normally happen — every real
    // registration path creates one) defaults to sending, matching
    // this column's own database default.
    const wantsEmail = prefs ? prefs[preferenceKey] !== false : true;

    if (wantsEmail && user?.email) {
      await sendEmail({ to: user.email, subject: emailSubject, html: emailHtml });
    }
  } catch (err) {
    console.error(`[notify] Failed to send email notification to user ${userId}:`, err.message);
  }
};

module.exports = { notifyUser };
