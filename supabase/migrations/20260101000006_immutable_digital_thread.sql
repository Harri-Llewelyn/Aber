-- Migration: 20260101000006_immutable_digital_thread.sql
-- Description: Make digital_thread append-only. Audit rows are written exclusively
-- by the SECURITY DEFINER trigger (log_digital_thread_event).

DROP POLICY IF EXISTS "digital_thread_insert_privileged" ON public.digital_thread;
DROP POLICY IF EXISTS "digital_thread_update_privileged" ON public.digital_thread;
DROP POLICY IF EXISTS "digital_thread_delete_privileged" ON public.digital_thread;

REVOKE INSERT, UPDATE, DELETE ON public.digital_thread FROM authenticated;

ALTER FUNCTION public.log_digital_thread_event() SET search_path = public;
