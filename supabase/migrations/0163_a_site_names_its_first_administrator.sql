-- 0163: A site's first administrator comes from the chart, not from the demo seed.
--
-- db-init calls ensure_first_administrator() on every install and upgrade while
-- supabaseAuth.firstAdministrator.email is set. When no account has that address it creates one,
-- holding Administrator, with the password from the release Secret. When one does, it changes
-- nothing: the password, the role and the account itself belong to the site from then on. The demo
-- personas in seed.sql are applied only where supabaseAuth.demoAccounts is on (values-dev.yaml).
--
-- Owner-only. It writes a password into auth.users, which no API role may reach; db-init connects
-- as postgres.

CREATE OR REPLACE FUNCTION public.ensure_first_administrator(p_email text, p_password text)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_id    uuid := gen_random_uuid();
  v_role  integer;
BEGIN
  IF v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' THEN
    RAISE EXCEPTION 'first administrator: % is not an email address', quote_literal(v_email)
      USING HINT = 'Set supabaseAuth.firstAdministrator.email to the address the administrator signs in with.';
  END IF;

  IF EXISTS (SELECT 1 FROM auth.users WHERE lower(email) = v_email) THEN
    RETURN 'exists';
  END IF;

  -- Checked only when creating, so a Secret that later drops the key does not fail an upgrade.
  IF length(coalesce(p_password, '')) < 12 THEN
    RAISE EXCEPTION 'first administrator %: the password is empty or shorter than 12 characters', v_email
      USING HINT = 'Set secrets.firstAdministratorPassword, or FIRST_ADMINISTRATOR_PASSWORD in secrets.existingSecret.';
  END IF;

  SELECT id INTO STRICT v_role FROM public.roles WHERE name = 'Administrator';

  -- The columns seed.sql writes, for its reason: GoTrue reads every varchar token column into a Go
  -- string, so each is '' rather than NULL, and aud must equal GOTRUE_JWT_AUD.
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    confirmation_token, recovery_token, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at, is_sso_user,
    email_change, email_change_token_new, email_change_token_current,
    phone_change, phone_change_token, reauthentication_token
  ) VALUES (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
    extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
    '', '', '{"provider":"email","providers":["email"],"role":"Administrator"}'::jsonb, '{}'::jsonb,
    now(), now(), false,
    '', '', '',
    '', '', ''
  );

  -- An identity row is what makes this a person rather than a machine principal
  -- (is_machine_principal()), and GoTrue's email sign-in looks the account up through it.
  INSERT INTO auth.identities (user_id, provider, provider_id, identity_data, created_at, updated_at)
  VALUES (v_id, 'email', v_id::text,
          jsonb_build_object('sub', v_id::text, 'email', v_email), now(), now());

  INSERT INTO public.user_roles (user_id, role_id) VALUES (v_id, v_role);

  RETURN 'created';
END
$$;

ALTER FUNCTION public.ensure_first_administrator(text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.ensure_first_administrator(text, text)
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.ensure_first_administrator(text, text) IS
  'Creates the site''s first administrator from supabaseAuth.firstAdministrator when no account has '
  'that email, and otherwise changes nothing. Called by db-init as postgres; no API role may execute it.';

DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(r, 'public.ensure_first_administrator(text, text)', 'EXECUTE') THEN
      RAISE EXCEPTION '0163: % may execute ensure_first_administrator(), which writes passwords', r;
    END IF;
  END LOOP;
END
$$;
