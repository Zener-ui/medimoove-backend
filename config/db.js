const { createClient } = require("@supabase/supabase-js");

// ============================================================
// ADMIN CLIENT
// Uses service role key — bypasses RLS
// Use ONLY for:
//   - Webhook handlers
//   - pg_cron / background jobs
//   - Internal system operations (balance updates, ledger writes)
//   - Admin-initiated actions
// NEVER expose this client to user-facing routes directly
// ============================================================
const adminClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

// ============================================================
// USER SCOPED CLIENT
// Uses anon key — respects RLS
// Use for all customer, vendor, rider operations
// ============================================================
const anonClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ============================================================
// GET USER SCOPED CLIENT WITH JWT
// Scopes all queries to the authenticated user via RLS
// Usage: const db = getUserClient(req.token);
// ============================================================
const getUserClient = (accessToken) => {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    {
      global: {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    }
  );
};

module.exports = { adminClient, anonClient, getUserClient };
