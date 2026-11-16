-- 0293: A device can follow its gateway's location.
--
-- A device's location was one of In a cell, Area-Wide and Site-Wide, and "In a cell" with no cell
-- meant "inherit the gateway's cell". device_locations resolved that as COALESCE(d.cell_id,
-- g.cell_id), so a device behind an Area-Wide or a Site-Wide gateway, which has no cell, resolved to
-- Unassigned: the device took neither the area nor the site its gateway names, and the place had
-- to be written twice, once on the gateway and once on each device.
--
--   * devices.location_scope gains 'gateway', shown as Follow Gateway. The device takes whatever its
--     gateway has when it is read: the gateway's cell, its area, the whole site, or nothing. It names
--     no cell and no area of its own (devices_follow_gateway_has_no_place), it is the column's
--     default, and 0001 carries both, because 0001 replays first on every boot and drops a CHECK that
--     differs from its own text: a CHECK widened only here would be narrowed again on the next boot,
--     and its re-add would fail on the first row holding 'gateway'.
--   * 'cell' now means a cell: devices_cell_scope_names_a_cell refuses it with no cell_id. Every
--     device that was 'cell' with no cell becomes 'gateway' first, in the transaction that adds the
--     CHECK, and the number moved is a NOTICE. A replay finds the CHECK and moves nothing.
--   * device_locations resolves a device that follows its gateway through the gateway's own scope
--     and gives it a location_source of followed_cell, followed_area or followed_site, or
--     unassigned when the gateway has no location or there is no gateway. Simulated and Playback
--     lanes still win first. Every column and every other source keeps its name and meaning.
--   * What reads location_source follows: device_uns_paths gives a followed device the topic of
--     the place it follows, and automations_document() calls a device that follows a Site-Wide
--     gateway Site-wide.
--   * Deleting a cell moves the devices filed in it to Follow Gateway first (a BEFORE DELETE trigger),
--     because the foreign key's SET NULL would otherwise write a cell scope with no cell.
--   * approve_quarantined_device() and relocate_devices() take the fourth scope: a device approved or
--     moved as Follow Gateway has its cell and area cleared, and a cell scope that names no cell is
--     refused in their words, as an area_wide one with no area is.
--
-- Nothing is stored twice and nothing is copied: a gateway's location changing moves the devices
-- that follow it at once. A proposal carries the value through the columns it already may name
-- (proposable_columns() lists location_scope), and approve_proposal() writes the row under the same
-- CHECKs, so no action kind changes.
--
-- Reasoning: supabase/README.md, "A device can follow its gateway's location (0293)".
-- Idempotent.
--
-- Redefines public.approve_quarantined_device: Follow Gateway names no cell and no area, and a cell
--   scope must name its cell
-- Redefines public.automations_document: a device that follows a Site-Wide gateway is Site-wide
-- Redefines public.relocate_devices: a move can say gateway, and a cell move must name its cell

