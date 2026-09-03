-- =============================================================================================
-- Migration: 0063_virtual_gateways_get_revoked.sql
-- Revocation asks the right question, so it reaches the gateways this stack actually has
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- ---------------------------------------------------------------------------------------------
-- THE DEFECT, DEMONSTRATED RATHER THAN INFERRED
--
-- A virtual gateway's broker credential survived deletion of its row. Measured end to end on a
-- running stack: create a virtual gateway, issue it a broker account with a known password, publish
-- successfully, DELETE the gateway row, then publish four more times -- all with a PUBACK.
--
-- Nothing was queued in `net.http_request_queue` and no row appeared in `net._http_response`, so
-- the revocation was never ATTEMPTED. Not pg_net failing, not a missing secret: both triggers were
-- enabled and all three vault secrets present. And the rotation itself works -- re-provisioning the
-- same account by hand invalidated the old password immediately.
--
-- `revoke_credential_on_decommission()` gates both arms on `gateway_holds_a_credential()`, which is
-- `NOT g.is_virtual AND g.enrolled_at IS NOT NULL`. Every gateway on a provisioned stack is
-- virtual, so the answer was always false and the revocation path was dead code in practice.
--
-- ---------------------------------------------------------------------------------------------
-- IT WAS DELIBERATE, AND THE REASON IS STILL GOOD -- IT IS THE PREMISE THAT WAS WRONG
--
-- 0040's header states the intent plainly:
--
--     "The guard is there so revocation cannot CREATE an account by rotating one that never
--      existed, and by that definition a simulator gateway holds nothing."
--
-- The guard's PURPOSE is correct and this migration keeps it. Revocation is a rotation through an
-- add-only credential service, so asking it to rotate an account that does not exist does not fail
-- -- it CREATES one, with a password nobody records, for a gateway that never had one. A revocation
-- path that litters the password file is worse than the leak it closes.
--
-- What was wrong is the second half: a simulator gateway holds nothing. It holds exactly what
-- `provision-gateways.mjs` issued it, which is a working broker account, which is why four of them
-- are publishing right now.
--
-- ---------------------------------------------------------------------------------------------
-- SO THE FIX IS THE PREDICATE 0056 ALREADY WROTE, AND NOT AN UNCONDITIONAL ATTEMPT
--
-- `gateway_has_broker_credential()` asks the question the guard was reaching for -- "is there an
-- account at the broker for this gateway" -- through both routes that can create one:
--
--     (NOT is_virtual AND enrolled_at IS NOT NULL)          physical enrolment
--  OR (is_virtual AND a CREDENTIAL_ISSUED row exists)       a mint, by an operator or a script
--
-- and it subtracts revocation. Crucially it CANNOT admit a gateway that never had an account, so it
-- preserves 0040's guarantee exactly while fixing the case that guarantee was over-applied to.
--
-- THE ALTERNATIVE -- attempt for every gateway carrying a sparkplug_id -- was rejected for that
-- reason. It would close the leak and reintroduce the account-creation the original guard exists to
-- prevent, one junk account per gateway ever deleted.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT THIS DOES NOT REACH, AND WHY IT IS A SEPARATE PIECE OF WORK
--
-- The predicate reads a `CREDENTIAL_ISSUED` row, and until 0062 nothing wrote one for a credential
-- issued by provisioning. So a stack installed before 0062 has gateways holding working accounts
-- that this still skips -- measured here: Cell 1, Cell 2 and Cell 3 all publish and all answer false.
-- `provision-gateways.mjs` now backfills that record on a re-run, which is the cheapest path to a
-- correct inventory on an existing install; it is in this change and not in this file, because SQL
-- cannot see the broker's password file and must not guess at it.
--
-- Accounts whose gateway row is ALREADY GONE are unreachable from here by construction -- there is
-- no row to fire a trigger. `scripts/revoke-orphaned-broker-accounts.mjs` is the sweep for those,
-- and it belongs on the host for the same reason: it has to read the password file to know what is
-- there.
--
-- Related: 0038 (the revocation this repairs), 0040 (the deliberate guard and its wrong premise),
--          0056 (the predicate), 0062 (what makes the predicate true for provisioned gateways),
--          scripts/revoke-orphaned-broker-accounts.mjs (what is already accumulated).
-- =============================================================================================

SET search_path TO public;

-- ---------------------------------------------------------------------------------------------
-- 1. The trigger function
-- ---------------------------------------------------------------------------------------------
-- REPRODUCED IN FULL rather than patched, the discipline 0048 and 0051 record: a redeclaration that
-- edited one call would leave the archive arm, the optimistic stamp and the transition guard in a
-- different migration from the live definition. Everything except the predicate is 0038's text.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_credential_on_decommission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The only attempt this one gets; see 0038's header.
    IF public.gateway_has_broker_credential(OLD) THEN
      PERFORM public.revoke_gateway_credential(OLD.sparkplug_id);
    END IF;
    RETURN OLD;
  END IF;

  -- On the TRANSITION, so an ordinary edit to an already-archived gateway does not re-rotate a
  -- credential that was revoked weeks ago and re-stamp when it happened.
  IF NEW.is_archived AND NOT COALESCE(OLD.is_archived, false)
     AND public.gateway_has_broker_credential(NEW) THEN
    IF public.revoke_gateway_credential(NEW.sparkplug_id) THEN
      -- Stamped OPTIMISTICALLY, because net.http_post is asynchronous and cannot report back
      -- inside this transaction. The sweep re-reads net._http_response and CLEARS this stamp if
      -- the call did not succeed, which is what turns an optimistic write into an eventually
      -- correct one.
      UPDATE public.gateways SET credential_revoked_at = now() WHERE id = NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.revoke_credential_on_decommission() IS
  'Rotates a decommissioned gateway''s broker credential to a password nobody records. Gated on '
  'gateway_has_broker_credential() (0056), NOT gateway_holds_a_credential() (0038): the latter '
  'asks about physical enrolment and therefore refused every virtual gateway, which is every '
  'gateway a provisioned stack has. The gate still cannot admit a gateway that never held an '
  'account, so 0040''s guarantee -- revocation never CREATES one -- is preserved.';


