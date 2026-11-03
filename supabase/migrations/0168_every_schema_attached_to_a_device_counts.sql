-- 0168: Every schema attached to a device counts, whichever path attached it.
--
-- A device's schemas were attached in two places: `device_submodels` rows, and `devices.schema_id`.
-- `device_schemas` read the column only for a device with no `device_submodels` row, so a device
-- given a second schema through the API stopped being judged against the first. The Devices page
-- writes `device_submodels` through set_device_schemas(), and `device_submodels` is audited now,
-- so a schema change stays in the audit trail. 0175 removed the column; the declarations below are
-- in their final form, so a replay never names it.

-- -------------------------------------------------------------------------------------------------
-- The view: one row per (device, schema)
-- -------------------------------------------------------------------------------------------------
-- Same columns as 0001's, so CREATE OR REPLACE keeps the grants. `source` is a constant, kept so a
-- client that selects it keeps working.
CREATE OR REPLACE VIEW public.device_schemas WITH (security_invoker='true') AS
 SELECT ds.device_id,
    ds.schema_id,
    ds.submodel_key,
    'device_submodels'::text AS source
   FROM public.device_submodels ds;

COMMENT ON VIEW public.device_schemas IS 'Every schema attached to a device, one row per (device, schema): its device_submodels rows. `source` is always ''device_submodels'', kept for clients that select it.';

COMMENT ON TABLE public.device_submodels IS 'A device''s schema attachments, one AAS Submodel each. The Devices page writes them through set_device_schemas().';

-- -------------------------------------------------------------------------------------------------
-- reject_archived_schema_assignment(): a guard on device_submodels
-- -------------------------------------------------------------------------------------------------
-- As 0001 declares it.
CREATE OR REPLACE FUNCTION public.reject_archived_schema_assignment() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
    v_device_id  uuid;
    v_is_shadow  boolean := false;
    v_status     text;
    v_name       text;
    v_version    integer;
    v_successor  text;
BEGIN
    -- `device_submodels` is the one place a device's schemas are attached; on any other table
    -- there is no binding to judge.
    IF TG_TABLE_NAME <> 'device_submodels' THEN
        RETURN NEW;
    END IF;
    v_device_id := NEW.device_id;
    -- The submodel rows are written AFTER the shadow device exists, so here the lookup is both
    -- possible and necessary -- the join row carries no shadow marker of its own.
    SELECT d.shadow_of IS NOT NULL INTO v_is_shadow
      FROM public.devices d WHERE d.id = v_device_id;

    -- Leaving the binding exactly where it was is allowed: the unchanged-value case is the one
    -- that keeps an unfinished migration editable.
    IF NEW.schema_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.schema_id IS NOT DISTINCT FROM OLD.schema_id THEN
        RETURN NEW;
    END IF;

    IF coalesce(v_is_shadow, false) THEN
        RETURN NEW;
    END IF;

    SELECT s.status::text, s.schema_name, s.version
      INTO v_status, v_name, v_version
      FROM public.schemas s
     WHERE s.id = NEW.schema_id;

    -- A schema_id naming nothing is left to the foreign key, which states that better than this
    -- trigger could. `IS DISTINCT FROM` rather than `<>` so a NULL status falls through here too.
    IF v_status IS DISTINCT FROM 'archived' THEN
        RETURN NEW;
    END IF;

    -- THE ERROR NAMES THE WAY OUT, because the operator reaching this is not doing something
    -- absurd -- they are looking at a version history and picked the wrong row. The successor is
    -- resolved here rather than left for them to find: it is one query, and "use v2 instead" is
    -- the entire remedy in most cases.
    SELECT s.schema_name INTO v_successor
      FROM public.schemas s
     WHERE s.parent_schema_id = NEW.schema_id
       AND s.status::text = 'active'
     ORDER BY s.version DESC
     LIMIT 1;

    RAISE EXCEPTION
        'schema "%" (v%) is archived and cannot be assigned to a device',
        v_name, v_version
        USING ERRCODE = 'check_violation',
              HINT = coalesce(
                  'Assign ' || v_successor || ', which replaced it.',
                  'This lineage has no active version. Publish one from the Schemas page, or leave '
                  'the device without a schema.'
              );
