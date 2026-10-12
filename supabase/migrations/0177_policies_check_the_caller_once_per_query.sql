-- 0177: Eight policies check the caller once per query, not once per row.
--
-- Each mixed a column with auth.uid(), has_role() or has_authority(), so the planner ran the call
-- for every row it scanned; has_role() and has_authority() are SECURITY DEFINER lookups and never
-- inlined. In a sub-select each call is an initplan that runs once per statement, and all three
-- are STABLE, so every answer is the same. 0001 still declares the per-row form, and creates it
-- only where a policy is missing; this file states each one.
--
-- A new policy wraps every auth.uid(), has_role() and has_authority() call in a sub-select. One
-- statement per line, in pg_dump's form, because tests read the declarations line by line and
-- replay_policy() (0001, section 3c) re-creates a policy only when the live one differs from it.
-- Each table's policies change in one transaction. One table per transaction, so no lock is held
-- while another is awaited. Measurements: supabase/README.md.

BEGIN;
SELECT public.replay_policy('public.audit_trail', 'audit_trail_select_asset', $ddl$
CREATE POLICY audit_trail_select_asset ON public.audit_trail FOR SELECT TO authenticated USING (((audit_domain = 'asset'::text) AND (( SELECT public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text, 'Auditor'::text]) AS has_role) OR ( SELECT public.has_authority(ARRAY['audit_trail:read'::text]) AS has_authority))));
$ddl$);
SELECT public.replay_policy('public.audit_trail', 'audit_trail_select_security', $ddl$
CREATE POLICY audit_trail_select_security ON public.audit_trail FOR SELECT TO authenticated USING (((audit_domain = 'security'::text) AND ( SELECT public.has_role(ARRAY['Administrator'::text, 'Auditor'::text]) AS has_role)));
$ddl$);
COMMIT;

BEGIN;
SELECT public.replay_policy('public.change_proposals', 'change_proposals_insert_proposer', $ddl$
CREATE POLICY change_proposals_insert_proposer ON public.change_proposals FOR INSERT TO authenticated WITH CHECK ((( SELECT public.has_authority(ARRAY['proposal:create'::text]) AS has_authority) AND (proposed_by = ( SELECT auth.uid() AS uid)) AND (status = 'open'::text)));
$ddl$);
SELECT public.replay_policy('public.change_proposals', 'change_proposals_select_own_or_approver', $ddl$
CREATE POLICY change_proposals_select_own_or_approver ON public.change_proposals FOR SELECT TO authenticated USING (((proposed_by = ( SELECT auth.uid() AS uid)) OR ( SELECT public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]) AS has_role)));
$ddl$);
SELECT public.replay_policy('public.change_proposals', 'change_proposals_update_own_open', $ddl$
CREATE POLICY change_proposals_update_own_open ON public.change_proposals FOR UPDATE TO authenticated USING (((proposed_by = ( SELECT auth.uid() AS uid)) AND (status = 'open'::text))) WITH CHECK ((proposed_by = ( SELECT auth.uid() AS uid)));
$ddl$);
COMMIT;

BEGIN;
SELECT public.replay_policy('public.principal_permissions', 'principal_permissions_select_own_or_admin', $ddl$
CREATE POLICY principal_permissions_select_own_or_admin ON public.principal_permissions FOR SELECT TO authenticated USING (((principal_id = ( SELECT auth.uid() AS uid)) OR ( SELECT public.has_role(ARRAY['Administrator'::text]) AS has_role)));
$ddl$);
COMMIT;

BEGIN;
SELECT public.replay_policy('public.system_settings', 'system_settings_select_authenticated', $ddl$
CREATE POLICY system_settings_select_authenticated ON public.system_settings FOR SELECT TO authenticated USING (((NOT sensitive) OR ( SELECT public.has_role(ARRAY['Administrator'::text]) AS has_role)));
$ddl$);
COMMIT;

BEGIN;
SELECT public.replay_policy('public.user_roles', 'user_roles_select_own_or_privileged', $ddl$
CREATE POLICY user_roles_select_own_or_privileged ON public.user_roles FOR SELECT TO authenticated USING (((user_id = (( SELECT auth.uid() AS uid))::text) OR ( SELECT public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]) AS has_role)));
$ddl$);
COMMIT;
