-- 0168: Every schema attached to a device counts, whichever path attached it.
--
-- A device's schemas are attached in two places: `device_submodels` rows, and `devices.schema_id`.
-- `device_schemas` read the column only for a device with no `device_submodels` row, so a device
-- given a second schema through the API stopped being judged against the first. The view now
-- returns both, one row per (device, schema). The Devices page writes `device_submodels` through
-- set_device_schemas() and clears the column; writing `devices.schema_id` is deprecated, and the
-- column is still read so an API client that sets it keeps working. `device_submodels` is audited
-- now, so moving the dashboard's writes there keeps a schema change in the audit trail.

-- -------------------------------------------------------------------------------------------------
-- The view: both arms, one row per (device, schema)
-- -------------------------------------------------------------------------------------------------
-- Same columns as 0001's, so CREATE OR REPLACE keeps the grants. The column arm is skipped only
-- when a `device_submodels` row names the same schema, so that row (and its submodel_key) wins.
CREATE OR REPLACE VIEW public.device_schemas WITH (security_invoker='true') AS
 SELECT ds.device_id,
    ds.schema_id,
    ds.submodel_key,
    'device_submodels'::text AS source
   FROM public.device_submodels ds
UNION
 SELECT d.id AS device_id,
    d.schema_id,
    NULL::text AS submodel_key,
    'devices.schema_id'::text AS source
   FROM public.devices d
  WHERE ((d.schema_id IS NOT NULL) AND (NOT (EXISTS ( SELECT 1
           FROM public.device_submodels ds
          WHERE ((ds.device_id = d.id) AND (ds.schema_id = d.schema_id))))));

COMMENT ON VIEW public.device_schemas IS 'Every schema attached to a device, one row per (device, schema): its device_submodels rows, and devices.schema_id when no row names that schema. `source` says which arm a row came from.';

COMMENT ON TABLE public.device_submodels IS 'A device''s schema attachments, one AAS Submodel each. The Devices page writes them through set_device_schemas(); device_schemas also reads the deprecated devices.schema_id.';

COMMENT ON COLUMN public.devices.schema_id IS 'Deprecated for writes: attach schemas as device_submodels rows (set_device_schemas()). Still read through device_schemas, so a client that sets it keeps working until the column is removed.';

-- -------------------------------------------------------------------------------------------------
-- reject_archived_schema_assignment(): moving a binding between the two arms is not a new binding
-- -------------------------------------------------------------------------------------------------
-- Unchanged from 0001 but for the device_schemas check before the status lookup. Without it,
-- set_device_schemas() could not move a device's archived devices.schema_id into device_submodels.
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
    -- One function, two tables: `devices.schema_id` and `device_submodels.schema_id` are the two
    -- arms of the `device_schemas` view, and a guard on one of them is not a guard.
    IF TG_TABLE_NAME = 'devices' THEN
        v_device_id := NEW.id;
        -- READ OFF `NEW`, NOT OUT OF THE TABLE. On INSERT the row is not visible to a query yet,
        -- so a lookup would report "not a shadow" for every shadow device at the moment it is
        -- created -- which is the only moment ensure_shadow_devices() writes this column.
        v_is_shadow := NEW.shadow_of IS NOT NULL;
    ELSE
        v_device_id := NEW.device_id;
        -- The submodel rows are written AFTER the shadow device exists, so here the lookup is both
        -- possible and necessary -- the join row carries no shadow marker of its own.
        SELECT d.shadow_of IS NOT NULL INTO v_is_shadow
          FROM public.devices d WHERE d.id = v_device_id;
    END IF;

    -- Detaching is always allowed. So is leaving the pointer exactly where it was: see the header
    -- for why the unchanged-value case is the one that keeps an unfinished migration editable.
    IF NEW.schema_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.schema_id IS NOT DISTINCT FROM OLD.schema_id THEN
        RETURN NEW;
    END IF;

    IF coalesce(v_is_shadow, false) THEN
        RETURN NEW;
    END IF;

    -- Already bound through the other arm: the device keeps the schema it has, so nothing new is
    -- assigned.
    IF EXISTS (SELECT 1 FROM public.device_schemas ds
                WHERE ds.device_id = v_device_id AND ds.schema_id = NEW.schema_id) THEN
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

