-- 0231: A person acknowledges an alert, with a reason, and the acknowledgement holds until it resolves.
--
-- platform_alerts has five nullable columns that say who acknowledged an occurrence, when, and why:
-- acknowledged_at, acknowledged_by, acknowledged_by_email, acknowledgement_reason and
-- acknowledgement_note. status stays firing or resolved, so no reader of status changes meaning.
-- 0001 states the columns and platform_alerts_active, which returns them, as it did for 0220's.
--
--   * The reason is one of a closed set: investigating, known_cause, planned_work,
--     sensor_or_model_fault, threshold_wrong and other. The note is optional, trimmed, and at most
--     200 characters, as a backup's note is; other needs one.
--   * acknowledge_alert() and withdraw_alert_acknowledgement() are the only writers. Each is
--     SECURITY DEFINER and writes one Audit Trail row naming the alert, its subject and when it
--     started. An Operator, a Shopfloor Manager or an Administrator acknowledges a row they may
--     read, by the select policy's own predicate: a machine identity's alert is the
--     Administrator's alone (0204). The acknowledger withdraws it, and so may a Shopfloor Manager
--     or an Administrator. A resolved, superseded or acknowledged row is refused with a reason.
--   * A BEFORE INSERT trigger copies the acknowledgement onto a new occurrence of the fingerprint
--     while the newest earlier occurrence is still firing and acknowledged, so it holds until the
--     alert resolves. Any writer gets it without changing; grafana-alert-webhook does not change.
--
-- 0232 files the audit rows: their lane, their class and the Audit Trail's map of kinds.
--
-- Reasoning: supabase/README.md, "A person acknowledges an alert (0231)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The columns, which 0001 states
-- -------------------------------------------------------------------------------------------------
COMMENT ON COLUMN public.platform_alerts.acknowledged_at IS
  'When a person acknowledged this occurrence, or the occurrence it inherited the acknowledgement '
  'from. NULL while unacknowledged. Written only by acknowledge_alert(), '
  'withdraw_alert_acknowledgement() and the inheritance trigger (0231).';

COMMENT ON COLUMN public.platform_alerts.acknowledged_by IS
  'The auth.users id of the person who acknowledged it. No foreign key, as for every other actor '
  'column a row outlives (0231).';

COMMENT ON COLUMN public.platform_alerts.acknowledged_by_email IS
  'The acknowledger''s email address as their access token carried it when they acknowledged, so '
  'every reader of the alert can see who did it. NULL when the token carried none (0231).';

COMMENT ON COLUMN public.platform_alerts.acknowledgement_reason IS
  'Why it was acknowledged: investigating, known_cause, planned_work, sensor_or_model_fault, '
  'threshold_wrong or other. A closed set, so the reasons can be counted later (0231).';

COMMENT ON COLUMN public.platform_alerts.acknowledgement_note IS
  'The acknowledger''s own words, trimmed, at most 200 characters. Optional, except with the '
  'reason other (0231).';

-- -------------------------------------------------------------------------------------------------
-- 2. Their CHECKs
-- -------------------------------------------------------------------------------------------------
-- The reasons are acknowledge_alert()'s, below, and the dashboard's (ALERT_ACKNOWLEDGEMENT_REASONS
-- in frontend/src/constants.js); mirror check 45 holds the three together.
DO $c$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'platform_alerts_acknowledgement_reason_valid'
                AND conrelid = 'public.platform_alerts'::regclass
                AND public.live_constraint_definition(conrelid, conname) <> 'CHECK ((acknowledgement_reason = ANY (ARRAY[''investigating''::text, ''known_cause''::text, ''planned_work''::text, ''sensor_or_model_fault''::text, ''threshold_wrong''::text, ''other''::text])))') THEN
    ALTER TABLE public.platform_alerts DROP CONSTRAINT platform_alerts_acknowledgement_reason_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'platform_alerts_acknowledgement_reason_valid'
                    AND conrelid = 'public.platform_alerts'::regclass) THEN
    ALTER TABLE public.platform_alerts
        ADD CONSTRAINT platform_alerts_acknowledgement_reason_valid CHECK ((acknowledgement_reason = ANY (ARRAY['investigating'::text, 'known_cause'::text, 'planned_work'::text, 'sensor_or_model_fault'::text, 'threshold_wrong'::text, 'other'::text])));
  END IF;
