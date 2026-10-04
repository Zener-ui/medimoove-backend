const { adminClient } = require("../config/db");
const { v4: uuidv4 } = require("uuid");
const axios = require("axios");

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_HEADERS = {
  Authorization: `Bearer ${PAYSTACK_SECRET}`,
  "Content-Type": "application/json",
};

const PLATFORM_ID = "00000000-0000-0000-0000-000000000001";

const getPlatformBalance = async (req,res) => {
  try {
    const { data,error } = await adminClient.from("platform_accounts")
      .select("*").eq("id",PLATFORM_ID).single();
    if(error) throw error;
    res.json({success:true,balance:data});
  } catch(err) { res.status(500).json({success:false,message:err.message}); }
};

const getPlatformLedger = async (req,res) => {
  try {
    const { data,error } = await adminClient.from("platform_ledger_entries")
      .select("*").order("created_at",{ascending:false}).limit(100);
    if(error) throw error;
    res.json({success:true,entries:data||[]});
  } catch(err) { res.status(500).json({success:false,message:err.message}); }
};

const getPlatformWithdrawals = async (req,res) => {
  try {
    const { data,error } = await adminClient.from("platform_withdrawals")
      .select("*").order("requested_at",{ascending:false});
    if(error) throw error;
    res.json({success:true,withdrawals:data||[]});
  } catch(err) { res.status(500).json({success:false,message:err.message}); }
};

const requestPlatformWithdrawal = async (req,res) => {
  try {
    const {amount,bank_account,bank_code,bank_name,account_name}=req.body||{};
    const numericAmount=Number(amount);
    if(!Number.isFinite(numericAmount)||numericAmount<=0)
      return res.status(400).json({success:false,message:"Enter a valid withdrawal amount."});
    if(!bank_account||!bank_code||!bank_name||!account_name)
      return res.status(400).json({success:false,message:"Bank account, bank code, bank name and account name are required."});

    // Balance deduction, single-active-withdrawal check, withdrawal row,
    // and platform ledger entry now happen in ONE PostgreSQL transaction.
    // This prevents a partial request from leaving the balance and ledger
    // out of sync, and closes the concurrent-request race in the old
    // application-level pending check.
    const id=uuidv4();
    const {data:withdrawal,error}=await adminClient.rpc("create_platform_withdrawal_atomic",{
      p_withdrawal_id:id,
      p_requested_by:req.user.id,
      p_amount:numericAmount,
      p_bank_account:String(bank_account).trim(),
      p_bank_code:String(bank_code).trim(),
      p_bank_name:String(bank_name).trim(),
      p_account_name:String(account_name).trim()
    });

    if(error){
      const message=error.message||"Unable to create platform withdrawal.";
      if(message.includes("already pending or processing"))
        return res.status(400).json({success:false,message:"A platform withdrawal is already pending or processing."});
      if(message.includes("Insufficient platform balance"))
        return res.status(400).json({success:false,message:"Insufficient platform balance."});
      if(message.includes("Invalid withdrawal amount"))
        return res.status(400).json({success:false,message:"Enter a valid withdrawal amount."});
      throw error;
    }

    res.status(201).json({success:true,withdrawal});
  } catch(err) { res.status(500).json({success:false,message:err.message}); }
};

const approvePlatformWithdrawal = async (req,res) => {
  let transferCallAttempted = false;
  try {
    const {data:withdrawal,error}=await adminClient.from("platform_withdrawals")
      .select("*").eq("id",req.params.id).single();
    if(error||!withdrawal) return res.status(404).json({success:false,message:"Platform withdrawal not found."});
    if(withdrawal.status!=="PENDING") return res.status(400).json({success:false,message:"Platform withdrawal is not pending."});
    if(!PAYSTACK_SECRET) return res.status(500).json({success:false,message:"PAYSTACK_SECRET_KEY is not configured on the backend."});

    const { data: claimed } = await adminClient.rpc("claim_platform_withdrawal_for_approval", {
      p_withdrawal_id: withdrawal.id, p_admin_id: req.user.id,
    });
    if (!claimed) return res.status(409).json({success:false,message:"This platform withdrawal is already being processed."});

    const recipient=await axios.post("https://api.paystack.co/transferrecipient",{
      type:"nuban",name:withdrawal.account_name,account_number:withdrawal.bank_account,
      bank_code:withdrawal.bank_code,currency:"NGN"
    },{headers:PAYSTACK_HEADERS});

    const recipientCode=recipient.data?.data?.recipient_code;
    if(!recipientCode) throw new Error("Paystack did not return a transfer recipient code.");

    const reference=`cartmoove-platform-${withdrawal.id}`;
    await adminClient.from("platform_withdrawals").update({ paystack_reference: reference }).eq("id", withdrawal.id).eq("status", "CLAIMED");
    transferCallAttempted = true;
    const transfer=await axios.post("https://api.paystack.co/transfer",{
      source:"balance",amount:Math.round(Number(withdrawal.amount)*100),
      recipient:recipientCode,reason:`Cartmoove platform revenue withdrawal ${withdrawal.id.slice(0,8)}`,
      reference
    },{headers:PAYSTACK_HEADERS});

    const data=transfer.data?.data;
    if(!data) throw new Error("Paystack did not return a transfer record.");

    // Paystack can return `otp` when Transfer OTP has not been disabled.
    // This is a real Paystack transfer record, not a failed API call. Do not
    // restore the platform balance or reset the withdrawal to PENDING here:
    // doing so could allow a second transfer while the first one is still
    // awaiting OTP. Keep the withdrawal PROCESSING with the actual Paystack
    // transfer identifiers and let the normal webhook/reconciliation path
    // resolve its eventual success/failure.
    const transferStatus = String(data.status || "pending").toLowerCase();
    const requiresOtp = transferStatus === "otp";

    await adminClient.from("platform_withdrawals").update({
      status:"PROCESSING",admin_reviewer_id:req.user.id,
      paystack_transfer_id:data.id?String(data.id):null,
      paystack_transfer_code:data.transfer_code||null,
      paystack_status:data.status||"pending",reviewed_at:new Date().toISOString()
    }).eq("id",withdrawal.id);

    res.json({
      success: true,
      message: requiresOtp
        ? "Platform payout was created at Paystack and is awaiting transfer OTP confirmation."
        : "Platform payout sent to Paystack and is processing.",
      status: "PROCESSING",
    });
  } catch(err) {
    const message=err.response?.data?.message||err.message;
    const {data:current}=await adminClient.from("platform_withdrawals")
      .select("status,amount").eq("id",req.params.id).single();

    if(current?.status==="CLAIMED" && !transferCallAttempted){
      await adminClient.from("platform_withdrawals").update({status:"PENDING"}).eq("id",req.params.id).eq("status","CLAIMED");
    } else if(current?.status==="PENDING"){
      await adminClient.rpc("restore_platform_balance",{p_amount:Number(current.amount)});
      await adminClient.from("platform_withdrawals").update({
        status:"FAILED",admin_reviewer_id:req.user.id,failure_reason:message,reviewed_at:new Date().toISOString()
      }).eq("id",req.params.id);
    }
    res.status(502).json({success:false,message});
  }
};

module.exports={getPlatformBalance,getPlatformLedger,getPlatformWithdrawals,requestPlatformWithdrawal,approvePlatformWithdrawal};
