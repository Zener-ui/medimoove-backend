/**
 * PREMBLY IDENTITY VERIFICATION SERVICE
 * Docs: https://docs.prembly.com
 *
 * Verifies a Nigerian rider's NIN (National Identification Number)
 * against Prembly's Identitypass API, and cross-checks the returned
 * name against the name on the rider's Fidelx account.
 *
 * ENV VARS REQUIRED (see .env.example):
 *   PREMBLY_APP_ID       - from dashboard.prembly.com → Applications
 *   PREMBLY_X_API_KEY    - from dashboard.prembly.com → API Keys (use the
 *                           sandbox key while testing, live key once approved)
 *   PREMBLY_BASE_URL     - defaults to https://api.prembly.com if unset
 *
 * NOTE ON API VERSIONS: Prembly has migrated some endpoints between a
 * legacy "/identitypass/verification/*" path style and a newer
 * "/verification/*" style depending on account/plan. The endpoint below
 * (/identitypass/verification/nin) is the one documented across their
 * SDKs and integration guides as of this writing. If your dashboard
 * shows a different path under API Reference → NIN, update
 * NIN_ENDPOINT_PATH below to match — everything else in this file
 * stays the same.
 */

const axios = require("axios");

const BASE_URL = process.env.PREMBLY_BASE_URL || "https://api.prembly.com";
const NIN_ENDPOINT_PATH = "/identitypass/verification/nin";

const authHeaders = () => ({
  "app-id": process.env.PREMBLY_APP_ID,
  "x-api-key": process.env.PREMBLY_X_API_KEY,
  accept: "application/json",
  "content-type": "application/json",
});

/**
 * Normalizes a name for comparison: uppercase, strip extra whitespace,
 * strip punctuation. Prembly returns firstname/middlename/surname as
 * separate fields, so we build a comparable full name from those.
 */
const normalizeName = (str = "") =>
  str
    .toUpperCase()
    .replace(/[^A-Z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Compares the account holder's full_name against the NIN record's
 * first/middle/surname. Returns true if all significant name tokens
 * from the account name appear somewhere in the NIN record name
 * (order-independent — NIMC records aren't always in the same order
 * a user types their name).
 */
const namesLikelyMatch = (accountFullName, ninRecord) => {
  const ninFullName = normalizeName(
    [ninRecord.firstname, ninRecord.middlename, ninRecord.surname].filter(Boolean).join(" ")
  );
  const accountTokens = normalizeName(accountFullName).split(" ").filter((t) => t.length > 1);
  const ninTokens = new Set(ninFullName.split(" "));

  if (accountTokens.length === 0) return false;
  const matchedCount = accountTokens.filter((t) => ninTokens.has(t)).length;
  // Require at least half the tokens (e.g. first + last name) to match.
  return matchedCount / accountTokens.length >= 0.5;
};

/**
 * Verifies a NIN against Prembly and cross-checks the name.
 *
 * @param {string} nin - 11-digit National Identification Number
 * @param {string} accountFullName - the rider's full_name on their Fidelx account
 * @returns {Promise<{
 *   verified: boolean,
 *   nameMatch: boolean | null,
 *   reference: string | null,
 *   rawResponse: object,
 *   errorMessage: string | null
 * }>}
 */
const verifyNIN = async (nin, accountFullName) => {
  if (!process.env.PREMBLY_APP_ID || !process.env.PREMBLY_X_API_KEY) {
    return {
      verified: false,
      nameMatch: null,
      reference: null,
      rawResponse: null,
      errorMessage: "Prembly is not configured (missing PREMBLY_APP_ID / PREMBLY_X_API_KEY).",
    };
  }

  try {
    const response = await axios.post(
      `${BASE_URL}${NIN_ENDPOINT_PATH}`,
      { number: nin },
      { headers: authHeaders(), timeout: 15000 }
    );

    const body = response.data;
    const ninData = body?.nin_data || body?.data || {};
    const providerVerified = body?.status === true || body?.verification?.status === "VERIFIED";

    if (!providerVerified) {
      return {
        verified: false,
        nameMatch: null,
        reference: body?.verification?.reference || null,
        rawResponse: body,
        errorMessage: body?.detail || body?.message || "NIN could not be verified by Prembly.",
      };
    }

    const nameMatch = namesLikelyMatch(accountFullName, ninData);

    return {
      verified: providerVerified && nameMatch,
      nameMatch,
      reference: body?.verification?.reference || null,
      rawResponse: body,
      errorMessage: nameMatch
        ? null
        : "NIN is valid, but the name on the NIN record doesn't match the name on your Fidelx account.",
    };
  } catch (err) {
    // Prembly returned a 4xx/5xx, or the request itself failed (timeout, DNS, etc.)
    const providerMessage = err.response?.data?.detail || err.response?.data?.message;
    return {
      verified: false,
      nameMatch: null,
      reference: null,
      rawResponse: err.response?.data || null,
      errorMessage: providerMessage || err.message || "Could not reach the verification service.",
    };
  }
};

module.exports = { verifyNIN };
