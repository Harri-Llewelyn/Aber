-- =============================================================================================
-- 0053: the one-shot ledger stops being writable by service_role
-- =============================================================================================
--
-- `one_shot_migrations` is the table that stops a migration running twice. `0040` uses it for the
-- demonstration-seed retirement, and its own header is explicit that **the claim is what branches**:
-- the ledger row is the only thing between a re-provisioned demonstration floor and a boot-time
-- purge that "reports success both times".
--
-- `0040` then granted `ALL` on it to `service_role`.
--
-- WHAT THAT MEANS. `service_role` bypasses RLS, so the table's "RLS with no policy at all" -- which
-- correctly denies `anon` and `authenticated` -- contributes nothing here. Any holder of the service
-- key can `DELETE FROM public.one_shot_migrations`, and the next boot re-runs `0040`'s purge against
-- whatever `Sim_` assets an operator has since provisioned. One statement, no error, and the purge
-- reports success exactly as it did the first time.
--
-- THIS IS THE POSTURE 0026 ALREADY REJECTED, APPLIED INCONSISTENTLY. That migration revoked
-- `service_role`'s direct INSERT on `digital_thread` and replaced it with a pinning RPC, on the
-- argument that "a convention is not what an audit trail rests on" -- while the table guarding a
-- DESTRUCTIVE replay kept `ALL`. The service key is held by the daemon and every edge function; the
-- stack's own threat model treats it as widely deployed.
--
-- SELECT IS DELIBERATELY KEPT. Reading the ledger is how an operator answers "why did the purge not
-- run" through the service key, it discloses a filename and a timestamp, and narrowing the WRITES is
-- the whole finding. Revoking the read as well would be a larger change than the defect warrants and
-- would remove a diagnostic for nothing.
--
-- Migrations are unaffected: db-init connects as `postgres`, which owns the table.
--
-- IDEMPOTENT. REVOKE is re-runnable, which db-init requires -- every migration replays on every
-- boot in filename order.
--
-- Found by the architecture audit of 2026-08-27 (F5).
-- Related: 0040 (the ledger and the claim-branches argument), 0026 (the same narrowing, on
--          digital_thread), 0031 (why a new table arrives already reachable).
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. The revoke
-- ---------------------------------------------------------------------------------------------
-- NAMED PRIVILEGES RATHER THAN `REVOKE ALL` FOLLOWED BY A RE-GRANT. The two-statement form has a
-- window inside the transaction where the role holds nothing, and -- more to the point -- it states
-- the intent backwards: what is being taken away is the ability to WRITE, and the read was never in
-- question.
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
-- BOTH DIRECTIONS, because either alone passes in a state that is broken. Asserting only the
-- refusal would pass on a table nobody can read either, which would have removed a diagnostic
-- without anybody noticing; asserting only the read would pass with the write still open, which is
-- the defect.
--
-- The DELETE is attempted for real, as `service_role`, against the live claim row -- there is no
-- other way to know the grant is what the database thinks it is. It runs inside a sub-block that is
-- rolled back, so a future regression that lets it through destroys nothing on the way to being
-- reported. The 0037/0038 retrofit in this same branch is the same idiom for the same reason.
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
