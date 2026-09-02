-- =============================================================================================
-- 0059: two lanes for assets that are not on the shopfloor
-- =============================================================================================
--
-- `device_locations` answers WHERE an asset is, in the sense the Overview map needs: which card
-- does this chip belong on. It has four answers today -- `explicit`, `inherited`, `site_wide`,
-- `unassigned` -- and every asset whose data is not observed from a real machine currently lands
-- in `unassigned`, alongside the devices an operator genuinely has not filed yet.
--
-- THAT IS THE BUG THIS FIXES, AND IT IS A BUG ABOUT MEANING RATHER THAN ABOUT PLACEMENT.
-- Unassigned is a work queue: `needsCellAssignment()` returns true for it, the Devices page
-- surfaces it as an action, and `unassignedHint()` tells an operator how to clear it. Every hint
-- it can offer -- "pick a cell for this device", "set one on the Gateways page" -- is advice that
-- cannot be taken for a simulator or a playback target. They are not unfiled. They cannot be
-- filed. Leaving them in a queue that is supposed to drain makes the queue permanently non-empty
-- and trains an operator to ignore it, which costs the real entries their only signal.
--
-- 0052 DEFERRED THIS AND REGISTERED AN OBJECTION TO IT, which is answered here rather than
-- overridden: "that view answers WHERE an asset is, and this is not a location". The objection is
-- right about `is_simulated` -- provenance is not a place -- and wrong about the consequence. The
-- view does not report provenance; it reports which of six mutually exclusive answers to give when
-- asked where to draw this asset, and for a synthetic one the honest answer is "not on your
-- shopfloor". That IS a location answer, and it is the one currently being given as "nowhere yet".
--
-- ---------------------------------------------------------------------------------------------
-- TWO LANES RATHER THAN ONE, AND THE DISTINCTION IS PROVENANCE
-- ---------------------------------------------------------------------------------------------
-- A shadow gateway is necessarily simulated -- `start_playback_job()` (0056) refuses any target
-- where `is_simulated` is false -- so one lane would cover both, and the second lane has to earn
-- itself. It does:
--
--   * a SIMULATED spindle reporting 4000 RPM never turned. The reading is invented;
--   * a SHADOW spindle reporting 4000 RPM did turn, on a real machine, on the day the capture was
--     recorded. The reading is genuine and the ASSET is the fiction.
--
-- Both are "not a machine that is running right now", and they give opposite answers to "is this
-- number true" -- which is the question being asked at the moment anyone consults the lane. Someone
-- working out why a schema rejected a metric, or why a chart has a spike, is sent somewhere
-- completely different by "this was invented" than by "this is a recording of your own plant".
-- Collapsing them loses the only distinction the lane would be consulted for.
--
-- PRECEDENCE IS SHADOW > SIMULATED > SITE_WIDE > EXPLICIT > INHERITED > UNASSIGNED, most specific
-- first. Both flags are true of a shadow device, so without an explicit ordering it would land in
-- Simulated and the more informative lane would be unreachable -- silently, since both arms are
-- correct in isolation.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT HERE
-- ---------------------------------------------------------------------------------------------
-- Item 15's other halves, unchanged and still owed: `deployment` ('host' | 'remote'), the
-- `CHECK (NOT is_simulated OR deployment = 'host')` that needs both columns, and the `is_virtual`
-- rename whose blast radius is 68 references across 28 files. None of them is needed by a lane,
-- and bundling a rename beside a feature is how a rename becomes unreviewable.
--
-- Nothing here flips `is_simulated` on the three seeded `Sim_` gateways. They are `false` today and
-- stay `false`: setting them is a decision about what a demonstration fixture is for, and the
-- constraint below prices it honestly rather than making it silently.
--
-- IDEMPOTENT. ADD COLUMN IF NOT EXISTS, DROP-then-ADD for the constraints, CREATE OR REPLACE for
-- the view: db-init replays every migration on every boot in filename order.
--
-- Related: 0001 (device_locations, gateways_site_wide_has_no_cell, the inheritance precedent),
--          0052 (is_simulated, and the objection answered above),
--          0056 (playback refuses a non-simulated target),
--          frontend/src/utils/cellResolution.js (the mirror -- keep in step),
--          scripts/check-mirror-drift.mjs (which fails until both sides agree),
--          item 15 in README.md.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------------------------
-- ON THE GATEWAY, NOT THE DEVICE, for the reason 0052 sets out at length and this migration does
-- not restate: a device-level copy needs two triggers to stay honest, and inheritance gives the
-- containment rule for nothing. Devices inherit through `gateway_id` and carry no flag.
ALTER TABLE public.gateways
    ADD COLUMN IF NOT EXISTS is_shadow boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.gateways.is_shadow IS
  'True when this gateway exists only to publish recorded captures -- its devices are replay lanes '
  'for real machines rather than machines. Implies is_simulated (a CHECK enforces it), and takes '
  'precedence over it in device_locations: the readings are genuine, so "replayed" is more '
  'informative than "synthetic". Devices INHERIT this through gateway_id and carry no flag of '
  'their own (see 0052).';


