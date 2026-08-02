-- Migration: 20260101000011_advisor_hardening.sql
-- Description: Close Supabase Advisor WARN findings that survive RLS.
--
-- RLS already returns zero rows to `anon` on every RBAC table (every policy is
-- scoped `TO authenticated`), and the SECURITY DEFINER functions below are already
-- restricted from PUBLIC. But Supabase's cluster-init default privileges grant
-- table SELECT and function EXECUTE directly to the named `anon`/`authenticated`
-- roles (not via PUBLIC), so those default grants survive `REVOKE ... FROM PUBLIC`
-- and still let `pg_graphql` introspect table shape / let RPC calls reach these
-- functions. This migration closes those residual grants explicitly, matching the
-- fail-closed pattern already used for `public.telemetry` (20260101000010).

-- `anon` never has a matching RLS policy on any of these tables, so it never
-- legitimately needs SELECT. Revoking closes pg_graphql's anon-facing
-- "table exposed" advisor findings without changing any real request's behavior.
REVOKE ALL ON public.asset_config FROM PUBLIC, anon;
REVOKE ALL ON public.cells FROM PUBLIC, anon;
REVOKE ALL ON public.devices FROM PUBLIC, anon;
REVOKE ALL ON public.digital_thread FROM PUBLIC, anon;
REVOKE ALL ON public.directory_services FROM PUBLIC, anon;
REVOKE ALL ON public.documents FROM PUBLIC, anon;
REVOKE ALL ON public.gateways FROM PUBLIC, anon;
REVOKE ALL ON public.permissions FROM PUBLIC, anon;
REVOKE ALL ON public.role_permissions FROM PUBLIC, anon;
REVOKE ALL ON public.roles FROM PUBLIC, anon;
REVOKE ALL ON public.schemas FROM PUBLIC, anon;
REVOKE ALL ON public.user_roles FROM PUBLIC, anon;

-- custom_access_token_hook is an auth hook: only supabase_auth_admin calls it
-- (see 20260101000007). Neither anon nor authenticated ever needs EXECUTE.
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) FROM anon, authenticated;

-- handle_new_user only ever runs via the AFTER INSERT ON auth.users trigger
-- (see 20260101000008). No role needs direct EXECUTE.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated;

-- has_role is called from inside RLS policies scoped `TO authenticated`, so
-- authenticated keeps its EXECUTE grant from 20260101000007. anon never evaluates
-- those policies and never needs to call has_role directly.
REVOKE EXECUTE ON FUNCTION public.has_role(text[]) FROM anon;

-- log_digital_thread_event is a trigger function only (see
-- 20260101000000_init_assets_and_digital_thread.sql); it had no explicit
-- grant/revoke statements at all until now. No role needs direct EXECUTE.
REVOKE ALL ON FUNCTION public.log_digital_thread_event() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
