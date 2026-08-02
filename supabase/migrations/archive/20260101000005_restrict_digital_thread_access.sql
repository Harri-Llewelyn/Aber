-- Migration: 20260101000005_restrict_digital_thread_access.sql
-- Description: Restrict public.digital_thread SELECT access strictly to Administrator, Shopfloor_Manager, and Auditor roles.

DROP POLICY IF EXISTS "digital_thread_select_authenticated" ON public.digital_thread;

DROP POLICY IF EXISTS "digital_thread_select_privileged_or_auditor" ON public.digital_thread;
CREATE POLICY "digital_thread_select_privileged_or_auditor" ON public.digital_thread
    FOR SELECT TO authenticated
    USING (
        (auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager', 'Auditor')
    );
