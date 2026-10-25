-- 0203: A person can have a display name. The email stays the identifier.
--
-- person_profiles holds one row per person who has a name: trimmed, 1 to 80 characters, no control
-- characters. No name is no row. It is named for the person rather than the name, so a later column
-- about the person (their picture) has somewhere to go.
--
--   * set_display_name() is the one writer. A person sets their own; an Administrator sets anyone's;
--     anything else is refused. It trims, and an empty or NULL name clears it. A machine identity
--     has no display name: it is named under Machine identities.
--   * Each change writes one DISPLAY_NAME_CHANGED row in the person's lane of the Audit Trail
--     (entity_type user_roles, beside PERSON_ADDED and ROLE_GRANTED): who, old name, new name.
--     Setting the name a person already has writes nothing.
--   * A person reads their own row. Everyone else reads a name through a function that answers
--     only where the caller can already see the person: list_people() (Administrator),
--     list_user_accounts() (Administrator, Auditor) and display_names_for() (the proposers and
--     retirers on Approvals and Archived Entities). list_people() and list_user_accounts() gain
--     their display_name column where they are declared, in 0166 and 0001, because those files
--     replay first and a later redeclaration cannot change a return type.
--   * The Audit Trail's search finds a person by name as well as by email.
--
-- Reasoning: supabase/README.md, "A person can have a display name (0203)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The table
-- -------------------------------------------------------------------------------------------------
-- The character class is the dashboard's and manage-people's (utils/displayName.js,
-- functions/manage-people/displayName.ts); check-mirror-drift.mjs holds the three together. It is
-- Unicode's control characters and its bidirectional controls, which can make text beside a name
-- read in another order.
CREATE TABLE IF NOT EXISTS public.person_profiles (
    user_id uuid NOT NULL,
    display_name text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT person_profiles_pkey PRIMARY KEY (user_id),
    CONSTRAINT person_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
    CONSTRAINT person_profiles_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL,
    CONSTRAINT person_profiles_display_name_trimmed CHECK (display_name = btrim(display_name)),
    CONSTRAINT person_profiles_display_name_length CHECK (char_length(display_name) BETWEEN 1 AND 80),
    CONSTRAINT person_profiles_display_name_printable CHECK (display_name !~ '[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]')
);

ALTER TABLE public.person_profiles OWNER TO postgres;
ALTER TABLE public.person_profiles ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.person_profiles IS
  'One row per person who has a display name; no row is no name. Written only by '
  'set_display_name(), which writes a DISPLAY_NAME_CHANGED audit row through '
  'log_display_name_change(). A person reads their own row; everyone else reads names through '
  'list_people(), list_user_accounts() and display_names_for(). Deleting the account deletes '
  'the row (0203).';
COMMENT ON COLUMN public.person_profiles.display_name IS
  'The name the dashboard shows first, with the email beside it where trust matters. Trimmed, 1 '
  'to 80 characters, no control characters. Read live, so a renamed person shows under the new '
  'name everywhere; the Audit Trail keeps the old one in the rename row.';
COMMENT ON COLUMN public.person_profiles.updated_at IS
  'When the name was last set. Written by set_display_name().';
COMMENT ON COLUMN public.person_profiles.updated_by IS
  'Who last set the name: the person, or an Administrator. Written by set_display_name().';

-- -------------------------------------------------------------------------------------------------
-- 2. Who reaches it
-- -------------------------------------------------------------------------------------------------
-- A person reads their own row. Nothing writes it but set_display_name(), so the audit row cannot
-- be skipped. anon and service_role hold nothing.
REVOKE ALL ON TABLE public.person_profiles FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.person_profiles TO authenticated;

