-- 0098: a cell has a place on its area's plan.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- An area carries one plan -- the drawing of the space it occupies -- and a cell takes a place on
-- it as two fractions of the plan's viewBox (`plan_x` across, `plan_y` down). A filed cell with no
-- place is drawn beside the plan, not on it, so filing a cell into an area -- which is what puts
-- its devices under the right Unified Namespace topic -- never waits on somebody opening a
-- drawing.
--
-- The plan is an object in the private `floor-plans` bucket (scripts/storage-init.mjs,
-- supabase/storage-policies.sql). The row stores its path and aspect ratio, never markup: SVG is
-- active content, and the dashboard renders it through an <img>, where it can run nothing.
--
-- This file describes a fresh database. `0113` moves one that still has `area_floors`, from when
-- a floor was a row of its own. The split is `0028`'s: one migration creates and another moves,
-- so neither fights the other's replay.

SET search_path TO public;

-- -------------------------------------------------------------------------------------------------
-- 1. An area carries a plan
-- -------------------------------------------------------------------------------------------------
ALTER TABLE public.areas
    ADD COLUMN IF NOT EXISTS plan_path   text,
    ADD COLUMN IF NOT EXISTS plan_aspect numeric(8,4);

COMMENT ON COLUMN public.areas.plan_path IS 'Object path of the area''s plan in the floor-plans bucket, <area_id>/<file>.svg, or NULL for the default outline. A path, never markup.';
COMMENT ON COLUMN public.areas.plan_aspect IS 'Width over height of the plan''s viewBox, read at upload. Cell places are fractions of the plan, so the aspect is what turns them back into a distance; NULL with no plan, when the default 4:3 outline applies.';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.areas'::regclass AND conname = 'areas_plan_aspect_positive') THEN
        ALTER TABLE public.areas ADD CONSTRAINT areas_plan_aspect_positive
            CHECK (plan_aspect IS NULL OR plan_aspect > 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.areas'::regclass AND conname = 'areas_plan_has_aspect') THEN
        ALTER TABLE public.areas ADD CONSTRAINT areas_plan_has_aspect
            CHECK ((plan_path IS NULL) = (plan_aspect IS NULL));
    END IF;
END $$;

-- Whether a storage object path is `<area_id>/<file>.svg` for an area that exists. The floor-plans
-- write policies in supabase/storage-policies.sql call this; split_part rather than
-- storage.foldername(), which does not exist when db-init runs. STABLE and RLS-visible: every
-- signed-in role may read areas.
CREATE OR REPLACE FUNCTION public.is_floor_plan_path(p_name text) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT split_part(p_name, '/', 3) = ''
     AND split_part(p_name, '/', 2) ~* '^[^/]+\.svg$'
     AND EXISTS (
       SELECT 1 FROM public.areas a
        WHERE a.id::text = split_part(p_name, '/', 1)
     )
$$;
REVOKE ALL ON FUNCTION public.is_floor_plan_path(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_floor_plan_path(text) TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- 2. A cell takes a place on it
-- -------------------------------------------------------------------------------------------------
ALTER TABLE public.cells
    ADD COLUMN IF NOT EXISTS plan_x numeric(7,6),
    ADD COLUMN IF NOT EXISTS plan_y numeric(7,6);

COMMENT ON COLUMN public.cells.plan_x IS 'Where the cell sits on its area''s plan, as a fraction of the plan''s width, 0 at the left. NULL with plan_y is unplaced: the Site Map lists the cell beside the plan.';
COMMENT ON COLUMN public.cells.plan_y IS 'Fraction of the plan''s height, 0 at the top. Always set together with plan_x.';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.cells'::regclass AND conname = 'cells_place_is_a_pair') THEN
        ALTER TABLE public.cells ADD CONSTRAINT cells_place_is_a_pair
            CHECK ((plan_x IS NULL) = (plan_y IS NULL));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.cells'::regclass AND conname = 'cells_place_within_plan') THEN
        ALTER TABLE public.cells ADD CONSTRAINT cells_place_within_plan
            CHECK ((plan_x IS NULL OR (plan_x >= 0 AND plan_x <= 1)) AND (plan_y IS NULL OR (plan_y >= 0 AND plan_y <= 1)));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.cells'::regclass AND conname = 'cells_place_needs_an_area') THEN
        ALTER TABLE public.cells ADD CONSTRAINT cells_place_needs_an_area
            CHECK (plan_x IS NULL OR area_id IS NOT NULL);
    END IF;
END $$;

-- How far apart two places are, in units of the plan's shorter side, so one number in the
-- settings means the same on a wide plan and a tall one. Mirrored by planDistance() in
-- frontend/src/utils/floorPlans.js.
CREATE OR REPLACE FUNCTION public.plan_distance(p_x1 numeric, p_y1 numeric, p_x2 numeric, p_y2 numeric, p_aspect numeric) RETURNS numeric
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
    WHEN COALESCE(p_aspect, 4.0/3.0) >= 1
      THEN sqrt(power((p_x1 - p_x2) * COALESCE(p_aspect, 4.0/3.0), 2) + power(p_y1 - p_y2, 2))
    ELSE   sqrt(power(p_x1 - p_x2, 2) + power((p_y1 - p_y2) / COALESCE(p_aspect, 4.0/3.0), 2))
  END
$$;
REVOKE ALL ON FUNCTION public.plan_distance(numeric, numeric, numeric, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.plan_distance(numeric, numeric, numeric, numeric, numeric) TO authenticated, service_role;

SELECT public.seed_setting(
    'site_map.min_pin_spacing',
    to_jsonb(0.08),
    'number',
    'Site',
    'Minimum spacing between cells on an area plan',
    'How close two cells may be placed on one area plan, as a fraction of the plan''s shorter '
    'side: 0.08 is eight percent, about one pin''s width on a plan drawn a few hundred pixels '
    'tall. Refused at the write, on the Cells page and on an approved proposal alike.',
    'none: the placement is refused'
);
UPDATE public.system_settings
   SET min_value = 0, max_value = 0.5
 WHERE key = 'site_map.min_pin_spacing' AND (min_value IS DISTINCT FROM 0 OR max_value IS DISTINCT FROM 0.5);

-- A place needs an area, and two places in one area keep their distance. A place is a point on
-- one area's plan and says nothing on another's, so a cell moved between areas without being
-- given a new place loses the one it had; a move that names a place keeps what it names, which is
-- how the Cells page files and places in a single write.
CREATE OR REPLACE FUNCTION public.place_cell_in_its_area() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_aspect numeric;
    v_min    numeric;
    v_near   text;
BEGIN
    IF TG_OP = 'UPDATE'
       AND NEW.area_id IS DISTINCT FROM OLD.area_id
       AND NEW.plan_x IS NOT DISTINCT FROM OLD.plan_x
       AND NEW.plan_y IS NOT DISTINCT FROM OLD.plan_y THEN
        NEW.plan_x := NULL;
        NEW.plan_y := NULL;
    END IF;

    -- A place written with no area at all is left for cells_place_needs_an_area to refuse.
    IF NEW.area_id IS NULL OR NEW.plan_x IS NULL OR COALESCE(NEW.is_archived, false) THEN
        RETURN NEW;
    END IF;

    SELECT plan_aspect INTO v_aspect FROM public.areas WHERE id = NEW.area_id;

    SELECT (value #>> '{}')::numeric INTO v_min
      FROM public.system_settings WHERE key = 'site_map.min_pin_spacing';
    v_min := COALESCE(v_min, 0.08);

    SELECT c.name INTO v_near
      FROM public.cells c
     WHERE c.area_id = NEW.area_id
       AND c.id <> NEW.id
       AND c.plan_x IS NOT NULL
       AND NOT COALESCE(c.is_archived, false)
       AND public.plan_distance(NEW.plan_x, NEW.plan_y, c.plan_x, c.plan_y, v_aspect) < v_min
     ORDER BY public.plan_distance(NEW.plan_x, NEW.plan_y, c.plan_x, c.plan_y, v_aspect)
     LIMIT 1;
    IF v_near IS NOT NULL THEN
        RAISE EXCEPTION 'that place is too close to "%" on the same area plan; the minimum spacing is % of the plan''s shorter side', v_near, v_min
            USING ERRCODE = 'check_violation',
                  HINT = 'Move the pin further away, or change site_map.min_pin_spacing on the Settings page.';
    END IF;

    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.place_cell_in_its_area() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_cells_place_on_floor ON public.cells;
DROP TRIGGER IF EXISTS trg_cells_place_in_area ON public.cells;
CREATE TRIGGER trg_cells_place_in_area
    BEFORE INSERT OR UPDATE OF area_id, plan_x, plan_y, is_archived ON public.cells
    FOR EACH ROW EXECUTE FUNCTION public.place_cell_in_its_area();

-- -------------------------------------------------------------------------------------------------
-- 3. The integer floor goes
-- -------------------------------------------------------------------------------------------------
-- 0097 added `cells.floor`, a smallint that grouped the Overview. Nothing reads it: where a cell
-- is drawn is its place on its area's plan.
ALTER TABLE public.cells DROP COLUMN IF EXISTS floor;

-- -------------------------------------------------------------------------------------------------
-- 4. The proposal lanes admit the place
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
    -- admits. `area_id` and the place are where the cell is; the cells trigger decides whether the
    -- three agree.
    WHEN 'cells' THEN ARRAY['name', 'grafana_url', 'icon', 'area_id', 'plan_x', 'plan_y', 'description']

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

-- The 0097 body with the cells arm assigning the place. Column by column, allowlist only: a column
-- absent from the patch keeps the value jsonb_populate_record carried over.
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

        -- The table's CHECKs, the area foreign key and place_cell_in_its_area() run on this
        -- UPDATE, so a patch naming an icon nobody drew, a deleted area or a place too close to a
        -- neighbour aborts the approval rather than being stored.
        UPDATE public.cells
           SET name        = v_cell_new.name,
               grafana_url = v_cell_new.grafana_url,
               icon        = v_cell_new.icon,
               area_id     = v_cell_new.area_id,
               plan_x      = v_cell_new.plan_x,
               plan_y      = v_cell_new.plan_y,
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
-- 5. The Site Map hears about areas as they change
-- -------------------------------------------------------------------------------------------------
-- `areas` joins the Realtime publication so a plan attached on the Areas page reaches an open Site
-- Map at once rather than on the next poll. ADD TABLE, guarded on membership: 0001 SETs the whole
-- membership from its intended list on every replay, and names the table there. REPLICA IDENTITY
-- FULL for the same reason as the other published tables: Realtime evaluates RLS against the old
-- row too.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
         WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'areas'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.areas;
    END IF;
END $$;

ALTER TABLE public.areas REPLICA IDENTITY FULL;

-- -------------------------------------------------------------------------------------------------
-- 6. Self-checks
-- -------------------------------------------------------------------------------------------------
-- Nothing here asserts that `area_floors` is gone: 0113 drops it, and this file runs first on the
-- boot that does it.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'cells' AND column_name = 'floor'
    ) THEN
        RAISE EXCEPTION '0098 self-check: cells.floor is still a column';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'cells' AND column_name = 'plan_x'
    ) THEN
        RAISE EXCEPTION '0098 self-check: cells.plan_x is missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'areas' AND column_name = 'plan_path'
    ) THEN
        RAISE EXCEPTION '0098 self-check: areas.plan_path is missing';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_cells_place_in_area') THEN
        RAISE EXCEPTION '0098 self-check: trg_cells_place_in_area is missing';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_cells_place_on_floor') THEN
        RAISE EXCEPTION '0098 self-check: trg_cells_place_on_floor is still attached';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.system_settings WHERE key = 'site_map.min_pin_spacing') THEN
        RAISE EXCEPTION '0098 self-check: site_map.min_pin_spacing was not seeded';
    END IF;

    IF 'plan_x' <> ALL (public.proposable_columns('cells')) THEN
        RAISE EXCEPTION '0098 self-check: the cells proposal lane does not admit a place';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
         WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'areas'
    ) THEN
        RAISE EXCEPTION '0098 self-check: areas is not in the supabase_realtime publication';
    END IF;
END $$;
