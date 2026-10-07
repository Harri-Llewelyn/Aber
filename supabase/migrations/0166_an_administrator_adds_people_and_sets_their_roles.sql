-- 0166: An Administrator adds people, sets their roles and removes their access from the dashboard.
--
-- The People tab on Access Control. list_people() lists every person, set_person_role() gives one
-- of the four roles, and three functions record the acts that change an account in GoTrue:
-- record_person_added(), remove_person_access() and restore_person_access(). The GoTrue half
-- (create, invite, ban, lift the ban) is the manage-people edge function's, because it needs the
-- secret key; it calls these in the caller's session, so each is checked and attributed here.
--
-- Removing access deletes the person's user_roles row, which every role check reads (has_role(),
-- has_authority(), the edge functions, the token hook), and keeps the role in access_removals so
-- restoring access gives it back. The account is banned, never deleted: audit_trail.changed_by
-- references it, and the trail goes on naming the person.
--
-- Every act here takes the same lock on user_roles and checks two rules under it: nobody changes
-- their own role or access, and at least one Administrator keeps access.

-- One row per person whose access an Administrator removed, holding the role to give back.
CREATE TABLE IF NOT EXISTS public.access_removals (
  user_id    uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  role_id    integer REFERENCES public.roles (id) ON DELETE SET NULL,
  removed_at timestamptz NOT NULL DEFAULT now(),
  removed_by uuid REFERENCES auth.users (id) ON DELETE SET NULL
);

ALTER TABLE public.access_removals OWNER TO postgres;
ALTER TABLE public.access_removals ENABLE ROW LEVEL SECURITY;
-- Read and written only by the functions below; list_people() is how a person's state is read.
REVOKE ALL ON TABLE public.access_removals FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.access_removals TO service_role;

COMMENT ON TABLE public.access_removals IS
  'People whose access an Administrator removed (remove_person_access()), with the role '
  'restore_person_access() gives back. Their user_roles row is deleted while the row here exists, '
  'and GoTrue bans the account. The permanent record is the ACCESS_REMOVED and ACCESS_RESTORED rows '
  'in audit_trail.';

-- True while the person may not sign in: their access was removed here, or GoTrue bans them.
CREATE OR REPLACE FUNCTION public.person_access_is_removed(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM public.access_removals WHERE user_id = p_user_id)
      OR EXISTS (SELECT 1 FROM auth.users
                  WHERE id = p_user_id AND banned_until IS NOT NULL AND banned_until > now());
END
$$;

