-- 0104: the appliance reports on a branch of its own, and the gateway row remembers where it is.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- =================================================================================================
-- WHAT THIS IS FOR
--
-- `main` in a gateway's repository is what was approved; `appliance` is what is running, written
-- only by the appliance (flow-sync.mjs pushes it with the deploy key, which the branch's protection
-- admits and nobody else's login does) and read by people in the forge. 0095 records the head of
-- `main` from the push webhook; these columns record the head of `appliance` from the same webhook,
-- beside it, so the drawer can say when the appliance last reported and link the forge's compare
-- view between the two, which is the drift diff in a form a person can read.
--
-- The heartbeat's `flow_hash` stays the dashboard's source of truth for what is deployed, because
-- it arrives over the broker credential. `forge_appliance_flow_sha256` is the digest of the
-- flows.json the appliance committed, which is the file Node-RED is running, so a value that
-- differs from `flow_hash` is an edit made in the appliance's own editor since the last deploy.
-- =================================================================================================

ALTER TABLE public.gateways
    ADD COLUMN IF NOT EXISTS forge_appliance_sha text,
    ADD COLUMN IF NOT EXISTS forge_appliance_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS forge_appliance_flow_sha256 text;

COMMENT ON COLUMN public.gateways.forge_appliance_sha IS
    'The commit at the head of the appliance branch in this gateway''s repository, as the forge last reported it (forge-events, on every push). Written only by the appliance. Null until it has pushed once.';
COMMENT ON COLUMN public.gateways.forge_appliance_at IS
    'When that commit was made: the last time the appliance reported what it is running.';
COMMENT ON COLUMN public.gateways.forge_appliance_flow_sha256 IS
    'SHA-256 of flows.json at that head: the flow Node-RED is running on the appliance. Differs from flow_hash when the flow was edited in the appliance''s editor after the last deploy.';

-- `gateway_status` is `SELECT g.*`, frozen at the view's creation; without this the columns exist
-- on the table and are invisible through the view. check-docs-drift refuses a migration that adds
-- a gateways column and does not end this way.
SELECT public.ensure_gateway_status_view();

NOTIFY pgrst, 'reload schema';
