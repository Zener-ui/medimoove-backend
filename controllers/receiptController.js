const { adminClient } = require("../config/db");
const { v4: uuidv4 } = require("uuid");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");

// ============================================================
// XSS ESCAPE — sanitize user-generated content before HTML
// ============================================================
const escapeHtml = (str) => {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};

const generateReceiptHTML = (type, data) => {
  const date = new Date(data.created_at).toLocaleString("en-NG");
  const styles = `
    body{font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333}
    .header{text-align:center;border-bottom:2px solid #00C896;padding-bottom:16px;margin-bottom:20px}
    .logo{font-size:24px;font-weight:900;color:#0A0F2C}.logo span{color:#00C896}
    .badge{display:inline-block;background:#00C896;color:white;padding:4px 12px;border-radius:20px;font-size:12px;margin-top:8px}
    .row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee}
    .total-row{display:flex;justify-content:space-between;padding:12px 0;font-weight:700;font-size:16px;border-top:2px solid #333}
    .footer{text-align:center;margin-top:24px;font-size:12px;color:#aaa}
  `;

  const header = `
    <div class="header">
      <div class="logo">Cart<span>moove</span></div>
      <div class="badge">${escapeHtml(type.replace("_", " "))}</div>
      <div style="font-size:12px;color:#888;margin-top:8px;">Receipt ID: ${escapeHtml(data.receipt_id)}</div>
      <div style="font-size:12px;color:#888;">${escapeHtml(date)}</div>
    </div>
  `;

  if (type === "ORDER") {
    const items = data.items?.map(i =>
      `<div class="row"><span>${escapeHtml(i.name)} x${escapeHtml(String(i.quantity))}</span><span>₦${(i.price * i.quantity).toLocaleString()}</span></div>`
    ).join("") || "";

    return `<html><head><meta charset="UTF-8"><style>${styles}</style></head><body>
      ${header}
      <div style="margin-bottom:16px"><div style="font-size:12px;color:#888;text-transform:uppercase">Order Reference</div>
      <div style="font-size:14px;font-weight:600">#${escapeHtml(data.order_id?.slice(0, 8).toUpperCase())}</div></div>
      ${items}
      <div class="row"><span>Subtotal</span><span>₦${Number(data.subtotal)?.toLocaleString()}</span></div>
      <div class="row"><span>Platform Fee</span><span>₦${Number(data.platform_fee)?.toLocaleString()}</span></div>
      <div class="row"><span>Delivery Fee</span><span>₦${Number(data.delivery_fee)?.toLocaleString()}</span></div>
      <div class="total-row"><span>Total Paid</span><span>₦${Number(data.total)?.toLocaleString()}</span></div>
      <div class="footer">Thank you for shopping with Fidelx 🛒</div>
    </body></html>`;
  }

  if (type === "WITHDRAWAL") {
    return `<html><head><meta charset="UTF-8"><style>${styles}</style></head><body>
      ${header}
      <div class="row"><span>Gross Amount</span><span>₦${Number(data.gross_amount)?.toLocaleString()}</span></div>
      <div class="row"><span>Withdrawal Fee (${escapeHtml(String(data.fee_percentage))}%)</span><span>-₦${Number(data.withdrawal_fee)?.toLocaleString()}</span></div>
      <div class="total-row"><span>Net Payout</span><span>₦${Number(data.net_payout)?.toLocaleString()}</span></div>
      <div class="row"><span>Bank</span><span>${escapeHtml(data.bank_name)}</span></div>
      <div class="row"><span>Account Name</span><span>${escapeHtml(data.account_name)}</span></div>
      <div class="footer">Fidelx Withdrawal Receipt</div>
    </body></html>`;
  }

  if (type === "REFUND") {
    return `<html><head><meta charset="UTF-8"><style>${styles}</style></head><body>
      ${header}
      <div class="row"><span>Order Reference</span><span>#${escapeHtml(data.order_id?.slice(0, 8).toUpperCase())}</span></div>
      <div class="row"><span>Refund Reason</span><span>${escapeHtml(data.reason)}</span></div>
      <div class="total-row"><span>Refund Amount</span><span>₦${Number(data.amount)?.toLocaleString()}</span></div>
      <div class="footer">Refund processed by Fidelx Support</div>
    </body></html>`;
  }

  return `<html><head><meta charset="UTF-8"></head><body>${header}<p>Receipt generated.</p></body></html>`;
};

