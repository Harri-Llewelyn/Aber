-- 0172: A 223P reading carries the QUDT quantity kind of what it reports, not a 223P class.
--
-- ASHRAE 223P is a reference here: its classes name equipment and substances, not readings. The
-- five example BMS metrics carried a sensor or substance class as their semantic id, so an AAS
-- consumer read a zone temperature as a temperature sensor. example-metrics.sql now gives each the
-- published QUDT quantity kind it reports; this repoints a database that holds the old ids, seeded
-- by 0002 up to 1.0.1 and by the example set since.
--
-- A row moves only when its name is one of the five and its id is still the class the seed gave
-- it, so an id an operator has changed is left alone. semantic_id is correctable in place
-- (test_metric_catalog_seed.py asserts it), so this is an UPDATE, and the audit trail records it.
-- No schema was ever seeded with one of these ids. A second boot matches nothing.

DO $$
DECLARE
  moved integer;
BEGIN
  WITH repoint(name, sensor_class, quantity_kind) AS (VALUES
    ('BMS/ZONE_TEMPERATURE', 'http://data.ashrae.org/standard223#TemperatureSensor',
     'http://qudt.org/vocab/quantitykind/Temperature'),
    ('BMS/ZONE_HUMIDITY', 'http://data.ashrae.org/standard223#HumiditySensor',
     'http://qudt.org/vocab/quantitykind/RelativeHumidity'),
    ('BMS/CO2_CONCENTRATION', 'http://data.ashrae.org/standard223#Constituent-CO2',
     'http://qudt.org/vocab/quantitykind/MoleFraction'),
    ('BMS/STATIC_PRESSURE', 'http://data.ashrae.org/standard223#PressureSensor',
     'http://qudt.org/vocab/quantitykind/Pressure'),
    ('BMS/SUPPLY_AIR_FLOW', 'http://data.ashrae.org/standard223#FlowSensor',
     'http://qudt.org/vocab/quantitykind/VolumeFlowRate')
  )
  UPDATE public.metric_catalog c
     SET semantic_id = r.quantity_kind,
         semantic_id_type = 'IRI'
    FROM repoint r
   WHERE c.name = r.name
     AND c.semantic_id = r.sensor_class;
  GET DIAGNOSTICS moved = ROW_COUNT;

  IF moved > 0 THEN
    RAISE NOTICE '0172: % example BMS metric(s) now carry a QUDT quantity kind in place of a 223P class.', moved;
  END IF;
END $$;
