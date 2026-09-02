-- =============================================================================================
-- Migration: 0037_archive_withdraws_enrolment.sql
-- Archiving a gateway withdraws its outstanding bundle, and enrolment refuses an archived one
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- ---------------------------------------------------------------------------------------------
-- THE GAP, REPRODUCED ON A RUNNING STACK BEFORE IT WAS CLOSED.
--
-- An operator creates a physical gateway, downloads its bundle, never instantiates it, and archives
-- the gateway. Nothing in that sequence touches the enrolment token. Redeeming the downloaded
-- bundle afterwards was measured to:
--
--   * SUCCEED -- HTTP 200 from enroll-gateway, with a real broker credential applied to the
--     running broker;
--   * RESURRECT the archived gateway to ONLINE, with a live heartbeat and the caller's own
--     `agent_version` string written to the row;
--   * ONBOARD A DEVICE -- a DBIRTH under that edge node put an invented device into the operator's
--     quarantine queue, attributed to hardware they had decommissioned.
--
-- Four places could have refused it and none did: the archive path is a plain UPDATE on `gateways`
-- that never touches the token table, `consume_gateway_enrollment_token()` tested only the hash,
-- `consumed_at` and `expires_at`, `enroll-gateway` checked nothing, and `resolve_gateway()` in the
-- daemon does not filter archived rows.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT ALREADY BOUNDED IT, because the fix should be understood as narrowing a window rather than
-- closing an open door:
--
--   * THE TOKEN TTL IS 30 MINUTES BY DEFAULT and a day at most (`issue_gateway_enrollment_token`).
--     A bundle older than that is inert, which is why this is a real defect and not an emergency.
--   * THE BROKER ACL CONFINES THE CREDENTIAL to `spBv1.0/+/+/%u/#`, so it can address exactly one
--     edge node -- its own -- and cannot forge any other gateway's telemetry.
--   * DEVICE TELEMETRY IS QUARANTINED until an operator approves the device, so nothing reaches
--     the historian on the strength of a DBIRTH alone.
--
-- The reason to fix it anyway is that AN OPERATOR REASONABLY BELIEVES ARCHIVING WITHDRAWS THE
-- BUNDLE. It is the only action the UI offers that looks like decommissioning, and a downloaded
-- file that outlives the thing it belongs to is a surprise in the dangerous direction.
--
-- ---------------------------------------------------------------------------------------------
-- TWO INDEPENDENT DEFENCES, DELIBERATELY, because they fail differently.
--
--   1. A TRIGGER burns live tokens the moment `is_archived` goes true. It runs in the same
--      transaction as the archive, for every caller -- the dashboard, a script, psql -- because it
--      is on the table rather than in the API path the dashboard happens to use.
--   2. `consume_gateway_enrollment_token()` REFUSES an archived gateway outright. That covers a
--      token issued before this migration existed, a row archived by something that somehow
--      bypassed the trigger, and the ordinary race where a bundle is redeemed in the same second
--      it is archived.
--
-- Either alone would close the reproduction above. Both, because the first is a state change and
-- the second is a rule, and a rule that only holds while a state change ran is not a rule.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT THIS DOES NOT DO, AND THE OMISSIONS ARE DECISIONS.
--
-- IT DOES NOT REVOKE AN ALREADY-ISSUED BROKER CREDENTIAL. Nothing in this platform does: the
-- credential service states plainly that it "cannot delete accounts", so every appliance ever
-- enrolled keeps a working broker account permanently, through archive and through delete. That is
-- a larger and unbounded gap than this one, it spans the credential service and both deployment
-- targets, and it is not a migration. This closes the path that ISSUES a new credential to an
-- archived gateway; it leaves the lifetime of credentials already issued exactly where it was.
--
-- IT DOES NOT CHANGE `status` ON ARCHIVE. A gateway archived while PENDING_ENROLLMENT still reads
-- PENDING_ENROLLMENT, which is what makes un-archiving restore the state the operator left rather
-- than a state this migration invented. The audit trail records the archive event itself.
--
-- UN-ARCHIVING DOES NOT RESTORE A TOKEN. A withdrawn bundle stays withdrawn and the operator
-- re-issues, which is the same answer `issue_gateway_enrollment_token()` already gives for
-- re-issuing over a live token. Restoring one would mean a bundle downloaded before archival
-- silently becoming live again, which is the surprise this migration exists to remove.
-- =============================================================================================

SET search_path TO public;