END;
$$;

ALTER FUNCTION public.reject_archived_schema_assignment() OWNER TO postgres;

COMMENT ON FUNCTION public.reject_archived_schema_assignment() IS 'Refuses a NEW device_submodels row binding a device to an archived schema. Leaving an existing binding in place is allowed -- an archived schema with devices still attached is an unfinished migration, not a fault -- and shadow devices are exempt because they copy the contract of the device they replay.';

-- -------------------------------------------------------------------------------------------------
-- record_ingestion_rejection(): the snapshot names every schema the device is judged against
-- -------------------------------------------------------------------------------------------------
-- Unchanged from 0001 but for the schemas: `schema_ids` lists the device's device_schemas rows,
-- which is what ingestion judges a payload against, and `schema_id` keeps its key with the first
-- of them.
CREATE OR REPLACE FUNCTION public.record_ingestion_rejection(p_device_id uuid, p_violations jsonb, p_observed_at timestamp with time zone DEFAULT now()) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_device     RECORD;
    v_schema_ids jsonb;
    v_count      INTEGER;
    v_id         BIGINT;
    -- A CAP, not a guess. The daemon already deduplicates per device, but a payload with a
    -- thousand unmodelled metrics would otherwise put a thousand objects into one jsonb column of
    -- an append-only table that cannot be pruned. Fifty names is far more than an operator will
    -- read and enough to diagnose any real fault; the total is recorded separately so the
    -- truncation is visible rather than silent.
    c_max_listed CONSTANT INTEGER := 50;
BEGIN
    -- The gate stated in the body: the grant below is to `authenticated`, and without this any
    -- signed-in user could forge SCHEMA_REJECTION rows into an append-only table. Same shape as the
    -- other `ingest_*` gates: granted broadly, gated on identity inside.
    PERFORM public.require_ingestion_caller('record_ingestion_rejection');

    IF p_device_id IS NULL THEN
        RAISE EXCEPTION 'record_ingestion_rejection: p_device_id is required'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    IF jsonb_typeof(p_violations) <> 'array' THEN
        RAISE EXCEPTION 'record_ingestion_rejection: p_violations must be a JSON array, got %',
            coalesce(jsonb_typeof(p_violations), 'null')
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    v_count := jsonb_array_length(p_violations);
    IF v_count = 0 THEN
        -- Nothing was refused, so there is nothing to record. Returning NULL rather than raising:
        -- the daemon computing an empty violation list is the ordinary healthy case, and a caller
        -- should not have to guard against its own success.
        RETURN NULL;
    END IF;

    -- FAIL ON AN UNKNOWN DEVICE rather than writing an audit row about an entity that does not
    -- exist. `entity_id` is a bare uuid with no foreign key -- deliberately, so history survives a
    -- purge -- which means nothing else would catch a typo'd id, and the row would sit in the
    -- trail forever describing nothing.
    SELECT id, name, sparkplug_id INTO v_device
      FROM public.devices WHERE id = p_device_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'record_ingestion_rejection: no device with id %', p_device_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- The schemas the daemon judges against, read as it reads them: through the view.
    SELECT coalesce(jsonb_agg(ds.schema_id ORDER BY ds.schema_id), '[]'::jsonb)
      INTO v_schema_ids
      FROM public.device_schemas ds
     WHERE ds.device_id = v_device.id;

    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'devices',
        v_device.id,
        'SCHEMA_REJECTION',
        NULL,
        jsonb_build_object(
            -- The identity as it was AT THE TIME. `name` is mutable and the device may later be
            -- renamed or purged; an audit row that could only be read by joining to a live row
            -- would lose its meaning in exactly the cases it matters most.
            'name',            v_device.name,
            'sparkplug_id',    v_device.sparkplug_id,
            'schema_id',       v_schema_ids -> 0,
            'schema_ids',      v_schema_ids,
            'observed_at',     p_observed_at,
            'violation_count', v_count,
            'violations',      CASE
                                 WHEN v_count <= c_max_listed THEN p_violations
                                 ELSE (
                                   SELECT jsonb_agg(value)
                                     FROM jsonb_array_elements(p_violations) WITH ORDINALITY t(value, n)
                                    WHERE n <= c_max_listed
                                 )
                               END,
            'truncated',       v_count > c_max_listed
        ),
        NULL,
        -- PINNED, not taken from a header. This function is the daemon's only route into the
        -- table, and what it records about the author is not negotiable by its caller.
        'ingestion',
        txid_current(),
        now()
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

