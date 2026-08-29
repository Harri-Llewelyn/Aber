-- =============================================================================================
-- 0058: asking an edge node to restate itself, from the dashboard
-- =============================================================================================
--
-- `Node Control/Rebirth` is a Sparkplug B NCMD meaning "say who you are again". The node republishes
-- its birth certificate: the metric list, the datatypes, and the alias table that every subsequent
-- DDATA is resolved against. It changes nothing on the plant.
--
-- THE DAEMON HAS ALWAYS SENT THESE. `request_node_rebirth()` fires at startup, on every sequence
-- gap, and now at the start of every broker capture -- because the alias table is in-memory and a
-- stable device may not birth again for weeks. What there has never been is a way for a PERSON to
-- ask, and the workaround was to nudge a node in the Node-RED editor and redeploy.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THIS IS THE ONE COMMAND, AND WHY THE TABLE IS NOT CALLED `commands`
--
-- Sparkplug's NCMD/DCMD channel can write metric VALUES. That is actuation: a setpoint, a mode, a
-- relay. This stack has never permitted it and this migration does not begin to -- `mosquitto.acl`
-- grants the ingestion principal `write spBv1.0/+/NCMD/+` and the daemon publishes exactly one
-- payload through it, which is the rebirth metric.
--
-- The line worth holding is that a rebirth asks a node to RESTATE WHAT IT ALREADY IS. It is
-- idempotent, it carries no operator intent about the process, and a node that ignores it is in
-- exactly the state it was before. Writing a metric value is the opposite of all three. A table
-- named `commands` would invite the second thing to be added beside the first as a variation on it,
-- so this one is named for the only thing it carries.
--
-- ---------------------------------------------------------------------------------------------
-- A ROW RATHER THAN A CALL, for the reason capture_jobs is a row: the browser cannot publish MQTT.
-- The broker has no WebSocket listener and the credential is a server-side secret, so a request is
-- something the daemon has to notice and act on -- and a row that records who asked and what
-- happened is a better artifact than a fire-and-forget POST to an endpoint nothing hosts.
--
-- IDEMPOTENT. db-init replays every migration on every boot in filename order.
--
-- Related: ingestion.py `request_node_rebirth()` (the publisher, and the throttle),
--          0047 (the gate pattern), 0055 (capture jobs, the same claim/report shape),
--          README.md item 17 section 2 (why a capture asks for a birth at all).
-- =============================================================================================

SET search_path TO public;


-- ---------------------------------------------------------------------------------------------
-- 1. The request
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rebirth_requests (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    gateway_id       uuid        NOT NULL REFERENCES public.gateways(id) ON DELETE CASCADE,
    -- Denormalised so the daemon addresses the NCMD without a join, and so the record still says
    -- which edge node was asked after the gateway row is gone.
    edge_node_id     text        NOT NULL,
    sparkplug_group  text        NOT NULL,
    status           text        NOT NULL DEFAULT 'PENDING',
    -- Whether the publish actually went out. `request_node_rebirth()` returns false when the
    -- per-node throttle has not elapsed, and that is a DIFFERENT outcome from a failure: the node
    -- was asked recently and asking again would be the flood the throttle exists to prevent.
    throttled        boolean     NOT NULL DEFAULT false,
    error            text,
    requested_by     uuid,
    requested_at     timestamptz NOT NULL DEFAULT now(),
    sent_at          timestamptz
);

ALTER TABLE public.rebirth_requests DROP CONSTRAINT IF EXISTS rebirth_requests_status_valid;
ALTER TABLE public.rebirth_requests ADD CONSTRAINT rebirth_requests_status_valid
    CHECK (status IN ('PENDING', 'SENT', 'FAILED'));

-- ONE PENDING REQUEST PER GATEWAY. A second is not a second rebirth -- the daemon's own throttle
-- would refuse it -- so queueing one would only produce a row whose outcome is "throttled" and a
-- button that appears to have done something. The index makes the UI's disabled state a fact.
CREATE UNIQUE INDEX IF NOT EXISTS rebirth_requests_one_pending_per_gateway
    ON public.rebirth_requests (gateway_id) WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_rebirth_requests_requested_at
    ON public.rebirth_requests (requested_at DESC);

