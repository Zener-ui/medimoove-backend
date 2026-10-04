const { adminClient } = require("../config/db");

// Public customer-facing fee settings. The database is the single source of truth.
const getFeeSettings = async (req, res) => {
  try {
    const { data, error } = await adminClient
      .from("fee_settings")
      .select("platform_fee_percentage, withdrawal_fee_percentage, withdrawal_fee_cap")
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    res.json({
      success: true,
      fees: {
        platform_fee_percentage: Number(data?.platform_fee_percentage ?? 3),
        withdrawal_fee_percentage: Number(data?.withdrawal_fee_percentage ?? 1),
        withdrawal_fee_cap: Number(data?.withdrawal_fee_cap ?? 2000),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Unable to load fee settings." });
  }
};

module.exports = { getFeeSettings };
