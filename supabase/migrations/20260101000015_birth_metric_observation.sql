-- Migration: 20260101000015_birth_metric_observation.sql
-- Description: Record the metric names a device declared in its most recent DBIRTH, so the
-- platform can tell which of them its assigned schema does not account for.
--
-- This column stores an *observation*, never a verdict. The obvious alternative -- having the
-- ingestion daemon work out which metrics are unmodelled and write a flag -- was rejected for
-- two reasons:
--
--   1. It would go stale. Adding the missing metric to a schema would leave every affected
--      device flagged until its next DBIRTH, and rebirths are rare by design: a stable device
--      may not publish one for weeks. Deriving the verdict at read time means a schema edit
--      reclassifies its devices immediately.
--   2. It would flood the audit log. log_digital_thread_event() fires on every UPDATE to
--      `devices`, so re-writing the same verdict on every rebirth would append an audit row
--      each time to a table that is deliberately immutable and append-only.
--
-- The daemon therefore writes this column only when the declared set actually changes, which
-- makes each resulting digital_thread entry a real change in what the device publishes.
--
-- Distinct from `asset_config`, which is a per-metric upsert of birth parameter *values* and is
-- never pruned -- so it accumulates every metric ever seen, and drops metrics declared without
-- a value. This column is a faithful snapshot of the names declared at the most recent birth.
--
-- NULL means no birth has been observed yet; an empty array means a birth was observed that
-- declared no non-identity metrics. The distinction matters for the same reason first_dbirth_at
-- exists: "never seen" and "seen, and it had nothing to say" are different findings.

ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS last_birth_metrics TEXT[];
ALTER TABLE public.devices ADD COLUMN IF NOT EXISTS last_birth_metrics_at TIMESTAMPTZ;

NOTIFY pgrst, 'reload schema';
