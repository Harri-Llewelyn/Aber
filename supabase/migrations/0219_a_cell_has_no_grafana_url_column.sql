-- 0219: A cell has no grafana_url column.
--
-- 1.7.0 deprecated `cells.grafana_url`: 0202 moved each cell's web address into its Attached Links,
-- as a link named Dashboard, and cleared the column. This drops the column, as 0175 dropped
-- devices.schema_id. All of it is guarded by the column's existence, so only the first boot after
-- the upgrade does anything; a fresh install and every later boot take no lock on cells.
--
--   * An http:// or https:// address an API client wrote since 0202 moves first, with 0202's
--     statement: a Dashboard link unless the cell already links to it, and the value cleared.
--   * Any other value 0202 kept is named in a NOTICE with its cell, then cleared by an UPDATE, so
--     that cell's audit row (actor_source 'migration') keeps it. A blank one just goes.
--   * Then the column is dropped.
--
-- The earlier files no longer name the column: 0001 does not create it, 0001 and 0165 declare
-- approve_proposal() without it, and 0202 moves only while it exists. So no replay brings it back,
-- and no boot has a moment when a live function names a column that is gone.
--
-- Reasoning: supabase/README.md, "A cell has no grafana_url column (0219)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. What the column still holds moves or is recorded, then the column goes
-- -------------------------------------------------------------------------------------------------
-- One statement, so one transaction: if a step fails, the column and every value stay as they were.
DO $$
DECLARE
  v_linked  integer;
  v_cleared integer;
  v_kept    integer := 0;
  v_cell    record;
BEGIN
  -- PL/pgSQL plans each statement when it first runs it, so the ones below never meet the missing
  -- column.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
                  WHERE attrelid = 'public.cells'::regclass
                    AND attname = 'grafana_url' AND NOT attisdropped) THEN
    RETURN;
  END IF;

  -- 0202's statement, so a web address written since then reaches Attached Links.
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
    RAISE NOTICE '0219: % cell dashboard address(es) moved to Attached Links, as links named Dashboard: % linked now, % linked already.',
      v_cleared, v_linked, v_cleared - v_linked;
  END IF;

  -- What 0202 kept. The UPDATE writes the cell's audit row, whose old_data holds the whole value;
  -- the NOTICE quotes its first 200 characters.
  FOR v_cell IN
    SELECT c.id, c.name, c.grafana_url
      FROM public.cells c
     WHERE btrim(c.grafana_url) <> ''
     ORDER BY c.name, c.id
       FOR UPDATE
  LOOP
    RAISE NOTICE '0219: cell "%" (%) held grafana_url %, which is not a web address. It goes with the column, and the cell''s Audit Trail keeps it.',
      v_cell.name, v_cell.id, quote_literal(left(v_cell.grafana_url, 200));
    UPDATE public.cells SET grafana_url = NULL WHERE id = v_cell.id;
    v_kept := v_kept + 1;
  END LOOP;

  ALTER TABLE public.cells DROP COLUMN grafana_url;

  RAISE NOTICE '0219: cells.grafana_url dropped; % value(s) that were not web addresses are named above and kept in the Audit Trail.',
    v_kept;
END
$$;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute
              WHERE attrelid = 'public.cells'::regclass
                AND attname = 'grafana_url' AND NOT attisdropped) THEN
    RAISE EXCEPTION '0219: cells.grafana_url is still there';
  END IF;
  IF 'grafana_url' = ANY (public.proposable_columns('cells')) THEN
    RAISE EXCEPTION '0219: proposable_columns(''cells'') admits grafana_url, which cells no longer has';
  END IF;
  -- The live approve_proposal(), from 0165: one that set the column would fail every cell approval.
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = 'public.approve_proposal(uuid)'::regprocedure
                    AND prosecdef
                    AND 'search_path=public' = ANY (proconfig)
                    AND prosrc !~ '\mgrafana_url\M') THEN
    RAISE EXCEPTION '0219: approve_proposal() names grafana_url, or is not SECURITY DEFINER with its search_path pinned';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
