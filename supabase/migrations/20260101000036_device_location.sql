-- Migration: 20260101000036_device_location.sql
-- Description: Decouple where an asset IS from how its data gets here. Adds an optional
--              devices.cell_id, a location_scope marker on devices and gateways, and the
--              device_locations view that resolves the effective cell in SQL.
--
-- THE DISTINCTION THIS DRAWS
--
-- `device -> gateway` is a DATA PATH. It is on the wire, in the Sparkplug topic, and it is what
-- telemetry is keyed through. `device -> cell` is a LOCATION -- an overlay that appears in no
-- topic and no payload. Until now the second was inherited entirely through the first, which
-- cannot express either of the two cases that motivated this:
--
--   * a virtual gateway (is_virtual, migration 0009) is a host-level proxy running on the
--     application stack. It has no honest cell, so every device behind it inherited an
--     arbitrary one;
--   * a site-scoped asset -- a BMS, an AGV, an ambient sensor -- has no single cell at all,
--     and saying it is in Bay 4 because its connector happens to live there is a lie the
--     database had no way to avoid telling.
--
-- NULL MEANS INHERIT, AND THE COLUMN HAS NO DEFAULT. This is the load-bearing decision.
--
-- A DEFAULT pointing at an "Unassigned" row would make inheritance unreachable: resolution is
-- COALESCE(device.cell_id, gateway.cell_id), so an explicit value always WINS, and a default
-- makes every value explicit. Concretely -- ingestion's quarantine_new_device() inserts every
-- auto-discovered device without a cell, and approve-quarantine sets gateway_id and not
-- cell_id, so with a default in place every approved device would be pinned in Unassigned
-- forever while appearing to have been filed correctly. Inheritance has to be the ABSENCE of
-- a decision, not a precedence rule competing with one.
--
-- ON DELETE SET NULL, NOT CASCADE. gateways.cell_id cascades (migration 0000) because a
-- gateway serving a demolished cell is genuinely orphaned. A device is not a child of its
-- location: deleting a cell must return its devices to the Unassigned queue, not destroy the
-- asset records, their birth history and their attached 3D models.
--
-- NEITHER LANE IS A cells ROW. "Unassigned" and "Site-Wide" are derived, exactly like device
-- tags, unmodelled metrics and gateway staleness. Pinned system rows in `cells` were
-- considered and rejected: `cells` is a full CRUD surface with archive, restore, retention
-- purge, Grafana URLs and attached documents, and a magic row leaks into all of it -- a
-- renameable UNIQUE `name` carrying semantics is the trap devices.asset_type was retired for,
-- and the pg_cron purge job (migration 0025) runs as superuser and would sail straight past
-- any RLS guard protecting it.
--
-- UNASSIGNED AND SITE-WIDE ARE DIFFERENT STATES AND MUST NOT MERGE. Unassigned is an absence
-- -- a work queue that should drain. Site-Wide is an assertion by an operator that this asset
-- has no single cell -- a permanent home. Collapsing them would make the queue undrainable.
-- That is what location_scope records, and it is why it is a marker rather than another cell.
--
-- SCOPE DOES NOT INHERIT; ONLY cell_id DOES. A device behind a Site-Wide gateway resolves to
-- Unassigned, not to Site-Wide. Site-Wide is a claim about a specific asset, and a physically
-- located machine reached through a host-run connector is the exact case this migration
-- exists to make expressible -- inheriting the connector's scope would silently answer the
-- question on the operator's behalf and hide the device from the queue that would have
-- prompted them. Marking such a device Site-Wide is one deliberate click.
--
-- NO IMMUTABILITY TRIGGER, and no NOT NULL. Where an asset sits is ordinary reconfiguration:
-- reversible, and changing no wire contract. This is the opposite of metric_catalog.name.