END $c$;

-- An acknowledgement is whole: a time, a person and a reason together, and no email or note without them.
DO $c$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'platform_alerts_acknowledgement_is_whole'
                AND conrelid = 'public.platform_alerts'::regclass
                AND public.live_constraint_definition(conrelid, conname) <> 'CHECK ((((acknowledged_at IS NULL) = (acknowledged_by IS NULL)) AND ((acknowledged_at IS NULL) = (acknowledgement_reason IS NULL)) AND ((acknowledged_at IS NOT NULL) OR ((acknowledged_by_email IS NULL) AND (acknowledgement_note IS NULL)))))') THEN
    ALTER TABLE public.platform_alerts DROP CONSTRAINT platform_alerts_acknowledgement_is_whole;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'platform_alerts_acknowledgement_is_whole'
                    AND conrelid = 'public.platform_alerts'::regclass) THEN
    ALTER TABLE public.platform_alerts
        ADD CONSTRAINT platform_alerts_acknowledgement_is_whole CHECK ((((acknowledged_at IS NULL) = (acknowledged_by IS NULL)) AND ((acknowledged_at IS NULL) = (acknowledgement_reason IS NULL)) AND ((acknowledged_at IS NOT NULL) OR ((acknowledged_by_email IS NULL) AND (acknowledgement_note IS NULL)))));
  END IF;
END $c$;

-- The note: trimmed and 1-200 characters, and required with other.
DO $c$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'platform_alerts_acknowledgement_note_valid'
                AND conrelid = 'public.platform_alerts'::regclass
                AND public.live_constraint_definition(conrelid, conname) <> 'CHECK ((((acknowledgement_note IS NULL) AND (acknowledgement_reason IS DISTINCT FROM ''other''::text)) OR ((acknowledgement_note IS NOT NULL) AND (char_length(acknowledgement_note) >= 1) AND (char_length(acknowledgement_note) <= 200) AND (acknowledgement_note = btrim(acknowledgement_note)))))') THEN
    ALTER TABLE public.platform_alerts DROP CONSTRAINT platform_alerts_acknowledgement_note_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'platform_alerts_acknowledgement_note_valid'
                    AND conrelid = 'public.platform_alerts'::regclass) THEN
    ALTER TABLE public.platform_alerts
        ADD CONSTRAINT platform_alerts_acknowledgement_note_valid CHECK ((((acknowledgement_note IS NULL) AND (acknowledgement_reason IS DISTINCT FROM 'other'::text)) OR ((acknowledgement_note IS NOT NULL) AND (char_length(acknowledgement_note) >= 1) AND (char_length(acknowledgement_note) <= 200) AND (acknowledgement_note = btrim(acknowledgement_note)))));
  END IF;
END $c$;

-- -------------------------------------------------------------------------------------------------
-- 3. A new occurrence inherits its fingerprint's acknowledgement
-- -------------------------------------------------------------------------------------------------
-- From the newest earlier occurrence, while that one is still firing: a later resolved occurrence
-- supersedes a firing one, as in platform_alerts_active, so nothing is inherited once the alert has
-- resolved. A resolved row, or one that arrives acknowledged, is left as it is. On the webhook's
-- upsert the trigger also fires for a row that then conflicts, but the update sets only the
-- columns the webhook sends, so an occurrence's own acknowledgement is never overwritten.
-- SECURITY DEFINER, so a writer that may not read every row still finds the earlier one.
CREATE OR REPLACE FUNCTION public.platform_alerts_inherit_acknowledgement() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_prior public.platform_alerts;
BEGIN
  IF NEW.status IS DISTINCT FROM 'firing' OR NEW.acknowledged_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO v_prior
    FROM public.platform_alerts a
   WHERE a.fingerprint = NEW.fingerprint
     AND a.starts_at < NEW.starts_at
   ORDER BY a.starts_at DESC, a.recorded_at DESC
   LIMIT 1;
  IF FOUND AND v_prior.status = 'firing' AND v_prior.acknowledged_at IS NOT NULL THEN
    NEW.acknowledged_at        := v_prior.acknowledged_at;
    NEW.acknowledged_by        := v_prior.acknowledged_by;
    NEW.acknowledged_by_email  := v_prior.acknowledged_by_email;
    NEW.acknowledgement_reason := v_prior.acknowledgement_reason;
    NEW.acknowledgement_note   := v_prior.acknowledgement_note;
  END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION public.platform_alerts_inherit_acknowledgement() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_alerts_inherit_acknowledgement() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.platform_alerts_inherit_acknowledgement() IS
  'BEFORE INSERT on platform_alerts: a firing occurrence that arrives unacknowledged takes the '
  'acknowledgement of the newest earlier occurrence of its fingerprint, when that one is still '
  'firing and acknowledged. Writes no audit row: nobody acted (0231).';

