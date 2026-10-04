const { adminClient } = require("../config/db");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");
const bcrypt = require("bcryptjs");
const { notifyAdmins } = require("../utils/notifyAdmins");
const { notifyUser } = require("../utils/notify");

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_HEADERS = {
  Authorization: `Bearer ${PAYSTACK_SECRET}`,
  "Content-Type": "application/json",
};

// Paystack's bank list is the source of truth — never a free-text field.
const getBanks = async (req, res) => {
  try {
    if (!PAYSTACK_SECRET) {
      return res.status(500).json({ success: false, message: "PAYSTACK_SECRET_KEY is not configured on the backend." });
    }
    const response = await axios.get("https://api.paystack.co/bank", {
      params: { currency: "NGN", perPage: 100 },
      headers: PAYSTACK_HEADERS,
    });
    const banks = (response.data?.data || [])
      .filter((bank) => bank.active && !bank.is_deleted && bank.type === "nuban")
      .map(({ name, code, slug }) => ({ name, code, slug }));
    res.json({ success: true, banks });
  } catch (err) {
    const message = err.response?.data?.message || err.message;
    res.status(502).json({ success: false, message: `Unable to load banks from Paystack: ${message}` });
  }
};

// Resolve the account before a withdrawal is created — the account
// name Paystack returns is authoritative; the client cannot type its own.
const resolveAccount = async (req, res) => {
  try {
    const account_number = String(req.body.account_number || "").replace(/\D/g, "");
    const bank_code = String(req.body.bank_code || "").trim();

    if (!/^\d{10}$/.test(account_number)) {
      return res.status(400).json({ success: false, message: "Enter a valid 10-digit Nigerian account number." });
    }
    if (!bank_code) return res.status(400).json({ success: false, message: "Select a bank." });
    if (!PAYSTACK_SECRET) {
      return res.status(500).json({ success: false, message: "PAYSTACK_SECRET_KEY is not configured on the backend." });
    }

    const response = await axios.get("https://api.paystack.co/bank/resolve", {
      params: { account_number, bank_code },
      headers: PAYSTACK_HEADERS,
    });

    const data = response.data?.data;
    if (!data?.account_name) {
      return res.status(422).json({ success: false, message: "Paystack could not verify this bank account." });
    }

    let bank_name = null;
    try {
      const bankResponse = await axios.get("https://api.paystack.co/bank", {
        params: { currency: "NGN", perPage: 100 },
        headers: PAYSTACK_HEADERS,
      });
      bank_name = bankResponse.data?.data?.find((b) => String(b.code) === bank_code)?.name || null;
    } catch (_) {
      // account is already verified; bank_name here is only display metadata
    }

    res.json({
      success: true,
      verified: true,
      account: { account_number, account_name: data.account_name, bank_code, bank_name },
    });
  } catch (err) {
    const message = err.response?.data?.message || "Unable to verify this bank account.";
    res.status(err.response?.status === 422 ? 422 : 502).json({ success: false, message });
  }
};

const getFeeSettings = async () => {
  const { data } = await adminClient.from("fee_settings").select("withdrawal_fee_percentage, withdrawal_fee_cap").single();
  return { feePercentage: data?.withdrawal_fee_percentage ?? 1, feeCap: data?.withdrawal_fee_cap ?? 2000 };
};

const calculateWithdrawalFee = (grossAmount, feePercentage = 1, feeCap = 2000) => {
  const fee = Math.round((feePercentage / 100) * grossAmount);
  const cappedFee = Math.min(fee, feeCap);
  return { gross_amount: grossAmount, withdrawal_fee: cappedFee, net_payout: grossAmount - cappedFee, fee_percentage: feePercentage, fee_cap: feeCap, fee_was_capped: fee > feeCap };
};

// ============================================================
// WITHDRAWAL PIN
// A 4-digit PIN, separate from the account password, that vendors
// and riders must set once and then re-enter on every withdrawal
// request — an extra confirmation step before money moves. Stored
// as a bcrypt hash on users.withdrawal_pin_hash, same pattern as
// the account password.
// ============================================================

