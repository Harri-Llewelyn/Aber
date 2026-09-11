-- 0097: the plant gains areas, and a site name.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- The hierarchy the Unified Namespace bridge publishes under is ISA-95's: enterprise, site, area,
-- work center, work unit. The stack had the two lowest as `cells` and `devices` and the enterprise
-- as the gateway's `sparkplug_group`. This adds the two between: the site as ONE setting rather
-- than a table (one campus; a second is the migration that makes it a table), and areas -- the
-- buildings -- as a table cells file into. A floor is a number on the cell, not a level: it groups
-- the map and names no topic segment.
--
-- A third location scope, `area_wide`, is a building's BMS: no single cell, one area. It requires
-- its area, and nothing else stores one -- a cell-scoped asset's area is its cell's, derived in
-- `device_locations`, for the reason `devices.cell_id` has no default. `site_wide` keeps its
-- meaning: the whole campus.
--
-- Names become topic segments, so `areas.name` takes the rule `gateways.sparkplug_group` has and
-- `cells.name` takes it NOT VALID: an existing name with `/` keeps its row, and the bridge skips it.
--
-- `device_locations` is dropped and recreated, here and in 0001: CREATE OR REPLACE cannot narrow
-- a view a later file widened, so 0001's replay would fail on the second boot. DROP VIEW discards
-- the grants, so they are re-applied after it, as ensure_gateway_status_view() does.

SET search_path TO public;

-- -------------------------------------------------------------------------------------------------
-- 1. Areas
-- -------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.areas (
    id          uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    name        text NOT NULL,
    description text,
    icon        text DEFAULT 'Building2'::text NOT NULL,
    created_at  timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT areas_name_key UNIQUE (name),
    CONSTRAINT areas_name_topic_safe CHECK ((name <> ''::text) AND (name !~ '[/+#]'::text)),
    CONSTRAINT areas_icon_valid CHECK ((icon = ANY (ARRAY['Building2'::text, 'Factory'::text, 'Warehouse'::text, 'FlaskConical'::text, 'Truck'::text, 'Parking'::text, 'Trees'::text, 'Zap'::text])))
);

-- For a database that created the table before the icon existed: the column and its CHECK,
-- added when missing.
ALTER TABLE public.areas ADD COLUMN IF NOT EXISTS icon text DEFAULT 'Building2'::text NOT NULL;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.areas'::regclass AND conname = 'areas_icon_valid'
    ) THEN
        ALTER TABLE public.areas
            ADD CONSTRAINT areas_icon_valid
            CHECK ((icon = ANY (ARRAY['Building2'::text, 'Factory'::text, 'Warehouse'::text, 'FlaskConical'::text, 'Truck'::text, 'Parking'::text, 'Trees'::text, 'Zap'::text])));
    END IF;
END $$;

COMMENT ON TABLE public.areas IS 'ISA-95 areas -- the buildings of the one site. A cell files into at most one area (cells.area_id); an area-wide asset names one directly. The name is a segment of every uns/ topic beneath it, so it cannot contain the MQTT separator or wildcards.';
COMMENT ON COLUMN public.areas.name IS 'Display name and the <area> segment of uns/<enterprise>/<site>/<area>/... Unique, non-empty, no / + #.';
COMMENT ON COLUMN public.areas.icon IS 'Icon key for this area, rendered by the dashboard from a bundled SVG set (frontend/src/utils/areaIcon.jsx). A closed set (see areas_icon_valid), as cells.icon is: a lookup key, never markup or a URL.';

ALTER TABLE public.areas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS areas_select_authenticated ON public.areas;
CREATE POLICY areas_select_authenticated ON public.areas FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS areas_insert_privileged ON public.areas;
CREATE POLICY areas_insert_privileged ON public.areas FOR INSERT TO authenticated
    WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

DROP POLICY IF EXISTS areas_update_privileged ON public.areas;
CREATE POLICY areas_update_privileged ON public.areas FOR UPDATE TO authenticated
    USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]))
    WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

DROP POLICY IF EXISTS areas_delete_privileged ON public.areas;
CREATE POLICY areas_delete_privileged ON public.areas FOR DELETE TO authenticated
    USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

GRANT ALL ON TABLE public.areas TO service_role;
GRANT ALL ON TABLE public.areas TO authenticated;

