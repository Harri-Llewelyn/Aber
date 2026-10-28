-- 0216: An Administrator resets a person's second factor, recorded in their lane.
--
-- Reset MFA, in a person's drawer on Access Control › People, is for someone who has lost their
-- authenticator. The factors are GoTrue's, deleted by the manage-people edge function through the
-- admin API with the secret key. record_person_mfa_reset() is the database half, as
-- record_person_password_set() (0167) is Set New Password's: called in the caller's session with
-- p_check_only true BEFORE GoTrue deletes anything, so the rules are decided first, and with false
-- AFTER, to write one MFA_RESET row with how many factors went. Sessions are left as they are: End
-- Sessions is the act that ends them. A person removing their own factor on Profile › Security goes
-- to GoTrue directly and is in GoTrue's own audit log, not here.
--
-- Reasoning: supabase/README.md, "An Administrator resets a person's second factor (0216)".
-- Idempotent.

-- Administrator only, never your own (Profile › Security removes your own), never a machine
-- identity; an unknown person is a 404. A removed person's factors may be reset, so they find none
-- when Restore Access lets them back. Writes nothing unless p_check_only is false.
CREATE OR REPLACE FUNCTION public.record_person_mfa_reset(
  p_user_id uuid, p_check_only boolean, p_factors_removed integer DEFAULT NULL
) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_email text;
BEGIN
  PERFORM public.check_person_act(p_user_id, 'reset a person''s second factor');

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'you cannot reset your own second factor here. Remove it on your Profile page''s Security tab.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- NULL checks only: a row is written only when the caller says the factors went.
  IF p_check_only IS NOT FALSE THEN
    RETURN;
  END IF;

  IF p_factors_removed IS NULL OR p_factors_removed < 0 THEN
    RAISE EXCEPTION 'p_factors_removed must say how many factors were removed: zero or more'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT u.email::text INTO v_email FROM auth.users u WHERE u.id = p_user_id;

  INSERT INTO public.audit_trail (
      entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
      causation_id, recorded_at
  ) VALUES (
      'user_roles', p_user_id, 'MFA_RESET', NULL,
      jsonb_build_object('email', v_email, 'factors_removed', p_factors_removed),
      auth.uid(), public.audit_actor_source(), txid_current(), now()
  );
END
$$;

ALTER FUNCTION public.record_person_mfa_reset(uuid, boolean, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_person_mfa_reset(uuid, boolean, integer) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.record_person_mfa_reset(uuid, boolean, integer) TO authenticated;

COMMENT ON FUNCTION public.record_person_mfa_reset(uuid, boolean, integer) IS
  'Administrator only, called by the manage-people edge function around GoTrue''s deletion of a '
  'person''s second factors (Reset MFA): with p_check_only true before it, which checks and writes '
  'nothing, and with false after it, which writes one MFA_RESET row in the person''s lane (their '
  'email and p_factors_removed, the number GoTrue deleted). Refuses the caller''s own account '
  '(42501) and a machine identity (22023); an unknown person is a 404. A removed person''s factors '
  'may be reset. Ends no session (0216).';

COMMENT ON FUNCTION public.audit_actor_source() IS
  'The actor_source a function writing its own audit_trail row records: user for a person, '
  'ingestion for the ingestion principal, service for any other machine identity, migration for '
  'the owner''s session with no token. log_audit_trail_event()''s ladder without the X-Aber-Actor '
  'header (0193). Called by the capture and playback gates, by log_display_name_change() (0203), '
  'by end_person_sessions() and record_person_email_change() (0207), by end_my_session() and '
  'end_my_other_sessions() (0211), by end_person_session() (0212), and by '
  'record_person_mfa_reset() (0216).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  f      constant text := 'public.record_person_mfa_reset(uuid, boolean, integer)';
  v_role text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = f::regprocedure
                  AND prosecdef AND 'search_path=public' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0216: % is not SECURITY DEFINER with its search_path pinned', f;
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
    IF has_function_privilege(v_role, f, 'EXECUTE') THEN
      RAISE EXCEPTION '0216: % may execute %', v_role, f;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION '0216: authenticated may not execute %; manage-people calls it as the caller', f;
  END IF;

  -- One signature: an overload would make PostgREST's call by argument names ambiguous.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'record_person_mfa_reset') <> 1 THEN
    RAISE EXCEPTION '0216: record_person_mfa_reset() has more than one signature';
  END IF;

  -- A request with no person behind it is refused before anything is checked or written.
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.record_person_mfa_reset(gen_random_uuid(), false, 1);
    RAISE EXCEPTION '0216: record_person_mfa_reset() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$check$;

NOTIFY pgrst, 'reload schema';
