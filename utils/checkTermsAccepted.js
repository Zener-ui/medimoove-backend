const { adminClient } = require("../config/db");

// Shared by vendor/rider registration so the backend enforces T&C
// acceptance too — not just a disabled submit button on the
// frontend. Reuses the existing `policies` / `policy_acceptances`
// tables (type: 'terms_of_service') rather than introducing a new
// vendor/rider-specific terms table.
const checkTermsAccepted = async (userId) => {
  const { data: policy, error: policyError } = await adminClient
    .from("policies")
    .select("id, version")
    .eq("type", "terms_of_service")
    .eq("is_active", true)
    .single();

  if (policyError || !policy) {
    // No active terms configured — fail closed with a clear message
    // rather than silently letting registration through.
    return { accepted: false, message: "Terms & Conditions are not currently available. Please try again shortly." };
  }

  const { data: acceptance } = await adminClient
    .from("policy_acceptances")
    .select("id")
    .eq("user_id", userId)
    .eq("policy_id", policy.id)
    .eq("policy_version", policy.version)
    .maybeSingle();

  if (!acceptance) {
    return { accepted: false, message: "You must accept the Fidelx Terms & Conditions before continuing.", policy };
  }

  return { accepted: true, policy };
};

module.exports = { checkTermsAccepted };
