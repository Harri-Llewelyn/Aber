-- 0255: Automations are kept as rows.
--
-- An automation is a rule that watches a reading and does something about it: "when this device's
-- metric is above 80 for five minutes, raise a warning". A person writes one as YAML on the
-- Automations page, but the rows are the record, so an automation is bound to the devices it names,
-- the Audit Trail knows who changed a threshold, row security decides who may write, and the
-- backups hold it by construction. This file states the three tables, who reads them, and the one
-- function that names an alert's fingerprint.
--
--   * automations: one row per automation. `key` is the person's `id:` in the YAML, a slug, and
--     what a re-upload finds the row by; `id` is the row's own uuid.
--   * automation_triggers: what starts one. A trigger that names several devices is one row per
--     device, so each is evaluated, and fires, on its own and the lifecycle can archive a single
--     device's row. `position` and `device_position` let the renderer group the rows back into the
--     trigger a person wrote. `kind` is `threshold` today; asset and metric are nullable and so is
--     the threshold, for the kinds that watch every device or carry none.
--   * automation_actions: what a firing trigger does. `alert` is the one action today.
--   * Every role reads the three tables. Nobody writes them directly: 0256's functions do, as the
--     owner, after asking for an Administrator or a Shopfloor Manager and, with the switch on, the
--     second factor.
--   * automation_alert_fingerprint() is the one place the fingerprint of an alert an automation
--     raises is composed. The lifecycle (0257) resolves by it, and the evaluator that writes the
--     alerts calls it.
--
-- 0256 writes and reads them, 0257 holds their lifecycle, and the Audit Trail's map of kinds
-- (0249) lists their acts.
--
-- Reasoning: supabase/README.md, "Automations are kept as rows (0255)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The tables
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.automations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    alias text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT automations_pkey PRIMARY KEY (id),
    CONSTRAINT automations_key_key UNIQUE (key),
    CONSTRAINT automations_key_format CHECK ((key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'::text)),
    CONSTRAINT automations_alias_valid
        CHECK (((char_length(alias) >= 1) AND (char_length(alias) <= 120) AND (alias = btrim(alias)))),
    CONSTRAINT automations_description_valid CHECK ((char_length(description) <= 1000))
);

ALTER TABLE public.automations OWNER TO postgres;
ALTER TABLE public.automations ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.automation_triggers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    automation_id uuid NOT NULL,
    "position" integer NOT NULL,
    device_position integer DEFAULT 0 NOT NULL,
    kind text NOT NULL,
    entity_id uuid,
    metric_name text,
    comparison text,
    threshold double precision,
    hold_seconds integer DEFAULT 0 NOT NULL,
    is_archived boolean DEFAULT false NOT NULL,
    archived_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT automation_triggers_pkey PRIMARY KEY (id),
    CONSTRAINT automation_triggers_automation_id_fkey FOREIGN KEY (automation_id)
        REFERENCES public.automations(id) ON DELETE CASCADE,
    CONSTRAINT automation_triggers_entity_id_fkey FOREIGN KEY (entity_id)
        REFERENCES public.devices(id) ON DELETE CASCADE,
    CONSTRAINT automation_triggers_metric_name_fkey FOREIGN KEY (metric_name)
        REFERENCES public.metric_catalog(name) ON DELETE RESTRICT,
    CONSTRAINT automation_triggers_kind_format CHECK ((kind ~ '^[a-z][a-z_]{0,31}$'::text)),
    CONSTRAINT automation_triggers_position_valid CHECK ((("position" >= 0) AND (device_position >= 0))),
    CONSTRAINT automation_triggers_comparison_format
        CHECK (((comparison IS NULL) OR (comparison ~ '^[a-z][a-z_]{0,31}$'::text))),
    CONSTRAINT automation_triggers_comparison_has_threshold CHECK (((comparison IS NULL) = (threshold IS NULL))),
    CONSTRAINT automation_triggers_hold_valid CHECK (((hold_seconds >= 0) AND (hold_seconds <= 3596400))),
    CONSTRAINT automation_triggers_threshold_shape
        CHECK (((kind <> 'threshold'::text)
                OR ((entity_id IS NOT NULL) AND (metric_name IS NOT NULL) AND (threshold IS NOT NULL)
                    AND (comparison = ANY (ARRAY['above'::text, 'below'::text]))))),
    CONSTRAINT automation_triggers_archived_has_time CHECK ((is_archived = (archived_at IS NOT NULL)))
);

