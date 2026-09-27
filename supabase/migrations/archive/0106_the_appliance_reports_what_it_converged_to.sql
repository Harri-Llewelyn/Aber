-- 0106: what the appliance converged to, and what this gateway's own playbook did.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- =================================================================================================
-- WHAT THIS IS FOR
--
-- `acs-gateway-converge` runs on every appliance hourly: it runs the platform playbook at the tag
-- the gateway's own platform.yml names, then this gateway's `custom.yml` if its repository carries
-- one, and writes both outcomes to converged.json. flow-sync.mjs already pushes that file to the
-- `appliance` branch, so the forge holds it; these columns are what forge-events reads out of it on
-- that push, so the dashboard can say which platform version an appliance is actually on and
-- whether its own adapter is running.
--
-- The custom half is the point. A bespoke adapter is the failure this lane is most likely to
-- produce and least likely to notice: it is a container on somebody else's hardware, it has no
-- heartbeat of its own, and a gateway whose adapter is crash-looping keeps publishing and reads
-- ONLINE. Recorded here, it is a row in the drawer instead.
--
-- WHY NOT THE HEARTBEAT. The heartbeat carries what the appliance observes about itself over the
-- broker credential, and it is deliberately small: everything on it is a column the ingestion
-- daemon writes on every message. A convergence happens hourly and is already in the forge, so
-- reading it from the push costs nothing per message and adds no metric to the hot path.
-- =================================================================================================

ALTER TABLE public.gateways
    ADD COLUMN IF NOT EXISTS forge_appliance_platform_tag text,
    ADD COLUMN IF NOT EXISTS forge_appliance_platform_outcome text,
    ADD COLUMN IF NOT EXISTS forge_appliance_converged_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS forge_appliance_custom_outcome text,
    ADD COLUMN IF NOT EXISTS forge_appliance_custom_revision text;

COMMENT ON COLUMN public.gateways.forge_appliance_platform_tag IS
    'The platform playbook tag this appliance last converged to, from converged.json on the appliance branch. Compare with the platform''s own version to see a fleet mid-rollout. Null until the appliance has converged once.';
COMMENT ON COLUMN public.gateways.forge_appliance_platform_outcome IS
    'How that convergence ended: converged, failed, or refused (the appliance is not enrolled, or no file names a tag).';
COMMENT ON COLUMN public.gateways.forge_appliance_converged_at IS
    'When the appliance recorded that convergence, by its own clock. The clock offset gauge says how far that is from the platform''s.';
COMMENT ON COLUMN public.gateways.forge_appliance_custom_outcome IS
    'How this gateway''s own custom.yml ended: converged or failed. Null when its repository carries no playbook of its own, and when the platform run failed before one could be attempted.';
COMMENT ON COLUMN public.gateways.forge_appliance_custom_revision IS
    'The commit of the gateway''s own repository that custom.yml was run from. Null for the same reasons as the outcome beside it.';

-- `gateway_status` is `SELECT g.*`, frozen at the view's creation; without this the columns exist
-- on the table and are invisible through the view. check-docs-drift refuses a migration that adds
-- a gateways column and does not end this way.
SELECT public.ensure_gateway_status_view();

NOTIFY pgrst, 'reload schema';
