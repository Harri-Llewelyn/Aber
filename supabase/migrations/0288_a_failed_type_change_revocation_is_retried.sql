-- 0288: A failed revocation after a change of a gateway's type is asked again.
--
-- Changing a gateway's type across Remote's boundary revokes the credential the old type held
-- (0252): revoke_gateway_credential() asks the credential service, asynchronously, and the stamp
-- credential_revoked_at is written as the call is queued. For an ARCHIVED gateway the sweep reads
-- the reply to that call and, if it failed, clears the stamp and asks again. For a gateway that is
-- not archived it did not: its first statement dropped the request row of every gateway that is
-- not archived, so a failed call was never judged and never repeated. The stamp stayed, the
-- dashboard called the credential revoked, and the broker account still worked for whoever held
-- the old password.
--
-- Now the sweep tells the two cases apart.
--
--   * An archived gateway is judged as it was: a reply that is not a 2xx, or none in five minutes,
--     clears the stamp, and the same run asks again for an archived gateway that holds a credential
--     and has none.
--   * A gateway that is not archived and still has its request row is asked again, and the stamp
--     stays. It stops when a 2xx confirms the request, or when a credential issued or enrolled
--     after the stamp has replaced the one the stamp ended. The gateway can be given a new
--     credential for its new type under the SAME broker account name, so a retry after that issue
--     would disable the credential just issued: it is checked before every retry, and the row is
--     dropped without a call to the credential service.
--
-- Read: enrolled_at, which an appliance's enrolment stamps, and the CREDENTIAL_ISSUED row the
-- Audit Trail keeps for a credential issued in the dashboard. No column of gateways records the
-- time of an issue, so the audit row is the one record of it, as gateway_has_broker_credential()
-- and the dashboard's credentialState() read it.
--
-- Reasoning: supabase/README.md, "A failed revocation after a change of type is asked again (0288)".
-- Idempotent.
--
-- Redefines public.sweep_gateway_credential_revocations: 0288 asks again for a gateway that is not
--   archived, whose change of type asked for a revocation that failed, keeping its stamp, until a
--   2xx confirms it or a credential issued or enrolled after the stamp replaces the one it ends;
--   0001 dropped the request row of every gateway that was not archived, so a failed call was never
--   judged. An archived gateway is judged as 0001 judges it

-- -------------------------------------------------------------------------------------------------
-- 1. A credential that came after the stamp
-- -------------------------------------------------------------------------------------------------
-- Whether the gateway was given a credential after the revocation was asked: it enrolled after the
-- stamp, or a credential was issued to it after the stamp. Then the account holds the new
-- password, and asking again would disable that one. False for a gateway with no stamp.
CREATE OR REPLACE FUNCTION public.gateway_credential_was_replaced(g public.gateways) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT g.credential_revoked_at IS NOT NULL
       AND ((g.enrolled_at IS NOT NULL AND g.enrolled_at > g.credential_revoked_at)
            OR EXISTS (
                SELECT 1 FROM public.audit_trail dt
                 WHERE dt.entity_type = 'gateways'
                   AND dt.entity_id   = g.id
                   AND dt.action      = 'CREDENTIAL_ISSUED'
                   AND dt.recorded_at > g.credential_revoked_at));
$$;

ALTER FUNCTION public.gateway_credential_was_replaced(g public.gateways) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.gateway_credential_was_replaced(g public.gateways) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.gateway_credential_was_replaced(g public.gateways) IS
  'Whether this gateway enrolled, or was issued a credential, after its credential_revoked_at: then the '
  'broker account holds the new password and a revocation asked again would disable it. False without a '
  'stamp. Read by the revocation sweep alone, which runs as the owner (0288).';

-- -------------------------------------------------------------------------------------------------
-- 2. The sweep
-- -------------------------------------------------------------------------------------------------
-- 0001's, with each statement that judged a request restricted to the gateways it was written for,
-- and a pass at the end for a gateway that is not archived. The archived gateway's statements are
-- 0001's, word for word.
CREATE OR REPLACE FUNCTION public.sweep_gateway_credential_revocations() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_row     record;
  v_asked   int := 0;
