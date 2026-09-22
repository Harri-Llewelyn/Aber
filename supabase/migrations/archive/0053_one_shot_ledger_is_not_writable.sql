-- =============================================================================================
-- 0053: the one-shot ledger stops being writable by service_role
-- =============================================================================================
--
-- `one_shot_migrations` is what stops 0040's purge running twice, and 0040 granted `ALL` on it
-- to `service_role`, which bypasses RLS. Any holder of the service key could delete the claim
-- row and the next boot would re-run the purge against whatever assets an operator has since
-- provisioned. SELECT is kept: reading the ledger is a diagnostic and discloses only a filename
-- and a timestamp. Migrations are unaffected: db-init connects as `postgres`, which owns the
-- table. Idempotent: REVOKE is re-runnable.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. The revoke
-- ---------------------------------------------------------------------------------------------
-- Named privileges rather than `REVOKE ALL` followed by a re-grant: what is taken away is the
-- ability to write, and the read was never in question.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.one_shot_migrations FROM service_role;

COMMENT ON TABLE public.one_shot_migrations IS
  'Ledger for migrations that must run exactly once, rather than on every boot like the rest of '
  'the chain. Claimed by INSERT ... ON CONFLICT DO NOTHING inside the same transaction as the '
  'work it guards. Written only by the migration owner (postgres): service_role holds SELECT and '
  'no write since 0053, because deleting a claim re-arms a destructive one-shot and the next boot '
  'reports success exactly as the first did.';

-- ---------------------------------------------------------------------------------------------
-- 2. Self-check
-- ---------------------------------------------------------------------------------------------
-- Both directions: asserting only the refusal would pass on a table nobody can read; asserting
-- only the read would pass with the write still open. The DELETE is attempted for real as
-- `service_role` inside a sub-block that is rolled back.
DO $selfcheck$
DECLARE
    v_refused boolean := false;
    v_rows    integer;
BEGIN
    BEGIN
        SET LOCAL ROLE service_role;

        -- (a) The read must survive.
        SELECT count(*) INTO v_rows FROM public.one_shot_migrations;

        -- (b) The write must not.
        BEGIN
            DELETE FROM public.one_shot_migrations;
        EXCEPTION WHEN insufficient_privilege THEN
            v_refused := true;
        END;

        RESET ROLE;

        IF NOT v_refused THEN
            RAISE EXCEPTION
              '0053 self-check: service_role deleted the one-shot ledger. The claim row is the only '
              'thing standing between a re-provisioned demonstration floor and 0040''s purge running '
              'a second time -- which reports success exactly as it did the first.';
        END IF;

        RAISE EXCEPTION 'rollback_selfcheck';
    EXCEPTION
        WHEN raise_exception THEN
            RESET ROLE;
            IF SQLERRM <> 'rollback_selfcheck' THEN RAISE; END IF;
    END;

    -- Reported rather than asserted: a fresh install has claimed nothing yet, and any count is
    -- legitimate on a long-lived one.
    SELECT count(*) INTO v_rows FROM public.one_shot_migrations;
    RAISE NOTICE
      '0053 self-check: service_role can read the one-shot ledger (% claim(s)) and cannot write it.',
      v_rows;
END;
$selfcheck$;
