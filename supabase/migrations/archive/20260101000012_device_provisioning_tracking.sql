-- Migration: 20260101000012_device_provisioning_tracking.sql
-- Description: Track whether a provisioned device has ever actually sent a DBIRTH, and let a
-- device be linked to a schema from the existing schema registry.
--
-- Without first_dbirth_at, a manually pre-provisioned device that never shows up is
-- indistinguishable from one that came online and later went offline (DDEATH) -- both just have
-- status = 'OFFLINE'. This column is written exactly once, by ingestion.py's process_dbirth(), on
-- the device's real first birth.
--
-- schema_id is optional: assigning a schema to a provisioned device lets the quarantine queue's
-- suggested-match feature compare a newly-quarantined device's reported metrics (asset_config)
-- against what a candidate provisioned device was expected to report.

ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS first_dbirth_at TIMESTAMPTZ;
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS schema_id UUID REFERENCES public.schemas(id) ON DELETE SET NULL;

NOTIFY pgrst, 'reload schema';