COMMENT ON FUNCTION public.reject_archived_schema_assignment() IS 'Refuses a NEW binding of a device to an archived schema, on either arm of the device_schemas view. Leaving an existing binding in place is allowed -- an archived schema with devices still attached is an unfinished migration, not a fault -- and so is moving one from devices.schema_id to device_submodels or back. Shadow devices are exempt because they copy the contract of the device they replay.';

-- -------------------------------------------------------------------------------------------------
-- record_ingestion_rejection(): the snapshot names every schema the device is judged against
-- -------------------------------------------------------------------------------------------------
-- Unchanged from 0001 but for the schemas: `schema_ids` lists the device's device_schemas rows,
-- which is what ingestion judges a payload against, and `schema_id` keeps its key with the first
-- of them (devices.schema_id when that is set, as before).
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
    SELECT coalesce(jsonb_agg(ds.schema_id
                              ORDER BY ds.source = 'devices.schema_id' DESC, ds.schema_id),
                    '[]'::jsonb)
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
    -- an INSERT proposes, so re-inserting an existing archived binding would be refused. The
    -- inserts come before the column is cleared, so a schema moving from devices.schema_id is
    -- still bound when its row arrives.
    INSERT INTO public.device_submodels (device_id, schema_id)
    SELECT p_device_id, s
      FROM unnest(v_wanted) s
     WHERE NOT EXISTS (SELECT 1 FROM public.device_submodels ds
                        WHERE ds.device_id = p_device_id AND ds.schema_id = s);

    DELETE FROM public.device_submodels
     WHERE device_id = p_device_id
       AND NOT (schema_id = ANY (v_wanted));

    UPDATE public.devices SET schema_id = NULL
     WHERE id = p_device_id AND schema_id IS NOT NULL;

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

COMMENT ON FUNCTION public.set_device_schemas(p_device_id uuid, p_schema_ids uuid[]) IS 'Make a device''s schemas exactly p_schema_ids, in one transaction: inserts the missing device_submodels rows, deletes the rest, and clears the deprecated devices.schema_id. An empty array detaches every schema. Unknown device or schema: 404. Authority: Administrator or Shopfloor_Manager.';

