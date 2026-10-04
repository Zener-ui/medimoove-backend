const dotenv = require("dotenv");
dotenv.config();

// ============================================================
// STARTUP ENV CHECK — warns, never crashes the process. This is
// visibility for deployment, not a gate: an operator watching the
// startup logs should immediately see what's missing or still a
// placeholder, rather than discovering it later from a confusing
// runtime failure (or, worse, not discovering it at all).
// ============================================================
const checkRequiredEnvVars = () => {
  const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "JWT_SECRET", "PAYSTACK_SECRET_KEY", "CLIENT_URL"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    console.warn(`[STARTUP WARNING] Missing required env vars: ${missing.join(", ")}`);
  }

  if (process.env.JWT_SECRET && /^(your|change|replace|example|secret|test|xxx)/i.test(process.env.JWT_SECRET)) {
    console.warn(
      "[STARTUP WARNING] JWT_SECRET looks like an unchanged placeholder value. " +
      "This is a critical security risk in any real deployment — replace it with a long random secret " +
      "(e.g. `openssl rand -hex 64`) before going live."
    );
  }

  const optionalButRecommended = ["RESEND_API_KEY", "EMAIL_FROM", "PREMBLY_APP_ID", "PREMBLY_X_API_KEY", "CHROME_EXECUTABLE_PATH"];
  const missingOptional = optionalButRecommended.filter((key) => !process.env[key]);
  if (missingOptional.length) {
    console.warn(
      `[STARTUP WARNING] Not set: ${missingOptional.join(", ")}. ` +
      "Password reset emails, rider ID verification, and/or receipt PDFs will degrade or fail without these — see .env.example."
    );
  }
};
checkRequiredEnvVars();

const express = require("express");
const cors = require("cors");

const {
  helmetMiddleware,
  requestId,
  logger,
  generalLimiter,
  paymentLimiter,
  productLimiter,
  requestSizeLimits,
} = require("./middleware/security");

const { maintenanceCheck } = require("./middleware/pilotGuard");

const app = express();

// Without this, req.ip resolves to your reverse proxy's own address for
// every visitor (Render/Railway/Heroku/etc. all sit behind one) instead
// of each real client's IP — collapsing every rate limiter below onto a
// single shared bucket for your entire platform's traffic, rather than
// one bucket per visitor. `1` trusts exactly one hop (your host's own
// proxy) — the standard setting for these platforms.
app.set("trust proxy", 1);

app.use(helmetMiddleware);
app.use(requestId);
app.use(logger);

app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
  })
);

// Raw body for Paystack webhook
app.use(
  "/api/payments/webhook",
  express.raw({ type: "application/json" })
);

app.use(express.json({ limit: requestSizeLimits.json }));

app.use(
  express.urlencoded({
    extended: true,
    limit: requestSizeLimits.urlencoded,
  })
);

// General rate limit
// Paystack webhooks must not be blocked by visitor/API rate limits or
// maintenance mode. Paystack is a server-to-server source of truth for
// financial state; delaying a legitimate webhook can leave payments,
// refunds, or transfers stuck until reconciliation. The webhook still
// performs its own Paystack signature verification in paymentController.
app.use("/api", (req, res, next) => {
  if (req.path === "/payments/webhook") return next();
  return generalLimiter(req, res, next);
});

// Maintenance mode check on all routes except Paystack's server-to-server
// webhook, which must continue processing financial events during downtime.
app.use((req, res, next) => {
  if (req.path === "/api/payments/webhook") return next();
  return maintenanceCheck(req, res, next);
});

// ============================================================
// ROUTES
// ============================================================

app.use("/api/auth", require("./routes/auth"));

app.use("/api/vendors", require("./routes/vendors"));

app.use(
  "/api/products",
  productLimiter,
  require("./routes/products")
);

app.use("/api/orders", require("./routes/orders"));

app.use(
  "/api/sub-orders",
  require("./routes/subOrders")
);

app.use("/api/riders", require("./routes/riders"));

app.use("/api/payments", require("./routes/payments"));

app.use("/api/reviews", require("./routes/reviews"));
app.use("/api/coupons", require("./routes/coupons"));
app.use("/api/promotions", require("./routes/promotions"));
app.use("/api/referrals", require("./routes/referrals"));

app.use("/api/disputes", require("./routes/disputes"));

app.use(
  "/api/notifications",
  require("./routes/notifications")
);

app.use("/api/support", require("./routes/support"));

app.use("/api/admin", require("./routes/admin"));

app.use("/api/platform-revenue", require("./routes/platformRevenue"));

app.use(
  "/api/withdrawals",
  require("./routes/withdrawals")
);

app.use("/api/delivery", require("./routes/delivery"));

app.use("/api/receipts", require("./routes/receipts"));

app.use("/api/search", require("./routes/search"));

app.use("/api/onboarding", require("./routes/onboarding"));

app.use("/api/preferences", require("./routes/preferences"));

app.use("/api/refunds", require("./routes/refunds"));

app.use("/api/policies", require("./routes/policies"));
app.use("/api/fees", require("./routes/fees"));
app.use("/api/push", require("./routes/push"));

app.use("/api/pilot", require("./routes/pilot"));

app.use("/api/monitoring", require("./routes/monitoring"));

app.use("/api/uploads", require("./routes/uploads"));

app.get("/", (req, res) => {
  res.json({
    message: "Fidelx API v3 running 🚀",
    request_id: req.id,
  });
});

app.use((err, req, res, next) => {
  console.error(
    `[ERROR] request_id=${req.id}`,
    err.stack
  );

  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal server error",
    request_id: req.id,
  });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Fidelx API v3 running on port ${PORT}`);
});