ALTER FUNCTION public.record_ingestion_rejection(p_device_id uuid, p_violations jsonb, p_observed_at timestamp with time zone) OWNER TO postgres;

COMMENT ON FUNCTION public.record_ingestion_rejection(p_device_id uuid, p_violations jsonb, p_observed_at timestamp with time zone) IS 'Record a Sparkplug payload the ingestion daemon refused, as a SCHEMA_REJECTION row in audit_trail. The row names every schema the device is judged against (`schema_ids`, from device_schemas; `schema_id` is the first of them). The violation list is capped at 50 entries with the true count kept alongside. actor_source is pinned to ''ingestion'' and changed_by to NULL: this is the narrow gate that replaces service_role''s direct INSERT on the audit table. Callable only by the Service_Ingestor principal, which is what makes the grant to `authenticated` safe.';

-- -------------------------------------------------------------------------------------------------
-- set_device_schemas(): the Devices page's one writer of a device's schemas
-- -------------------------------------------------------------------------------------------------
-- One transaction, so a failed insert leaves the device's schemas as they were. SECURITY DEFINER,
-- as relocate_devices() is, so it can call raise_not_found(); RLS does not apply inside it.
CREATE OR REPLACE FUNCTION public.set_device_schemas(p_device_id uuid, p_schema_ids uuid[]) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_wanted  uuid[];
    v_before  uuid[];
    v_after   uuid[];
    v_unknown uuid;
BEGIN
    -- The only check there is: the role pair the devices and device_submodels write policies name.
    IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
        RAISE EXCEPTION 'insufficient privileges to change a device''s schemas'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF p_schema_ids IS NULL THEN
        RAISE EXCEPTION 'p_schema_ids is required; pass an empty array to detach every schema'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    SELECT coalesce(array_agg(DISTINCT s ORDER BY s), '{}')
      INTO v_wanted
      FROM unnest(p_schema_ids) s
     WHERE s IS NOT NULL;

    -- Locked so two saves of one device cannot interleave their inserts and deletes.
    PERFORM 1 FROM public.devices WHERE id = p_device_id FOR UPDATE;
    IF NOT FOUND THEN
        PERFORM public.raise_not_found(format('device %s not found', p_device_id));
    END IF;

    SELECT s INTO v_unknown
      FROM unnest(v_wanted) s
     WHERE NOT EXISTS (SELECT 1 FROM public.schemas sc WHERE sc.id = s)
     LIMIT 1;
    IF v_unknown IS NOT NULL THEN
        PERFORM public.raise_not_found(format('schema %s not found', v_unknown));
    END IF;

    SELECT coalesce(array_agg(ds.schema_id ORDER BY ds.schema_id), '{}')
      INTO v_before
      FROM public.device_schemas ds WHERE ds.device_id = p_device_id;

    -- Only the rows not already present: reject_archived_schema_assignment() fires on every row
    -- an INSERT proposes, so re-inserting an existing archived binding would be refused.
    INSERT INTO public.device_submodels (device_id, schema_id)
    SELECT p_device_id, s
      FROM unnest(v_wanted) s
     WHERE NOT EXISTS (SELECT 1 FROM public.device_submodels ds
                        WHERE ds.device_id = p_device_id AND ds.schema_id = s);

    DELETE FROM public.device_submodels
     WHERE device_id = p_device_id
       AND NOT (schema_id = ANY (v_wanted));

    SELECT coalesce(array_agg(ds.schema_id ORDER BY ds.schema_id), '{}')
      INTO v_after
      FROM public.device_schemas ds WHERE ds.device_id = p_device_id;

    RETURN jsonb_build_object(
        'device_id',  p_device_id,
        'schema_ids', to_jsonb(v_after),
        'attached',   (SELECT count(*) FROM unnest(v_after) s WHERE NOT (s = ANY (v_before))),
        'detached',   (SELECT count(*) FROM unnest(v_before) s WHERE NOT (s = ANY (v_after)))
    );