SELECT public.replay_trigger('public.platform_alerts', 'trg_platform_alerts_inherit_acknowledgement', $ddl$
CREATE TRIGGER trg_platform_alerts_inherit_acknowledgement BEFORE INSERT ON public.platform_alerts FOR EACH ROW EXECUTE FUNCTION public.platform_alerts_inherit_acknowledgement();
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- 4. What an audit row says about an alert
-- -------------------------------------------------------------------------------------------------
-- The alert's name, its severity, when it started, the occurrence and its fingerprint, and its
-- subject. `name` is what the Audit Trail labels a lane by: the alert and, for a device or a
-- gateway, the asset it is about, so two machines' alerts of one rule are two lanes that read apart.
CREATE OR REPLACE FUNCTION public.alert_audit_identity(p_alert public.platform_alerts) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT jsonb_build_object(
    'name', CASE WHEN p_alert.entity_type IN ('device', 'gateway')
                 THEN p_alert.alert_name || ' · ' || coalesce(s.subject_name, p_alert.sparkplug_id, 'unknown')
                 ELSE p_alert.alert_name END,
    'alert_name', p_alert.alert_name,
    'severity', p_alert.severity,
    'starts_at', to_char(p_alert.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'alert_id', p_alert.id,
    'fingerprint', p_alert.fingerprint,
    'subject_kind', p_alert.entity_type,
    'subject_id', p_alert.entity_id,
    'subject_name', s.subject_name,
    'sparkplug_id', p_alert.sparkplug_id)
    FROM (SELECT CASE p_alert.entity_type
                   WHEN 'device' THEN (SELECT d.name FROM public.devices d WHERE d.id = p_alert.entity_id)
                   WHEN 'gateway' THEN (SELECT g.name FROM public.gateways g WHERE g.id = p_alert.entity_id)
                   WHEN 'service_identity' THEN (SELECT m.name FROM public.machine_principals m
                                                  WHERE m.principal_id = p_alert.entity_id)
                 END AS subject_name) s;
$$;

ALTER FUNCTION public.alert_audit_identity(public.platform_alerts) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.alert_audit_identity(public.platform_alerts) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.alert_audit_identity(public.platform_alerts) IS
  'The identity an alert''s acknowledgement audit rows carry: name (the alert, and the device or '
  'gateway it is about), alert_name, severity, starts_at, alert_id, fingerprint, subject_kind, '
  'subject_id, subject_name and sparkplug_id. Called by acknowledge_alert() and '
  'withdraw_alert_acknowledgement() (0231).';

-- -------------------------------------------------------------------------------------------------
-- 5. Acknowledging
-- -------------------------------------------------------------------------------------------------
-- A person's act: a machine identity holds no role (user_roles refuses it one), so it is refused
-- with every other caller outside the three roles. The row is locked, so two
-- people acknowledging at once are taken in turn and the second is told who was first. The audit
-- row is in the alert's lane, one per fingerprint; a machine identity's alert is in that identity's
-- lane, which only an Administrator and an Auditor read.
CREATE OR REPLACE FUNCTION public.acknowledge_alert(p_alert_id uuid, p_reason text,
                                                    p_note text DEFAULT NULL)
RETURNS public.platform_alerts
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_note     text := nullif(btrim(coalesce(p_note, '')), '');
  v_alert    public.platform_alerts;
  v_newest   uuid;
  v_identity jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Operator']) THEN
    RAISE EXCEPTION 'Only an Operator, a Shopfloor Manager or an Administrator may acknowledge an alert.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reason IS NULL OR NOT p_reason = ANY (ARRAY['investigating', 'known_cause', 'planned_work',
                                                   'sensor_or_model_fault', 'threshold_wrong', 'other']) THEN
    RAISE EXCEPTION 'The reason is investigating, known_cause, planned_work, sensor_or_model_fault, '
                    'threshold_wrong or other, not %.', coalesce(quote_literal(p_reason), 'NULL')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF char_length(coalesce(v_note, '')) > 200 THEN
    RAISE EXCEPTION 'The note is at most 200 characters.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_reason = 'other' AND v_note IS NULL THEN
    RAISE EXCEPTION 'Other needs a note saying what the reason is.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_alert FROM public.platform_alerts WHERE id = p_alert_id FOR UPDATE;
  -- platform_alerts_select_authenticated's predicate: a row the caller cannot read is not there.
  IF NOT FOUND OR NOT (v_alert.entity_type <> 'service_identity' OR public.has_role(ARRAY['Administrator'])) THEN
    PERFORM public.raise_not_found(format('There is no alert %s.', p_alert_id));
  END IF;
  IF v_alert.status <> 'firing' THEN
    RAISE EXCEPTION 'This alert resolved at %, so there is nothing to acknowledge.',
      to_char(v_alert.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI "UTC"')
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT a.id INTO v_newest
    FROM public.platform_alerts a
   WHERE a.fingerprint = v_alert.fingerprint
   ORDER BY a.starts_at DESC, a.recorded_at DESC
   LIMIT 1;
  IF v_newest <> v_alert.id THEN
    RAISE EXCEPTION 'A newer occurrence of this alert has replaced this one, so there is nothing to acknowledge.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_alert.acknowledged_at IS NOT NULL THEN
    RAISE EXCEPTION 'Already acknowledged by % at %.',
      coalesce(v_alert.acknowledged_by_email, v_alert.acknowledged_by::text),
      to_char(v_alert.acknowledged_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI "UTC"')
      USING ERRCODE = 'unique_violation';
  END IF;

  v_identity := public.alert_audit_identity(v_alert);
  UPDATE public.platform_alerts
     SET acknowledged_at = now(),
         acknowledged_by = v_uid,
         acknowledged_by_email = nullif(auth.jwt() ->> 'email', ''),
         acknowledgement_reason = p_reason,
         acknowledgement_note = v_note
   WHERE id = v_alert.id
  RETURNING * INTO v_alert;

  -- old_data is the alert, new_data the alert with the acknowledgement, so the Audit Trail's
  -- drawer shows the reason and the note as what changed.
  IF v_alert.entity_type = 'service_identity' THEN
    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'service_principals', coalesce(v_alert.entity_id, md5('platform_alerts:' || v_alert.fingerprint)::uuid),
        'ALERT_ACKNOWLEDGED', v_identity,
        v_identity || jsonb_build_object('reason', p_reason, 'note', v_note),
        v_uid, public.audit_actor_source(), txid_current(), now()
    );
  ELSE
    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'platform_alerts', md5('platform_alerts:' || v_alert.fingerprint)::uuid,
        'ALERT_ACKNOWLEDGED', v_identity,
        v_identity || jsonb_build_object('reason', p_reason, 'note', v_note),
        v_uid, public.audit_actor_source(), txid_current(), now()
    );
  END IF;
  RETURN v_alert;
