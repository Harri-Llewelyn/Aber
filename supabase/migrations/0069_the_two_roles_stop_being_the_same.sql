-- =============================================================================================
-- Migration: 0069_the_two_roles_stop_being_the_same.sql
-- Shopfloor_Manager operates the shopfloor; Administrator operates the platform
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- Withdraws three permissions from Shopfloor_Manager and narrows the write policies they gate:
--
--     Manager KEEPS   devices, cells, gateways, links, quarantine view/approve/reject,
--                     telemetry, archives, digital thread -- the shopfloor
--     Manager LOSES   authz:manage    who has access
--                     schema:manage   what contract ingestion validates against
--                     gitops:manage   what gets deployed to the edge
--
-- A breaking change for a deployment where a Shopfloor_Manager does schema or GitOps work; the
-- repair is to make that person an Administrator.
--
-- No RLS policy reads `role_permissions`; the table is consumed by `usePermissions.js` alone,
-- so revoking a grant on its own hides a button and changes nothing at PostgREST. The seven
-- write policies `schema:manage` gates (`schemas` INSERT/UPDATE/DELETE, `metric_catalog` and
-- `metric_groups` INSERT/UPDATE) narrow here, in the same transaction. `gitops:manage` is
-- enforced by `ALLOWED_ROLES` in deploy-nodered. `authz:manage` has no write path yet: the
-- split is a prerequisite for the first role-assignment control.
--
-- A plain DELETE, not `one_shot_migrations`: nothing recreates these rows, so a second run
-- matches no rows.
-- =============================================================================================

SET search_path TO public;

-- ---------------------------------------------------------------------------------------------
-- 1. The three grants Shopfloor_Manager gives up
-- ---------------------------------------------------------------------------------------------
-- By id and not by name: role_permissions references the id and the frontend holds the same
-- literal, so a renamed permission does not stop this matching.
DELETE FROM public.role_permissions
 WHERE role_id = 2
   AND permission_id IN (
     'e012c345-6789-4c1d-8706-933e08544e39',  -- authz:manage
     'f123d456-7890-4c1d-8706-933e08544e40',  -- schema:manage
     'c234e567-8901-4c1d-8706-933e08544e41'   -- gitops:manage
   );

-- ---------------------------------------------------------------------------------------------
-- 2. The policies `schema:manage` actually gates
-- ---------------------------------------------------------------------------------------------
-- The names do not change: `_privileged` in this schema means "not everyone", and the authority
-- is in the predicate. DROP-then-CREATE is forced: 0001 recreates each of these wide on every
-- boot, and two policies for one command are OR'd.

-- The schema registry. Publishing a schema decides what ingestion accepts as conformant, which is
-- the whole of `schema:manage` -- see ingestion/README.md#schema-conformance.
DROP POLICY IF EXISTS schemas_insert_privileged ON public.schemas;
CREATE POLICY schemas_insert_privileged ON public.schemas
    FOR INSERT TO authenticated
    WITH CHECK (public.has_role(ARRAY['Administrator'::text]));

DROP POLICY IF EXISTS schemas_update_privileged ON public.schemas;
CREATE POLICY schemas_update_privileged ON public.schemas
    FOR UPDATE TO authenticated
    USING (public.has_role(ARRAY['Administrator'::text]))
    WITH CHECK (public.has_role(ARRAY['Administrator'::text]));

DROP POLICY IF EXISTS schemas_delete_privileged ON public.schemas;
CREATE POLICY schemas_delete_privileged ON public.schemas
    FOR DELETE TO authenticated
    USING (public.has_role(ARRAY['Administrator'::text]));

-- The metric catalog and its group registry, both written from the Schemas page's Add Metric
-- form and gated in the UI on SCHEMA_MANAGE. `metric_catalog.name` is immutable, so an INSERT
-- here is not a draft.
DROP POLICY IF EXISTS metric_catalog_insert_privileged ON public.metric_catalog;
CREATE POLICY metric_catalog_insert_privileged ON public.metric_catalog
    FOR INSERT TO authenticated
    WITH CHECK (public.has_role(ARRAY['Administrator'::text]));

DROP POLICY IF EXISTS metric_catalog_update_privileged ON public.metric_catalog;
CREATE POLICY metric_catalog_update_privileged ON public.metric_catalog
    FOR UPDATE TO authenticated
    USING (public.has_role(ARRAY['Administrator'::text]))
    WITH CHECK (public.has_role(ARRAY['Administrator'::text]));

DROP POLICY IF EXISTS metric_groups_insert_privileged ON public.metric_groups;
CREATE POLICY metric_groups_insert_privileged ON public.metric_groups
    FOR INSERT TO authenticated
    WITH CHECK (public.has_role(ARRAY['Administrator'::text]));

