-- Migration: 20260101000017_metric_group_vocabulary.sql
-- Description: A curated vocabulary of metric group names, and a database-level guard against
-- the same group being spelled two ways.
--
-- This table does NOT store a metric's group -- that is still derived from the metric's name by
-- the generated column added in migration 0016, and remains the only source of truth. This is a
-- registry of *approved spellings*: it gives the Add Metric form something to offer before any
-- metric uses a group, and it is the authority the spelling trigger below checks against.
--
-- Why the spelling guard is enforced here rather than only in the UI: metric names are immutable
-- (enforce_metric_catalog_immutability, migration 0013), so a group is immutable too. If `Robot`
-- and `robot` both reach the catalog, the taxonomy is permanently forked and the only remedy is
-- deprecating every metric on the wrong side of the split -- which means reconfiguring physical
-- devices. A constraint that can be bypassed by any API client is not good enough for a mistake
-- that cannot be undone. Same reasoning as the immutability trigger it sits beside.

CREATE TABLE IF NOT EXISTS public.metric_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Case-insensitive: the whole point is that `Robot` and `robot` cannot coexist.
CREATE UNIQUE INDEX IF NOT EXISTS uq_metric_groups_name_ci ON public.metric_groups (lower(name));

-- A group name is itself a name segment, so it cannot contain the separator or be blank.
ALTER TABLE public.metric_groups DROP CONSTRAINT IF EXISTS metric_groups_name_is_one_segment;
ALTER TABLE public.metric_groups ADD CONSTRAINT metric_groups_name_is_one_segment
  CHECK (name <> '' AND strpos(name, '/') = 0);

CREATE OR REPLACE FUNCTION public.enforce_metric_group_spelling()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  incoming_group TEXT;
  canonical TEXT;
BEGIN
  -- Derived from NEW.name rather than read from NEW.metric_group: generated columns are computed
  -- *after* BEFORE triggers run, so NEW.metric_group is still NULL at this point. Keep this
  -- expression identical to the generated column in migration 0016.
  incoming_group := CASE WHEN strpos(NEW.name, '/') > 0
                         THEN NULLIF(split_part(NEW.name, '/', 1), '') END;

  IF incoming_group IS NULL THEN
    RETURN NEW;  -- Ungrouped metrics are permitted; the convention is encouraged, not required.
  END IF;

  -- Checked against both the registry and the groups already in use, so a group that entered the
  -- catalog without being registered still governs the spelling of everything that follows it.
  SELECT known.name INTO canonical
    FROM (
      SELECT name FROM public.metric_groups
      UNION
      SELECT DISTINCT metric_group FROM public.metric_catalog WHERE metric_group IS NOT NULL
    ) AS known
   WHERE lower(known.name) = lower(incoming_group)
     AND known.name <> incoming_group
   LIMIT 1;

  IF canonical IS NOT NULL THEN
    RAISE EXCEPTION
      'metric group ''%'' differs only in case from the existing group ''%''. Metric names are '
      'immutable, so allowing both would permanently fork the taxonomy. Name this metric ''%/%'' '
      'instead.',
      incoming_group, canonical, canonical, substr(NEW.name, length(incoming_group) + 2);
  END IF;

  RETURN NEW;
END;
$$;

-- INSERT only: `name` is immutable, so an UPDATE can never change a metric's group.
DROP TRIGGER IF EXISTS trg_metric_group_spelling ON public.metric_catalog;
CREATE TRIGGER trg_metric_group_spelling
BEFORE INSERT ON public.metric_catalog
FOR EACH ROW EXECUTE FUNCTION public.enforce_metric_group_spelling();

ALTER TABLE public.metric_groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "metric_groups_select_authenticated" ON public.metric_groups;
CREATE POLICY "metric_groups_select_authenticated" ON public.metric_groups
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "metric_groups_insert_privileged" ON public.metric_groups;
CREATE POLICY "metric_groups_insert_privileged" ON public.metric_groups
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

DROP POLICY IF EXISTS "metric_groups_update_privileged" ON public.metric_groups;
CREATE POLICY "metric_groups_update_privileged" ON public.metric_groups
  FOR UPDATE TO authenticated
  USING (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']))
  WITH CHECK (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

REVOKE ALL ON public.metric_groups FROM PUBLIC, anon;

-- The starter vocabulary. Deliberately small: a taxonomy grows one considered entry at a time,
-- and every group seeded here is one an engineer will otherwise invent ad hoc under a slightly
-- different name. These describe what a metric is *about*, not which device reports it -- a CNC
-- that logs ambient temperature publishes an Environmental metric without being a sensor.
INSERT INTO public.metric_groups (name, description) VALUES
  ('Robot',         'Articulated arm and motion metrics -- axis positions, gripper state, tool centre point'),
  ('Environmental', 'Ambient conditions around the asset -- temperature, humidity, pressure, air quality'),
  ('Process',       'The physical process being run -- setpoints, feed rates, cycle counts'),
  ('OEE',           'ISO 22400 overall equipment effectiveness -- availability, performance, quality'),
  ('Safety',        'Interlocks, emergency stops, guard and light-curtain state'),
  ('Diagnostics',   'Device health and provenance -- firmware version, serial number, uptime, fault codes'),
  ('Energy',        'Power draw and consumption -- current, voltage, kWh')
ON CONFLICT (lower(name)) DO NOTHING;

NOTIFY pgrst, 'reload schema';
