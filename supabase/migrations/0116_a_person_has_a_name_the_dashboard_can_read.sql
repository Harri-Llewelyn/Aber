-- 0116: a person has a name the dashboard can read.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- The Digital Thread's role-assignment lane is one PERSON's history -- `log_role_assignment()`
-- keys it by `user_roles.user_id` -- and nothing served to the browser could turn that id into
-- anybody. `auth.users` is not exposed by PostgREST, `public.user_roles` is not published to
-- clients, and `list_machine_principals()` (0043) deliberately returns only the identities that
-- CANNOT sign in. So the lane that answers "who was given what, and when" drew a shortened uuid.
--
-- `list_user_accounts()` is the other half: the identities that are not machines, decided by
-- `is_machine_principal()` (0048) rather than by a second test of its own. 0048's header is
-- explicit that "a second definition of 'is this a service account' would be worse than the bug",
-- and this is where a second one would have gone.
--
-- THE GATE MATCHES THE POLICY ON THE ROWS IT LABELS. `digital_thread_select_security` admits
-- Administrator and Auditor, and a role assignment is stamped into that lane -- so anybody who can
-- read the lane can read the names in it, and nobody else learns anything. Administrator-only, as
-- `list_machine_principals()` is, would leave an Auditor reading a lane of uuids beside an
-- Administrator reading names: the same record, told differently, which is the one thing an audit
-- trail must not do.
--
-- EMAIL AND NOTHING ELSE. It is the only human-readable identifier `auth.users` carries here --
-- `raw_user_meta_data` is empty on every account this stack creates -- and a read surface over the
-- auth schema should return the least that does the job. It can be NULL: an account with an
-- identity provider but no address is not a machine, and the caller falls back to the id rather
-- than being told the account does not exist.

SET search_path TO public;

CREATE OR REPLACE FUNCTION public.list_user_accounts()
    RETURNS TABLE(user_id uuid, email text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    -- Administrator and Auditor: the two roles `digital_thread_select_security` admits. See the
    -- header for why this is not narrower.
    IF NOT public.has_role(ARRAY['Administrator', 'Auditor']) THEN
        RAISE EXCEPTION 'insufficient privileges to list user accounts'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN QUERY
    SELECT u.id, u.email::text
      FROM auth.users u
     -- ONE DEFINITION OF "IS THIS A SERVICE ACCOUNT", which is 0048's rule. Spelling the test out
     -- again here would be a second one, and the two would agree until the day they did not.
     WHERE NOT public.is_machine_principal(u.id)
     ORDER BY u.email NULLS LAST, u.id;
END;
$$;

COMMENT ON FUNCTION public.list_user_accounts() IS
  'The people who can reach this stack, as id and email, for naming the person a digital_thread role-assignment row is about. Membership is NOT is_machine_principal() (0048), the same predicate the rest of the stack tells a person from a service identity with. Administrator and Auditor only -- the roles digital_thread_select_security admits, because an Auditor reading uuids beside an Administrator reading names would be the same record told two ways. The email may be NULL; the caller falls back to the id.';

REVOKE ALL ON FUNCTION public.list_user_accounts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_user_accounts() TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_user_accounts() TO service_role;

-- -------------------------------------------------------------------------------------------------
-- Self-checks
--
-- Structural only. The gate cannot be exercised from here: `has_role()` resolves `auth.uid()`, and
-- a migration runs as the owner with no JWT, so every call would take the refusing arm. What the
-- gate ADMITS and REFUSES is asserted per role in test_user_accounts_listing.py, which can become
-- each of them.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
    v_secdef boolean;
    v_public boolean;
BEGIN
    SELECT p.prosecdef INTO v_secdef
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'list_user_accounts';

    IF v_secdef IS NULL THEN
        RAISE EXCEPTION '0116 self-check: list_user_accounts() was not created';
    END IF;

    -- Without this it reads `auth.users` as the caller, which `authenticated` cannot -- so the
    -- function would answer every caller with an empty list rather than with a refusal, and the
    -- lane would go back to uuids with nothing to say why.
    IF NOT v_secdef THEN
        RAISE EXCEPTION '0116 self-check: list_user_accounts() is not SECURITY DEFINER';
    END IF;

    -- EXECUTE to PUBLIC would hand every anonymous caller the account list, since the gate inside
    -- is a role check rather than a grant.
    SELECT has_function_privilege('public', 'public.list_user_accounts()', 'EXECUTE')
      INTO v_public;

    IF v_public THEN
        RAISE EXCEPTION
            '0116 self-check: PUBLIC may execute list_user_accounts() -- the REVOKE above did not take';
    END IF;

    RAISE NOTICE '0116: list_user_accounts() is in place, SECURITY DEFINER, and not public.';
END
$check$;