-- The same audit trigger the other asset tables carry; audit_domain_for() below files it under
-- the asset lane so a Shopfloor_Manager can read the record.
DROP TRIGGER IF EXISTS trg_areas_digital_thread ON public.areas;
CREATE TRIGGER trg_areas_digital_thread
    AFTER INSERT OR DELETE OR UPDATE ON public.areas
    FOR EACH ROW EXECUTE FUNCTION public.log_digital_thread_event();

-- -------------------------------------------------------------------------------------------------
-- 2. A cell files into an area, on a floor
-- -------------------------------------------------------------------------------------------------
-- ON DELETE SET NULL: deleting a building un-files its cells into the Unassigned lane rather than
-- deleting them or refusing.
ALTER TABLE public.cells
    ADD COLUMN IF NOT EXISTS area_id uuid REFERENCES public.areas(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS floor smallint,
    ADD COLUMN IF NOT EXISTS description text;

COMMENT ON COLUMN public.cells.description IS 'Free text about the cell, shown as a help tip beside its name on the Overview map when present. Not a topic segment.';
COMMENT ON COLUMN public.cells.area_id IS 'The ISA-95 area (building) this cell is in; NULL is unfiled, which the Areas page lists as a queue. Devices and gateways in the cell derive their area from it and store none.';
COMMENT ON COLUMN public.cells.floor IS 'Ground floor is 0, basements negative. A grouping on the Overview map, not a hierarchy level: it has no lane and no topic segment.';

CREATE INDEX IF NOT EXISTS cells_area_id_idx ON public.cells (area_id);

-- NOT VALID: enforced for every write from now on, and not checked against existing rows, so a
-- database holding a cell called "Bay 1/2" still boots. The self-check at the end names such rows.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.cells'::regclass AND conname = 'cells_name_topic_safe'
    ) THEN
        ALTER TABLE public.cells
            ADD CONSTRAINT cells_name_topic_safe
            CHECK ((name <> ''::text) AND (name !~ '[/+#]'::text)) NOT VALID;
    END IF;
END $$;

-- -------------------------------------------------------------------------------------------------
-- 3. The third scope, on devices and on gateways
-- -------------------------------------------------------------------------------------------------
-- No ON DELETE action: an area holding an area-wide asset cannot be deleted until the asset is
-- moved, because the asset's scope requires its area (the CHECK below) and a SET NULL would break it.
ALTER TABLE public.devices
    ADD COLUMN IF NOT EXISTS area_id uuid REFERENCES public.areas(id);
ALTER TABLE public.gateways
    ADD COLUMN IF NOT EXISTS area_id uuid REFERENCES public.areas(id);

COMMENT ON COLUMN public.devices.area_id IS 'Populated exactly when location_scope = ''area_wide''. A cell-scoped device derives its area through its effective cell (public.device_locations) and stores none; a site-wide device has none.';
COMMENT ON COLUMN public.gateways.area_id IS 'Populated exactly when location_scope = ''area_wide''. Not inherited by its devices, as location_scope is not: they resolve to Unassigned until an operator files them.';

-- Widened on replay freely, as 0090 says of domains. Guarded on the definition lacking the new
-- value rather than on the constraint's absence, so the replay after a widening does nothing.
DO $$
DECLARE
    v_table text;
BEGIN
    FOREACH v_table IN ARRAY ARRAY['devices', 'gateways'] LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conrelid = format('public.%I', v_table)::regclass
               AND conname  = v_table || '_location_scope_valid'
               AND pg_get_constraintdef(oid) LIKE '%area_wide%'
        ) THEN
            EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', v_table, v_table || '_location_scope_valid');
            EXECUTE format(
                'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK ((location_scope = ANY (ARRAY[''cell''::text, ''site_wide''::text, ''area_wide''::text])))',
                v_table, v_table || '_location_scope_valid'
            );
        END IF;

        -- Mirrors <table>_site_wide_has_no_cell one scope down: area-wide is an assertion that the
        -- asset has no single cell.
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conrelid = format('public.%I', v_table)::regclass
               AND conname  = v_table || '_area_wide_has_no_cell'
        ) THEN
            EXECUTE format(
                'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK ((location_scope <> ''area_wide''::text) OR (cell_id IS NULL))',
                v_table, v_table || '_area_wide_has_no_cell'
            );
        END IF;

        -- Both directions in one predicate: area-wide names its area, and only area-wide does.
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conrelid = format('public.%I', v_table)::regclass
               AND conname  = v_table || '_area_wide_names_its_area'
        ) THEN
            EXECUTE format(
                'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK ((location_scope = ''area_wide''::text) = (area_id IS NOT NULL))',
                v_table, v_table || '_area_wide_names_its_area'
            );
        END IF;
    END LOOP;
