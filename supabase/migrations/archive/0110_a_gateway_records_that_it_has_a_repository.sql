-- 0110: when a gateway's repository was created, so "enrolled" and "has a repository" are two
-- questions.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- =================================================================================================
-- WHAT THIS IS FOR
--
-- enroll-gateway sets `enrolled_at` in step 3 and creates the repository in step 4, and step 4 is
-- non-fatal by construction. So `enrolled_at IS NOT NULL` is necessary for a repository to exist
-- and not sufficient: it is also set when the deployment has no forge at all, when the appliance
-- sent no usable SSH public key, and when provisioning simply failed. A page reading `enrolled_at`
-- offers links to a repository that answers 404 -- and with no forge deployed, to whatever address
-- the frontend falls back to.
--
-- This column records step 4 instead of inferring it from step 3.
--
-- WHO WRITES IT. enroll-gateway on a successful provision, and forge-sweep for a repository it
-- finds whose row has none -- the sweep already enumerates the organisation and matches repositories
-- to gateway rows, so a stack that enrolled its fleet before this migration self-corrects on the
-- next pass rather than needing a backfill it cannot compute. Nothing clears it: a repository is
-- not deleted when a gateway is archived (its keys are, #197 is the open request to change that),
-- and a sweep that cannot reach the forge must not read as "the repository is gone".
-- =================================================================================================

ALTER TABLE public.gateways
    ADD COLUMN IF NOT EXISTS forge_repository_at timestamp with time zone;

COMMENT ON COLUMN public.gateways.forge_repository_at IS
    'When this gateway''s repository was created in the forge (enroll-gateway step 4), or when forge-sweep first saw it. Null means there is no repository to link to: no forge on this deployment, no SSH key sent at enrolment, or provisioning failed -- all of which leave enrolled_at set.';

-- Backfill only where a repository is PROVEN to exist: forge-events writes these columns from a
-- push, and a push requires the repository. Every other row is left null for the sweep to settle,
-- because no column on this table distinguishes "enrolled with no forge" from "enrolled with one".
UPDATE public.gateways
   SET forge_repository_at = COALESCE(forge_head_at, forge_appliance_at, enrolled_at)
 WHERE forge_repository_at IS NULL
   AND (forge_head_sha IS NOT NULL OR forge_appliance_sha IS NOT NULL);

-- `gateway_status` is `SELECT g.*`, frozen at the view's creation; without this the column exists
-- on the table and is invisible through the view. check-docs-drift refuses a migration that adds
-- a gateways column and does not end this way.
SELECT public.ensure_gateway_status_view();

NOTIFY pgrst, 'reload schema';
