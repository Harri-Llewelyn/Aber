-- =============================================================================================
-- Migration: 0158_a_revocation_is_judged_by_its_own_reply.sql (applied as 0028 until the 1.0 squash)
-- The revocation retry judges each stamp by the reply to its own request
-- =============================================================================================
--
-- Archiving a gateway stamps credential_revoked_at as soon as its revocation is queued, and
-- sweep_gateway_credential_revocations() clears a stamp that turned out to be wrong so the gateway
-- is asked again. It judged "wrong" by whether ANY 2xx reached net._http_response near the stamp,
-- so a failed revocation stayed stamped whenever the forge sweep or the liveness probe answered
-- 200 in the same minutes.
--
-- revoke_gateway_credential() now records the request id net.http_post returns, against the
-- gateway, in public.gateway_revocation_requests. The sweep reads the reply with that id: a 2xx
-- confirms the stamp and drops the row, so the judgement survives pg_net pruning its replies; any
-- other reply, or none five minutes on, clears the stamp and the gateway is asked again in the
-- same pass. Stamps written before the table existed are cleared once, as it is created, so the
-- sweep re-asks those gateways too.
--
-- A table rather than a gateways column: 0001 replays CREATE OR REPLACE VIEW gateway_status with
-- an explicit column list, which fails on every boot after a column is added to gateways.
--
-- Reasoning: supabase/README.md, "The retry judges each revocation by its own reply (0028)".
-- Idempotent.
-- =============================================================================================

SET search_path TO public;

-- ---------------------------------------------------------------------------------------------
-- 1. The request each stamp waits on, and the one-time re-ask of stamps judged the old way
-- ---------------------------------------------------------------------------------------------
-- The re-ask runs only as the table is created: on every later boot a stamp with no row is one a
-- 2xx confirmed. A stamp is cleared only where the sweep will ask again, i.e. where the gateway
-- still holds a broker credential once the stamp is gone.
DO $table$
BEGIN
  IF to_regclass('public.gateway_revocation_requests') IS NOT NULL THEN
    RETURN;
  END IF;

  CREATE TABLE public.gateway_revocation_requests (
      gateway_id uuid NOT NULL,
      request_id bigint NOT NULL,
      requested_at timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT gateway_revocation_requests_pkey PRIMARY KEY (gateway_id),
      CONSTRAINT gateway_revocation_requests_gateway_id_fkey FOREIGN KEY (gateway_id)
          REFERENCES public.gateways(id) ON DELETE CASCADE
  );

  UPDATE public.gateways g
     SET credential_revoked_at = NULL
   WHERE g.is_archived
     AND g.credential_revoked_at IS NOT NULL
     AND public.gateway_has_broker_credential(
           jsonb_populate_record(g, '{"credential_revoked_at": null}'::jsonb));
END
$table$;

ALTER TABLE public.gateway_revocation_requests OWNER TO postgres;

COMMENT ON TABLE public.gateway_revocation_requests IS
  'The pg_net request behind each archived gateway''s credential_revoked_at stamp, until the '
  'revocation sweep has judged its reply. Written by revoke_gateway_credential(), removed by the '
  'sweep; readable by service_role.';
COMMENT ON COLUMN public.gateway_revocation_requests.request_id IS
  'The id net.http_post returned; its reply lands in net._http_response under the same id.';
COMMENT ON COLUMN public.gateway_revocation_requests.requested_at IS
  'When the request was queued. No reply five minutes on counts as a failed revocation.';

ALTER TABLE public.gateway_revocation_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.gateway_revocation_requests FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.gateway_revocation_requests TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. Asking records the request
-- ---------------------------------------------------------------------------------------------
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
  -- configured" rather than as "rejected".
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

  -- The sweep judges the caller's stamp by this request's reply. An INSERT, never an UPDATE of
  -- gateways: the BEFORE DELETE trigger calls this, and updating the row being deleted aborts the
  -- DELETE. A deleted gateway's row goes with it by ON DELETE CASCADE; no gateway row, no record.
  INSERT INTO public.gateway_revocation_requests (gateway_id, request_id, requested_at)
  SELECT g.id, v_request, now() FROM public.gateways g WHERE g.sparkplug_id = p_sparkplug_id
  ON CONFLICT (gateway_id) DO UPDATE
     SET request_id = EXCLUDED.request_id, requested_at = EXCLUDED.requested_at;

  RETURN true;
