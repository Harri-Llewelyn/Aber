-- 0095: the forge says when `main` moved, and the gateway row remembers.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- =================================================================================================
-- WHAT THIS IS FOR
--
-- A gateway's flow lives in its own repository (forge.ts), and the appliance converges to `main`
-- on a timer. Between a merge and the next tick nothing on the dashboard knows the flow changed:
-- the row carries what the appliance last REPORTED (flow_hash, agent_version), never what the
-- forge holds. So a person who has just approved a pull request looks at a gateway that shows
-- nothing new, and the only way to see the commit was to open the forge.
--
-- Gitea delivers a webhook on every push (forge-events, registered on the repository at
-- enrolment), and these columns are what it records: the head of `main` -- its sha, its message,
-- who pushed it, when -- and the SHA-256 of `flows.json` at that head. The hash is the other half
-- of the drift check flow-sync.mjs calls "a dashboard concern": the appliance reports a flow hash,
-- the forge's head has one, and comparing them is a read of one row. The appliance's hash is the
-- flow flow-sync.mjs last deployed, read from /data/gitops/deployed.json by the flow every minute
-- and reported on the heartbeat; the gateway drawer makes the comparison.
--
-- COLUMNS ON gateways RATHER THAN A TABLE OF PUSHES. The dashboard reads `select *` on gateways,
-- one repository is one gateway, and "where is main" is a property of the gateway rather than an
-- event stream. A history is what the forge is for.
-- =================================================================================================

ALTER TABLE public.gateways
    ADD COLUMN IF NOT EXISTS forge_head_sha text,
    ADD COLUMN IF NOT EXISTS forge_head_message text,
    ADD COLUMN IF NOT EXISTS forge_head_by text,
    ADD COLUMN IF NOT EXISTS forge_head_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS forge_head_flow_sha256 text;

COMMENT ON COLUMN public.gateways.forge_head_sha IS
    'The commit at the head of main in this gateway''s repository, as the forge last reported it (forge-events, on every push). Null until the first push after the webhook existed.';
COMMENT ON COLUMN public.gateways.forge_head_message IS
    'First line of that commit''s message.';
COMMENT ON COLUMN public.gateways.forge_head_by IS
    'Who pushed it, as the forge names them: the email of the login that merged, or the committer of a push.';
COMMENT ON COLUMN public.gateways.forge_head_at IS
    'When that commit was made. The appliance deploys it on its next tick after this.';
COMMENT ON COLUMN public.gateways.forge_head_flow_sha256 IS
    'SHA-256 of flows.json at that head, or null if main carries none. flow_hash is the same digest for the flow the appliance last deployed, reported on its heartbeat; equal means the appliance has deployed what main holds.';

-- `gateway_status` is `SELECT g.*`, which Postgres froze at the view's creation: without this the
-- new columns exist on the table and are invisible through the view, silently. check-docs-drift
-- refuses a migration that adds a gateways column and does not end this way.
SELECT public.ensure_gateway_status_view();

-- PostgREST caches the schema; a column it has not seen is a column `select *` does not return.
NOTIFY pgrst, 'reload schema';