SELECT public.replay_policy('public.person_profiles', 'person_profiles_select_own', $ddl$
CREATE POLICY person_profiles_select_own ON public.person_profiles FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- 3. Each change is one Audit Trail row
-- -------------------------------------------------------------------------------------------------
-- In the person's lane: entity_type user_roles, keyed by the person, as the People acts are. A
-- row deleted because its account was deleted is not a rename, and writes nothing.
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
  'is no name. Nothing for an UPDATE that leaves the name as it was, or a row deleted with its '
  'account (0203).';

COMMENT ON FUNCTION public.audit_actor_source() IS
  'The actor_source a function writing its own audit_trail row records: user for a person, '
  'ingestion for the ingestion principal, service for any other machine identity, migration for '
  'the owner''s session with no token. log_audit_trail_event()''s ladder without the X-Aber-Actor '
  'header (0193). Called by the capture and playback gates and by log_display_name_change() (0203).';

SELECT public.replay_trigger('public.person_profiles', 'person_profiles_audit_trail', $ddl$
CREATE TRIGGER person_profiles_audit_trail AFTER INSERT OR DELETE ON public.person_profiles FOR EACH ROW EXECUTE FUNCTION public.log_display_name_change();
$ddl$);
SELECT public.replay_trigger('public.person_profiles', 'person_profiles_audit_trail_update', $ddl$
CREATE TRIGGER person_profiles_audit_trail_update AFTER UPDATE ON public.person_profiles FOR EACH ROW WHEN ((old.display_name IS DISTINCT FROM new.display_name)) EXECUTE FUNCTION public.log_display_name_change();
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- 4. Setting a name
-- -------------------------------------------------------------------------------------------------
-- The table's CHECKs are the rule. A refusal is re-raised as invalid_parameter_value with a
-- sentence the dashboard can show, so the rule is stated once.
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
        DELETE FROM public.person_profiles WHERE user_id = p_user_id;
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
  'held, or NULL. A change writes one DISPLAY_NAME_CHANGED audit row; the same name writes none '
  '(0203).';

-- -------------------------------------------------------------------------------------------------
-- 5. Reading a name by id, for Approvals and Archived Entities
-- -------------------------------------------------------------------------------------------------
-- Answers for the caller's own id, for the proposer of a change_proposals row the caller may read,
-- and for the retirer of a retired_entities row the caller may read. The role and permission tests
-- are those tables' SELECT policies. Any other id is left out, so the page shows the email alone.
CREATE OR REPLACE FUNCTION public.display_names_for(p_ids uuid[]) RETURNS TABLE(user_id uuid, display_name text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT p.user_id, p.display_name
    FROM public.person_profiles p
   WHERE p.user_id = ANY (p_ids)
     AND (p.user_id = auth.uid()
          OR ((SELECT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']))
              AND EXISTS (SELECT 1 FROM public.change_proposals cp WHERE cp.proposed_by = p.user_id))
          OR ((SELECT public.has_authority(ARRAY['archive:manage', 'audit_trail:read']))
              AND EXISTS (SELECT 1 FROM public.retired_entities r WHERE r.retired_by = p.user_id)));
$$;

ALTER FUNCTION public.display_names_for(p_ids uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.display_names_for(uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.display_names_for(uuid[]) TO authenticated;

COMMENT ON FUNCTION public.display_names_for(p_ids uuid[]) IS
  'The display names of the given people that the caller can already see: their own, the '
  'proposer of a change proposal they may read (change_proposals_select_own_or_approver), and '
  'the retirer of a retired entity they may read (retired_entities_select_privileged). Any other '
  'id is left out rather than refused, and a person with no name has no row (0203).';

-- -------------------------------------------------------------------------------------------------
-- 6. The Audit Trail's search finds a person by name
-- -------------------------------------------------------------------------------------------------
-- 0001's definition, matching display_name as well as email. The SET clause restates 0176's pin.
CREATE OR REPLACE FUNCTION public.audit_trail_user_ids_matching(p_pattern text) RETURNS uuid[]
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT coalesce(array_agg(u.id), '{}'::uuid[])
    FROM auth.users u
    LEFT JOIN public.person_profiles p ON p.user_id = u.id
   WHERE p_pattern IS NOT NULL
     AND public.has_role(ARRAY['Administrator', 'Auditor'])
     AND (u.email ILIKE p_pattern OR p.display_name ILIKE p_pattern)
$$;

ALTER FUNCTION public.audit_trail_user_ids_matching(p_pattern text) OWNER TO postgres;

COMMENT ON FUNCTION public.audit_trail_user_ids_matching(p_pattern text) IS
  'The ids of people whose email or display name matches a LIKE pattern, for the one disjunct of '
  'audit_trail_page()''s search that cannot read its answer out of an audit payload: a person''s '
  'lane is labelled with the person (0116, 0203). Administrator and Auditor only, and an empty '
  'array rather than an error for anybody else, because this is part of a query rather than a '
  'request of its own.';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_role      text;
  v_privilege text;
  f           text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.person_profiles'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION '0203: person_profiles does not have row-level security on';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
    IF has_table_privilege(v_role, 'public.person_profiles', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') THEN
      RAISE EXCEPTION '0203: % holds a privilege on person_profiles', v_role;
    END IF;
  END LOOP;
  IF NOT has_table_privilege('authenticated', 'public.person_profiles', 'SELECT') THEN
    RAISE EXCEPTION '0203: authenticated cannot read its own person_profiles row';
  END IF;
  -- One privilege per call: has_table_privilege() answers true when ANY of a list is held.
  FOREACH v_privilege IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
    IF has_table_privilege('authenticated', 'public.person_profiles', v_privilege) THEN
      RAISE EXCEPTION '0203: authenticated may % person_profiles directly, around its audit row', v_privilege;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.person_profiles'::regclass
                  AND polname = 'person_profiles_select_own') THEN
    RAISE EXCEPTION '0203: person_profiles_select_own is missing';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.person_profiles'::regclass
        AND tgname IN ('person_profiles_audit_trail', 'person_profiles_audit_trail_update')) <> 2 THEN
    RAISE EXCEPTION '0203: a person_profiles audit trigger is missing';
  END IF;

  FOREACH f IN ARRAY ARRAY['public.set_display_name(uuid, text)', 'public.display_names_for(uuid[])',
                           'public.list_people()', 'public.list_user_accounts()'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION '0203: anon may execute %', f;
    END IF;
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION '0203: authenticated may not execute %; the dashboard calls it', f;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public.log_display_name_change()', 'EXECUTE') THEN
    RAISE EXCEPTION '0203: authenticated may execute log_display_name_change()';
  END IF;

  IF pg_get_function_result('public.list_people()'::regprocedure) NOT LIKE '%display_name text%' THEN
    RAISE EXCEPTION '0203: list_people() returns no display_name; 0166 did not declare it';
  END IF;
  IF pg_get_function_result('public.list_user_accounts()'::regprocedure) NOT LIKE '%display_name text%' THEN
    RAISE EXCEPTION '0203: list_user_accounts() returns no display_name; 0001 did not declare it';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.audit_trail_user_ids_matching(text)'::regprocedure
                  AND prosecdef AND 'search_path=public' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0203: audit_trail_user_ids_matching() lost SECURITY DEFINER or its search_path pin';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