-- -------------------------------------------------------------------------------------------------
-- A device's schema attachments reach the audit trail
-- -------------------------------------------------------------------------------------------------
-- The Devices page used to change a device's schema through devices.schema_id, which the devices
-- trigger records. It now writes device_submodels, so that table is audited too, keyed by its
-- device as device_nameplate is, and filed in the asset lane.
DROP TRIGGER IF EXISTS trg_device_submodels_audit_trail ON public.device_submodels;
CREATE TRIGGER trg_device_submodels_audit_trail AFTER INSERT OR DELETE OR UPDATE ON public.device_submodels FOR EACH ROW EXECUTE FUNCTION public.log_audit_trail_event('device_id');

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
-- Unchanged from 0001 but for `device_submodels` in the purge probe, beside `device_nameplate`: its
-- rows are keyed by the device's id, so a deleted device's schema attachments are hidden and counted
-- with it rather than drawn as a lane of their own.
CREATE OR REPLACE FUNCTION public.audit_trail_page(p_limit integer DEFAULT 200, p_include_purged boolean DEFAULT false, p_entity_type text DEFAULT NULL::text, p_action text DEFAULT NULL::text, p_entity_ids uuid[] DEFAULT NULL::uuid[], p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_recorded_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id bigint DEFAULT NULL::bigint, p_search text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $_$
WITH term AS (
    SELECT CASE WHEN p_search IS NULL OR btrim(p_search) = '' THEN NULL ELSE btrim(p_search) END AS raw
),
pattern AS (
    -- The search as a LIKE pattern, built once. THE METACHARACTERS ARE ESCAPED: the box promises
    -- a substring of a name or an id, and an unescaped '%' would silently return the whole trail
    -- to somebody who typed a percentage into it. Backslash is the default LIKE escape, so the
    -- backslashes have to be doubled first or an escape would be introduced by the escaping.
    SELECT CASE
             WHEN t.raw IS NULL THEN NULL
             ELSE '%' || replace(replace(replace(t.raw, '\', '\\'), '%', '\%'), '_', '\_') || '%'
           END AS pattern,
           -- THE SAME TERM AS A ROW ID, when it is nothing but digits. 18 at most: bigint tops out
           -- at 19, and a cast that overflows raises rather than missing.
           CASE
             WHEN t.raw ~ '^[0-9]{1,18}$' THEN t.raw::bigint
             ELSE NULL
           END AS id_term
      FROM term t
),
-- MATERIALIZED, AND MEASURED. Without it Postgres inlines this CTE and the helper lands in the
-- per-row Filter of every partition scan -- a STABLE function is allowed to be called once and is
-- not promised to be. On 4,065 rows that took a search from 53ms to 583ms, which is the shape of
-- cost that looks like "the trail got big" rather than like a query doing the wrong thing.
q AS MATERIALIZED (
    SELECT p.pattern,
           p.id_term,
           public.audit_trail_user_ids_matching(p.pattern)        AS user_ids,
           public.audit_trail_backup_job_ids_matching(p.pattern)  AS job_ids
      FROM pattern p
),
matching AS (
    SELECT t.*,
           -- SEVEN TYPES, FIVE PROBES, and the mismatch is `device_nameplate` and `device_submodels`:
           -- both are keyed by their device's id, so `devices` answers for them. A type is listed
           -- here only if one of the probes below can be asked about its rows -- `user_roles` and
           -- `service_principals` are auth.users rows with no public table to read, and would
           -- otherwise answer "absent from all five" about a person who is perfectly present. An
           -- entity type whose table has been RETIRED is a third case this still does not answer:
           -- "the table is gone" is not "the row is gone", so `area_floors` remains drawn and
           -- cannot be hidden.
           t.entity_type IN ('areas', 'cells', 'gateways', 'devices', 'schemas', 'device_nameplate',
                             'device_submodels')
       AND NOT EXISTS (SELECT 1 FROM public.areas    a WHERE a.id = t.entity_id)
       AND NOT EXISTS (SELECT 1 FROM public.cells    c WHERE c.id = t.entity_id)
       AND NOT EXISTS (SELECT 1 FROM public.gateways g WHERE g.id = t.entity_id)
       AND NOT EXISTS (SELECT 1 FROM public.devices  d WHERE d.id = t.entity_id)
       AND NOT EXISTS (SELECT 1 FROM public.schemas  s WHERE s.id = t.entity_id)
               AS is_purged
      FROM public.audit_trail t
     CROSS JOIN q
     WHERE (p_entity_type IS NULL OR t.entity_type = p_entity_type)
       AND (p_action      IS NULL OR t.action      = p_action)
       AND (p_entity_ids  IS NULL OR t.entity_id   = ANY (p_entity_ids))
       AND (p_since       IS NULL OR t.recorded_at >= p_since)
       AND (p_until       IS NULL OR t.recorded_at <= p_until)
       -- THE ID AND THE NAME THE TIMELINE DRAWS. Both snapshots are read because an INSERT has
       -- only `new_data` and a DELETE only `old_data`, and an UPDATE that renames something is
       -- findable under either name, which is what somebody searching for the old one wants.
       AND (q.pattern IS NULL
            OR t.entity_id::text ILIKE q.pattern
            -- THE OTHER TWO IDS THE DRAWER SHOWS: this audit row, and the transaction that wrote
            -- it. Only when the term is nothing but digits, so this adds rows to a numeric search
            -- and changes no other one.
            OR (q.id_term IS NOT NULL
                AND (t.id = q.id_term OR t.causation_id = q.id_term))
            -- The person a role assignment is about, who is not in the payload. Empty for a caller
            -- who may not ask, which matches no row.
            OR t.entity_id = ANY (q.user_ids)
            -- The note and the produced backup's stamp, which are on two tables and in no payload.
            -- Empty on the same terms, and for the same reason.
            OR t.entity_id = ANY (q.job_ids)
            OR EXISTS (
                 SELECT 1
                   FROM unnest(ARRAY['name', 'sparkplug_id', 'schema_name',
                                     'label', 'key', 'role', 'stamp', 'origin']) AS f(field)
                  WHERE (t.new_data ->> f.field) ILIKE q.pattern
                     OR (t.old_data ->> f.field) ILIKE q.pattern
               ))
),
visible AS (
    SELECT * FROM matching
     WHERE (p_include_purged OR NOT is_purged)
       -- The cursor is applied here and not in `matching`: `purged_assets` and `total_matching` are
       -- counted over `matching` and are facts about everything the filters select, not about what
       -- is left after paging.
       AND (p_before_id IS NULL
            OR p_before_recorded_at IS NULL
            OR (recorded_at, id) < (p_before_recorded_at, p_before_id))
     ORDER BY recorded_at DESC, id DESC
     LIMIT greatest(1, least(coalesce(p_limit, 200), 1000))
)
SELECT jsonb_build_object(
    'events', coalesce(
        (SELECT jsonb_agg(
                  (to_jsonb(v) - 'is_purged')
                  -- HOW MANY ROWS THE TRANSACTION WROTE (0139), over the whole table and not the
                  -- page, so the drawer can tell a single-row act from a group whose other rows
                  -- the filters hide or a later page holds. One probe of
                  -- idx_audit_trail_causation per row on the page. Under the caller's own
                  -- policies, like the rows themselves: it is the number a reader could load.
                  -- Null where there is no causation: NULL is not a group, and counting it would
                  -- make every legacy row one act.
                  || jsonb_build_object('transaction_rows',
                       CASE WHEN v.causation_id IS NULL THEN NULL
                            ELSE (SELECT count(*) FROM public.audit_trail d
                                   WHERE d.causation_id = v.causation_id)
                       END)
                  ORDER BY v.recorded_at DESC, v.id DESC)
           FROM visible v),
        '[]'::jsonb),
    'purged_assets', (SELECT count(DISTINCT entity_id) FROM matching WHERE is_purged),
    -- HOW LONG THE TRAIL IS UNDER THESE FILTERS, so a reader holding one page knows what fraction
    -- of it that is. Counted under the SAME predicate `visible` opens with, minus the cursor and
    -- the limit -- so it does not move as the reader pages, and a page can never report more rows
    -- than the total it is a fraction of.
    'total_matching', (SELECT count(*) FROM matching WHERE p_include_purged OR NOT is_purged),
    -- KEPT, AND IT MEANS "THERE IS A NEXT PAGE". It used to mean "your view is cut off", which was
    -- the same thing when there was no way to ask for more. Callers that only ever showed a banner
    -- keep working unchanged.
    'truncated', (SELECT count(*) FROM visible) >= greatest(1, least(coalesce(p_limit, 200), 1000)),
    -- WHERE THE READER GOT TO, or null at the end of the trail. Null is the ONLY end-of-data
    -- signal a caller should trust: an empty `events` array with a non-null cursor cannot happen,
    -- but a full page that happens to be the last one is ordinary, so "fewer rows than I asked
    -- for" is not a reliable test and callers must not invent one.
    'next_cursor', CASE
        WHEN (SELECT count(*) FROM visible) >= greatest(1, least(coalesce(p_limit, 200), 1000))
        THEN (SELECT jsonb_build_object('recorded_at', v.recorded_at, 'id', v.id)
                FROM visible v ORDER BY v.recorded_at ASC, v.id ASC LIMIT 1)
        ELSE NULL
    END
);
$_$;

ALTER FUNCTION public.audit_trail_page(p_limit integer, p_include_purged boolean, p_entity_type text, p_action text, p_entity_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone, p_before_recorded_at timestamp with time zone, p_before_id bigint, p_search text) OWNER TO postgres;

COMMENT ON FUNCTION public.audit_trail_page(p_limit integer, p_include_purged boolean, p_entity_type text, p_action text, p_entity_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone, p_before_recorded_at timestamp with time zone, p_before_id bigint, p_search text) IS 'One page of the Audit Trail, with deleted entities filtered server-side and counted over the whole match rather than the page. `total_matching` is how many rows the filters select in total, under the same purged rule as the page, so a reader knows what fraction of the trail they hold. Keyset paged on (recorded_at DESC, id DESC): pass the previous response''s `next_cursor` back as p_before_recorded_at/p_before_id. A null next_cursor is the only end-of-data signal. `p_search` matches the entity id and the audit-snapshot fields the timeline labels a lane from, so an entity is findable by the name the page shows for it; LIKE metacharacters in it are literal. A term of 1 to 18 digits ALSO matches the audit row''s own id and its causation_id (0121), which is how the other two ids the event drawer shows are searchable; it is an additional disjunct, so a numeric name still matches by name. `transaction_rows` on each event is how many rows share its causation_id, counted over the whole table under the caller''s own policies rather than over the page, and null where there is no causation (0139). Two labels are not in any payload and are matched through a SECURITY DEFINER helper each: the person a role assignment is about (0115), and a backup job''s note and the stamp of the backup it produced (0118). `is_purged` applies to areas, cells, gateways, devices, schemas, device nameplates and device schema attachments -- every entity type this function can probe a table for. A type with no readable table behind it (user_roles and service_principals, which are auth.users rows; area_floors, whose table was retired) is never called deleted. `purged_assets` keeps its wire name and counts all of them.';