const PIN_REGEX = /^\d{4}$/;

// Paystack rejects transfers below its own minimum, which was surfacing to
// admins as a confusing 502 at approval time instead of being caught up
// front. Blocking it at request time means it never reaches that point.
const MIN_WITHDRAWAL_AMOUNT = 100;

// @route GET /api/withdrawals/pin/status
const getPinStatus = async (req, res) => {
  try {
    const { data: user, error } = await adminClient
      .from("users")
      .select("withdrawal_pin_hash")
      .eq("id", req.user.id)
      .single();
    if (error) throw error;
    res.json({ success: true, pin_set: !!user?.withdrawal_pin_hash });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// @route POST /api/withdrawals/pin/set
// First-time setup: { pin }. Changing an existing PIN: { pin, current_pin }.
const setWithdrawalPin = async (req, res) => {
  try {
    const { pin, current_pin } = req.body;
    if (!PIN_REGEX.test(String(pin || ""))) {
      return res.status(400).json({ success: false, message: "PIN must be exactly 4 digits." });
    }

    const { data: user, error } = await adminClient
      .from("users")
      .select("withdrawal_pin_hash")
      .eq("id", req.user.id)
      .single();
    if (error) throw error;

    if (user?.withdrawal_pin_hash) {
      // Changing an existing PIN requires proving you know the old one —
      // otherwise anyone with a hijacked session could silently swap the
      // PIN out from under the real account holder.
      if (!current_pin) {
        return res.status(400).json({ success: false, message: "Enter your current PIN to set a new one." });
      }
      const matches = await bcrypt.compare(String(current_pin), user.withdrawal_pin_hash);
      if (!matches) {
        // 400, not 401 — a wrong PIN means this one request is
        // rejected, not that the account's login session is invalid.
        // The frontend's global API client force-logs-out on ANY 401
        // (see api/client.js), which previously meant a mistyped PIN
        // was logging people straight out of the app.
        return res.status(400).json({ success: false, message: "Current PIN is incorrect." });
      }
    }

    const withdrawal_pin_hash = await bcrypt.hash(String(pin), 10);
    await adminClient.from("users").update({ withdrawal_pin_hash }).eq("id", req.user.id);

    res.json({ success: true, message: user?.withdrawal_pin_hash ? "Withdrawal PIN updated." : "Withdrawal PIN set." });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};


const requestWithdrawal = async (req, res, type) => {
  try {
    const { amount, bank_account, bank_code, bank_name, account_name, pin } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: "Invalid withdrawal amount." });
    if (amount < MIN_WITHDRAWAL_AMOUNT) {
      return res.status(400).json({ success: false, message: `Minimum withdrawal amount is ₦${MIN_WITHDRAWAL_AMOUNT}.` });
    }
    if (!bank_code) return res.status(400).json({ success: false, message: "Bank account must be verified before requesting a withdrawal." });

    // Withdrawal PIN check — a separate confirmation step from the
    // account password, required on every withdrawal request.
    if (!PIN_REGEX.test(String(pin || ""))) {
      return res.status(400).json({ success: false, message: "Enter your 4-digit withdrawal PIN." });
    }
    const { data: pinUser } = await adminClient.from("users").select("withdrawal_pin_hash").eq("id", req.user.id).single();
    if (!pinUser?.withdrawal_pin_hash) {
      return res.status(400).json({ success: false, message: "Set up a withdrawal PIN before requesting a withdrawal." });
    }
    const pinMatches = await bcrypt.compare(String(pin), pinUser.withdrawal_pin_hash);
    if (!pinMatches) {
      // Same reasoning as above — 400, never 401, for a wrong PIN.
      return res.status(400).json({ success: false, message: "Incorrect withdrawal PIN." });
    }

    let entityId = null;
    if (type === "vendor") {
      const { data: vendor } = await adminClient.from("vendors").select("id, status").eq("user_id", req.user.id).single();
      if (!vendor || vendor.status !== "approved") return res.status(403).json({ success: false, message: "Vendor account not approved." });
      entityId = vendor.id;
    } else {
      const { data: rider } = await adminClient.from("riders").select("id, status").eq("user_id", req.user.id).single();
      if (!rider || rider.status !== "approved") return res.status(403).json({ success: false, message: "Rider account not approved." });
      entityId = rider.id;
    }

    const { data: pending } = await adminClient.from("withdrawals").select("id").eq("requester_id", req.user.id).eq("status", "PENDING").single();
    if (pending) return res.status(400).json({ success: false, message: "You already have a pending withdrawal." });

    const { feePercentage, feeCap } = await getFeeSettings();
    const { gross_amount, withdrawal_fee, net_payout, fee_was_capped } = calculateWithdrawalFee(amount, feePercentage, feeCap);
    const withdrawalId = uuidv4();

    // The balance deduction, pending-withdrawal check, withdrawal row, and
    // request ledger entry must succeed or fail together. Previously these
    // were separate calls, so a failure/crash during the ledger INSERT could
    // leave a valid balance deduction and withdrawal row with no accounting
    // entry. The RPC locks the user's balance row and performs the entire
    // request in one PostgreSQL transaction.
    const { data: withdrawalRow, error: createError } = await adminClient.rpc("create_vendor_rider_withdrawal_atomic", {
      p_withdrawal_id: withdrawalId,
      p_requester_id: req.user.id,
      p_requester_type: type,
      p_vendor_id: type === "vendor" ? entityId : null,
      p_rider_id: type === "rider" ? entityId : null,
      p_gross_amount: gross_amount,
      p_withdrawal_fee: withdrawal_fee,
      p_net_payout: net_payout,
      p_fee_percentage: feePercentage,
      p_fee_cap: feeCap,
      p_fee_was_capped: fee_was_capped,
      p_bank_account: String(bank_account).trim(),
      p_bank_code: String(bank_code).trim(),
      p_bank_name: String(bank_name).trim(),
      p_account_name: String(account_name).trim(),
    });

    if (createError) {
      const message = createError.message || "Unable to create withdrawal request.";
      if (message.includes("already have a pending withdrawal")) {
        return res.status(400).json({ success: false, message: "You already have a pending withdrawal." });
      }
      if (message.includes("Insufficient balance")) {
        const { data: currentBalance } = await adminClient.from("balances").select("available_balance").eq("user_id", req.user.id).maybeSingle();
        const available = Number(currentBalance?.available_balance ?? 0);
        return res.status(400).json({ success: false, message: `Insufficient balance. Available: ₦${available.toLocaleString()}` });
      }
      throw createError;
    }

    // notifications.user_id has no foreign key and is just TEXT, so writing
    // the literal string "admin" here doesn't error — but it also never
    // matches any real admin's actual user_id, meaning this notification
    // was permanently invisible to every admin account.
    await notifyAdmins(
      "New Withdrawal Request",
      `${type} requested ₦${gross_amount.toLocaleString()}. Net: ₦${net_payout.toLocaleString()}`
    );

    res.status(201).json({ success: true, message: "Withdrawal request submitted.", withdrawal: { id: withdrawalId, gross_amount, withdrawal_fee, net_payout, fee_was_capped, status: "PENDING" } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const requestVendorWithdrawal = (req, res) => requestWithdrawal(req, res, "vendor");
const requestRiderWithdrawal = (req, res) => requestWithdrawal(req, res, "rider");

const getMyWithdrawals = async (req, res) => {
  try {
    const { data, error } = await adminClient.from("withdrawals").select("id, gross_amount, withdrawal_fee, net_payout, fee_was_capped, status, requested_at, completed_at, rejection_reason").eq("requester_id", req.user.id).order("requested_at", { ascending: false });
    if (error) throw error;
    res.json({ success: true, withdrawals: data });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

const getAllWithdrawals = async (req, res) => {
  try {
    const { status } = req.query;
    let query = adminClient.from("withdrawals").select("*, users!requester_id(full_name, email, phone)").order("requested_at", { ascending: true });
    if (status) query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, withdrawals: data });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

const approveWithdrawal = async (req, res) => {
  try {
    const { proof_of_payout } = req.body;

    if (!PAYSTACK_SECRET) {
      return res.status(500).json({ success: false, message: "PAYSTACK_SECRET_KEY is not configured on the backend." });
    }

    const { data: withdrawal } = await adminClient.from("withdrawals").select("*").eq("id", req.params.id).single();
    if (!withdrawal) return res.status(404).json({ success: false, message: "Withdrawal not found." });
    if (withdrawal.status !== "PENDING" && withdrawal.status !== "CLAIMED") {
      return res.status(400).json({ success: false, message: "Withdrawal is not pending." });
    }
    if (!withdrawal.bank_code || !withdrawal.bank_account || !withdrawal.account_name) {
      return res.status(400).json({ success: false, message: "Withdrawal has no verified bank details." });
    }

    // ATOMIC CLAIM — BEFORE any Paystack call, not after. This is the
    // actual fix for the audit's finding: the old code called Paystack's
    // live Transfer API first and only tried to atomically claim the
    // withdrawal afterward, so two overlapping "Approve" actions on the
    // same withdrawal could both pass the plain status check above and
    // BOTH successfully call Paystack, sending two real bank transfers
    // for one withdrawal request — only detected, never prevented, by
    // the old code. Now the claim itself is the gate: only the caller
    // whose UPDATE actually matches a still-PENDING row proceeds past
    // this point at all. A concurrent second request gets rejected here,
    // before it can touch Paystack.
    // CLAIMED is an exclusive in-flight state, not a state that another
    // approval request may adopt.  Only the atomic PENDING -> CLAIMED
    // transition is allowed to enter the Paystack section below.  A second
    // concurrent click/request therefore stops here before it can call
    // Paystack.  If the first worker crashes, reconciliation owns recovery
    // of the stale CLAIMED row and can return it to PENDING after verifying
    // whether a transfer was actually created.
    const { data: claimed, error: claimErr } = await adminClient.rpc("claim_withdrawal_for_approval", {
      p_withdrawal_id: req.params.id, p_admin_id: req.user.id,
    });
    if (claimErr) throw claimErr;
    if (!claimed) {
      return res.status(409).json({ success: false, message: "This withdrawal is already being processed by another request." });
    }

    // From here on, a crash before the Paystack call has even started
    // leaves the withdrawal safely in CLAIMED with no transfer ever
    // sent — the reconciliation job below can just reset it back to
    // PENDING for a clean retry. Track whether we've actually reached
    // the point of calling Paystack, so the catch block below knows
    // whether "safe to reset to PENDING" still applies.
    let transferCallAttempted = false;

    try {
      // Re-verify immediately before money leaves — the account details
      // were verified at request time, but re-checking right before the
      // transfer protects against a stale/changed account by the time an
      // admin gets to it.
      const resolved = await axios.get("https://api.paystack.co/bank/resolve", {
        params: { account_number: withdrawal.bank_account, bank_code: withdrawal.bank_code },
        headers: PAYSTACK_HEADERS,
      });
      const resolvedName = resolved.data?.data?.account_name;
      if (!resolvedName) throw new Error("Paystack could not re-verify the withdrawal account.");
      if (String(resolvedName).trim().toLowerCase() !== String(withdrawal.account_name).trim().toLowerCase()) {
        throw new Error("The verified account name has changed. Withdrawal requires re-verification.");
      }

      const reference = `cartmoove-withdraw-${withdrawal.id}`;
      const recipient = await axios.post(
        "https://api.paystack.co/transferrecipient",
        { type: "nuban", name: resolvedName, account_number: withdrawal.bank_account, bank_code: withdrawal.bank_code, currency: "NGN" },
        { headers: PAYSTACK_HEADERS }
      );
      const recipientCode = recipient.data?.data?.recipient_code;
      if (!recipientCode) throw new Error("Paystack did not return a transfer recipient code.");

      // From this call onward, a real transfer may exist at Paystack
      // even if something after this line throws or the process
      // crashes — reference is deterministic (derived from
      // withdrawal.id, not randomly generated), so Paystack itself
      // will reject a genuine duplicate transfer attempt using the
      // same reference rather than silently sending money twice. This
      // is what "idempotent external-transfer strategy" concretely
      // means here: the reference IS the idempotency key Paystack
      // enforces on its side, independent of anything our own DB
      // claim did.
      transferCallAttempted = true;
      const transfer = await axios.post(
        "https://api.paystack.co/transfer",
        {
          source: "balance",
          amount: Math.round(Number(withdrawal.net_payout) * 100),
          recipient: recipientCode,
          currency: "NGN",
          reason: `Cartmoove withdrawal ${withdrawal.id.slice(0, 8)}`,
          reference,
        },
        { headers: PAYSTACK_HEADERS }
      );
      const transferData = transfer.data?.data;
      if (!transferData) throw new Error("Paystack did not return a transfer record.");

      // Paystack can return status: "otp" here if "Disable OTP for Transfers"
      // hasn't been turned on in Settings → Preferences on the Paystack
      // dashboard. When that happens, the transfer does NOT actually move
      // any money — it sits waiting for an OTP code sent to the account
      // owner's phone/email, which this code has no flow to collect or
      // submit. Previously this wasn't checked at all, so a stuck "otp"
      // transfer looked identical to a real success: withdrawal marked
      // PROCESSING, balance already deducted, but nothing ever actually
      // reaches the recipient's bank. Treating it as a hard failure here
      // routes it through the same rollback path as any other Paystack
      // failure (restores balance, marks FAILED, notifies the user) instead
      // of silently lying about the withdrawal's real state.
      if (transferData.status === "otp") {
        throw new Error("Paystack requires an OTP to complete this transfer. Go to your Paystack dashboard → Settings → Preferences and turn on \"Disable OTP for Transfers\", then retry this withdrawal.");
      }

      // We already own this withdrawal exclusively (the CLAIMED claim
      // above is the real guard) — this update just records the
      // transfer details and moves CLAIMED -> PROCESSING. The .eq
      // ("status","CLAIMED") is kept anyway as a defensive belt-and-
      // braces check, not because it's doing the concurrency-safety
      // work here.
      const { data: updated } = await adminClient
        .from("withdrawals")
        .update({
          status: "PROCESSING",
          admin_reviewer_id: req.user.id,
          proof_of_payout: proof_of_payout || null,
          paystack_recipient_code: recipientCode,
          paystack_transfer_id: transferData.id ? String(transferData.id) : null,
          paystack_transfer_code: transferData.transfer_code || null,
          paystack_reference: reference,
          paystack_status: transferData.status || "pending",
          reviewed_at: new Date().toISOString(),
        })
        .eq("id", withdrawal.id)
        .eq("status", "CLAIMED")
        .select("id")
        .maybeSingle();

      if (!updated) {
        // Extremely unlikely given the claim above, but if it somehow
        // happens (e.g. a manual DB edit), don't leave this unrecorded.
        await adminClient.from("audit_logs").insert({
          id: uuidv4(), action: "WITHDRAWAL_APPROVE_RACE_DETECTED", actor_id: req.user.id, target_id: req.params.id,
          target_type: "withdrawal", details: { paystack_transfer_id: transferData.id, note: "Transfer was initiated but the withdrawal row was no longer CLAIMED when we tried to record it — check Paystack dashboard for this transfer manually." },
        });
        return res.status(409).json({ success: false, message: "This withdrawal's state changed unexpectedly. A Paystack transfer may have been initiated — please check the Paystack dashboard before retrying." });
      }

      // Withdrawal-fee revenue is no longer credited here — see
      // paymentController.js's transfer.success webhook handler. It's
      // only booked once Paystack actually confirms the transfer
      // completed, not merely "accepted for processing" (audit item 6).

      await adminClient.from("audit_logs").insert({
        id: uuidv4(), action: "WITHDRAWAL_APPROVED", actor_id: req.user.id, target_id: req.params.id, target_type: "withdrawal",
        details: { gross_amount: withdrawal.gross_amount, net_payout: withdrawal.net_payout, paystack_reference: reference },
      });
      await notifyUser(withdrawal.requester_id, {
        title: "Withdrawal Processing",
        body: `Your withdrawal of ₦${Number(withdrawal.net_payout).toLocaleString()} has been sent to Paystack and is being processed.`,
        preferenceKey: "email_withdrawal_updates",
        emailSubject: "Withdrawal processing",
        emailHtml: `<p>Your withdrawal of <strong>₦${Number(withdrawal.net_payout).toLocaleString()}</strong> has been sent to Paystack and is being processed.</p>`,
      });

      res.json({ success: true, message: "Withdrawal sent to Paystack and is processing.", status: "PROCESSING" });
    } catch (innerErr) {
      if (!transferCallAttempted) {
        // Nothing was ever sent to Paystack — safe to hand this
        // withdrawal back for a clean retry rather than leaving it
        // stuck CLAIMED with no path forward.
        await adminClient.from("withdrawals").update({ status: "PENDING" }).eq("id", withdrawal.id).eq("status", "CLAIMED");
      } else {
        // A transfer call WAS made and then something failed (network
        // drop reading the response, a crash, etc.) — we genuinely
        // don't know if Paystack received and is acting on it. Do NOT
        // reset to PENDING (a retry could send a second real transfer
        // with a fresh reference if it doesn't reuse the deterministic
        // one) and do NOT guess. Leave it CLAIMED and let the
        // reconciliation job below resolve it by asking Paystack
        // directly, using the one piece of information that's safe to
        // reuse: the deterministic reference.
        await adminClient.from("audit_logs").insert({
          id: uuidv4(), action: "WITHDRAWAL_APPROVE_UNCERTAIN_OUTCOME", actor_id: req.user.id, target_id: req.params.id,
          target_type: "withdrawal", details: { error: innerErr.message, note: "Transfer call was attempted but its outcome is unknown. Left CLAIMED for reconciliation." },
        });
      }
      throw innerErr;
    }
  } catch (err) {
    const message = err.response?.data?.message || err.message;

    // If the Paystack call failed before a transfer was ever created (bad
    // recipient, insufficient Paystack balance, minimum-amount rejection,
    // etc.), the withdrawal row is still PENDING and the requester's app
    // balance was already deducted atomically at request time. Without this,
    // that money is stuck deducted with no transfer and no way to withdraw
    // again (requestWithdrawal blocks a second request while one is still
    // PENDING) — same rollback pattern as approvePlatformWithdrawal.
    const { data: current } = await adminClient
      .from("withdrawals")
      .select("status, gross_amount, requester_id")
      .eq("id", req.params.id)
      .single();

    if (current?.status === "PENDING") {
      await adminClient.rpc("restore_balance_after_rejection", {
        p_user_id: current.requester_id,
        p_amount: current.gross_amount,
      });
      await adminClient
        .from("withdrawals")
        .update({
          status: "FAILED",
          admin_reviewer_id: req.user.id,
          rejection_reason: message,
          reviewed_at: new Date().toISOString(),
        })
        .eq("id", req.params.id);
      await notifyUser(current.requester_id, {
        title: "Withdrawal Failed",
        body: `Your withdrawal could not be processed: ${message}. Your balance has been restored.`,
        preferenceKey: "email_withdrawal_updates",
        emailSubject: "Withdrawal failed — balance restored",
        emailHtml: `<p>Your withdrawal could not be processed.</p><p><strong>Reason:</strong> ${message}</p><p>Your balance has been restored.</p>`,
      });
    }

    res.status(502).json({ success: false, message });
  }
};

const rejectWithdrawal = async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ success: false, message: "Rejection reason is required." });

    const { data: withdrawal } = await adminClient.from("withdrawals").select("requester_id, gross_amount, status").eq("id", req.params.id).single();
    if (!withdrawal) return res.status(404).json({ success: false, message: "Withdrawal not found." });
    if (withdrawal.status !== "PENDING") return res.status(400).json({ success: false, message: "Withdrawal is not pending." });

    // ATOMIC REJECTION — marking the withdrawal REJECTED and restoring the
    // reserved balance must succeed or fail together. The old code did
    // these as two separate operations, so a crash after the status update
    // could leave the withdrawal REJECTED while the user's balance stayed
    // deducted permanently. The database function also makes duplicate
    // rejection requests harmless: only PENDING can be claimed.
    const { data: rejected, error: rejectionError } = await adminClient.rpc("reject_vendor_rider_withdrawal", {
      p_withdrawal_id: req.params.id,
      p_admin_id: req.user.id,
      p_rejection_reason: reason,
    });
    if (rejectionError) throw rejectionError;
    if (!rejected) {
      return res.status(409).json({ success: false, message: "Withdrawal is no longer pending." });
    }

    await notifyUser(withdrawal.requester_id, {
      title: "Withdrawal Rejected",
      body: `Your withdrawal was rejected. Reason: ${reason}. Your balance has been restored.`,
      preferenceKey: "email_withdrawal_updates",
      emailSubject: "Withdrawal rejected — balance restored",
      emailHtml: `<p>Your withdrawal request was rejected.</p><p><strong>Reason:</strong> ${reason}</p><p>Your balance has been restored and is available for a new withdrawal request.</p>`,
    });
    await adminClient.from("audit_logs").insert({ id: uuidv4(), action: "WITHDRAWAL_REJECTED", actor_id: req.user.id, target_id: req.params.id, target_type: "withdrawal", details: { reason } });

    res.json({ success: true, message: "Withdrawal rejected and balance restored." });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

const getFeePreview = async (req, res) => {
  try {
    const amount = parseFloat(req.query.amount);
    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: "Invalid amount." });
    const { feePercentage, feeCap } = await getFeeSettings();
    res.json({ success: true, breakdown: calculateWithdrawalFee(amount, feePercentage, feeCap) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

const updateFeeSettings = async (req, res) => {
  try {
    const { withdrawal_fee_percentage, withdrawal_fee_cap } = req.body;
    const { data: existing } = await adminClient.from("fee_settings").select("id").single();
    if (existing) {
      await adminClient.from("fee_settings").update({ withdrawal_fee_percentage, withdrawal_fee_cap, updated_by: req.user.id, updated_at: new Date().toISOString() }).eq("id", existing.id);
    } else {
      await adminClient.from("fee_settings").insert({ id: uuidv4(), withdrawal_fee_percentage, withdrawal_fee_cap, updated_by: req.user.id });
    }
    await adminClient.from("audit_logs").insert({ id: uuidv4(), action: "FEE_SETTINGS_UPDATED", actor_id: req.user.id, target_type: "fee_settings", details: { withdrawal_fee_percentage, withdrawal_fee_cap } });
    res.json({ success: true, message: "Fee settings updated." });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
};

module.exports = { getBanks, resolveAccount, requestVendorWithdrawal, requestRiderWithdrawal, getMyWithdrawals, getAllWithdrawals, approveWithdrawal, rejectWithdrawal, getFeePreview, updateFeeSettings, getPinStatus, setWithdrawalPin };
