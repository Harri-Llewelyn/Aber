-- 0114: archiving a gateway reaches the forge, and the row records that it did.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- =================================================================================================
-- WHAT THIS IS FOR (#197)
--
-- Archiving a gateway disabled its broker account (0038) and burned its unredeemed enrolment
-- tokens (0001), and forge-sweep removes its deploy key. Its repository stayed live: the
-- `appliance` branch still accepted a report, and in the forge's own listing a retired gateway
-- read exactly like one in service. The forge is where a gateway's flow and a plant's notes about
-- it live, so it was the one place an archived gateway was indistinguishable from a working one.
--
-- The sweep now archives that repository -- Gitea's own read-only mark, which keeps every branch,
-- issue and wiki page and badges the repository -- and takes it back out when the gateway is
-- restored. Nothing deletes a repository: a delete is a decision a person takes in the forge,
-- because the wiki is the one place a plant's notes about a gateway live, and the forge is in
-- every backup (scripts/backup-service.mjs).
--
-- =================================================================================================
-- WHERE THE CALL LIVES, WHICH WAS THE OPEN QUESTION
--
-- Not in a new edge function. The database holds no forge credential and reaches Gitea through
-- nothing; the one authorised path is forge-sweep, which already enumerates the organisation,
-- matches each repository to its gateway row and reconciles the deploy keys against `is_archived`.
-- The archive mark is the same reconciliation over the same data, so it belongs in the same pass.
--
-- What this file adds is the IMMEDIACY. The sweep runs every fifteen minutes (0099), and an
-- operator who archives a gateway should not read "still live" in the forge for a quarter of an
-- hour. The trigger below asks for one pass as the archive lands, through the pg_net call
-- sweep_forge() already makes, so an archive taken while the forge is down is retried by the timer
-- rather than lost -- the property the request asked for, without a second queue or a second
-- secret.
--
-- A DELETE FIRES NOTHING, deliberately. Only an archived gateway can be deleted -- the asset pages
-- archive and the Archived Entities page deletes what they archived, and `purge_expired_archives`
-- takes only rows whose retention timer has passed -- so its repository is already archived by the
-- time the row goes. The sweep archives a repository whose row is gone anyway, which covers a
-- gateway deleted by some other route.
--
-- =================================================================================================
-- WHY THE STAMP IS NOT OPTIMISTIC, WHERE credential_revoked_at IS
--
-- 0038 stamps `credential_revoked_at` in the trigger and lets the sweep clear it if pg_net never
-- recorded a 2xx: the request is the only evidence available inside that transaction.
--
-- `forge_archived_at` is written by forge-sweep instead, after the forge has answered. The reason
-- is that a stamp written here would be a claim about a component this deployment may not have at
-- all -- a stack with no forge, or with no repository for this gateway, would show every archived
-- gateway as archived in a forge that does not exist. The dashboard reads this column to say
-- whether the repository is read-only, and an unset one has to mean "not as far as anything here
-- knows".
-- =================================================================================================

SET search_path TO public;

ALTER TABLE public.gateways
    ADD COLUMN IF NOT EXISTS forge_archived_at timestamp with time zone;

COMMENT ON COLUMN public.gateways.forge_archived_at IS
    'When forge-sweep last saw this gateway''s repository in the forge''s archive -- read-only, every branch and wiki page kept. Written and cleared by the sweep, never by the trigger that asks for it: null means the repository is live, or that nothing has spoken to a forge about it. Set from is_archived, so restoring the gateway clears it on the next pass.';

-- -------------------------------------------------------------------------------------------------
-- The trigger: one sweep, as the archive lands
-- -------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sweep_forge_on_archive_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  -- SECURITY DEFINER because sweep_forge() is service_role's and an operator archiving a gateway
  -- is `authenticated`. It reaches no further than the sweep the schedule already runs.

  -- ON THE TRANSITION, IN EITHER DIRECTION. `UPDATE OF is_archived` fires whenever the column
  -- appears in a SET list, including when it is set to the value it already held, and an archived
  -- gateway is written to by ordinary edits -- so without this guard every such write would walk
  -- the whole forge. Both directions matter: restoring is what takes the repository back out.
  IF NEW.is_archived IS DISTINCT FROM COALESCE(OLD.is_archived, false)
     -- A gateway with no repository has nothing in the forge to follow. A host-run, simulated or
     -- shadow gateway never gets one, and neither does one enrolled on a deployment with no forge.
     -- A fleet enrolled before 0110 has repositories this column does not name yet; those converge
     -- on the timer, which is what the timer is for.
     AND NEW.forge_repository_at IS NOT NULL THEN
    PERFORM public.sweep_forge();
  END IF;
  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.sweep_forge_on_archive_change() IS
    'Ask forge-sweep for one pass when a gateway is archived or restored, so its repository follows within seconds rather than at the next quarter hour. Gated on the transition and on the gateway having a repository. ASYNCHRONOUS, like everything sweep_forge() does: the pass is queued, and the fifteen-minute schedule is what makes it eventually correct.';

REVOKE EXECUTE ON FUNCTION public.sweep_forge_on_archive_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_gateways_forge_follows_archive ON public.gateways;
CREATE TRIGGER trg_gateways_forge_follows_archive
    AFTER UPDATE OF is_archived ON public.gateways
    FOR EACH ROW EXECUTE FUNCTION public.sweep_forge_on_archive_change();

-- `gateway_status` is `SELECT g.*`, frozen at the view's creation; without this the column exists
-- on the table and is invisible through the view. check-docs-drift refuses a migration that adds
-- a gateways column and does not end this way.
SELECT public.ensure_gateway_status_view();

NOTIFY pgrst, 'reload schema';
