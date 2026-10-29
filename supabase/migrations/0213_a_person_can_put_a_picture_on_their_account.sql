-- 0213: A person can put a picture on their own account. Nobody else sees it.
--
-- The picture is one object in the private `avatars` bucket, at <user id>/avatar.
-- scripts/storage-init.mjs creates the bucket; supabase/storage-policies.sql admits its owner and
-- nobody else. person_profiles (0203) records that the picture exists, as areas.plan_path records
-- an area's plan, so the dashboard downloads it only when there is one.
--
--   * avatar_path is <user id>/avatar or NULL. A row now holds a name, a picture or both, so
--     display_name may be NULL. No name and no picture is still no row.
--   * set_own_picture() is the only way a person sets or clears it. It takes no id and acts on the
--     caller alone, who must hold a role. set_display_name() never touches it: an Administrator
--     clearing another person's name keeps the row while it holds a picture.
--   * forget_person_picture() clears it for manage-people's Remove Access, as service_role, once
--     the function has deleted the object. Only for a person whose access is removed.
--   * is_own_avatar_object() is the test every avatars policy makes: the object is the caller's own
--     <id>/avatar, and the caller holds a role, so a machine identity is refused.
--   * A row with no name is no name. The audit trigger writes nothing for it, and
--     display_names_for() leaves it out, so nobody learns from it that a picture exists.
--
-- Reasoning: supabase/README.md, "A person can put a picture on their account (0213)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The column
-- -------------------------------------------------------------------------------------------------
ALTER TABLE public.person_profiles ADD COLUMN IF NOT EXISTS avatar_path text;
ALTER TABLE public.person_profiles ALTER COLUMN display_name DROP NOT NULL;

-- The one object the bucket's policies admit its owner to. Any other value would name a file the
-- dashboard could never download.
DO $c$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'person_profiles_avatar_path_is_the_owner_s'
                AND conrelid = 'public.person_profiles'::regclass
                AND public.live_constraint_definition(conrelid, conname) <> 'CHECK (((avatar_path IS NULL) OR (avatar_path = ((user_id)::text || ''/avatar''::text))))') THEN
    ALTER TABLE public.person_profiles DROP CONSTRAINT person_profiles_avatar_path_is_the_owner_s;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'person_profiles_avatar_path_is_the_owner_s'
                    AND conrelid = 'public.person_profiles'::regclass) THEN
    ALTER TABLE public.person_profiles
        ADD CONSTRAINT person_profiles_avatar_path_is_the_owner_s CHECK (((avatar_path IS NULL) OR (avatar_path = ((user_id)::text || '/avatar'::text))));
  END IF;
END $c$;

DO $c$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'person_profiles_holds_a_name_or_a_picture'
                AND conrelid = 'public.person_profiles'::regclass
                AND public.live_constraint_definition(conrelid, conname) <> 'CHECK (((display_name IS NOT NULL) OR (avatar_path IS NOT NULL)))') THEN
    ALTER TABLE public.person_profiles DROP CONSTRAINT person_profiles_holds_a_name_or_a_picture;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'person_profiles_holds_a_name_or_a_picture'
                    AND conrelid = 'public.person_profiles'::regclass) THEN
    ALTER TABLE public.person_profiles
        ADD CONSTRAINT person_profiles_holds_a_name_or_a_picture CHECK (((display_name IS NOT NULL) OR (avatar_path IS NOT NULL)));
  END IF;
END $c$;

COMMENT ON TABLE public.person_profiles IS
  'One row per person who has a display name, a picture or both; no row is neither. The name is '
  'written only by set_display_name(), which writes a DISPLAY_NAME_CHANGED audit row through '
  'log_display_name_change(); the picture only by set_own_picture() and, on Remove Access, '
  'forget_person_picture(). A person reads their own row; everyone else reads names through '
  'list_people(), list_user_accounts() and display_names_for(), and nobody else learns of a '
  'picture. Deleting the account deletes the row (0203, 0213).';