ALTER TABLE public.automation_triggers OWNER TO postgres;
ALTER TABLE public.automation_triggers ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.automation_actions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    automation_id uuid NOT NULL,
    "position" integer NOT NULL,
    kind text NOT NULL,
    severity text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT automation_actions_pkey PRIMARY KEY (id),
    CONSTRAINT automation_actions_automation_id_fkey FOREIGN KEY (automation_id)
        REFERENCES public.automations(id) ON DELETE CASCADE,
    CONSTRAINT automation_actions_position_key UNIQUE (automation_id, "position"),
    CONSTRAINT automation_actions_kind_format CHECK ((kind ~ '^[a-z][a-z_]{0,31}$'::text)),
    CONSTRAINT automation_actions_position_valid CHECK (("position" >= 0)),
    CONSTRAINT automation_actions_alert_shape
        CHECK (((kind <> 'alert'::text) OR (severity = ANY (ARRAY['critical'::text, 'warning'::text, 'info'::text]))))
);

ALTER TABLE public.automation_actions OWNER TO postgres;
ALTER TABLE public.automation_actions ENABLE ROW LEVEL SECURITY;

-- The rows of an automation in the order a document writes them; the lifecycle's lookups by device
-- (and the cascade from devices, which needs one); and the catalogue's key check.
CREATE INDEX IF NOT EXISTS idx_automation_triggers_automation
    ON public.automation_triggers USING btree (automation_id, "position", device_position);