-- ---------------------------------------------------------------------------------------------
-- 1. Archiving withdraws every live bundle for that gateway
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.withdraw_gateway_enrollment_tokens()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- ON THE TRANSITION, NOT ON THE VALUE. `UPDATE OF is_archived` fires whenever the column appears
  -- in a SET list, including when it is set to the value it already held -- and an archived
  -- gateway is written to by ordinary edits. Without this guard every such write would re-stamp
  -- `consumed_at` on rows that were consumed long ago, rewriting when a token died.
  IF NEW.is_archived AND NOT COALESCE(OLD.is_archived, false) THEN
    UPDATE public.gateway_enrollment_tokens
       SET consumed_at = now()
     WHERE gateway_id = NEW.id
       AND consumed_at IS NULL;
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.withdraw_gateway_enrollment_tokens() IS
  'Burns any unredeemed enrolment token when a gateway is archived. SECURITY DEFINER because the '
  'operator archiving the gateway has no grant on gateway_enrollment_tokens -- RLS is on with no '
  'policy, deliberately, so the table is reachable only by service_role and by definers like this.';

DROP TRIGGER IF EXISTS trg_gateways_withdraw_enrolment ON public.gateways;

-- AFTER, not BEFORE. Nothing here changes the row being written, and running after the archive has
-- committed to the row means a constraint failure on `gateways` cannot leave tokens burned for an
-- archive that never happened.
CREATE TRIGGER trg_gateways_withdraw_enrolment
AFTER UPDATE OF is_archived ON public.gateways
FOR EACH ROW
EXECUTE FUNCTION public.withdraw_gateway_enrollment_tokens();