DROP POLICY IF EXISTS metric_groups_update_privileged ON public.metric_groups;
CREATE POLICY metric_groups_update_privileged ON public.metric_groups
    FOR UPDATE TO authenticated
    USING (public.has_role(ARRAY['Administrator'::text]))
    WITH CHECK (public.has_role(ARRAY['Administrator'::text]));

-- ---------------------------------------------------------------------------------------------
-- 3. Self-check
-- ---------------------------------------------------------------------------------------------
-- The read policies are asserted to have survived: a Shopfloor_Manager must go on reading
-- schemas and the metric catalog, or the Devices page cannot show what a device conforms to.
DO $selfcheck$
DECLARE
  v_admin_grants int;
  v_mgr_grants   int;
  v_leaked       text;
  v_wide         text;
  v_open_read    int;
BEGIN
  -- Not absolute counts: this file's subject is a withdrawal, and a total would fail on the second
  -- boot after any later migration grants anything (docs/incidents.md, "Self-checks must not
  -- count totals"). The two claims below stay true whatever is granted later.

  -- 1. Administrator KEEPS all three. "The role the withdrawn capabilities move TO" is the claim;
  --    this is it, stated directly instead of inferred from a total.
  SELECT count(*) INTO v_admin_grants
    FROM public.role_permissions rp
    JOIN public.permissions p ON p.id = rp.permission_id
   WHERE rp.role_id = 1
     AND p.name IN ('authz:manage', 'schema:manage', 'gitops:manage');
  IF v_admin_grants <> 3 THEN
    RAISE EXCEPTION
      '0069 self-check: Administrator holds % of the three withdrawn permissions, expected 3. '
      'This migration withdraws from Shopfloor_Manager only; Administrator is the role the '
      'withdrawn capabilities move TO, so removing one from Administrator empties it entirely.',
      v_admin_grants;
  END IF;

  -- 2. Administrator's grants remain a strict SUPERSET of Shopfloor_Manager's. This is the
  --    structural half of "the two roles stop being the same" -- the Manager is a narrowing of the
  --    Administrator, not a different set -- and it survives any later grant that goes to both.
  SELECT count(*) INTO v_mgr_grants
    FROM public.role_permissions mgr
   WHERE mgr.role_id = 2
     AND NOT EXISTS (
       SELECT 1 FROM public.role_permissions adm
        WHERE adm.role_id = 1 AND adm.permission_id = mgr.permission_id
     );
  IF v_mgr_grants <> 0 THEN
    RAISE EXCEPTION
      '0069 self-check: Shopfloor_Manager holds % permission(s) Administrator does not. The '
      'Manager is a narrowing of the Administrator, so a grant to one without the other means a '
      'later migration granted a role a capability its supervisor cannot exercise.',
      v_mgr_grants;
  END IF;

  SELECT string_agg(p.name, ', ' ORDER BY p.name) INTO v_leaked
    FROM public.role_permissions rp
    JOIN public.permissions p ON p.id = rp.permission_id
   WHERE rp.role_id = 2
     AND p.name IN ('authz:manage', 'schema:manage', 'gitops:manage');
  IF v_leaked IS NOT NULL THEN
    RAISE EXCEPTION
      '0069 self-check: Shopfloor_Manager still holds %. The DELETE matches on permission id, so '
      'this means a grant was re-added after it -- not that a rename slipped past.', v_leaked;
  END IF;

  -- The predicate, read back from the catalogue rather than trusted from the statements above.
  -- A policy that still names Shopfloor_Manager is a button hidden from a role that can still
  -- reach the table with a raw PostgREST call, which is the exact failure this section exists to
  -- prevent.
  SELECT string_agg(policyname, ', ' ORDER BY policyname) INTO v_wide
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('schemas', 'metric_catalog', 'metric_groups')
     AND cmd <> 'SELECT'
     AND (coalesce(qual, '') || ' ' || coalesce(with_check, '')) LIKE '%Shopfloor_Manager%';
  IF v_wide IS NOT NULL THEN
    RAISE EXCEPTION
      '0069 self-check: % still admit(s) Shopfloor_Manager. 0001 recreates these policies wide on '
      'every boot, so this file must run after it and must DROP before it CREATEs.', v_wide;
  END IF;

  SELECT count(*) INTO v_open_read
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('schemas', 'metric_catalog', 'metric_groups')
     AND cmd = 'SELECT'
     AND qual = 'true';
  IF v_open_read <> 3 THEN
    RAISE EXCEPTION
      '0069 self-check: % of 3 open SELECT policies remain on schemas, metric_catalog and '
      'metric_groups. Reading a schema is not managing one -- the Devices page resolves a '
      'device''s conformance through these tables for every role.', v_open_read;
  END IF;

  RAISE NOTICE
    '0069 self-check passed: the three withdrawn permissions are Administrator''s alone, '
    'Shopfloor_Manager holds nothing Administrator does not, and the seven schema-management '
    'write policies admit Administrator alone with all three reads open.';
END;
$selfcheck$;
