-- =============================================================================================
-- Migration: 0038_revoke_gateway_credentials.sql
-- A decommissioned gateway's broker credential stops working
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- Takes two psql variables, defaulted so the file is runnable standalone:
--
--     -v supabase_functions_url='http://supabase-kong:8000/functions/v1'
--     -v supabase_anon_key='...'
--     -v gateway_revoke_secret='...'
--
-- ---------------------------------------------------------------------------------------------
-- THE GAP. Nothing in this platform has ever revoked a broker credential. 0037 closed the path
-- that ISSUES one to an archived gateway; this closes the lifetime of ones already issued. Until
-- now every appliance ever enrolled kept a working Mosquitto account permanently -- through
-- archive, and through deletion of the gateway row itself.
--
-- WHAT SUCH A CREDENTIAL CAN AND CANNOT DO, because the fix should be sized against the risk. The
-- ACL confines it to `spBv1.0/+/+/%u/#`, so it addresses exactly one edge node -- its own -- and
-- can forge nothing for any other gateway. And once the `gateways` row is archived or gone,
-- `resolve_gateway()` drops its messages as an unregistered edge node, so it cannot write data.
-- What remains is an authenticated foothold on the broker that can connect and subscribe to its
-- own command topics, indefinitely, for hardware that was decommissioned. That is defence in
-- depth rather than an open door, and it is worth closing because it ACCUMULATES: every gateway
-- ever retired leaves one behind.
--
-- ---------------------------------------------------------------------------------------------
-- REVOCATION IS A ROTATION, NOT A DELETION, AND THAT IS THE WHOLE DESIGN.
--
-- The credential service says of itself: "This service can add a gateway account and do nothing
-- else -- it cannot read a password back, cannot delete accounts, cannot reach the database", and
-- "it is not a general credential API and must not become one".
--
-- THAT BOUNDARY IS NOT STYLE. Whoever reaches that service today can add accounts the ACL confines
-- to their own edge node. A delete verb would turn the same reach into "remove every gateway
-- account and stop the entire fleet publishing" -- a fleet-wide denial of service, and a strictly
-- worse primitive than the one it holds now. It would also invert `mergeCredential()`, which
-- exists to THROW rather than return contents that would lose an account.
--
-- So this revokes with the endpoint that already exists: re-provision the account with a fresh
-- random password that NOBODY RECORDS. The service generates it, the response is discarded, and
-- the credential the appliance holds stops working immediately. No new verb, no new authority, and
-- the never-lose-an-account guard stays exactly as it is.
--
-- THE COST IS AN INERT ROW IN THE PASSWORD FILE. A revoked account's hash remains, of a password
-- that was never written down and cannot be recovered -- mosquitto_passwd stores only hashes.
-- Cleaning those up is a housekeeping task for whoever owns the broker, not a capability this
-- platform needs.
--
-- ---------------------------------------------------------------------------------------------
-- IT IS BEST-EFFORT ON DELETE AND SELF-HEALING ON ARCHIVE, and the difference is worth knowing.
--
-- `net.http_post` is ASYNCHRONOUS AND FIRE-AND-FORGET. It queues a request and returns an id; the
-- transaction commits whether or not the call ever succeeds. So a single trigger call is a best
-- effort, not a guarantee -- the broker could be down, the service restarting, the network
-- partitioned.
--
--   ARCHIVE is therefore RETRIED. `credential_revoked_at` records success, and the sweep below
--   re-attempts every archived gateway that has no stamp. A failed revocation is corrected on the
--   next run rather than lost.
--
--   DELETE cannot be retried, because the row carrying the stamp is gone and there is nothing left
--   to sweep. The trigger fires once and that is the only attempt. Recording deletions in a queue
--   table would fix it and is deliberately not done here: a deleted gateway's credential already
--   cannot write data, so the residual risk does not justify a new table and a drain loop.
--   ARCHIVE-THEN-DELETE, which is what the dashboard's own flow does, gets the retried path.
-- =============================================================================================

SET check_function_bodies = false;

\if :{?supabase_functions_url}
\else
\set supabase_functions_url 'http://supabase-kong:8000/functions/v1'
\endif
\if :{?supabase_anon_key}
\else
\set supabase_anon_key ''
\endif
\if :{?gateway_revoke_secret}
\else
\set gateway_revoke_secret ''
\endif

SELECT set_config('acs_cymru.fn_url',      :'supabase_functions_url', false);
SELECT set_config('acs_cymru.anon_key',    :'supabase_anon_key', false);
SELECT set_config('acs_cymru.revoke_key',  :'gateway_revoke_secret', false);


