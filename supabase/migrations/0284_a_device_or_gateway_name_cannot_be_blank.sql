-- 0284: A device's name and a gateway's name cannot be blank.
--
-- devices.name and gateways.name were NOT NULL and nothing more, so '' and a name of spaces were
-- stored: through PUT /api/v1/devices and /gateways, PostgREST, an approved proposal, a machine
-- identity that may write, an import or a script. The row then showed as a blank line on its page,
-- a blank pin label on the Site Map and a blank entry in the search and the i3X address space.
-- Areas and cells already refuse an empty name (areas_name_topic_safe, cells_name_topic_safe).
--
--   * devices_name_not_blank and gateways_name_not_blank: btrim(name) <> ''. btrim removes spaces
--     only, so a name of tabs or line breaks is still stored.
--   * A row already blank is NEVER renamed here. Adding the CHECK would scan the table and fail on
--     it with a message that names no row, so the file looks first, in each table whose CHECK is not
--     yet there, and stops with every blank row named (table, id, Sparkplug id and what the name
--     holds). An operator gives each a name or deletes it, and upgrades again. A replay, with both
--     CHECKs in place, scans nothing.
--
-- Nothing else writes a blank name today: ingest_register_quarantined_device() refuses one, and a
-- replay lane's device is named after its original.
--
-- Reasoning: supabase/README.md, "A device's name and a gateway's name cannot be blank (0284)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. A row that is already blank stops the upgrade, and is named
-- -------------------------------------------------------------------------------------------------
DO $blank$
DECLARE
  v_rows text;
  v_count integer;
BEGIN
  SELECT string_agg(format('%s %s (Sparkplug id %s) holds %s', t.kind, t.id, t.sparkplug_id, t.shown),
                    E'\n' ORDER BY t.kind, t.id),
         count(*)
    INTO v_rows, v_count
    FROM (
      SELECT 'device' AS kind, d.id, d.sparkplug_id, format('%L', d.name) AS shown
        FROM public.devices d
       WHERE btrim(d.name) = ''
         AND NOT EXISTS (SELECT 1 FROM pg_constraint
                          WHERE conname = 'devices_name_not_blank'
                            AND conrelid = 'public.devices'::regclass)
      UNION ALL
      SELECT 'gateway', g.id, g.sparkplug_id, format('%L', g.name)
        FROM public.gateways g
       WHERE btrim(g.name) = ''
         AND NOT EXISTS (SELECT 1 FROM pg_constraint
                          WHERE conname = 'gateways_name_not_blank'
                            AND conrelid = 'public.gateways'::regclass)
    ) t;

  IF v_count > 0 THEN
    RAISE EXCEPTION '0284: % device(s) or gateway(s) have a blank name, and a name can no longer be blank', v_count
      USING DETAIL = v_rows,
            HINT = 'Give each row a name, or delete it if it was made by mistake, then upgrade again. '
                   'help/site/upgrading.md, "From 1.9.0, a device or a gateway cannot have a blank name" '
                   'has the query that lists them.';
  END IF;
END
$blank$;

-- -------------------------------------------------------------------------------------------------
-- 2. The two CHECKs
-- -------------------------------------------------------------------------------------------------
DO $c$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'devices_name_not_blank'
                AND conrelid = 'public.devices'::regclass
                AND public.live_constraint_definition(conrelid, conname) <> 'CHECK ((btrim(name) <> ''''::text))') THEN
    ALTER TABLE public.devices DROP CONSTRAINT devices_name_not_blank;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'devices_name_not_blank'
                    AND conrelid = 'public.devices'::regclass) THEN
    ALTER TABLE public.devices
        ADD CONSTRAINT devices_name_not_blank CHECK ((btrim(name) <> ''::text));
  END IF;
END $c$;

DO $c$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'gateways_name_not_blank'
                AND conrelid = 'public.gateways'::regclass
                AND public.live_constraint_definition(conrelid, conname) <> 'CHECK ((btrim(name) <> ''''::text))') THEN
    ALTER TABLE public.gateways DROP CONSTRAINT gateways_name_not_blank;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gateways_name_not_blank'
                    AND conrelid = 'public.gateways'::regclass) THEN
    ALTER TABLE public.gateways
        ADD CONSTRAINT gateways_name_not_blank CHECK ((btrim(name) <> ''::text));
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
  FOR v_table, v_name IN VALUES ('public.devices'::regclass, 'devices_name_not_blank'),
                                ('public.gateways'::regclass, 'gateways_name_not_blank') LOOP
    IF public.live_constraint_definition(v_table, v_name) IS DISTINCT FROM v_want THEN
      RAISE EXCEPTION '0284: % is missing or reads %, not %', v_name,
        coalesce(public.live_constraint_definition(v_table, v_name), 'nothing'), v_want;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = v_table AND conname = v_name AND NOT convalidated) THEN
      RAISE EXCEPTION '0284: % is NOT VALID, so a blank name may still be there', v_name;
    END IF;
  END LOOP;
END
$check$;

NOTIFY pgrst, 'reload schema';
