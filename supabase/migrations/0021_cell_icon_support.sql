-- =============================================================================================
-- Migration: 0021_cell_icon_support.sql
-- An optional icon on a shopfloor cell
-- =============================================================================================
--
-- WHY. Every cell card on the Overview map renders identically, so a floor of six cells is six
-- rectangles distinguished only by reading their names. An icon is the cheapest way to make the
-- map scannable -- a machining cell, a robot cell and a facility zone become recognisable at a
-- glance rather than after a read.
--
-- A CLOSED SET, ENFORCED BY A CHECK, and that is the load-bearing decision here. The column stores
-- a NAME, not markup and not a URL: the frontend maps it to a bundled SVG component. Left as free
-- text it would eventually hold an emoji, a path, or a URL to something off-site -- and the last of
-- those turns a cell label into a request the browser makes to a third party. The constraint is
-- what keeps this a lookup key rather than a rendering instruction.
--
-- 'Factory' IS THE DEFAULT AND IS NOT NULLABLE. A nullable icon would mean every consumer needs a
-- fallback, and the three that exist would drift; one default in the schema is one place.
--
-- The names match the frontend's icon registry (frontend/src/components/common/Icons.jsx). Adding
-- one means a new component AND a new value in the CHECK -- deliberately two steps, because a
-- value the UI cannot render is a cell that draws nothing.
-- =============================================================================================

\set ON_ERROR_STOP on

ALTER TABLE public.cells ADD COLUMN IF NOT EXISTS icon text NOT NULL DEFAULT 'Factory';

COMMENT ON COLUMN public.cells.icon IS
  'Icon key for this cell, rendered by the dashboard from a bundled SVG set. A closed set '
  '(see cells_icon_valid) rather than free text: the column is a lookup key, never markup or a URL.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cells_icon_valid'
  ) THEN
    ALTER TABLE public.cells
      ADD CONSTRAINT cells_icon_valid
      CHECK (icon IN (
        'Factory',        -- general cell
        'Bot',            -- robotic assembly
        'Cog',            -- CNC and machining
        'CircuitBoard',   -- PLC and controllers
        'Gauge',          -- metrology and quality
        'Building2',      -- BMS and facility
        'Truck',          -- AGV and logistics
        'Zap'             -- energy and power
      ));
    RAISE NOTICE '0021: added cells.icon with a closed value set.';
  END IF;
END;
$$;


-- ---------------------------------------------------------------------------------------------
-- Give the demonstrator's cells an icon that matches what is in them.
-- ---------------------------------------------------------------------------------------------
-- Matched on the CURRENT names, and skipped silently when a cell has been renamed or does not
-- exist. This is a nicety, not a correctness requirement -- a migration that failed the boot
-- because somebody renamed a cell would be trading a real property for a cosmetic one.
--
-- Guarded on `icon = 'Factory'` so an operator's own choice is never overwritten by a later boot.
UPDATE public.cells SET icon = 'Cog'
 WHERE icon = 'Factory' AND name ILIKE '%machining%';

UPDATE public.cells SET icon = 'Bot'
 WHERE icon = 'Factory' AND name ILIKE '%robot%';

UPDATE public.cells SET icon = 'Gauge'
 WHERE icon = 'Factory' AND (name ILIKE '%KPI%' OR name ILIKE '%quality%' OR name ILIKE '%metrolog%');

UPDATE public.cells SET icon = 'Truck'
 WHERE icon = 'Factory' AND (name ILIKE '%AGV%' OR name ILIKE '%logistic%');


DO $$
DECLARE
  v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad FROM public.cells WHERE icon IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION '0021 self-check: % cell(s) have a NULL icon despite the NOT NULL default', v_bad;
  END IF;

  RAISE NOTICE '0021 self-check passed: every cell carries an icon from the closed set.';
END $$;