END $$;

COMMENT ON COLUMN public.devices.location_scope IS '''cell'' (located in, or awaiting, a cell), ''area_wide'' (asserted to have no single cell within one area -- a building''s BMS) or ''site_wide'' (asserted to have no single area -- a campus-wide asset). Distinct from cell_id IS NULL, which means undecided.';
COMMENT ON COLUMN public.gateways.location_scope IS '''cell'', ''area_wide'' or ''site_wide''. An area- or site-wide gateway -- typically is_virtual -- is a host-level proxy with no physical cell. Scope is not inherited by its devices; they resolve to Unassigned until an operator files them.';

-- -------------------------------------------------------------------------------------------------
-- 4. Where a device is, now with its area
-- -------------------------------------------------------------------------------------------------
-- The existing columns keep their order and meaning; two are appended. Precedence gains one arm:
-- area-wide sits between site-wide and the explicit cell, resolving to no cell and to its own area.
DROP VIEW IF EXISTS public.device_locations;
CREATE OR REPLACE VIEW public.device_locations WITH (security_invoker='true') AS
 SELECT d.id AS device_id,
    d.gateway_id,
    d.cell_id AS explicit_cell_id,
    g.cell_id AS gateway_cell_id,
    d.location_scope,
        CASE
            WHEN COALESCE(g.is_shadow, false) THEN NULL::uuid
            WHEN COALESCE(g.is_simulated, false) THEN NULL::uuid
            WHEN (d.location_scope = 'site_wide'::text) THEN NULL::uuid
            WHEN (d.location_scope = 'area_wide'::text) THEN NULL::uuid
            ELSE COALESCE(d.cell_id, g.cell_id)
        END AS effective_cell_id,
        CASE
            WHEN COALESCE(g.is_shadow, false) THEN 'shadow'::text
            WHEN COALESCE(g.is_simulated, false) THEN 'simulated'::text
            WHEN (d.location_scope = 'site_wide'::text) THEN 'site_wide'::text
            WHEN (d.location_scope = 'area_wide'::text) THEN 'area_wide'::text
            WHEN (d.cell_id IS NOT NULL) THEN 'explicit'::text
            WHEN (g.cell_id IS NOT NULL) THEN 'inherited'::text
            ELSE 'unassigned'::text
        END AS location_source,
    ((d.location_scope = 'cell'::text) AND (d.cell_id IS NOT NULL) AND (g.cell_id IS NOT NULL) AND (d.cell_id <> g.cell_id)) AS cell_mismatch,
    d.area_id AS explicit_area_id,
        CASE
            WHEN COALESCE(g.is_shadow, false) THEN NULL::uuid
            WHEN COALESCE(g.is_simulated, false) THEN NULL::uuid
            WHEN (d.location_scope = 'site_wide'::text) THEN NULL::uuid
            WHEN (d.location_scope = 'area_wide'::text) THEN d.area_id
            ELSE c.area_id
        END AS effective_area_id
   FROM public.devices d
     LEFT JOIN public.gateways g ON g.id = d.gateway_id
     LEFT JOIN public.cells c ON c.id = COALESCE(d.cell_id, g.cell_id);

COMMENT ON VIEW public.device_locations IS 'Effective cell and area per device, and which arm answered. Precedence: shadow (a replay lane behind a playback gateway) and simulated (synthetic telemetry) resolve to NO cell and NO area and take priority over everything else; then site-wide assets, which have neither by assertion; then area-wide assets, which have their own area and no cell; then explicit devices.cell_id, then inherited gateways.cell_id, else unassigned. A cell-scoped device''s area is its effective cell''s. The first two are the gateway''s flags and are inherited -- devices store no copy. Mirrors frontend/src/utils/cellResolution.js -- keep the two in step. Derived at read time and never stored, so flipping a gateway''s flag or cell reclassifies its devices immediately.';

REVOKE ALL ON public.device_locations FROM PUBLIC, anon;
GRANT ALL ON TABLE public.device_locations TO service_role;
GRANT SELECT ON TABLE public.device_locations TO authenticated;

