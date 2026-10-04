-- =============================================================================================
-- Migration: 0162_machine_principals_hold_no_role.sql (applied as 0032 until the 1.0 squash)
-- The user_roles comment says machine principals hold no role
-- =============================================================================================
--
-- The COMMENT ON TABLE public.user_roles that 0001 declares says the three seeded machine
-- principals hold Operator. They hold no role: refuse_role_for_machine_principal() refuses one,
-- and 0002 grants each of them telemetry:read on principal_permissions instead. This restates the
-- comment; 0001 keeps the old text until the next squash, and this one wins on every replay.
--
-- Idempotent.
-- =============================================================================================

SET search_path TO public;

COMMENT ON TABLE public.user_roles IS
  'Role assignment per person. A machine principal, an auth.users row that cannot sign in, holds '
  'no role: refuse_role_for_machine_principal() refuses one, and has_authority() resolves its '
  'grants through principal_permissions. Three are seeded, each granted telemetry:read: '
  'b0000000-0000-4000-8000-000000000001, the read-only principal the MCP client authenticates as; '
  'b0000000-0000-4000-8000-000000000002, Service_Ingestor, the identity the ingestion daemon '
  'authenticates as; and b0000000-0000-4000-8000-000000000003, Service_Playback, the identity the '
  'playback worker authenticates as. The two services write through SECURITY DEFINER gates that '
  'check which of them is calling.';

-- ---------------------------------------------------------------------------------------------
-- Self-check: the comment this file set, and the guard it describes
-- ---------------------------------------------------------------------------------------------
DO $check$
DECLARE
    v_comment text := obj_description('public.user_roles'::regclass, 'pg_class');
BEGIN
    IF coalesce(v_comment, '') NOT LIKE 'Role assignment per person.%'
       OR v_comment ILIKE '%hold Operator%' THEN
        RAISE EXCEPTION '0032 self-check: the COMMENT on public.user_roles is %, not the one this file set.',
            coalesce(v_comment, '(missing)');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger t
         WHERE t.tgrelid = 'public.user_roles'::regclass
           AND NOT t.tgisinternal
           AND t.tgfoid = 'public.refuse_role_for_machine_principal()'::regprocedure
    ) THEN
        RAISE EXCEPTION '0032 self-check: no trigger on public.user_roles calls refuse_role_for_machine_principal(), which the comment names.';
    END IF;
END
$check$;
