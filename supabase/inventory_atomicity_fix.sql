-- ============================================================
-- FIX #17 — INVENTORY RESERVATION / RELEASE / CONFIRM ATOMICITY
--
-- Keeps the inventory row and stock counters in the same PostgreSQL
-- transaction. This closes crash windows where one side could commit
-- while the other side did not.
-- ============================================================

CREATE OR REPLACE FUNCTION reserve_inventory_item(
  p_product_id UUID,
  p_variant_id UUID,
  p_order_id UUID,
  p_quantity INT,
  p_expires_at TIMESTAMPTZ
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_reservation_id UUID := gen_random_uuid();
  v_updated INT;
  v_product_id UUID;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN
    RAISE EXCEPTION 'Invalid inventory reservation quantity: %', p_quantity;
  END IF;

  IF p_expires_at IS NULL THEN
    RAISE EXCEPTION 'Inventory reservation expiry is required';
  END IF;

  UPDATE products
  SET reserved_quantity = reserved_quantity + p_quantity
  WHERE id = p_product_id
    AND is_available = true
    AND (stock_quantity - reserved_quantity) >= p_quantity;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RAISE EXCEPTION 'Not enough stock for product %', p_product_id;
  END IF;

  IF p_variant_id IS NOT NULL THEN
    SELECT product_id INTO v_product_id
    FROM product_variants
    WHERE id = p_variant_id
    FOR UPDATE;

    IF v_product_id IS NULL OR v_product_id <> p_product_id THEN
      RAISE EXCEPTION 'Variant % does not belong to product %', p_variant_id, p_product_id;
    END IF;

    UPDATE product_variants
    SET reserved_quantity = reserved_quantity + p_quantity
    WHERE id = p_variant_id
      AND (stock_quantity - reserved_quantity) >= p_quantity;

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
      RAISE EXCEPTION 'Not enough stock for variant %', p_variant_id;
    END IF;
  END IF;

  INSERT INTO inventory_reservations (
    id, product_id, variant_id, order_id, quantity, status, expires_at
  ) VALUES (
    v_reservation_id, p_product_id, p_variant_id, p_order_id,
    p_quantity, 'reserved', p_expires_at
  );

  RETURN v_reservation_id;
END;
$$;

CREATE OR REPLACE FUNCTION release_inventory_reservation(
  p_reservation_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_product_id UUID;
  v_variant_id UUID;
  v_quantity INT;
  v_claimed INT;
BEGIN
  UPDATE inventory_reservations
  SET status = 'released'
  WHERE id = p_reservation_id
    AND status = 'reserved'
  RETURNING product_id, variant_id, quantity
  INTO v_product_id, v_variant_id, v_quantity;

  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    RETURN FALSE;
  END IF;

  UPDATE products
  SET reserved_quantity = GREATEST(0, reserved_quantity - v_quantity)
  WHERE id = v_product_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product % not found while releasing reservation %', v_product_id, p_reservation_id;
  END IF;

  IF v_variant_id IS NOT NULL THEN
    UPDATE product_variants
    SET reserved_quantity = GREATEST(0, reserved_quantity - v_quantity)
    WHERE id = v_variant_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Variant % not found while releasing reservation %', v_variant_id, p_reservation_id;
    END IF;
  END IF;

  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION confirm_inventory_reservation(
  p_reservation_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_product_id UUID;
  v_variant_id UUID;
  v_quantity INT;
  v_claimed INT;
  v_updated INT;
BEGIN
  UPDATE inventory_reservations
  SET status = 'confirmed'
  WHERE id = p_reservation_id
    AND status = 'reserved'
  RETURNING product_id, variant_id, quantity
  INTO v_product_id, v_variant_id, v_quantity;

  GET DIAGNOSTICS v_claimed = ROW_COUNT;
  IF v_claimed = 0 THEN
    RETURN FALSE;
  END IF;

  UPDATE products
  SET
    stock_quantity = stock_quantity - v_quantity,
    reserved_quantity = reserved_quantity - v_quantity
  WHERE id = v_product_id
    AND stock_quantity >= v_quantity
    AND reserved_quantity >= v_quantity;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RAISE EXCEPTION 'Insufficient product stock while confirming reservation %', p_reservation_id;
  END IF;

  IF v_variant_id IS NOT NULL THEN
    UPDATE product_variants
    SET
      stock_quantity = stock_quantity - v_quantity,
      reserved_quantity = reserved_quantity - v_quantity
    WHERE id = v_variant_id
      AND stock_quantity >= v_quantity
      AND reserved_quantity >= v_quantity;

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    IF v_updated = 0 THEN
      RAISE EXCEPTION 'Insufficient variant stock while confirming reservation %', p_reservation_id;
    END IF;
  END IF;

  RETURN TRUE;
END;
$$;
