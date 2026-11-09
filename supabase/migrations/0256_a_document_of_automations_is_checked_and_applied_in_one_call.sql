-- 0256: A document of automations is checked and applied in one call.
--
-- The Automations page parses a person's YAML into JSON and hands it to one function. The database
-- is the authority: it checks every field, resolves every reference and checks the caller's right,
-- and the browser's JSON Schema is a convenience that a guard test holds to it.
--
--   * apply_automations(p_doc, p_dry_run) answers one result per automation: its key, its status
--     (new, changed, unchanged or refused) and, for a refusal, reasons that each carry a JSON path
--     the editor maps back to a line, such as $[0].triggers[1].above. All or nothing: with any
--     refusal, or with p_dry_run true, it writes nothing, so the upload preview is the same call.
--     It never deletes: an automation the document leaves out is left alone.
--   * What it accepts is closed. One trigger type, `threshold`, with one device or a list, a
--     catalogue metric, `above` or `below` (exactly one) and `for`. One action type, `alert`, with
--     a severity. `conditions` only when absent or empty. A key it does not know is refused, never
--     ignored.
--   * automations_document() renders the rows back to the document's shape, with each device's
--     name and place for a comment beside its id. apply_automations() of that document reports
--     every automation unchanged.
--   * set_automation_enabled() and delete_automation() are the list's two acts.
--   * automations_for_entity() says which automations apply to a device, and why.
--   * Every writer begins by asking for an Administrator or a Shopfloor Manager and the second
--     factor (require_mfa()), and writes one Audit Trail row per automation it creates, changes,
--     enables, disables or deletes, naming who did it.
--
-- 0255 states the tables. 0257 holds the lifecycle that follows a device, and resolves the alerts of
-- what is turned off or removed.
--
-- Reasoning: supabase/README.md, "A document of automations is checked and applied in one call
-- (0256)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. Small pure helpers
-- -------------------------------------------------------------------------------------------------
-- A duration in seconds as the document writes it: the largest of h, m and s that divides it. The
-- document accepts at most three digits of any of them, and every value it accepts renders in three.
CREATE OR REPLACE FUNCTION public.automation_duration_text(p_seconds integer) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT CASE
    WHEN p_seconds IS NULL THEN NULL
    WHEN p_seconds > 0 AND p_seconds % 3600 = 0 THEN (p_seconds / 3600)::text || 'h'
    WHEN p_seconds > 0 AND p_seconds % 60 = 0 THEN (p_seconds / 60)::text || 'm'
    ELSE p_seconds::text || 's'
  END;
$$;

