-- ============================================================
-- FIDELX INVENTORY CONFIRMATION FIX
--
-- Ensures paid orders actually decrement stock_quantity and clear
-- reserved_quantity. Also makes the stock confirmation RPCs explicit
-- and safe to re-run.
-- Run this in the SAME Supabase project used by the deployed backend.
-- ============================================================

CREATE OR REPLACE FUNCTION confirm_product_stock(
  p_product_id UUID,
  p_quantity INT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Invalid inventory confirmation quantity: %', p_quantity;
  END IF;

  UPDATE products
  SET
    stock_quantity = GREATEST(0, stock_quantity - p_quantity),
    reserved_quantity = GREATEST(0, reserved_quantity - p_quantity)
  WHERE id = p_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product % not found during inventory confirmation', p_product_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION confirm_variant_stock(
  p_variant_id UUID,
  p_quantity INT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Invalid variant inventory confirmation quantity: %', p_quantity;
  END IF;

  UPDATE product_variants
  SET
    stock_quantity = GREATEST(0, stock_quantity - p_quantity),
    reserved_quantity = GREATEST(0, reserved_quantity - p_quantity)
  WHERE id = p_variant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Variant % not found during inventory confirmation', p_variant_id;
  END IF;
END;
$$;

-- Re-create the reservation claim used by the backend. Only a still
-- reserved row can be claimed, so repeated payment verification cannot
-- deduct the same reservation twice.
CREATE OR REPLACE FUNCTION claim_reservation(
  p_reservation_id UUID,
  p_new_status TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_claimed INT;
BEGIN
  IF p_new_status NOT IN ('confirmed', 'released') THEN
    RAISE EXCEPTION 'Invalid reservation target status: %', p_new_status;
  END IF;

  UPDATE inventory_reservations
  SET status = p_new_status
  WHERE id = p_reservation_id
    AND status = 'reserved';

  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  RETURN v_claimed > 0;
END;
$$;

-- Make sure the backend's atomic reservation function exists too.
CREATE OR REPLACE FUNCTION atomic_reserve_stock(
  p_product_id UUID,
  p_quantity INT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  rows_updated INT;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RETURN FALSE;
  END IF;

  UPDATE products
  SET reserved_quantity = reserved_quantity + p_quantity
  WHERE id = p_product_id
    AND (stock_quantity - reserved_quantity) >= p_quantity
    AND is_available = true;

  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RETURN rows_updated > 0;
END;
$$;

CREATE OR REPLACE FUNCTION atomic_reserve_variant_stock(
  p_variant_id UUID,
  p_quantity INT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  rows_updated INT;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RETURN FALSE;
  END IF;

  UPDATE product_variants
  SET reserved_quantity = reserved_quantity + p_quantity
  WHERE id = p_variant_id
    AND (stock_quantity - reserved_quantity) >= p_quantity;

  GET DIAGNOSTICS rows_updated = ROW_COUNT;
  RETURN rows_updated > 0;
END;
$$;