COMMENT ON COLUMN public.person_profiles.display_name IS
  'The name the dashboard shows first, with the email beside it where trust matters. Trimmed, 1 '
  'to 80 characters, no control characters; NULL on a row that holds only a picture. Read live, '
  'so a renamed person shows under the new name everywhere; the Audit Trail keeps the old one in '
  'the rename row (0203, 0213).';
COMMENT ON COLUMN public.person_profiles.avatar_path IS
  'The person''s picture in the private avatars bucket: <user id>/avatar, or NULL for none. Set '
  'only by set_own_picture(), by the person, after the dashboard uploads the object; cleared by '
  'set_own_picture() or, on Remove Access, forget_person_picture(). Only the owner reads the '
  'object. A value naming a missing object shows the fallback (0213).';
COMMENT ON COLUMN public.person_profiles.updated_at IS
  'When the name was last set or cleared. Written by set_display_name(); a picture does not '
  'change it (0203, 0213).';
COMMENT ON COLUMN public.person_profiles.updated_by IS
  'Who last set or cleared the name: the person, or an Administrator. Written by '
  'set_display_name() (0203, 0213).';

-- -------------------------------------------------------------------------------------------------
-- 2. A row with no name writes no rename row
-- -------------------------------------------------------------------------------------------------
-- 0203's trigger function, which now also writes nothing when the name did not change: a row made
-- or deleted for a picture alone holds no name before or after.
CREATE OR REPLACE FUNCTION public.log_display_name_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_user_id uuid;
    v_old     text;
    v_new     text;
BEGIN
    IF TG_OP = 'INSERT' THEN
        v_user_id := NEW.user_id;
        v_new := NEW.display_name;
    ELSIF TG_OP = 'UPDATE' THEN
        v_user_id := NEW.user_id;
        v_old := OLD.display_name;
        v_new := NEW.display_name;
    ELSE
        IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.user_id) THEN
            RETURN OLD;
        END IF;
        v_user_id := OLD.user_id;
        v_old := OLD.display_name;
    END IF;

    IF v_old IS NOT DISTINCT FROM v_new THEN
        RETURN NULL;
    END IF;

    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'user_roles', v_user_id, 'DISPLAY_NAME_CHANGED',
        jsonb_build_object('display_name', v_old), jsonb_build_object('display_name', v_new),
        auth.uid(), public.audit_actor_source(), txid_current(), now()
    );
    RETURN NULL;
END
$$;

ALTER FUNCTION public.log_display_name_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.log_display_name_change() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.log_display_name_change() IS
  'Audit trigger for person_profiles: one DISPLAY_NAME_CHANGED row per change, in the person''s '
  'lane (entity_type user_roles, entity_id the person), with the old and new display_name. NULL '
  'is no name. Nothing when the name did not change, which includes a row made or deleted for a '
  'picture alone, and nothing for a row deleted with its account (0203, 0213).';

