-- =============================================================================================
-- 0023_platform_alerts.sql
--
-- The landing table for Grafana alert notifications, and the realtime feed the dashboard reads.
--
-- ---------------------------------------------------------------------------------------------
-- THE TABLE IS `platform_alerts`, AND IT WAS `platform_alerts` UNTIL THE PLATFORM RULES ARRIVED.
--
-- It was built when every rule was a MACHINE condition -- a thermal excursion, an emergency stop --
-- so `sparkplug_id NOT NULL` and a foreign key to `devices` were exactly right. The platform alert rules add
-- rules about the PLATFORM: a gateway that has gone stale, an enrolment stuck in AWAITING_BIRTH,
-- a quarantine queue that is filling. The first two are about a gateway and the third is about no
-- single entity at all, and none of them fits a table whose every row must name a device.
--
-- So the subject is now (`entity_type`, `entity_id`) with `sparkplug_id` kept as the wire identity
-- where one exists -- the same shape `digital_thread` uses, and NO FOREIGN KEY, for the same reason
-- it has none: an alert that fired is a thing that happened, and purging the asset does not unhappen
-- it. The old `device_id` FK was already `ON DELETE SET NULL`, which conceded the point while still
-- costing a join.
--
-- 0028 migrates an existing database. THIS FILE DESCRIBES A FRESH ONE, which is why it simply
-- creates the new table: on a database that 0028 has already converted, every statement here is a
-- no-op, and on one it has not yet reached, 0023 creates the new table and 0028 moves the rows in.
-- ---------------------------------------------------------------------------------------------
--
-- WHY GRAFANA IS THE ENGINE AND THIS IS ONLY A LOG. The dashboard used to derive an "alarm" state
-- in the browser by comparing the latest telemetry against literals -- see
-- frontend/src/utils/deviceStatus.js for the four reasons that was withdrawn. Alerting needs an
-- evaluation interval, state history, silences, and a notification policy with grouping and
-- repeat intervals. Grafana has all of that and this platform already runs it against the
-- historian. Building a second evaluator here would be re-implementing it a layer further from
-- the data, and the platform is deliberately not an MES (docs/vocabularies.md).
--
-- So the flow is: Grafana evaluates -> webhook contact point -> the grafana-alert-webhook edge
-- function -> this table -> Supabase Realtime -> the dashboard's toast and Topbar pill.
--
-- ---------------------------------------------------------------------------------------------
-- APPEND-ONLY ON (fingerprint, starts_at), NOT UPSERT ON fingerprint
--
-- A Grafana fingerprint is a hash of an alert instance's LABEL SET, so it is stable across every
-- fire -> resolve -> fire cycle for the same series. Keying uniquely on it alone would make the
-- second excursion overwrite the first, and the table would quietly become "most recent
-- occurrence per series" while still carrying `starts_at`/`ends_at` columns that promise history.
-- Pairing it with `starts_at` -- which Grafana moves for each new firing -- makes one row per
-- OCCURRENCE, so "this machine overheated four times last week" is answerable.
--
-- The resolve notification for an occurrence carries the SAME startsAt, which is what lets the
-- function close the row it opened rather than inserting a second one.
--
-- IT IS NOT AN AUDIT TABLE. `digital_thread` is append-only and immutable by trigger because it
-- records human decisions. This records a machine's observations, and an occurrence legitimately
-- transitions firing -> resolved in place, so it takes ordinary UPDATE.
-- ---------------------------------------------------------------------------------------------

SET search_path TO public;

