-- 0164: An Administrator can show a Host gateway's broker credential again.
--
-- A Host or Simulated gateway's credential is typed into the Node-RED editor by a person, so the
-- dashboard keeps an encrypted copy in Vault when it issues one, and an Administrator can show it
-- again from the gateway's drawer. Each showing is a CREDENTIAL_SHOWN row in the Audit Trail. The
-- copy is replaced when a new credential is issued and deleted when the gateway is archived or
-- deleted, which is when its broker account is disabled. Remote and Playback gateways keep none: an
-- appliance's credential never reaches a person, and the playback worker's is delivered to it.
--
-- The platform holding these passwords recoverably is an accepted risk (docs/security-model.md).

-- Written by gateway-credential, in the caller's session, straight after the mint: the roles that
-- may issue the credential are the roles that may keep its copy. False for a gateway that keeps
-- none (Remote, Playback, archived), so the caller need not know which those are.
CREATE OR REPLACE FUNCTION public.keep_gateway_credential(p_gateway_id uuid, p_password text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_gateway public.gateways%ROWTYPE;
  v_name    text := 'gateway_broker_password:' || p_gateway_id::text;
  v_id      uuid;
BEGIN
  IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'insufficient privileges to keep a gateway credential'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_gateway FROM public.gateways WHERE id = p_gateway_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gateway % does not exist', p_gateway_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_gateway.deployment <> 'host' OR v_gateway.is_shadow OR v_gateway.is_archived THEN
    RETURN false;
  END IF;

  IF coalesce(p_password, '') = '' THEN
    RAISE EXCEPTION 'a gateway credential cannot be empty'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT id INTO v_id FROM vault.secrets WHERE name = v_name;
  IF v_id IS NULL THEN
    PERFORM vault.create_secret(p_password, v_name,
      'The broker password last issued to gateway ' || v_gateway.sparkplug_id || '.');
  ELSE
    PERFORM vault.update_secret(v_id, p_password);
  END IF;
  RETURN true;
END
$$;

ALTER FUNCTION public.keep_gateway_credential(uuid, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.keep_gateway_credential(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.keep_gateway_credential(uuid, text) TO authenticated;

COMMENT ON FUNCTION public.keep_gateway_credential(uuid, text) IS
  'Keeps an encrypted copy (Vault) of the broker password just issued to an active Host or Simulated '
  'gateway, replacing any earlier one, so show_gateway_credential() can show it again. Administrator '
  'or Shopfloor_Manager, the roles that may issue it.';

-- Administrator only. NO_DATA_FOUND (404 through PostgREST) when no copy is kept: a credential issued
-- before 0164, or one whose copy could not be written.
CREATE OR REPLACE FUNCTION public.show_gateway_credential(p_gateway_id uuid)
RETURNS TABLE(mqtt_username text, password text, issued_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_gateway  public.gateways%ROWTYPE;
  v_password text;
  v_issued   timestamptz;
BEGIN
  IF NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'insufficient privileges to show a gateway credential'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_gateway FROM public.gateways WHERE id = p_gateway_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gateway % does not exist', p_gateway_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT s.decrypted_secret, s.updated_at INTO v_password, v_issued
    FROM vault.decrypted_secrets s
   WHERE s.name = 'gateway_broker_password:' || p_gateway_id::text;

  IF v_password IS NULL THEN
    RAISE EXCEPTION 'no copy of gateway %''s credential is kept; issue a new one to be able to show it again',
      v_gateway.name
      USING ERRCODE = 'no_data_found';
  END IF;

  -- The password itself is never in the row: who looked, at which gateway, and when.
  INSERT INTO public.audit_trail (
    entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
    causation_id, recorded_at
  ) VALUES (
    'gateways', v_gateway.id, 'CREDENTIAL_SHOWN', NULL,
    jsonb_build_object(
      'name',          v_gateway.name,
      'sparkplug_id',  v_gateway.sparkplug_id,
      'mqtt_username', v_gateway.sparkplug_id
    ),
    auth.uid(), 'user', txid_current(), now()
  );

  RETURN QUERY SELECT v_gateway.sparkplug_id, v_password, v_issued;
END
$$;

ALTER FUNCTION public.show_gateway_credential(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.show_gateway_credential(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.show_gateway_credential(uuid) TO authenticated;

COMMENT ON FUNCTION public.show_gateway_credential(uuid) IS
  'Administrator only: the kept copy of a Host or Simulated gateway''s broker credential, recording a '
  'CREDENTIAL_SHOWN row in the Audit Trail each time. NO_DATA_FOUND when no copy is kept.';

-- The copy goes with the broker account: on archive (revoke_credential_on_decommission disables it)
-- and on delete.
CREATE OR REPLACE FUNCTION public.forget_gateway_credential()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (NEW.is_archived AND NOT coalesce(OLD.is_archived, false)) THEN
    DELETE FROM vault.secrets WHERE name = 'gateway_broker_password:' || OLD.id::text;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION public.forget_gateway_credential() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.forget_gateway_credential() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_gateways_forget_credential ON public.gateways;
CREATE TRIGGER trg_gateways_forget_credential
  AFTER UPDATE OF is_archived OR DELETE ON public.gateways
  FOR EACH ROW EXECUTE FUNCTION public.forget_gateway_credential();

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.keep_gateway_credential(uuid, text)',
                           'public.show_gateway_credential(uuid)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION '0164: anon may execute %, which reads or writes a broker password', f;
    END IF;
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION '0164: authenticated may not execute %; the dashboard calls it', f;
    END IF;
  END LOOP;
END
$$;
