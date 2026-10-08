-- 0167: An Administrator sets a new password for a person, and sign-up hands out no role.
--
-- record_person_password_set() is the database half of Set New Password on the People tab. The
-- password itself is GoTrue's, changed by the manage-people edge function with the secret key. The
-- function calls this twice in the caller's session: with p_check_only true BEFORE GoTrue changes
-- anything, so the rules are decided first, and with false AFTER, to write PASSWORD_SET. A person
-- changing their own password goes to GoTrue directly (PUT /auth/v1/user) and is in GoTrue's own
-- audit log, not here.
--
-- handle_new_user() is dropped. It gave every self-registered account the Operator role, and
-- nothing attaches it; attached, it would give a role to anyone who can reach the sign-up endpoint
-- while supabaseAuth.disableSignup is false. 0001 still declares it, so it is dropped on every boot.

-- Administrator only. Refuses your own password (Change Password, in the account menu, is how you
-- change it), a machine identity, and a person whose access is removed. Writes nothing unless
-- p_check_only is false; the row it writes then holds no password.
CREATE OR REPLACE FUNCTION public.record_person_password_set(p_user_id uuid, p_check_only boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_email text;
BEGIN
  PERFORM public.check_person_act(p_user_id, 'set a person''s password');

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'you cannot set your own password here. Use Change Password in your account menu.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF public.person_access_is_removed(p_user_id) THEN
    RAISE EXCEPTION 'this person''s access is removed. Restore it first, then set a new password.'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- NULL checks only: a row is written only when the caller says the change was made.
  IF p_check_only IS NOT FALSE THEN
    RETURN;
  END IF;

  SELECT u.email::text INTO v_email FROM auth.users u WHERE u.id = p_user_id;

  INSERT INTO public.audit_trail (
    entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
    causation_id, recorded_at
  ) VALUES (
    'user_roles', p_user_id, 'PASSWORD_SET', NULL,
    jsonb_build_object('email', v_email, 'method', 'new password shown once'),
    auth.uid(), 'user', txid_current(), now()
  );
END
$$;

ALTER FUNCTION public.record_person_password_set(uuid, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_person_password_set(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_person_password_set(uuid, boolean) TO authenticated;

COMMENT ON FUNCTION public.record_person_password_set(uuid, boolean) IS
  'Administrator only, called by the manage-people edge function around GoTrue''s change of a '
  'person''s password: with p_check_only true before it, which checks and writes nothing, and with '
  'false after it, which writes a PASSWORD_SET row (email and method, never the password). Refuses '
  'the caller''s own password, a machine identity, and a person whose access is removed. An unknown '
  'person is a 404.';

-- CASCADE takes with it trg_handle_new_user on auth.users, which a database first built by the
-- archived migrations, before 0001, may still hold.
DROP FUNCTION IF EXISTS public.handle_new_user() CASCADE;

DO $$
BEGIN
  IF has_function_privilege('anon', 'public.record_person_password_set(uuid, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION '0167: anon may execute record_person_password_set(), which records a password change';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.record_person_password_set(uuid, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION '0167: authenticated may not execute record_person_password_set(); manage-people calls it as the caller';
  END IF;
  IF to_regprocedure('public.handle_new_user()') IS NOT NULL THEN
    RAISE EXCEPTION '0167: handle_new_user() still exists';
  END IF;
END
$$;
