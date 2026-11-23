-- 0311: A revocation is owed until the credential service confirms it.
--
-- Archiving a gateway, deleting it, changing its type across Remote's boundary and (0312) setting it
-- up again for a new appliance each ask the credential service to disable the gateway's broker account.
-- The request goes through pg_net, so its answer arrives after the transaction, and the revocation
-- sweep (0288) judges it every 15 minutes. It did not ask again in every case:
--
--   * An archived gateway was asked again only while gateway_has_broker_credential() said it held a
--     credential under its CURRENT type. A gateway whose type had changed away from Remote holds no
--     record under the new type, so a failed revocation of the old type's credential was dropped.
--   * gateway_revocation_requests cascades with the gateway row, so a revocation still unanswered when
--     the gateway was deleted was never asked again, and the delete itself asked only while the row
--     read as holding a credential.
--   * When the credential service was not configured, a change of type wrote nothing, so nothing was
--     left for the sweep to ask once it was.
--
-- Now a revocation is owed from the moment it is wanted until a 2xx to its own request confirms it,
-- whatever the gateway's type, archived or not, and after it is deleted.
--
--   * A row of gateway_revocation_requests is the debt for a gateway that exists. request_id is empty
--     until a call can be made. owe_gateway_revocation() writes the row, then asks.
--   * deleted_gateway_revocations keeps the debt of a deleted gateway, by the Sparkplug ID that names
--     its account. The delete moves an unconfirmed row there, and asks first when the row still holds a
--     credential. revoke_gateway_credential() records a retry's request there too.
--   * Archiving and a change of type stamp credential_revoked_at whether or not the call can be made.
--   * The sweep asks again for every owed revocation whose request failed, went five minutes without
--     an answer, or was never made, keeping the stamp, for an archived gateway as for one that is not.
--     It still drops one that a credential issued or enrolled after the stamp has replaced, for a
--     gateway that is not archived (gateway_credential_was_replaced(), 0288), and for a deleted
--     gateway one that a gateway made again under its Sparkplug ID has replaced.
--   * A change of type away from Remote asks forge-sweep for a pass at once, as an archive does: the
--     sweep removes the deploy keys of a gateway that is no longer Remote.
--
-- Reasoning: supabase/README.md, "A revocation is owed until the credential service confirms it (0311)".
-- Idempotent.
--
-- Redefines public.revoke_gateway_credential: 0311 records the request against a deleted gateway's
--   owed revocation as well as against the gateway row; 0001 recorded it against the row alone
-- Redefines public.revoke_credential_on_decommission: 0311 owes an archive's revocation whether or not
--   the call can be made, and on a delete keeps whatever is owed in deleted_gateway_revocations; 0001
--   asked once on a delete and only for a credential the row still held
-- Redefines public.clean_up_after_a_gateway_type_change: 0311 owes the revocation and stamps it whether
--   or not the call can be made, and asks forge-sweep at once when a gateway leaves Remote; 0310
--   stamped only a call that was made. The archived gateway's status step is 0310's
-- Redefines public.sweep_gateway_credential_revocations: 0311 asks again for every owed revocation
--   until a 2xx confirms it, archived or not, whatever the type and after a delete; 0288 cleared an
--   archived gateway's stamp and asked again only where its current type held a credential

-- -------------------------------------------------------------------------------------------------
-- 1. The record of what is owed
-- -------------------------------------------------------------------------------------------------
-- A row whose revocation could not be asked yet has no request. 0001 states the column NOT NULL in
-- its CREATE TABLE IF NOT EXISTS and never sets it again, so this survives a replay.
DO $nullable$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.gateway_revocation_requests'::regclass
                AND attname = 'request_id' AND attnotnull) THEN
    ALTER TABLE public.gateway_revocation_requests ALTER COLUMN request_id DROP NOT NULL;
  END IF;
END
$nullable$;

COMMENT ON TABLE public.gateway_revocation_requests IS
  'A revocation owed for a gateway that exists: its broker account is to be disabled, and the row stays '
  'until a 2xx to its own request confirms it, or a credential issued or enrolled after the stamp replaces '
  'the one it ends. Written by owe_gateway_revocation() and revoke_gateway_credential(), judged and removed '
  'by the revocation sweep. A delete moves an unconfirmed row to deleted_gateway_revocations. Readable by '
  'service_role (0311).';