END $_$;

COMMENT ON FUNCTION public.revoke_gateway_credential(p_sparkplug_id text) IS
  'Ask the credential service to disable this gateway''s broker account, which is how this platform '
  'revokes: the broker drops any live session at once and refuses the next CONNECT. The account is '
  'not deleted; a later issue re-enables it. Returns false when the service is not configured. '
  'ASYNCHRONOUS: true means "asked", not "revoked". Records the pg_net request id in '
  'gateway_revocation_requests, against the gateway row if there is one, for the sweep to judge.';

-- ---------------------------------------------------------------------------------------------
-- 3. The sweep judges each stamp by its own reply
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sweep_gateway_credential_revocations() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_row     record;
  v_asked   int := 0;
BEGIN
  -- A 2xx to its own request confirms a stamp, and dropping the row makes that final: pg_net
  -- prunes replies after six hours. Rows whose gateway was restored or lost its stamp go too.
  DELETE FROM public.gateway_revocation_requests q
   USING public.gateways g
   WHERE g.id = q.gateway_id
     AND (NOT g.is_archived
          OR g.credential_revoked_at IS NULL
          OR EXISTS (SELECT 1 FROM net._http_response r
                      WHERE r.id = q.request_id AND r.status_code BETWEEN 200 AND 299));

  -- Any other reply, or none five minutes on, means the revocation did not happen. Clearing the
  -- stamp puts the gateway back into the retry set below.
  WITH failed AS (
    DELETE FROM public.gateway_revocation_requests q
     WHERE NOT EXISTS (SELECT 1 FROM net._http_response r
                        WHERE r.id = q.request_id AND r.status_code BETWEEN 200 AND 299)
       AND (q.requested_at < now() - interval '5 minutes'
            OR EXISTS (SELECT 1 FROM net._http_response r WHERE r.id = q.request_id))
    RETURNING q.gateway_id
  )
  UPDATE public.gateways g
     SET credential_revoked_at = NULL
    FROM failed
   WHERE g.id = failed.gateway_id;

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
  'Judges each revocation stamp by the reply to its own pg_net request (gateway_revocation_requests): '
  'a 2xx confirms it, any other reply or none after five minutes clears it. Then asks again for '
  'every archived gateway that holds a broker credential and has no stamp, 200 per run. Run by '
  'pg_cron every 15 minutes. Does nothing for DELETED gateways -- their row is gone; '
  'scripts/revoke-orphaned-broker-accounts.mjs is the sweep for those.';

-- ---------------------------------------------------------------------------------------------
-- What this file did, and nothing wider. Queues nothing: the call below is refused before
-- net.http_post.
-- ---------------------------------------------------------------------------------------------
DO $check$
BEGIN
    IF NOT (SELECT relrowsecurity FROM pg_class
             WHERE oid = 'public.gateway_revocation_requests'::regclass) THEN
        RAISE EXCEPTION '0028: gateway_revocation_requests has row level security off';
    END IF;
    IF has_table_privilege('anon', 'public.gateway_revocation_requests', 'SELECT')
       OR has_table_privilege('authenticated', 'public.gateway_revocation_requests', 'SELECT')
       OR has_table_privilege('service_role', 'public.gateway_revocation_requests', 'INSERT')
       OR NOT has_table_privilege('service_role', 'public.gateway_revocation_requests', 'SELECT') THEN
        RAISE EXCEPTION '0028: gateway_revocation_requests is readable past service_role, or writable other than through its functions';
    END IF;

    IF public.revoke_gateway_credential('not-a-sparkplug-id') THEN
        RAISE EXCEPTION '0028: revoke_gateway_credential() accepted a malformed edge node id';
    END IF;

    IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.revoke_gateway_credential(text)'::regprocedure)
       NOT LIKE '%INSERT INTO public.gateway_revocation_requests%' THEN
        RAISE EXCEPTION '0028: revoke_gateway_credential() does not record its request id';
    END IF;
    IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.sweep_gateway_credential_revocations()'::regprocedure)
       NOT LIKE '%r.id = q.request_id%' THEN
        RAISE EXCEPTION '0028: the revocation sweep does not match replies on the request id';
    END IF;
END
$check$;
