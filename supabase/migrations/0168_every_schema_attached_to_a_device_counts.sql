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
