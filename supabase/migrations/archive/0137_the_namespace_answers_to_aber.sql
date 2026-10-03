-- =============================================================================================
-- Migration: 0137_the_namespace_answers_to_aber.sql (applied as 0004 until the 1.0 squash)
-- Locally-minted semantic ids move from acs-cymru.local to aber.local (#335, tier 3)
-- =============================================================================================
--
-- `https://acs-cymru.local/semantics/…` was the authority every id minted here sat under -- the
-- MTConnect and ISO 22400 vocabularies, the catalog rows built on them and the two local
-- extensions. The authority is the honesty mechanism (an id under mtconnect.org would assert an
-- interoperability nobody certified), and it carries the platform's name, so it moves with it.
--
-- WHY A MIGRATION AND NOT JUST THE SEED. 0002 re-seeds every vocabulary on every boot, but its
-- DO UPDATE clauses re-stamp metadata and never `semantic_id`: that column is a hand-corrected
-- assertion on metric_catalog and the stable handle downstream systems key on everywhere. A stack
-- installed before 1.0 therefore keeps the old authority on every row until this rewrites it.
--
-- ONLY IDS UNDER THE OLD AUTHORITY MOVE. An operator's own id under any other namespace -- their
-- organisation's, a standard body's -- is left exactly as it is. The path after the authority is
-- kept byte for byte, so `…/mtconnect/v2.0/Axes/C/ANGLE` stays that.
--
-- Nothing else holds a minted id. AAS shell and submodel identifiers and the i3X type ids are
-- derived at request time from AAS_BASE_IRI and the daemon's namespace constants, which the same
-- release moves. History is not rewritten: audit_trail rows carry what they carried.
--
-- Idempotent: the second run matches nothing.
-- =============================================================================================

SET search_path TO public;

DO $$
DECLARE
    v_old constant text := 'https://acs-cymru.local/';
    v_new constant text := 'https://aber.local/';
    v_catalog integer;
    v_mtc     integer;
    v_iso     integer;
BEGIN
    UPDATE public.metric_catalog
       SET semantic_id = v_new || substr(semantic_id, length(v_old) + 1)
     WHERE semantic_id LIKE v_old || '%';
    GET DIAGNOSTICS v_catalog = ROW_COUNT;

    UPDATE public.mtconnect_vocabulary
       SET semantic_id = v_new || substr(semantic_id, length(v_old) + 1)
     WHERE semantic_id LIKE v_old || '%';
    GET DIAGNOSTICS v_mtc = ROW_COUNT;

    UPDATE public.iso22400_vocabulary
       SET semantic_id = v_new || substr(semantic_id, length(v_old) + 1)
     WHERE semantic_id LIKE v_old || '%';
    GET DIAGNOSTICS v_iso = ROW_COUNT;

    IF v_catalog + v_mtc + v_iso > 0 THEN
        RAISE NOTICE '0004: % catalog, % MTConnect and % ISO 22400 semantic id(s) moved from '
                     'acs-cymru.local to aber.local.', v_catalog, v_mtc, v_iso;
    END IF;
END;
$$;

-- Self-check: no minted id is left under the old authority in any table that holds one.
DO $$
DECLARE
    v_stale integer;
BEGIN
    SELECT (SELECT count(*) FROM public.metric_catalog        WHERE semantic_id LIKE 'https://acs-cymru.local/%')
         + (SELECT count(*) FROM public.mtconnect_vocabulary  WHERE semantic_id LIKE 'https://acs-cymru.local/%')
         + (SELECT count(*) FROM public.iso22400_vocabulary   WHERE semantic_id LIKE 'https://acs-cymru.local/%')
      INTO v_stale;
    IF v_stale > 0 THEN
        RAISE EXCEPTION '0004 self-check: % semantic id(s) still under acs-cymru.local', v_stale;
    END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