-- ---------------------------------------------------------------------------------------------
-- 1. Where the address and the credentials live
-- ---------------------------------------------------------------------------------------------
-- THREE VALUES IN VAULT, and only one of them is secret in the ordinary sense. Vault is this
-- database's store for things that must be READ FROM SQL and must not be readable by `anon` or
-- `authenticated` (0001 revokes both); splitting a URL into a second store would mean two places
-- to configure one outbound call.
--
--   supabase_functions_url        where Kong serves /functions/v1 on this target
--   supabase_anon_key             gets past Kong's key-auth, and proves NOTHING else -- it ships
--                                 inside every browser bundle
--   gateway_revoke_secret         what actually authorises the revocation, checked by the function
DO $vault$
DECLARE
  v_url    text := btrim(coalesce(current_setting('acs_cymru.fn_url', true), ''));
  v_anon   text := btrim(coalesce(current_setting('acs_cymru.anon_key', true), ''));
  v_secret text := btrim(coalesce(current_setting('acs_cymru.revoke_key', true), ''));
  v_id     uuid;
BEGIN
  IF v_secret = '' OR v_anon = '' THEN
    RAISE NOTICE
      '0038: GATEWAY_REVOKE_SECRET or SUPABASE_ANON_KEY is unset; credential revocation is INERT '
      'on this stack. Archiving will not revoke, and the sweep will do nothing.';
  END IF;

  -- REPLACED, NOT MERGED. A rotated value must overwrite the stored one and vault.create_secret
  -- refuses a duplicate name, so the old row goes first. Same shape 0006 uses.
  FOR v_id IN SELECT id FROM vault.secrets
               WHERE name IN ('supabase_functions_url', 'supabase_anon_key', 'gateway_revoke_secret')
  LOOP
    DELETE FROM vault.secrets WHERE id = v_id;
  END LOOP;

  PERFORM vault.create_secret(v_url, 'supabase_functions_url',
    'Base URL of the edge function router on this target, read by revoke_gateway_credential().');
  PERFORM vault.create_secret(v_anon, 'supabase_anon_key',
    'Anon key, used only to pass Kong key-auth on the revocation call. Not authorisation.');
  PERFORM vault.create_secret(v_secret, 'gateway_revoke_secret',
    'Shared secret the revoke-gateway-credential function verifies. This is the authorisation.');
END;
$vault$;


-- ---------------------------------------------------------------------------------------------
-- 2. The stamp
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.gateways
  ADD COLUMN IF NOT EXISTS credential_revoked_at timestamp with time zone;

-- `gateway_status` is `SELECT g.*`, which Postgres freezes at creation -- so a column added here
-- is invisible through it until the view is rebuilt, and db-init replays 0025's rebuild BEFORE
-- this file on every boot. check-docs-drift.mjs asserts every migration adding a gateways column
-- ends with this call, and caught this one.
SELECT public.ensure_gateway_status_view();

COMMENT ON COLUMN public.gateways.credential_revoked_at IS
  'When this gateway''s broker credential was last rotated to a password nobody recorded, which is '
  'how this platform revokes. NULL on a gateway that is not archived, and on an archived one whose '
  'revocation has not yet succeeded -- the sweep in 0038 retries those. Set back to NULL by '
  're-enrolment, because that issues a fresh working credential.';


-- ---------------------------------------------------------------------------------------------
-- 3. Who actually holds a credential
-- ---------------------------------------------------------------------------------------------
-- REVOKING SOMETHING THAT WAS NEVER ISSUED CREATES IT, which is the one sharp edge of revoking by
-- rotation. The credential service is add-only: handed a sparkplug_id with no account it makes
-- one, with a password nobody recorded. Harmless, and still litter -- an inert account per gateway
-- that was created, never enrolled, and later archived.
--
-- FOUND BY RUNNING THE SWEEP ON A REAL STACK. It rotated a gateway whose bundle had been
-- downloaded and never instantiated, and the password file gained an account for an appliance that
-- had never existed.
--
-- `enrolled_at` IS THE HONEST TEST. enroll-gateway stamps it in the same write that issues the
-- credential, so NULL means no credential was ever handed out and there is nothing to revoke. A
-- virtual gateway is excluded for the same reason at one remove -- issue_gateway_enrollment_token()
-- refuses one, so it can never enrol.
CREATE OR REPLACE FUNCTION public.gateway_holds_a_credential(g public.gateways)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$ SELECT NOT g.is_virtual AND g.enrolled_at IS NOT NULL $$;

COMMENT ON FUNCTION public.gateway_holds_a_credential(public.gateways) IS
  'Whether a broker account was ever issued for this gateway, so revocation does not CREATE one by '
  'rotating an account that never existed. Takes the row so triggers can call it on NEW/OLD.';