COMMENT ON COLUMN public.gateway_revocation_requests.request_id IS
  'The id net.http_post returned for the latest call; its reply lands in net._http_response under the same '
  'id. Empty until a call could be made, when the credential service was not configured (0311).';
COMMENT ON COLUMN public.gateway_revocation_requests.requested_at IS
  'When the latest call was queued, or when the revocation was owed if none could be made. No reply five '
  'minutes on counts as a failed revocation.';

-- The debt of a deleted gateway. No foreign key: it outlives the row on purpose.
CREATE TABLE IF NOT EXISTS public.deleted_gateway_revocations (
    sparkplug_id text NOT NULL,
    gateway_id uuid NOT NULL,
    owed_since timestamp with time zone DEFAULT now() NOT NULL,
    request_id bigint,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT deleted_gateway_revocations_pkey PRIMARY KEY (sparkplug_id),
    CONSTRAINT deleted_gateway_revocations_sparkplug_id_check CHECK (sparkplug_id ~ '^gwy[0-9a-f]{21}$')
);

ALTER TABLE public.deleted_gateway_revocations OWNER TO postgres;
ALTER TABLE public.deleted_gateway_revocations ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.deleted_gateway_revocations IS
  'A revocation still owed for a gateway whose row was deleted, by the Sparkplug ID that names its broker '
  'account. Written by revoke_credential_on_decommission() as the row goes and by revoke_gateway_credential() '
  'as the sweep asks again; removed by the sweep once a 2xx to its own request confirms it. RLS on with no '
  'policy; readable by service_role (0311).';
COMMENT ON COLUMN public.deleted_gateway_revocations.gateway_id IS
  'The id of the gateway that was deleted. Not a foreign key: the row it named is gone.';
COMMENT ON COLUMN public.deleted_gateway_revocations.owed_since IS
  'When the gateway was deleted. A gateway made again under the same Sparkplug ID and given a credential '
  'after this holds the account, and nothing more is asked.';
COMMENT ON COLUMN public.deleted_gateway_revocations.request_id IS
  'The id net.http_post returned for the latest call, or empty while none could be made.';
COMMENT ON COLUMN public.deleted_gateway_revocations.requested_at IS
  'When the latest call was queued. No reply five minutes on counts as a failed revocation.';

REVOKE ALL ON TABLE public.deleted_gateway_revocations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.deleted_gateway_revocations TO service_role;

