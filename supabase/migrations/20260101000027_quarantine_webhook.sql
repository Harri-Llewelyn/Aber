-- Migration: 20260101000027_quarantine_webhook.sql
-- Description: Fire an HTTP webhook when a device ENTERS quarantine, so Node-RED and any
--              external system learn about it without polling.
--
-- This is not replacing custom glue -- there is currently no outbound event path at all.
-- Nothing outside the dashboard learns that ingestion has quarantined a device.
--
-- WHY pg_net AND WHAT IT DOES NOT GIVE YOU
--
-- net.http_post() enqueues into net.http_request_queue and returns immediately; a background
-- worker performs the send. So the trigger never blocks the writing transaction on Node-RED
-- being reachable, and the enqueue is transactional -- it rolls back with the device write.
--
-- But pg_net has NO retries, NO backoff, NO dead-letter queue and NO ordering guarantee. A
-- failed POST leaves an error row in net._http_response and nothing else happens. That is
-- acceptable for an advisory notification. If anything downstream ever needs guaranteed
-- delivery, this is the wrong transport -- publish from the ingestion daemon to MQTT instead,
-- which this stack already runs a broker for.

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Endpoint registry -------------------------------------------------------------------------
-- A table rather than a hardcoded URL so a second consumer can be added without a code change,
-- and so an endpoint can be disabled without dropping the trigger.
CREATE TABLE IF NOT EXISTS public.webhook_endpoints (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key   TEXT NOT NULL,
  url         TEXT NOT NULL,
  -- vault.secrets.name of a bearer token, or NULL for an unauthenticated endpoint.
  secret_name TEXT,
  is_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_key, url)
);

COMMENT ON TABLE public.webhook_endpoints IS
  'Outbound webhook targets. Managed by migration only -- there is deliberately no '
  'INSERT/UPDATE/DELETE RLS policy, so no API caller can point the database at a host of '
  'their choosing.';

ALTER TABLE public.webhook_endpoints ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "webhook_endpoints_select_privileged" ON public.webhook_endpoints;
CREATE POLICY "webhook_endpoints_select_privileged" ON public.webhook_endpoints
  FOR SELECT TO authenticated
  USING (public.has_role(ARRAY['Administrator']));

-- No write policies, by design. With RLS enabled and no policy, every INSERT/UPDATE/DELETE from
-- `authenticated` is denied -- fail closed. A writable endpoint table is an SSRF primitive:
-- it would let an API caller aim an authenticated, database-originated POST at any host they
-- like, including cloud metadata services.

-- Supabase's default privileges grant `anon` SELECT on new tables in public, so without this
-- the only thing standing between a logged-out caller and the endpoint list is the RLS policy
-- above. That is sufficient today (it yields zero rows), but a future policy edit would
-- silently widen it. Revoke at the grant level too -- same treatment as public.gateway_status.
REVOKE ALL ON public.webhook_endpoints FROM anon;

INSERT INTO public.webhook_endpoints (event_key, url, secret_name)
VALUES ('device.quarantined', 'http://node-red:1880/hooks/quarantine', 'nodered_admin_token')
ON CONFLICT (event_key, url) DO NOTHING;


-- Dispatcher ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_device_quarantine_webhook()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, vault
AS $$
DECLARE
  ep    RECORD;
  hdrs  JSONB;
  token TEXT;