END;
$$;

ALTER FUNCTION public.set_device_schemas(p_device_id uuid, p_schema_ids uuid[]) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.set_device_schemas(p_device_id uuid, p_schema_ids uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_device_schemas(p_device_id uuid, p_schema_ids uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.set_device_schemas(p_device_id uuid, p_schema_ids uuid[]) IS 'Make a device''s schemas exactly p_schema_ids, in one transaction: inserts the missing device_submodels rows and deletes the rest. An empty array detaches every schema. Unknown device or schema: 404. Authority: Administrator or Shopfloor_Manager.';

-- -------------------------------------------------------------------------------------------------
-- A device's schema attachments reach the audit trail
-- -------------------------------------------------------------------------------------------------
-- The Devices page changes a device's schemas in device_submodels, so that table is audited, keyed
-- by its device as device_nameplate is, and filed in the asset lane.
SELECT public.replay_trigger('public.device_submodels', 'trg_device_submodels_audit_trail', $ddl$
CREATE TRIGGER trg_device_submodels_audit_trail AFTER INSERT OR DELETE OR UPDATE ON public.device_submodels FOR EACH ROW EXECUTE FUNCTION public.log_audit_trail_event('device_id');
$ddl$);

-- Unchanged from 0001 but for `device_submodels` in the asset list.
CREATE OR REPLACE FUNCTION public.audit_domain_for(p_entity_type text, p_action text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
    -- Identity and authority. Every act on these is Administrator-only to perform AND the table
    -- itself is Administrator-only to read, which is what makes the lane agree with its contents.
    WHEN p_entity_type IN ('service_principals', 'user_roles', 'system_settings')
      THEN 'security'

    -- The asset trail: the shopfloor's own history. CREDENTIAL_ISSUED lands here on `gateways`
    -- deliberately: a Manager may mint a host-run gateway's broker credential. `schemas` and
    -- `metric_catalog` are Administrator-only writes to tables every authenticated user reads.
    WHEN p_entity_type IN ('areas', 'cells', 'devices', 'gateways', 'links',
                           'schemas', 'device_nameplate', 'device_submodels', 'change_proposals',
                           'cell_links', 'gateway_links', 'device_links',
                           'metric_catalog')
      THEN 'asset'

    -- Fail-closed: a new entity_type nobody classified is restricted rather than exposed.
    ELSE 'security'
  END
$$;

ALTER FUNCTION public.audit_domain_for(p_entity_type text, p_action text) OWNER TO postgres;

-- -------------------------------------------------------------------------------------------------
-- audit_trail_page(): a deleted device's schema rows are deleted rows too
-- -------------------------------------------------------------------------------------------------
-- As 0001 declares it. A deleted device's schema rows are deleted rows too: the purged rule's kinds,
-- `device_submodels` beside `device_nameplate`, both keyed by their device's id, are
-- audit_trail_matching()'s (0228), so a deleted device's schema attachments are hidden and counted
-- with it rather than drawn as a lane of their own.
CREATE OR REPLACE FUNCTION public.audit_trail_page(p_limit integer DEFAULT 200, p_include_purged boolean DEFAULT false, p_entity_type text[] DEFAULT NULL::text[], p_action text[] DEFAULT NULL::text[], p_entity_ids uuid[] DEFAULT NULL::uuid[], p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_recorded_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id bigint DEFAULT NULL::bigint, p_search text DEFAULT NULL::text, p_changed_by uuid[] DEFAULT NULL::uuid[], p_class text[] DEFAULT NULL::text[], p_counts boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    SET plan_cache_mode TO 'force_custom_plan'
    AS $_$
-- PLANNED FOR EACH CALL, WITH ITS VALUES. force_custom_plan makes every argument a constant to the
-- planner, so a filter nobody chose folds away, a window prunes the months outside it, and a class
-- not asked for drops its branch. A generic plan keeps all of them, and reads every row.
--
-- THE CLASSES ARE READ FROM THEIR INDEXES. audit_trail_matching() (0228) returns one class's rows,
-- and each class has a partial index covering what the filters, the policies and the counts read.
-- So the counts are an index-only scan, and the page is the newest few of each class, merged.
DECLARE
  v_all       text[] := ARRAY['created', 'operational', 'configuration', 'lifecycle', 'read'];
  v_raw       text := nullif(btrim(p_search), '');
  v_pattern   text;
  v_id_term   bigint;
  -- Ids the search matches by something not in the row: a person, a backup job's note or stamp,
  -- and the backups a job took.
  v_also      uuid[] := '{}';
  -- Every entity the purged rule can find, so a row's test is one lookup.
  v_live      uuid[];
  v_limit     integer := greatest(1, least(coalesce(p_limit, 200), 1000));
  -- NULL or an empty list is no constraint.
  v_types     text[] := CASE WHEN cardinality(p_entity_type) > 0 THEN p_entity_type END;
  v_actions   text[] := CASE WHEN cardinality(p_action) > 0 THEN p_action END;
  v_people    uuid[] := CASE WHEN cardinality(p_changed_by) > 0 THEN p_changed_by END;
  v_classes   text[] := CASE WHEN cardinality(p_class) > 0 THEN p_class END;
  v_counts    boolean := coalesce(p_counts, false);
  v_since     timestamptz := coalesce(p_since, '-infinity');
  v_until     timestamptz := coalesce(p_until, 'infinity');
  -- Both halves of the cursor, or neither.
  v_before_at timestamptz := CASE WHEN p_before_id IS NOT NULL THEN p_before_recorded_at END;
  v_before_id bigint := CASE WHEN p_before_recorded_at IS NOT NULL THEN p_before_id END;
  -- The classes the page is drawn from, and the classes counted: all of them for the counts, which
  -- leave each filter's own choice out of its own figures.
  v_page      text[];
  v_scan      text[];
  v_scan_types   text[];
  v_scan_actions text[];
BEGIN
  IF v_raw IS NOT NULL THEN
    -- The search as a LIKE pattern. THE METACHARACTERS ARE ESCAPED: an unescaped '%' would return
    -- the whole trail to somebody who typed a percentage. Backslashes first, as LIKE's escape.
    v_pattern := '%' || replace(replace(replace(v_raw, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    -- The same term as a row id, when it is nothing but digits; 18 at most, so the cast cannot
    -- overflow.
    IF v_raw ~ '^[0-9]{1,18}$' THEN
      v_id_term := v_raw::bigint;
    END IF;
    v_also := public.audit_trail_user_ids_matching(v_pattern)
           || public.audit_trail_backup_job_ids_matching(v_pattern);
    -- A backup request's id also finds the backup it took: the Backup taken row records the job,
    -- and every later row of that backup is keyed by the backup's own id. Read from the trail,
    -- since a pruned backup's row is gone from `backups`.
    IF v_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_also := v_also || ARRAY(
        SELECT DISTINCT b.entity_id FROM public.audit_trail b
         WHERE b.entity_type = 'backups' AND b.action = 'BACKUP_TAKEN'
           AND b.new_data ->> 'job_id' = lower(v_raw));
    END IF;
  END IF;

  v_live := ARRAY(SELECT a.id FROM public.areas a UNION ALL SELECT c.id FROM public.cells c
                  UNION ALL SELECT g.id FROM public.gateways g UNION ALL SELECT d.id FROM public.devices d
                  UNION ALL SELECT s.id FROM public.schemas s);
  v_page := coalesce(v_classes, v_all);
  v_scan := CASE WHEN v_counts THEN v_all ELSE v_page END;
  v_scan_types := CASE WHEN v_counts THEN NULL ELSE v_types END;
  v_scan_actions := CASE WHEN v_counts THEN NULL ELSE v_actions END;

  RETURN (
    WITH counted AS (
      SELECT * FROM public.audit_trail_matching('created', v_scan_types, v_scan_actions, p_entity_ids, v_since, v_until, v_people, v_live, v_pattern, v_id_term, v_also, NULL, NULL) WHERE 'created' = ANY (v_scan)
      UNION ALL
      SELECT * FROM public.audit_trail_matching('operational', v_scan_types, v_scan_actions, p_entity_ids, v_since, v_until, v_people, v_live, v_pattern, v_id_term, v_also, NULL, NULL) WHERE 'operational' = ANY (v_scan)
      UNION ALL
      SELECT * FROM public.audit_trail_matching('configuration', v_scan_types, v_scan_actions, p_entity_ids, v_since, v_until, v_people, v_live, v_pattern, v_id_term, v_also, NULL, NULL) WHERE 'configuration' = ANY (v_scan)
      UNION ALL
      SELECT * FROM public.audit_trail_matching('lifecycle', v_scan_types, v_scan_actions, p_entity_ids, v_since, v_until, v_people, v_live, v_pattern, v_id_term, v_also, NULL, NULL) WHERE 'lifecycle' = ANY (v_scan)
      UNION ALL
      SELECT * FROM public.audit_trail_matching('read', v_scan_types, v_scan_actions, p_entity_ids, v_since, v_until, v_people, v_live, v_pattern, v_id_term, v_also, NULL, NULL) WHERE 'read' = ANY (v_scan)
    ),
    -- One row per class, kind and action, and per deleted entity, so the totals, the purged count
    -- and the counts are sums over a few hundred rows rather than over the trail.
    tally AS MATERIALIZED (
      SELECT r.class, r.entity_type, r.action, r.is_purged,
             CASE WHEN r.is_purged THEN r.entity_id END AS gone,
             count(*) AS n
        FROM counted r
       GROUP BY 1, 2, 3, 4, 5
    ),
    judged AS MATERIALIZED (
      SELECT g.*,
             (v_types   IS NULL OR g.entity_type = ANY (v_types))   AS by_type,
             (v_actions IS NULL OR g.action      = ANY (v_actions)) AS by_action,
             (v_classes IS NULL OR g.class       = ANY (v_classes)) AS by_class,
             (p_include_purged OR NOT g.is_purged) AS shown
        FROM tally g
    ),
    -- The newest of each class after the cursor, merged. A class with nothing to show is not read.
    page AS MATERIALIZED (
      SELECT c.id, c.recorded_at, c.class FROM (
        (SELECT m.id, m.recorded_at, m.class FROM public.audit_trail_matching('created', v_types, v_actions, p_entity_ids, v_since, v_until, v_people, v_live, v_pattern, v_id_term, v_also, v_before_at, v_before_id) m
          WHERE 'created' = ANY (v_page) AND (p_include_purged OR NOT m.is_purged)
            AND EXISTS (SELECT 1 FROM judged j WHERE j.class = 'created' AND j.shown AND j.by_type AND j.by_action)
          ORDER BY m.recorded_at DESC, m.id DESC LIMIT v_limit)
        UNION ALL
        (SELECT m.id, m.recorded_at, m.class FROM public.audit_trail_matching('operational', v_types, v_actions, p_entity_ids, v_since, v_until, v_people, v_live, v_pattern, v_id_term, v_also, v_before_at, v_before_id) m
          WHERE 'operational' = ANY (v_page) AND (p_include_purged OR NOT m.is_purged)
            AND EXISTS (SELECT 1 FROM judged j WHERE j.class = 'operational' AND j.shown AND j.by_type AND j.by_action)
          ORDER BY m.recorded_at DESC, m.id DESC LIMIT v_limit)
        UNION ALL
        (SELECT m.id, m.recorded_at, m.class FROM public.audit_trail_matching('configuration', v_types, v_actions, p_entity_ids, v_since, v_until, v_people, v_live, v_pattern, v_id_term, v_also, v_before_at, v_before_id) m
          WHERE 'configuration' = ANY (v_page) AND (p_include_purged OR NOT m.is_purged)
            AND EXISTS (SELECT 1 FROM judged j WHERE j.class = 'configuration' AND j.shown AND j.by_type AND j.by_action)
          ORDER BY m.recorded_at DESC, m.id DESC LIMIT v_limit)
        UNION ALL
        (SELECT m.id, m.recorded_at, m.class FROM public.audit_trail_matching('lifecycle', v_types, v_actions, p_entity_ids, v_since, v_until, v_people, v_live, v_pattern, v_id_term, v_also, v_before_at, v_before_id) m
          WHERE 'lifecycle' = ANY (v_page) AND (p_include_purged OR NOT m.is_purged)
            AND EXISTS (SELECT 1 FROM judged j WHERE j.class = 'lifecycle' AND j.shown AND j.by_type AND j.by_action)
          ORDER BY m.recorded_at DESC, m.id DESC LIMIT v_limit)
        UNION ALL
        (SELECT m.id, m.recorded_at, m.class FROM public.audit_trail_matching('read', v_types, v_actions, p_entity_ids, v_since, v_until, v_people, v_live, v_pattern, v_id_term, v_also, v_before_at, v_before_id) m
          WHERE 'read' = ANY (v_page) AND (p_include_purged OR NOT m.is_purged)
            AND EXISTS (SELECT 1 FROM judged j WHERE j.class = 'read' AND j.shown AND j.by_type AND j.by_action)
          ORDER BY m.recorded_at DESC, m.id DESC LIMIT v_limit)
      ) c
      ORDER BY c.recorded_at DESC, c.id DESC
      LIMIT v_limit
    )
    SELECT jsonb_build_object(
      'events', coalesce(
          (SELECT jsonb_agg(
                    to_jsonb(t)
                    || jsonb_build_object(
                         'class', p.class,
                         -- HOW MANY ROWS THE TRANSACTION WROTE (0139), over the whole table and not
                         -- the page, under the caller's own policies. Null where there is no
                         -- causation: NULL is not a group.
                         'transaction_rows',
                         CASE WHEN t.causation_id IS NULL THEN NULL
                              ELSE (SELECT count(*) FROM public.audit_trail d WHERE d.causation_id = t.causation_id)
                         END)
                    ORDER BY t.recorded_at DESC, t.id DESC)
             FROM page p
             JOIN public.audit_trail t ON t.id = p.id AND t.recorded_at = p.recorded_at),
          '[]'::jsonb),
      'purged_assets', (SELECT count(DISTINCT gone) FROM judged
                         WHERE is_purged AND by_type AND by_action AND by_class),
      -- HOW LONG THE TRAIL IS UNDER THESE FILTERS, without the cursor, so it does not move as the
      -- reader pages.
      'total_matching', (SELECT coalesce(sum(n), 0) FROM judged
                          WHERE shown AND by_type AND by_action AND by_class),
      -- THERE IS A NEXT PAGE. Null next_cursor is the only end-of-data signal.
      'truncated', (SELECT count(*) FROM page) >= v_limit,
      'next_cursor', CASE
          WHEN (SELECT count(*) FROM page) >= v_limit
          THEN (SELECT jsonb_build_object('recorded_at', p.recorded_at, 'id', p.id)
                  FROM page p ORDER BY p.recorded_at ASC, p.id ASC LIMIT 1)
      END,
      -- Each class's, kind's and action's events under every filter but its own, when asked for.
      'counts', CASE WHEN v_counts THEN jsonb_build_object(
          'class', (SELECT coalesce(jsonb_object_agg(x.class, x.n), '{}') FROM
                      (SELECT class, sum(n) AS n FROM judged WHERE shown AND by_type AND by_action
                        GROUP BY class) x),
          'entity_type', (SELECT coalesce(jsonb_object_agg(x.entity_type, x.n), '{}') FROM
                      (SELECT entity_type, sum(n) AS n FROM judged WHERE shown AND by_action AND by_class
                        GROUP BY entity_type) x),
          'action', (SELECT coalesce(jsonb_object_agg(x.action, x.n), '{}') FROM
                      (SELECT action, sum(n) AS n FROM judged WHERE shown AND by_type AND by_class
                        GROUP BY action) x))
      END
    )
  );
END
$_$;

ALTER FUNCTION public.audit_trail_page(p_limit integer, p_include_purged boolean, p_entity_type text[], p_action text[], p_entity_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone, p_before_recorded_at timestamp with time zone, p_before_id bigint, p_search text, p_changed_by uuid[], p_class text[], p_counts boolean) OWNER TO postgres;

COMMENT ON FUNCTION public.audit_trail_page(p_limit integer, p_include_purged boolean, p_entity_type text[], p_action text[], p_entity_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone, p_before_recorded_at timestamp with time zone, p_before_id bigint, p_search text, p_changed_by uuid[], p_class text[], p_counts boolean) IS 'One page of the Audit Trail, with deleted entities filtered server-side and counted over the whole match rather than the page. `total_matching` is how many rows the filters select in total, under the same purged rule as the page, so a reader knows what fraction of the trail they hold. Keyset paged on (recorded_at DESC, id DESC): pass the previous response''s `next_cursor` back as p_before_recorded_at/p_before_id. A null next_cursor is the only end-of-data signal. `p_search` matches the entity id and the audit-snapshot fields the timeline labels a lane from, so an entity is findable by the name the page shows for it; LIKE metacharacters in it are literal. A term of 1 to 18 digits ALSO matches the audit row''s own id and its causation_id (0121), which is how the other two ids the event drawer shows are searchable; it is an additional disjunct, so a numeric name still matches by name. A backup request''s id also matches the rows of the backup it took, found through its Backup taken row (0228). `p_entity_type`, `p_action`, `p_changed_by` and `p_class` are lists, each matched as any of its values, and the four are combined with AND: NULL or an empty list is no constraint, and a one-element list is the single value it holds (0227). `p_changed_by` keeps the rows whose changed_by is one of those people''s or machine identities'' ids, under the caller''s own policies (0222). `p_class` keeps the rows audit_event_class() puts in those classes, and each event carries its `class` (0228). With `p_counts`, `counts` gives each class, kind and action its events under every filter but its own. `transaction_rows` on each event is how many rows share its causation_id, counted over the whole table under the caller''s own policies rather than over the page, and null where there is no causation (0139). Two labels are not in any payload and are matched through a SECURITY DEFINER helper each: the person a role assignment is about (0115), and a backup job''s note and the stamp of the backup it produced (0118). `is_purged` applies to areas, cells, gateways, devices, schemas, device nameplates and device schema attachments -- every entity type this function can probe a table for. A type with no readable table behind it (user_roles and service_principals, which are auth.users rows; area_floors, whose table was retired) is never called deleted. `purged_assets` keeps its wire name and counts all of them.';
