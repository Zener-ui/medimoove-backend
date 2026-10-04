-- Fix #23: atomically claim a review helpful vote and increment the counter.
--
-- The old flow inserted a vote and then incremented helpful_count separately.
-- Two different users could lose an increment because of a stale read, and a
-- crash between the two steps could leave a vote row without its count.

CREATE OR REPLACE FUNCTION public.mark_review_helpful_atomic(
  p_review_id UUID,
  p_user_id UUID
)
RETURNS TABLE (
  voted BOOLEAN,
  helpful_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  -- Lock the review row first. This serializes concurrent votes for the
  -- counter while the unique vote constraint protects against duplicates.
  PERFORM 1 FROM reviews WHERE id = p_review_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Review % not found', p_review_id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM review_helpful_votes
    WHERE review_id = p_review_id
      AND user_id = p_user_id
  ) THEN
    SELECT COALESCE(r.helpful_count, 0)
      INTO v_count
    FROM reviews r
    WHERE r.id = p_review_id;

    RETURN QUERY SELECT FALSE, v_count;
    RETURN;
  END IF;

  INSERT INTO review_helpful_votes (id, review_id, user_id)
  VALUES (gen_random_uuid(), p_review_id, p_user_id);

  UPDATE reviews
  SET helpful_count = COALESCE(helpful_count, 0) + 1,
      updated_at = NOW()
  WHERE id = p_review_id
  RETURNING helpful_count INTO v_count;

  RETURN QUERY SELECT TRUE, v_count;
END;
$$;