ALTER FUNCTION public.person_access_is_removed(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.person_access_is_removed(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- The checks every act on a person shares, in the order a caller can act on: the caller's role,
-- the lock, the person's existence, and that they are a person. Raises; returns nothing.
CREATE OR REPLACE FUNCTION public.check_person_act(p_user_id uuid, p_act text)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'insufficient privileges to %', p_act
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Serialises every act on people, so two Administrators changing each other at once cannot both
  -- pass the last-Administrator rule. Reads are not blocked. The role is checked again under the
  -- lock, because the other act may have just taken it away.
  LOCK TABLE public.user_roles IN SHARE ROW EXCLUSIVE MODE;
  IF NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'insufficient privileges to %', p_act
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    PERFORM public.raise_not_found(format('person %s not found', coalesce(p_user_id::text, 'NULL')));
  END IF;

  IF public.is_machine_principal(p_user_id) THEN
    RAISE EXCEPTION '% is a machine identity, not a person. Machine identities hold permissions, '
      'not roles: manage it under Machine identities.', p_user_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
END
$$;

ALTER FUNCTION public.check_person_act(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.check_person_act(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

-- Refuses an act that would leave no Administrator with access. p_user_id is the person losing
-- Administrator or access; nothing is checked when they do not hold Administrator.
CREATE OR REPLACE FUNCTION public.check_an_administrator_remains(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
                  WHERE ur.user_id = p_user_id::text AND r.name = 'Administrator') THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.user_roles ur
      JOIN public.roles r ON r.id = ur.role_id AND r.name = 'Administrator'
      JOIN auth.users u ON u.id::text = ur.user_id
     WHERE u.id <> p_user_id
       AND NOT public.person_access_is_removed(u.id)
  ) THEN
    RAISE EXCEPTION 'this would leave no Administrator who can sign in. Make someone else an '
      'Administrator first.'
      USING ERRCODE = 'raise_exception';
  END IF;
END
$$;

ALTER FUNCTION public.check_an_administrator_remains(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.check_an_administrator_remains(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Leaves exactly one user_roles row for the person, holding p_role_id: updates the one row there is,
-- inserts when there is none, and deletes extras. log_role_assignment() records each change. False
-- when the person already held exactly that role.
CREATE OR REPLACE FUNCTION public.write_person_role(p_user_id uuid, p_role_id integer)
RETURNS boolean
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_rows integer;
BEGIN
  SELECT count(*) INTO v_rows FROM public.user_roles WHERE user_id = p_user_id::text;

  IF v_rows = 1 THEN
    UPDATE public.user_roles SET role_id = p_role_id
     WHERE user_id = p_user_id::text AND role_id <> p_role_id;
    RETURN FOUND;
  END IF;

  IF v_rows > 1 THEN
    DELETE FROM public.user_roles WHERE user_id = p_user_id::text AND role_id <> p_role_id;
  END IF;
  INSERT INTO public.user_roles (user_id, role_id) VALUES (p_user_id::text, p_role_id)
  ON CONFLICT (user_id, role_id) DO NOTHING;
  RETURN true;
END
$$;

ALTER FUNCTION public.write_person_role(uuid, integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.write_person_role(uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;

-- The id of one of the four role names, or an invalid_parameter_value error naming them.
CREATE OR REPLACE FUNCTION public.person_role_id(p_role text)
RETURNS integer
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
DECLARE
  v_id integer;
BEGIN
  IF p_role = ANY (ARRAY['Administrator', 'Shopfloor_Manager', 'Operator', 'Auditor']) THEN
    SELECT id INTO v_id FROM public.roles WHERE name = p_role;
  END IF;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'unknown role %: a person holds Administrator, Shopfloor_Manager, Operator or '
      'Auditor', coalesce(quote_literal(p_role), 'NULL')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN v_id;
END
$$;

ALTER FUNCTION public.person_role_id(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.person_role_id(text) FROM PUBLIC, anon, authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- What the People tab calls
-- -------------------------------------------------------------------------------------------------

-- Every person, never a machine identity. status is 'removed' while their access is removed (here
-- or by a GoTrue ban), 'invited' until they first sign in, and 'active' after.
CREATE OR REPLACE FUNCTION public.list_people()
RETURNS TABLE(user_id uuid, email text, role text, status text, sign_in_blocked boolean,
              role_on_restore text, invited_at timestamptz, last_sign_in_at timestamptz,
              created_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'insufficient privileges to list people'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT u.id,
         u.email::text,
         (SELECT r.name FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
           WHERE ur.user_id = u.id::text ORDER BY r.id LIMIT 1),
         CASE WHEN a.user_id IS NOT NULL OR coalesce(u.banned_until > now(), false) THEN 'removed'
              WHEN u.last_sign_in_at IS NULL THEN 'invited'
              ELSE 'active' END,
         coalesce(u.banned_until > now(), false),
         (SELECT r.name FROM public.roles r WHERE r.id = a.role_id),
         u.invited_at,
         u.last_sign_in_at,
         u.created_at
    FROM auth.users u
    LEFT JOIN public.access_removals a ON a.user_id = u.id
   WHERE NOT public.is_machine_principal(u.id)
   ORDER BY u.email NULLS LAST, u.id;
END
$$;

ALTER FUNCTION public.list_people() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.list_people() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_people() TO authenticated;

COMMENT ON FUNCTION public.list_people() IS
  'Every person (auth.users that is not a machine principal) with their role, status (active, '
  'invited, removed), whether GoTrue blocks their sign-in, the role restoring access gives back, '
  'and when they were invited and last signed in. Administrator only.';

-- Gives a person one of the four roles. Refuses the caller's own role, a person whose access is
-- removed, and a change that would leave no Administrator with access. False when nothing changed.
CREATE OR REPLACE FUNCTION public.set_person_role(p_user_id uuid, p_role text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role_id integer;
BEGIN
  PERFORM public.check_person_act(p_user_id, 'set a person''s role');
  v_role_id := public.person_role_id(p_role);

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'you cannot change your own role. Ask another Administrator.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF public.person_access_is_removed(p_user_id) THEN
    RAISE EXCEPTION 'this person''s access is removed. Restore it first, then change their role.'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF p_role <> 'Administrator' THEN
    PERFORM public.check_an_administrator_remains(p_user_id);
  END IF;

  RETURN public.write_person_role(p_user_id, v_role_id);
END
$$;

ALTER FUNCTION public.set_person_role(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_person_role(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_person_role(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.set_person_role(uuid, text) IS
  'Administrator only. Leaves the person exactly one user_roles row, holding Administrator, '
  'Shopfloor_Manager, Operator or Auditor; log_role_assignment() records the change. Refuses the '
  'caller''s own role, a machine identity, a person whose access is removed, and a change that would '
  'leave no Administrator with access. An unknown person is a 404. False when nothing changed.';

-- Written by manage-people, in the caller's session, straight after GoTrue created or invited the
-- account: gives it its role and records who added it. Refuses an account that has signed in or is
-- more than an hour old, so it cannot be used to claim an older account was added by the caller.
CREATE OR REPLACE FUNCTION public.record_person_added(p_user_id uuid, p_role text, p_invited boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role_id integer;
  v_email   text;
BEGIN
  PERFORM public.check_person_act(p_user_id, 'add a person');
  v_role_id := public.person_role_id(p_role);

  SELECT u.email::text INTO v_email
    FROM auth.users u
   WHERE u.id = p_user_id
     AND u.last_sign_in_at IS NULL
     AND u.created_at > now() - interval '1 hour';
  IF NOT FOUND THEN
    RAISE EXCEPTION '% is not an account added in the last hour; set its role instead', p_user_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  PERFORM public.write_person_role(p_user_id, v_role_id);

  -- No password: GoTrue holds only its hash, and the dashboard showed it once.
  INSERT INTO public.audit_trail (
    entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
    causation_id, recorded_at
  ) VALUES (
    'user_roles', p_user_id, 'PERSON_ADDED', NULL,
    jsonb_build_object(
      'email', v_email,
      'role', p_role,
      'method', CASE WHEN p_invited THEN 'invitation' ELSE 'initial password' END
    ),
    auth.uid(), 'user', txid_current(), now()
  );
END
$$;

ALTER FUNCTION public.record_person_added(uuid, text, boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_person_added(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_person_added(uuid, text, boolean) TO authenticated;

COMMENT ON FUNCTION public.record_person_added(uuid, text, boolean) IS
  'Administrator only, called by the manage-people edge function after GoTrue created or invited the '
  'account. Gives it its role and writes a PERSON_ADDED row (email, role, method; never a password). '
  'Refuses an account that has signed in or is more than an hour old.';

-- Called by manage-people BEFORE it asks GoTrue to ban the account, so the rules below are checked
-- before anything changes there. Deletes the role row, keeps the role to give back, and records
-- ACCESS_REMOVED. False, changing nothing, when the access is already removed: the function then
-- retries the ban.
CREATE OR REPLACE FUNCTION public.remove_person_access(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_role_id integer;
  v_role    text;
  v_email   text;
BEGIN
  PERFORM public.check_person_act(p_user_id, 'remove a person''s access');

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'you cannot remove your own access. Ask another Administrator.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF EXISTS (SELECT 1 FROM public.access_removals WHERE user_id = p_user_id) THEN
    RETURN false;
  END IF;

  PERFORM public.check_an_administrator_remains(p_user_id);

  SELECT ur.role_id, r.name INTO v_role_id, v_role
    FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
   WHERE ur.user_id = p_user_id::text
   ORDER BY r.id
   LIMIT 1;
  SELECT u.email::text INTO v_email FROM auth.users u WHERE u.id = p_user_id;

  INSERT INTO public.access_removals (user_id, role_id, removed_by)
  VALUES (p_user_id, v_role_id, auth.uid());
  DELETE FROM public.user_roles WHERE user_id = p_user_id::text;

  INSERT INTO public.audit_trail (
    entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
    causation_id, recorded_at
  ) VALUES (
    'user_roles', p_user_id, 'ACCESS_REMOVED',
    jsonb_build_object('access', 'active', 'role', v_role),
    jsonb_build_object('access', 'removed', 'email', v_email),
    auth.uid(), 'user', txid_current(), now()
  );
  RETURN true;
END
$$;

ALTER FUNCTION public.remove_person_access(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.remove_person_access(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_person_access(uuid) TO authenticated;

COMMENT ON FUNCTION public.remove_person_access(uuid) IS
  'Administrator only, called by the manage-people edge function before it bans the account in '
  'GoTrue. Deletes the person''s user_roles row, so every role check refuses them at once, keeps the '
  'role in access_removals, and writes an ACCESS_REMOVED row. Refuses the caller''s own access and '
  'the last Administrator with access. False when the access was already removed.';

-- Called by manage-people BEFORE it lifts the GoTrue ban. Gives back the role kept at removal and
-- records ACCESS_RESTORED. Refuses a person whose access is not removed. Returns the role the person
-- holds afterwards, or NULL when they hold none (a ban made outside the dashboard keeps no role).
CREATE OR REPLACE FUNCTION public.restore_person_access(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_removal public.access_removals%ROWTYPE;
  v_role    text;
  v_email   text;
BEGIN
  PERFORM public.check_person_act(p_user_id, 'restore a person''s access');

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'you cannot restore your own access. Ask another Administrator.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT public.person_access_is_removed(p_user_id) THEN
    RAISE EXCEPTION 'this person''s access is not removed'
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT * INTO v_removal FROM public.access_removals WHERE user_id = p_user_id;
  IF FOUND THEN
    IF v_removal.role_id IS NOT NULL THEN
      PERFORM public.write_person_role(p_user_id, v_removal.role_id);
    END IF;
    DELETE FROM public.access_removals WHERE user_id = p_user_id;
  END IF;

  SELECT r.name INTO v_role
    FROM public.user_roles ur JOIN public.roles r ON r.id = ur.role_id
   WHERE ur.user_id = p_user_id::text
   ORDER BY r.id
   LIMIT 1;
  SELECT u.email::text INTO v_email FROM auth.users u WHERE u.id = p_user_id;

  INSERT INTO public.audit_trail (
    entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
    causation_id, recorded_at
  ) VALUES (
    'user_roles', p_user_id, 'ACCESS_RESTORED',
    jsonb_build_object('access', 'removed'),
    jsonb_build_object('access', 'active', 'role', v_role, 'email', v_email),
    auth.uid(), 'user', txid_current(), now()
  );
  RETURN v_role;
END
$$;

ALTER FUNCTION public.restore_person_access(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.restore_person_access(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restore_person_access(uuid) TO authenticated;

COMMENT ON FUNCTION public.restore_person_access(uuid) IS
  'Administrator only, called by the manage-people edge function before it lifts the GoTrue ban. '
  'Gives back the role kept by remove_person_access() and writes an ACCESS_RESTORED row. Refuses the '
  'caller''s own access and a person whose access is not removed. Returns the role the person holds '
  'afterwards, or NULL.';

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.list_people()',
                           'public.set_person_role(uuid, text)',
                           'public.record_person_added(uuid, text, boolean)',
                           'public.remove_person_access(uuid)',
                           'public.restore_person_access(uuid)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION '0166: anon may execute %, which reads or changes who has access', f;
    END IF;
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION '0166: authenticated may not execute %; the dashboard calls it', f;
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['public.person_access_is_removed(uuid)',
                           'public.check_person_act(uuid, text)',
                           'public.check_an_administrator_remains(uuid)',
                           'public.write_person_role(uuid, integer)',
                           'public.person_role_id(text)'] LOOP
    IF has_function_privilege('authenticated', f, 'EXECUTE')
       OR has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION '0166: an API role may execute %, which only 0166''s functions call', f;
    END IF;
  END LOOP;

  IF has_table_privilege('authenticated', 'public.access_removals', 'SELECT')
     OR has_table_privilege('anon', 'public.access_removals', 'SELECT') THEN
    RAISE EXCEPTION '0166: an API role may read access_removals directly';
  END IF;
END
$$;