-- -------------------------------------------------------------------------------------------------
-- 1. Cell requires a cell, and a device that follows its gateway names no place
-- -------------------------------------------------------------------------------------------------
-- The move and the CHECK are one transaction, behind a lock that holds writers off devices, so a
-- write by the previous release's dashboard or script cannot slip a 'cell' row with no cell in
-- between. The lock is taken only where the CHECK is missing, so a replay locks nothing.
DO $cell$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'devices_cell_scope_names_a_cell'
                AND conrelid = 'public.devices'::regclass
                AND public.live_constraint_definition(conrelid, conname) <> 'CHECK (((location_scope <> ''cell''::text) OR (cell_id IS NOT NULL)))') THEN
    ALTER TABLE public.devices DROP CONSTRAINT devices_cell_scope_names_a_cell;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'devices_cell_scope_names_a_cell'
                    AND conrelid = 'public.devices'::regclass) THEN
    DECLARE
      v_moved integer;
      v_cell  integer;
      v_area  integer;
      v_site  integer;
    BEGIN
      LOCK TABLE public.devices IN SHARE ROW EXCLUSIVE MODE;

      -- Each move is an UPDATE the audit trigger records, with the actor `migration`, so the Audit
      -- Trail shows every device that changed and what it held.
      WITH moved AS (
        UPDATE public.devices
           SET location_scope = 'gateway'
         WHERE location_scope = 'cell' AND cell_id IS NULL
        RETURNING gateway_id
      )
      SELECT count(*),
             count(*) FILTER (WHERE g.cell_id IS NOT NULL AND g.location_scope = 'cell'),
             count(*) FILTER (WHERE g.location_scope = 'area_wide'),
             count(*) FILTER (WHERE g.location_scope = 'site_wide')
        INTO v_moved, v_cell, v_area, v_site
        FROM moved m
        LEFT JOIN public.gateways g ON g.id = m.gateway_id;

      RAISE NOTICE '0293: % device(s) were In a cell with no cell and now follow their gateway: % in its cell, % Area-Wide, % Site-Wide, % with no place to take',
        v_moved, v_cell, v_area, v_site, v_moved - v_cell - v_area - v_site;

      ALTER TABLE public.devices
          ADD CONSTRAINT devices_cell_scope_names_a_cell CHECK (((location_scope <> 'cell'::text) OR (cell_id IS NOT NULL)));
    END;
  END IF;
END
$cell$;

DO $c$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'devices_follow_gateway_has_no_place'
                AND conrelid = 'public.devices'::regclass
                AND public.live_constraint_definition(conrelid, conname) <> 'CHECK (((location_scope <> ''gateway''::text) OR ((cell_id IS NULL) AND (area_id IS NULL))))') THEN
    ALTER TABLE public.devices DROP CONSTRAINT devices_follow_gateway_has_no_place;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'devices_follow_gateway_has_no_place'
                    AND conrelid = 'public.devices'::regclass) THEN
    ALTER TABLE public.devices
        ADD CONSTRAINT devices_follow_gateway_has_no_place CHECK (((location_scope <> 'gateway'::text) OR ((cell_id IS NULL) AND (area_id IS NULL))));
  END IF;
END $c$;