ALTER FUNCTION public.automation_duration_text(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.automation_duration_text(integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.automation_duration_text(integer) TO authenticated;

COMMENT ON FUNCTION public.automation_duration_text(integer) IS
  'A hold in seconds as a document writes `for:`: 3600 is 1h, 300 is 5m, 90 is 90s, 0 is 0s (0256).';

-- The JSON path of a key under a parent: $[0].triggers, or $[0]["odd key"] for a key that is not a
-- plain name.
CREATE OR REPLACE FUNCTION public.automation_path(p_parent text, p_key text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT p_parent || CASE WHEN p_key ~ '^[A-Za-z_][A-Za-z0-9_]*$' THEN '.' || p_key
                          ELSE '[' || to_jsonb(p_key)::text || ']' END;
$$;

ALTER FUNCTION public.automation_path(text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.automation_path(text, text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.automation_path(text, text) IS
  'The JSON path of a key under a parent path, for a refusal''s reason: $[0].triggers, or '
  '$[0]["odd key"] where the key is not a plain name (0256).';

CREATE OR REPLACE FUNCTION public.automation_reason(p_path text, p_message text) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT jsonb_build_object('path', p_path, 'message', p_message);
$$;

ALTER FUNCTION public.automation_reason(text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.automation_reason(text, text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.automation_reason(text, text) IS
  'One reason in a refused automation''s result: {path, message} (0256).';

-- -------------------------------------------------------------------------------------------------
-- 2. An automation in the document's shape
-- -------------------------------------------------------------------------------------------------
-- One renderer for the rows and for a document that has been checked, so "unchanged" is a
-- comparison of two renderings of the same shape. Trigger rows group back into the trigger a person
-- wrote: the same position, kind, metric, comparison, threshold and hold. One device is written as
-- an id, several as a list. A hold of 0 is the default and is left out. The threshold has been
-- through a double precision on both sides.
CREATE OR REPLACE FUNCTION public.automation_document_of(p_key text, p_alias text, p_description text,
                                                         p_enabled boolean, p_rows jsonb, p_actions jsonb)
RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT jsonb_build_object(
    'id', p_key,
    'alias', p_alias,
    'description', p_description,
    'enabled', p_enabled,
    'triggers', coalesce((
      SELECT jsonb_agg(g.trigger ORDER BY g.pos, g.first_device)
        FROM (SELECT r.pos,
                     min(r.device_pos) AS first_device,
                     jsonb_build_object(
                       'trigger', r.kind,
                       'device', CASE WHEN count(*) = 1 THEN to_jsonb(min(r.entity_id))
                                      ELSE jsonb_agg(to_jsonb(r.entity_id) ORDER BY r.device_pos, r.entity_id) END,
                       'metric', r.metric_name)
                     || CASE WHEN r.comparison IS NOT NULL
                             THEN jsonb_build_object(r.comparison, to_jsonb(r.threshold)) ELSE '{}'::jsonb END
                     || CASE WHEN r.hold_seconds > 0
                             THEN jsonb_build_object('for', public.automation_duration_text(r.hold_seconds))
                             ELSE '{}'::jsonb END AS trigger
                FROM (SELECT (x ->> 'position')::integer AS pos,
                             (x ->> 'device_position')::integer AS device_pos,
                             x ->> 'kind' AS kind,
                             x ->> 'entity_id' AS entity_id,
                             x ->> 'metric_name' AS metric_name,
                             x ->> 'comparison' AS comparison,
                             (x ->> 'threshold')::double precision AS threshold,
                             (x ->> 'hold_seconds')::integer AS hold_seconds
                        FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x) r
               GROUP BY r.pos, r.kind, r.metric_name, r.comparison, r.threshold, r.hold_seconds) g), '[]'::jsonb),
    'actions', coalesce((
      SELECT jsonb_agg(jsonb_build_object('action', a ->> 'kind', 'severity', a ->> 'severity')
                       ORDER BY (a ->> 'position')::integer)
        FROM jsonb_array_elements(coalesce(p_actions, '[]'::jsonb)) a), '[]'::jsonb));
$$;

ALTER FUNCTION public.automation_document_of(text, text, text, boolean, jsonb, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.automation_document_of(text, text, text, boolean, jsonb, jsonb) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.automation_document_of(text, text, text, boolean, jsonb, jsonb) TO authenticated;

COMMENT ON FUNCTION public.automation_document_of(text, text, text, boolean, jsonb, jsonb) IS
  'An automation in the document''s shape: id, alias, description, enabled, triggers and actions. '
  'p_rows are trigger rows (position, device_position, kind, entity_id, metric_name, comparison, '
  'threshold, hold_seconds), grouped back into the triggers a person wrote; p_actions are action '
  'rows (position, kind, severity). Used for the stored rows and for a checked document alike, so '
  '"unchanged" compares two renderings of one shape (0256).';

-- The stored automation, in the document's shape. Archived trigger rows are left out: they name a
-- device that is archived, and come back with it.
CREATE OR REPLACE FUNCTION public.automation_stored_document(p_automation_id uuid) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT public.automation_document_of(
    a.key, a.alias, a.description, a.enabled,
    (SELECT jsonb_agg(jsonb_build_object(
              'position', t.position, 'device_position', t.device_position, 'kind', t.kind,
              'entity_id', t.entity_id, 'metric_name', t.metric_name, 'comparison', t.comparison,
              'threshold', t.threshold, 'hold_seconds', t.hold_seconds)
            ORDER BY t.position, t.device_position, t.id)
       FROM public.automation_triggers t
      WHERE t.automation_id = a.id AND NOT t.is_archived),
    (SELECT jsonb_agg(jsonb_build_object('position', x.position, 'kind', x.kind, 'severity', x.severity)
                      ORDER BY x.position)
       FROM public.automation_actions x
      WHERE x.automation_id = a.id))
    FROM public.automations a
   WHERE a.id = p_automation_id;
$$;

ALTER FUNCTION public.automation_stored_document(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.automation_stored_document(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.automation_stored_document(uuid) TO authenticated;

COMMENT ON FUNCTION public.automation_stored_document(uuid) IS
  'The stored automation in the document''s shape, without the trigger rows archived with their '
  'device. SECURITY INVOKER: the tables'' own policies decide what the caller sees (0256).';

-- -------------------------------------------------------------------------------------------------
-- 3. Checking a document
-- -------------------------------------------------------------------------------------------------
-- Reads the catalogue and the devices and writes nothing. A file is bounded: 500 automations, 100
-- triggers each, 500 devices a trigger and 10,000 devices in all. For each automation, in
-- order: {index, key, reasons, canon}. `canon` is the automation as it would be stored, with every
-- value typed and every default made explicit, and null when there is any reason to refuse it. It
-- is checked field by field and every reason is collected, so a person fixes a file in one pass.
CREATE OR REPLACE FUNCTION public.automations_parse(p_doc jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
DECLARE
  c_id      CONSTANT text := '^[a-z0-9][a-z0-9_-]{0,63}$';
  c_uuid    CONSTANT text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  c_for     CONSTANT text := '^(0|[1-9][0-9]{0,2})[smh]$';
  c_max_automations CONSTANT integer := 500;
  c_max_triggers    CONSTANT integer := 100;
  c_max_devices     CONSTANT integer := 500;
  c_max_rows        CONSTANT integer := 10000;
  v_out      jsonb := '[]'::jsonb;
  v_seen     jsonb := '{}'::jsonb;
  v_auto     jsonb;
  v_apath    text;
  v_reasons  jsonb;
  v_rows     jsonb;
  v_actions  jsonb;
  v_key      text;
  v_id       text;
  v_alias    text;
  v_desc     text := '';
  v_enabled  boolean := true;
  v_list     jsonb;
  v_trig     jsonb;
  v_tpath    text;
  v_dpath    text;
  v_devs     jsonb;
  v_dev      jsonb;
  v_dev_id   text;
  v_dev_ids  text[];
  v_dev_count integer;
  v_visited  integer := 0;
  v_metric   text;
  v_metric_ok boolean;
  v_cmp      text;
  v_val      jsonb;
  v_num      numeric;
  v_threshold double precision;
  v_hold     integer;
  v_for      text;
  v_act      jsonb;
  v_ok       boolean;
BEGIN
  IF jsonb_typeof(p_doc) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_array(jsonb_build_object('index', NULL, 'key', NULL, 'reasons', jsonb_build_array(
      public.automation_reason('$', 'A file holds a list of automations. Start each one with `- id:`.')), 'canon', NULL));
  END IF;
  IF jsonb_array_length(p_doc) > c_max_automations THEN
    RETURN jsonb_build_array(jsonb_build_object('index', NULL, 'key', NULL, 'reasons', jsonb_build_array(
      public.automation_reason('$', format('A file holds at most %s automations. Split it.', c_max_automations))),
      'canon', NULL));
  END IF;

  FOR i IN 0 .. jsonb_array_length(p_doc) - 1 LOOP
    v_auto := p_doc -> i;
    v_apath := format('$[%s]', i);
    v_reasons := '[]'::jsonb;
    v_rows := '[]'::jsonb;
    v_actions := '[]'::jsonb;
    v_id := NULL;
    v_alias := NULL;
    v_desc := '';
    v_enabled := true;

    IF jsonb_typeof(v_auto) IS DISTINCT FROM 'object' THEN
      v_out := v_out || jsonb_build_object('index', i, 'key', NULL, 'canon', NULL, 'reasons', jsonb_build_array(
        public.automation_reason(v_apath, 'An automation is a set of keys: id, alias, triggers and actions at least.')));
      CONTINUE;
    END IF;

    -- A key nothing here means is refused, never ignored.
    FOR v_key IN SELECT jsonb_object_keys(v_auto) LOOP
      IF NOT v_key = ANY (ARRAY['id', 'alias', 'description', 'enabled', 'triggers', 'conditions', 'actions']) THEN
        v_reasons := v_reasons || public.automation_reason(public.automation_path(v_apath, v_key), format(
          '`%s` is not a key an automation takes. Remove it. The keys are id, alias, description, enabled, triggers, conditions and actions.', v_key));
      END IF;
    END LOOP;

    -- id
    v_val := v_auto -> 'id';
    IF v_val IS NULL OR jsonb_typeof(v_val) <> 'string' OR (v_val #>> '{}') !~ c_id THEN
      v_reasons := v_reasons || public.automation_reason(v_apath || '.id',
        '`id` is the automation''s fixed name: 1 to 64 lowercase letters, digits, hyphens or underscores, starting with a letter or a digit.');
    ELSE
      v_id := v_val #>> '{}';
      IF v_seen ? v_id THEN
        v_reasons := v_reasons || public.automation_reason(v_apath || '.id', format(
          '`%s` is already the id of the automation at %s. Give each automation its own id.', v_id, v_seen ->> v_id));
      ELSE
        v_seen := v_seen || jsonb_build_object(v_id, v_apath);
      END IF;
    END IF;

    -- alias
    v_val := v_auto -> 'alias';
    IF v_val IS NULL OR jsonb_typeof(v_val) <> 'string'
       OR char_length(v_val #>> '{}') NOT BETWEEN 1 AND 120
       OR (v_val #>> '{}') !~ '^\S' OR (v_val #>> '{}') !~ '\S$' OR (v_val #>> '{}') ~ '[[:cntrl:]]' THEN
      v_reasons := v_reasons || public.automation_reason(v_apath || '.alias',
        '`alias` is the name the list shows: 1 to 120 characters, with no space or control character at either end.');
    ELSE
      v_alias := v_val #>> '{}';
    END IF;

    -- description
    IF v_auto ? 'description' THEN
      v_val := v_auto -> 'description';
      IF jsonb_typeof(v_val) <> 'string' OR char_length(v_val #>> '{}') > 1000 THEN
        v_reasons := v_reasons || public.automation_reason(v_apath || '.description',
          '`description` is text of at most 1,000 characters.');
      ELSE
        v_desc := v_val #>> '{}';
      END IF;
    END IF;

    -- enabled
    IF v_auto ? 'enabled' THEN
      v_val := v_auto -> 'enabled';
      IF jsonb_typeof(v_val) <> 'boolean' THEN
        v_reasons := v_reasons || public.automation_reason(v_apath || '.enabled', '`enabled` is true or false.');
      ELSE
        v_enabled := (v_val #>> '{}')::boolean;
      END IF;
    END IF;

    -- conditions: none exist yet, so only an absent or empty list is accepted.
    IF v_auto ? 'conditions' THEN
      v_val := v_auto -> 'conditions';
      v_ok := CASE WHEN jsonb_typeof(v_val) = 'array' THEN jsonb_array_length(v_val) > 0 ELSE true END;
      IF v_ok THEN
        v_reasons := v_reasons || public.automation_reason(v_apath || '.conditions',
          'This release has no condition types. Remove `conditions`, or leave it empty.');
      END IF;
    END IF;

    -- triggers
    v_list := v_auto -> 'triggers';
    IF v_list IS NULL OR jsonb_typeof(v_list) <> 'array' THEN
      v_reasons := v_reasons || public.automation_reason(v_apath || '.triggers',
        '`triggers` is the list of what starts the automation. Give a list, with at least one trigger unless `enabled` is false.');
    ELSIF jsonb_array_length(v_list) > c_max_triggers THEN
      v_reasons := v_reasons || public.automation_reason(v_apath || '.triggers',
        format('An automation takes at most %s triggers.', c_max_triggers));
    ELSE
      IF jsonb_array_length(v_list) = 0 AND v_enabled THEN
        v_reasons := v_reasons || public.automation_reason(v_apath || '.triggers',
          'An enabled automation needs a trigger. Add one, or set `enabled: false`.');
      END IF;
      FOR j IN 0 .. jsonb_array_length(v_list) - 1 LOOP
        v_trig := v_list -> j;
        v_tpath := format('%s.triggers[%s]', v_apath, j);
        IF jsonb_typeof(v_trig) <> 'object' THEN
          v_reasons := v_reasons || public.automation_reason(v_tpath,
            'A trigger is a set of keys: trigger, device, metric and above or below.');
          CONTINUE;
        END IF;

        FOR v_key IN SELECT jsonb_object_keys(v_trig) LOOP
          IF NOT v_key = ANY (ARRAY['trigger', 'device', 'metric', 'above', 'below', 'for']) THEN
            v_reasons := v_reasons || public.automation_reason(public.automation_path(v_tpath, v_key), format(
              '`%s` is not a key a threshold trigger takes. Remove it. The keys are trigger, device, metric, above, below and for.', v_key));
          END IF;
        END LOOP;

        -- trigger: the type
        v_val := v_trig -> 'trigger';
        IF v_val IS NULL OR jsonb_typeof(v_val) <> 'string' OR (v_val #>> '{}') <> 'threshold' THEN
          v_reasons := v_reasons || public.automation_reason(v_tpath || '.trigger',
            '`trigger` names the type. This release has `threshold`.');
        END IF;

        -- metric: a measured one, in the catalogue, and a number
        v_metric := NULL;
        v_val := v_trig -> 'metric';
        IF v_val IS NULL OR jsonb_typeof(v_val) <> 'string' THEN
          v_reasons := v_reasons || public.automation_reason(v_tpath || '.metric',
            '`metric` is the catalogue name of the reading, such as Spindle/LOAD.');
        ELSE
          v_metric := v_val #>> '{}';
          -- A derived metric is not accepted yet: its check goes here when derived metrics are a catalogue row.
          SELECT m.datatype BETWEEN 1 AND 10 INTO v_metric_ok FROM public.metric_catalog m WHERE m.name = v_metric;
          IF v_metric_ok IS NULL THEN
            v_reasons := v_reasons || public.automation_reason(v_tpath || '.metric', format(
              '`%s` is not in the metric catalogue. Register it on the Metrics page first.', v_metric));
            v_metric := NULL;
          ELSIF NOT v_metric_ok THEN
            v_reasons := v_reasons || public.automation_reason(v_tpath || '.metric', format(
              '`%s` is not a number, so it has no threshold to compare with. Use a numeric metric.', v_metric));
            v_metric := NULL;
          END IF;
        END IF;

        -- above or below: exactly one, a number
        v_cmp := NULL;
        v_threshold := NULL;
        IF (v_trig ? 'above') AND (v_trig ? 'below') THEN
          v_reasons := v_reasons || public.automation_reason(v_tpath, 'Give `above` or `below`, not both.');
        ELSIF NOT (v_trig ? 'above') AND NOT (v_trig ? 'below') THEN
          v_reasons := v_reasons || public.automation_reason(v_tpath, 'A threshold trigger needs `above` or `below`.');
        ELSE
          v_cmp := CASE WHEN v_trig ? 'above' THEN 'above' ELSE 'below' END;
          v_val := v_trig -> v_cmp;
          v_ok := false;
          IF jsonb_typeof(v_val) = 'number' THEN
            v_num := (v_val #>> '{}')::numeric;
            IF abs(v_num) <= 1.7976931348623157e308::numeric THEN
              BEGIN
                v_threshold := v_num::double precision;
                v_ok := true;
              EXCEPTION WHEN numeric_value_out_of_range THEN
                v_ok := false;
              END;
            END IF;
          END IF;
          IF NOT v_ok THEN
            v_reasons := v_reasons || public.automation_reason(v_tpath || '.' || v_cmp,
              format('`%s` is a number, with no unit: the value is in the metric''s catalogue unit.', v_cmp));
            v_cmp := NULL;
          END IF;
        END IF;

        -- for: how long it must hold, 30s, 5m or 1h
        v_hold := 0;
        IF v_trig ? 'for' THEN
          v_val := v_trig -> 'for';
          IF jsonb_typeof(v_val) <> 'string' OR (v_val #>> '{}') !~ c_for THEN
            v_reasons := v_reasons || public.automation_reason(v_tpath || '.for',
              '`for` is how long it must hold before it fires: a whole number and s, m or h, such as 30s, 5m or 1h, up to 999 of one unit.');
            v_hold := NULL;
          ELSE
            v_for := v_val #>> '{}';
            v_hold := substring(v_for FROM '^[0-9]+')::integer
                      * CASE right(v_for, 1) WHEN 's' THEN 1 WHEN 'm' THEN 60 ELSE 3600 END;
          END IF;
        END IF;

        -- device: one id or a list, each a device that exists and is not archived
        v_devs := NULL;
        v_val := v_trig -> 'device';
        v_dpath := v_tpath || '.device';
        v_dev_count := CASE WHEN jsonb_typeof(v_val) = 'array' THEN jsonb_array_length(v_val) ELSE 0 END;
        IF v_val IS NULL THEN
          v_reasons := v_reasons || public.automation_reason(v_dpath,
            '`device` is the id of the device to watch, or a list of ids. Copy them from the Devices page.');
        ELSIF jsonb_typeof(v_val) = 'string' THEN
          v_devs := jsonb_build_array(v_val);
        ELSIF jsonb_typeof(v_val) = 'array' AND v_dev_count BETWEEN 1 AND c_max_devices THEN
          v_devs := v_val;
        ELSE
          v_reasons := v_reasons || public.automation_reason(v_dpath, format(
            '`device` is a device id, or a list of 1 to %s of them.', c_max_devices));
        END IF;
        IF v_devs IS NOT NULL THEN
          v_dev_ids := ARRAY[]::text[];
          FOR k IN 0 .. jsonb_array_length(v_devs) - 1 LOOP
            -- Every device of every trigger is a row to check, so the whole file is bounded.
            v_visited := v_visited + 1;
            IF v_visited > c_max_rows THEN
              RETURN jsonb_build_array(jsonb_build_object('index', NULL, 'key', NULL, 'reasons', jsonb_build_array(
                public.automation_reason('$', format('A file holds at most %s devices across its triggers. Split it.', c_max_rows))),
                'canon', NULL));
            END IF;
            v_dev := v_devs -> k;
            IF jsonb_typeof(v_val) = 'array' THEN v_dpath := format('%s.device[%s]', v_tpath, k); END IF;
            v_dev_id := NULL;
            IF jsonb_typeof(v_dev) <> 'string' OR (v_dev #>> '{}') !~ c_uuid THEN
              v_reasons := v_reasons || public.automation_reason(v_dpath,
                'A device is named by its id: a lowercase uuid, as the Devices page shows it.');
            ELSIF (v_dev #>> '{}') = ANY (v_dev_ids) THEN
              v_reasons := v_reasons || public.automation_reason(v_dpath, 'This device is listed twice.');
            ELSE
              v_dev_id := v_dev #>> '{}';
              v_dev_ids := v_dev_ids || v_dev_id;
              SELECT NOT coalesce(d.is_archived, false) INTO v_ok FROM public.devices d WHERE d.id = v_dev_id::uuid;
              IF v_ok IS NULL THEN
                v_reasons := v_reasons || public.automation_reason(v_dpath, format(
                  'No device has the id %s. Copy an id from the Devices page.', v_dev_id));
                v_dev_id := NULL;
              ELSIF NOT v_ok THEN
                v_reasons := v_reasons || public.automation_reason(v_dpath, format(
                  'Device %s is archived. Restore it, or name another device.', v_dev_id));
                v_dev_id := NULL;
              END IF;
            END IF;
            IF v_dev_id IS NOT NULL AND v_metric IS NOT NULL AND v_cmp IS NOT NULL AND v_hold IS NOT NULL THEN
              v_rows := v_rows || jsonb_build_object(
                'position', j, 'device_position', k, 'kind', 'threshold', 'entity_id', v_dev_id,
                'metric_name', v_metric, 'comparison', v_cmp, 'threshold', to_jsonb(v_threshold),
                'hold_seconds', v_hold);
            END IF;
          END LOOP;
        END IF;
      END LOOP;
    END IF;

    -- actions: one `alert`
    v_list := v_auto -> 'actions';
    IF v_list IS NULL OR jsonb_typeof(v_list) <> 'array' THEN
      v_reasons := v_reasons || public.automation_reason(v_apath || '.actions',
        '`actions` is what the automation does. Give a list with one `alert`.');
    ELSIF jsonb_array_length(v_list) <> 1 THEN
      v_reasons := v_reasons || public.automation_reason(v_apath || '.actions',
        'An automation takes exactly one action in this release: an `alert`.');
    ELSE
      v_act := v_list -> 0;
      v_tpath := v_apath || '.actions[0]';
      IF jsonb_typeof(v_act) <> 'object' THEN
        v_reasons := v_reasons || public.automation_reason(v_tpath, 'An action is a set of keys: action and severity.');
      ELSE
        FOR v_key IN SELECT jsonb_object_keys(v_act) LOOP
          IF NOT v_key = ANY (ARRAY['action', 'severity']) THEN
            v_reasons := v_reasons || public.automation_reason(public.automation_path(v_tpath, v_key), format(
              '`%s` is not a key an alert action takes. Remove it. The keys are action and severity.', v_key));
          END IF;
        END LOOP;
        v_val := v_act -> 'action';
        IF v_val IS NULL OR jsonb_typeof(v_val) <> 'string' OR (v_val #>> '{}') <> 'alert' THEN
          v_reasons := v_reasons || public.automation_reason(v_tpath || '.action',
            '`action` names the type. This release has `alert`.');
        END IF;
        v_val := v_act -> 'severity';
        IF v_val IS NULL OR jsonb_typeof(v_val) <> 'string'
           OR NOT (v_val #>> '{}') = ANY (ARRAY['critical', 'warning', 'info']) THEN
          v_reasons := v_reasons || public.automation_reason(v_tpath || '.severity',
            '`severity` is critical, warning or info.');
        ELSE
          v_actions := jsonb_build_array(jsonb_build_object('position', 0, 'kind', 'alert', 'severity', v_val #>> '{}'));
        END IF;
      END IF;
    END IF;

    v_out := v_out || jsonb_build_object(
      'index', i, 'key', v_id, 'reasons', v_reasons,
      'canon', CASE WHEN jsonb_array_length(v_reasons) = 0 THEN
                 jsonb_build_object('key', v_id, 'alias', v_alias, 'description', v_desc, 'enabled', v_enabled,
                                    'rows', v_rows, 'actions', v_actions)
               END);
  END LOOP;
  RETURN v_out;
END
$$;

ALTER FUNCTION public.automations_parse(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.automations_parse(jsonb) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.automations_parse(jsonb) IS
  'Checks a document of automations and writes nothing: for each, {index, key, reasons, canon}. '
  'canon is the automation as it would be stored, typed and with its defaults explicit, and null '
  'when there is any reason to refuse it. Every reason is collected, each with a JSON path. '
  'Refuses a key it does not know, a metric that is not a number in the catalogue, a device that '
  'is not there or is archived, and anything but one `threshold` trigger type and one `alert` '
  'action. Called by apply_automations() (0256).';

-- -------------------------------------------------------------------------------------------------
-- 4. The Audit Trail row of an act
-- -------------------------------------------------------------------------------------------------
-- One row per automation per act, in the asset lane: who did it, and the automation as the document
-- writes it, before and after. `name` is the alias, so the trail labels the lane by it after the
-- automation is gone. A why is the sentence a lifecycle act records; a person's act has none. Each
-- action is written out, as the Audit Trail's map of kinds reads it.
CREATE OR REPLACE FUNCTION public.automation_audit_identity(p_automation_id uuid, p_document jsonb, p_why text) RETURNS jsonb
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT CASE WHEN p_document IS NULL THEN NULL ELSE
    p_document || jsonb_build_object('name', p_document ->> 'alias', 'automation_id', p_automation_id)
                || CASE WHEN p_why IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('reason', p_why) END
  END;
$$;

ALTER FUNCTION public.automation_audit_identity(uuid, jsonb, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.automation_audit_identity(uuid, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.automation_audit_identity(uuid, jsonb, text) IS
  'What an automation''s audit rows carry: the automation in the document''s shape, with name (its '
  'alias), automation_id and, for a lifecycle act, reason (0256).';

CREATE OR REPLACE FUNCTION public.file_automation_act(p_act text, p_automation_id uuid, p_old jsonb, p_new jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF p_act = 'created' THEN
    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'automations', p_automation_id, 'AUTOMATION_CREATED', p_old, p_new,
        v_uid, public.audit_actor_source(), txid_current(), now()
    );
  ELSIF p_act = 'changed' THEN
    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'automations', p_automation_id, 'AUTOMATION_CHANGED', p_old, p_new,
        v_uid, public.audit_actor_source(), txid_current(), now()
    );
  ELSIF p_act = 'enabled' THEN
    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'automations', p_automation_id, 'AUTOMATION_ENABLED', p_old, p_new,
        v_uid, public.audit_actor_source(), txid_current(), now()
    );
  ELSIF p_act = 'disabled' THEN
    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'automations', p_automation_id, 'AUTOMATION_DISABLED', p_old, p_new,
        v_uid, public.audit_actor_source(), txid_current(), now()
    );
  ELSIF p_act = 'deleted' THEN
    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'automations', p_automation_id, 'AUTOMATION_DELETED', p_old, p_new,
        v_uid, public.audit_actor_source(), txid_current(), now()
    );
  ELSE
    RAISE EXCEPTION 'file_automation_act(): there is no act %', p_act;
  END IF;
END
$$;

ALTER FUNCTION public.file_automation_act(text, uuid, jsonb, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.file_automation_act(text, uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.file_automation_act(text, uuid, jsonb, jsonb) IS
  'Writes the one Audit Trail row of an act on an automation: p_act is created, changed, enabled, '
  'disabled or deleted (AUTOMATION_CREATED, AUTOMATION_CHANGED, AUTOMATION_ENABLED, '
  'AUTOMATION_DISABLED, AUTOMATION_DELETED), in the asset lane under entity_type automations, with '
  'the snapshots it is given. Called by the writers here and by the lifecycle (0257); nobody else '
  'may execute it (0256).';

-- -------------------------------------------------------------------------------------------------
-- 5. Applying a document
-- -------------------------------------------------------------------------------------------------
-- An Administrator or a Shopfloor Manager, as a person: a machine identity holds no role and an
-- app's token is refused by has_role(). Every field is checked before anything is written, and one
-- refusal anywhere writes nothing, so a half-applied file cannot happen. An automation that exists
-- is found by its key and compared with what the document would make of it; an unchanged one is
-- left untouched and writes no Audit Trail row. A changed one keeps the trigger rows that still
-- name the same device and metric, so an alert already firing for them keeps its fingerprint.
CREATE OR REPLACE FUNCTION public.apply_automations(p_doc jsonb, p_dry_run boolean) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_parsed    jsonb;
  v_item      jsonb;
  v_canon     jsonb;
  v_new_doc   jsonb;
  v_old_doc   jsonb;
  v_existing  public.automations;
  v_work      jsonb := '[]'::jsonb;
  v_out       jsonb := '[]'::jsonb;
  v_status    text;
  v_changes   jsonb;
  v_id        uuid;
  v_refused   boolean := false;
  v_row       jsonb;
  v_used      uuid[];
  v_match     uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'Only a Shopfloor Manager or an Administrator may apply automations.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.require_mfa();
  IF p_dry_run IS NULL THEN
    RAISE EXCEPTION 'p_dry_run is true to preview and false to apply.' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_parsed := public.automations_parse(p_doc);

  -- What each would be, without writing.
  FOR v_item IN SELECT x FROM jsonb_array_elements(v_parsed) x LOOP
    v_canon := v_item -> 'canon';
    v_id := NULL;
    v_changes := '[]'::jsonb;
    v_new_doc := NULL;
    IF v_canon IS NULL OR jsonb_typeof(v_canon) = 'null' THEN
      v_status := 'refused';
      v_refused := true;
    ELSE
      v_new_doc := public.automation_document_of(
        v_canon ->> 'key', v_canon ->> 'alias', v_canon ->> 'description', (v_canon ->> 'enabled')::boolean,
        v_canon -> 'rows', v_canon -> 'actions');
      SELECT * INTO v_existing FROM public.automations WHERE key = v_canon ->> 'key';
      IF NOT FOUND THEN
        v_status := 'new';
      ELSE
        v_id := v_existing.id;
        v_old_doc := public.automation_stored_document(v_existing.id);
        IF v_old_doc = v_new_doc THEN
          v_status := 'unchanged';
        ELSE
          v_status := 'changed';
          SELECT coalesce(jsonb_agg(k ORDER BY k), '[]'::jsonb) INTO v_changes
            FROM (SELECT key AS k FROM jsonb_each(v_new_doc)
                   WHERE v_old_doc -> key IS DISTINCT FROM v_new_doc -> key) c;
        END IF;
      END IF;
    END IF;
    v_work := v_work || jsonb_build_object(
      'index', v_item -> 'index', 'key', v_item -> 'key', 'status', v_status, 'id', v_id,
      'changes', v_changes, 'reasons', v_item -> 'reasons', 'canon', v_canon, 'doc', v_new_doc);
  END LOOP;

  IF NOT p_dry_run AND NOT v_refused THEN
    FOR v_item IN SELECT x FROM jsonb_array_elements(v_work) x LOOP
      v_status := v_item ->> 'status';
      IF v_status NOT IN ('new', 'changed') THEN CONTINUE; END IF;
      v_canon := v_item -> 'canon';
      v_new_doc := v_item -> 'doc';

      IF v_status = 'new' THEN
        INSERT INTO public.automations (key, alias, description, enabled)
        VALUES (v_canon ->> 'key', v_canon ->> 'alias', v_canon ->> 'description', (v_canon ->> 'enabled')::boolean)
        RETURNING id INTO v_id;
        INSERT INTO public.automation_triggers (automation_id, "position", device_position, kind, entity_id,
                                                metric_name, comparison, threshold, hold_seconds)
        SELECT v_id, (r ->> 'position')::integer, (r ->> 'device_position')::integer, r ->> 'kind',
               (r ->> 'entity_id')::uuid, r ->> 'metric_name', r ->> 'comparison',
               (r ->> 'threshold')::double precision, (r ->> 'hold_seconds')::integer
          FROM jsonb_array_elements(v_canon -> 'rows') r;
        INSERT INTO public.automation_actions (automation_id, "position", kind, severity)
        SELECT v_id, (a ->> 'position')::integer, a ->> 'kind', a ->> 'severity'
          FROM jsonb_array_elements(v_canon -> 'actions') a;
        PERFORM public.file_automation_act('created', v_id, NULL,
          public.automation_audit_identity(v_id, v_new_doc, NULL));
      ELSE
        v_id := (v_item ->> 'id')::uuid;
        SELECT * INTO v_existing FROM public.automations WHERE id = v_id FOR UPDATE;
        v_old_doc := public.automation_stored_document(v_id);
        UPDATE public.automations
           SET alias = v_canon ->> 'alias', description = v_canon ->> 'description',
               enabled = (v_canon ->> 'enabled')::boolean, updated_at = now()
         WHERE id = v_id;

        -- A row that still names the same device and metric is kept, with the content it has now;
        -- the best match is the one whose content is already what the document says.
        v_used := ARRAY[]::uuid[];
        FOR v_row IN SELECT r FROM jsonb_array_elements(v_canon -> 'rows') r LOOP
          SELECT t.id INTO v_match
            FROM public.automation_triggers t
           WHERE t.automation_id = v_id AND NOT t.is_archived
             AND t.entity_id = (v_row ->> 'entity_id')::uuid AND t.metric_name = v_row ->> 'metric_name'
             AND t.id <> ALL (v_used)
           ORDER BY (t.comparison = v_row ->> 'comparison'
                     AND t.threshold = (v_row ->> 'threshold')::double precision
                     AND t.hold_seconds = (v_row ->> 'hold_seconds')::integer) DESC,
                    t.position, t.device_position, t.id
           LIMIT 1;
          IF v_match IS NULL THEN
            INSERT INTO public.automation_triggers (automation_id, "position", device_position, kind, entity_id,
                                                    metric_name, comparison, threshold, hold_seconds)
            VALUES (v_id, (v_row ->> 'position')::integer, (v_row ->> 'device_position')::integer,
                    v_row ->> 'kind', (v_row ->> 'entity_id')::uuid, v_row ->> 'metric_name',
                    v_row ->> 'comparison', (v_row ->> 'threshold')::double precision,
                    (v_row ->> 'hold_seconds')::integer)
            RETURNING id INTO v_match;
          ELSE
            UPDATE public.automation_triggers
               SET "position" = (v_row ->> 'position')::integer,
                   device_position = (v_row ->> 'device_position')::integer,
                   kind = v_row ->> 'kind', comparison = v_row ->> 'comparison',
                   threshold = (v_row ->> 'threshold')::double precision,
                   hold_seconds = (v_row ->> 'hold_seconds')::integer
             WHERE id = v_match;
          END IF;
          v_used := v_used || v_match;
        END LOOP;
        -- What the document no longer names goes, and takes its open alerts with it (0257).
        DELETE FROM public.automation_triggers
         WHERE automation_id = v_id AND NOT is_archived AND id <> ALL (v_used);

        DELETE FROM public.automation_actions WHERE automation_id = v_id;
        INSERT INTO public.automation_actions (automation_id, "position", kind, severity)
        SELECT v_id, (a ->> 'position')::integer, a ->> 'kind', a ->> 'severity'
          FROM jsonb_array_elements(v_canon -> 'actions') a;

        -- The act is named for what it changed: only the switch, or the automation.
        IF v_item -> 'changes' = '["enabled"]'::jsonb AND (v_canon ->> 'enabled')::boolean THEN
          PERFORM public.file_automation_act('enabled', v_id,
            public.automation_audit_identity(v_id, v_old_doc, NULL),
            public.automation_audit_identity(v_id, v_new_doc, NULL));
        ELSIF v_item -> 'changes' = '["enabled"]'::jsonb THEN
          PERFORM public.file_automation_act('disabled', v_id,
            public.automation_audit_identity(v_id, v_old_doc, NULL),
            public.automation_audit_identity(v_id, v_new_doc, NULL));
        ELSE
          PERFORM public.file_automation_act('changed', v_id,
            public.automation_audit_identity(v_id, v_old_doc, NULL),
            public.automation_audit_identity(v_id, v_new_doc, NULL));
        END IF;
      END IF;
      -- The id of a new automation, for the result.
      v_work := (SELECT jsonb_agg(CASE WHEN w -> 'index' = v_item -> 'index'
                                       THEN w || jsonb_build_object('id', v_id) ELSE w END ORDER BY ord)
                   FROM jsonb_array_elements(v_work) WITH ORDINALITY AS e(w, ord));
    END LOOP;
  END IF;

  SELECT coalesce(jsonb_agg(w - 'canon' - 'doc' ORDER BY ord), '[]'::jsonb) INTO v_out
    FROM jsonb_array_elements(v_work) WITH ORDINALITY AS e(w, ord);
  RETURN v_out;
END
$$;

ALTER FUNCTION public.apply_automations(jsonb, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.apply_automations(jsonb, boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.apply_automations(jsonb, boolean) TO authenticated;

COMMENT ON FUNCTION public.apply_automations(jsonb, boolean) IS
  'Checks a document of automations and applies it: a Shopfloor Manager or an Administrator (42501 '
  'otherwise). Answers one result per automation, {index, key, status, id, changes, reasons}: status '
  'new, changed, unchanged or refused, changes the document keys that differ, and for a refusal '
  'reasons, each {path, message} with a JSON path such as $[0].triggers[1].above. All or nothing: '
  'with any refusal, or with p_dry_run true, nothing is written, so a preview and an apply are one '
  'call. Never deletes: an automation the document leaves out is left alone. An automation is '
  'found by its key. A change writes one Audit Trail row; an unchanged automation writes none '
  '(0256).';

-- -------------------------------------------------------------------------------------------------
-- 6. Reading them back
-- -------------------------------------------------------------------------------------------------
-- {automations, devices}: the automations in the document's shape, all or the keys asked for in the
-- order of their keys, and for each device they name its current name and place, for the page to
-- write as a comment beside the id. The YAML keeps no comments, so the page writes them again on
-- every render. A device's place is its cell and its area, as the Devices page names it. SECURITY
-- INVOKER: every role reads the tables, and a device the caller may not read has no name here.
CREATE OR REPLACE FUNCTION public.automations_document(p_keys text[] DEFAULT NULL::text[]) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  WITH docs AS (
    SELECT a.key, public.automation_stored_document(a.id) AS doc
      FROM public.automations a
     WHERE p_keys IS NULL OR a.key = ANY (p_keys)
  ), named AS (
    SELECT DISTINCT d.dev AS device_id
      FROM docs,
           LATERAL jsonb_array_elements(docs.doc -> 'triggers') t,
           LATERAL (SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(t -> 'device') = 'array'
                                                          THEN t -> 'device' ELSE jsonb_build_array(t -> 'device') END)) d(dev)
  )
  SELECT jsonb_build_object(
    'automations', coalesce((SELECT jsonb_agg(doc ORDER BY key) FROM docs), '[]'::jsonb),
    'devices', coalesce((
      SELECT jsonb_object_agg(n.device_id, jsonb_build_object(
               'name', d.name,
               'place', CASE WHEN dl.location_source = 'site_wide' THEN 'Site-wide'
                             ELSE nullif(concat_ws(' · ', c.name, coalesce(ar.name, wide.name)), '') END))
        FROM named n
        JOIN public.devices d ON d.id = n.device_id::uuid
        LEFT JOIN public.device_locations dl ON dl.device_id = d.id
        LEFT JOIN public.cells c ON c.id = dl.effective_cell_id
        LEFT JOIN public.areas ar ON ar.id = c.area_id
        LEFT JOIN public.areas wide ON wide.id = dl.effective_area_id AND c.id IS NULL), '{}'::jsonb));
$$;

ALTER FUNCTION public.automations_document(text[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.automations_document(text[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.automations_document(text[]) TO authenticated;

COMMENT ON FUNCTION public.automations_document(text[]) IS
  'The automations in the document''s shape, as {automations, devices}: every automation, or the '
  'keys asked for, ordered by key, and for each device they name its name and place (cell and area, '
  'or Site-wide) for a comment beside the id. apply_automations() of the automations list reports '
  'every one unchanged. Trigger rows archived with their device are left out (0256).';

-- -------------------------------------------------------------------------------------------------
-- 7. The list's two acts
-- -------------------------------------------------------------------------------------------------
-- Turning one off resolves its open alerts, and turning one on needs a trigger that is live: both
-- through the triggers of 0257. Changing nothing writes nothing.
CREATE OR REPLACE FUNCTION public.set_automation_enabled(p_key text, p_enabled boolean) RETURNS public.automations
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_before public.automations;
  v_after  public.automations;
  v_old    jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'Only a Shopfloor Manager or an Administrator may enable or disable an automation.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.require_mfa();
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'p_enabled is true or false.' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_before FROM public.automations WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.raise_not_found(format('There is no automation %s.', coalesce(quote_literal(p_key), 'NULL')));
  END IF;
  IF v_before.enabled = p_enabled THEN
    RETURN v_before;
  END IF;
  IF p_enabled AND NOT EXISTS (SELECT 1 FROM public.automation_triggers t
                                WHERE t.automation_id = v_before.id AND NOT t.is_archived) THEN
    RAISE EXCEPTION 'This automation has no live trigger, so there is nothing to enable. Add a trigger first.'
      USING ERRCODE = 'check_violation';
  END IF;

  v_old := public.automation_stored_document(v_before.id);
  UPDATE public.automations SET enabled = p_enabled, updated_at = now()
   WHERE id = v_before.id RETURNING * INTO v_after;
  IF p_enabled THEN
    PERFORM public.file_automation_act('enabled', v_after.id,
      public.automation_audit_identity(v_after.id, v_old, NULL),
      public.automation_audit_identity(v_after.id, public.automation_stored_document(v_after.id), NULL));
  ELSE
    PERFORM public.file_automation_act('disabled', v_after.id,
      public.automation_audit_identity(v_after.id, v_old, NULL),
      public.automation_audit_identity(v_after.id, public.automation_stored_document(v_after.id), NULL));
  END IF;
  RETURN v_after;
END
$$;

ALTER FUNCTION public.set_automation_enabled(text, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_automation_enabled(text, boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.set_automation_enabled(text, boolean) TO authenticated;

COMMENT ON FUNCTION public.set_automation_enabled(text, boolean) IS
  'Enables or disables the automation with this key: a Shopfloor Manager or an Administrator (42501 '
  'otherwise), on an automation that exists (404). Enabling one with no live trigger is refused '
  '(23514). Turning one off resolves its open alerts. Writes one AUTOMATION_ENABLED or '
  'AUTOMATION_DISABLED row, or nothing when it is already so, and returns the automation (0256).';

CREATE OR REPLACE FUNCTION public.delete_automation(p_key text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_row  public.automations;
  v_doc  jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'Only a Shopfloor Manager or an Administrator may delete an automation.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.require_mfa();

  SELECT * INTO v_row FROM public.automations WHERE key = p_key FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.raise_not_found(format('There is no automation %s.', coalesce(quote_literal(p_key), 'NULL')));
  END IF;
  v_doc := public.automation_stored_document(v_row.id);
  -- Its triggers and actions go with it, and its open alerts are resolved first (0257).
  DELETE FROM public.automations WHERE id = v_row.id;
  PERFORM public.file_automation_act('deleted', v_row.id, public.automation_audit_identity(v_row.id, v_doc, NULL), NULL);
END
$$;

ALTER FUNCTION public.delete_automation(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delete_automation(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.delete_automation(text) TO authenticated;

COMMENT ON FUNCTION public.delete_automation(text) IS
  'Deletes the automation with this key, with its triggers and actions, and resolves its open '
  'alerts: a Shopfloor Manager or an Administrator (42501 otherwise), on one that exists (404). '
  'Writes one AUTOMATION_DELETED row holding the automation as it was (0256).';

-- -------------------------------------------------------------------------------------------------
-- 8. From a device to its automations
-- -------------------------------------------------------------------------------------------------
-- One row per reason an automation applies to the device. `named`: a live trigger names it.
-- `site-wide`: a trigger that names no device applies to every modelled device, one with a schema
-- attached. The reasons that a per-device override and a place condition add come with the rules
-- that have them. SECURITY INVOKER, for every role.
CREATE OR REPLACE FUNCTION public.automations_for_entity(p_entity_id uuid)
RETURNS TABLE (automation_id uuid, key text, alias text, enabled boolean, reason text)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT x.id, x.key, x.alias, x.enabled, x.reason
    FROM (
      SELECT DISTINCT a.id, a.key, a.alias, a.enabled, 'named'::text AS reason, 0 AS ord
        FROM public.automation_triggers t
        JOIN public.automations a ON a.id = t.automation_id
       WHERE t.entity_id = p_entity_id AND NOT t.is_archived
      UNION ALL
      SELECT DISTINCT a.id, a.key, a.alias, a.enabled, 'site-wide'::text, 1
        FROM public.automation_triggers t
        JOIN public.automations a ON a.id = t.automation_id
       WHERE t.entity_id IS NULL AND NOT t.is_archived
         AND EXISTS (SELECT 1 FROM public.devices d
                      WHERE d.id = p_entity_id AND NOT d.is_archived
                        AND EXISTS (SELECT 1 FROM public.device_submodels s WHERE s.device_id = d.id))
    ) x
   ORDER BY x.ord, x.alias, x.key;
$$;

ALTER FUNCTION public.automations_for_entity(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.automations_for_entity(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.automations_for_entity(uuid) TO authenticated;

COMMENT ON FUNCTION public.automations_for_entity(uuid) IS
  'The automations that apply to a device and why, one row per reason: `named` when a live trigger '
  'names it, `site-wide` when a trigger that names no device applies to every modelled device (one '
  'with a schema attached). Disabled automations are listed, with enabled false. The reasons a '
  'per-device override and a place condition give are added with the rules that have them (0256).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn  text;
  v_src text;
  v_out jsonb;
BEGIN
  -- Each writer is SECURITY DEFINER with a pinned path, asks for the second factor, and is for
  -- signed-in roles only.
  FOREACH v_fn IN ARRAY ARRAY['public.apply_automations(jsonb, boolean)', 'public.set_automation_enabled(text, boolean)',
                              'public.delete_automation(text)'] LOOP
    SELECT p.prosrc INTO v_src FROM pg_proc p
     WHERE p.oid = v_fn::regprocedure AND p.prosecdef AND p.proconfig = ARRAY['search_path=public'];
    IF v_src IS NULL THEN
      RAISE EXCEPTION '0256: % is not SECURITY DEFINER with search_path pinned to public', v_fn;
    END IF;
    IF position('PERFORM public.require_mfa();' IN v_src) = 0 THEN
      RAISE EXCEPTION '0256: % does not ask for the second factor', v_fn;
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY['public.apply_automations(jsonb, boolean)', 'public.set_automation_enabled(text, boolean)',
                              'public.delete_automation(text)', 'public.automations_document(text[])',
                              'public.automations_for_entity(uuid)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0256: % is not for signed-in roles alone', v_fn;
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY['public.automations_parse(jsonb)', 'public.file_automation_act(text, uuid, jsonb, jsonb)'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0256: a browser-facing role may execute %', v_fn;
    END IF;
  END LOOP;

  -- The checker answers a refusal with a path, and an empty list with nothing to refuse.
  v_out := public.automations_parse('{}'::jsonb);
  IF v_out -> 0 -> 'reasons' -> 0 ->> 'path' <> '$' THEN
    RAISE EXCEPTION '0256: automations_parse() does not refuse a document that is not a list';
  END IF;
  v_out := public.automations_parse('[{"mode": "single"}]'::jsonb);
  IF v_out -> 0 -> 'reasons' -> 0 ->> 'path' <> '$[0].mode' OR v_out -> 0 -> 'canon' <> 'null'::jsonb THEN
    RAISE EXCEPTION '0256: automations_parse() does not refuse a key it does not know';
  END IF;
  IF public.automations_parse('[]'::jsonb) <> '[]'::jsonb THEN
    RAISE EXCEPTION '0256: automations_parse() finds something in an empty list';
  END IF;
  IF public.automation_duration_text(3600) <> '1h' OR public.automation_duration_text(300) <> '5m'
     OR public.automation_duration_text(90) <> '90s' OR public.automation_duration_text(0) <> '0s' THEN
    RAISE EXCEPTION '0256: automation_duration_text() does not write 1h, 5m, 90s and 0s';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
