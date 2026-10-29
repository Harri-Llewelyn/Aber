-- 0221: An area's plan can be turned in quarter turns, and the file stays as it was uploaded.
--
-- areas.plan_rotation is how far the dashboard turns the plan clockwise when it draws it: 0, 90,
-- 180 or 270 degrees. The SVG in the area-plans bucket is never rewritten, and neither are the
-- places on it: cells.plan_x and plan_y stay fractions of the drawing as uploaded, and the
-- dashboard turns the drawing and its pins together. So a turn writes one areas row and no cells
-- row, and place_cell_in_its_area() and plan_distance() are unchanged: the spacing is measured in
-- the plan's shorter side, which a quarter turn does not change.
--
--   * areas_plan_rotation_quarter_turn: the column holds 0, 90, 180 or 270.
--   * areas_plan_rotation_needs_a_plan: an area with no plan is not turned, as areas_plan_has_aspect
--     ties plan_aspect to plan_path. Removing a plan resets the turn for any client that writes
--     the row, and the default outline is never drawn turned.
--
-- The grants and policies are on the table, not its columns, so every signed-in reader reads the
-- column and those who may update an area (Administrator, Shopfloor Manager) write it.
-- trg_areas_audit_trail records a turn as it records any other change to an area.
--
-- Reasoning: supabase/README.md, "An area's plan can be turned (0221)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The column and its two CHECKs
-- -------------------------------------------------------------------------------------------------
-- A constant default, so adding the column to a table with rows rewrites none of them.
ALTER TABLE public.areas ADD COLUMN IF NOT EXISTS plan_rotation smallint DEFAULT 0 NOT NULL;
ALTER TABLE public.areas ALTER COLUMN plan_rotation SET DEFAULT 0;

DO $c$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'areas_plan_rotation_quarter_turn'
                AND conrelid = 'public.areas'::regclass
                AND public.live_constraint_definition(conrelid, conname) <> 'CHECK ((plan_rotation = ANY (ARRAY[0, 90, 180, 270])))') THEN
    ALTER TABLE public.areas DROP CONSTRAINT areas_plan_rotation_quarter_turn;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'areas_plan_rotation_quarter_turn'
                    AND conrelid = 'public.areas'::regclass) THEN
    ALTER TABLE public.areas
        ADD CONSTRAINT areas_plan_rotation_quarter_turn CHECK ((plan_rotation = ANY (ARRAY[0, 90, 180, 270])));
  END IF;
END $c$;

DO $c$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'areas_plan_rotation_needs_a_plan'
                AND conrelid = 'public.areas'::regclass
                AND public.live_constraint_definition(conrelid, conname) <> 'CHECK (((plan_path IS NOT NULL) OR (plan_rotation = 0)))') THEN
    ALTER TABLE public.areas DROP CONSTRAINT areas_plan_rotation_needs_a_plan;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'areas_plan_rotation_needs_a_plan'
                    AND conrelid = 'public.areas'::regclass) THEN
    ALTER TABLE public.areas
        ADD CONSTRAINT areas_plan_rotation_needs_a_plan CHECK (((plan_path IS NOT NULL) OR (plan_rotation = 0)));
  END IF;
END $c$;

COMMENT ON COLUMN public.areas.plan_rotation IS
  'How far the dashboard turns the area''s plan clockwise when it draws it: 0, 90, 180 or 270 '
  'degrees. The SVG stays as uploaded, and cells.plan_x and plan_y stay fractions of it, so a '
  'client that draws the plan turns the drawing and its pins together. At 90 and 270 the frame is '
  'drawn at 1 / plan_aspect, while a distance between places is still worked out with plan_aspect. '
  '0 while the area has no plan (areas_plan_rotation_needs_a_plan). Replacing the plan keeps it '
  '(0221).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_name text;
  v_want text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.areas'::regclass
                    AND attname = 'plan_rotation' AND NOT attisdropped
                    AND atttypid = 'smallint'::regtype AND attnotnull) THEN
    RAISE EXCEPTION '0221: areas.plan_rotation is missing, not smallint, or nullable';
  END IF;
  IF pg_get_expr((SELECT d.adbin FROM pg_attrdef d JOIN pg_attribute a
                     ON a.attrelid = d.adrelid AND a.attnum = d.adnum
                  WHERE d.adrelid = 'public.areas'::regclass AND a.attname = 'plan_rotation'),
                 'public.areas'::regclass) IS DISTINCT FROM '0' THEN
    RAISE EXCEPTION '0221: areas.plan_rotation does not default to 0, so a new area would be drawn turned';
  END IF;

  FOR v_name, v_want IN VALUES
      ('areas_plan_rotation_quarter_turn', 'CHECK ((plan_rotation = ANY (ARRAY[0, 90, 180, 270])))'),
      ('areas_plan_rotation_needs_a_plan', 'CHECK (((plan_path IS NOT NULL) OR (plan_rotation = 0)))') LOOP
    IF public.live_constraint_definition('public.areas'::regclass, v_name) IS DISTINCT FROM v_want THEN
      RAISE EXCEPTION '0221: % is missing or reads %, not %', v_name,
        coalesce(public.live_constraint_definition('public.areas'::regclass, v_name), 'nothing'), v_want;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.areas'::regclass
                AND conname IN ('areas_plan_rotation_quarter_turn', 'areas_plan_rotation_needs_a_plan')
                AND NOT convalidated) THEN
    RAISE EXCEPTION '0221: a plan_rotation CHECK is NOT VALID, so a row it refuses may still be there';
  END IF;

  -- Read and written through the table's own grants, which the dashboard's turn relies on.
  IF NOT has_column_privilege('authenticated', 'public.areas', 'plan_rotation', 'SELECT')
     OR NOT has_column_privilege('authenticated', 'public.areas', 'plan_rotation', 'UPDATE') THEN
    RAISE EXCEPTION '0221: authenticated cannot read or write areas.plan_rotation; the dashboard turns a plan with it';
  END IF;
  IF has_column_privilege('anon', 'public.areas', 'plan_rotation', 'SELECT') THEN
    RAISE EXCEPTION '0221: anon may read areas.plan_rotation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.areas'::regclass
                    AND tgname = 'trg_areas_audit_trail' AND NOT tgisinternal
                    AND tgenabled <> 'D'
                    AND tgtype & 16 = 16) THEN
    RAISE EXCEPTION '0221: trg_areas_audit_trail does not record an UPDATE of areas, so a turn would go unrecorded';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