const createReceipt = async (type, user_id, reference_id, metadata) => {
  const receipt_id = `RCPT-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  const html = generateReceiptHTML(type, { ...metadata, receipt_id });

  const { data, error } = await adminClient.from("receipts").insert({
    id: uuidv4(), receipt_id, type, user_id, reference_id, metadata,
    html_content: html, created_at: new Date().toISOString(),
  }).select().single();

  if (error) console.error("Receipt creation error:", error.message);
  return data;
};

// @route GET /api/receipts/:id/pdf
// Renders the SAME HTML template already used for the in-browser
// receipt (html_content, stored at creation time) to a PDF, via a
// headless Chromium instance — rather than rebuilding the layout in
// a separate PDF-drawing library. Deliberately launches a fresh
// browser per request and closes it immediately after: simpler and
// safer than managing a long-lived shared browser instance across
// concurrent Express requests, at the cost of ~1-2s extra latency
// per PDF. Worth revisiting (e.g. a small browser pool) if PDF
// volume becomes high enough for that to matter.
//
// DEPLOYMENT NOTE: this used to run on full `puppeteer`, which
// bundles its own Chromium download — that bundled Chromium needs
// system shared libraries (libnss3, libatk, etc.) that most minimal
// Node hosting images (Railway, Render, and similar) don't install by
// default, so it would fail to launch in production even though it
// worked fine locally. @sparticuz/chromium is a Chromium build
// specifically compiled to run without those system libraries — this
// is the standard fix for "Puppeteer works locally, 500s in
// production" on exactly this kind of host.
const getReceiptPdf = async (req, res) => {
  let browser;
  try {
    const { data, error } = await adminClient
      .from("receipts")
      .select("html_content, receipt_id")
      .eq("receipt_id", req.params.id)
      .eq("user_id", req.user.id)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, message: "Receipt not found." });
    }

    // CHROME_EXECUTABLE_PATH stays available as a local-dev override
    // (e.g. testing on Windows/Mac against a real installed Chrome) —
    // @sparticuz/chromium's bundled binary is Linux-only, built for
    // exactly the kind of container production actually runs on.
    const executablePath = process.env.CHROME_EXECUTABLE_PATH || (await chromium.executablePath());

    browser = await puppeteer.launch({
      headless: true,
      executablePath,
      args: process.env.CHROME_EXECUTABLE_PATH ? ["--no-sandbox", "--disable-setuid-sandbox"] : chromium.args,
    });
    const page = await browser.newPage();
    await page.setContent(data.html_content, { waitUntil: "networkidle0" });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "20px", bottom: "20px", left: "20px", right: "20px" },
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${data.receipt_id}.pdf"`);
    // page.pdf() on current Puppeteer returns a Uint8Array, not a Node
    // Buffer. res.send() only treats a true Buffer as raw binary — anything
    // else that's an object silently falls through to res.json(), which
    // JSON-stringifies the byte array into text. The response still carries
    // Content-Type: application/pdf and downloads as "receipt.pdf", but the
    // file is actually JSON text, so no PDF reader can open it.
    res.send(Buffer.from(pdfBuffer));
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  } finally {
    if (browser) await browser.close();
  }
};

// @route GET /api/receipts/by-reference/:referenceId
// The frontend has an order/withdrawal/refund's own ID (reference_id),
// not the internally-generated receipt_id (RCPT-...) that the other
// endpoints below key off of — those are different values. This
// bridges the gap: look up the most recent receipt for a given
// reference, then the caller can use its real receipt_id for the
// HTML/PDF endpoints.
const getReceiptByReference = async (req, res) => {
  try {
    const { data, error } = await adminClient
      .from("receipts")
      .select("receipt_id, type, created_at")
      .eq("reference_id", req.params.referenceId)
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, message: "No receipt found for this reference." });
    }

    res.json({ success: true, receipt: data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const getMyReceipts = async (req, res) => {
  try {
    const { data, error } = await adminClient.from("receipts").select("id, receipt_id, type, reference_id, created_at").eq("user_id", req.user.id).order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ success: true, receipts: data });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

const getReceiptById = async (req, res) => {
  try {
    const { data, error } = await adminClient.from("receipts").select("*").eq("receipt_id", req.params.id).eq("user_id", req.user.id).single();
    if (error || !data) return res.status(404).json({ success: false, message: "Receipt not found." });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(data.html_content);
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

module.exports = { getMyReceipts, getReceiptById, getReceiptPdf, getReceiptByReference, createReceipt };
