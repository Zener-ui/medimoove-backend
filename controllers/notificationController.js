const { adminClient } = require("../config/db");

// @route GET /api/notifications
const getMyNotifications = async (req, res) => {
  try {
    const { data, error } = await adminClient
      .from("notifications")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw error;

    res.json({ success: true, notifications: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/notifications/:id/read
const markAsRead = async (req, res) => {
  try {
    await adminClient
      .from("notifications")
      .update({ is_read: true })
      .eq("id", req.params.id)
      .eq("user_id", req.user.id);

    res.json({ success: true, message: "Notification marked as read." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route PUT /api/notifications/read-all
const markAllAsRead = async (req, res) => {
  try {
    await adminClient
      .from("notifications")
      .update({ is_read: true })
      .eq("user_id", req.user.id)
      .eq("is_read", false);

    res.json({ success: true, message: "All notifications marked as read." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/notifications/urgent-notices
// Any authenticated role can hit this — returns active urgent notices
// matching either the caller's own role or "all", most recent first.
// Which ones the caller has already dismissed is tracked client-side
// (see utils/whatsapp.js-style localStorage pattern in the frontend),
// not here — this always returns everything currently active for
// their role, and the frontend decides what's new to them.
const getActiveNotices = async (req, res) => {
  try {
    const { data, error } = await adminClient
      .from("urgent_notices")
      .select("id, title, body, image_url, category, created_at")
      .eq("is_active", true)
      .in("category", [req.user.role, "all"])
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json({ success: true, notices: data || [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { getMyNotifications, markAsRead, markAllAsRead, getActiveNotices };
