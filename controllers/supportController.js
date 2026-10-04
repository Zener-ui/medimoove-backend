const { adminClient } = require("../config/db");
const { v4: uuidv4 } = require("uuid");
const { notifyAdmins } = require("../utils/notifyAdmins");
const ESCALATE_IMMEDIATELY = ["refund", "fraud", "payment", "wrong item", "damaged", "safety", "dispute", "stolen"];

const getPriority = (subject, message) => {
  const text = `${subject} ${message}`.toLowerCase();
  const isUrgent = ESCALATE_IMMEDIATELY.some((kw) => text.includes(kw));
  if (isUrgent) return "CRITICAL";
  if (text.includes("delivery") || text.includes("rider")) return "HIGH";
  if (text.includes("product") || text.includes("order")) return "NORMAL";
  return "LOW";
};

// @route POST /api/support/tickets
const createTicket = async (req, res) => {
  try {
    const { subject, message, order_id } = req.body;

    if (!subject || !message) {
      return res.status(400).json({ success: false, message: "Subject and message are required." });
    }

    const priority = getPriority(subject, message);
    const isCritical = priority === "CRITICAL";

    const { data, error } = await adminClient.from("support_tickets").insert({
      id: uuidv4(),
      user_id: req.user.id,
      role: req.user.role,
      subject,
      message,
      order_id: order_id || null,
      priority,
      messages: [],
      status: "OPEN",
    }).select().single();

    if (error) throw error;

    // Notify admin — CRITICAL tickets get highlighted
    await notifyAdmins(
      isCritical ? `🚨 CRITICAL Ticket: ${subject}` : `New Support Ticket: ${subject}`,
      isCritical
        ? `URGENT: ${req.user.role} needs immediate help. Reason may involve: ${subject}`
        : `New ${priority} priority ticket from ${req.user.role}.`
    );

    res.status(201).json({
      success: true,
      ticket: data,
      message: isCritical
        ? "Your ticket has been flagged as urgent. An admin will respond shortly."
        : "Ticket submitted. An admin will get back to you shortly.",
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route GET /api/support/tickets
const getMyTickets = async (req, res) => {
  try {
    const { data, error } = await adminClient
      .from("support_tickets")
      .select("id, subject, priority, status, created_at, messages")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.json({ success: true, tickets: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/support/tickets/:id/reply
const replyToTicket = async (req, res) => {
  try {
    const { message } = req.body;
    const { data: ticket } = await adminClient.from("support_tickets").select("id, messages, user_id").eq("id", req.params.id).single();
    if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found." });

    if (ticket.user_id !== req.user.id && req.user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Not authorized to reply to this ticket." });
    }

    const messages = ticket.messages || [];
    messages.push({ sender: req.user.role, sender_id: req.user.id, message, sent_at: new Date().toISOString() });

    await adminClient.from("support_tickets").update({ messages, status: "IN_PROGRESS" }).eq("id", req.params.id);
    res.json({ success: true, message: "Reply sent." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = { createTicket, getMyTickets, replyToTicket };
