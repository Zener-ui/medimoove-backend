const { adminClient } = require("../config/db");
const webpush = require("../config/webpush");
const { v4: uuidv4 } = require("uuid");

// @route GET /api/push/vapid-key
// Public — the VAPID public key is meant to be exposed, the frontend
// needs it to create a push subscription.
const getVapidKey = (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) {
    return res.status(503).json({ success: false, message: "Push notifications are not configured yet." });
  }
  res.json({ success: true, key: process.env.VAPID_PUBLIC_KEY });
};

// @route POST /api/push/subscribe
const subscribe = async (req, res) => {
  try {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ success: false, message: "Invalid push subscription." });
    }

    // One row per browser/device (endpoint is unique per subscription).
    // upsert on endpoint means re-subscribing (e.g. after clearing site
    // data) cleanly replaces the old row instead of erroring or
    // duplicating.
    const { error } = await adminClient
      .from("push_subscriptions")
      .upsert(
        { id: uuidv4(), user_id: req.user.id, endpoint, p256dh: keys.p256dh, auth_key: keys.auth },
        { onConflict: "endpoint" }
      );

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/push/unsubscribe
const unsubscribe = async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ success: false, message: "endpoint is required." });

    await adminClient.from("push_subscriptions").delete().eq("endpoint", endpoint).eq("user_id", req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/push/dispatch-internal
// Called only by the database trigger (trg_push_on_notification) added
// in push_notifications_migration.sql — never by the frontend. Guarded
// by a shared secret instead of a user JWT, since there's no logged-in
// user in this request; it's Postgres calling in.
const dispatchInternal = async (req, res) => {
  try {
    const secret = req.headers["x-internal-webhook-secret"];
    if (!secret || secret !== process.env.INTERNAL_WEBHOOK_SECRET) {
      return res.status(401).json({ success: false });
    }

    const { user_id, title, body } = req.body || {};
    if (!user_id || !title) return res.json({ success: true }); // nothing to do

    // notifications.user_id is plain TEXT with no foreign key constraint
    // (unlike push_subscriptions.user_id, which is a strict UUID) — so
    // nothing at the database level guarantees this is actually a valid
    // UUID. It always has been so far, but rather than let a future
    // malformed value hard-crash this endpoint with a Postgres type-cast
    // error, degrade gracefully instead.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(user_id)) return res.json({ success: true, sent: 0, skipped: "user_id not a valid UUID" });

    const { data: subs, error } = await adminClient
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth_key")
      .eq("user_id", user_id);

    if (error) throw error;
    if (!subs?.length) return res.json({ success: true, sent: 0 });

    const payload = JSON.stringify({ title, body: body || "" });

    const results = await Promise.allSettled(
      subs.map((sub) =>
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
          payload
        ).catch(async (err) => {
          // 404/410 means the browser has permanently invalidated this
          // subscription (uninstalled, cleared data, unsubscribed
          // outside the app) — clean it up so we stop trying forever.
          if (err.statusCode === 404 || err.statusCode === 410) {
            await adminClient.from("push_subscriptions").delete().eq("id", sub.id);
          }
          throw err;
        })
      )
    );

    res.json({ success: true, sent: results.filter((r) => r.status === "fulfilled").length, total: subs.length });
  } catch (err) {
    // This endpoint is called by a Postgres trigger with its errors
    // swallowed on that end regardless — but still respond honestly
    // rather than always 200, in case anything else ever calls this.
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { getVapidKey, subscribe, unsubscribe, dispatchInternal };
