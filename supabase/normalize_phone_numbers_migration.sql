-- ============================================================
-- NORMALIZE EXISTING PHONE NUMBERS — MIGRATION
-- Run this AFTER deploying the authController.js fix.
--
-- WHY: registration never normalized phone format before today, so the
-- same real number could be stored as "08165896780" on one account and
-- "+2348165896780" on a completely different one — both pass the plain
-- string UNIQUE constraint since they're different text values. Login's
-- old query checked both formats at once, so it would match BOTH rows
-- and throw on .single(), which the code silently reported as
-- "Invalid credentials" — indistinguishable from a wrong password. This
-- is exactly what happened to David's vendor account (collided with a
-- separate rider account on the same real number).
--
-- The code fix (authController.js) makes this impossible going forward
-- by always storing and querying one canonical local "0XXXXXXXXXX"
-- format. This migration brings EXISTING rows in line with that, safely:
-- it normalizes anything with no collision, and instead of touching
-- anything ambiguous, it just lists it for you to resolve by hand (same
-- as the vendor/rider fix — rename or merge whichever way makes sense).
-- ============================================================

-- STEP 1 — find any remaining collisions (read-only, run first)
-- If this returns rows, resolve each one manually (same approach as
-- before: rename the phone on whichever account is the duplicate) BEFORE
-- running step 2, since step 2 will skip normalizing anything involved
-- in a collision to avoid a unique-constraint violation.
SELECT
  CASE WHEN phone LIKE '+234%' THEN '0' || substring(phone from 5)
       WHEN phone LIKE '234%' THEN '0' || substring(phone from 4)
       ELSE phone END AS normalized_phone,
  array_agg(id) AS colliding_user_ids,
  array_agg(role) AS roles,
  array_agg(phone) AS original_phone_values,
  COUNT(*) AS collision_count
FROM users
GROUP BY normalized_phone
HAVING COUNT(*) > 1;

-- STEP 2 — normalize every phone number that has NO collision.
-- Anything caught by step 1 is deliberately left untouched here.
UPDATE users
SET phone = CASE
  WHEN phone LIKE '+234%' THEN '0' || substring(phone from 5)
  WHEN phone LIKE '234%' THEN '0' || substring(phone from 4)
  ELSE phone
END
WHERE phone NOT IN (
  SELECT phone FROM users u2
  WHERE (CASE WHEN u2.phone LIKE '+234%' THEN '0' || substring(u2.phone from 5)
              WHEN u2.phone LIKE '234%' THEN '0' || substring(u2.phone from 4)
              ELSE u2.phone END)
    IN (
      SELECT normalized FROM (
        SELECT CASE WHEN phone LIKE '+234%' THEN '0' || substring(phone from 5)
                    WHEN phone LIKE '234%' THEN '0' || substring(phone from 4)
                    ELSE phone END AS normalized
        FROM users
      ) x
      GROUP BY normalized HAVING COUNT(*) > 1
    )
);

-- STEP 3 — confirm: every phone should now start with "0", none with
-- "+234" or "234"
SELECT phone FROM users WHERE phone LIKE '+234%' OR phone LIKE '234%';

-- ============================================================
-- SAME FIX, SAME REASON, FOR EMAIL — registration also never lowercased
-- email before today, so "David@Example.com" and "david@example.com"
-- could exist as two different accounts under the plain UNIQUE
-- constraint. Same collision risk, same fix shape.
-- ============================================================

-- STEP 4 — find any email casing collisions (read-only)
SELECT LOWER(email) AS normalized_email, array_agg(id) AS colliding_user_ids,
       array_agg(role) AS roles, array_agg(email) AS original_email_values, COUNT(*) AS collision_count
FROM users
GROUP BY LOWER(email)
HAVING COUNT(*) > 1;

-- STEP 5 — lowercase every email with no collision
UPDATE users
SET email = LOWER(email)
WHERE email <> LOWER(email)
  AND LOWER(email) NOT IN (
    SELECT LOWER(email) FROM users GROUP BY LOWER(email) HAVING COUNT(*) > 1
  );