COMMENT ON COLUMN public.devices.location_scope IS '''gateway'' (follows its gateway''s location at read time: its cell, its area, the whole site, or none; the default), ''cell'' (in the cell cell_id names), ''area_wide'' (asserted to have no single cell within one area -- a building''s BMS) or ''site_wide'' (asserted to have no single area -- a campus-wide asset). Resolve through public.device_locations, never by reading this column alone.';
COMMENT ON COLUMN public.devices.cell_id IS 'The device''s own cell: set exactly when location_scope = ''cell'' (devices_cell_scope_names_a_cell), NULL for every other scope. A device that follows its gateway has none; its cell is its gateway''s. Resolve through public.device_locations, never by reading this column alone.';
COMMENT ON COLUMN public.devices.area_id IS 'Populated exactly when location_scope = ''area_wide''. A cell-scoped device derives its area through its effective cell (public.device_locations) and stores none; a device that follows its gateway takes the gateway''s; a site-wide device has none.';

-- -------------------------------------------------------------------------------------------------
-- 2. device_locations
-- -------------------------------------------------------------------------------------------------
-- Same columns, same order and same types as 0001's: CREATE OR REPLACE VIEW cannot add or drop one,
-- and 0001 replays its own text first on every boot. The new arms sit after the lanes and the two
-- wide scopes and before the cell's own, so a device that names its own place is untouched.
-- A device that follows its gateway reads the gateway's scope: a Site-Wide or an Area-Wide gateway
-- names no cell (gateways_site_wide_has_no_cell, gateways_area_wide_has_no_cell), so the cell is
-- g.cell_id, and the area is the gateway's own for Area-Wide and its cell's otherwise.
-- 'inherited' stays in the set although nothing now produces it: a cell-scoped device names its cell.
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
            WHEN (d.location_scope = 'gateway'::text) THEN g.cell_id
            ELSE COALESCE(d.cell_id, g.cell_id)
        END AS effective_cell_id,
        CASE
            WHEN COALESCE(g.is_shadow, false) THEN 'shadow'::text
            WHEN COALESCE(g.is_simulated, false) THEN 'simulated'::text
            WHEN (d.location_scope = 'site_wide'::text) THEN 'site_wide'::text
            WHEN (d.location_scope = 'area_wide'::text) THEN 'area_wide'::text
            WHEN ((d.location_scope = 'gateway'::text) AND (g.location_scope = 'site_wide'::text)) THEN 'followed_site'::text
            WHEN ((d.location_scope = 'gateway'::text) AND (g.location_scope = 'area_wide'::text)) THEN 'followed_area'::text
            WHEN ((d.location_scope = 'gateway'::text) AND (g.cell_id IS NOT NULL)) THEN 'followed_cell'::text
            WHEN (d.location_scope = 'gateway'::text) THEN 'unassigned'::text
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
            WHEN ((d.location_scope = 'gateway'::text) AND (g.location_scope = 'site_wide'::text)) THEN NULL::uuid
            WHEN ((d.location_scope = 'gateway'::text) AND (g.location_scope = 'area_wide'::text)) THEN g.area_id
            ELSE c.area_id
        END AS effective_area_id
   FROM ((public.devices d
     LEFT JOIN public.gateways g ON ((g.id = d.gateway_id)))
     LEFT JOIN public.cells c ON ((c.id = COALESCE(d.cell_id, g.cell_id))));

ALTER VIEW public.device_locations OWNER TO postgres;

COMMENT ON VIEW public.device_locations IS 'Effective cell and area per device, and which arm answered. Precedence: shadow (a replay lane behind a playback gateway) and simulated (synthetic telemetry) resolve to NO cell and NO area and take priority over everything else; then site-wide assets, which have neither by assertion; then area-wide assets, which have their own area and no cell; then a device that follows its gateway (location_scope gateway), which takes the gateway''s own place: followed_site for a Site-Wide gateway, followed_area for an Area-Wide one with its area, followed_cell for one in a cell with that cell, else unassigned, also when there is no gateway; then explicit devices.cell_id, then inherited gateways.cell_id (nothing produces it now that a cell-scoped device names its cell), else unassigned. A cell-scoped device''s area is its effective cell''s, and so is a followed cell''s. The first two are the gateway''s flags and are inherited -- devices store no copy. Mirrors frontend/src/utils/cellResolution.js -- keep the two in step. Derived at read time and never stored, so flipping a gateway''s flag, cell or scope reclassifies its devices immediately.';

-- -------------------------------------------------------------------------------------------------
-- 3. device_uns_paths
-- -------------------------------------------------------------------------------------------------
-- 0214's view with the three followed sources placed as the ones they follow: a followed_site
-- device sits directly under the site, a followed_area one under its area, and a followed_cell one
-- under its cell, which is in no area for cell_unfiled when the cell is filed in none. The columns
-- and the reasons are 0214's.
CREATE OR REPLACE VIEW public.device_uns_paths WITH (security_invoker='true') AS
 SELECT p.device_id,
    p.area_id,
    p.cell_id,
    p.enterprise,
        CASE
            WHEN r.skip_reason IS NULL THEN array_to_string(p.segments, '/'::text)
            ELSE NULL::text
        END AS uns_path,
    r.skip_reason
   FROM ( SELECT dl.device_id,
            dl.location_source,
            dl.effective_area_id AS area_id,
            dl.effective_cell_id AS cell_id,
            e.enterprise,
            s.site,
                CASE
                    WHEN dl.location_source = ANY (ARRAY['site_wide'::text, 'followed_site'::text]) THEN ARRAY[e.enterprise, s.site, d.name]
                    WHEN dl.location_source = ANY (ARRAY['area_wide'::text, 'followed_area'::text]) THEN ARRAY[e.enterprise, s.site, a.name, d.name]
                    ELSE ARRAY[e.enterprise, s.site, a.name, c.name, d.name]
                END AS segments
           FROM public.device_locations dl
             JOIN public.devices d ON d.id = dl.device_id
             LEFT JOIN public.gateways g ON g.id = dl.gateway_id
             LEFT JOIN public.areas a ON a.id = dl.effective_area_id
             LEFT JOIN public.cells c ON c.id = dl.effective_cell_id
             CROSS JOIN LATERAL ( SELECT COALESCE(g.observed_sparkplug_group, g.sparkplug_group,
                    ( SELECT NULLIF(v.value #>> '{}'::text[], ''::text)
                           FROM public.system_settings v
                          WHERE v.key = 'sparkplug.group_id'::text)) AS enterprise) e
             CROSS JOIN ( SELECT ( SELECT NULLIF(btrim(v.value #>> '{}'::text[], E' \t\n\x0B\f\r'::text), ''::text)
                           FROM public.system_settings v
                          WHERE v.key = 'site.name'::text AND jsonb_typeof(v.value) = 'string'::text) AS site) s) p
     CROSS JOIN LATERAL ( SELECT
                CASE
                    WHEN p.site IS NULL THEN 'site_unset'::text
                    WHEN p.location_source = ANY (ARRAY['shadow'::text, 'simulated'::text]) THEN 'lane'::text
                    WHEN p.location_source = 'unassigned'::text THEN 'unassigned'::text
                    WHEN p.location_source = ANY (ARRAY['explicit'::text, 'inherited'::text, 'followed_cell'::text])
                         AND p.area_id IS NULL THEN 'cell_unfiled'::text
                    WHEN EXISTS ( SELECT 1
                           FROM unnest(p.segments) seg(name)
                          WHERE seg.name IS NULL OR seg.name = ''::text OR seg.name ~ '[/+#]'::text) THEN 'unsafe_name'::text
                    ELSE NULL::text
                END AS skip_reason) r;

ALTER VIEW public.device_uns_paths OWNER TO postgres;

COMMENT ON VIEW public.device_uns_paths IS 'Each device''s place in the Unified Namespace: uns_path, its path below the bridge''s root (<enterprise>/<site>/<area>/<cell>/<device>, without the levels it does not occupy), or skip_reason, why it has none: site_unset, lane, unassigned, cell_unfiled or unsafe_name, in that order. Exactly one is set. enterprise is the gateway''s observed_sparkplug_group, else its sparkplug_group, else the sparkplug.group_id setting, and uns_path always starts with it and a slash. area_id and cell_id are device_locations'' effective ones, so a device that follows its gateway is placed where the gateway is. The UNS bridge (ingestion/uns_publish.py) and the dashboard read it. security_invoker: the caller''s RLS on devices, gateways, cells, areas and system_settings applies (0214, 0293).';

-- -------------------------------------------------------------------------------------------------
-- 4. approve_quarantined_device()
-- -------------------------------------------------------------------------------------------------
-- 0165's, with Follow Gateway named beside Site-Wide and Area-Wide in the scope the call clears, and
-- a cell scope that names no cell refused here, in the words of the area-wide refusal, instead of
-- by the CHECK. Nothing else changes: not the actor re-check, the merge path, or location being
-- written only when answered.
CREATE OR REPLACE FUNCTION public.approve_quarantined_device(p_device_id uuid, p_actor_id uuid, p_gateway_id uuid DEFAULT NULL::uuid, p_merge_into_device_id uuid DEFAULT NULL::uuid, p_asset_name text DEFAULT NULL::text, p_cell_id uuid DEFAULT NULL::uuid, p_location_scope text DEFAULT NULL::text, p_set_cell boolean DEFAULT false, p_set_location_scope boolean DEFAULT false, p_area_id uuid DEFAULT NULL::uuid, p_set_area boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_quarantined public.devices%ROWTYPE;
  v_candidate   public.devices%ROWTYPE;
  v_result      public.devices%ROWTYPE;
  v_actor_role  text;
  v_cell        uuid := p_cell_id;
  v_area        uuid := p_area_id;
BEGIN
  -- Authorization is re-derived from the database rather than taken on trust. The edge function
  -- checks too; this is the check that still holds if the RPC is ever reached another way.
  SELECT r.name INTO v_actor_role
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
   WHERE ur.user_id = p_actor_id
   LIMIT 1;

  IF v_actor_role IS NULL OR v_actor_role NOT IN ('Administrator', 'Shopfloor_Manager') THEN
    RAISE EXCEPTION 'actor % is not permitted to approve quarantined devices', p_actor_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Attribute every trigger-written audit row in this transaction to the operator. SET LOCAL, so
  -- it is discarded at COMMIT and cannot bleed into the connection's next user.
  PERFORM set_config('aber.actor_id', p_actor_id::text, true);

  SELECT * INTO v_quarantined FROM public.devices WHERE id = p_device_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.raise_not_found(format('quarantined device %s not found', p_device_id));
  END IF;

  -- ---------------------------------------------------------------------------------------
  -- Merge path: absorb a discovered duplicate into the row that was already provisioned.
  -- ---------------------------------------------------------------------------------------
  IF p_merge_into_device_id IS NOT NULL THEN
    IF p_merge_into_device_id = p_device_id THEN
      RAISE EXCEPTION 'cannot merge device % into itself', p_device_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Two named ids and a short transaction; the FOR UPDATE is what stops a concurrent approval
    -- racing this one into two live rows.
    SELECT * INTO v_candidate FROM public.devices WHERE id = p_merge_into_device_id FOR UPDATE;
    IF NOT FOUND THEN
      PERFORM public.raise_not_found(format('target device %s not found', p_merge_into_device_id));
    END IF;

    -- asset_config is keyed by sparkplug_id, not by row id, so the recorded birth parameters
    -- have to be re-keyed onto the surviving row.
    UPDATE public.asset_config
       SET asset_id = v_candidate.sparkplug_id
     WHERE asset_id = v_quarantined.sparkplug_id;

    -- reported_identity carries over deliberately: the physical device keeps publishing under
    -- the id it announced, and that is what ingestion has to keep resolving. Without it the
    -- merged device is re-quarantined on its very next birth. The candidate's deliberately
    -- provisioned fields (gateway_id, connection_method, its device_submodels) are left alone.
    UPDATE public.devices
       SET status            = v_quarantined.status,
           first_dbirth_at   = COALESCE(v_candidate.first_dbirth_at, v_quarantined.first_dbirth_at),
           reported_identity = v_quarantined.reported_identity,
           identity_source   = v_quarantined.identity_source,
           quarantine_reason = NULL,
           is_quarantined    = false
     WHERE id = v_candidate.id
    RETURNING * INTO v_result;

    DELETE FROM public.devices WHERE id = v_quarantined.id;

    RETURN jsonb_build_object(
      'merged', true,
      'device', to_jsonb(v_result),
      'discarded_device_id', v_quarantined.id
    );
  END IF;

  -- ---------------------------------------------------------------------------------------
  -- Straight approval.
  -- ---------------------------------------------------------------------------------------
  -- Mirrors the scope CHECKs: a site-wide asset, or one that follows its gateway, names neither
  -- cell nor area, an area-wide one names its area and no cell, a cell-scoped one names its cell and
  -- no area. Cleared here rather than left to a constraint violation the caller cannot interpret.
  IF p_set_location_scope AND p_location_scope IN ('site_wide', 'gateway') THEN
    v_cell := NULL;
    v_area := NULL;
  ELSIF p_set_location_scope AND p_location_scope = 'area_wide' THEN
    v_cell := NULL;
    IF v_area IS NULL THEN
      RAISE EXCEPTION 'an area_wide device must name its area'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSIF p_set_location_scope THEN
    v_area := NULL;
    -- The cell the row will hold: the one named when the call answers the cell, else the one it has.
    IF p_location_scope = 'cell'
       AND ((p_set_cell AND v_cell IS NULL) OR (NOT p_set_cell AND v_quarantined.cell_id IS NULL)) THEN
      RAISE EXCEPTION 'a cell device must name its cell'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  UPDATE public.devices
     SET is_quarantined    = false,
         quarantine_reason = NULL,
         gateway_id        = p_gateway_id,
         -- LOCATION IS OMITTED WHEN NOT ANSWERED, NEVER DEFAULTED. A device arrives following its
         -- gateway, so writing a value the operator did not choose would pin it to a place of its
         -- own for every device approved this way. The p_set_* flags are what distinguish "not
         -- supplied" from "explicitly cleared" -- a plain NULL argument cannot express the
         -- difference. Any scope but cell clears the cell whether or not one was supplied, since
         -- the CHECK would refuse the pair.
         cell_id           = CASE WHEN p_set_cell OR (p_set_location_scope AND p_location_scope <> 'cell')
                                  THEN v_cell ELSE cell_id END,
         area_id           = CASE WHEN p_set_area OR p_set_location_scope THEN v_area ELSE area_id END,
         location_scope    = CASE WHEN p_set_location_scope THEN p_location_scope ELSE location_scope END,
         name              = COALESCE(NULLIF(btrim(COALESCE(p_asset_name, '')), ''), name)
   WHERE id = p_device_id
  RETURNING * INTO v_result;

  RETURN jsonb_build_object('merged', false, 'device', to_jsonb(v_result));
END;
$$;
ALTER FUNCTION public.approve_quarantined_device(p_device_id uuid, p_actor_id uuid, p_gateway_id uuid, p_merge_into_device_id uuid, p_asset_name text, p_cell_id uuid, p_location_scope text, p_set_cell boolean, p_set_location_scope boolean, p_area_id uuid, p_set_area boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.approve_quarantined_device(p_device_id uuid, p_actor_id uuid, p_gateway_id uuid, p_merge_into_device_id uuid, p_asset_name text, p_cell_id uuid, p_location_scope text, p_set_cell boolean, p_set_location_scope boolean, p_area_id uuid, p_set_area boolean) FROM PUBLIC, anon;

COMMENT ON FUNCTION public.approve_quarantined_device(p_device_id uuid, p_actor_id uuid, p_gateway_id uuid, p_merge_into_device_id uuid, p_asset_name text, p_cell_id uuid, p_location_scope text, p_set_cell boolean, p_set_location_scope boolean, p_area_id uuid, p_set_area boolean) IS 'Atomically approves or merges a quarantined device. Re-checks the actor role against public.user_roles and attributes the resulting audit_trail rows to that actor. Takes the four location scopes (gateway, cell, area_wide, site_wide); location is written only when answered. A scope of gateway clears the cell and the area, and a cell scope that names no cell is refused.';

-- -------------------------------------------------------------------------------------------------
-- 5. automations_document()
-- -------------------------------------------------------------------------------------------------
-- 0256's, with a device that follows a Site-Wide gateway named Site-wide as a Site-Wide one is.
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
               'place', CASE WHEN dl.location_source IN ('site_wide', 'followed_site') THEN 'Site-wide'
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

-- -------------------------------------------------------------------------------------------------
-- 6. relocate_devices()
-- -------------------------------------------------------------------------------------------------
-- 0165's, taking the fourth scope and refusing a cell move with no cell in its own words. Dropping a
-- device onto Unassigned used to be a cell move with no cell; that is now a move to `gateway`, which
-- clears the cell and the area, and the device follows its gateway. Nothing else changes: the
-- authority check, the batch limits, the all-or-nothing transaction and the audit rows are 0165's.
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
  PERFORM public.require_mfa();

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
      RAISE EXCEPTION 'move for device % must state location_scope (gateway, cell, area_wide or site_wide)', v_device_id
        USING ERRCODE = 'null_value_not_allowed';
    END IF;
    IF v_scope NOT IN ('gateway', 'cell', 'area_wide', 'site_wide') THEN
      RAISE EXCEPTION 'location_scope % is not valid for device %; expected gateway, cell, area_wide or site_wide',
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
    -- rejected: "site-wide, in cell 3" is an incompletely cleared form, not a refusal case. What
    -- cannot be forced is an area-wide move with no area and a cell move with no cell, which are
    -- refused. A move to `gateway` is how a device stops being pinned: it follows its gateway.
    IF v_scope IN ('site_wide', 'gateway') THEN
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
      IF v_cell IS NULL THEN
        RAISE EXCEPTION 'a cell move for device % must name cell_id', v_device_id
          USING ERRCODE = 'null_value_not_allowed';
      END IF;
    END IF;

    SELECT * INTO v_before FROM public.devices WHERE id = v_device_id FOR UPDATE;
    IF NOT FOUND THEN
      -- The whole batch fails: a half-applied rearrangement is what the batch exists to remove.
      PERFORM public.raise_not_found(
          format('device %s not found; no part of this batch was applied', v_device_id));
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
    -- The transaction the UPDATEs ran in, which log_audit_trail_event() stamped on every row it
    -- wrote; NULL when nothing changed, since the trigger then wrote no row.
    'causation_id', CASE WHEN v_applied > 0 THEN txid_current() ELSE NULL END,
    'requested',    v_len,
    'applied',      v_applied,
    'unchanged',    v_unchanged,
    'devices',      v_results
  );
END;
$$;

ALTER FUNCTION public.relocate_devices(p_moves jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.relocate_devices(p_moves jsonb) FROM PUBLIC, anon;

COMMENT ON FUNCTION public.relocate_devices(p_moves jsonb) IS 'Apply a batch of device relocations in ONE transaction, so the whole rearrangement shares a single audit_trail causation_id. A move states location_scope (gateway, cell, area_wide or site_wide) and, for cell, cell_id, and for area_wide, area_id. A gateway move clears the cell and the area: the device follows its gateway. Refuses the batch outright on an unknown device, cell or area, a duplicate device, a missing location_scope, an area_wide move with no area or a cell move with no cell -- a half-applied batch is the failure mode this exists to remove. Authority: Administrator or Shopfloor_Manager.';

-- -------------------------------------------------------------------------------------------------
-- 7. A cell that is deleted un-files its devices, as it always has
-- -------------------------------------------------------------------------------------------------
-- devices.cell_id is ON DELETE SET NULL, which now writes a cell scope with no cell and fails the
-- CHECK: the nightly purge could not delete an archived cell that a device behind a simulated gateway
-- still names, and nobody could delete one by hand. So the devices are moved to Follow Gateway first,
-- in the same statement's transaction, and the foreign key finds nothing left to clear. SECURITY
-- DEFINER because the person deleting the cell may not be able to update devices, and the foreign
-- key's own action never asked. The audit trigger records each device as the deleter's act.
CREATE OR REPLACE FUNCTION public.devices_follow_their_gateway_when_their_cell_is_deleted() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  UPDATE public.devices
     SET cell_id = NULL,
         location_scope = 'gateway'
   WHERE cell_id = OLD.id;
  RETURN OLD;
END;
$$;

ALTER FUNCTION public.devices_follow_their_gateway_when_their_cell_is_deleted() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.devices_follow_their_gateway_when_their_cell_is_deleted() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.devices_follow_their_gateway_when_their_cell_is_deleted() IS
  'BEFORE DELETE on cells: every device in the cell goes to Follow Gateway (no cell, scope gateway) '
  'before the foreign key''s SET NULL would write a cell scope with no cell and fail '
  'devices_cell_scope_names_a_cell (0293).';

SELECT public.replay_trigger('public.cells', 'trg_cells_devices_follow_their_gateway_on_delete', $ddl$
CREATE TRIGGER trg_cells_devices_follow_their_gateway_on_delete BEFORE DELETE ON public.cells FOR EACH ROW EXECUTE FUNCTION public.devices_follow_their_gateway_when_their_cell_is_deleted();
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_columns text;
  v_name    text;
BEGIN
  -- 0001 carries the value and the default. A file that only asserted them here would be undone by
  -- 0001 on the next boot, so this is where a change to either is caught.
  IF public.live_constraint_definition('public.devices'::regclass, 'devices_location_scope_valid')
       IS DISTINCT FROM 'CHECK ((location_scope = ANY (ARRAY[''cell''::text, ''site_wide''::text, ''area_wide''::text, ''gateway''::text])))' THEN
    RAISE EXCEPTION '0293: devices_location_scope_valid reads %, which does not admit exactly cell, site_wide, area_wide and gateway; 0001 carries it',
      coalesce(public.live_constraint_definition('public.devices'::regclass, 'devices_location_scope_valid'), 'nothing');
  END IF;
  IF (SELECT pg_get_expr(ad.adbin, ad.adrelid)
        FROM pg_attrdef ad
        JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum
       WHERE ad.adrelid = 'public.devices'::regclass AND a.attname = 'location_scope') IS DISTINCT FROM '''gateway''::text' THEN
    RAISE EXCEPTION '0293: devices.location_scope does not default to gateway; 0001 carries the default';
  END IF;

  FOR v_name IN SELECT unnest(ARRAY['devices_cell_scope_names_a_cell', 'devices_follow_gateway_has_no_place']) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.devices'::regclass AND conname = v_name AND convalidated) THEN
      RAISE EXCEPTION '0293: % is missing or NOT VALID on devices, so a row may still break it', v_name;
    END IF;
  END LOOP;
  IF public.live_constraint_definition('public.devices'::regclass, 'devices_cell_scope_names_a_cell')
       IS DISTINCT FROM 'CHECK (((location_scope <> ''cell''::text) OR (cell_id IS NOT NULL)))'
     OR public.live_constraint_definition('public.devices'::regclass, 'devices_follow_gateway_has_no_place')
       IS DISTINCT FROM 'CHECK (((location_scope <> ''gateway''::text) OR ((cell_id IS NULL) AND (area_id IS NULL))))' THEN
    RAISE EXCEPTION '0293: a CHECK on devices does not read as this file declares it';
  END IF;

  -- The views keep the columns their readers select by name. device_uns_paths's list comes first:
  -- mirror check 27 reads the first column list this file asserts for that view.
  SELECT string_agg(attname, ',' ORDER BY attnum) INTO v_columns
    FROM pg_attribute
   WHERE attrelid = 'public.device_uns_paths'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_columns IS DISTINCT FROM 'device_id,area_id,cell_id,enterprise,uns_path,skip_reason' THEN
    RAISE EXCEPTION '0293: device_uns_paths has the columns %, not the ones ingestion/uns_publish.py reads', v_columns;
  END IF;
  SELECT string_agg(attname, ',' ORDER BY attnum) INTO v_columns
    FROM pg_attribute
   WHERE attrelid = 'public.device_locations'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_columns IS DISTINCT FROM 'device_id,gateway_id,explicit_cell_id,gateway_cell_id,location_scope,effective_cell_id,location_source,cell_mismatch,explicit_area_id,effective_area_id' THEN
    RAISE EXCEPTION '0293: device_locations has the columns %, not the ones its readers select', v_columns;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.cells'::regclass
                    AND t.tgname = 'trg_cells_devices_follow_their_gateway_on_delete'
                    AND t.tgenabled <> 'D') THEN
    RAISE EXCEPTION '0293: trg_cells_devices_follow_their_gateway_on_delete is missing or disabled, so deleting a cell would fail on a device filed in it';
  END IF;
  IF has_function_privilege('anon', 'public.devices_follow_their_gateway_when_their_cell_is_deleted()', 'EXECUTE') THEN
    RAISE EXCEPTION '0293: anon may execute devices_follow_their_gateway_when_their_cell_is_deleted()';
  END IF;
  FOR v_name IN SELECT unnest(ARRAY['device_locations', 'device_uns_paths']) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class
                    WHERE oid = ('public.' || v_name)::regclass
                      AND 'security_invoker=true' = ANY (coalesce(reloptions, '{}'::text[]))) THEN
      RAISE EXCEPTION '0293: % does not run as its caller; it would bypass the RLS on devices', v_name;
    END IF;
    IF has_table_privilege('anon', ('public.' || v_name)::regclass, 'SELECT, INSERT, UPDATE, DELETE') THEN
      RAISE EXCEPTION '0293: anon holds a privilege on %', v_name;
    END IF;
  END LOOP;
END
$check$;

NOTIFY pgrst, 'reload schema';