-- ---------------------------------------------------------------------------------------------
-- 1. devices.cell_id -- the explicit override
-- ---------------------------------------------------------------------------------------------

ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS cell_id UUID REFERENCES public.cells(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.devices.cell_id IS
  'Explicit location override. NULL means inherit from gateways.cell_id -- deliberately no '
  'default, since an explicit value wins over inheritance and a default would make '
  'inheritance unreachable. Resolve through public.device_locations, never by reading this '
  'column alone.';

-- Partial: the column is NULL for most devices by design, and the queries that use it are
-- equality filters for a specific cell ("which devices are in Bay 4"). Indexing the NULLs
-- would just be storing the Unassigned lane twice.
CREATE INDEX IF NOT EXISTS idx_devices_cell_id
  ON public.devices (cell_id) WHERE cell_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 2. location_scope -- the Site-Wide assertion, on both asset levels
-- ---------------------------------------------------------------------------------------------
--
-- 'cell' is the default and is NOT the same kind of default that was rejected for cell_id: it
-- says "this asset belongs in some cell", which is true of every asset until someone asserts
-- otherwise, and it leaves cell_id free to mean inherit. It is NOT NULL because there is no
-- third state -- an asset either has a cell-shaped location or it does not.

ALTER TABLE public.devices
  ADD COLUMN IF NOT EXISTS location_scope TEXT NOT NULL DEFAULT 'cell';
ALTER TABLE public.gateways
  ADD COLUMN IF NOT EXISTS location_scope TEXT NOT NULL DEFAULT 'cell';

COMMENT ON COLUMN public.devices.location_scope IS
  '''cell'' (located in, or awaiting, a cell) or ''site_wide'' (asserted to have no single '
  'cell -- BMS, AGV, ambient sensor). Distinct from cell_id IS NULL, which means undecided.';
COMMENT ON COLUMN public.gateways.location_scope IS
  '''cell'' or ''site_wide''. A site-wide gateway -- typically is_virtual -- is a host-level '
  'proxy with no physical cell. Scope is not inherited by its devices; they resolve to '
  'Unassigned until an operator files them.';

ALTER TABLE public.devices DROP CONSTRAINT IF EXISTS devices_location_scope_valid;
ALTER TABLE public.devices ADD CONSTRAINT devices_location_scope_valid
  CHECK (location_scope IN ('cell', 'site_wide'));

ALTER TABLE public.gateways DROP CONSTRAINT IF EXISTS gateways_location_scope_valid;
ALTER TABLE public.gateways ADD CONSTRAINT gateways_location_scope_valid
  CHECK (location_scope IN ('cell', 'site_wide'));

-- A closed set, mirrored by LOCATION_SCOPES in frontend/src/utils/cellResolution.js -- the same
-- keep-in-step obligation as semantic_id_type in migration 0029.

-- "It is in no particular cell" and "it is in Bay 4" cannot both be true. Without this the
-- view's CASE would silently ignore a populated cell_id on a site-wide row, which is the
-- worst of the three outcomes: the value is visible in the table, discarded on read, and
-- nothing anywhere says so. Rejecting the contradiction means the UI must clear the cell when
-- an operator marks an asset Site-Wide -- one write, and an honest one.
ALTER TABLE public.devices DROP CONSTRAINT IF EXISTS devices_site_wide_has_no_cell;
ALTER TABLE public.devices ADD CONSTRAINT devices_site_wide_has_no_cell
  CHECK (location_scope <> 'site_wide' OR cell_id IS NULL);

ALTER TABLE public.gateways DROP CONSTRAINT IF EXISTS gateways_site_wide_has_no_cell;
ALTER TABLE public.gateways ADD CONSTRAINT gateways_site_wide_has_no_cell
  CHECK (location_scope <> 'site_wide' OR cell_id IS NULL);

-- public.gateway_status selects g.*, expanded at creation time, so it does not know about the
-- column just added. Rebuild it now rather than leaving it a column short until the next boot
-- replays migration 0024. See that file for why this is a function call and not a CREATE OR
-- REPLACE VIEW.
SELECT public.ensure_gateway_status_view();

-- ---------------------------------------------------------------------------------------------
-- 3. device_locations -- resolution, in one place
-- ---------------------------------------------------------------------------------------------
--
-- The effective cell is not expressible as a PostgREST embed. `cells?select=*,gateways(devices(...))`
-- returns devices by inheritance, so a device explicitly placed in cell B whose gateway serves
-- cell A comes back under A, and no combination of embeds can express "unless the child
-- overrides". Every consumer would otherwise re-implement the COALESCE, and they would drift.
--
-- Read this flat and merge it client-side by device_id -- the same shape as device_schemas
-- (migration 0034), which is consumed exactly that way in api.js.
--
-- The column list is spelled out rather than using d.*, deliberately: see migration 0024 for
-- what a star-expanded view costs when the base table gains a column. Even so this is
-- DROP-then-CREATE, not CREATE OR REPLACE, so a future migration is free to reorder or remove
-- a column here instead of being restricted to appending.

DROP VIEW IF EXISTS public.device_locations;

CREATE VIEW public.device_locations
WITH (security_invoker = true) AS
SELECT
  d.id                                        AS device_id,
  d.gateway_id,
  d.cell_id                                   AS explicit_cell_id,
  g.cell_id                                   AS gateway_cell_id,
  d.location_scope,
  -- A site-wide asset resolves to no cell at all. The CHECK above guarantees its own cell_id
  -- is already NULL, so this is about not inheriting its gateway's.
  CASE
    WHEN d.location_scope = 'site_wide' THEN NULL
    ELSE COALESCE(d.cell_id, g.cell_id)
  END                                         AS effective_cell_id,
  -- Which arm answered. The UI needs this to say WHY a device is where it is: "inherited from
  -- Line 2 Gateway" and "set explicitly" look identical once resolved, but only one of them
  -- moves when the gateway is reassigned.
  CASE
    WHEN d.location_scope = 'site_wide' THEN 'site_wide'
    WHEN d.cell_id IS NOT NULL          THEN 'explicit'
    WHEN g.cell_id IS NOT NULL          THEN 'inherited'
    ELSE 'unassigned'
  END                                         AS location_source,
  -- The device is filed somewhere its own gateway does not serve. Legitimate -- a machine on a
  -- shared or host-run connector -- but also exactly what a mis-click looks like, so it is
  -- surfaced as a warning rather than prevented. The explicit value still wins.
  (d.location_scope = 'cell'
   AND d.cell_id IS NOT NULL
   AND g.cell_id IS NOT NULL
   AND d.cell_id <> g.cell_id)                AS cell_mismatch
FROM public.devices d
LEFT JOIN public.gateways g ON g.id = d.gateway_id;

COMMENT ON VIEW public.device_locations IS
  'Effective cell per device: explicit devices.cell_id, else inherited gateways.cell_id, else '
  'unassigned; site-wide assets resolve to no cell. Mirrors '
  'frontend/src/utils/cellResolution.js -- keep the two in step. Derived at read time and '
  'never stored, so editing a gateway''s cell reclassifies its devices immediately.';

-- security_invoker means the caller's own policies apply to BOTH base tables -- a reader needs
-- SELECT on devices and gateways, which the authenticated policies in migration 0000 grant.
-- Without it the view would run as its owner and hand out rows RLS would otherwise withhold.
--
-- REVOKE BEFORE GRANT, AND `authenticated` IS IN THE REVOKE. Supabase ships
-- ALTER DEFAULT PRIVILEGES granting ALL on new tables in `public` to anon and authenticated, so
-- a freshly created view arrives holding INSERT/UPDATE/DELETE/TRUNCATE before this file says a
-- word -- verified on this stack. Granting SELECT on top of that leaves the write privileges in
-- place and makes the grant read as if it were read-only when it is not. This view is not
-- auto-updatable (it joins and computes), so the writes would fail anyway, but a privilege that
-- misstates the intent is exactly the kind of thing a later, simpler view inherits silently.
-- gateway_status and device_schemas are in the same position; 0024 is corrected alongside this,
-- 0034 is left for a separate change.
REVOKE ALL ON public.device_locations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.device_locations TO authenticated;

-- REALTIME. Nothing to add to the publication: devices and gateways are already published with
-- REPLICA IDENTITY FULL (migration 0023), so the new columns ride along on the existing change
-- feed. A view cannot be published in any case. Note the consequence for subscribers -- a
-- device's effective cell can change without the device row changing at all, because its
-- gateway moved. Any tab rendering this must subscribe to gateways as well as devices; Cells,
-- Devices and Overview already do.

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------------------------
-- 4. Prove the resolution, rather than trusting the CASE was written correctly
-- ---------------------------------------------------------------------------------------------
--
-- Same self-verifying discipline as migration 0029's mutability probe, 0033's schema assertion
-- and 0035's path-shape probe. Every branch of the view is exercised against real rows, and
-- the contradiction CHECK is proven to reject. A silent error here would not surface as a
-- failure anywhere -- it would surface as devices quietly filed in the wrong cell.

-- THE PROBE IDS VARY IN THEIR LEADING BLOCK, AND THEY HAVE TO. sparkplug_id is
-- GENERATED ALWAYS AS 'dev' || substr(encode(uuid_send(id),'hex'), 1, 21) with a UNIQUE index
-- (migration 0014) -- the FIRST 21 of 32 hex characters, which is everything up to the first
-- character of the final block. Fixtures distinguished only by their trailing digits, the
-- obvious way to write them, all collapse to one wire identity and collide on
-- idx_devices_sparkplug_id. Migration 0035's probe never hit this because it needed only one
-- device.
DO $probe$
DECLARE
  cell_a       UUID := '00360001-0000-4000-8000-000000000000';
  cell_b       UUID := '00360002-0000-4000-8000-000000000000';
  gw           UUID := '00360003-0000-4000-8000-000000000000';
  dev_inherit  UUID := '00360004-0000-4000-8000-000000000000';
  dev_explicit UUID := '00360005-0000-4000-8000-000000000000';
  dev_orphan   UUID := '00360006-0000-4000-8000-000000000000';
  dev_site     UUID := '00360007-0000-4000-8000-000000000000';
  probe_ids    UUID[] := ARRAY[cell_a, cell_b, gw, dev_inherit, dev_explicit, dev_orphan, dev_site];
  r            RECORD;
  v_error      TEXT := NULL;
  rejected     BOOLEAN := FALSE;
BEGIN
  -- Residue from an interrupted previous run. Cells are matched by name too: the name is
  -- UNIQUE, so a row left behind under a different id would fail the insert below.
  DELETE FROM public.devices  WHERE id = ANY(probe_ids);
  DELETE FROM public.gateways WHERE id = ANY(probe_ids) OR name LIKE 'migration-0036-probe%';
  DELETE FROM public.cells    WHERE id = ANY(probe_ids) OR name LIKE 'migration-0036-probe%';

  INSERT INTO public.cells (id, name) VALUES
    (cell_a, 'migration-0036-probe-cell-a'),
    (cell_b, 'migration-0036-probe-cell-b');
  INSERT INTO public.gateways (id, name, cell_id) VALUES
    (gw, 'migration-0036-probe-gateway', cell_a);
  INSERT INTO public.devices (id, name, gateway_id, cell_id, location_scope) VALUES
    (dev_inherit,  'migration-0036-probe-inherit',  gw,   NULL,   'cell'),
    (dev_explicit, 'migration-0036-probe-explicit', gw,   cell_b, 'cell'),
    (dev_orphan,   'migration-0036-probe-orphan',   NULL, NULL,   'cell'),
    (dev_site,     'migration-0036-probe-site',     gw,   NULL,   'site_wide');

  -- (a) No explicit cell: the gateway's cell is inherited.
  SELECT * INTO r FROM public.device_locations WHERE device_id = dev_inherit;
  IF r.effective_cell_id IS DISTINCT FROM cell_a OR r.location_source <> 'inherited' THEN
    v_error := format('inheritance: expected (%s, inherited), got (%s, %s)',
                      cell_a, r.effective_cell_id, r.location_source);
  END IF;

  -- (b) An explicit cell wins over the gateway's, and the disagreement is reported rather
  --     than resolved away.
  SELECT * INTO r FROM public.device_locations WHERE device_id = dev_explicit;
  IF v_error IS NULL AND (r.effective_cell_id IS DISTINCT FROM cell_b
                          OR r.location_source <> 'explicit'
                          OR NOT r.cell_mismatch) THEN
    v_error := format('override: expected (%s, explicit, mismatch), got (%s, %s, %s)',
                      cell_b, r.effective_cell_id, r.location_source, r.cell_mismatch);
  END IF;

  -- (c) No gateway and no cell is the Unassigned work queue, not an error and not Site-Wide.
  SELECT * INTO r FROM public.device_locations WHERE device_id = dev_orphan;
  IF v_error IS NULL AND (r.effective_cell_id IS NOT NULL OR r.location_source <> 'unassigned') THEN
    v_error := format('unassigned: expected (NULL, unassigned), got (%s, %s)',
                      r.effective_cell_id, r.location_source);
  END IF;

  -- (d) Site-Wide resolves to no cell even though its gateway has one -- scope does not
  --     inherit, and neither does the gateway's cell once the assertion is made.
  SELECT * INTO r FROM public.device_locations WHERE device_id = dev_site;
  IF v_error IS NULL AND (r.effective_cell_id IS NOT NULL OR r.location_source <> 'site_wide') THEN
    v_error := format('site_wide: expected (NULL, site_wide), got (%s, %s)',
                      r.effective_cell_id, r.location_source);
  END IF;

  -- (e) The contradiction is rejected at write time, not tolerated and ignored on read.
  BEGIN
    UPDATE public.devices SET cell_id = cell_a WHERE id = dev_site;
  EXCEPTION WHEN check_violation THEN
    rejected := TRUE;
  END;
  IF v_error IS NULL AND NOT rejected THEN
    v_error := 'devices_site_wide_has_no_cell accepted a site-wide device with an explicit cell';
  END IF;

  -- Cleanup runs before the RAISE so a passing migration leaves nothing behind. psql runs each
  -- migration in autocommit, so the RAISE rolls back this DO block -- fixtures included, since
  -- they were created inside it -- rather than the whole file; the ALTERs above stay. That is
  -- the right split: the schema is sound, and ON_ERROR_STOP=1 in supabase-db-init still fails
  -- the boot. A stack that will not come up beats one that files assets in the wrong cell.
  DELETE FROM public.devices  WHERE id = ANY(probe_ids);
  DELETE FROM public.gateways WHERE id = ANY(probe_ids);
  DELETE FROM public.cells    WHERE id = ANY(probe_ids);
  -- log_digital_thread_event() fired for every one of those rows. The table is append-only and
  -- this migration replays on every boot, so its audit trail has to be removed with it.
  DELETE FROM public.digital_thread WHERE entity_id = ANY(probe_ids);

  IF v_error IS NOT NULL THEN
    RAISE EXCEPTION 'device_locations resolution is wrong -- %', v_error;
  END IF;
END $probe$;
