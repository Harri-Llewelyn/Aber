-- Migration: 20260101000013_metric_catalog.sql
-- Description: A catalog of individually-defined Sparkplug B metrics that schemas are built from.
--
-- name/datatype are the wire contract a real device is already configured against -- they are
-- immutable once created, enforced below at the DB level (not just the UI), mirroring
-- digital_thread's append-only pattern. "Editing" a metric's name or datatype means deprecating
-- it and creating a new entry, not rewriting the existing row.

CREATE TABLE IF NOT EXISTS public.metric_catalog (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    datatype INT NOT NULL,
    description TEXT,
    deprecated BOOLEAN NOT NULL DEFAULT FALSE,
    superseded_by UUID REFERENCES public.metric_catalog(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.enforce_metric_catalog_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name OR NEW.datatype IS DISTINCT FROM OLD.datatype THEN
    RAISE EXCEPTION 'metric_catalog.name and .datatype are immutable once created; deprecate this entry and create a new one instead';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_metric_catalog_immutability ON public.metric_catalog;
CREATE TRIGGER trg_metric_catalog_immutability
BEFORE UPDATE ON public.metric_catalog
FOR EACH ROW EXECUTE FUNCTION public.enforce_metric_catalog_immutability();

ALTER TABLE public.metric_catalog ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "metric_catalog_select_authenticated" ON public.metric_catalog;
CREATE POLICY "metric_catalog_select_authenticated" ON public.metric_catalog
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "metric_catalog_insert_privileged" ON public.metric_catalog;
CREATE POLICY "metric_catalog_insert_privileged" ON public.metric_catalog
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

DROP POLICY IF EXISTS "metric_catalog_update_privileged" ON public.metric_catalog;
CREATE POLICY "metric_catalog_update_privileged" ON public.metric_catalog
  FOR UPDATE TO authenticated
  USING (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']))
  WITH CHECK (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

REVOKE ALL ON public.metric_catalog FROM PUBLIC, anon;

-- Starter catalog. Only the two local extensions are seeded here: everything else the demo
-- publishes is an MTConnect data item type, seeded by 20260101000019 under its standard name
-- (`temperature` -> `Systems/TEMPERATURE`, and so on). The original ad-hoc names were removed
-- from this seed by 20260101000020 so a fresh stack never creates them.
--
-- These two have no MTConnect equivalent and are deliberately local: the standard defines only
-- AXIS_/CHUCK_/SPINDLE_INTERLOCK rather than a generic interlock, and it models a threshold as a
-- Constraint on a data item rather than as a data item of its own.
INSERT INTO public.metric_catalog (name, datatype, description) VALUES
  ('max_temp_threshold', 10, 'Configured maximum temperature threshold (local extension)'),
  ('safety_interlock', 11, 'Safety interlock present/enabled (local extension)')
ON CONFLICT (name) DO NOTHING;

NOTIFY pgrst, 'reload schema';