-- ---------------------------------------------------------------------------------------------
-- 2. Two same-row constraints
-- ---------------------------------------------------------------------------------------------
-- A SHADOW GATEWAY IS SIMULATED BY DEFINITION, and stating it here rather than trusting the caller
-- is what keeps the view's precedence chain meaningful. `is_shadow AND NOT is_simulated` is a row
-- that would take the shadow lane while `start_playback_job()` refuses to publish to it -- an
-- asset in the replay lane that can never receive a replay.
ALTER TABLE public.gateways DROP CONSTRAINT IF EXISTS gateways_shadow_is_simulated;
ALTER TABLE public.gateways ADD CONSTRAINT gateways_shadow_is_simulated
    CHECK ((NOT is_shadow) OR is_simulated);

-- THE VIEW'S CASE MUST NEVER SILENTLY DISCARD A STORED VALUE. This is the rule
-- `devices_site_wide_has_no_cell` and `gateways_site_wide_has_no_cell` already state for the
-- site-wide arm, and the new arms need it for the same reason: a simulated gateway sitting in
-- Cell 1 would resolve to the Simulated lane, its stored `cell_id` would be dropped on the floor
-- by the CASE, and the Cells page would show a cell whose own gateway row says otherwise. Making
-- it unsayable is one line; detecting it later is a support conversation.
--
-- IT COVERS BOTH FLAGS, which is that decision being taken rather than deferred. 0064 prices
-- it honestly -- "an onboarding simulator GAINS from being visibly not-real, while a demonstration
-- fixture LOSES, because a shopfloor map showing an empty plant beside one Simulated bucket
-- demonstrates less than four populated cells did" -- and the answer taken here is the first: a
-- map that shows a plant which is not there is the more expensive of the two.
ALTER TABLE public.gateways DROP CONSTRAINT IF EXISTS gateways_synthetic_has_no_cell;

-- CLEARED BEFORE THE CONSTRAINT, because otherwise this migration cannot be applied to any stack
-- where the simulator has been flagged -- including this one, where the three seeded `Sim_` cell
-- gateways were marked simulated by hand. db-init replays every migration on every boot, so a
-- constraint that fails on live data is not a failed migration, it is a database that will not
-- come up.
--
-- THIS DISCARDS AN OPERATOR'S PLACEMENT, which is normally the thing provisioning is careful never
-- to do (see the "an operator who has deliberately moved a gateway owns that decision" arm in
-- scripts/provision-gateways.mjs). It is justified here only because the placement is no longer
-- expressible: the lane resolves ahead of the cell, so the stored value had already stopped being
-- read and clearing it makes the row say what the UI was already showing. It is reported, not
-- silent -- an operator reading db-init's output sees exactly what moved.
--
-- IDEMPOTENT by construction: the second run matches no rows.
DO $relocate$
DECLARE
    v_moved integer;
BEGIN
    WITH cleared AS (
        UPDATE public.gateways
           SET cell_id = NULL
         WHERE (is_simulated OR is_shadow) AND cell_id IS NOT NULL
        RETURNING name
    )
    SELECT count(*) INTO v_moved FROM cleared;

    IF v_moved > 0 THEN
        RAISE NOTICE
          '0059: cleared the cell on % synthetic gateway(s). Their devices now resolve to the '
          'Simulated lane rather than to a cell -- the shopfloor map shows what is actually on the '
          'shopfloor. Re-running scripts/provision-gateways.mjs will NOT put them back.', v_moved;
    END IF;
END;
$relocate$;

ALTER TABLE public.gateways ADD CONSTRAINT gateways_synthetic_has_no_cell
    CHECK (((NOT is_simulated) AND (NOT is_shadow)) OR cell_id IS NULL);


-- ---------------------------------------------------------------------------------------------
-- 3. Rebuild gateway_status
-- ---------------------------------------------------------------------------------------------
-- WITHOUT THIS THE COLUMN IS INVISIBLE AND NOTHING ERRORS. `gateway_status` is `SELECT g.*`, which
-- Postgres expands and FREEZES at creation time, so a column added afterwards never appears through
-- the view -- and since db-init replays in filename order, no earlier rebuild picks it up either.
-- The frontend reads gateways through this view. Asserted by scripts/check-docs-drift.mjs.
SELECT public.ensure_gateway_status_view();


