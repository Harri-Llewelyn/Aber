-- 0202: A cell's dashboard address is one of its links.
--
-- `cells.grafana_url` is left from the first cells table, when each demonstrator cell had a Grafana
-- dashboard. Attached Links (`links`) already holds any number of named addresses per cell, so this
-- file moves each address there and stops the column being used. It is deprecated in 1.7.0 and
-- dropped no sooner than 1.8.0, by a file of its own.
--
--   * Each cell's http:// or https:// address becomes a link named Dashboard, tagged other, in the
--     shape the Cells page writes (entity_type 'cell', the cell's id as text). Archived cells are
--     included. A cell that already has a link to the same address gets no second one.
--   * Each address moved, or already linked, is cleared from the column. So a replay finds nothing
--     left to move, and a Dashboard link somebody deleted stays deleted. A value an API client
--     writes later reaches Attached Links at the next boot.
--   * NULL and blank are skipped. Any other value is named in a NOTICE and stays in the column.
--   * proposable_columns() no longer admits grafana_url, so approve_proposal() refuses a patch
--     naming it.
--
-- `links` has no audit trigger, so a moved link names nobody. The `cells` UPDATE leaves one audit
-- row per cell, as actor_source 'migration'.
--
-- Reasoning: supabase/README.md, "A cell's dashboard address is one of its links (0202)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. grafana_url is not proposable
-- -------------------------------------------------------------------------------------------------
-- 0001's definition without grafana_url. The SET clause restates 0176's pin, which a CREATE OR
-- REPLACE would otherwise clear.
CREATE OR REPLACE FUNCTION public.proposable_columns(p_entity_type text) RETURNS text[]
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT CASE p_entity_type
    -- `area_id` joins `cell_id` and `location_scope`: the three together say where an asset sits,
    -- and the table's CHECKs decide whether the triple is sayable, so one proposal can relocate.
    WHEN 'devices' THEN ARRAY[
      'name', 'description', 'connection_method',
      'cell_id', 'area_id', 'location_scope', 'model_3d_path'
    ]
    WHEN 'device_nameplate' THEN ARRAY[
      'manufacturer_name', 'manufacturer_product_designation', 'manufacturer_product_type',
      'serial_number', 'year_of_construction', 'date_of_manufacture', 'hardware_version',
      'firmware_version', 'software_version', 'country_of_origin', 'uri_of_the_product'
    ]

    -- Every column of an area a person chooses; the other two are the platform's. `name` reaches
    -- MQTT as the <area> segment of every uns/ topic beneath it, which is why the table carries
    -- `areas_name_topic_safe` and a UNIQUE -- both run on the approval's UPDATE. `icon` is one of
    -- the eight names `areas_icon_valid` admits.
    WHEN 'areas' THEN ARRAY['name', 'description', 'icon']

    -- `icon` is one of eight names the CHECK on the table admits. `area_id` and the place are where
    -- the cell is; the cells trigger decides whether the three agree. `grafana_url` is deprecated:
    -- a cell's dashboard is one of its links.
    WHEN 'cells' THEN ARRAY['name', 'icon', 'area_id', 'plan_x', 'plan_y', 'description']

    WHEN 'gateways' THEN ARRAY['name', 'description', 'cell_id', 'area_id', 'location_scope', 'access_url']

    -- 'schemas' is absent on purpose, and so are the three link lanes 0108 withdrew: the empty
    -- array is how this function closes a lane.
    ELSE ARRAY[]::text[]
  END
$$;

COMMENT ON FUNCTION public.proposable_columns(p_entity_type text) IS
  'Which columns a change proposal may name, per entity type. An unknown or withdrawn entity type '
  'yields the empty array, so a lane nobody has written an allowlist for can propose nothing at all '
  'rather than everything. Withdrawn: schemas (0090) and the three link lanes (0108). Areas joined in '
  '0123. cells.grafana_url left in 0202, when its values moved to Attached Links.';

COMMENT ON COLUMN public.cells.grafana_url IS
  'Deprecated in 1.7.0, and removed no sooner than 1.8.0. Each cell''s http:// or https:// address '
  'moved to its Attached Links (links, entity_type ''cell'', display_name ''Dashboard'') and was '
  'cleared here, so it reads NULL. db-init moves a web address written here since at its next boot. '
  'Any other value stays, and db-init''s log names it. Not proposable; the dashboard neither shows '
  'nor writes it (0202).';

-- -------------------------------------------------------------------------------------------------
-- 2. Each web address moves to Attached Links, and is cleared here
-- -------------------------------------------------------------------------------------------------
-- One statement, so a link and the cleared value commit together. Compared and stored trimmed,
-- since a blank around an address is not part of it. The scheme test is the Attached Links form's.
DO $$
DECLARE
  v_linked  integer;
  v_cleared integer;
  v_cell    record;
BEGIN
  WITH moving AS (
    SELECT c.id, btrim(c.grafana_url) AS url
      FROM public.cells c
     WHERE btrim(c.grafana_url) ~ '^https?://'
       FOR UPDATE
  ), linked AS (
    INSERT INTO public.links (entity_type, entity_id, display_name, url, link_tag)
    SELECT 'cell', m.id::text, 'Dashboard', m.url, 'other'
      FROM moving m
     WHERE NOT EXISTS (SELECT 1 FROM public.links l
                        WHERE l.entity_type = 'cell'
                          AND l.entity_id = m.id::text
                          AND btrim(l.url) = m.url)
    RETURNING 1
  ), cleared AS (
    UPDATE public.cells c
       SET grafana_url = NULL
      FROM moving m
     WHERE c.id = m.id
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM linked), (SELECT count(*) FROM cleared)
    INTO v_linked, v_cleared;

  IF v_cleared > 0 THEN
    RAISE NOTICE '0202: % cell dashboard address(es) moved to Attached Links, as links named Dashboard: % linked now, % linked already.',
      v_cleared, v_linked, v_cleared - v_linked;
  END IF;

  -- Named on every boot until somebody changes it, as the drop will name it again.
  FOR v_cell IN
    SELECT c.id, c.name, c.grafana_url
      FROM public.cells c
     WHERE btrim(c.grafana_url) <> ''
       AND btrim(c.grafana_url) !~ '^https?://'
     ORDER BY c.name, c.id
  LOOP
    RAISE NOTICE '0202: cell "%" (%) keeps grafana_url %: it is not an http:// or https:// address, so it was not moved to Attached Links.',
      v_cell.name, v_cell.id, quote_literal(left(v_cell.grafana_url, 200));
  END LOOP;
END
$$;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_cells text[] := public.proposable_columns('cells');
BEGIN
  IF EXISTS (SELECT 1 FROM public.cells WHERE btrim(grafana_url) ~ '^https?://') THEN
    RAISE EXCEPTION '0202: a cell still holds a web address in grafana_url after the move';
  END IF;
  IF 'grafana_url' = ANY (v_cells) THEN
    RAISE EXCEPTION '0202: proposable_columns(''cells'') still admits grafana_url';
  END IF;
  IF NOT v_cells @> ARRAY['name', 'icon', 'area_id', 'plan_x', 'plan_y', 'description'] THEN
    RAISE EXCEPTION '0202: proposable_columns(''cells'') lost a column it admits: %', v_cells;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = 'public.proposable_columns(text)'::regprocedure
                    AND coalesce(proconfig, '{}') @> ARRAY['search_path=public']) THEN
    RAISE EXCEPTION '0202: proposable_columns() does not pin its search_path';
  END IF;
  IF position('(0202)' IN coalesce(col_description('public.cells'::regclass,
       (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'public.cells'::regclass AND attname = 'grafana_url' AND NOT attisdropped)), '')) = 0 THEN
    RAISE EXCEPTION '0202: cells.grafana_url does not carry this file''s comment';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
