-- =============================================================================================
-- Migration: 0069_the_two_roles_stop_being_the_same.sql
-- Shopfloor_Manager operates the shopfloor; Administrator operates the platform
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT WAS WRONG
--
-- `0002_seed_data.sql` grants `Administrator` (role 1) and `Shopfloor_Manager` (role 2) THE SAME
-- THIRTEEN PERMISSIONS. The two names have been decoration since the baseline: everything one can
-- do, the other can do, and the only difference a reader could point at was the description text.
--
-- Meanwhile the database had already started separating them BY HAND. `system_settings` for read
-- and for write, `list_service_principals()` and `create_service_principal()` all check
-- `has_role(ARRAY['Administrator'])` alone, against dozens of sites that check the pair. The
-- divergence existed in the policies and the permission table did not know about it.
--
-- This migration makes the permission table agree with the direction those policies were already
-- going, and narrows the write policies that correspond to the permissions being withdrawn.
--
--     Manager KEEPS   devices, cells, gateways, links, quarantine view/approve/reject,
--                     telemetry, archives, digital thread -- the shopfloor
--     Manager LOSES   authz:manage    who has access
--                     schema:manage   what contract ingestion validates against
--                     gitops:manage   what gets deployed to the edge
--
-- IT IS A BREAKING CHANGE for a deployment where a Shopfloor_Manager does schema or GitOps work,
-- and it is stated as one rather than described as a hardening. The repair is to
-- make that person an Administrator.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THE POLICIES MOVE IN THE SAME FILE, AND WHY THIS IS NOT A UI CHANGE
--
-- NO RLS POLICY IN THIS SCHEMA READS `role_permissions`. Every database control resolves through
-- `has_role()`, and the permission table is consumed by `usePermissions.js` alone -- so revoking
-- a grant, on its own, hides a button and changes nothing a caller reaches PostgREST with.
--
-- This repository has already written down what that costs, in the comment retiring
-- `VITE_ALLOW_SIGNUP`: *"THIS REPLACES `VITE_ALLOW_SIGNUP`, which was a frontend flag and
-- therefore never an access control."* A revoked permission whose policy still admits the role is
-- the same object. So the seven write policies that `schema:manage` gates in the UI narrow here,
-- in the same transaction as the grant that names them:
--
--     public.schemas          INSERT / UPDATE / DELETE   the schema registry itself
--     public.metric_catalog   INSERT / UPDATE            the Schemas page's Add Metric form
--     public.metric_groups    INSERT / UPDATE            the same form's group registry
--
-- `gitops:manage` has no policy to narrow: its enforcement point is `ALLOWED_ROLES` in
-- `supabase/functions/deploy-nodered/index.ts`, which moves with this migration.
--
-- `authz:manage` has no policy and no control. `public.user_roles` and `public.role_permissions`
-- carry a SELECT policy each and nothing else, so no authenticated caller -- Administrator
-- included -- can write either through PostgREST today. A Shopfloor_Manager cannot promote
-- themselves to Administrator through the Access Control tab: there is no such control and no
-- write path for one to use. THE ESCALATION IS LATENT, NOT LIVE: it arrives with
-- the first role-assignment control, which is why the split is a PREREQUISITE for building that
-- control rather than a patch on an open hole. The README is corrected to say so.
--
-- ---------------------------------------------------------------------------------------------
-- WHY A PLAIN DELETE, AND NOT `one_shot_migrations`
--
-- 0040 needed the ledger because the rows it removed were rows an operator DELIBERATELY RECREATES:
-- `npm run provision:gateways` puts the demonstration floor back, and a delete replayed every boot
-- would make provisioning useless while reporting success.
--
-- Nothing recreates these. `role_permissions` is written only by 0002, by this file, and by a DBA
-- with a psql session -- RLS grants `authenticated` SELECT alone, and no RPC touches it. So a
-- second run genuinely matches no rows, the house rule is satisfied without a claim, and the
-- ledger would be ceremony over a DELETE that is already idempotent.
--
-- Related: 0002 (the grants), 0001 (the policies and the RBAC tables), 0042/0044 (the four
--          Administrator-only policies this follows), 0070 (the audit-domain split behind it).
-- =============================================================================================

SET search_path TO public;

-- ---------------------------------------------------------------------------------------------
-- 1. The three grants Shopfloor_Manager gives up
-- ---------------------------------------------------------------------------------------------
-- BY ID AND NOT BY NAME. `0049` renamed `document:manage` to `link:manage` and left the id alone,
-- precisely because role_permissions references the id and the frontend holds the same literal. A
-- name-matched DELETE here would silently stop matching the first time one of these is reworded.
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
-- THE NAMES DO NOT CHANGE, and that is a decision rather than an omission. `_privileged` in this
-- schema means "not everyone" and not "the pair" -- `webhook_endpoints_select_privileged` has been
-- Administrator-only under that suffix since 0001. Renaming seven policies would break nothing and
-- teach nothing; the authority is in the predicate, which is the part that is enforced.
--
-- DROP-then-CREATE is forced, not preferred: 0001 recreates each of these WIDE on every boot, so
-- this file has to replace them after it. Two policies for one command are OR'd in PostgreSQL, so
-- leaving the old one in place would restore exactly what this migration removes.

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

-- The metric catalog and its group registry, both written from the Schemas page's Add Metric form
-- and from the Vocabulary page's Use action -- and both gated in the UI on SCHEMA_MANAGE, which is
-- what makes them part of this permission rather than of `device:manage`.
--
-- `metric_catalog.name` IS IMMUTABLE (0007), so an INSERT here is not a draft: it is the reason
-- api.js calls its confirmation "the last check before something permanent".
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
-- THE READ POLICIES ARE ASSERTED TO HAVE SURVIVED, and that is the half most likely to be lost in
-- a careless repeat of this change. A Shopfloor_Manager must go on READING schemas and the metric
-- catalog: the Devices page resolves a device's schema through them, so narrowing the SELECT would
-- present as a manager who can see devices and not what they conform to.
DO $selfcheck$
DECLARE
  v_admin_grants int;
  v_mgr_grants   int;
  v_leaked       text;
  v_wide         text;
  v_open_read    int;
BEGIN
  -- ===============================================================================================
  -- THESE WERE ABSOLUTE COUNTS (13 AND 10) AND THAT WAS A LANDMINE, not a stricter check.
  --
  -- This file's subject is a WITHDRAWAL: three permissions leave Shopfloor_Manager and stay with
  -- Administrator. Neither of those facts is a total. Asserting totals made this self-check a
  -- tripwire under every FUTURE migration that grants anything to anybody -- and one duly stood
  -- on it: 0086 granted `proposal:create` to roles 1, 2 and 3, taking Administrator to 14.
  --
  -- THE FAILURE MODE IS THE WORST AVAILABLE, and it is worth naming so it is not re-introduced.
  -- Migrations replay on every boot in filename order with no ledger, and 0069 runs long before
  -- 0086. So on the boot where 0086 FIRST ran, 0069 counted 13 and passed. On every boot after
  -- that it counted 14 and aborted -- taking the whole chain with it, including every migration
  -- numbered above 0069. The stack silently stopped being able to apply new migrations at all,
  -- while continuing to run perfectly on the schema it already had.
  --
  -- AND THE TEST LANE CANNOT SEE IT. `npm run test:db` builds a database from nothing, so 0069
  -- always runs before 0086 grants and always counts 13. A second boot is the only thing that
  -- reproduces it, which is why this shipped green.
  --
  -- What replaces them are the two claims this migration is actually making, both of which stay
  -- true no matter what is granted later.
  -- ===============================================================================================

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
