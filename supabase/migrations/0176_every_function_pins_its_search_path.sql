-- 0176: Ten more functions pin their search_path, and the one that does not says why.
--
-- These were the functions in public without the SET clause every other one carries, and Studio's
-- advisor (lint 0011) listed them. All are SECURITY INVOKER and name no relation unqualified, so a
-- pin changes no answer. ALTER rather than a redeclaration: an earlier file's CREATE OR REPLACE
-- clears the setting on every replay, and this file sets it again.
--
-- A SQL function with a SET clause is never inlined. may_decide_proposal() stays unpinned for
-- that reason, recorded in its comment below; measurements in supabase/README.md.

ALTER FUNCTION public.audit_domain_for(p_entity_type text, p_action text) SET search_path TO 'public';
ALTER FUNCTION public.directory_liveness_job_map() SET search_path TO 'public';
ALTER FUNCTION public.enforce_metric_catalog_immutability() SET search_path TO 'public';
ALTER FUNCTION public.enforce_metric_group_spelling() SET search_path TO 'public';
ALTER FUNCTION public.gateway_holds_a_credential(g public.gateways) SET search_path TO 'public';
ALTER FUNCTION public.is_valid_quarantine_reason(p_reason text) SET search_path TO 'public';
ALTER FUNCTION public.plan_distance(p_x1 numeric, p_y1 numeric, p_x2 numeric, p_y2 numeric, p_aspect numeric) SET search_path TO 'public';
ALTER FUNCTION public.proposable_columns(p_entity_type text) SET search_path TO 'public';
ALTER FUNCTION public.schema_version_base_name(schema_name text) SET search_path TO 'public';
ALTER FUNCTION public.service_token_max_days() SET search_path TO 'public';

-- 0001's comment, with the reason the advisor still lists this function.
COMMENT ON FUNCTION public.may_decide_proposal(p_entity_type text) IS 'Who may approve or reject a proposal in this lane. The device lanes and areas resolve the role pair (Administrator, Shopfloor_Manager) their tables'' write policies name. Cells and gateways resolve cell:manage and gateway:manage, where their tables'' policies name the same pair: the two agree for a person, because the pair are the only roles holding those grants, and no machine can hold either, because create_machine_principal() refuses them. An unknown or withdrawn lane -- schemas, and the three link lanes -- is decidable by nobody. Its search_path is not pinned, on purpose: a SET clause stops the planner inlining it, and list_proposer_names() calls it once per proposal, which a pin made four times slower (0176). It runs with the caller''s rights and names its schema on every function it calls.';

DO $$
DECLARE
  v_unpinned text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_unpinned
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('audit_domain_for', 'directory_liveness_job_map',
                       'enforce_metric_catalog_immutability', 'enforce_metric_group_spelling',
                       'gateway_holds_a_credential', 'is_valid_quarantine_reason',
                       'plan_distance', 'proposable_columns', 'schema_version_base_name',
                       'service_token_max_days')
     AND NOT coalesce(p.proconfig, '{}') @> ARRAY['search_path=public'];
  IF v_unpinned IS NOT NULL THEN
    RAISE EXCEPTION '0176: search_path is not pinned on %', v_unpinned;
  END IF;
END
$$;
