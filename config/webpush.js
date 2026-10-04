const webpush = require("web-push");

// VAPID_PUBLIC_KEY is also exposed to the frontend (it's meant to be
// public — that's the point of a public key) via /api/push/vapid-key.
// VAPID_PRIVATE_KEY must never leave the backend.
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || "mailto:support@fidelx.example",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.warn("VAPID keys not set — push notifications are disabled until VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are configured.");
}

module.exports = webpush;
