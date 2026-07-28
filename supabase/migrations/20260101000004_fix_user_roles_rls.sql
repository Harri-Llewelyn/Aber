-- Migration: 20260101000004_fix_user_roles_rls.sql
-- Description: Replace overly-broad user_roles SELECT policy with one restricted to user's own row or privileged roles.
--
-- Manual Verification Procedure:
-- 1. Log in as operator@factoryplus.local (role 'Operator').
-- 2. Execute `SELECT * FROM public.user_roles;` via Supabase Client under Operator JWT session.
-- 3. Confirm only the Operator's own user_roles row is returned (querying for another user's user_id returns zero rows).
-- 4. Log in as admin@factoryplus.local (role 'Administrator').
-- 5. Confirm Administrator can SELECT user_roles records for any user_id.

DROP POLICY IF EXISTS "user_roles_select_authenticated" ON public.user_roles;

DROP POLICY IF EXISTS "user_roles_select_own_or_privileged" ON public.user_roles;
CREATE POLICY "user_roles_select_own_or_privileged" ON public.user_roles
    FOR SELECT TO authenticated
    USING (
        user_id = auth.uid()::text
        OR (auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager')
    );
