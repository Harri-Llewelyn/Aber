-- =============================================================================================
-- 0044_create_service_principal.sql
--
-- Create a machine identity from the Access Control page. See Machine Identities in
-- supabase/README.md.
--
-- A SEPARATE FILE FROM 0043 DELIBERATELY. That one records that a token was signed, which is an
-- observation. This one creates an identity that can hold a role, which is an authority -- and the
-- two should be reviewable apart rather than arriving as one diff where the smaller half carries
-- the larger.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT MAKES THIS SAFE TO EXPOSE AT ALL, GIVEN WHAT IT WRITES TO
--
-- It inserts into `auth.users`, which is GoTrue's schema, and nothing else in this application
-- does -- with one exception that is also the precedent: 0034 seeds the MCP principal exactly this
-- way, and explains why it is viable ("`id` is the only column on this image's `auth.users`
-- without a default").
--
-- THE ROW IT CREATES CANNOT SIGN IN, and that is enforced by construction rather than by intent.
-- Only `id` is supplied: no email, no password, no identity provider. 0042's predicate -- no email
-- and no password -- therefore holds for every row this writes, which is what makes the new
-- identity appear in the Service Identities list, and what makes 0043 willing to record a token
-- against it.
--
-- A caller cannot pass an email or a password because there is no parameter for one. That is a
-- deliberate absence: an optional email would make "can this account sign in?" a property of the
-- call site rather than of this function.
--
-- ---------------------------------------------------------------------------------------------
-- THE ROLE IS CHOSEN FROM THE FOUR THAT EXIST, WHICH IS THE WHOLE MODEL
--
-- §13 draws the line and it is the right one: "this is not a fine-grained access control engine.
-- The role set is fixed at four, the policies name them literally throughout the schema, and 0002
-- grants permissions to roles by id. Profiles are chosen from a list; nothing here builds a
-- permission graph."
--
-- So this takes a role NAME and resolves it, refusing anything not in `roles`. It does not create
-- roles, grant permissions, or accept a permission list.
--
-- ADMINISTRATOR AND Shopfloor_Manager ARE REFUSED AS THE TARGET ROLE, which is the one judgement
-- call in the file. A machine identity holding a privileged role would be a credential that can
-- write to the shopfloor and, once a token is signed for it, cannot be revoked. 0034 already
-- argued the narrower version of this for the MCP principal -- Operator rather than Auditor,
-- because Auditor can read the audit trail and the client has no use for it -- and the same
-- instinct applied one level up says a machine should not hold a role that can approve onboarding
-- or archive a cell. Relaxing this is a one-line change to `c_allowed`, taken deliberately.
-- =============================================================================================

SET search_path TO public;

CREATE OR REPLACE FUNCTION public.create_service_principal(
  p_role_name text,
  p_note      text DEFAULT NULL
)
RETURNS TABLE (principal_id uuid, roles text[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  -- Read-only roles only. See the header: a machine identity holding a privileged role becomes an
  -- unrevocable write credential the moment a token is signed for it.
  c_allowed  CONSTANT text[] := ARRAY['Operator', 'Auditor'];
  v_role_id  integer;
  v_id       uuid;
BEGIN
  -- ADMINISTRATOR ONLY, matching list_service_principals() (0042) and narrower than the credential
  -- RPCs in 0041. Creating an identity that can reach the stack is an access-control act, and
  -- `authz:manage` is granted to Administrator alone.
  IF NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'insufficient privileges to create a service principal'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_role_name IS NULL OR NOT (p_role_name = ANY(c_allowed)) THEN
    RAISE EXCEPTION
      'create_service_principal: role must be one of %, got %. A machine identity holding a '
      'privileged role would be an unrevocable write credential once a token is signed for it.',
      array_to_string(c_allowed, ', '), coalesce(p_role_name, 'null')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- BY NAME, not by a hardcoded id -- 0034's reasoning: `roles.id` is an integer assigned by 0001,
  -- and a migration that hardcodes it is asserting a fact about a sequence.
  SELECT id INTO v_role_id FROM public.roles WHERE name = p_role_name;
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'create_service_principal: the % role does not exist', p_role_name
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- A NOTE IS BOUNDED. It reaches the audit row below, which is append-only and cannot be pruned.
  IF p_note IS NOT NULL AND length(p_note) > 200 THEN
    RAISE EXCEPTION 'create_service_principal: p_note must be 200 characters or fewer'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_id := gen_random_uuid();

  -- ONLY `id`. See the header -- this is what makes the account unable to sign in, and it is a
  -- property of the INSERT rather than of anybody's intent.
  INSERT INTO auth.users (id) VALUES (v_id);
  INSERT INTO public.user_roles (user_id, role_id) VALUES (v_id::text, v_role_id);

  -- RECORDED HERE, AND ATTRIBUTED TO A PERSON, which is the one way this differs from 0043. That
  -- function is called by a host script holding a machine credential and cannot name anybody; this
  -- one is called by an Administrator with a session, so `auth.uid()` is the attribution rather
  -- than a claim -- the same reasoning as 0041's record_gateway_credential_issued().
  INSERT INTO public.digital_thread (
    entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
    causation_id, recorded_at
  ) VALUES (
    'service_principals',
    v_id,
    'INSERT',
    NULL,
    jsonb_build_object(
      'roles',       to_jsonb(ARRAY[p_role_name]),
      'note',        p_note,
      'can_sign_in', false
    ),
    auth.uid(),
    'user',
    txid_current(),
    now()
  );

  RETURN QUERY SELECT v_id, ARRAY[p_role_name];
END;
$$;

COMMENT ON FUNCTION public.create_service_principal(text, text) IS
  'Create a machine identity that cannot sign in, holding one read-only role. Administrator only. '
  'Writes to auth.users the way 0034 does -- id alone, so the account has no email, no password '
  'and no identity provider. Refuses a privileged role: once a token is signed for a principal it '
  'cannot be revoked.';

REVOKE ALL ON FUNCTION public.create_service_principal(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_service_principal(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_service_principal(text, text) TO service_role;


-- ---------------------------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------------------------
-- ASSERTS THE TWO REFUSALS, because the success path is what a caller exercises and the refusals
-- are what nothing does. A privileged role slipping through here is the difference between a
-- read-only machine identity and a permanent write credential on the shopfloor.
DO $selfcheck$
DECLARE
  v_admin_refused boolean := false;
  v_anon_exec     boolean;
BEGIN
  -- Called with no session at all -- auth.uid() is NULL, so has_role() is false and the privilege
  -- check must fire before anything is written. Asserted rather than assumed: the role check sits
  -- ahead of the role-name check on purpose, and reordering them would let an unauthorised caller
  -- learn which role names are accepted.
  BEGIN
    PERFORM public.create_service_principal('Administrator');
  EXCEPTION
    WHEN insufficient_privilege THEN v_admin_refused := true;
    WHEN invalid_parameter_value THEN
      RAISE EXCEPTION
        '0044 self-check: an unauthorised caller reached the role-name check. The privilege check '
        'must come first, or a refusal tells the caller what the accepted values are.';
  END;

  IF NOT v_admin_refused THEN
    RAISE EXCEPTION '0044 self-check: create_service_principal() ran without Administrator.';
  END IF;

  -- anon must not hold EXECUTE. Checked rather than trusted, for 0033's reason: the REVOKE above
  -- narrows a DEFAULT ACL rather than declining to grant, so if that ACL changes shape the REVOKE
  -- is what stops being sufficient and nothing else here would notice.
  SELECT has_function_privilege('anon', 'public.create_service_principal(text, text)', 'EXECUTE')
    INTO v_anon_exec;
  IF v_anon_exec THEN
    RAISE EXCEPTION '0044 self-check: anon holds EXECUTE on create_service_principal().';
  END IF;

  RAISE NOTICE '0044 self-check passed: unauthorised callers are refused before the role is read, '
               'and anon cannot execute it.';
END;
$selfcheck$;

NOTIFY pgrst, 'reload schema';
