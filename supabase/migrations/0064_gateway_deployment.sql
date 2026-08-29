-- =============================================================================================
-- Migration: 0064_gateway_deployment.sql
-- The axis the code actually branches on, given a column of its own
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- ---------------------------------------------------------------------------------------------
-- WHY, IN ONE SENTENCE: `is_virtual` carries three incompatible definitions and every behaviour
-- that branches on it is about a fourth thing.
--
-- Roadmap §15 sets this out in full and the evidence has since arrived on its own:
--
--   * `0025` and provision-gateways.mjs read it as "no physical edge appliance behind this row".
--   * `GatewaysTab.jsx` reads it as "this connector runs on the app host".
--   * The checkbox says "(Cloud / Server-Simulated)" -- which contradicts the second, since a
--     cloud connector is the one thing definitively not on the app host.
--
-- And the behaviours: the bundle is refused because there is no machine to carry it to; flow
-- backups are hidden because there is no appliance with a flow of its own to lose; the bundle modal
-- opens on create because a physical gateway needs one before it can publish. Every one of those is
-- about REMOTENESS. None is about virtuality.
--
-- ---------------------------------------------------------------------------------------------
-- THE COST OF LEAVING IT, PAID THREE TIMES IN TWO DAYS
--
-- `gateway_holds_a_credential()` is `NOT is_virtual AND enrolled_at IS NOT NULL`, and it has now
-- been the wrong predicate in three separate places:
--
--   * `0056` -- it refused every playback target, and had to add a second predicate to ask the
--     question it meant.
--   * `0062` (#91) -- the credential inventory reported nothing outstanding for gateways holding
--     live broker accounts.
--   * `0063` (#102) -- revocation never fired for a virtual gateway, so a deleted gateway's
--     credential went on publishing. Demonstrated end to end.
--
-- Each was fixed where it was found. A word that means three things does not get better with
-- another local fix, and this is the column those fixes should have been able to reach for.
--
-- ---------------------------------------------------------------------------------------------
-- TWO COLUMNS, NOT A THREE-WAY ENUM
--
-- `deployment` ('host' | 'remote') and `is_simulated` (already here, `0052`) express the three
-- varieties this stack wants -- a host connector to real devices, a remote appliance, and a
-- host-run simulator -- while leaving the fourth SAYABLE rather than unrepresentable. Folding them
-- into one enum welds two independent facts together and makes a simulator on a separate
-- load-generation box inexpressible.
--
-- The forbidden combination is stated as a cross-column CHECK rather than designed away, which is
-- the idiom already here: `gateways_site_wide_has_no_cell` is exactly this shape, and relaxing the
-- rule later is one line rather than a data migration.
--
-- ---------------------------------------------------------------------------------------------
-- THE RENAME IS NOT IN THIS FILE, DELIBERATELY
--
-- §15: "a rename smuggled in beside a feature is a rename nobody reviews". `is_virtual` still
-- exists, still means what it meant, and still has 126 references across 47 files -- the roadmap
-- prices it at 68 across 28, which was true when written and is corrected there in this change.
-- Retiring it is its own branch, and it needs this column to exist first.
--
-- UNTIL THEN THE TWO MUST NOT DRIFT, which is what `sync_gateway_deployment()` is for. It is
-- transitional by construction and its removal is part of that branch.
--
-- Related: 0001 (is_virtual), 0052 (is_simulated), 0059 (is_shadow and the lanes),
--          0063 (the most recent thing the ambiguity cost), README.md §15.
-- =============================================================================================

SET search_path TO public;

-- ---------------------------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------------------------
-- NO DEFAULT, AND THAT IS LOAD BEARING. The sync trigger below has to be able to tell "the caller
-- said nothing about deployment" from "the caller said host", and a DEFAULT makes those identical:
-- every INSERT would arrive carrying 'host' and every existing writer -- all of which set
-- `is_virtual` and none of which knows this column -- would silently create host gateways.
--
-- NULL is therefore the "unspecified" signal, and it survives only until the BEFORE INSERT trigger
-- fills it. NOT NULL is added after the backfill, and constraints are checked after BEFORE
-- triggers, so a row can never be committed without a value.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.gateways ADD COLUMN IF NOT EXISTS deployment text;

COMMENT ON COLUMN public.gateways.deployment IS
  'Where this gateway''s connector runs: ''host'' (inside this stack) or ''remote'' (an edge '
  'appliance on the plant network). This is the axis every behaviour branching on is_virtual was '
  'actually about -- bundles, flow backups, enrolment. Kept in step with is_virtual by '
  'sync_gateway_deployment() until that column is retired (roadmap 15).';

-- The backfill, and the mapping is the one §15 derives: `is_virtual` was already being used to mean
-- "no appliance out there", which is `host`.
UPDATE public.gateways
   SET deployment = CASE WHEN is_virtual THEN 'host' ELSE 'remote' END
 WHERE deployment IS NULL;

ALTER TABLE public.gateways ALTER COLUMN deployment SET NOT NULL;


-- ---------------------------------------------------------------------------------------------
-- 2. The constraints
-- ---------------------------------------------------------------------------------------------
-- DROP-then-ADD, the idempotent form this chain uses for constraints: `ADD CONSTRAINT IF NOT
-- EXISTS` does not exist in PostgreSQL, and a bare ADD fails on the second boot.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.gateways DROP CONSTRAINT IF EXISTS gateways_deployment_valid;
ALTER TABLE public.gateways ADD  CONSTRAINT gateways_deployment_valid
  CHECK (deployment = ANY (ARRAY['host'::text, 'remote'::text]));

-- THE CROSS-COLUMN RULE §15 NAMES. A simulator is a process this stack runs; a "remote simulator"
-- would be a box on the plant network pretending to be a machine, which nothing here can provision,
-- observe or reason about. Stated where a reader will find it, and relaxed in one line if it ever
-- turns out to be wanted -- which is the whole argument for two columns rather than an enum.
ALTER TABLE public.gateways DROP CONSTRAINT IF EXISTS gateways_simulated_is_host;
ALTER TABLE public.gateways ADD  CONSTRAINT gateways_simulated_is_host
  CHECK (NOT is_simulated OR deployment = 'host');


-- ---------------------------------------------------------------------------------------------
-- 3. The transitional sync
-- ---------------------------------------------------------------------------------------------
-- EVERY WRITER TODAY SETS `is_virtual` AND NONE SETS `deployment`: provision-gateways.mjs, the
-- Gateways page's create modal, enroll-gateway, 0002's seed. They keep working unchanged and get a
-- correct `deployment` for free.
--
-- DEPLOYMENT WINS WHEN IT IS PRESENT, which is what makes this a migration path rather than a
-- second source of truth. A new writer naming `deployment` alone gets the `is_virtual` its
-- consumers still read; an old writer naming `is_virtual` alone gets the new column. On UPDATE
-- there is no third case to decide -- see the note in the function, which is the interesting part.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_gateway_deployment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_implied text;
BEGIN
  v_implied := CASE WHEN NEW.is_virtual THEN 'host' ELSE 'remote' END;

  IF TG_OP = 'INSERT' THEN
    -- Unspecified is NULL, because the column has no default. See the note on the ALTER above.
    IF NEW.deployment IS NULL THEN
      NEW.deployment := v_implied;
    ELSE
      NEW.is_virtual := (NEW.deployment = 'host');
    END IF;
    RETURN NEW;
  END IF;

  -- ON UPDATE, WHICHEVER COLUMN MOVED WINS, and there is no disagreement case to refuse. That was
  -- not obvious and the first version of this function guarded against one:
  --
  --   Both columns are two-valued and the row starts in agreement, so an update that changes BOTH
  --   necessarily flips both -- host/true to remote/false, or the reverse -- which agrees again. A
  --   caller naming one column and restating the other at its CURRENT value is indistinguishable
  --   from one that named a single column, because NEW carries the whole row either way.
  --
  -- So the guard was unreachable, and a test written to prove it fires is a test that cannot pass.
  -- Refusing something impossible reads as a rule a reader must hold in their head; this reads as
  -- the arithmetic it is. The INSERT arm above is different and does need its rule: `is_virtual`
  -- has a column default, so an insert naming only `deployment` arrives with both set and possibly
  -- disagreeing -- and there, deployment is the one the caller chose.
  IF NEW.deployment IS DISTINCT FROM OLD.deployment THEN
    NEW.is_virtual := (NEW.deployment = 'host');
  ELSIF NEW.is_virtual IS DISTINCT FROM OLD.is_virtual THEN
    NEW.deployment := v_implied;
  END IF;

  RETURN NEW;
END $$;

COMMENT ON FUNCTION public.sync_gateway_deployment() IS
  'Keeps gateways.deployment and gateways.is_virtual in agreement while both exist. Transitional: '
  'it goes when is_virtual does (roadmap 15). deployment wins when a caller names it; a caller '
  'naming both and disagreeing is refused.';

DROP TRIGGER IF EXISTS trg_gateways_sync_deployment ON public.gateways;
CREATE TRIGGER trg_gateways_sync_deployment
BEFORE INSERT OR UPDATE OF deployment, is_virtual ON public.gateways
FOR EACH ROW
EXECUTE FUNCTION public.sync_gateway_deployment();


-- ---------------------------------------------------------------------------------------------
-- 4. The view has to be rebuilt, and this migration is exactly why that rule exists
-- ---------------------------------------------------------------------------------------------
-- `public.gateway_status` is `SELECT g.*`, which PostgreSQL freezes at creation time: a column
-- added afterwards is invisible through the view and NOTHING ERRORS. `check-docs-drift.mjs`
-- enforces this for every migration adding a `gateways` column, and §15 predicted this change would
-- have to satisfy it twice -- once here and once when `is_virtual` goes.
-- ---------------------------------------------------------------------------------------------
SELECT public.ensure_gateway_status_view();


-- ---------------------------------------------------------------------------------------------
-- 5. Self-check
-- ---------------------------------------------------------------------------------------------
-- THE PROBE IS ROLLED BACK, 0038's and 0048's idiom: every INSERT and UPDATE below fires
-- `trg_gateways_digital_thread`, and `digital_thread` is append-only and cannot be pruned. A
-- self-check that committed would append rows to the audit trail on every boot. Only the sentinel
-- is swallowed, so a genuine assertion failure still stops db-init.
-- ---------------------------------------------------------------------------------------------
DO $selfcheck$
DECLARE
  v_gw     CONSTANT uuid := '00000000-0000-4000-8000-00000000f064';
  v_dep    text;
  v_virt   boolean;
  v_failed boolean;
BEGIN
  -- The view must expose the column, for the reason in section 4.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'gateway_status'
       AND column_name = 'deployment'
  ) THEN
    RAISE EXCEPTION
      '0064 self-check: public.gateway_status does not expose `deployment`. The view is SELECT g.*, '
      'frozen at creation -- it must be rebuilt by ensure_gateway_status_view() after the column is '
      'added, or every consumer reads a table that appears not to have it.';
  END IF;

  DELETE FROM public.gateways WHERE id = v_gw;

  BEGIN
    -- (a) An OLD writer -- is_virtual only, which is every writer in the repository today.
    INSERT INTO public.gateways (id, name, is_virtual, location_scope, status)
    VALUES (v_gw, '0064 self-check', true, 'site_wide', 'PENDING_ENROLLMENT');
    SELECT deployment INTO v_dep FROM public.gateways WHERE id = v_gw;
    IF v_dep <> 'host' THEN
      RAISE EXCEPTION
        '0064 self-check: an insert naming is_virtual=true produced deployment=%. Every writer in '
        'the repository names is_virtual and none names deployment; if they do not agree the two '
        'columns describe different fleets.', v_dep;
    END IF;

    -- (b) A NEW writer -- deployment only, which is what the rename will produce.
    UPDATE public.gateways SET deployment = 'remote' WHERE id = v_gw;
    SELECT is_virtual INTO v_virt FROM public.gateways WHERE id = v_gw;
    IF v_virt THEN
      RAISE EXCEPTION
        '0064 self-check: setting deployment=remote left is_virtual true. Consumers still read '
        'is_virtual, so they would go on treating a remote appliance as host-run.';
    END IF;

    -- (c) The old writer still wins its own way round.
    UPDATE public.gateways SET is_virtual = true WHERE id = v_gw;
    SELECT deployment INTO v_dep FROM public.gateways WHERE id = v_gw;
    IF v_dep <> 'host' THEN
      RAISE EXCEPTION '0064 self-check: setting is_virtual=true left deployment=%.', v_dep;
    END IF;

    -- (d) The cross-column rule refuses a remote simulator.
    v_failed := false;
    BEGIN
      UPDATE public.gateways SET is_simulated = true, deployment = 'remote' WHERE id = v_gw;
    EXCEPTION WHEN check_violation THEN
      v_failed := true;
    END;
    IF NOT v_failed THEN
      RAISE EXCEPTION
        '0064 self-check: a simulated gateway was allowed to be remote. gateways_simulated_is_host '
        'is what makes "simulator" mean a process this stack runs.';
    END IF;

    RAISE EXCEPTION 'rollback_selfcheck';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM <> 'rollback_selfcheck' THEN RAISE; END IF;
  END;

  RAISE NOTICE
    '0064 self-check passed: the view exposes deployment, both writer generations agree, and a '
    'remote simulator is refused. Probe rolled back, no audit rows written.';
END;
$selfcheck$;
