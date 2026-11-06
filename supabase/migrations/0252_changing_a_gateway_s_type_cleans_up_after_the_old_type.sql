-- 0252: Changing a gateway's type cleans up after the old type.
--
-- The Edit form's Type select writes `deployment` and `is_simulated`, and nothing followed it: the
-- clean-up triggers fire on archive and delete alone. So a Remote gateway edited to Host kept
-- PENDING_ENROLLMENT and a live setup token, and a Host gateway edited to Remote kept a working
-- broker credential.
--
--   * clean_up_after_a_gateway_type_change() runs BEFORE UPDATE OF deployment, is_simulated, so the
--     change and what it ends are one audited UPDATE. Only crossing Remote's boundary ends
--     anything: every unredeemed setup token is burned, the credential the OLD row holds is
--     revoked as archiving revokes it, and its kept copy is forgotten. A gateway that leaves Remote
--     mid-enrolment, or becomes Remote, reads OFFLINE. Host, Simulated and Third-party all hold a
--     credential issued in the dashboard, so a change among them ends nothing.
--   * consume_gateway_enrollment_token() and its read-only twin peek_gateway_enrollment_token()
--     refuse a gateway that is not Remote, with the same no rows as an archived one. Both are
--     redeclared whole from 0001, unchanged but for that line and its comment.
--   * Once, for the rows earlier type changes left: a gateway that is not Remote reads OFFLINE
--     rather than an enrolment state, and its unredeemed tokens are burned. Nothing is revoked
--     here, because nothing records which type a credential was issued under.
--
-- Reasoning: supabase/README.md, "Changing a gateway's type cleans up after the old type (0252)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. Redeeming a token refuses a gateway that is not Remote
-- -------------------------------------------------------------------------------------------------
-- Declared before the trigger and the clean-up below, so a token issued under the old type cannot
-- be redeemed while they run.
CREATE OR REPLACE FUNCTION public.consume_gateway_enrollment_token(p_token text) RETURNS TABLE(gateway_id uuid, sparkplug_id text, sparkplug_group text, gateway_name text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_hash       text;
  v_gateway_id uuid;
BEGIN
  -- Shape-checked before it is hashed, so a malformed value cannot reach the index at all.
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;

  v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  -- An archived gateway is decommissioned, and one that is not Remote has no appliance: there is
  -- nothing it is legitimate to hand a credential to. A refused token is not burned: the UPDATE
  -- matches nothing, `consumed_at` stays NULL, and the row remains for a trigger to withdraw or to
  -- expire on its own.
  UPDATE public.gateway_enrollment_tokens t
     SET consumed_at = now()
    FROM public.gateways g
   WHERE t.token_hash = v_hash
     AND t.consumed_at IS NULL
     AND t.expires_at > now()
     AND g.id = t.gateway_id
     AND NOT g.is_archived
     AND g.deployment = 'remote'
  RETURNING t.gateway_id INTO v_gateway_id;

  IF v_gateway_id IS NULL THEN
    RETURN;
  END IF;

  -- The identity the appliance needs on the wire. `sparkplug_id` is the generated column the ACL
  -- pins the topic's edge-node segment to, and `sparkplug_group` is the other half of the address
  -- resolve_gateway() looks up first -- an appliance told only the node id falls through to the
  -- group-agnostic arm, which works until two groups exist.
  RETURN QUERY
  SELECT g.id, g.sparkplug_id, g.sparkplug_group, g.name
    FROM public.gateways g
   WHERE g.id = v_gateway_id;
END $_$;

ALTER FUNCTION public.consume_gateway_enrollment_token(p_token text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.consume_gateway_enrollment_token(p_token text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_gateway_enrollment_token(p_token text) TO service_role;

COMMENT ON FUNCTION public.consume_gateway_enrollment_token(p_token text) IS 'Atomically claim a live enrolment token and return the gateway''s wire identity. Returns NO ROWS for an unknown, expired or already-consumed token, and for a gateway that is ARCHIVED (0037) or not Remote (0252) -- deliberately indistinguishable. Called by the enroll-gateway edge function with the service-role key; the token itself is the authorisation, so no role is checked.';

CREATE OR REPLACE FUNCTION public.peek_gateway_enrollment_token(p_token text) RETURNS TABLE(gateway_id uuid, sparkplug_id text, sparkplug_group text, gateway_name text, expires_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_hash text;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;

  v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  -- The consumer's refusals, so the installer is served only for a token enrolment would redeem.
  RETURN QUERY
  SELECT g.id, g.sparkplug_id, g.sparkplug_group, g.name, t.expires_at
    FROM public.gateway_enrollment_tokens t
    JOIN public.gateways g ON g.id = t.gateway_id
   WHERE t.token_hash = v_hash
     AND t.consumed_at IS NULL
     AND t.expires_at > now()
     AND NOT g.is_archived
     AND g.deployment = 'remote';
END $_$;

ALTER FUNCTION public.peek_gateway_enrollment_token(p_token text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.peek_gateway_enrollment_token(p_token text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.peek_gateway_enrollment_token(p_token text) TO service_role;

COMMENT ON FUNCTION public.peek_gateway_enrollment_token(p_token text) IS 'Whether an enrolment token is live now, and for which gateway, WITHOUT consuming it: the read-only twin of consume_gateway_enrollment_token(), answering the same refusals with no rows (an archived gateway, or one that is not Remote, among them). Called by the gateway-install edge function with the service-role key to authorise the installer, playbook and .env downloads; only enrolment spends the token.';

-- -------------------------------------------------------------------------------------------------
-- 2. A type change ends what the old type held
-- -------------------------------------------------------------------------------------------------
-- SECURITY DEFINER because the Manager changing the type has no grant on the token table, Vault
-- or revoke_gateway_credential(). BEFORE, so the status and the revocation stamp are written by
-- the UPDATE that changes the type, and the Audit Trail holds one row for the whole act.
CREATE OR REPLACE FUNCTION public.clean_up_after_a_gateway_type_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  -- `UPDATE OF` fires whenever a column is in the SET list, and the Edit form sends both on every
  -- save. A change among Host, Simulated and Third-party crosses nothing: all three hold a
  -- credential issued in the dashboard. An archived gateway's were ended when it was archived.
  IF (OLD.deployment = 'remote') = (NEW.deployment = 'remote') OR OLD.is_archived THEN
    RETURN NEW;
  END IF;

  -- The setup command the old type was issued, burned as archiving burns it. Entering Remote finds
  -- none unless an earlier change left one, and a fresh token is issued by Set up.
  UPDATE public.gateway_enrollment_tokens
     SET consumed_at = now()
   WHERE gateway_id = NEW.id
     AND consumed_at IS NULL;

  -- Asked about OLD: gateway_has_broker_credential() decides by the row's deployment, and NEW
  -- would be asked for the new type's record, which a gateway that has just changed type lacks.
  IF public.gateway_has_broker_credential(OLD) THEN
    IF public.revoke_gateway_credential(OLD.sparkplug_id) THEN
      -- Stamped optimistically, as archiving stamps it: net.http_post is asynchronous.
      NEW.credential_revoked_at := now();
    END IF;
  END IF;

  -- The copy an Administrator could show again was of the credential just ended. A Remote gateway
  -- keeps none, so this deletes nothing on the way out of Remote.
  DELETE FROM vault.secrets WHERE name = 'gateway_broker_password:' || OLD.id::text;

  -- A Remote gateway waits OFFLINE until Set up issues a token. One that leaves Remote mid-enrolment
  -- reads as a new gateway of its type does; any other status is the gateway's own word.
  IF NEW.deployment = 'remote' OR NEW.status IN ('PENDING_ENROLLMENT', 'AWAITING_BIRTH') THEN
    NEW.status := 'OFFLINE';
  END IF;
  RETURN NEW;
END $$;

ALTER FUNCTION public.clean_up_after_a_gateway_type_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.clean_up_after_a_gateway_type_change() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.clean_up_after_a_gateway_type_change() IS 'Trigger function: when a gateway''s type crosses Remote''s boundary, burns its unredeemed enrolment tokens, revokes the broker credential the OLD row holds (gateway_has_broker_credential) and stamps credential_revoked_at, forgets the kept copy of a dashboard-issued password, and sets OFFLINE a gateway that becomes Remote or leaves Remote mid-enrolment. A change among Host, Simulated and Third-party, and any change to an archived gateway, ends nothing (0252).';

SELECT public.replay_trigger('public.gateways', 'trg_gateways_type_change_cleans_up', $ddl$
CREATE TRIGGER trg_gateways_type_change_cleans_up BEFORE UPDATE OF deployment, is_simulated ON public.gateways FOR EACH ROW EXECUTE FUNCTION public.clean_up_after_a_gateway_type_change();
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- 3. Once: what earlier type changes left behind
-- -------------------------------------------------------------------------------------------------
-- Each statement matches nothing once it has run, and the trigger keeps it so, so a replay
-- changes nothing.
UPDATE public.gateway_enrollment_tokens t
   SET consumed_at = now()
  FROM public.gateways g
 WHERE g.id = t.gateway_id
   AND g.deployment <> 'remote'
   AND t.consumed_at IS NULL;

UPDATE public.gateways
   SET status = 'OFFLINE'
 WHERE deployment <> 'remote'
   AND status IN ('PENDING_ENROLLMENT', 'AWAITING_BIRTH');

-- -------------------------------------------------------------------------------------------------
-- 4. Self-check
-- -------------------------------------------------------------------------------------------------
-- Of the shapes alone: a row an enrolment in flight writes while this runs is the trigger's to
-- judge, and a check of the rows would fail the boot on it.
DO $check$
DECLARE
  v_fn  text;
  v_def text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['public.consume_gateway_enrollment_token(text)',
                              'public.peek_gateway_enrollment_token(text)'] LOOP
    IF position('g.deployment = ''remote''' IN (SELECT prosrc FROM pg_proc WHERE oid = v_fn::regprocedure)) = 0 THEN
      RAISE EXCEPTION '0252: % does not refuse a gateway that is not Remote', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0252: a browser-facing role may execute %, and could learn which token values exist', v_fn;
    END IF;
  END LOOP;

  SELECT pg_get_triggerdef(t.oid) INTO v_def
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.gateways'::regclass
     AND t.tgname = 'trg_gateways_type_change_cleans_up';
  IF v_def IS NULL OR position('BEFORE UPDATE OF deployment, is_simulated' IN v_def) = 0 THEN
    RAISE EXCEPTION '0252: trg_gateways_type_change_cleans_up is not BEFORE UPDATE OF deployment, is_simulated (found %)', v_def;
  END IF;

  IF has_function_privilege('anon', 'public.clean_up_after_a_gateway_type_change()', 'EXECUTE') THEN
    RAISE EXCEPTION '0252: anon may execute clean_up_after_a_gateway_type_change()';
  END IF;
END
$check$;