-- ---------------------------------------------------------------------------------------------
-- 4. The lanes
-- ---------------------------------------------------------------------------------------------
-- MIRRORED BY frontend/src/utils/cellResolution.js, which resolves the same six answers in a
-- browser for rows that have not been read through this view -- optimistic updates, staged drags
-- on the Overview map, and every component test. check-mirror-drift.mjs pins the label set
-- literally and fails until both files agree, which is the intended cost of adding a lane.
--
-- The two new arms read the GATEWAY's flags while the four existing arms read the device's, and
-- that asymmetry is the inheritance working: there is no device-level override to consider, so
-- there is no NULL-means-inherit case here the way there is for cell_id.
--
-- `g.is_shadow` is null-safe by the LEFT JOIN's own logic: a device with no gateway yields NULL,
-- which is not true, so it falls through to the existing arms and lands in `unassigned` exactly as
-- it does today.
CREATE OR REPLACE VIEW public.device_locations WITH (security_invoker='true') AS
 SELECT d.id AS device_id,
    d.gateway_id,
    d.cell_id AS explicit_cell_id,
    g.cell_id AS gateway_cell_id,
    d.location_scope,
        CASE
            WHEN COALESCE(g.is_shadow, false) THEN NULL::uuid
            WHEN COALESCE(g.is_simulated, false) THEN NULL::uuid
            WHEN (d.location_scope = 'site_wide'::text) THEN NULL::uuid
            ELSE COALESCE(d.cell_id, g.cell_id)
        END AS effective_cell_id,
        CASE
            WHEN COALESCE(g.is_shadow, false) THEN 'shadow'::text
            WHEN COALESCE(g.is_simulated, false) THEN 'simulated'::text
            WHEN (d.location_scope = 'site_wide'::text) THEN 'site_wide'::text
            WHEN (d.cell_id IS NOT NULL) THEN 'explicit'::text
            WHEN (g.cell_id IS NOT NULL) THEN 'inherited'::text
            ELSE 'unassigned'::text
        END AS location_source,
    -- UNCHANGED, and deliberately not extended to the new lanes. A mismatch means "filed somewhere
    -- its own gateway does not serve", which is a question about two cells; a synthetic asset has
    -- neither, and gateways_synthetic_has_no_cell guarantees the gateway half is NULL anyway.
    ((d.location_scope = 'cell'::text) AND (d.cell_id IS NOT NULL) AND (g.cell_id IS NOT NULL) AND (d.cell_id <> g.cell_id)) AS cell_mismatch
   FROM (public.devices d
     LEFT JOIN public.gateways g ON ((g.id = d.gateway_id)));

COMMENT ON VIEW public.device_locations IS
  'Effective cell per device, and which arm answered. Precedence: shadow (a replay lane behind a '
  'playback gateway) and simulated (synthetic telemetry) resolve to NO cell and take priority over '
  'everything else; then site-wide assets, which have none by assertion; then explicit '
  'devices.cell_id, then inherited gateways.cell_id, else unassigned. The first two are the '
  'gateway''s flags and are inherited -- devices store no copy. Mirrors '
  'frontend/src/utils/cellResolution.js -- keep the two in step. Derived at read time and never '
  'stored, so flipping a gateway''s flag or cell reclassifies its devices immediately.';


-- ---------------------------------------------------------------------------------------------
-- 5. Self-check
-- ---------------------------------------------------------------------------------------------
-- WHAT CAN ACTUALLY FAIL IS THE DESIGN, NOT THE MECHANICS. Asserting that the view returns six
-- labels is asserting that CASE works. Two things here are decisions a later migration could
-- plausibly undo while looking reasonable in isolation:
--
--   * `devices.is_shadow` -- the same stored-copy mistake 0052 guards against for is_simulated,
--     and just as tempting, because "flag the replay device" reads as the obvious thing to do;
--   * the precedence order -- a rewrite that puts `simulated` first is a one-line edit that makes
--     the shadow lane unreachable while every test about simulated assets keeps passing.
--
-- The second is checked by resolution rather than by reading the definition: a row that is both
-- must report `shadow`.
DO $selfcheck$
DECLARE
    v_source text;
    v_shadow integer;
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'devices' AND column_name = 'is_shadow'
    ) THEN
        RAISE EXCEPTION
          '0059 self-check: devices.is_shadow exists. Whether a device is a replay lane is '
          'inherited from its gateway and must not be stored twice -- a CHECK cannot span two '
          'tables, so keeping a device-level copy honest needs a trigger on devices for insert and '
          're-parenting AND one on gateways for the flip. See 0052''s header.';
    END IF;

    -- Resolve a hypothetical row through the view's own CASE. Written as a query against no table
    -- so it costs nothing and needs no fixture to exist or be cleaned up.
    SELECT CASE
             WHEN t.is_shadow THEN 'shadow'
             WHEN t.is_simulated THEN 'simulated'
             WHEN t.location_scope = 'site_wide' THEN 'site_wide'
             ELSE 'other'
           END
      INTO v_source
      FROM (SELECT true AS is_shadow, true AS is_simulated, 'site_wide' AS location_scope) t;

    IF v_source <> 'shadow' THEN
        RAISE EXCEPTION
          '0059 self-check: precedence resolved to %, expected shadow. A gateway that is both '
          'shadow and simulated must report the shadow lane -- it is the more specific and the '
          'more informative answer, because the replayed readings are genuine.', v_source;
    END IF;

    SELECT count(*) INTO v_shadow FROM public.gateways WHERE is_shadow;
    RAISE NOTICE
      '0059 self-check: the shadow and simulated lanes resolve ahead of site_wide, devices carry '
      'no copy of either flag, and % gateway(s) are currently shadow.', v_shadow;
END;
$selfcheck$;