CREATE INDEX IF NOT EXISTS idx_automation_triggers_entity
    ON public.automation_triggers USING btree (entity_id) WHERE (entity_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_automation_triggers_metric
    ON public.automation_triggers USING btree (metric_name) WHERE (metric_name IS NOT NULL);

COMMENT ON TABLE public.automations IS
  'A rule that watches readings and acts: written as YAML on the Automations page, kept here as '
  'rows, which are the record. Every signed-in role reads it; written only by apply_automations(), '
  'set_automation_enabled() and delete_automation(), for an Administrator or a Shopfloor Manager, '
  'each of which writes one Audit Trail row per automation (0255, 0256).';
COMMENT ON COLUMN public.automations.key IS
  'The `id:` a person writes in the YAML: a slug of 1 to 64 lowercase letters, digits, hyphens and '
  'underscores, starting with a letter or a digit. A re-upload with the same key updates this row '
  'instead of adding another. Fixed once written (0255).';
COMMENT ON COLUMN public.automations.alias IS
  'The automation''s name as the list shows it: 1 to 120 characters, with no space at either end (0255).';
COMMENT ON COLUMN public.automations.description IS
  'What it is for, in the writer''s words, up to 1,000 characters. The YAML has no comments, so this '
  'is where words go (0255).';
COMMENT ON COLUMN public.automations.enabled IS
  'Whether its triggers are evaluated. Turned off by a person, or by the lifecycle when the last '
  'trigger that could fire is gone, which the Audit Trail records with its reason (0255, 0257).';

COMMENT ON TABLE public.automation_triggers IS
  'What starts an automation: one row per trigger and device, so each device is evaluated, and '
  'fires, on its own. `position` is the trigger''s place in the automation''s `triggers` list and '
  'device_position the device''s place in its `device:` list, so a renderer can group the rows back '
  'into the trigger a person wrote. Read by every signed-in role; written by 0256''s functions only '
  '(0255).';
COMMENT ON COLUMN public.automation_triggers.kind IS
  'The trigger type. `threshold` compares the latest value of one metric on one device with a '
  'number, held for hold_seconds. A later kind adds its own CHECK for the columns it needs (0255).';
COMMENT ON COLUMN public.automation_triggers.entity_id IS
  'The device it watches, deleted with it. NULL for a kind that applies to every modelled device. '
  'A `threshold` row always names one (0255).';
COMMENT ON COLUMN public.automation_triggers.metric_name IS
  'The metric it watches, a measured one in metric_catalog: the catalogue refuses to delete a metric '
  'a trigger uses. NULL for a kind that carries none (0255).';
COMMENT ON COLUMN public.automation_triggers.comparison IS
  '`above` or `below`: the reading breaches when it is greater than, or less than, the threshold. '
  'NULL with the threshold (0255).';
COMMENT ON COLUMN public.automation_triggers.threshold IS
  'The number the latest value is compared with, in the metric''s catalogue unit. Units are never '
  'written. NULL for a kind that has none (0255).';
COMMENT ON COLUMN public.automation_triggers.hold_seconds IS
  'How long a reading must keep breaching before the trigger fires: `for:` in the YAML, written '
  '30s, 5m or 1h and stored in seconds. 0 fires on the first breach (0255).';
COMMENT ON COLUMN public.automation_triggers.is_archived IS
  'True while the device it names is archived: the row is kept, the device''s return brings it back, '
  'and nothing evaluates it meanwhile. Set and cleared by the lifecycle (0257).';

COMMENT ON TABLE public.automation_actions IS
  'What a firing trigger does. `alert` raises a platform alert of the given severity, and is the one '
  'action in this release. Read by every signed-in role; written by 0256''s functions only (0255).';
COMMENT ON COLUMN public.automation_actions.kind IS 'The action type: `alert` (0255).';
COMMENT ON COLUMN public.automation_actions.severity IS
  'For an `alert` action: critical, warning or info, the vocabulary platform_alerts.severity holds (0255).';

-- -------------------------------------------------------------------------------------------------
-- 2. Who reads them, and that nobody writes them
-- -------------------------------------------------------------------------------------------------
-- Every signed-in role reads every automation, as every role reads the windows an alert stays quiet
-- in. anon is revoked by name. No role holds INSERT, UPDATE or DELETE: 0256's functions are the only
-- writers, and run as the owner.
REVOKE ALL ON TABLE public.automations FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.automation_triggers FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.automation_actions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.automations TO authenticated, service_role;
GRANT SELECT ON TABLE public.automation_triggers TO authenticated, service_role;
GRANT SELECT ON TABLE public.automation_actions TO authenticated, service_role;

SELECT public.replay_policy('public.automations', 'automations_select_authenticated', $ddl$
CREATE POLICY automations_select_authenticated ON public.automations FOR SELECT TO authenticated USING (true);
$ddl$);
SELECT public.replay_policy('public.automation_triggers', 'automation_triggers_select_authenticated', $ddl$
CREATE POLICY automation_triggers_select_authenticated ON public.automation_triggers FOR SELECT TO authenticated USING (true);
$ddl$);
SELECT public.replay_policy('public.automation_actions', 'automation_actions_select_authenticated', $ddl$
CREATE POLICY automation_actions_select_authenticated ON public.automation_actions FOR SELECT TO authenticated USING (true);
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- 3. The fingerprint of an alert an automation raises
-- -------------------------------------------------------------------------------------------------
-- `condition:`, then the trigger row's id, the device's id and the metric, so a reader of a
-- platform_alerts row can tell which writer made it and which trigger. The metric comes last
-- because a metric name may hold a slash, never a colon. Asked without a device and a metric, it
-- answers the prefix every fingerprint of that trigger starts with, which is how a trigger that
-- watches every device is resolved as a whole.
CREATE OR REPLACE FUNCTION public.automation_alert_fingerprint(p_trigger_id uuid, p_entity_id uuid, p_metric_name text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT CASE
    WHEN p_trigger_id IS NULL THEN NULL
    WHEN p_entity_id IS NULL OR p_metric_name IS NULL THEN 'condition:' || p_trigger_id::text || ':'
    ELSE 'condition:' || p_trigger_id::text || ':' || p_entity_id::text || ':' || p_metric_name
  END;
$$;

ALTER FUNCTION public.automation_alert_fingerprint(uuid, uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.automation_alert_fingerprint(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.automation_alert_fingerprint(uuid, uuid, text) IS
  'The platform_alerts fingerprint of an alert an automation''s trigger raises for one device and '
  'metric: condition:<trigger id>:<device id>:<metric>. With no device or no metric, the prefix '
  'condition:<trigger id>: that all of the trigger''s fingerprints start with. The evaluator writes '
  'by it and the lifecycle resolves by it, so it is composed here and nowhere else (0255).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_table text;
  v_trigger uuid := '11111111-1111-4111-8111-111111111111';
  v_entity  uuid := '22222222-2222-4222-8222-222222222222';
BEGIN
  FOREACH v_table IN ARRAY ARRAY['automations', 'automation_triggers', 'automation_actions'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = ('public.' || v_table)::regclass AND c.relrowsecurity) THEN
      RAISE EXCEPTION '0255: row security is off on %', v_table;
    END IF;
    IF has_table_privilege('anon', 'public.' || v_table, 'SELECT')
       OR has_table_privilege('anon', 'public.' || v_table, 'INSERT') THEN
      RAISE EXCEPTION '0255: anon holds a privilege on %', v_table;
    END IF;
    IF NOT has_table_privilege('authenticated', 'public.' || v_table, 'SELECT') THEN
      RAISE EXCEPTION '0255: authenticated cannot read %', v_table;
    END IF;
    IF has_table_privilege('authenticated', 'public.' || v_table, 'INSERT')
       OR has_table_privilege('authenticated', 'public.' || v_table, 'UPDATE')
       OR has_table_privilege('authenticated', 'public.' || v_table, 'DELETE') THEN
      RAISE EXCEPTION '0255: authenticated may write % directly', v_table;
    END IF;
  END LOOP;

  IF public.automation_alert_fingerprint(v_trigger, v_entity, 'Spindle/LOAD')
     <> 'condition:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:Spindle/LOAD'
     OR public.automation_alert_fingerprint(v_trigger, NULL, NULL)
        <> 'condition:11111111-1111-4111-8111-111111111111:'
     OR NOT starts_with(public.automation_alert_fingerprint(v_trigger, v_entity, 'Spindle/LOAD'),
                        public.automation_alert_fingerprint(v_trigger, NULL, NULL)) THEN
    RAISE EXCEPTION '0255: automation_alert_fingerprint() does not compose condition:<trigger>:<device>:<metric>';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