-- ---------------------------------------------------------------------------------------------
-- 4. The revocation itself
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_gateway_credential(p_sparkplug_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_url    text;
  v_anon   text;
  v_secret text;
BEGIN
  IF p_sparkplug_id IS NULL OR p_sparkplug_id !~ '^gwy[0-9a-f]{21}$' THEN
    RETURN false;
  END IF;

  SELECT decrypted_secret INTO v_url    FROM vault.decrypted_secrets WHERE name = 'supabase_functions_url';
  SELECT decrypted_secret INTO v_anon   FROM vault.decrypted_secrets WHERE name = 'supabase_anon_key';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'gateway_revoke_secret';

  -- A STACK WITH NOTHING CONFIGURED DOES NOTHING rather than sending a bare "Bearer ". The call
  -- would answer 401 or 503 either way; not making it keeps the failure legible as "not
  -- configured" rather than as "rejected". Same reasoning as 0006's webhook signer.
  IF coalesce(v_url,'') = '' OR coalesce(v_anon,'') = '' OR coalesce(v_secret,'') = '' THEN
    RETURN false;
  END IF;

  -- THROUGH KONG TO THE EDGE FUNCTION, not straight at the credential service. The chart admits
  -- only `supabase-functions` to that service and calls it the only edge into credential issuance;
  -- `supabase-db -> supabase-kong` is already permitted for exactly this. See the function's own
  -- header.
  --
  -- `apikey` gets past Kong. `x-revoke-secret` is what authorises the act -- the anon key ships in
  -- every browser bundle and proves nothing.
  PERFORM net.http_post(
    url     := rtrim(v_url, '/') || '/revoke-gateway-credential',
    headers := jsonb_build_object(
                 'Content-Type',    'application/json',
                 'apikey',          v_anon,
                 'Authorization',   'Bearer ' || v_anon,
                 'x-revoke-secret', v_secret),
    body    := jsonb_build_object('sparkplug_id', p_sparkplug_id)
  );

  RETURN true;
END $$;

COMMENT ON FUNCTION public.revoke_gateway_credential(text) IS
  'Rotate a gateway''s broker account to a password nobody records, which is how this platform '
  'revokes -- the credential service is add-only by design and must not gain a delete verb. '
  'Returns false when the service is not configured. ASYNCHRONOUS: net.http_post queues the '
  'request, so a true return means "asked", not "revoked". The sweep is what makes archive '
  'eventually correct.';

REVOKE ALL ON FUNCTION public.revoke_gateway_credential(text) FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------------------------
-- 5. Archive and delete both ask for revocation
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_credential_on_decommission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The only attempt this one gets; see the header.
    IF public.gateway_holds_a_credential(OLD) THEN
      PERFORM public.revoke_gateway_credential(OLD.sparkplug_id);
    END IF;
    RETURN OLD;
  END IF;

  -- On the TRANSITION, so an ordinary edit to an already-archived gateway does not re-rotate a
  -- credential that was revoked weeks ago and re-stamp when it happened.
  IF NEW.is_archived AND NOT COALESCE(OLD.is_archived, false)
     AND public.gateway_holds_a_credential(NEW) THEN
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

DROP TRIGGER IF EXISTS trg_gateways_revoke_credential_update ON public.gateways;
CREATE TRIGGER trg_gateways_revoke_credential_update
AFTER UPDATE OF is_archived ON public.gateways
FOR EACH ROW
EXECUTE FUNCTION public.revoke_credential_on_decommission();

DROP TRIGGER IF EXISTS trg_gateways_revoke_credential_delete ON public.gateways;
CREATE TRIGGER trg_gateways_revoke_credential_delete
BEFORE DELETE ON public.gateways
FOR EACH ROW
EXECUTE FUNCTION public.revoke_credential_on_decommission();


-- ---------------------------------------------------------------------------------------------
-- 6. Re-enrolment clears the stamp
-- ---------------------------------------------------------------------------------------------
-- An un-archived gateway that enrols again receives a working credential, so a stamp left behind
-- would read as "revoked" on an appliance that is publishing. enroll-gateway writes `status`;
-- this keys off the credential having been re-issued rather than off the status value, because
-- the first NBIRTH overwrites status anyway.
CREATE OR REPLACE FUNCTION public.clear_credential_revoked_on_enrolment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.is_archived IS FALSE AND COALESCE(OLD.is_archived, false) IS TRUE THEN
    NEW.credential_revoked_at := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_gateways_clear_credential_revoked ON public.gateways;
CREATE TRIGGER trg_gateways_clear_credential_revoked
BEFORE UPDATE OF is_archived ON public.gateways
FOR EACH ROW
EXECUTE FUNCTION public.clear_credential_revoked_on_enrolment();


-- ---------------------------------------------------------------------------------------------
-- 7. The sweep, which is what makes archive reliable rather than hopeful
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
       AND public.gateway_holds_a_credential(g)
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
  'clears stamps that pg_net shows were never answered. Run by pg_cron every 15 minutes. Does '
  'nothing for DELETED gateways -- their row is gone and there is nothing left to retry.';

REVOKE ALL ON FUNCTION public.sweep_gateway_credential_revocations() FROM PUBLIC, anon, authenticated;

-- EVERY 15 MINUTES. The condition changes only when an operator archives something, and the fast
-- path is the trigger -- this exists for the transient failure the trigger cannot see, so it is
-- paced for eventual correctness rather than for latency.
SELECT cron.unschedule('sweep-gateway-credential-revocations')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sweep-gateway-credential-revocations');
SELECT cron.schedule('sweep-gateway-credential-revocations', '*/15 * * * *',
                     'SELECT public.sweep_gateway_credential_revocations()');


-- ---------------------------------------------------------------------------------------------
-- 8. Self-check
-- ---------------------------------------------------------------------------------------------
-- IT MUST NOT MAKE A NETWORK CALL, and the first version did. db-init replays every migration on
-- every boot, so an end-to-end check here archived a fabricated gateway on each start and the
-- credential service dutifully created an account for it -- a junk row added to the broker's
-- password file per boot, by the migration whose subject is not littering the password file.
--
-- So this asserts the WIRING and the GUARDS, all of which short-circuit before the HTTP call, and
-- the end-to-end proof lives where it can be run once and observed: archive a real enrolled
-- gateway and watch its credential stop working.
-- THE PROBE IS ROLLED BACK, AND THAT IS NOT TIDINESS. Every INSERT, UPDATE and DELETE below fires
-- `trg_gateways_digital_thread`, and `digital_thread` is append-only to every application role and
-- cannot be pruned. Committed, this self-check appended a handful of rows to the audit trail ON
-- EVERY BOOT -- which is the failure class this repository names twice elsewhere: 0005's heartbeat
-- problem, and roadmap item 17's warning against "a row per progress tick into an append-only table
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
  v_gw    CONSTANT uuid := '00000000-0000-4000-8000-00000000f038';
  v_stamp timestamptz;
  v_count int;
BEGIN
  -- (a) Both triggers are attached. Without them nothing revokes and nothing says so.
  SELECT count(*) INTO v_count FROM pg_trigger
   WHERE tgrelid = 'public.gateways'::regclass
     AND NOT tgisinternal
     AND tgname IN ('trg_gateways_revoke_credential_update',
                    'trg_gateways_revoke_credential_delete',
                    'trg_gateways_clear_credential_revoked');
  IF v_count <> 3 THEN
    RAISE EXCEPTION
      '0038 self-check: % of 3 revocation triggers are attached to public.gateways.', v_count;
  END IF;

  -- Cleanup outside the rolled-back block, for the reason given in the header above.
  DELETE FROM public.gateways WHERE id = v_gw;

  BEGIN
  INSERT INTO public.gateways (id, name, is_virtual, location_scope, status)
  VALUES (v_gw, '0038 self-check', false, 'site_wide', 'PENDING_ENROLLMENT');

  -- (b) A gateway that NEVER ENROLLED is not revoked -- the guard that stops rotation creating an
  --     account for an appliance that never existed. No HTTP call is made, so nothing is queued.
  UPDATE public.gateways SET is_archived = true, archived_at = now() WHERE id = v_gw;
  SELECT credential_revoked_at INTO v_stamp FROM public.gateways WHERE id = v_gw;
  IF v_stamp IS NOT NULL THEN
    RAISE EXCEPTION
      '0038 self-check: archiving a gateway with enrolled_at NULL requested revocation. Rotating an '
      'account that was never issued CREATES it, which is litter in the broker password file.';
  END IF;

  -- (c) Un-archiving clears a stamp, so a re-enrolled appliance does not read as revoked.
  UPDATE public.gateways SET credential_revoked_at = now() WHERE id = v_gw;
  UPDATE public.gateways SET is_archived = false, archived_at = NULL WHERE id = v_gw;
  SELECT credential_revoked_at INTO v_stamp FROM public.gateways WHERE id = v_gw;
  IF v_stamp IS NOT NULL THEN
    RAISE EXCEPTION
      '0038 self-check: un-archiving left credential_revoked_at set. A publishing appliance would '
      'read as revoked.';
  END IF;

  -- (d) A malformed edge node id is refused before it reaches the network.
  IF public.revoke_gateway_credential('not-a-sparkplug-id') THEN
    RAISE EXCEPTION '0038 self-check: revoke_gateway_credential() accepted a malformed edge node id.';
  END IF;

  -- No DELETE here any more: the rollback removes the probe and its audit rows together.
  RAISE EXCEPTION 'rollback_selfcheck';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'rollback_selfcheck' THEN RAISE; END IF;
  END;

  RAISE NOTICE '0038 self-check passed: 3 triggers attached, an unenrolled gateway is not revoked, '
               'un-archive clears the stamp, and a malformed id is refused. Probe rolled back, no '
               'audit rows written.';
END;
$selfcheck$;