-- -------------------------------------------------------------------------------------------------
-- 3. Setting a name leaves the picture alone
-- -------------------------------------------------------------------------------------------------
-- 0203's function, except that clearing a name keeps a row that holds a picture: the picture is
-- its owner's alone to clear. Nothing here writes avatar_path; the self-check below holds that.
CREATE OR REPLACE FUNCTION public.set_display_name(p_user_id uuid, p_name text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_caller     uuid := auth.uid();
    v_name       text := nullif(btrim(p_name), '');
    v_old        text;
    v_constraint text;
BEGIN
    IF v_caller IS NULL OR public.is_machine_principal(v_caller) THEN
        RAISE EXCEPTION 'insufficient privileges to set a display name: sign in as a person'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_user_id IS DISTINCT FROM v_caller AND NOT public.has_role(ARRAY['Administrator']) THEN
        RAISE EXCEPTION 'insufficient privileges to set another person''s display name. '
            'An Administrator can, on the People tab.'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_user_id IS NULL OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
        PERFORM public.raise_not_found(format('person %s not found', coalesce(p_user_id::text, 'NULL')));
    END IF;
    IF public.is_machine_principal(p_user_id) THEN
        RAISE EXCEPTION '% is a machine identity, not a person. Name it under Machine identities.', p_user_id
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT display_name INTO v_old FROM public.person_profiles WHERE user_id = p_user_id FOR UPDATE;

    IF v_name IS NULL THEN
        DELETE FROM public.person_profiles WHERE user_id = p_user_id AND avatar_path IS NULL;
        UPDATE public.person_profiles
           SET display_name = NULL, updated_at = now(), updated_by = v_caller
         WHERE user_id = p_user_id AND display_name IS NOT NULL;
        RETURN NULL;
    END IF;
    IF v_old IS NOT DISTINCT FROM v_name THEN
        RETURN v_name;
    END IF;

    BEGIN
        INSERT INTO public.person_profiles (user_id, display_name, updated_at, updated_by)
        VALUES (p_user_id, v_name, now(), v_caller)
        ON CONFLICT (user_id) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               updated_at = EXCLUDED.updated_at,
               updated_by = EXCLUDED.updated_by;
    EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        RAISE EXCEPTION '%', CASE v_constraint
            WHEN 'person_profiles_display_name_length'
              THEN 'A display name is 80 characters at most.'
            WHEN 'person_profiles_display_name_printable'
              THEN 'A display name cannot contain a control character, such as a line break or a tab.'
            ELSE SQLERRM END
            USING ERRCODE = 'invalid_parameter_value';
    END;
    RETURN v_name;
END
$$;

ALTER FUNCTION public.set_display_name(p_user_id uuid, p_name text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_display_name(uuid, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.set_display_name(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.set_display_name(p_user_id uuid, p_name text) IS
  'Sets a person''s display name, trimmed; an empty or NULL name clears it. A person sets their '
  'own, an Administrator anyone''s; anything else is 42501. A machine identity is 22023, an '
  'unknown person a 404, and a name the CHECKs refuse 22023 with a sentence. Returns the name now '
  'held, or NULL. A change writes one DISPLAY_NAME_CHANGED audit row; the same name writes none. '
  'Never changes the person''s picture: clearing the name of a person who has one keeps the row '
  '(0203, 0213).';

-- -------------------------------------------------------------------------------------------------
-- 4. Reading names by id leaves out a row with no name, and names a job's requester
-- -------------------------------------------------------------------------------------------------
-- 0203's function. A row that holds only a picture is left out, as a person with no name always
-- was, so the answer says nothing about a picture. It also names the person who started a capture
-- or playback job, for the roles those jobs' SELECT policies admit, for the Capture page's History.
CREATE OR REPLACE FUNCTION public.display_names_for(p_ids uuid[]) RETURNS TABLE(user_id uuid, display_name text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT p.user_id, p.display_name
    FROM public.person_profiles p
   WHERE p.user_id = ANY (p_ids)
     AND p.display_name IS NOT NULL
     AND (p.user_id = auth.uid()
          OR ((SELECT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']))
              AND EXISTS (SELECT 1 FROM public.change_proposals cp WHERE cp.proposed_by = p.user_id))
          OR ((SELECT public.has_authority(ARRAY['archive:manage', 'audit_trail:read']))
              AND EXISTS (SELECT 1 FROM public.retired_entities r WHERE r.retired_by = p.user_id))
          OR ((SELECT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Auditor']))
              AND (EXISTS (SELECT 1 FROM public.capture_jobs j WHERE j.requested_by = p.user_id)
                   OR EXISTS (SELECT 1 FROM public.playback_jobs j WHERE j.requested_by = p.user_id))));
$$;

ALTER FUNCTION public.display_names_for(p_ids uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.display_names_for(uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.display_names_for(uuid[]) TO authenticated;

COMMENT ON FUNCTION public.display_names_for(p_ids uuid[]) IS
  'The display names of the given people that the caller can already see: their own, the '
  'proposer of a change proposal they may read (change_proposals_select_own_or_approver), the '
  'retirer of a retired entity they may read (retired_entities_select_privileged), and the person '
  'who started a capture or playback job they may read (capture_jobs_select_privileged, '
  'playback_jobs_select_privileged). Any other id is left out rather than refused, and a person '
  'with no name has no row, whether or not they have a picture (0203, 0213).';

-- -------------------------------------------------------------------------------------------------
-- 5. A person sets or clears their own picture
-- -------------------------------------------------------------------------------------------------
-- No id: the caller's own row, so nobody records or clears another person's picture. The dashboard
-- uploads the object first and calls this after; a value naming a missing object is shown as no
-- picture, so the order cannot strand a person behind an error.
CREATE OR REPLACE FUNCTION public.set_own_picture(p_present boolean) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_caller uuid := auth.uid();
    v_path   text;
BEGIN
    IF v_caller IS NULL
       OR NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Operator', 'Auditor']) THEN
        RAISE EXCEPTION 'insufficient privileges to set a picture: sign in as a person who holds a role'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NOT coalesce(p_present, false) THEN
        DELETE FROM public.person_profiles WHERE user_id = v_caller AND display_name IS NULL;
        UPDATE public.person_profiles SET avatar_path = NULL
         WHERE user_id = v_caller AND avatar_path IS NOT NULL;
        RETURN NULL;
    END IF;

    v_path := v_caller::text || '/avatar';
    INSERT INTO public.person_profiles (user_id, avatar_path) VALUES (v_caller, v_path)
    ON CONFLICT (user_id) DO UPDATE SET avatar_path = EXCLUDED.avatar_path;
    RETURN v_path;
END
$$;

ALTER FUNCTION public.set_own_picture(p_present boolean) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_own_picture(boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.set_own_picture(boolean) TO authenticated;

COMMENT ON FUNCTION public.set_own_picture(p_present boolean) IS
  'Records that the caller has a picture (true), at <their id>/avatar in the avatars bucket, or '
  'that they have none (false or NULL). Returns the path now held, or NULL. Acts on the caller '
  'alone and takes no id, so nobody sets or clears another person''s. The caller must hold a role, '
  'so a machine identity and a person whose access is removed are 42501. Upload the object first. '
  'Writes no audit row: nobody else sees a picture (0213).';

-- -------------------------------------------------------------------------------------------------
-- 6. Remove Access clears it
-- -------------------------------------------------------------------------------------------------
-- manage-people's remove action calls this as service_role after it has deleted the object, so a
-- restored account comes back with no picture. Refused for a person whose access is not removed:
-- otherwise the picture is its owner's alone to clear.
CREATE OR REPLACE FUNCTION public.forget_person_picture(p_user_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    IF p_user_id IS NULL OR NOT public.person_access_is_removed(p_user_id) THEN
        RAISE EXCEPTION 'a picture is forgotten only for a person whose access is removed'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    DELETE FROM public.person_profiles WHERE user_id = p_user_id AND display_name IS NULL;
    UPDATE public.person_profiles SET avatar_path = NULL
     WHERE user_id = p_user_id AND avatar_path IS NOT NULL;
END
$$;

ALTER FUNCTION public.forget_person_picture(p_user_id uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.forget_person_picture(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.forget_person_picture(uuid) TO service_role;

COMMENT ON FUNCTION public.forget_person_picture(p_user_id uuid) IS
  'service_role only: manage-people''s Remove Access, once it has deleted the person''s object '
  'from the avatars bucket. Clears person_profiles.avatar_path, and deletes the row when it holds '
  'no name. Refused (42501) unless the person''s access is removed. Idempotent (0213).';

-- -------------------------------------------------------------------------------------------------
-- 7. The test every avatars policy makes
-- -------------------------------------------------------------------------------------------------
-- Run as the caller, in their storage request. Every person role, Auditor included; a machine
-- identity and a removed person hold none.
CREATE OR REPLACE FUNCTION public.is_own_avatar_object(p_name text) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT coalesce(p_name = (SELECT auth.uid())::text || '/avatar', false)
     AND public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Operator', 'Auditor']);
$$;

ALTER FUNCTION public.is_own_avatar_object(p_name text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_own_avatar_object(text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.is_own_avatar_object(text) TO authenticated;

COMMENT ON FUNCTION public.is_own_avatar_object(p_name text) IS
  'True when an avatars object name is the caller''s own <id>/avatar and the caller holds a role. '
  'Every avatars policy in storage-policies.sql is this test and nothing else, so only the owner '
  'reads, writes or deletes their picture (0213).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_role text;
  f      text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.person_profiles'::regclass
                  AND attname = 'avatar_path' AND NOT attisdropped AND NOT attnotnull) THEN
    RAISE EXCEPTION '0213: person_profiles.avatar_path is missing or NOT NULL';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.person_profiles'::regclass
              AND attname = 'display_name' AND attnotnull) THEN
    RAISE EXCEPTION '0213: person_profiles.display_name is still NOT NULL, so a picture needs a name';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.person_profiles'::regclass
        AND conname IN ('person_profiles_avatar_path_is_the_owner_s',
                        'person_profiles_holds_a_name_or_a_picture')) <> 2 THEN
    RAISE EXCEPTION '0213: a person_profiles picture constraint is missing';
  END IF;

  -- Nothing but the two picture functions writes the column. set_display_name() is the one an
  -- Administrator calls for someone else.
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.set_display_name(uuid, text)'::regprocedure)
     ~ 'avatar_path\s*(=|,|\))' THEN
    RAISE EXCEPTION '0213: set_display_name() writes avatar_path, so an Administrator could change another person''s picture';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.log_display_name_change()'::regprocedure)
     !~ 'v_old IS NOT DISTINCT FROM v_new' THEN
    RAISE EXCEPTION '0213: log_display_name_change() writes a rename row for a row that holds only a picture';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.display_names_for(uuid[])'::regprocedure)
     !~ 'display_name IS NOT NULL' THEN
    RAISE EXCEPTION '0213: display_names_for() answers a row with no name, which tells the caller a picture exists';
  END IF;

  -- One boolean and no id: the caller's own picture and nobody else's.
  IF (SELECT pronargs <> 1 OR proargtypes[0] <> 'boolean'::regtype FROM pg_proc
       WHERE oid = 'public.set_own_picture(boolean)'::regprocedure) THEN
    RAISE EXCEPTION '0213: set_own_picture() takes something besides one boolean';
  END IF;

  FOREACH f IN ARRAY ARRAY['public.set_own_picture(boolean)', 'public.forget_person_picture(uuid)',
                           'public.set_display_name(uuid, text)', 'public.display_names_for(uuid[])',
                           'public.log_display_name_change()'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = f::regprocedure
                    AND prosecdef AND 'search_path=public' = ANY (proconfig)) THEN
      RAISE EXCEPTION '0213: % is not SECURITY DEFINER with its search_path pinned', f;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.is_own_avatar_object(text)'::regprocedure
                  AND NOT prosecdef AND 'search_path=public' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0213: is_own_avatar_object() must run as the caller, with its search_path pinned';
  END IF;

  FOREACH f IN ARRAY ARRAY['public.set_own_picture(boolean)', 'public.is_own_avatar_object(text)'] LOOP
    FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
      IF has_function_privilege(v_role, f, 'EXECUTE') THEN
        RAISE EXCEPTION '0213: % may execute %', v_role, f;
      END IF;
    END LOOP;
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION '0213: authenticated may not execute %; the dashboard and the bucket call it', f;
    END IF;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_function_privilege(v_role, 'public.forget_person_picture(uuid)', 'EXECUTE') THEN
      RAISE EXCEPTION '0213: % may execute forget_person_picture(), which clears another person''s picture', v_role;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.forget_person_picture(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0213: service_role may not execute forget_person_picture(); Remove Access calls it';
  END IF;

  -- A request with no person behind it is refused before anything is written.
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.set_own_picture(true);
    RAISE EXCEPTION '0213: set_own_picture() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF public.is_own_avatar_object(gen_random_uuid()::text || '/avatar') THEN
    RAISE EXCEPTION '0213: is_own_avatar_object() admitted a caller with no identity';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
