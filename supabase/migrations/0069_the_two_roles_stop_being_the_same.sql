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
-- and it is stated as one in README §20 rather than described as a hardening. The repair is to
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
-- included -- can write either through PostgREST today. README §20 used to say a Shopfloor_Manager
-- "can promote themselves to Administrator through the Access Control tab"; there is no such
-- control and no write path for one to use. THE ESCALATION IS LATENT, NOT LIVE: it arrives with
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
--          Administrator-only policies this follows), README.md §20, §21, §22.
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
  SELECT count(*) INTO v_admin_grants FROM public.role_permissions WHERE role_id = 1;
  IF v_admin_grants <> 13 THEN
    RAISE EXCEPTION
      '0069 self-check: Administrator holds % permission(s), expected 13. This migration withdraws '
      'from Shopfloor_Manager only; Administrator is the role the withdrawn capabilities move TO.',
      v_admin_grants;
  END IF;

  SELECT count(*) INTO v_mgr_grants FROM public.role_permissions WHERE role_id = 2;
  IF v_mgr_grants <> 10 THEN
    RAISE EXCEPTION
      '0069 self-check: Shopfloor_Manager holds % permission(s), expected 10 (13 less authz, '
      'schema and gitops). DEFAULT_ROLE_PERMISSIONS_MAP in frontend/src/hooks/usePermissions.js '
      'mirrors this set and check-mirror-drift.mjs compares the two.',
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
    '0069 self-check passed: Administrator holds 13 permissions, Shopfloor_Manager 10, and the '
    'seven schema-management write policies admit Administrator alone with all three reads open.';
END;
$selfcheck$;