-- -------------------------------------------------------------------------------------------------
-- 5. A batch relocation can say area-wide
-- -------------------------------------------------------------------------------------------------
-- The 0001 body with one scope added. A move now carries `area_id`, required for area_wide and
-- forced NULL otherwise, as cell_id is forced NULL for the two wide scopes.
CREATE OR REPLACE FUNCTION public.relocate_devices(p_moves jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_move      jsonb;
  v_device_id uuid;
  v_scope     text;
  v_cell      uuid;
  v_raw_cell  text;
  v_area      uuid;
  v_raw_area  text;
  v_len       integer;
  v_applied   integer := 0;
  v_unchanged integer := 0;
  v_before    public.devices%ROWTYPE;
  v_after     public.devices%ROWTYPE;
  v_results   jsonb := '[]'::jsonb;
  v_changed   boolean;
BEGIN
  -- Fail closed, before anything observable happens. SECURITY DEFINER means RLS does not apply
  -- inside this function, so the allow-list `devices_update_privileged` uses is re-derived here.
  IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'insufficient privileges to relocate devices'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_moves IS NULL OR jsonb_typeof(p_moves) <> 'array' THEN
    RAISE EXCEPTION 'p_moves must be a JSON array of moves, got %',
                    COALESCE(jsonb_typeof(p_moves), 'null')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_len := jsonb_array_length(p_moves);

  -- An empty batch is a caller bug: the page disables Apply at zero staged moves.
  IF v_len = 0 THEN
    RAISE EXCEPTION 'p_moves is empty; nothing to relocate'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Every row below takes a FOR UPDATE lock held until commit, so the batch is bounded.
  IF v_len > 200 THEN
    RAISE EXCEPTION 'a relocation batch is limited to 200 moves; got %', v_len
      USING ERRCODE = 'program_limit_exceeded',
            HINT = 'Apply the rearrangement in smaller batches.';
  END IF;

  -- One device may appear once: "last one wins" would silently discard an instruction.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_moves) m
     GROUP BY m ->> 'device_id'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'p_moves names the same device more than once; a batch must state one destination per device'
      USING ERRCODE = 'cardinality_violation';
  END IF;

  -- Ordered by device_id so two overlapping batches cannot deadlock on their row locks.
  FOR v_move IN
    SELECT m FROM jsonb_array_elements(p_moves) m ORDER BY m ->> 'device_id'
  LOOP
    IF jsonb_typeof(v_move) <> 'object' THEN
      RAISE EXCEPTION 'every element of p_moves must be an object, got %', jsonb_typeof(v_move)
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF (v_move ->> 'device_id') IS NULL THEN
      RAISE EXCEPTION 'every move must name a device_id' USING ERRCODE = 'null_value_not_allowed';
    END IF;

    BEGIN
      v_device_id := (v_move ->> 'device_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'device_id % is not a uuid', v_move ->> 'device_id'
        USING ERRCODE = 'invalid_parameter_value';
    END;

    -- Required, not defaulted to 'cell': a caller that forgot the key would silently clear a
    -- wide scope an operator asserted.
    v_scope := v_move ->> 'location_scope';
    IF v_scope IS NULL THEN
      RAISE EXCEPTION 'move for device % must state location_scope (cell, area_wide or site_wide)', v_device_id
        USING ERRCODE = 'null_value_not_allowed';
    END IF;
    IF v_scope NOT IN ('cell', 'area_wide', 'site_wide') THEN
      RAISE EXCEPTION 'location_scope % is not valid for device %; expected cell, area_wide or site_wide',
                      v_scope, v_device_id
        USING ERRCODE = 'check_violation';
    END IF;

    -- Empty string reads as absent, as emptyToNull() does in frontend/src/api.js.
    v_raw_cell := NULLIF(btrim(COALESCE(v_move ->> 'cell_id', '')), '');
    IF v_raw_cell IS NULL THEN
      v_cell := NULL;
    ELSE
      BEGIN
        v_cell := v_raw_cell::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'cell_id % is not a uuid', v_raw_cell
          USING ERRCODE = 'invalid_parameter_value';
      END;
    END IF;

    v_raw_area := NULLIF(btrim(COALESCE(v_move ->> 'area_id', '')), '');
    IF v_raw_area IS NULL THEN
      v_area := NULL;
    ELSE
      BEGIN
        v_area := v_raw_area::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'area_id % is not a uuid', v_raw_area
          USING ERRCODE = 'invalid_parameter_value';
      END;
    END IF;

    -- Mirrors the CHECKs and locationFieldsFrom() in frontend/src/api.js. Forced rather than
    -- rejected: "site-wide, in cell 3" is an incompletely cleared form, not a refusal case. The
    -- one thing that cannot be forced is an area-wide move with no area, which is refused.
    IF v_scope = 'site_wide' THEN
      v_cell := NULL;
      v_area := NULL;
    ELSIF v_scope = 'area_wide' THEN
      v_cell := NULL;
      IF v_area IS NULL THEN
        RAISE EXCEPTION 'an area_wide move for device % must name area_id', v_device_id
          USING ERRCODE = 'null_value_not_allowed';
      END IF;
    ELSE
      v_area := NULL;
    END IF;

    SELECT * INTO v_before FROM public.devices WHERE id = v_device_id FOR UPDATE;
    IF NOT FOUND THEN
      -- The whole batch fails: a half-applied rearrangement is what the batch exists to remove.
      RAISE EXCEPTION 'device % not found; no part of this batch was applied', v_device_id
        USING ERRCODE = 'no_data_found';
    END IF;

    IF v_cell IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.cells c WHERE c.id = v_cell) THEN
      RAISE EXCEPTION 'cell % not found; no part of this batch was applied', v_cell
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF v_area IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.areas a WHERE a.id = v_area) THEN
      RAISE EXCEPTION 'area % not found; no part of this batch was applied', v_area
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- The gateway is left alone: a drop says where the machine is, not which connector reaches it.
    UPDATE public.devices
       SET cell_id        = v_cell,
           area_id        = v_area,
           location_scope = v_scope
     WHERE id = v_device_id
    RETURNING * INTO v_after;

    v_changed := v_before.cell_id IS DISTINCT FROM v_after.cell_id
              OR v_before.area_id IS DISTINCT FROM v_after.area_id
              OR v_before.location_scope IS DISTINCT FROM v_after.location_scope;

    -- A no-op move is counted but not called applied: the audit trigger writes no row for it.
    IF v_changed THEN
      v_applied := v_applied + 1;
    ELSE
      v_unchanged := v_unchanged + 1;
    END IF;

    v_results := v_results || jsonb_build_object(
      'device_id',      v_after.id,
      'cell_id',        v_after.cell_id,
      'area_id',        v_after.area_id,
      'location_scope', v_after.location_scope,
      'changed',        v_changed
    );
  END LOOP;

  RETURN jsonb_build_object(
    -- The transaction the UPDATEs ran in, which log_digital_thread_event() stamped on every row it
    -- wrote; NULL when nothing changed, since the trigger then wrote no row.
    'causation_id', CASE WHEN v_applied > 0 THEN txid_current() ELSE NULL END,
    'requested',    v_len,
    'applied',      v_applied,
    'unchanged',    v_unchanged,
    'devices',      v_results
  );
