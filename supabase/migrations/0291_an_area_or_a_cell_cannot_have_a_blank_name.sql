-- 0291: An area's name and a cell's name cannot be blank.
--
-- areas_name_topic_safe and cells_name_topic_safe refuse an empty name and the characters / + and #,
-- and do not trim: name <> '' lets a name of spaces through. The dashboard's dialogs trim first, but
-- PostgREST, an approved proposal, a machine identity that may write, an import and a script do not.
-- An area's and a cell's name are segments of every Unified Namespace topic beneath them, so a name
-- of spaces made a topic segment of spaces. 0284 did the same for devices and gateways.
--
--   * areas_name_not_blank and cells_name_not_blank: btrim(name) <> ''. btrim removes spaces only,
--     so a name of tabs or line breaks is still stored. The two topic_safe CHECKs are not touched:
--     0001 declares them, replays first on every boot and drops a CHECK whose definition differs
--     from its own, so one redefined here would be put back and redefined again on every boot, and
--     would not keep its oid. A second CHECK per table has no such partner, so a replay keeps both.
--     An empty name now names areas_name_not_blank, which Postgres checks first, by name.
--   * cells_name_not_blank is VALIDATED. cells_name_topic_safe is NOT VALID, carried from the
--     database the baseline was dumped from, and stays so. The new rule is blankness alone, and the
--     stop below names every blank cell, so validating it can refuse nothing the stop has not named.
--     A cell that holds / + or # is a different rule, one cells_name_topic_safe never checked on
--     rows that were already there; this file does not start to.
--   * A row already blank is NEVER renamed here. Adding the CHECK would scan the table and fail on
--     it with a message that names no row, so the file looks first, in each table whose CHECK is not
--     yet there, and stops with every blank row named (table, id, when it was made and what the name
--     holds). An operator gives each a name or deletes it, and upgrades again. A replay, with both
--     CHECKs in place, scans nothing.
--
-- Nothing else writes a blank name: the dashboard's dialogs refuse one (placeNameProblem()), and no
-- function in the chain inserts an area or a cell.
--
-- Reasoning: supabase/README.md, "An area's name and a cell's name cannot be blank (0291)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. A row that is already blank stops the upgrade, and is named
-- -------------------------------------------------------------------------------------------------
DO $blank$
DECLARE
  v_rows text;
  v_count integer;
BEGIN
  SELECT string_agg(format('%s %s (made %s) holds %s', t.kind, t.id, t.made, t.shown),
                    E'\n' ORDER BY t.kind, t.id),
         count(*)
    INTO v_rows, v_count
    FROM (
      SELECT 'area' AS kind, a.id, coalesce(a.created_at::date::text, 'at an unknown date') AS made,
             format('%L', a.name) AS shown
        FROM public.areas a
       WHERE btrim(a.name) = ''
         AND NOT EXISTS (SELECT 1 FROM pg_constraint
                          WHERE conname = 'areas_name_not_blank'
                            AND conrelid = 'public.areas'::regclass)
      UNION ALL
      SELECT 'cell', c.id, coalesce(c.created_at::date::text, 'at an unknown date'), format('%L', c.name)
        FROM public.cells c
       WHERE btrim(c.name) = ''
         AND NOT EXISTS (SELECT 1 FROM pg_constraint
                          WHERE conname = 'cells_name_not_blank'
                            AND conrelid = 'public.cells'::regclass)
    ) t;

  IF v_count > 0 THEN
    RAISE EXCEPTION '0291: % area(s) or cell(s) have a blank name, and a name can no longer be blank', v_count
      USING DETAIL = v_rows,
            HINT = 'Give each row a name, or delete it if it was made by mistake, then upgrade again. '
                   'help/site/upgrading.md, "From 1.9.0, an area or a cell cannot have a blank name" '
                   'has the query that lists them.';
  END IF;
END
$blank$;

-- -------------------------------------------------------------------------------------------------
-- 2. The two CHECKs
-- -------------------------------------------------------------------------------------------------
DO $c$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'areas_name_not_blank'
                AND conrelid = 'public.areas'::regclass
                AND public.live_constraint_definition(conrelid, conname) <> 'CHECK ((btrim(name) <> ''''::text))') THEN
    ALTER TABLE public.areas DROP CONSTRAINT areas_name_not_blank;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'areas_name_not_blank'
                    AND conrelid = 'public.areas'::regclass) THEN
    ALTER TABLE public.areas
        ADD CONSTRAINT areas_name_not_blank CHECK ((btrim(name) <> ''::text));
  END IF;
END $c$;

DO $c$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'cells_name_not_blank'
                AND conrelid = 'public.cells'::regclass
                AND public.live_constraint_definition(conrelid, conname) <> 'CHECK ((btrim(name) <> ''''::text))') THEN
    ALTER TABLE public.cells DROP CONSTRAINT cells_name_not_blank;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'cells_name_not_blank'
                    AND conrelid = 'public.cells'::regclass) THEN
    ALTER TABLE public.cells
        ADD CONSTRAINT cells_name_not_blank CHECK ((btrim(name) <> ''::text));
  END IF;
END $c$;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_want text := 'CHECK ((btrim(name) <> ''''::text))';
  v_table regclass;
  v_name text;
BEGIN
  FOR v_table, v_name IN VALUES ('public.areas'::regclass, 'areas_name_not_blank'),
                                ('public.cells'::regclass, 'cells_name_not_blank') LOOP
    IF public.live_constraint_definition(v_table, v_name) IS DISTINCT FROM v_want THEN
      RAISE EXCEPTION '0291: % is missing or reads %, not %', v_name,
        coalesce(public.live_constraint_definition(v_table, v_name), 'nothing'), v_want;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = v_table AND conname = v_name AND NOT convalidated) THEN
      RAISE EXCEPTION '0291: % is NOT VALID, so a blank name may still be there', v_name;
    END IF;
  END LOOP;
END
$check$;

NOTIFY pgrst, 'reload schema';