COMMENT ON TABLE public.rebirth_requests IS
  'A person asking an edge node to republish its birth certificate. The daemon claims PENDING rows '
  'and publishes Node Control/Rebirth, which is the only NCMD this stack sends and the only one '
  'mosquitto.acl permits it. Not a general command channel: writing a metric VALUE is actuation and '
  'is deliberately not reachable from here. See 0058''s header.';


-- ---------------------------------------------------------------------------------------------
-- 2. RLS
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.rebirth_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rebirth_requests_select_privileged" ON public.rebirth_requests;
CREATE POLICY "rebirth_requests_select_privileged" ON public.rebirth_requests
    FOR SELECT TO authenticated
    USING (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Auditor']));

-- No write policy. The gates below are the only door.


-- ---------------------------------------------------------------------------------------------
-- 3. Asking
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_gateway_rebirth(p_gateway_id uuid)
    RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_gateway public.gateways;
    v_id      uuid;
BEGIN
    -- THE SAME AUTHORITY AS RECORDING, not a lower one. A rebirth is harmless to the process and
    -- still momentarily affects the live stream for every subscriber to that node, so it belongs
    -- with the acts an operator takes deliberately rather than with the pages anyone may read.
    IF NOT public.may_manage_captures() THEN
        RAISE EXCEPTION
          'request_gateway_rebirth: requires Administrator or Shopfloor_Manager'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_gateway FROM public.gateways WHERE id = p_gateway_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'request_gateway_rebirth: no gateway %', p_gateway_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF v_gateway.is_archived THEN
        RAISE EXCEPTION
          'request_gateway_rebirth: gateway % is archived, so nothing is listening for the request.',
          v_gateway.name USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- ALREADY ASKED. Reported rather than left to the unique index, so the message says what is
    -- happening instead of naming a constraint.
    IF EXISTS (
        SELECT 1 FROM public.rebirth_requests
         WHERE gateway_id = p_gateway_id AND status = 'PENDING'
    ) THEN
        RAISE EXCEPTION
          'request_gateway_rebirth: a rebirth request for % is already waiting to be sent.',
          v_gateway.name USING ERRCODE = 'unique_violation';
    END IF;

    INSERT INTO public.rebirth_requests
        (gateway_id, edge_node_id, sparkplug_group, requested_by)
    VALUES
        (v_gateway.id, v_gateway.sparkplug_id, v_gateway.sparkplug_group, auth.uid())
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$fn$;

COMMENT ON FUNCTION public.request_gateway_rebirth(uuid) IS
  'Ask an edge node to republish its birth certificate. The only way a rebirth_requests row is '
  'created. The daemon sends it; this only records that somebody asked.';


-- ---------------------------------------------------------------------------------------------
-- 4. The daemon's gates
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ingest_claim_rebirth_requests()
    RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_rows jsonb;
BEGIN
    PERFORM public.require_ingestion_caller('ingest_claim_rebirth_requests');

    -- ALL OF THEM, not one at a time. A rebirth is a single publish with no buffer behind it, so a
    -- daemon that took one per poll would trickle four requests out over twelve seconds for no
    -- reason -- unlike a capture, where one at a time is the whole point.
    WITH claimed AS (
        UPDATE public.rebirth_requests
           SET status = 'SENT', sent_at = now()
         WHERE id IN (SELECT id FROM public.rebirth_requests WHERE status = 'PENDING'
                       ORDER BY requested_at FOR UPDATE SKIP LOCKED)
        RETURNING id, edge_node_id, sparkplug_group
    )
    SELECT coalesce(jsonb_agg(to_jsonb(claimed)), '[]'::jsonb) INTO v_rows FROM claimed;

    -- MARKED SENT ON CLAIM, and corrected afterwards if the publish did not happen. The opposite
    -- order -- claim, publish, then mark -- leaves a row PENDING if the daemon dies mid-publish,
    -- and the next poll would send it again. A rebirth sent twice is harmless; a request that
    -- silently repeats forever because nothing closed it is not.
    RETURN v_rows;
END;
$fn$;


CREATE OR REPLACE FUNCTION public.ingest_record_rebirth_outcome(
    p_id        uuid,
    p_throttled boolean DEFAULT false,
    p_error     text    DEFAULT NULL
) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
BEGIN
    PERFORM public.require_ingestion_caller('ingest_record_rebirth_outcome');

    UPDATE public.rebirth_requests
       SET status    = CASE WHEN p_error IS NULL THEN 'SENT' ELSE 'FAILED' END,
           throttled = coalesce(p_throttled, false),
           error     = left(nullif(btrim(coalesce(p_error, '')), ''), 2000)
     WHERE id = p_id;
END;
$fn$;


-- ---------------------------------------------------------------------------------------------
-- 5. Realtime, so the page sees the answer
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
         WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'rebirth_requests'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.rebirth_requests;
        RAISE NOTICE '0058: rebirth_requests added to the supabase_realtime publication.';
    END IF;
END $$;

ALTER TABLE public.rebirth_requests REPLICA IDENTITY FULL;


-- ---------------------------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------------------------
-- REVOKE FIRST: default privileges grant ALL on every new public table to anon and authenticated.
REVOKE ALL ON public.rebirth_requests FROM anon, authenticated;
GRANT SELECT ON public.rebirth_requests TO authenticated;

REVOKE ALL ON FUNCTION public.request_gateway_rebirth(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_gateway_rebirth(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.ingest_claim_rebirth_requests() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ingest_claim_rebirth_requests() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.ingest_record_rebirth_outcome(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ingest_record_rebirth_outcome(uuid, boolean, text)
    TO authenticated, service_role;


-- ---------------------------------------------------------------------------------------------
-- 7. Self-check
-- ---------------------------------------------------------------------------------------------
DO $selfcheck$
DECLARE
    v_write integer;
    v_wide  text;
BEGIN
    SELECT count(*) INTO v_write FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'rebirth_requests'
       AND cmd IN ('INSERT', 'UPDATE', 'DELETE') AND 'authenticated' = ANY (roles);
    IF v_write <> 0 THEN
        RAISE EXCEPTION
          '0058 self-check: % write polic(ies) on rebirth_requests admit `authenticated`. This table '
          'is how a publish to the plant is requested; the gate is the only door.', v_write;
    END IF;

    SELECT string_agg(format('%s to %s', privilege_type, grantee), '; ') INTO v_wide
      FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND table_name = 'rebirth_requests'
       AND (grantee = 'anon' OR (grantee = 'authenticated' AND privilege_type <> 'SELECT'));
    IF v_wide IS NOT NULL THEN
        RAISE EXCEPTION '0058 self-check: the grant layer is wider than the gate. Found: %.', v_wide;
    END IF;

    -- THE COMMAND SURFACE IS ONE COMMAND, and this is the check that says so. A column carrying a
    -- metric name or a value would mean this table had become a way to actuate the plant, which is
    -- a decision that must not arrive as a migration adding a field to something that already
    -- exists.
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'rebirth_requests'
           AND column_name IN ('metric_name', 'metric_value', 'payload', 'command', 'value')
    ) THEN
        RAISE EXCEPTION
          '0058 self-check: rebirth_requests has gained a column that carries a command payload. '
          'This table sends Node Control/Rebirth and nothing else -- writing a metric VALUE is '
          'actuation, mosquitto.acl does not permit it, and it is not a variation on asking a node '
          'to restate itself. See 0058''s header.';
    END IF;

    RAISE NOTICE
      '0058 self-check: rebirth_requests takes no direct write, is not readable by anon, and still '
      'carries no command payload.';
END;
$selfcheck$;