-- ---------------------------------------------------------------------------------------------
-- 2. Redemption refuses an archived gateway
-- ---------------------------------------------------------------------------------------------
-- REPLACED WHOLE rather than patched, because this function is the security boundary and a reader
-- should be able to see all of it at once. The only change from 0025 is the join to `gateways` and
-- the `NOT g.is_archived` term.
CREATE OR REPLACE FUNCTION public.consume_gateway_enrollment_token(p_token text)
RETURNS TABLE (
  gateway_id uuid,
  sparkplug_id text,
  sparkplug_group text,
  gateway_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_hash       text;
  v_gateway_id uuid;
BEGIN
  -- Shape-checked before it is hashed, so a malformed value cannot reach the index at all.
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;

  v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  -- THE ARCHIVED ARM IS THE NEW ONE (0037). An archived gateway is decommissioned: there is no
  -- appliance it is legitimate to hand a broker credential to, and the operator who archived it
  -- believes the bundle they downloaded is dead.
  --
  -- A REFUSED TOKEN IS NOT BURNED. The UPDATE simply matches nothing, so `consumed_at` stays NULL
  -- and the row remains for the trigger above to withdraw -- or, for a token predating this
  -- migration, until it expires on its own. Burning on refusal would let anyone holding a stale
  -- bundle destroy a token that un-archiving might legitimately precede re-issuing.
  UPDATE public.gateway_enrollment_tokens t
     SET consumed_at = now()
    FROM public.gateways g
   WHERE t.token_hash = v_hash
     AND t.consumed_at IS NULL
     AND t.expires_at > now()
     AND g.id = t.gateway_id
     AND NOT g.is_archived
  RETURNING t.gateway_id INTO v_gateway_id;

  IF v_gateway_id IS NULL THEN
    RETURN;
  END IF;

  -- The identity the appliance needs on the wire. `sparkplug_id` is the generated column the ACL
  -- pins the topic's edge-node segment to, and `sparkplug_group` is the other half of the address
  -- resolve_gateway() looks up first -- an appliance told only the node id falls through to the
  -- group-agnostic arm, which works until two groups exist.
  RETURN QUERY
  SELECT g.id, g.sparkplug_id, g.sparkplug_group, g.name
    FROM public.gateways g
   WHERE g.id = v_gateway_id;
END $$;

COMMENT ON FUNCTION public.consume_gateway_enrollment_token(text) IS
  'Atomically claim a live enrolment token and return the gateway''s wire identity. Returns NO ROWS '
  'for an unknown, expired, already-consumed token or an ARCHIVED gateway (0037) -- the four are '
  'deliberately indistinguishable. Called by the enroll-gateway edge function with the '
  'service-role key; the token itself is the authorisation, so no role is checked.';

REVOKE ALL ON FUNCTION public.consume_gateway_enrollment_token(text) FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------------------------
-- 3. Self-check
-- ---------------------------------------------------------------------------------------------
-- ASSERTS THE REPRODUCTION, not the presence of the code. A trigger that exists and a function that
-- was replaced prove nothing about whether the sequence still works, and that sequence is the whole
-- reason this migration exists.
-- THE PROBE IS ROLLED BACK, AND THAT IS NOT TIDINESS. Every INSERT, UPDATE and DELETE below fires
-- `trg_gateways_digital_thread`, and `digital_thread` is append-only to every application role and
-- cannot be pruned. Committed, this self-check appended a handful of rows to the audit trail ON
-- EVERY BOOT -- which is the failure class this repository names twice elsewhere: 0005's heartbeat
-- problem, and the warning against "a row per progress tick into an append-only table
-- no application role can prune".
--
-- Measured before the fix: replaying 0037 and 0038 once added 9 rows, and `migration` had become
-- the LARGEST actor_source in the table -- 517 rows against 135 from real users -- with 496 of them
-- pointing at probe gateways long since deleted, so they render through the Digital Thread page's
-- purged-entity fallback. Synthetic noise in the one table whose signal the whole design protects.
--
-- The idiom is 0048's: do the work in a sub-block, raise `rollback_selfcheck` at the end, and
-- swallow only that. A subtransaction that ends in an exception discards everything it wrote, the
-- audit rows included, while the outer transaction carries on. Any OTHER exception -- including
-- every assertion below -- is re-raised untouched, so a genuine failure still stops db-init.
--
-- THE CLEANUP DELETE STAYS OUTSIDE THE BLOCK, deliberately. It is a no-op on a healthy boot, and on
-- a database left holding a probe row by an older version of this file it is the one thing that
-- removes it. Inside, it would be rolled back with everything else and the stale row would live
-- forever.
DO $selfcheck$
DECLARE
  v_gw    CONSTANT uuid := '00000000-0000-4000-8000-00000000f037';
  v_token CONSTANT text := repeat('f0', 32);
  v_rows  int;
  v_consumed timestamptz;
BEGIN
  DELETE FROM public.gateways WHERE id = v_gw;

  BEGIN
  INSERT INTO public.gateways (id, name, is_virtual, location_scope, status)
  VALUES (v_gw, '0037 self-check', false, 'site_wide', 'PENDING_ENROLLMENT');

  INSERT INTO public.gateway_enrollment_tokens (gateway_id, token_hash, expires_at)
  VALUES (v_gw, encode(extensions.digest(v_token, 'sha256'), 'hex'), now() + interval '30 minutes');

  -- (a) The trigger burns it on archive.
  UPDATE public.gateways SET is_archived = true, archived_at = now() WHERE id = v_gw;

  SELECT consumed_at INTO v_consumed
    FROM public.gateway_enrollment_tokens WHERE gateway_id = v_gw;
  IF v_consumed IS NULL THEN
    RAISE EXCEPTION
      '0037 self-check: archiving a gateway did not withdraw its live enrolment token. A bundle '
      'downloaded before archival would still be redeemable.';
  END IF;

  -- (b) Redemption refuses it even with the token un-burned, which is the case for every bundle
  --     issued before this migration existed.
  UPDATE public.gateway_enrollment_tokens SET consumed_at = NULL WHERE gateway_id = v_gw;

  SELECT count(*) INTO v_rows
    FROM public.consume_gateway_enrollment_token(v_token);
  IF v_rows <> 0 THEN
    RAISE EXCEPTION
      '0037 self-check: an ARCHIVED gateway''s enrolment token was redeemed. This is the '
      'reproduction the migration exists to close -- it issues a real broker credential and '
      'resurrects the archived row to ONLINE.';
  END IF;

  -- (c) And the ordinary case still works, so the fix is not simply refusing everything.
  UPDATE public.gateways SET is_archived = false, archived_at = NULL WHERE id = v_gw;
  UPDATE public.gateway_enrollment_tokens SET consumed_at = NULL WHERE gateway_id = v_gw;

  SELECT count(*) INTO v_rows
    FROM public.consume_gateway_enrollment_token(v_token);
  IF v_rows <> 1 THEN
    RAISE EXCEPTION
      '0037 self-check: a LIVE token on an un-archived gateway was refused (% rows). The archival '
      'term has broken ordinary enrolment.', v_rows;
  END IF;

  -- No DELETE here any more: the rollback below removes the probe and its audit rows together,
  -- and an explicit delete would only add a row for the rollback to discard.
  RAISE EXCEPTION 'rollback_selfcheck';
  EXCEPTION
    WHEN raise_exception THEN
      -- Only ours. Every assertion above raises through here and must keep its message and its
      -- power to stop the boot.
      IF SQLERRM <> 'rollback_selfcheck' THEN RAISE; END IF;
  END;

  RAISE NOTICE
    '0037 self-check passed: archive withdraws the bundle, an archived gateway cannot be enrolled, '
    'and ordinary enrolment still works. Probe rolled back, no audit rows written.';
END;
$selfcheck$;
