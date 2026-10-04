const express=require("express");
const router=express.Router();
const {
  getPlatformBalance,getPlatformLedger,getPlatformWithdrawals,
  requestPlatformWithdrawal,approvePlatformWithdrawal
}=require("../controllers/platformRevenueController");
const {protect}=require("../middleware/auth");
const {roles}=require("../middleware/roles");

router.use(protect,roles("admin"));
router.get("/balance",getPlatformBalance);
router.get("/ledger",getPlatformLedger);
router.get("/withdrawals",getPlatformWithdrawals);
router.post("/withdrawals",requestPlatformWithdrawal);
router.put("/withdrawals/:id/approve",approvePlatformWithdrawal);

module.exports=router;
