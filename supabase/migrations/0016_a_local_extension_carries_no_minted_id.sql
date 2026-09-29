-- =============================================================================================
-- Migration: 0016_a_local_extension_carries_no_minted_id.sql
-- The two local extensions lose the semantic ids the seed minted for them (#547)
-- =============================================================================================
--
-- 0002 seeded `safety_interlock` and `max_temp_threshold` with ids under
-- `https://aber.local/semantics/local/`. Nothing outside this installation resolves them, so
-- they named no concept, yet the schema builder marked both metrics as mapped and the AAS export
-- left them out of its unmapped count. 0002 now seeds NULL; this clears a database seeded earlier.
--
-- A metric is cleared, id and type together, only while its id is still exactly the one minted
-- for it. An id an Administrator has set since stays.
--
-- An UPDATE, so the audit trigger 0010 attaches records each clear on the Audit Trail: asset
-- lane, actor_source 'migration', changed_by NULL.
--
-- Idempotent: the second run matches nothing.
-- =============================================================================================

SET search_path TO public;

DO $$
DECLARE
    v_cleared integer;
BEGIN
    UPDATE public.metric_catalog
       SET semantic_id = NULL,
           semantic_id_type = NULL
     WHERE (name, semantic_id) IN (
             ('safety_interlock',   'https://aber.local/semantics/local/safety_interlock'),
             ('max_temp_threshold', 'https://aber.local/semantics/local/max_temp_threshold'));
    GET DIAGNOSTICS v_cleared = ROW_COUNT;
    IF v_cleared > 0 THEN
        RAISE NOTICE '0016: cleared the minted semantic id of % local extension(s).', v_cleared;
    END IF;
END;
$$;

-- Self-check: neither metric still holds the id minted for it.
DO $$
DECLARE
    v_left text;
BEGIN
    SELECT string_agg(name, ', ' ORDER BY name) INTO v_left
      FROM public.metric_catalog
     WHERE (name, semantic_id) IN (
             ('safety_interlock',   'https://aber.local/semantics/local/safety_interlock'),
             ('max_temp_threshold', 'https://aber.local/semantics/local/max_temp_threshold'));
    IF v_left IS NOT NULL THEN
        RAISE EXCEPTION '0016 self-check: % still hold(s) the semantic id minted by the seed.', v_left;
    END IF;
END;
$$;