BEGIN
  -- A 2xx to its own request confirms a stamp, and dropping the row makes that final: pg_net
  -- prunes replies after six hours. Rows whose gateway lost its stamp go too (a restore clears
  -- it), and so do those of a gateway that is not archived once a newer credential replaced the
  -- one the stamp ended: nothing is left to ask for.
  DELETE FROM public.gateway_revocation_requests q
   USING public.gateways g
   WHERE g.id = q.gateway_id
     AND (g.credential_revoked_at IS NULL
          OR (g.is_archived IS NOT TRUE AND public.gateway_credential_was_replaced(g))
          OR EXISTS (SELECT 1 FROM net._http_response r
                      WHERE r.id = q.request_id AND r.status_code BETWEEN 200 AND 299));

  -- Any other reply, or none five minutes on, means the revocation of an archived gateway did not
  -- happen. Clearing the stamp puts the gateway back into the retry set below. A gateway that is
  -- not archived keeps its stamp and its row: it is asked again at the end.
  WITH failed AS (
    DELETE FROM public.gateway_revocation_requests q
     USING public.gateways g
     WHERE g.id = q.gateway_id
       AND g.is_archived IS TRUE
       AND NOT EXISTS (SELECT 1 FROM net._http_response r
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

  -- A change of type asked for a revocation that failed: ask again, with the stamp as it is, until
  -- a 2xx confirms it or a newer credential replaces the one it ends. revoke_gateway_credential()
  -- writes the new request over the row. When it declines, because the credential service is not
  -- configured, the row stays and the next run asks again.
  FOR v_row IN
    SELECT g.sparkplug_id
      FROM public.gateway_revocation_requests q
      JOIN public.gateways g ON g.id = q.gateway_id
     WHERE g.is_archived IS NOT TRUE
       AND g.credential_revoked_at IS NOT NULL
       AND NOT public.gateway_credential_was_replaced(g)
       AND NOT EXISTS (SELECT 1 FROM net._http_response r
                        WHERE r.id = q.request_id AND r.status_code BETWEEN 200 AND 299)
       AND (q.requested_at < now() - interval '5 minutes'
            OR EXISTS (SELECT 1 FROM net._http_response r WHERE r.id = q.request_id))
     ORDER BY q.requested_at
     LIMIT 200
  LOOP
    IF public.revoke_gateway_credential(v_row.sparkplug_id) THEN
      v_asked := v_asked + 1;
    END IF;
  END LOOP;

  RETURN v_asked;
END $$;

ALTER FUNCTION public.sweep_gateway_credential_revocations() OWNER TO postgres;

COMMENT ON FUNCTION public.sweep_gateway_credential_revocations() IS
  'Judges each revocation by the reply to its own pg_net request (gateway_revocation_requests): a 2xx '
  'confirms it. For an archived gateway any other reply, or none after five minutes, clears the stamp, and '
  'the run asks again for every archived gateway that holds a broker credential and has no stamp. For a '
  'gateway that is not archived, whose type change asked, it asks again and keeps the stamp, until a 2xx '
  'confirms it or a credential issued or enrolled after the stamp replaces the one it ends. 200 of each '
  'per run. Run by pg_cron every 15 minutes. Does nothing for DELETED gateways -- their row is gone; '
  'scripts/revoke-orphaned-broker-accounts.mjs is the sweep for those (0288).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_src text;
BEGIN
  IF has_function_privilege('anon', 'public.gateway_credential_was_replaced(public.gateways)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.gateway_credential_was_replaced(public.gateways)', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.gateway_credential_was_replaced(public.gateways)', 'EXECUTE') THEN
    RAISE EXCEPTION '0288: an API role may execute gateway_credential_was_replaced()';
  END IF;
  IF has_function_privilege('anon', 'public.sweep_gateway_credential_revocations()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.sweep_gateway_credential_revocations()', 'EXECUTE') THEN
    RAISE EXCEPTION '0288: a browser-facing role may execute sweep_gateway_credential_revocations()';
  END IF;
  -- The retry asks nothing of a gateway a newer credential replaced, and the archived gateway's
  -- retry is still the one that reads gateway_has_broker_credential().
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'public.sweep_gateway_credential_revocations()'::regprocedure;
  IF position('NOT public.gateway_credential_was_replaced(g)' IN v_src) = 0
     OR position('public.gateway_has_broker_credential(g)' IN v_src) = 0 THEN
    RAISE EXCEPTION '0288: sweep_gateway_credential_revocations() does not check for a newer credential before it asks again';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
