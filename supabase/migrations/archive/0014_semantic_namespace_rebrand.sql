-- =============================================================================================
-- 0014_semantic_namespace_rebrand.sql
--
-- Repoints every locally-minted semantic identifier from the retired `factoryplus.local`
-- namespace onto `acs-cymru.local`, matching the rename of the application itself.
--
-- WHY A MIGRATION AND NOT A SEED EDIT. `0002_seed_data.sql` now emits the new namespace, which
-- covers a FRESH database and nothing else. Two of the four columns below hold rows this
-- repository never wrote:
--
--   * `metric_catalog.semantic_id` -- an operator maps a device's metric to a concept in the
--     schema builder, and that row is theirs. A re-seed does not touch it.
--   * `schemas.semantic_id` -- likewise, attached by whoever built the schema.
--
-- Leave them and the deployment ends up with two namespaces side by side: seeded vocabulary rows
-- under acs-cymru.local, operator-authored rows still under factoryplus.local, and an AAS export
-- that emits both as `ExternalReference` values from the same shell.
--
-- WHAT THIS DELIBERATELY DOES NOT CHANGE:
--
--   * `mtconnect.org`, `opcfoundation.org`, `admin-shell.io` and `data.ashrae.org` identifiers.
--     Those are PUBLISHED ids owned by their standards bodies. The whole point of minting local
--     concepts under a namespace we control is that it cannot be confused with one we do not --
--     see README -> Standards, "the namespace is the honesty mechanism". The rename preserves
--     that property exactly; it only changes which domain we are honest about.
--   * The sha256 salt in scripts/generate-opcua-vocabulary.mjs, which derives metric_groups
--     PRIMARY KEYS rather than naming anything.
--
-- IDEMPOTENT, like every file here: db-init replays it on every boot, and the second run matches
-- no rows. The self-check at the end asserts that.
--
-- ⚠ REFERENCE STABILITY. An AAS shell exported before this migration carries the old IRIs. That
-- is the accepted cost of the rename and the reason it is recorded as its own migration rather
-- than folded into a seed: the change is visible, dated, and reversible by symmetry.
-- =============================================================================================

SET search_path TO public;

DO $$
DECLARE
  v_old CONSTANT TEXT := 'https://factoryplus.local/';
  v_new CONSTANT TEXT := 'https://acs-cymru.local/';
  v_total INTEGER := 0;
  v_rows  INTEGER;
  r       RECORD;
BEGIN
  -- Driven off the catalogue rather than a hardcoded list. Every vocabulary added since this was
  -- written (0013 added ASHRAE 223P; more are expected) carries the same column name, and a list
  -- would silently miss them -- the failure being a table left on the old namespace with nothing
  -- reporting it.
  FOR r IN
    SELECT c.table_name
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.column_name  = 'semantic_id'
       AND c.data_type IN ('text', 'character varying')
     ORDER BY c.table_name
  LOOP
    EXECUTE format(
      'UPDATE public.%I SET semantic_id = replace(semantic_id, %L, %L) WHERE semantic_id LIKE %L',
      r.table_name, v_old, v_new, v_old || '%'
    );
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows > 0 THEN
      RAISE NOTICE '0014: % rows repointed in public.%', v_rows, r.table_name;
      v_total := v_total + v_rows;
    END IF;
  END LOOP;

  IF v_total = 0 THEN
    RAISE NOTICE '0014: nothing to repoint (fresh database, or already applied).';
  ELSE
    RAISE NOTICE '0014: % semantic identifier(s) moved to %', v_total, v_new;
  END IF;
END;
$$;

-- Self-check. The loop above is dynamic, so this proves it actually reached every table rather
-- than trusting that it did.
DO $$
DECLARE
  v_left INTEGER := 0;
  v_rows INTEGER;
  r      RECORD;
BEGIN
  FOR r IN
    SELECT c.table_name
      FROM information_schema.columns c
     WHERE c.table_schema = 'public'
       AND c.column_name  = 'semantic_id'
       AND c.data_type IN ('text', 'character varying')
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM public.%I WHERE semantic_id LIKE %L',
      r.table_name, 'https://factoryplus.local/%'
    ) INTO v_rows;
    v_left := v_left + v_rows;
  END LOOP;

  IF v_left > 0 THEN
    RAISE EXCEPTION '0014 self-check: % semantic id(s) still under the retired namespace', v_left;
  END IF;
  RAISE NOTICE '0014 self-check passed: no semantic identifier remains under factoryplus.local.';
END;
$$;

NOTIFY pgrst, 'reload schema';
