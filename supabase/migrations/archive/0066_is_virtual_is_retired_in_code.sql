-- =============================================================================================
-- Migration: 0066_is_virtual_is_retired_in_code.sql
-- The word is gone from every reader; the column waits for a squash, and here is why
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- ---------------------------------------------------------------------------------------------
-- THIS MIGRATION DROPS NOTHING, AND THAT IS THE POINT OF IT
--
-- The rename is complete in code: `0064` added `deployment`, `0065` moved every SQL
-- predicate onto it, and the frontend, the edge functions and provisioning followed. Nothing in
-- this repository READS `gateways.is_virtual` any more.
--
-- The column itself stays, and the attempt to remove it is worth recording because the reason is
-- structural rather than incidental.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THE COLUMN CANNOT BE DROPPED BY A MIGRATION
--
-- db-init replays EVERY migration in filename order on EVERY boot. There is no ledger. So a column
-- can only be dropped if no earlier migration's executed statements reference it -- and `0036` does,
-- twice over:
--
--   * `gateway_health_rows()` NAMES `is_virtual boolean` in its RETURNS TABLE. A later migration
--     that changes that shape makes the next boot fail at 0036 with
--     `cannot change return type of existing function` -- measured, on the first replay after the
--     drop was attempted.
--   * 0036's own self-check runs `SELECT count(*) FROM public.gateway_health`, which EXECUTES the
--     function. Even with the signature reconciled, the body would then reference a column that no
--     longer exists.
--
-- The ways out were all worse than the column:
--
--   * Editing 0036 to name `deployment` makes a migration reference a column that arrives 28 files
--     later. It would work -- bodies are unchecked there -- and it would be a lie about ordering
--     that the next reader has to unpick.
--   * Editing 0036's self-check to skip when the column is absent buys the same thing for the price
--     of a self-check that no longer checks on the path it was written for.
--   * Dropping the column and leaving 0036 broken means a stack that boots today and fails to boot
--     tomorrow, which is the failure this chain's replay model exists to prevent.
--
-- SO THE PHYSICAL REMOVAL IS A SQUASH-TIME TASK. `0001` is already a squashed baseline; that is the
-- mechanism this repository has for chain surgery, and a column drop is chain surgery. When the
-- next squash happens, `is_virtual` and this note go together.
--
-- ---------------------------------------------------------------------------------------------
-- UNTIL THEN THE COLUMN MUST STAY TRUE, WHICH IS WHY 0064's TRIGGER SURVIVES
--
-- A retired column that goes on being written correctly is inert. One that drifts is a trap: a
-- reader who finds `is_virtual = false` on a host-run gateway created next year would reasonably
-- believe it. `sync_gateway_deployment()` keeps it accurate for nothing more than that.
--
-- Related: 0064 (the column that replaced it), 0065 (the predicates), 0036 (the reason it stays).
-- =============================================================================================

SET search_path TO public;

COMMENT ON COLUMN public.gateways.is_virtual IS
  'RETIRED. Nothing reads this column: `deployment` (0064) carries the question it was '
  'being asked -- where the connector runs -- with one meaning instead of three. It is still '
  'written, by sync_gateway_deployment(), so it cannot drift into being wrong; it is not dropped '
  'because 0036 names it in a function signature and calls that function in its own self-check, and '
  'every migration replays on every boot. Remove it at the next baseline squash, with 0066.';


-- ---------------------------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------------------------
-- ASSERTS THE RETIREMENT RATHER THAN THE REMOVAL. What matters is that nothing has quietly started
-- reading the column again -- a new predicate, a new view -- because that is how a retired word
-- comes back and takes its three meanings with it.
--
-- `gateway_health_rows` is the one exception and it is named: it reports the column to Grafana,
-- which selects by name and does not name it. It goes when the column does.
-- ---------------------------------------------------------------------------------------------
DO $selfcheck$
DECLARE
  v_readers text;
  v_synced  boolean;
BEGIN
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO v_readers
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prokind = 'f'
     -- Comments stripped: a body may EXPLAIN that it used to read the column, and a check that
     -- cannot tell a mention from a use forces the documentation to be thinned to keep it quiet.
     AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g') LIKE '%is_virtual%'
     AND p.proname NOT IN ('sync_gateway_deployment', 'gateway_health_rows');

  IF v_readers IS NOT NULL THEN
    RAISE EXCEPTION
      '0066 self-check: function(s) [%] read gateways.is_virtual. That column is retired -- ask '
      '`deployment` instead, which says where the connector runs and means only that.', v_readers;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.gateways'::regclass
       AND NOT tgisinternal
       AND tgname = 'trg_gateways_sync_deployment'
  ) INTO v_synced;

  IF NOT v_synced THEN
    RAISE EXCEPTION
      '0066 self-check: trg_gateways_sync_deployment is gone while is_virtual is still here. The '
      'column would drift from `deployment` on the next write, and a retired column that lies is '
      'worse than one nobody reads.';
  END IF;

  RAISE NOTICE
    '0066 self-check passed: nothing reads is_virtual, and the trigger that keeps it honest until '
    'the next squash is attached.';
END;
$selfcheck$;
