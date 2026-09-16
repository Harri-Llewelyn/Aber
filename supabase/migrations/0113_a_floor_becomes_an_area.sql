-- 0113: a floor becomes an area.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- A floor was a row of its own (`area_floors`), and the Site Map drew one floor of an area at a
-- time. That hid every cell that was not on the floor being shown while the count beside it named
-- the whole area, so the level goes: every floor other than an area's ground floor becomes an area
-- of its own, and a cell takes its place on its area's plan.
--
-- `0098` describes the database this leaves. This file moves one that still has floors, and does
-- nothing on any boot after the one that moves it -- the split `0028` names, so that neither file
-- fights the other's replay.
--
-- PLANS DO NOT SURVIVE. A plan's object path names the floor it was uploaded for, and SQL cannot
-- move a storage object, so every area starts on the default outline and a NOTICE names the plans
-- to upload again. Cells that change area lose their place with it -- a place is a point on one
-- area's plan -- which place_cell_in_its_area() does on the move itself.
--
-- Area-Wide devices and gateways stay with the area they were marked in: the area row survives the
-- promotion, keeping its id, its name and everything pointed at it.

SET search_path TO public;

-- -------------------------------------------------------------------------------------------------
-- 1. Every floor above the ground floor becomes an area
-- -------------------------------------------------------------------------------------------------
DO $migrate$
DECLARE
    v_area     record;
    v_floor    record;
    v_keep     uuid;
    v_new_area uuid;
    v_name     text;
    v_moved    integer := 0;
    v_cells    integer := 0;
    v_created  integer := 0;
    v_rejected integer := 0;
    v_plans    text;
BEGIN
    IF to_regclass('public.area_floors') IS NULL THEN
        RETURN;
    END IF;

    -- Before anything moves: the plans that are about to stop being reachable, named as the
    -- operator knows them. A promoted floor is about to become an area of its own, so the pair is
    -- what identifies the drawing rather than either name alone.
    SELECT string_agg(a.name || ' / ' || f.name, ', ' ORDER BY a.name, f.level)
      INTO v_plans
      FROM public.area_floors f
      JOIN public.areas a ON a.id = f.area_id
     WHERE f.plan_path IS NOT NULL;

    -- An area no longer comes with a ground floor, and a promoted floor must not gain one of its
    -- own while the table is still standing.
    DROP TRIGGER IF EXISTS trg_areas_ground_floor ON public.areas;

    FOR v_area IN SELECT id, name, icon, description FROM public.areas ORDER BY name LOOP
        -- The floor the area keeps, which is the one the Site Map opened on: level 0, else the
        -- lowest above ground, else the highest basement. Mirrors groundFloor() in
        -- frontend/src/utils/floorPlans.js.
        SELECT id INTO v_keep
          FROM public.area_floors
         WHERE area_id = v_area.id
         ORDER BY (level = 0) DESC, (level > 0) DESC, abs(level) ASC
         LIMIT 1;

        FOR v_floor IN
            SELECT id, level, name
              FROM public.area_floors
             WHERE area_id = v_area.id AND (v_keep IS NULL OR id <> v_keep)
             ORDER BY level
        LOOP
            -- The new area's name has to pass areas_name_topic_safe and areas_name_key: a topic
            -- separator is replaced rather than stripped, so two names cannot collapse into one,
            -- and a collision is broken first by the level and then by the floor's id.
            v_name := btrim(regexp_replace(v_area.name || ' ' || v_floor.name, '[/+#]', ' ', 'g'));
            IF EXISTS (SELECT 1 FROM public.areas WHERE name = v_name) THEN
                v_name := v_name || ' (level ' || v_floor.level || ')';
            END IF;
            IF EXISTS (SELECT 1 FROM public.areas WHERE name = v_name) THEN
                v_name := v_name || ' ' || left(v_floor.id::text, 8);
            END IF;

            INSERT INTO public.areas (name, description, icon)
            VALUES (v_name, v_area.description, v_area.icon)
            RETURNING id INTO v_new_area;
            v_created := v_created + 1;

            UPDATE public.cells SET area_id = v_new_area WHERE floor_id = v_floor.id;
            GET DIAGNOSTICS v_moved = ROW_COUNT;
            v_cells := v_cells + v_moved;
        END LOOP;
    END LOOP;

    -- An open proposal naming `floor_id` proposes a move onto something that will not exist.
    -- REJECTED RATHER THAN EDITED: approve_proposal() merges a patch with jsonb_populate_record(),
    -- which IGNORES a key with no matching column, so a patch left alone would approve cleanly
    -- having relocated nothing. The proposer is told what happened and can propose the area.
    PERFORM set_config('acs_cymru.proposal_transition', 'on', true);
    UPDATE public.change_proposals
       SET status          = 'rejected',
           decided_at      = now(),
           decision_reason = 'Floors were retired while this was open: each floor became an area '
                             'of its own, and a cell is filed into an area rather than onto a '
                             'floor. Propose the move again, naming the area.'
     WHERE status = 'open'
       AND entity_type = 'cells'
       AND patch ? 'floor_id';
    GET DIAGNOSTICS v_rejected = ROW_COUNT;

    RAISE NOTICE '0113: % floor(s) became areas, % cell(s) moved onto them, % proposal(s) rejected.',
        v_created, v_cells, v_rejected;
    IF v_plans IS NOT NULL THEN
        RAISE NOTICE '0113: a plan is uploaded per area now, and these are not carried over -- '
                     'upload one again for: %', v_plans;
    END IF;
END
$migrate$;

-- -------------------------------------------------------------------------------------------------
-- 2. The floor stops being a thing
-- -------------------------------------------------------------------------------------------------
DO $drop$
BEGIN
    IF to_regclass('public.area_floors') IS NULL THEN
        RETURN;
    END IF;

    -- The column first: dropping it takes its foreign key, its index and cells_place_needs_a_floor
    -- with it, which is every reference to the table from `cells`.
    ALTER TABLE public.cells DROP COLUMN IF EXISTS floor_id;
    DROP TABLE public.area_floors CASCADE;
END
$drop$;

DROP FUNCTION IF EXISTS public.place_cell_on_its_floor();
DROP FUNCTION IF EXISTS public.guard_floor_delete();
DROP FUNCTION IF EXISTS public.area_gets_a_ground_floor();
DROP FUNCTION IF EXISTS public.floor_level_name(integer);

-- -------------------------------------------------------------------------------------------------
-- 3. Self-checks
-- -------------------------------------------------------------------------------------------------
DO $check$
BEGIN
    IF to_regclass('public.area_floors') IS NOT NULL THEN
        RAISE EXCEPTION '0113 self-check: area_floors is still a table';
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'cells' AND column_name = 'floor_id'
    ) THEN
        RAISE EXCEPTION '0113 self-check: cells.floor_id is still a column';
    END IF;

    IF 'floor_id' = ANY (public.proposable_columns('cells')) THEN
        RAISE EXCEPTION '0113 self-check: the cells proposal lane still admits floor_id';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.change_proposals
         WHERE status = 'open' AND entity_type = 'cells' AND patch ? 'floor_id'
    ) THEN
        RAISE EXCEPTION '0113 self-check: an open cells proposal still names floor_id';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'floor_level_name' AND pronamespace = 'public'::regnamespace) THEN
        RAISE EXCEPTION '0113 self-check: floor_level_name() is still declared';
    END IF;
END
$check$;