END;
$$;

COMMENT ON FUNCTION public.relocate_devices(p_moves jsonb) IS 'Apply a batch of device relocations in ONE transaction, so the whole rearrangement shares a single digital_thread causation_id. A move states location_scope (cell, area_wide or site_wide) and, for area_wide, area_id. Refuses the batch outright on an unknown device, cell or area, a duplicate device, a missing location_scope or an area_wide move with no area -- a half-applied batch is the failure mode this exists to remove. Authority: Administrator or Shopfloor_Manager.';

-- -------------------------------------------------------------------------------------------------
-- 6. The proposal lanes admit the new columns
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.proposable_columns(p_entity_type text) RETURNS text[]
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE p_entity_type
    -- `area_id` joins `cell_id` and `location_scope`: the three together say where an asset sits,
    -- and the table's CHECKs decide whether the triple is sayable, so one proposal can relocate.
    WHEN 'devices' THEN ARRAY[
      'name', 'description', 'asset_type', 'connection_method',
      'cell_id', 'area_id', 'location_scope', 'model_3d_path'
    ]
    WHEN 'device_nameplate' THEN ARRAY[
      'manufacturer_name', 'manufacturer_product_designation', 'manufacturer_product_type',
      'serial_number', 'year_of_construction', 'date_of_manufacture', 'hardware_version',
      'firmware_version', 'software_version', 'country_of_origin', 'uri_of_the_product'
    ]

    -- `grafana_url` is a dashboard address and `icon` is one of eight names the CHECK on the table
    -- admits. `area_id` and `floor` are where the cell is.
    WHEN 'cells' THEN ARRAY['name', 'grafana_url', 'icon', 'area_id', 'floor', 'description']

    WHEN 'gateways' THEN ARRAY['name', 'description', 'cell_id', 'area_id', 'location_scope', 'access_url']

    -- The columns of a row to create. `display_name` and `url` are also required, which this
    -- function cannot express -- validate_change_proposal() carries that half.
    WHEN 'cell_links'    THEN ARRAY['display_name', 'url', 'link_tag']
    WHEN 'gateway_links' THEN ARRAY['display_name', 'url', 'link_tag']
    WHEN 'device_links'  THEN ARRAY['display_name', 'url', 'link_tag']

    -- 'schemas' is absent on purpose: the empty array is how this function closes a lane.
    ELSE ARRAY[]::text[]
  END