-- ---------------------------------------------------------------------------------------------
-- 2. The sweep, which had the same predicate and therefore the same blind spot
-- ---------------------------------------------------------------------------------------------
-- WORTH FIXING SEPARATELY EVEN THOUGH THE TRIGGER NOW WORKS. The sweep is what makes archive
-- EVENTUALLY correct -- it exists precisely for the case where the trigger's asynchronous call did
-- not land -- so leaving it asking the old question would mean a virtual gateway whose revocation
-- failed silently was never retried. The fast path and the safety net have to agree about who they
-- are for.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sweep_gateway_credential_revocations()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_row     record;
  v_asked   int := 0;
BEGIN
  -- FIRST, UNDO OPTIMISM THAT TURNED OUT TO BE WRONG. A stamp written by the trigger means the
  -- request was QUEUED. If pg_net recorded a non-2xx answer, or recorded nothing at all within
  -- five minutes, the revocation did not happen and the stamp is a lie -- clearing it puts the
  -- gateway back into the retry set below.
  UPDATE public.gateways g
     SET credential_revoked_at = NULL
   WHERE g.is_archived
     AND g.credential_revoked_at IS NOT NULL
     AND g.credential_revoked_at < now() - interval '5 minutes'
     AND NOT EXISTS (
       SELECT 1 FROM net._http_response r
        WHERE r.created >= g.credential_revoked_at - interval '1 minute'
          AND r.status_code BETWEEN 200 AND 299
     );

  FOR v_row IN
    SELECT sparkplug_id FROM public.gateways g
     WHERE g.is_archived
       AND g.credential_revoked_at IS NULL
       AND public.gateway_has_broker_credential(g)
     LIMIT 200
  LOOP
    IF public.revoke_gateway_credential(v_row.sparkplug_id) THEN
      UPDATE public.gateways SET credential_revoked_at = now()
       WHERE sparkplug_id = v_row.sparkplug_id;
      v_asked := v_asked + 1;
    END IF;
  END LOOP;

  RETURN v_asked;
END $$;

COMMENT ON FUNCTION public.sweep_gateway_credential_revocations() IS
  'Retries broker-credential revocation for archived gateways whose trigger call did not land, and '
  'clears stamps that pg_net shows were never answered. Run by pg_cron every 15 minutes. Gated on '
  'gateway_has_broker_credential() since 0063. Does nothing for DELETED gateways -- their row is '
  'gone; scripts/revoke-orphaned-broker-accounts.mjs is the sweep for those.';

REVOKE ALL ON FUNCTION public.sweep_gateway_credential_revocations() FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------------------------
-- 3. Self-check
-- ---------------------------------------------------------------------------------------------
-- IT MUST NOT MAKE A NETWORK CALL, and 0038's own self-check records what happens when one does:
-- db-init replays every migration on every boot, so a check that archived a fabricated gateway had
-- the credential service create an account for it -- a junk row in the password file per boot, from
-- the migration whose subject is not littering the password file. The same trap applies here twice
-- over, since the whole point of this change is that the path now fires for virtual gateways.
--
-- So this asserts the WIRING, statically, and the end-to-end proof lives in
-- gateway-credential/test_gateway_credential.py where it runs once and is observed.
-- ---------------------------------------------------------------------------------------------
DO $selfcheck$
DECLARE
  v_trigger_src text;
  v_sweep_src   text;
BEGIN
  SELECT prosrc INTO v_trigger_src
    FROM pg_proc WHERE oid = 'public.revoke_credential_on_decommission()'::regprocedure;
  SELECT prosrc INTO v_sweep_src
    FROM pg_proc WHERE oid = 'public.sweep_gateway_credential_revocations()'::regprocedure;

  IF position('gateway_has_broker_credential' IN v_trigger_src) = 0
     OR position('gateway_holds_a_credential' IN v_trigger_src) > 0 THEN
    RAISE EXCEPTION
      '0063 self-check: the decommission trigger is not gated on gateway_has_broker_credential(). '
      'With the old predicate it refuses every virtual gateway, which is every gateway a '
      'provisioned stack has, and a deleted gateway''s broker account goes on working.';
  END IF;

  IF position('gateway_has_broker_credential' IN v_sweep_src) = 0
     OR position('gateway_holds_a_credential' IN v_sweep_src) > 0 THEN
    RAISE EXCEPTION
      '0063 self-check: the sweep is not gated on gateway_has_broker_credential(). The retry path '
      'would then never reach the gateways the fast path now revokes.';
  END IF;

  -- THE OLD PREDICATE STAYS, and its absence would be the real surprise. 0056 uses it deliberately
  -- to assert what a PHYSICAL gateway is, and 0041's issuance path is about enrolment. This
  -- migration changes who asks which question, not the questions available.
  IF to_regprocedure('public.gateway_holds_a_credential(public.gateways)') IS NULL THEN
    RAISE EXCEPTION
      '0063 self-check: gateway_holds_a_credential() has gone. It is still the right question for '
      'physical enrolment and 0056 asserts with it.';
  END IF;

  RAISE NOTICE
    '0063 self-check passed: revocation and its sweep both ask gateway_has_broker_credential().';
END;
$selfcheck$;
