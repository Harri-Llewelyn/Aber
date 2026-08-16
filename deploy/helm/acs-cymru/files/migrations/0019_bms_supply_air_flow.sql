-- =============================================================================================
-- Migration: 0019_bms_supply_air_flow.sql
-- One more ASHRAE 223P metric: supply air flow
-- =============================================================================================
--
-- WHY SEPARATELY FROM 0018. That migration is the demonstrator's metric set as it was settled;
-- this is one concept the shopfloor simulator needed afterwards. Appending to 0018 would edit a
-- migration that has already run on stacks elsewhere, and every migration here is replayed on
-- every boot -- so a changed 0018 would apply silently on some stacks and not others depending on
-- what they had already inserted. New file, new number, same idempotency rules.
--
-- THE CONCEPT IS REAL AND IS SELECTED, NOT TYPED. `FlowSensor` is a class in the seeded 223P
-- ontology, so this joins it exactly as 0018 joins its vocabularies -- the inner join is what
-- stops a metric being created against an id nobody verified.
--
-- WHY NOT `BMS/SupplyAirFlow`, WHICH IS WHAT WAS ASKED FOR. Migration 0007 constrains a metric
-- name to '/'-delimited segments of alphanumerics and underscore, and the existing BMS rows are
-- SCREAMING_SNAKE (`BMS/ZONE_TEMPERATURE`, `BMS/ZONE_HUMIDITY`). Both spellings satisfy the
-- constraint; only one matches its neighbours. `name` is immutable, so a second convention in the
-- same group would be permanent -- and the group is how the dashboard buckets these.
--
-- THE SEMANTIC ID NAMES A SENSOR CLASS, NOT A QUANTITY, for the reason 0018's BMS block sets out:
-- 223P models a measurement as a Property attached to a Sensor, and this catalog has one flat name
-- per series with nowhere to hang that pair. Pointing at the sensor class is the closest honest
-- statement available.
-- =============================================================================================

\set ON_ERROR_STOP on

INSERT INTO public.metric_catalog (name, datatype, description, category, units, standard,
                                   semantic_id, semantic_id_type)
SELECT s.name, s.datatype, s.description, s.category, s.units, 'ASHRAE 223P', v.semantic_id, 'IRI'
  FROM (VALUES
    ('BMS/SUPPLY_AIR_FLOW', 10, 'Supply air volumetric flow rate', 'SAMPLE', 'LITER/SECOND',
     'FlowSensor')
  ) AS s(name, datatype, description, category, units, concept)
  JOIN public.ashrae223_vocabulary v ON v.name = s.concept
ON CONFLICT (name) DO NOTHING;


DO $$
DECLARE
  v_ok boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.metric_catalog
     WHERE name = 'BMS/SUPPLY_AIR_FLOW'
       AND standard = 'ASHRAE 223P'
       AND semantic_id IS NOT NULL
  ) INTO v_ok;

  IF NOT v_ok THEN
    RAISE EXCEPTION
      '0019 self-check: BMS/SUPPLY_AIR_FLOW is absent or carries no semantic id. The join against '
      'ashrae223_vocabulary matched nothing, which means the FlowSensor class was renamed or the '
      'vocabulary was re-keyed.';
  END IF;

  RAISE NOTICE '0019 self-check passed: BMS/SUPPLY_AIR_FLOW registered against 223P FlowSensor.';
END $$;