$$;

-- Areas join the asset lane; an unclassified table falls to the fail-closed security domain,
-- where a Shopfloor_Manager could not read the record of a building they created.
CREATE OR REPLACE FUNCTION public.audit_domain_for(p_entity_type text, p_action text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
    -- Identity and authority. Every act on these is Administrator-only to perform, so it is
    -- Administrator-and-Auditor to read.
    WHEN p_entity_type IN ('service_principals', 'user_roles', 'system_settings')
      THEN 'security'

    -- The asset trail: the shopfloor's own history. CREDENTIAL_ISSUED lands here on `gateways`
    -- deliberately: a Manager may mint a virtual gateway's broker credential.
    WHEN p_entity_type IN ('areas', 'cells', 'devices', 'gateways', 'links',
                           'device_nameplate', 'change_proposals',
                           'cell_links', 'gateway_links', 'device_links')
      THEN 'asset'

    -- Fail-closed: a new entity_type nobody classified is restricted rather than exposed.
    ELSE 'security'
  END
$$;

-- The 0090 body with the new columns assigned. Column by column, allowlist only: a column absent
-- from the patch keeps the value jsonb_populate_record carried over from the current row.
CREATE OR REPLACE FUNCTION public.approve_proposal(p_proposal_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_proposal  public.change_proposals%ROWTYPE;
    v_device    public.devices%ROWTYPE;
    v_merged    public.devices%ROWTYPE;
    v_plate     public.device_nameplate%ROWTYPE;
    v_plate_new public.device_nameplate%ROWTYPE;
    v_cell      public.cells%ROWTYPE;
    v_cell_new  public.cells%ROWTYPE;
    v_gateway   public.gateways%ROWTYPE;
    v_gw_new    public.gateways%ROWTYPE;
    v_link_kind text;
    v_actor     uuid := auth.uid();
    v_allowed   text[];
    v_key       text;
    v_thread    bigint;
BEGIN
    -- The outer gate is the union of everybody who may decide anything; the lane's own gate below
    -- is the one that decides.
    IF NOT (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
            OR public.has_authority(ARRAY['cell:manage', 'gateway:manage', 'link:manage'])) THEN
        RAISE EXCEPTION 'not permitted to decide change proposals'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_proposal FROM public.change_proposals
     WHERE id = p_proposal_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'proposal % not found', p_proposal_id USING ERRCODE = 'no_data_found';
    END IF;

    IF NOT public.may_decide_proposal(v_proposal.entity_type) THEN
        RAISE EXCEPTION 'not permitted to decide proposals on %', v_proposal.entity_type
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF v_proposal.status <> 'open' THEN
        RAISE EXCEPTION 'proposal % is already %', p_proposal_id, v_proposal.status
            USING ERRCODE = 'check_violation';
    END IF;

    -- Re-validated, not trusted: the patch may have been edited since the insert trigger checked
    -- it, and the allowlist may have narrowed.
    v_allowed := public.proposable_columns(v_proposal.entity_type);
    FOREACH v_key IN ARRAY ARRAY(SELECT jsonb_object_keys(v_proposal.patch)) LOOP
        IF NOT (v_key = ANY (v_allowed)) THEN
            RAISE EXCEPTION 'proposal % names % , which is not proposable on %',
                p_proposal_id, v_key, v_proposal.entity_type
                USING ERRCODE = 'invalid_parameter_value';
        END IF;
    END LOOP;

    -- Already true is not approvable: the repair is a rejection naming what happened.
    IF public.proposal_is_already_true(p_proposal_id) THEN
        RAISE EXCEPTION
            'this change is already in place -- somebody made it while the proposal was open; reject it with that as the reason rather than recording an approval that changes nothing'
            USING ERRCODE = 'check_violation';
    END IF;

    -- Attribute every trigger-written audit row in this transaction to the approver. SET LOCAL,
    -- so it is discarded at COMMIT.
    PERFORM set_config('acs_cymru.actor_id', v_actor::text, true);

    IF v_proposal.entity_type = 'devices' THEN
        SELECT * INTO v_device FROM public.devices
         WHERE id = v_proposal.entity_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'device % no longer exists', v_proposal.entity_id
                USING ERRCODE = 'no_data_found';
        END IF;

        SELECT * INTO v_merged FROM jsonb_populate_record(v_device, v_proposal.patch);

        UPDATE public.devices
           SET name              = v_merged.name,
               description       = v_merged.description,
               asset_type        = v_merged.asset_type,
               connection_method = v_merged.connection_method,
               cell_id           = v_merged.cell_id,
               area_id           = v_merged.area_id,
               location_scope    = v_merged.location_scope,
               model_3d_path     = v_merged.model_3d_path
         WHERE id = v_device.id;

    ELSIF v_proposal.entity_type = 'device_nameplate' THEN
        -- A device with no nameplate row yet is the normal case: the row is created by whoever
        -- first asserts something about the asset.
        INSERT INTO public.device_nameplate (device_id) VALUES (v_proposal.entity_id)
        ON CONFLICT (device_id) DO NOTHING;

        SELECT * INTO v_plate FROM public.device_nameplate
         WHERE device_id = v_proposal.entity_id FOR UPDATE;

        SELECT * INTO v_plate_new FROM jsonb_populate_record(v_plate, v_proposal.patch);

        UPDATE public.device_nameplate
           SET manufacturer_name                = v_plate_new.manufacturer_name,
               manufacturer_product_designation = v_plate_new.manufacturer_product_designation,
               manufacturer_product_type        = v_plate_new.manufacturer_product_type,
               serial_number                    = v_plate_new.serial_number,
               year_of_construction             = v_plate_new.year_of_construction,
               date_of_manufacture              = v_plate_new.date_of_manufacture,
               hardware_version                 = v_plate_new.hardware_version,
               firmware_version                 = v_plate_new.firmware_version,
               software_version                 = v_plate_new.software_version,
               country_of_origin                = v_plate_new.country_of_origin,
               uri_of_the_product               = v_plate_new.uri_of_the_product,
               updated_at                       = now(),
               -- The proposer; see 0086.
               updated_by                       = v_proposal.proposed_by
         WHERE device_id = v_proposal.entity_id;

    ELSIF v_proposal.entity_type = 'cells' THEN
        SELECT * INTO v_cell FROM public.cells
         WHERE id = v_proposal.entity_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'cell % no longer exists', v_proposal.entity_id
                USING ERRCODE = 'no_data_found';
        END IF;

        SELECT * INTO v_cell_new FROM jsonb_populate_record(v_cell, v_proposal.patch);

        -- The table's CHECKs and the area foreign key run on this UPDATE, so a patch naming an
        -- icon nobody drew or an area that was deleted aborts the approval rather than being stored.
        UPDATE public.cells
           SET name        = v_cell_new.name,
               grafana_url = v_cell_new.grafana_url,
               icon        = v_cell_new.icon,
               area_id     = v_cell_new.area_id,
               floor       = v_cell_new.floor,
               description = v_cell_new.description
         WHERE id = v_cell.id;

    ELSIF v_proposal.entity_type = 'gateways' THEN
        SELECT * INTO v_gateway FROM public.gateways
         WHERE id = v_proposal.entity_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'gateway % no longer exists', v_proposal.entity_id
                USING ERRCODE = 'no_data_found';
        END IF;

        SELECT * INTO v_gw_new FROM jsonb_populate_record(v_gateway, v_proposal.patch);

        -- The location CHECKs guard this statement; a relocation that breaks one fails here, inside
        -- the approver's transaction, and the proposal stays open with the database's own sentence.
        UPDATE public.gateways
           SET name           = v_gw_new.name,
               description    = v_gw_new.description,
               cell_id        = v_gw_new.cell_id,
               area_id        = v_gw_new.area_id,
               location_scope = v_gw_new.location_scope,
               access_url     = v_gw_new.access_url
         WHERE id = v_gateway.id;

    ELSIF v_proposal.entity_type IN ('cell_links', 'gateway_links', 'device_links') THEN
        -- An INSERT, not an UPDATE: the one lane shape that creates a row. `links.entity_type` is
        -- the singular noun and `links.entity_id` is text, so both are derived.
        v_link_kind := CASE v_proposal.entity_type
            WHEN 'cell_links'    THEN 'cell'
            WHEN 'gateway_links' THEN 'gateway'
            WHEN 'device_links'  THEN 'device'
        END;

        INSERT INTO public.links (entity_type, entity_id, display_name, url, link_tag)
        VALUES (
            v_link_kind,
            v_proposal.entity_id::text,
            v_proposal.patch ->> 'display_name',
            v_proposal.patch ->> 'url',
            COALESCE(NULLIF(v_proposal.patch ->> 'link_tag', ''), 'other')
        );

    END IF;
    -- No `schemas` branch: 0090 withdrew the lane and may_decide_proposal() refuses it above.

    -- The row that names both parties; the target's own audit trigger records only the approver.
    INSERT INTO public.digital_thread
        (entity_type, entity_id, action, old_data, new_data, changed_by, actor_source, audit_domain)
    VALUES (
        v_proposal.entity_type,
        v_proposal.entity_id,
        'PROPOSAL_APPLIED',
        NULL,
        jsonb_build_object(
            'proposal_id',       v_proposal.id,
            'proposed_by',       v_proposal.proposed_by,
            'proposed_by_email', v_proposal.proposed_by_email,
            'approved_by',       v_actor,
            'patch',             v_proposal.patch,
            'rationale',         v_proposal.rationale
        ),
        v_actor,
        'user',
        public.audit_domain_for(v_proposal.entity_type, 'PROPOSAL_APPLIED')
    )
    RETURNING id INTO v_thread;

    PERFORM set_config('acs_cymru.proposal_transition', 'on', true);

    UPDATE public.change_proposals
       SET status = 'applied', decided_by = v_actor, decided_at = now(),
           applied_thread_id = v_thread
     WHERE id = p_proposal_id;

    RETURN jsonb_build_object(
        'id', p_proposal_id, 'status', 'applied', 'thread_id', v_thread
    );
END;
$$;

-- -------------------------------------------------------------------------------------------------
-- 7. The site
-- -------------------------------------------------------------------------------------------------
-- One value, because the stack models one campus. Read by the ingestion daemon's UNS bridge,
-- which publishes nothing while it is empty: a placeholder name would put a word nobody chose in
-- every topic, which is the trap the derived lanes exist to avoid.
SELECT public.seed_setting(
    'site.name',
    to_jsonb(''::text),
    'string',
    'Site',
    'Site name',
    'The ISA-95 site -- this campus -- as the second segment of every Unified Namespace topic: '
    'uns/<enterprise>/<site>/<area>/<cell>/<device>/<metric>. The enterprise segment is each '
    'gateway''s Sparkplug group. The bridge publishes nothing until this is set. It cannot '
    'contain / + or #.',
    'none: the UNS bridge stays inert'
);

-- -------------------------------------------------------------------------------------------------
-- 8. The gateway status view learns the new column
-- -------------------------------------------------------------------------------------------------
-- `SELECT g.*` is frozen at creation, so without this `gateway_status` would go on returning the
-- columns it was born with and `area_id` would be invisible through it.
SELECT public.ensure_gateway_status_view();

-- -------------------------------------------------------------------------------------------------
-- 9. Self-checks
-- -------------------------------------------------------------------------------------------------
DO $$
DECLARE
    v_unsafe text;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'device_locations'
           AND column_name = 'effective_area_id'
    ) THEN
        RAISE EXCEPTION '0097 self-check: device_locations has no effective_area_id';
    END IF;

    IF (SELECT count(*) FROM pg_constraint
         WHERE conname IN ('devices_area_wide_names_its_area', 'gateways_area_wide_names_its_area',
                           'devices_area_wide_has_no_cell', 'gateways_area_wide_has_no_cell')) <> 4 THEN
        RAISE EXCEPTION '0097 self-check: an area_wide CHECK is missing';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.system_settings WHERE key = 'site.name') THEN
        RAISE EXCEPTION '0097 self-check: site.name was not seeded';
    END IF;

    -- Named, not refused: the NOT VALID constraint left these rows alone, and the bridge skips them.
    SELECT string_agg(quote_literal(name), ', ') INTO v_unsafe
      FROM public.cells WHERE name = '' OR name ~ '[/+#]';
    IF v_unsafe IS NOT NULL THEN
        RAISE NOTICE '0097: cell name(s) % contain / + or # and will not appear in the Unified Namespace until renamed.', v_unsafe;
    END IF;
END $$;