CREATE TABLE IF NOT EXISTS public.platform_alerts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    -- Grafana's own identifier for the alert INSTANCE (a hash of its labels). Not unique on its
    -- own -- see the header.
    fingerprint text NOT NULL,
    -- WHAT THE ALERT IS ABOUT. 'device' and 'gateway' name an asset; 'platform' is an alert with no
    -- single subject -- a quarantine queue depth, a count of stuck enrolments -- where inventing one
    -- would be worse than admitting there is none.
    entity_type text DEFAULT 'device' NOT NULL,
    -- The asset's row id, resolved by the webhook at write time so a reader can join without going
    -- through the historian. NULL for `platform`, and NULL for an asset the id did not match.
    --
    -- NO FOREIGN KEY, deliberately, and the same decision `digital_thread.entity_id` makes: an alert
    -- that fired is a thing that happened, and purging the asset does not unhappen it. The column
    -- this replaces carried `ON DELETE SET NULL`, which conceded exactly that while still costing a
    -- constraint -- and a generic subject cannot reference two different tables anyway.
    entity_id uuid,
    -- THE IMMUTABLE WIRE IDENTITY, not the display name. `devices.name` is mutable and
    -- `identity_source = 'legacy_name'` exists to deprecate matching on it; telemetry is keyed by
    -- `asset_id` in the historian, so this is also the label Grafana naturally carries.
    --
    -- NULLABLE SINCE THE PLATFORM RULES: a fleet-wide alert has no wire identity to carry, and the
    -- webhook used to drop any notification without one. The CHECK below is what keeps that
    -- nullability from becoming an excuse for an unattributed ASSET alert.
    sparkplug_id text,
    alert_name text NOT NULL,
    severity text DEFAULT 'warning' NOT NULL,
    status text NOT NULL,
    summary text,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_alerts_severity_valid CHECK ((severity = ANY (ARRAY['critical'::text, 'warning'::text, 'info'::text]))),
    CONSTRAINT platform_alerts_status_valid CHECK ((status = ANY (ARRAY['firing'::text, 'resolved'::text]))),
    -- A resolved occurrence must say when. Without this a resolve that lost its endsAt would sit
    -- in the table as closed-but-open-ended, and every "how long did it last" reader would have to
    -- guess.
    CONSTRAINT platform_alerts_resolved_has_end CHECK ((status <> 'resolved') OR (ends_at IS NOT NULL)),
    CONSTRAINT platform_alerts_entity_type_valid
        CHECK ((entity_type = ANY (ARRAY['device'::text, 'gateway'::text, 'platform'::text]))),
    -- AN ASSET ALERT MUST NAME THE ASSET. Making `sparkplug_id` nullable for the platform rules
    -- would otherwise quietly permit a device alert that identifies nothing -- which is the failure
    -- the webhook's skip-and-count behaviour existed to prevent, moved into the schema where it
    -- cannot be bypassed by a future caller.
    CONSTRAINT platform_alerts_asset_has_wire_id
        CHECK ((entity_type = 'platform') OR (sparkplug_id IS NOT NULL))
);

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'platform_alerts_pkey' AND conrelid = 'public.platform_alerts'::regclass
  ) THEN
    ALTER TABLE ONLY public.platform_alerts ADD CONSTRAINT platform_alerts_pkey PRIMARY KEY (id);
  END IF;

  -- The occurrence key. This is what the webhook's ON CONFLICT targets, so it is a constraint
  -- rather than a plain unique index -- ON CONFLICT can name either, but an inferred index is one
  -- more thing that has to be guessed correctly at 3am.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'uq_platform_alerts_event' AND conrelid = 'public.platform_alerts'::regclass
  ) THEN
    ALTER TABLE ONLY public.platform_alerts
        ADD CONSTRAINT uq_platform_alerts_event UNIQUE (fingerprint, starts_at);
  END IF;

END
$migration$;