BEGIN
  FOR ep IN
    SELECT * FROM public.webhook_endpoints
    WHERE event_key = 'device.quarantined' AND is_enabled
  LOOP
    hdrs := jsonb_build_object('Content-Type', 'application/json');

    IF ep.secret_name IS NOT NULL THEN
      SELECT decrypted_secret INTO token
      FROM vault.decrypted_secrets
      WHERE name = ep.secret_name;

      -- Only attach credentials when there are any. The default stack runs Node-RED without
      -- adminAuth and stores no token, and sending a literal "Bearer " would be worse than
      -- sending nothing.
      IF token IS NOT NULL AND token <> '' THEN
        hdrs := hdrs || jsonb_build_object('Authorization', 'Bearer ' || token);
      END IF;
    END IF;

    PERFORM net.http_post(
      url     := ep.url,
      headers := hdrs,
      body    := jsonb_build_object(
        'event',             'device.quarantined',
        'device_id',         NEW.id,
        -- The identifier an operator can actually match against MQTT and TimescaleDB.
        'sparkplug_id',      NEW.sparkplug_id,
        'name',              NEW.name,
        'gateway_id',        NEW.gateway_id,
        'reported_identity', NEW.reported_identity,
        'quarantine_reason', NEW.quarantine_reason,
        'identity_source',   NEW.identity_source,
        'occurred_at',       NOW()
      ),
      timeout_milliseconds := 3000
    );
  END LOOP;

  RETURN NULL;  -- AFTER trigger; return value is ignored
END $$;

REVOKE ALL ON FUNCTION public.dispatch_device_quarantine_webhook() FROM PUBLIC;


-- Trigger --------------------------------------------------------------------------------------
-- FIRES ON THE TRANSITION INTO QUARANTINE, NOT ON EVERY WRITE.
--
-- This is deliberately NOT a trigger on digital_thread INSERT, which is the obvious design and
-- is wrong here. log_digital_thread_event() is an unconditional AFTER INSERT OR UPDATE OR
-- DELETE trigger on cells/gateways/devices, and ingestion stamps gateways.last_heartbeat on
-- every NBIRTH/NDATA/NDEATH -- the Node-RED simulator alone beats every 30s. A blanket hook on
-- digital_thread would therefore emit roughly 2 HTTP requests per minute per gateway of pure
-- heartbeat noise, forever.
--
-- SPLIT INTO TWO TRIGGERS, not one AFTER INSERT OR UPDATE with a TG_OP test.
--
-- TG_OP cannot be referenced in a WHEN clause: it is a PL/pgSQL variable available only inside
-- the function body, whereas WHEN is plain SQL evaluated by the executor. Writing
-- `WHEN (... AND (TG_OP = 'INSERT' OR ...))` fails outright with
-- `ERROR: column "tg_op" does not exist`.
--
-- Also, OLD is not bound at all on INSERT, so a single combined trigger could not reference
-- OLD.is_quarantined in its condition even if TG_OP were available. Two triggers sharing one
-- function express the same rule and are the standard form.
--
-- Together they fire on exactly the transition into quarantine:
--   * INSERT: ingestion auto-quarantines a device it has never seen -- the row is born
--     quarantined, so any such INSERT is an entry.
--   * UPDATE OF is_quarantined: the trigger is not evaluated at all when other columns are
--     written (a rename, a heartbeat-driven status change, a gateway reassignment).
--       - NEW.is_quarantined IS TRUE          -- approvals, which clear the flag, do not fire
--       - OLD.is_quarantined IS DISTINCT FROM TRUE -- re-saving an already-quarantined device
--         does not re-fire. IS DISTINCT FROM rather than <> so a NULL previous value counts
--         as a transition instead of evaluating to NULL and silently suppressing the event.

-- Drop the pre-split name too, so a database that ever ran an earlier revision is cleaned up.
DROP TRIGGER IF EXISTS trg_device_quarantine_webhook ON public.devices;

DROP TRIGGER IF EXISTS trg_device_quarantine_webhook_insert ON public.devices;
CREATE TRIGGER trg_device_quarantine_webhook_insert
AFTER INSERT ON public.devices
FOR EACH ROW
WHEN (NEW.is_quarantined IS TRUE)
EXECUTE FUNCTION public.dispatch_device_quarantine_webhook();

DROP TRIGGER IF EXISTS trg_device_quarantine_webhook_update ON public.devices;
CREATE TRIGGER trg_device_quarantine_webhook_update
AFTER UPDATE OF is_quarantined ON public.devices
FOR EACH ROW
WHEN (NEW.is_quarantined IS TRUE AND OLD.is_quarantined IS DISTINCT FROM TRUE)
EXECUTE FUNCTION public.dispatch_device_quarantine_webhook();

NOTIFY pgrst, 'reload schema';
