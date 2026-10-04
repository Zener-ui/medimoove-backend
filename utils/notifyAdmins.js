const { adminClient } = require("../config/db");
const { v4: uuidv4 } = require("uuid");
const { sendEmail } = require("./emailService");

/**
 * Notifies every user with role='admin'.
 *
 * This exists because four different controllers previously wrote
 * notifications with the literal string "admin" as user_id — since
 * notifications.user_id is TEXT with no foreign key, that insert never
 * errored, but it also never matched any real admin's actual user_id
 * (a UUID), so those notifications were permanently invisible to
 * everyone. This queries real admin accounts and notifies each one.
 *
 * Optionally also emails every admin — used for genuinely urgent
 * platform alerts (e.g. suspected fraud, a stuck financial state).
 * Unlike notifyUser(), this is NOT gated behind a per-admin email
 * preference: these are operational alerts admins need to see, not
 * a marketing/updates category they'd reasonably opt out of.
 */
const notifyAdmins = async (title, body, { emailSubject, emailHtml } = {}) => {
  const { data: admins } = await adminClient.from("users").select("id, email").eq("role", "admin");
  if (!admins?.length) return;

  await adminClient.from("notifications").insert(
    admins.map((admin) => ({
      id: uuidv4(),
      user_id: admin.id,
      title,
      body,
      is_read: false,
    }))
  );

  if (!emailSubject || !emailHtml) return;

  try {
    await Promise.all(
      admins
        .filter((admin) => admin.email)
        .map((admin) => sendEmail({ to: admin.email, subject: emailSubject, html: emailHtml }))
    );
  } catch (err) {
    console.error(`[notifyAdmins] Failed to send admin email notifications:`, err.message);
  }
};

module.exports = { notifyAdmins };