-- The three access patterns, and nothing speculative. "What is firing now" drives the view below,
-- "this asset's history" drives the drawer, and the third arrived with the platform rules: the
-- dashboard reddens a device chip only for a DEVICE alert, so it filters on entity_type before it
-- looks at anything else.
CREATE INDEX IF NOT EXISTS idx_platform_alerts_status_started
    ON public.platform_alerts (status, starts_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_alerts_sparkplug_started
    ON public.platform_alerts (sparkplug_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_alerts_entity
    ON public.platform_alerts (entity_type, entity_id);

COMMENT ON TABLE public.platform_alerts IS
  'One row per Grafana alert OCCURRENCE -- machine conditions and platform conditions alike -- delivered by the grafana-alert-webhook edge function. Append-only on (fingerprint, starts_at); an occurrence transitions firing -> resolved in place.';
COMMENT ON COLUMN public.platform_alerts.sparkplug_id IS
  'The immutable Sparkplug id of the asset the alert was raised for, taken from the Grafana label. '
  'Never a display name. NULL only for entity_type = platform, which has no single subject.';
COMMENT ON COLUMN public.platform_alerts.entity_type IS
  'What the alert is about: device | gateway | platform. The dashboard reddens an asset only for '
  'its own kind, so this is read before entity_id anywhere a colour or a link is derived.';
COMMENT ON COLUMN public.platform_alerts.entity_id IS
  'The subject row id, or NULL for a platform-scoped alert or an id that matched nothing. '
  'Carries no foreign key on purpose -- see the column definition.';


-- ---------------------------------------------------------------------------------------------
-- The active feed.
--
-- ONE ROW PER FINGERPRINT, the newest occurrence, and only while it is firing. DISTINCT ON rather
-- than a plain `WHERE status = 'firing'`: if a resolve is ever missed -- a dropped webhook, a
-- Grafana restart mid-notification -- the series can hold an old firing row AND a newer resolved
-- one, and a naive filter would show the stale one forever. Taking the newest occurrence first and
-- then discarding it unless it is still firing means a later resolve always wins.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.platform_alerts_active WITH (security_invoker='true') AS
SELECT *
  FROM (
    SELECT DISTINCT ON (a.fingerprint)
           a.id, a.fingerprint, a.entity_type, a.entity_id, a.sparkplug_id, a.alert_name,
           a.severity, a.status, a.summary, a.starts_at, a.ends_at, a.recorded_at
      FROM public.platform_alerts a
     ORDER BY a.fingerprint, a.starts_at DESC, a.recorded_at DESC
  ) newest
 WHERE newest.status = 'firing';

COMMENT ON VIEW public.platform_alerts_active IS
  'Currently firing alerts, one row per Grafana fingerprint (the newest occurrence). A later resolved occurrence supersedes an earlier firing one, so a missed resolve cannot pin a stale alert.';


-- ---------------------------------------------------------------------------------------------
-- RLS.
--
-- SELECT TO authenticated ONLY -- deliberately NOT `anon`. An alert summary names a device and the
-- condition it breached, which is operational intelligence about a factory floor; migration 0009
-- exists to revoke exactly this kind of residual anon reach, and validate.py check 13a asserts
-- anon holds no EXECUTE in public. Every comparable table (device_nameplate, digital_thread) is
-- authenticated-only for the same reason.
--
-- WRITES ARE service_role ONLY, and no policy grants them to anyone else. The webhook function is
-- the only writer; an operator acknowledging an alert is a UI concern this table does not model
-- yet, and adding a write policy before there is a caller would be authority granted for
-- convenience.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.platform_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_alerts_select_authenticated ON public.platform_alerts;
CREATE POLICY platform_alerts_select_authenticated
    ON public.platform_alerts FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS platform_alerts_all_service_role ON public.platform_alerts;
CREATE POLICY platform_alerts_all_service_role
    ON public.platform_alerts FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON public.platform_alerts FROM anon;
REVOKE ALL ON public.platform_alerts_active FROM anon;
GRANT SELECT ON public.platform_alerts TO authenticated;
GRANT SELECT ON public.platform_alerts_active TO authenticated;
GRANT ALL ON public.platform_alerts TO service_role;
GRANT SELECT ON public.platform_alerts_active TO service_role;


-- ---------------------------------------------------------------------------------------------
-- Realtime.
--
-- REPLICA IDENTITY FULL, matching cells/gateways/devices. Without it a logical-replication UPDATE
-- carries only the primary key, so a subscriber sees that row 42 changed and nothing about what it
-- changed to -- and the firing -> resolved transition, which is the entire point of the
-- subscription, would be invisible in the payload.
--
-- THE ADD IS HERE AND THE INTENT IS DECLARED IN 0001. That file's `ALTER PUBLICATION ... SET TABLE`
-- is absolute and replays on every boot, so it lists `platform_alerts` among its intended tables and
-- publishes whichever of them exist. On a fresh database 0001 runs before this file and cannot
-- include it, which is why this migration adds it directly: without that, realtime for alerts
-- would not work until the second boot.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.platform_alerts REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'platform_alerts'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.platform_alerts;
    RAISE NOTICE '0023: platform_alerts added to the supabase_realtime publication.';
  END IF;
END $$;


-- ---------------------------------------------------------------------------------------------
-- The machining schema gains `max_temp_threshold`.
--
-- The thermal alert rule reads a PER-DEVICE limit that the machine publishes itself, rather than
-- comparing against a constant -- which is what `metric_catalog` has carried since 0002
-- ('Configured maximum temperature threshold (local extension)') and what nothing has ever read.
-- The CNC subflow now declares it at birth, so it must be MODELLED or every mill is immediately
-- flagged as publishing outside its schema, and the "zero unmodelled metrics" property 0022
-- establishes is lost on the first boot.
--
-- WIDENING AN ACTIVE SCHEMA IN PLACE, WHICH IS NORMALLY REFUSED. prevent_active_schema_mutation()
-- freezes every column but `status` on an active schema -- for `service_role` as well as for
-- `authenticated`, because a trusted key is still not a reason to redefine a contract devices were
-- provisioned against. It exempts the OWNER explicitly, and its own comment names this case:
-- "migrations ... rewrite seeded schemas by name on every boot". This runs as the owner.
--
-- That exemption is for correcting a SEEDED schema within its own release, which is what this is:
-- 0022 shipped the schema and this adds a metric to the same simulated devices in the same branch.
-- An operator-authored schema is a different matter and is versioned through publish_schema_version().
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  v_widened INTEGER := 0;
BEGIN
  UPDATE public.schemas
     SET schema_definition = jsonb_set(
           schema_definition,
           '{properties,max_temp_threshold}',
           '{"type": "number"}'::jsonb,
           true
         )
   WHERE schema_name = 'Machining_Cell_Schema'
     AND version = 1
     AND NOT (schema_definition -> 'properties' ? 'max_temp_threshold');
  GET DIAGNOSTICS v_widened = ROW_COUNT;

  RAISE NOTICE '0023: widened % machining schema(s) with max_temp_threshold.', v_widened;
END $$;


-- Self-check. Asserts the end state the webhook, the view and the alert rules all depend on.
DO $$
DECLARE
  v_missing TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'platform_alerts'
  ) THEN
    RAISE EXCEPTION
      '0023 self-check: platform_alerts is not in the supabase_realtime publication, so the '
      'dashboard would never receive an alert';
  END IF;

  IF (SELECT relreplident FROM pg_class WHERE oid = 'public.platform_alerts'::regclass) <> 'f' THEN
    RAISE EXCEPTION
      '0023 self-check: platform_alerts is not REPLICA IDENTITY FULL, so a firing -> resolved '
      'UPDATE would reach subscribers carrying only its primary key';
  END IF;

  -- anon must not be able to read it, by grant OR by policy.
  IF has_table_privilege('anon', 'public.platform_alerts', 'SELECT') THEN
    RAISE EXCEPTION '0023 self-check: anon can SELECT platform_alerts';
  END IF;

  IF EXISTS (SELECT 1 FROM public.schemas WHERE schema_name = 'Machining_Cell_Schema') THEN
    SELECT schema_name INTO v_missing
      FROM public.schemas
     WHERE schema_name = 'Machining_Cell_Schema'
       AND NOT (schema_definition -> 'properties' ? 'max_temp_threshold');
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION
        '0023 self-check: Machining_Cell_Schema does not model max_temp_threshold, which the CNC '
        'subflow declares at birth -- every mill would be flagged as publishing outside its schema';
    END IF;
  END IF;

  RAISE NOTICE '0023 self-check passed: platform_alerts published with full replica identity, anon '
               'excluded, machining schema models its thermal limit.';
END $$;

NOTIFY pgrst, 'reload schema';
