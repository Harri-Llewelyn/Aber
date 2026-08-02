-- Migration: 20260101000020_drop_superseded_metrics.sql
-- Description: Delete the pre-MTConnect catalog entries outright, rather than leaving them
-- deprecated-but-present.
--
-- Migration 0019 marked them `deprecated` with `superseded_by` pointing at their replacement, which
-- is the correct treatment for a platform with real devices in the field: an integrator whose
-- hardware still publishes `temperature` needs to find that name and be told what it became. This
-- platform has no such devices -- it is a development deployment with no production data -- so the
-- entries are noise in the catalog rather than a migration aid, and are removed on request.
--
-- Deleting them is safe with respect to referential integrity:
--   * metric_catalog.superseded_by is the only foreign key into this table, and it points *from*
--     these rows *at* their replacements, so removing them leaves the replacements untouched.
--   * Nothing else references a metric by id. `schemas.schema_definition`, `asset_config` and
--     `telemetry` all key on the metric *name* as free text, so historical telemetry published
--     under the old names remains readable -- it simply has no catalog entry describing it, which
--     is exactly the "uncatalogued metric" state the Telemetry tab already renders as its own
--     optgroup.
--
-- The seed in migration 0013 is trimmed to match, so a fresh stack never creates them and this
-- delete is not re-fighting an insert on every restart.

DELETE FROM public.metric_catalog
 WHERE name IN (
   'temperature', 'vibration', 'status', 'safety_ok',
   'firmware_version', 'serial_number',
   'availability', 'performance', 'quality'
 );

NOTIFY pgrst, 'reload schema';