END
$$;

ALTER FUNCTION public.acknowledge_alert(uuid, text, text) OWNER TO postgres;

COMMENT ON FUNCTION public.acknowledge_alert(uuid, text, text) IS
  'Acknowledges a firing alert occurrence: an Operator, a Shopfloor Manager or an Administrator '
  '(42501 otherwise), on a row they may read (404 otherwise; a service_identity '
  'alert is the Administrator''s alone). p_reason is investigating, known_cause, planned_work, '
  'sensor_or_model_fault, threshold_wrong or other; p_note is trimmed, at most 200 characters, and '
  'required with other (22023). A resolved or superseded occurrence is 23514, and one already '
  'acknowledged 23505, naming who and when. Writes one ALERT_ACKNOWLEDGED audit row and returns '
  'the row (0231).';

-- -------------------------------------------------------------------------------------------------
-- 6. Withdrawing
-- -------------------------------------------------------------------------------------------------
-- The acknowledger, or a Shopfloor Manager or an Administrator. A resolved occurrence keeps its
-- acknowledgement as history, so only a firing one is withdrawn.
CREATE OR REPLACE FUNCTION public.withdraw_alert_acknowledgement(p_alert_id uuid)
RETURNS public.platform_alerts
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_alert    public.platform_alerts;
  v_identity jsonb;
  v_held     jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Operator']) THEN
    RAISE EXCEPTION 'Only an Operator, a Shopfloor Manager or an Administrator may withdraw an acknowledgement.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_alert FROM public.platform_alerts WHERE id = p_alert_id FOR UPDATE;
  IF NOT FOUND OR NOT (v_alert.entity_type <> 'service_identity' OR public.has_role(ARRAY['Administrator'])) THEN
    PERFORM public.raise_not_found(format('There is no alert %s.', p_alert_id));
  END IF;
  IF v_alert.acknowledged_at IS NULL THEN
    RAISE EXCEPTION 'This alert is not acknowledged, so there is nothing to withdraw.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_alert.status <> 'firing' THEN
    RAISE EXCEPTION 'This alert resolved at %, and its acknowledgement is kept as its record.',
      to_char(v_alert.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI "UTC"')
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_alert.acknowledged_by IS DISTINCT FROM v_uid
     AND NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'Only the person who acknowledged it, a Shopfloor Manager or an Administrator may withdraw it.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_identity := public.alert_audit_identity(v_alert);
  v_held := jsonb_build_object(
    'reason', v_alert.acknowledgement_reason, 'note', v_alert.acknowledgement_note,
    'acknowledged_by', v_alert.acknowledged_by, 'acknowledged_by_email', v_alert.acknowledged_by_email,
    'acknowledged_at', to_char(v_alert.acknowledged_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  UPDATE public.platform_alerts
     SET acknowledged_at = NULL,
         acknowledged_by = NULL,
         acknowledged_by_email = NULL,
         acknowledgement_reason = NULL,
         acknowledgement_note = NULL
   WHERE id = v_alert.id
  RETURNING * INTO v_alert;

  -- old_data holds the acknowledgement withdrawn, and whose it was.
  IF v_alert.entity_type = 'service_identity' THEN
    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'service_principals', coalesce(v_alert.entity_id, md5('platform_alerts:' || v_alert.fingerprint)::uuid),
        'ALERT_ACKNOWLEDGEMENT_WITHDRAWN', v_identity || v_held, v_identity,
        v_uid, public.audit_actor_source(), txid_current(), now()
    );
  ELSE
    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'platform_alerts', md5('platform_alerts:' || v_alert.fingerprint)::uuid,
        'ALERT_ACKNOWLEDGEMENT_WITHDRAWN', v_identity || v_held, v_identity,
        v_uid, public.audit_actor_source(), txid_current(), now()
    );
  END IF;
  RETURN v_alert;
END
$$;

ALTER FUNCTION public.withdraw_alert_acknowledgement(uuid) OWNER TO postgres;

COMMENT ON FUNCTION public.withdraw_alert_acknowledgement(uuid) IS
  'Withdraws the acknowledgement of a firing alert occurrence: the person who made it, or a '
  'Shopfloor Manager or an Administrator (42501 otherwise), on a row '
  'they may read (404 otherwise). An occurrence that is not acknowledged, or has resolved, is '
  '23514. Writes one ALERT_ACKNOWLEDGEMENT_WITHDRAWN audit row whose old_data holds the '
  'acknowledgement, and returns the row (0231).';

COMMENT ON FUNCTION public.audit_actor_source() IS
  'The actor_source a function writing its own audit_trail row records: user for a person, '
  'ingestion for the ingestion principal, service for any other machine identity, migration for '
  'the owner''s session with no token. log_audit_trail_event()''s ladder without the X-Aber-Actor '
  'header (0193). Called by the capture and playback gates, by log_display_name_change() (0203), '
  'by end_person_sessions() and record_person_email_change() (0207), by end_my_session() and '
  'end_my_other_sessions() (0211), by end_person_session() (0212), by '
  'record_broker_account_created() and record_broker_account_deleted() (0218), by '
  'record_service_logs_read() (0225), and by acknowledge_alert() and '
  'withdraw_alert_acknowledgement() (0231).';

-- -------------------------------------------------------------------------------------------------
-- 7. Who may call what
-- -------------------------------------------------------------------------------------------------
-- A signed-in person calls both; each checks the roles itself. No machine path acknowledges.
REVOKE ALL ON FUNCTION public.acknowledge_alert(uuid, text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.acknowledge_alert(uuid, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.withdraw_alert_acknowledgement(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.withdraw_alert_acknowledgement(uuid) TO authenticated;

-- -------------------------------------------------------------------------------------------------
-- What this file and 0001 did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_column   text;
  v_type     text;
  v_relation text;
  v_name     text;
  v_fn       text;
BEGIN
  FOR v_column, v_type IN VALUES ('acknowledged_at', 'timestamp with time zone'), ('acknowledged_by', 'uuid'),
                                 ('acknowledged_by_email', 'text'), ('acknowledgement_reason', 'text'),
                                 ('acknowledgement_note', 'text') LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'platform_alerts'
                      AND column_name = v_column AND data_type = v_type
                      AND is_nullable = 'YES' AND column_default IS NULL) THEN
      RAISE EXCEPTION '0231: platform_alerts.% is missing, not %, NOT NULL or defaulted', v_column, v_type;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'platform_alerts_active'
                      AND column_name = v_column AND data_type = v_type) THEN
      RAISE EXCEPTION '0231: platform_alerts_active does not return % as %; 0001 states the view', v_column, v_type;
    END IF;
    FOREACH v_relation IN ARRAY ARRAY['platform_alerts', 'platform_alerts_active'] LOOP
      IF NOT has_column_privilege('authenticated', format('public.%I', v_relation), v_column, 'SELECT') THEN
        RAISE EXCEPTION '0231: authenticated cannot read %.%; the alert counter shows it', v_relation, v_column;
      END IF;
      IF has_column_privilege('anon', format('public.%I', v_relation), v_column, 'SELECT') THEN
        RAISE EXCEPTION '0231: anon may read %.%', v_relation, v_column;
      END IF;
    END LOOP;
    -- One privilege per call: has_column_privilege() answers true when ANY of a list is held.
    IF has_column_privilege('authenticated', 'public.platform_alerts', v_column, 'INSERT')
       OR has_column_privilege('authenticated', 'public.platform_alerts', v_column, 'UPDATE') THEN
      RAISE EXCEPTION '0231: authenticated may write platform_alerts.% past acknowledge_alert()', v_column;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_class
                  WHERE oid = 'public.platform_alerts_active'::regclass
                    AND 'security_invoker=true' = ANY (reloptions)) THEN
    RAISE EXCEPTION '0231: platform_alerts_active lost security_invoker, so it would read past the table''s RLS';
  END IF;

  FOREACH v_name IN ARRAY ARRAY['platform_alerts_acknowledgement_reason_valid',
                                'platform_alerts_acknowledgement_is_whole',
                                'platform_alerts_acknowledgement_note_valid'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = v_name AND conrelid = 'public.platform_alerts'::regclass
                      AND contype = 'c' AND convalidated) THEN
      RAISE EXCEPTION '0231: % is missing or not validated', v_name;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.platform_alerts'::regclass
                    AND t.tgname = 'trg_platform_alerts_inherit_acknowledgement'
                    AND NOT t.tgisinternal AND t.tgenabled = 'O'
                    AND t.tgfoid = 'public.platform_alerts_inherit_acknowledgement()'::regprocedure
                    -- ROW (1), BEFORE (2) and INSERT (4), and nothing else.
                    AND t.tgtype = 7) THEN
    RAISE EXCEPTION '0231: trg_platform_alerts_inherit_acknowledgement is not BEFORE INSERT FOR EACH ROW';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY['public.acknowledge_alert(uuid, text, text)',
                              'public.withdraw_alert_acknowledgement(uuid)'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn::regprocedure
                    AND prosecdef AND 'search_path=public' = ANY (proconfig)) THEN
      RAISE EXCEPTION '0231: % is not SECURITY DEFINER with its search_path pinned', v_fn;
    END IF;
    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0231: authenticated may not execute %; the alert counter calls it', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0231: anon or service_role may execute %', v_fn;
    END IF;
  END LOOP;

  -- A request with no person behind it is refused before anything is read.
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.acknowledge_alert('00000000-0000-4000-8000-000000000000', 'investigating', NULL);
    RAISE EXCEPTION '0231: acknowledge_alert() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.withdraw_alert_acknowledgement('00000000-0000-4000-8000-000000000000');
    RAISE EXCEPTION '0231: withdraw_alert_acknowledgement() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$check$;

NOTIFY pgrst, 'reload schema';
