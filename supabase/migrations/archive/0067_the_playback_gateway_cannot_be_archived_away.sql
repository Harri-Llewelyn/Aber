-- =============================================================================================
-- Migration: 0067_the_playback_gateway_cannot_be_archived_away.sql
-- Archiving the last shadow gateway breaks playback, and the failure arrives much later
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT GOES WRONG, AND WHY IT IS NOT OBVIOUS AT THE TIME
--
-- `ensure_shadow_devices()` (0060) finds the playback gateway BY ITS FLAG rather than by the pinned
-- id, deliberately -- two playbacks at once need two edge nodes, so an operator may add a second:
--
--     SELECT * INTO v_gateway FROM public.gateways
--      WHERE is_shadow AND NOT is_archived
--
-- Archive the only one and that query finds nothing. Playback then fails with "this stack has no
-- playback gateway", at the moment somebody starts a job -- which may be weeks after the archive,
-- by a different person, on a page that says nothing about gateways. The archive itself reports
-- success and looks like ordinary housekeeping.
--
-- Nothing else notices. 0060's self-check asserts the row exists and holds its flags; `is_archived`
-- is not among them, so db-init stays green. The seed's `ON CONFLICT DO UPDATE` restores the flags
-- and not the archive state, so the next boot does not undo it either.
--
-- ---------------------------------------------------------------------------------------------
-- THE RULE IS "NOT THE LAST ONE", NOT "NEVER"
--
-- Refusing outright would be easier and would be wrong: `ensure_shadow_devices()` looks the gateway
-- up by flag precisely so a stack can have more than one, and an operator swapping one shadow
-- gateway for another is doing something legitimate. So this refuses only the archive that would
-- leave NONE -- the same condition the function itself fails on, checked where it can still be
-- explained rather than where it is discovered.
--
-- The message names the way through, because a refusal an operator cannot act on is a wall: mark
-- another gateway `is_shadow` first, which is exactly what 0060's own error text suggests.
--
-- DELETION IS NOT GUARDED HERE. `0060` seeds the row on every boot, so a delete is repaired by the
-- next db-init rather than being silently permanent -- and the seed is the mechanism that makes
-- that true, which archive deliberately bypasses.
--
-- Related: 0060 (the gateway and ensure_shadow_devices), 0037 (what archiving withdraws),
--          frontend/src/components/tabs/GatewaysTab.jsx (the action this hides).
-- =============================================================================================

SET search_path TO public;

CREATE OR REPLACE FUNCTION public.refuse_archiving_the_last_shadow_gateway()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  -- ON THE TRANSITION ONLY. An ordinary edit to an already-archived gateway must not be refused,
  -- and neither must un-archiving one -- which is the repair this error tells an operator to make.
  IF NOT NEW.is_archived OR COALESCE(OLD.is_archived, false) THEN
    RETURN NEW;
  END IF;

  IF NOT NEW.is_shadow THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.gateways g
     WHERE g.is_shadow AND NOT g.is_archived AND g.id <> NEW.id
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'gateway % is the only playback gateway on this stack, and archiving it would leave broker '
    'playback with no edge node to publish as. ensure_shadow_devices() (0060) looks it up by the '
    'is_shadow flag, so the failure would arrive later, at the moment somebody starts a job. Mark '
    'another gateway is_shadow first, then archive this one.',
    NEW.name
    USING ERRCODE = 'restrict_violation';
END $$;

COMMENT ON FUNCTION public.refuse_archiving_the_last_shadow_gateway() IS
  'Refuses the archive that would leave a stack with no un-archived shadow gateway. Not a ban on '
  'archiving one: swapping in a replacement first is legitimate and is what 0060''s own error text '
  'tells an operator to do.';

DROP TRIGGER IF EXISTS trg_gateways_keep_a_playback_target ON public.gateways;
CREATE TRIGGER trg_gateways_keep_a_playback_target
BEFORE UPDATE OF is_archived ON public.gateways
FOR EACH ROW
EXECUTE FUNCTION public.refuse_archiving_the_last_shadow_gateway();


-- ---------------------------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------------------------
-- BOTH DIRECTIONS, because a guard that refuses everything is as broken as one that refuses
-- nothing -- and here the permissive half is the one with a real use behind it.
--
-- The probe is rolled back: every write below fires the digital-thread trigger, and that table is
-- append-only and cannot be pruned. 0038's idiom -- sub-block, sentinel, swallow only that.
-- ---------------------------------------------------------------------------------------------
DO $selfcheck$
DECLARE
  v_shadow uuid;
  v_spare  CONSTANT uuid := '00000000-0000-4000-8000-00000000f067';
  v_denied boolean;
BEGIN
  SELECT id INTO v_shadow FROM public.gateways
   WHERE is_shadow AND NOT is_archived ORDER BY created_at LIMIT 1;

  IF v_shadow IS NULL THEN
    RAISE NOTICE '0067 self-check: no live shadow gateway to probe against; skipping.';
    RETURN;
  END IF;

  BEGIN
    -- (a) The last one is refused.
    v_denied := false;
    BEGIN
      UPDATE public.gateways SET is_archived = true WHERE id = v_shadow;
    EXCEPTION WHEN restrict_violation THEN
      v_denied := true;
    END;
    IF NOT v_denied THEN
      RAISE EXCEPTION
        '0067 self-check: the only playback gateway was allowed to be archived. Playback would '
        'then fail at job time with an error naming a gateway nobody had touched.';
    END IF;

    -- (b) With a replacement present it is allowed, which is the swap this rule exists to permit.
    INSERT INTO public.gateways (id, name, deployment, is_simulated, is_shadow, location_scope)
    VALUES (v_spare, '0067 self-check spare', 'host', true, true, 'site_wide');

    UPDATE public.gateways SET is_archived = true WHERE id = v_shadow;
    IF NOT (SELECT is_archived FROM public.gateways WHERE id = v_shadow) THEN
      RAISE EXCEPTION
        '0067 self-check: archiving was refused even with a second shadow gateway present. The '
        'rule is "not the last one", not "never" -- swapping one in is legitimate.';
    END IF;

    RAISE EXCEPTION 'rollback_selfcheck';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'rollback_selfcheck' THEN RAISE; END IF;
  END;

  RAISE NOTICE
    '0067 self-check passed: the last playback gateway cannot be archived, and one with a '
    'replacement can. Probe rolled back, no audit rows written.';
END;
$selfcheck$;
