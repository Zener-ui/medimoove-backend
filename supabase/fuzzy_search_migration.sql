-- ============================================================
-- FUZZY PRODUCT SEARCH — MIGRATION
--
-- WHY: search previously only did a plain ILIKE '%query%' substring
-- match — "resembles" queries (typos, reordered words, e.g. "chiken"
-- for "chicken", or "rice jollof" for "Jollof Rice") never matched at
-- all. pg_trgm (Postgres's trigram similarity extension, standard on
-- Supabase) allows genuine fuzzy matching instead.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram indexes make fuzzy matching fast even as the product
-- catalog grows — without these, trigram matching still works
-- correctly, just via a slower sequential scan.
CREATE INDEX IF NOT EXISTS idx_products_name_trgm ON products USING GIN (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_products_description_trgm ON products USING GIN (description gin_trgm_ops);

-- The similarity threshold is set directly on the function (not via a
-- standalone SET statement, which would only apply to the SQL editor's
-- current session and never reach the backend's actual queries) —
-- lowered slightly from Postgres's default so short local-market
-- search terms (e.g. "rice") still perform well without an excessive
-- false-positive rate. Adjust here if results ever feel too loose or
-- too strict.
CREATE OR REPLACE FUNCTION search_products_fuzzy(p_query TEXT)
RETURNS TABLE(id UUID) AS $$
BEGIN
  RETURN QUERY
  SELECT p.id
  FROM products p
  WHERE p.name ILIKE '%' || p_query || '%'
     OR p.description ILIKE '%' || p_query || '%'
     OR p.name % p_query
     OR p.description % p_query
  ORDER BY
    CASE WHEN p.name ILIKE '%' || p_query || '%' THEN 0 ELSE 1 END,
    GREATEST(similarity(p.name, p_query), similarity(COALESCE(p.description, ''), p_query)) DESC
  LIMIT 200;
END;
$$ LANGUAGE plpgsql STABLE SET pg_trgm.similarity_threshold = 0.25;