-- -------------------------------------------------------------------------------------------------
-- 2. Asking, and owing
-- -------------------------------------------------------------------------------------------------
-- 0001's body, with the request also written to a deleted gateway's debt.
CREATE OR REPLACE FUNCTION public.revoke_gateway_credential(p_sparkplug_id text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_url     text;
  v_key     text;
  v_secret  text;
  v_request bigint;
BEGIN
  IF p_sparkplug_id IS NULL OR p_sparkplug_id !~ '^gwy[0-9a-f]{21}$' THEN
    RETURN false;
  END IF;

  SELECT decrypted_secret INTO v_url    FROM vault.decrypted_secrets WHERE name = 'supabase_functions_url';
  SELECT decrypted_secret INTO v_key    FROM vault.decrypted_secrets WHERE name = 'supabase_publishable_key';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'gateway_revoke_secret';

  -- A STACK WITH NOTHING CONFIGURED DOES NOTHING rather than sending a bare "Bearer ". The call
  -- would answer 401 or 503 either way; not making it keeps the failure legible as "not
  -- configured" rather than as "rejected". The debt stays for the sweep to ask once it is.
  IF coalesce(v_url,'') = '' OR coalesce(v_key,'') = '' OR coalesce(v_secret,'') = '' THEN
    RETURN false;
  END IF;

  -- Through the gateway to the edge function, not straight at the credential service: the chart
  -- admits only `supabase-functions` to that service. `apikey` gets past the gateway;
  -- `x-revoke-secret` is what authorises the act.
  v_request := net.http_post(
    url     := rtrim(v_url, '/') || '/revoke-gateway-credential',
    headers := jsonb_build_object(
                 'Content-Type',    'application/json',
                 'apikey',          v_key,
                 'Authorization',   'Bearer ' || v_key,
                 'x-revoke-secret', v_secret),
    body    := jsonb_build_object('sparkplug_id', p_sparkplug_id)
  );

  -- The sweep judges the revocation by this request's reply. An INSERT, never an UPDATE of
  -- gateways: the BEFORE DELETE trigger calls this, and updating the row being deleted aborts the
  -- DELETE.
  INSERT INTO public.gateway_revocation_requests (gateway_id, request_id, requested_at)
  SELECT g.id, v_request, now() FROM public.gateways g WHERE g.sparkplug_id = p_sparkplug_id
  ON CONFLICT (gateway_id) DO UPDATE
     SET request_id = EXCLUDED.request_id, requested_at = EXCLUDED.requested_at;

  -- A deleted gateway's debt is kept by its Sparkplug ID.
  UPDATE public.deleted_gateway_revocations
     SET request_id = v_request, requested_at = now()
   WHERE sparkplug_id = p_sparkplug_id;

  RETURN true;
END $_$;

ALTER FUNCTION public.revoke_gateway_credential(p_sparkplug_id text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.revoke_gateway_credential(p_sparkplug_id text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.revoke_gateway_credential(p_sparkplug_id text) IS 'Ask the credential service to disable this gateway''s broker account, which is how this platform revokes: the broker drops any live session at once and refuses the next CONNECT. The account is not deleted; a later issue re-enables it. Returns false, and asks nothing, when the service is not configured. ASYNCHRONOUS: true means "asked", not "revoked". Records the pg_net request id against the gateway''s owed revocation, in gateway_revocation_requests while the row exists and in deleted_gateway_revocations after a delete, for the sweep to judge (0311).';

-- The one way a revocation becomes owed. The row is written before the call, so a call that cannot be
-- made leaves the debt for the sweep. A request an earlier revocation left on the row is cleared: its
-- reply answers for that revocation, not this one.
CREATE OR REPLACE FUNCTION public.owe_gateway_revocation(p_sparkplug_id text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  INSERT INTO public.gateway_revocation_requests (gateway_id, request_id, requested_at)
  SELECT g.id, NULL, now() FROM public.gateways g WHERE g.sparkplug_id = p_sparkplug_id
  ON CONFLICT (gateway_id) DO UPDATE
     SET request_id = NULL, requested_at = EXCLUDED.requested_at;

  RETURN public.revoke_gateway_credential(p_sparkplug_id);
END $$;

ALTER FUNCTION public.owe_gateway_revocation(p_sparkplug_id text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.owe_gateway_revocation(p_sparkplug_id text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.owe_gateway_revocation(p_sparkplug_id text) IS
  'Record that this gateway''s broker account is to be disabled, in gateway_revocation_requests, then ask '
  'the credential service (revoke_gateway_credential). The record stays until the sweep sees a 2xx to its '
  'own request, so a call that fails or cannot be made is asked again. Returns whether the call was made. '
  'Run by the archive and delete trigger, the type-change clean-up, the setup issue and the sweep, as the '
  'owner (0311).';

-- -------------------------------------------------------------------------------------------------
-- 3. Archive and delete
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_credential_on_decommission() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF public.gateway_has_broker_credential(OLD) THEN
      PERFORM public.owe_gateway_revocation(OLD.sparkplug_id);
    END IF;
    -- What is owed outlives the row: the cascade would take this gateway's row of
    -- gateway_revocation_requests, so an unconfirmed one moves, with its request, to the table keyed
    -- by the Sparkplug ID. A revocation an archive asked weeks ago and the sweep confirmed is not
    -- owed, and nothing is asked again for it.
    INSERT INTO public.deleted_gateway_revocations
           (sparkplug_id, gateway_id, owed_since, request_id, requested_at)
    SELECT OLD.sparkplug_id, OLD.id, now(), q.request_id, q.requested_at
      FROM public.gateway_revocation_requests q
     WHERE q.gateway_id = OLD.id
       AND NOT EXISTS (SELECT 1 FROM net._http_response r
                        WHERE r.id = q.request_id AND r.status_code BETWEEN 200 AND 299)
    ON CONFLICT (sparkplug_id) DO UPDATE
       SET gateway_id = EXCLUDED.gateway_id, owed_since = EXCLUDED.owed_since,
           request_id = EXCLUDED.request_id, requested_at = EXCLUDED.requested_at;
    RETURN OLD;
  END IF;

  -- On the TRANSITION, so an ordinary edit to an already-archived gateway does not re-rotate a
  -- credential that was revoked weeks ago and re-stamp when it happened.
  IF NEW.is_archived AND NOT COALESCE(OLD.is_archived, false)
     AND public.gateway_has_broker_credential(NEW) THEN
    PERFORM public.owe_gateway_revocation(NEW.sparkplug_id);
    -- Stamped whether or not the call could be made: the revocation is owed from now, and the sweep
    -- asks until a 2xx confirms it. A second UPDATE, so archiving holds two audit rows.
    UPDATE public.gateways SET credential_revoked_at = now() WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END $$;

ALTER FUNCTION public.revoke_credential_on_decommission() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.revoke_credential_on_decommission() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.revoke_credential_on_decommission() IS 'Trigger function: when a gateway is archived, owes and asks the revocation of the broker account it holds (gateway_has_broker_credential), so revocation never creates one, and stamps credential_revoked_at whether or not the call could be made. When it is deleted, asks for a credential the row still holds, and moves every revocation still owed to deleted_gateway_revocations, where the sweep asks until a 2xx confirms it (0311).';

-- -------------------------------------------------------------------------------------------------
-- 4. A change of type
-- -------------------------------------------------------------------------------------------------
-- 0310's body, with the revocation owed and stamped whether or not the call could be made, and the
-- forge asked at once when a gateway leaves Remote. SECURITY DEFINER because the Manager changing the
-- type has no grant on the token table, Vault or the revocation call. BEFORE, so the status and the
-- stamp are written by the UPDATE that changes the type, and the Audit Trail holds one row.
CREATE OR REPLACE FUNCTION public.clean_up_after_a_gateway_type_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  -- `UPDATE OF` fires whenever a column is in the SET list, and the Edit form sends both on every
  -- save. A change among Host, Simulated and Third-party crosses nothing: all three hold a
  -- credential issued in the dashboard.
  IF (OLD.deployment = 'remote') = (NEW.deployment = 'remote') THEN
    RETURN NEW;
  END IF;

  -- An archived gateway's setup tokens were burned and its credential ended when it was archived.
  IF OLD.is_archived IS NOT TRUE THEN
    -- The setup command the old type was issued, burned as archiving burns it. Entering Remote finds
    -- none unless an earlier change left one, and a fresh token is issued by Set up.
    UPDATE public.gateway_enrollment_tokens
       SET consumed_at = now()
     WHERE gateway_id = NEW.id
       AND consumed_at IS NULL;

    -- Asked about OLD: gateway_has_broker_credential() decides by the row's deployment, and NEW
    -- would be asked for the new type's record, which a gateway that has just changed type lacks.
    -- Owed until the credential service confirms it, so stamped whether or not the call was made.
    IF public.gateway_has_broker_credential(OLD) THEN
      PERFORM public.owe_gateway_revocation(OLD.sparkplug_id);
      NEW.credential_revoked_at := now();
    END IF;

    -- The copy an Administrator could show again was of the credential just ended. A Remote gateway
    -- keeps none, so this deletes nothing on the way out of Remote.
    DELETE FROM vault.secrets WHERE name = 'gateway_broker_password:' || OLD.id::text;

    -- The appliance's deploy key goes with Remote: forge-sweep removes the keys of a gateway that is
    -- not Remote, and is asked now, as an archive asks it. A gateway with no repository has none.
    IF OLD.deployment = 'remote' AND NEW.forge_repository_at IS NOT NULL THEN
      PERFORM public.sweep_forge();
    END IF;
  END IF;

  -- A Remote gateway waits OFFLINE until Set up issues a token. One that leaves Remote mid-enrolment
  -- reads as a new gateway of its type does; any other status is the gateway's own word.
  IF NEW.deployment = 'remote' OR NEW.status IN ('PENDING_ENROLLMENT', 'AWAITING_BIRTH') THEN
    NEW.status := 'OFFLINE';
  END IF;
  RETURN NEW;
END $$;

ALTER FUNCTION public.clean_up_after_a_gateway_type_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.clean_up_after_a_gateway_type_change() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.clean_up_after_a_gateway_type_change() IS 'Trigger function: when a gateway''s type crosses Remote''s boundary, burns its unredeemed enrolment tokens, owes and asks the revocation of the broker credential the OLD row holds (gateway_has_broker_credential) and stamps credential_revoked_at whether or not the call could be made, forgets the kept copy of a dashboard-issued password, asks forge-sweep at once when a gateway with a repository leaves Remote, and sets OFFLINE a gateway that becomes Remote or leaves Remote mid-enrolment. An archived gateway had its tokens and credential ended when it was archived, so only its status follows (0310). A change among Host, Simulated and Third-party ends nothing (0252, 0311).';

-- -------------------------------------------------------------------------------------------------
-- 5. The sweep
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sweep_gateway_credential_revocations() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_row     record;
  v_asked   int := 0;
BEGIN
  -- Settled. A 2xx to its own request confirms the revocation, and dropping the row makes that final:
  -- pg_net prunes replies after six hours. A credential issued or enrolled after the stamp is the one
  -- the account holds now, and asking again would disable it; an archived gateway is issued none and
  -- enrols none, so its stamp is the last word, as in 0288. A gateway whose record holds no stamp is
  -- owed nothing.
  DELETE FROM public.gateway_revocation_requests q
   USING public.gateways g
   WHERE g.id = q.gateway_id
     AND (g.credential_revoked_at IS NULL
          OR (g.is_archived IS NOT TRUE AND public.gateway_credential_was_replaced(g))
          OR EXISTS (SELECT 1 FROM net._http_response r
                      WHERE r.id = q.request_id AND r.status_code BETWEEN 200 AND 299));

  -- The same for a deleted gateway. A gateway made again under its Sparkplug ID, and enrolled or
  -- issued a credential since the delete, holds the account now.
  DELETE FROM public.deleted_gateway_revocations d
   WHERE EXISTS (SELECT 1 FROM net._http_response r
                  WHERE r.id = d.request_id AND r.status_code BETWEEN 200 AND 299)
      OR EXISTS (SELECT 1 FROM public.gateways g
                  WHERE g.sparkplug_id = d.sparkplug_id
                    AND ((g.enrolled_at IS NOT NULL AND g.enrolled_at > d.owed_since)
                         OR EXISTS (SELECT 1 FROM public.audit_trail dt
                                     WHERE dt.entity_type = 'gateways'
                                       AND dt.entity_id   = g.id
                                       AND dt.action      = 'CREDENTIAL_ISSUED'
                                       AND dt.recorded_at > d.owed_since)));

  -- Asked again, whatever the type, archived or not, or deleted: a request answered with anything but
  -- a 2xx, one with no answer five minutes on, and one never made. The stamp stays. The call writes
  -- its request over the debt; when the credential service is not configured it makes none, and the
  -- next run asks again.
  FOR v_row IN
    SELECT owed.sparkplug_id
      FROM (SELECT g.sparkplug_id, q.request_id, q.requested_at
              FROM public.gateway_revocation_requests q
              JOIN public.gateways g ON g.id = q.gateway_id
             WHERE g.credential_revoked_at IS NOT NULL
               AND (g.is_archived IS TRUE OR NOT public.gateway_credential_was_replaced(g))
            UNION ALL
            SELECT d.sparkplug_id, d.request_id, d.requested_at
              FROM public.deleted_gateway_revocations d) owed
     WHERE NOT EXISTS (SELECT 1 FROM net._http_response r
                        WHERE r.id = owed.request_id AND r.status_code BETWEEN 200 AND 299)
       AND (owed.request_id IS NULL
            OR owed.requested_at < now() - interval '5 minutes'
            OR EXISTS (SELECT 1 FROM net._http_response r WHERE r.id = owed.request_id))
     ORDER BY owed.requested_at
     LIMIT 200
  LOOP
    IF public.revoke_gateway_credential(v_row.sparkplug_id) THEN
      v_asked := v_asked + 1;
    END IF;
  END LOOP;

  -- An archived gateway with no stamp that ever held a credential, by enrolment or by an issue under
  -- any type: what an archive left before this file when the call could not be made, or an earlier
  -- sweep when it cleared the stamp of a call that failed, the type changed or not. An archived
  -- gateway is out of service, so its account is disabled whichever type holds it. It is owed and
  -- stamped now, so a later change of type or a delete cannot lose it.
  FOR v_row IN
    SELECT g.id, g.sparkplug_id FROM public.gateways g
     WHERE g.is_archived
       AND g.credential_revoked_at IS NULL
       AND (g.enrolled_at IS NOT NULL
            OR EXISTS (SELECT 1 FROM public.audit_trail dt
                        WHERE dt.entity_type = 'gateways'
                          AND dt.entity_id   = g.id
                          AND dt.action      = 'CREDENTIAL_ISSUED'))
     LIMIT 200
  LOOP
    IF public.owe_gateway_revocation(v_row.sparkplug_id) THEN
      v_asked := v_asked + 1;
    END IF;
    UPDATE public.gateways SET credential_revoked_at = now() WHERE id = v_row.id;
  END LOOP;

  RETURN v_asked;
END $$;

ALTER FUNCTION public.sweep_gateway_credential_revocations() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sweep_gateway_credential_revocations() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.sweep_gateway_credential_revocations() IS
  'Judges each owed revocation by the reply to its own pg_net request: a 2xx confirms it and the debt '
  'goes. Any other reply, none after five minutes, or no request yet is asked again, with the stamp kept, '
  'whatever the gateway''s type, archived or not, and for a deleted gateway from deleted_gateway_revocations. '
  'A credential issued or enrolled after the stamp, or for a deleted gateway one given to a gateway made '
  'again under its Sparkplug ID, replaces the one it ends, and nothing more is asked. An archived gateway '
  'with no stamp that ever enrolled or was issued a credential is owed and stamped. 200 of each per run. '
  'Run by pg_cron every 15 minutes (0311).';

COMMENT ON COLUMN public.gateways.credential_revoked_at IS 'When the platform ended this gateway''s broker credential, by disabling its account at the broker. Stamped when the gateway is archived, its type crosses Remote''s boundary (0252), or it is set up again for a new appliance (0312), whether or not the call to the credential service could be made: the revocation is owed in gateway_revocation_requests until a 2xx confirms it (0311). Deleting a gateway revokes it too, and leaves its debt in deleted_gateway_revocations. Restoring the gateway leaves it, since the account stays disabled. A credential issued after the stamp outranks it in gateway_has_broker_credential(), and one issued or enrolled after it in the dashboard''s credentialState().';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_src text;
BEGIN
  IF has_function_privilege('anon', 'public.owe_gateway_revocation(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.owe_gateway_revocation(text)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.owe_gateway_revocation(text)', 'EXECUTE') THEN
    RAISE EXCEPTION '0311: an API role may execute owe_gateway_revocation()';
  END IF;
  IF has_function_privilege('anon', 'public.revoke_gateway_credential(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.revoke_gateway_credential(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.sweep_gateway_credential_revocations()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.sweep_gateway_credential_revocations()', 'EXECUTE') THEN
    RAISE EXCEPTION '0311: a browser-facing role may ask for a revocation or run the sweep';
  END IF;
  IF has_table_privilege('anon', 'public.deleted_gateway_revocations', 'SELECT')
     OR has_table_privilege('authenticated', 'public.deleted_gateway_revocations', 'SELECT')
     OR has_table_privilege('service_role', 'public.deleted_gateway_revocations', 'INSERT')
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.deleted_gateway_revocations'::regclass) THEN
    RAISE EXCEPTION '0311: deleted_gateway_revocations is readable by a browser-facing role, writable by an API role, or has RLS off';
  END IF;

  -- A revocation that could not be asked is still recorded.
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.gateway_revocation_requests'::regclass
                AND attname = 'request_id' AND attnotnull) THEN
    RAISE EXCEPTION '0311: gateway_revocation_requests.request_id is NOT NULL, so an owed revocation with no call cannot be recorded';
  END IF;

  -- Each path that ends a credential owes it, the delete keeps the debt, and the sweep asks for the
  -- deleted gateway's debt and never for one a newer credential replaced.
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.revoke_credential_on_decommission()'::regprocedure;
  IF position('owe_gateway_revocation' IN v_src) = 0 OR position('deleted_gateway_revocations' IN v_src) = 0 THEN
    RAISE EXCEPTION '0311: revoke_credential_on_decommission() does not owe the revocation, or a delete loses it';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.clean_up_after_a_gateway_type_change()'::regprocedure;
  IF position('owe_gateway_revocation' IN v_src) = 0 THEN
    RAISE EXCEPTION '0311: clean_up_after_a_gateway_type_change() does not owe the revocation';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = 'public.sweep_gateway_credential_revocations()'::regprocedure;
  IF position('deleted_gateway_revocations' IN v_src) = 0
     OR position('NOT public.gateway_credential_was_replaced(g)' IN v_src) = 0 THEN
    RAISE EXCEPTION '0311: the sweep does not ask for a deleted gateway''s revocation, or asks again after a newer credential';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
