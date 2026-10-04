const express = require("express");
const router = express.Router();
const { createTicket, getMyTickets, replyToTicket } = require("../controllers/supportController");
const { protect } = require("../middleware/auth");

router.post("/tickets", protect, createTicket);
router.get("/tickets", protect, getMyTickets);
router.post("/tickets/:id/reply", protect, replyToTicket);

module.exports = router;
