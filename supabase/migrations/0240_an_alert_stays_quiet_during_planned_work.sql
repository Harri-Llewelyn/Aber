-- 0240: An alert stays quiet during planned work: a suppression window on a device, a gateway or a
-- cell.
--
-- alert_suppression_windows holds one row per window: one subject (a device, a gateway or a cell),
-- a start, an end and a reason. 0001 states the table, its read policy and its grants, and
-- platform_alert_suppressing_window(), because platform_alerts_active joins them on every boot.
--
--   * "Suppressed now" is decided when a row is read: platform_alert_suppressing_window(entity_type,
--     entity_id, at) answers the window covering an alert at `at`, or NULL. A device is covered by
--     its own windows and by its current cell's; a gateway by its own; a platform or machine
--     identity alert never. platform_alerts_active returns suppressed, the window, its reason and
--     its end. The sender calls the same function.
--   * schedule_alert_suppression_window(), change_alert_suppression_window() and
--     end_alert_suppression_window() are the only writers. Each is SECURITY DEFINER: an
--     Administrator or a Shopfloor Manager acts, and every other caller is refused. Each act writes
--     one Audit Trail row in the subject's own lane. A start in the past is taken as now. Ending a
--     window that has not started cancels it: it covered nothing, so it is deleted.
--   * platform_alerts.suppression_window_id records the window that first covered an occurrence,
--     for history, and is never cleared. A BEFORE INSERT trigger stamps an occurrence that starts
--     in a window; stamp_platform_alerts_suppression() stamps one already firing when a window
--     opens over it, called by the writers and every minute by pg_cron for a window that starts
--     later.
--
-- 0241 files the audit rows in the Audit Trail's map of kinds.
--
-- Reasoning: supabase/README.md, "An alert stays quiet during planned work (0240)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The window's constraints, which 0001 does not state
-- -------------------------------------------------------------------------------------------------
DO $c$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'alert_suppression_windows_pkey'
                AND conrelid = 'public.alert_suppression_windows'::regclass
                AND public.live_constraint_definition(conrelid, conname) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.alert_suppression_windows DROP CONSTRAINT alert_suppression_windows_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'alert_suppression_windows_pkey'
                    AND conrelid = 'public.alert_suppression_windows'::regclass) THEN
    ALTER TABLE ONLY public.alert_suppression_windows
        ADD CONSTRAINT alert_suppression_windows_pkey PRIMARY KEY (id);
  END IF;
END $c$;

-- One subject, and only one.
DO $c$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'alert_suppression_windows_one_subject'
                AND conrelid = 'public.alert_suppression_windows'::regclass
                AND public.live_constraint_definition(conrelid, conname) <> 'CHECK ((num_nonnulls(device_id, gateway_id, cell_id) = 1))') THEN
    ALTER TABLE public.alert_suppression_windows DROP CONSTRAINT alert_suppression_windows_one_subject;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'alert_suppression_windows_one_subject'
                    AND conrelid = 'public.alert_suppression_windows'::regclass) THEN
    ALTER TABLE public.alert_suppression_windows
        ADD CONSTRAINT alert_suppression_windows_one_subject CHECK ((num_nonnulls(device_id, gateway_id, cell_id) = 1));
  END IF;
END $c$;

DO $c$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'alert_suppression_windows_ends_after_start'
                AND conrelid = 'public.alert_suppression_windows'::regclass
                AND public.live_constraint_definition(conrelid, conname) <> 'CHECK ((ends_at > starts_at))') THEN
    ALTER TABLE public.alert_suppression_windows DROP CONSTRAINT alert_suppression_windows_ends_after_start;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'alert_suppression_windows_ends_after_start'
                    AND conrelid = 'public.alert_suppression_windows'::regclass) THEN
    ALTER TABLE public.alert_suppression_windows
        ADD CONSTRAINT alert_suppression_windows_ends_after_start CHECK ((ends_at > starts_at));
  END IF;
END $c$;

-- The reason: trimmed and 1-200 characters, as an acknowledgement's note is.
DO $c$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'alert_suppression_windows_reason_valid'
                AND conrelid = 'public.alert_suppression_windows'::regclass
                AND public.live_constraint_definition(conrelid, conname) <> 'CHECK (((char_length(reason) >= 1) AND (char_length(reason) <= 200) AND (reason = btrim(reason))))') THEN
    ALTER TABLE public.alert_suppression_windows DROP CONSTRAINT alert_suppression_windows_reason_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'alert_suppression_windows_reason_valid'
                    AND conrelid = 'public.alert_suppression_windows'::regclass) THEN
    ALTER TABLE public.alert_suppression_windows
        ADD CONSTRAINT alert_suppression_windows_reason_valid CHECK (((char_length(reason) >= 1) AND (char_length(reason) <= 200) AND (reason = btrim(reason))));
  END IF;
END $c$;

-- An early end names who ended it; no email without the person.
DO $c$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'alert_suppression_windows_ended_is_whole'
                AND conrelid = 'public.alert_suppression_windows'::regclass
                AND public.live_constraint_definition(conrelid, conname) <> 'CHECK (((ended_by IS NOT NULL) OR (ended_by_email IS NULL)))') THEN
    ALTER TABLE public.alert_suppression_windows DROP CONSTRAINT alert_suppression_windows_ended_is_whole;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'alert_suppression_windows_ended_is_whole'
                    AND conrelid = 'public.alert_suppression_windows'::regclass) THEN
    ALTER TABLE public.alert_suppression_windows
        ADD CONSTRAINT alert_suppression_windows_ended_is_whole CHECK (((ended_by IS NOT NULL) OR (ended_by_email IS NULL)));
  END IF;
END $c$;

-- No foreign key to the subject: a window outlives its device, gateway or cell, as an alert and the
-- audit rows do, and a purge never waits on one. No child of cells cascades
-- (test_archive_purge_cascade.py). The writers refuse a subject that is not there.

-- A subject's windows by their end: the predicate reads those not yet ended, and a drawer lists them.
CREATE INDEX IF NOT EXISTS idx_alert_suppression_windows_device ON public.alert_suppression_windows USING btree (device_id, ends_at) WHERE (device_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_alert_suppression_windows_gateway ON public.alert_suppression_windows USING btree (gateway_id, ends_at) WHERE (gateway_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_alert_suppression_windows_cell ON public.alert_suppression_windows USING btree (cell_id, ends_at) WHERE (cell_id IS NOT NULL);

COMMENT ON TABLE public.alert_suppression_windows IS
  'A scheduled period on one device, gateway or cell during which its alerts are recorded but marked '
  'suppressed: not counted, colouring nothing, and not sent. It ends by itself; there is no switch '
  'to forget. Every signed-in role reads it; written only by schedule_alert_suppression_window(), '
  'change_alert_suppression_window() and end_alert_suppression_window(), each of which writes an '
  'Audit Trail row in the subject''s lane. platform_alert_suppressing_window() decides what it '
  'covers (0240).';
COMMENT ON COLUMN public.alert_suppression_windows.device_id IS
  'The device it covers. Exactly one of device_id, gateway_id and cell_id is set. No foreign key: '
  'the window outlives its subject, as an alert does (0240).';
COMMENT ON COLUMN public.alert_suppression_windows.gateway_id IS
  'The gateway it covers: the gateway''s own alerts, not its devices'' (0240).';
COMMENT ON COLUMN public.alert_suppression_windows.cell_id IS
  'The cell it covers: every device whose cell is this one when an alert is read, by '
  'device_locations.effective_cell_id (0240).';
COMMENT ON COLUMN public.alert_suppression_windows.starts_at IS
  'When it starts covering. Never earlier than when it was scheduled: a start in the past is taken '
  'as now (0240).';
COMMENT ON COLUMN public.alert_suppression_windows.ends_at IS
  'The first moment it no longer covers. Set to now when a person ends it early (0240).';
COMMENT ON COLUMN public.alert_suppression_windows.reason IS
  'Why the alerts are quiet, in the scheduler''s words: trimmed, 1 to 200 characters (0240).';
COMMENT ON COLUMN public.alert_suppression_windows.created_by IS
  'The auth.users id of the person who scheduled it. No foreign key, as for every other actor '
  'column a row outlives (0240).';
COMMENT ON COLUMN public.alert_suppression_windows.created_by_email IS
  'Their email address as their access token carried it, so every reader sees who scheduled it. '
  'NULL when the token carried none (0240).';
COMMENT ON COLUMN public.alert_suppression_windows.ended_by IS
  'Who ended it early, or NULL for a window that ran to its end (0240).';
COMMENT ON COLUMN public.alert_suppression_windows.ended_by_email IS
  'Their email address as their token carried it (0240).';

COMMENT ON FUNCTION public.platform_alert_suppressing_window(text, uuid, timestamp with time zone) IS
  'The suppression window that covers an alert on (p_entity_type, p_entity_id) at p_at, or NULL. A '
  'device alert is covered by the device''s own windows and by those of the cell it is in when this '
  'is called, whatever p_at; a gateway alert by the gateway''s own; a platform or service_identity '
  'alert, and one whose entity_id is NULL, never. Of several, the one that ends last. Read by '
  'platform_alerts_active, the stamp, and the sender, which holds a send while it answers (0240).';

-- -------------------------------------------------------------------------------------------------
-- 2. The occurrence's stamp, which 0001 states
-- -------------------------------------------------------------------------------------------------
COMMENT ON COLUMN public.platform_alerts.suppression_window_id IS
  'The suppression window that first covered this occurrence, for history: stamped as it starts in '
  'one, or when one opens while it fires. Never cleared or moved, even when the window changes or '
  'ends. No foreign key: the occurrence outlives a window''s subject. Whether it is suppressed now '
  'is platform_alerts_active''s question, not this column''s (0240).';

-- An INSERT takes the window covering the occurrence's start, or, for one arriving firing, the one
-- covering it now. An UPDATE that names the column keeps a stamp already there. SECURITY DEFINER, so
-- any writer reads the windows and the devices' cells.
CREATE OR REPLACE FUNCTION public.platform_alerts_stamp_suppression() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.suppression_window_id IS NOT NULL THEN
      NEW.suppression_window_id := OLD.suppression_window_id;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.suppression_window_id IS NULL THEN
    NEW.suppression_window_id := coalesce(
      public.platform_alert_suppressing_window(NEW.entity_type, NEW.entity_id, NEW.starts_at),
      CASE WHEN NEW.status = 'firing'
           THEN public.platform_alert_suppressing_window(NEW.entity_type, NEW.entity_id, now()) END);
  END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION public.platform_alerts_stamp_suppression() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.platform_alerts_stamp_suppression() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.platform_alerts_stamp_suppression() IS
  'BEFORE INSERT and BEFORE UPDATE OF suppression_window_id on platform_alerts: a new occurrence '
  'records the window covering its start, or the one covering it now while it fires; an update '
  'never clears or moves a stamp. Writes no audit row: nobody acted (0240).';

SELECT public.replay_trigger('public.platform_alerts', 'trg_platform_alerts_stamp_suppression', $ddl$
CREATE TRIGGER trg_platform_alerts_stamp_suppression BEFORE INSERT ON public.platform_alerts FOR EACH ROW EXECUTE FUNCTION public.platform_alerts_stamp_suppression();
$ddl$);
SELECT public.replay_trigger('public.platform_alerts', 'trg_platform_alerts_keep_suppression', $ddl$
CREATE TRIGGER trg_platform_alerts_keep_suppression BEFORE UPDATE OF suppression_window_id ON public.platform_alerts FOR EACH ROW EXECUTE FUNCTION public.platform_alerts_stamp_suppression();
$ddl$);

-- An alert already firing when a window opens over it: the newest occurrence of each fingerprint
-- still firing, unstamped, and covered now. Firing rows are few, and the newest-occurrence probe is
-- uq_platform_alerts_event's. Each stamp is an UPDATE, which Realtime carries to the dashboards.
CREATE OR REPLACE FUNCTION public.stamp_platform_alerts_suppression() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_stamped integer;
BEGIN
  UPDATE public.platform_alerts a
     SET suppression_window_id = c.window_id
    FROM (SELECT f.id,
                 public.platform_alert_suppressing_window(f.entity_type, f.entity_id, now()) AS window_id
            FROM public.platform_alerts f
           WHERE f.status = 'firing'
             AND f.suppression_window_id IS NULL
             AND f.entity_type IN ('device', 'gateway')
             AND f.entity_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM public.platform_alerts n
                              WHERE n.fingerprint = f.fingerprint
                                AND (n.starts_at, n.recorded_at) > (f.starts_at, f.recorded_at))) c
   WHERE a.id = c.id
     AND c.window_id IS NOT NULL;
  GET DIAGNOSTICS v_stamped = ROW_COUNT;
  RETURN v_stamped;
END
$$;

ALTER FUNCTION public.stamp_platform_alerts_suppression() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.stamp_platform_alerts_suppression() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.stamp_platform_alerts_suppression() IS
  'Stamps suppression_window_id on each alert still firing, not yet stamped, that a window covers '
  'now, and returns how many. Called by the three window writers, and every minute by the '
  'stamp_platform_alerts_suppression pg_cron job for a window whose start arrives later (0240).';

-- Its own job rather than a line in another every-minute job: a failure here stops nothing else,
-- and cron.job_run_details names it.
SELECT public.ensure_cron_job(
  'stamp_platform_alerts_suppression',
  '* * * * *',
  $job$SELECT public.stamp_platform_alerts_suppression()$job$
);

-- -------------------------------------------------------------------------------------------------
-- 3. What an audit row says about a window
-- -------------------------------------------------------------------------------------------------
-- `name` is the subject's, as the subject's own rows carry it, so the Audit Trail labels the lane by
-- it after the subject is gone.
CREATE OR REPLACE FUNCTION public.alert_suppression_window_audit_identity(p_window public.alert_suppression_windows)
RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT jsonb_build_object(
    'name', s.subject_name,
    'window_id', p_window.id,
    'subject_kind', CASE WHEN p_window.device_id IS NOT NULL THEN 'device'
                         WHEN p_window.gateway_id IS NOT NULL THEN 'gateway'
                         ELSE 'cell' END,
    'subject_id', coalesce(p_window.device_id, p_window.gateway_id, p_window.cell_id),
    'subject_name', s.subject_name,
    'starts_at', to_char(p_window.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'ends_at', to_char(p_window.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'reason', p_window.reason,
    'created_by', p_window.created_by,
    'created_by_email', p_window.created_by_email,
    'ended_by', p_window.ended_by,
    'ended_by_email', p_window.ended_by_email)
    FROM (SELECT coalesce((SELECT d.name FROM public.devices d WHERE d.id = p_window.device_id),
                          (SELECT g.name FROM public.gateways g WHERE g.id = p_window.gateway_id),
                          (SELECT c.name FROM public.cells c WHERE c.id = p_window.cell_id)) AS subject_name) s;
$$;

ALTER FUNCTION public.alert_suppression_window_audit_identity(public.alert_suppression_windows) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.alert_suppression_window_audit_identity(public.alert_suppression_windows) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.alert_suppression_window_audit_identity(public.alert_suppression_windows) IS
  'What a window''s audit rows carry: name (the subject''s), window_id, subject_kind, subject_id, '
  'subject_name, starts_at, ends_at, reason, and who scheduled and ended it (0240).';

-- -------------------------------------------------------------------------------------------------
-- 4. Scheduling
-- -------------------------------------------------------------------------------------------------
-- A person's act: a machine identity holds no role, so it is refused with every other caller
-- outside the two roles. The refusals come before anything is written, each with a sentence the
-- dashboard shows. The audit row is in the subject's lane, each lane's INSERT with its kind written
-- out, as the Audit Trail's map of kinds reads it.
CREATE OR REPLACE FUNCTION public.schedule_alert_suppression_window(p_subject_kind text, p_subject_id uuid,
                                                                    p_starts_at timestamp with time zone,
                                                                    p_ends_at timestamp with time zone,
                                                                    p_reason text)
RETURNS public.alert_suppression_windows
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_start  timestamptz := greatest(coalesce(p_starts_at, now()), now());
  v_window public.alert_suppression_windows;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'Only a Shopfloor Manager or an Administrator may schedule a suppression window.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_subject_kind IS NULL OR NOT p_subject_kind = ANY (ARRAY['device', 'gateway', 'cell']) THEN
    RAISE EXCEPTION 'A window is on a device, a gateway or a cell, not %.', coalesce(quote_literal(p_subject_kind), 'NULL')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_ends_at IS NULL THEN
    RAISE EXCEPTION 'A window needs an end.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_ends_at <= v_start THEN
    RAISE EXCEPTION 'A window must end after it starts, and after now.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'A window needs a reason.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF char_length(v_reason) > 200 THEN
    RAISE EXCEPTION 'The reason is at most 200 characters.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_subject_id IS NULL
     OR (p_subject_kind = 'device' AND NOT EXISTS (SELECT 1 FROM public.devices WHERE id = p_subject_id))
     OR (p_subject_kind = 'gateway' AND NOT EXISTS (SELECT 1 FROM public.gateways WHERE id = p_subject_id))
     OR (p_subject_kind = 'cell' AND NOT EXISTS (SELECT 1 FROM public.cells WHERE id = p_subject_id)) THEN
    PERFORM public.raise_not_found(format('There is no %s %s.', p_subject_kind, p_subject_id));
  END IF;

  INSERT INTO public.alert_suppression_windows (
      device_id, gateway_id, cell_id, starts_at, ends_at, reason, created_by, created_by_email, created_at
  ) VALUES (
      CASE WHEN p_subject_kind = 'device' THEN p_subject_id END,
      CASE WHEN p_subject_kind = 'gateway' THEN p_subject_id END,
      CASE WHEN p_subject_kind = 'cell' THEN p_subject_id END,
      v_start, p_ends_at, v_reason, v_uid, nullif(auth.jwt() ->> 'email', ''), now()
  )
  RETURNING * INTO v_window;

  IF v_window.device_id IS NOT NULL THEN
    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'devices', v_window.device_id, 'SUPPRESSION_WINDOW_SCHEDULED', NULL,
        public.alert_suppression_window_audit_identity(v_window),
        v_uid, public.audit_actor_source(), txid_current(), now()
    );
  ELSIF v_window.gateway_id IS NOT NULL THEN
    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'gateways', v_window.gateway_id, 'SUPPRESSION_WINDOW_SCHEDULED', NULL,
        public.alert_suppression_window_audit_identity(v_window),
        v_uid, public.audit_actor_source(), txid_current(), now()
    );
  ELSE
    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'cells', v_window.cell_id, 'SUPPRESSION_WINDOW_SCHEDULED', NULL,
        public.alert_suppression_window_audit_identity(v_window),
        v_uid, public.audit_actor_source(), txid_current(), now()
    );
  END IF;

  -- A window starting now covers what is already firing.
  PERFORM public.stamp_platform_alerts_suppression();
  RETURN v_window;
END
$$;

ALTER FUNCTION public.schedule_alert_suppression_window(text, uuid, timestamp with time zone, timestamp with time zone, text) OWNER TO postgres;

COMMENT ON FUNCTION public.schedule_alert_suppression_window(text, uuid, timestamp with time zone, timestamp with time zone, text) IS
  'Schedules a suppression window on a device, a gateway or a cell (p_subject_kind device, gateway '
  'or cell): a Shopfloor Manager or an Administrator (42501 otherwise). p_starts_at NULL or in the '
  'past is now; p_ends_at is required and after the start; p_reason is trimmed and 1 to 200 '
  'characters (22023 otherwise). A subject that does not exist is 404. Writes one '
  'SUPPRESSION_WINDOW_SCHEDULED audit row in the subject''s lane, stamps the alerts it covers now, '
  'and returns the window (0240).';

-- -------------------------------------------------------------------------------------------------
-- 5. Changing
-- -------------------------------------------------------------------------------------------------
-- A NULL argument keeps what the window has, so the dashboard sends only what changed. A window
-- that has started keeps its start, and one that has ended is kept as it was: both are history.
-- Changing nothing writes nothing.
CREATE OR REPLACE FUNCTION public.change_alert_suppression_window(p_window_id uuid,
                                                                  p_starts_at timestamp with time zone,
                                                                  p_ends_at timestamp with time zone,
                                                                  p_reason text)
RETURNS public.alert_suppression_windows
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_window public.alert_suppression_windows;
  v_after  public.alert_suppression_windows;
  v_start  timestamptz;
  v_end    timestamptz;
  v_reason text;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'Only a Shopfloor Manager or an Administrator may change a suppression window.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_window FROM public.alert_suppression_windows WHERE id = p_window_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.raise_not_found(format('There is no suppression window %s.', p_window_id));
  END IF;
  IF v_window.ends_at <= now() THEN
    RAISE EXCEPTION 'This window ended at %, and an ended window is kept as it was.',
      to_char(v_window.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI "UTC"')
      USING ERRCODE = 'check_violation';
  END IF;

  v_start := v_window.starts_at;
  IF p_starts_at IS NOT NULL AND p_starts_at IS DISTINCT FROM v_window.starts_at THEN
    IF v_window.starts_at <= now() THEN
      RAISE EXCEPTION 'This window started at %, so its start stays.',
        to_char(v_window.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI "UTC"')
        USING ERRCODE = 'check_violation';
    END IF;
    v_start := greatest(p_starts_at, now());
  END IF;
  v_end := coalesce(p_ends_at, v_window.ends_at);
  IF v_end <= now() THEN
    RAISE EXCEPTION 'A window must end after now. To end this one now, end it.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_end <= v_start THEN
    RAISE EXCEPTION 'A window must end after it starts.' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_reason := v_window.reason;
  IF p_reason IS NOT NULL THEN
    v_reason := nullif(btrim(p_reason), '');
    IF v_reason IS NULL THEN
      RAISE EXCEPTION 'A window needs a reason.' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF char_length(v_reason) > 200 THEN
      RAISE EXCEPTION 'The reason is at most 200 characters.' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  IF v_start = v_window.starts_at AND v_end = v_window.ends_at AND v_reason = v_window.reason THEN
    RETURN v_window;
  END IF;

  UPDATE public.alert_suppression_windows
     SET starts_at = v_start, ends_at = v_end, reason = v_reason
   WHERE id = v_window.id
  RETURNING * INTO v_after;

  IF v_after.device_id IS NOT NULL THEN
    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'devices', v_after.device_id, 'SUPPRESSION_WINDOW_CHANGED',
        public.alert_suppression_window_audit_identity(v_window),
        public.alert_suppression_window_audit_identity(v_after),
        v_uid, public.audit_actor_source(), txid_current(), now()
    );
  ELSIF v_after.gateway_id IS NOT NULL THEN
    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'gateways', v_after.gateway_id, 'SUPPRESSION_WINDOW_CHANGED',
        public.alert_suppression_window_audit_identity(v_window),
        public.alert_suppression_window_audit_identity(v_after),
        v_uid, public.audit_actor_source(), txid_current(), now()
    );
  ELSE
    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'cells', v_after.cell_id, 'SUPPRESSION_WINDOW_CHANGED',
        public.alert_suppression_window_audit_identity(v_window),
        public.alert_suppression_window_audit_identity(v_after),
        v_uid, public.audit_actor_source(), txid_current(), now()
    );
  END IF;

  -- A start moved to now covers what is already firing.
  PERFORM public.stamp_platform_alerts_suppression();
  RETURN v_after;
END
$$;

ALTER FUNCTION public.change_alert_suppression_window(uuid, timestamp with time zone, timestamp with time zone, text) OWNER TO postgres;

COMMENT ON FUNCTION public.change_alert_suppression_window(uuid, timestamp with time zone, timestamp with time zone, text) IS
  'Changes a window''s start, end or reason; a NULL argument keeps what it has. A Shopfloor Manager '
  'or an Administrator (42501 otherwise), on a window that exists (404). An ended window, and the '
  'start of a started one, are 23514. A start in the past is now; the end must be after now and the '
  'start, and the reason 1 to 200 characters (22023). Writes one SUPPRESSION_WINDOW_CHANGED audit row '
  'with the window before and after, or nothing when nothing changed, and returns the window (0240).';

-- -------------------------------------------------------------------------------------------------
-- 6. Ending
-- -------------------------------------------------------------------------------------------------
-- A window that has started ends now and names who ended it. One that has not started is
-- cancelled: it covered nothing and no occurrence names it, so it is deleted, and its audit row
-- keeps it.
CREATE OR REPLACE FUNCTION public.end_alert_suppression_window(p_window_id uuid)
RETURNS public.alert_suppression_windows
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_window public.alert_suppression_windows;
  v_after  public.alert_suppression_windows;
  v_action text;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'Only a Shopfloor Manager or an Administrator may end a suppression window.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_window FROM public.alert_suppression_windows WHERE id = p_window_id FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.raise_not_found(format('There is no suppression window %s.', p_window_id));
  END IF;
  IF v_window.ends_at <= now() THEN
    RAISE EXCEPTION 'This window already ended at %.',
      to_char(v_window.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI "UTC"')
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_window.starts_at >= now() THEN
    v_action := 'SUPPRESSION_WINDOW_CANCELLED';
    DELETE FROM public.alert_suppression_windows WHERE id = v_window.id;
    v_after := v_window;
  ELSE
    v_action := 'SUPPRESSION_WINDOW_ENDED';
    UPDATE public.alert_suppression_windows
       SET ends_at = now(), ended_by = v_uid, ended_by_email = nullif(auth.jwt() ->> 'email', '')
     WHERE id = v_window.id
    RETURNING * INTO v_after;
  END IF;

  -- A cancellation's new_data is NULL: the window is gone.
  IF v_window.device_id IS NOT NULL THEN
    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'devices', v_window.device_id, v_action,
        public.alert_suppression_window_audit_identity(v_window),
        CASE WHEN v_action = 'SUPPRESSION_WINDOW_ENDED' THEN public.alert_suppression_window_audit_identity(v_after) END,
        v_uid, public.audit_actor_source(), txid_current(), now()
    );
  ELSIF v_window.gateway_id IS NOT NULL THEN
    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'gateways', v_window.gateway_id, v_action,
        public.alert_suppression_window_audit_identity(v_window),
        CASE WHEN v_action = 'SUPPRESSION_WINDOW_ENDED' THEN public.alert_suppression_window_audit_identity(v_after) END,
        v_uid, public.audit_actor_source(), txid_current(), now()
    );
  ELSE
    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'cells', v_window.cell_id, v_action,
        public.alert_suppression_window_audit_identity(v_window),
        CASE WHEN v_action = 'SUPPRESSION_WINDOW_ENDED' THEN public.alert_suppression_window_audit_identity(v_after) END,
        v_uid, public.audit_actor_source(), txid_current(), now()
    );
  END IF;
  RETURN v_after;
END
$$;

ALTER FUNCTION public.end_alert_suppression_window(uuid) OWNER TO postgres;

COMMENT ON FUNCTION public.end_alert_suppression_window(uuid) IS
  'Ends a window now: a Shopfloor Manager or an Administrator (42501 otherwise), on a window that '
  'exists (404) and has not ended (23514). A started window''s end becomes now, with who ended it '
  '(SUPPRESSION_WINDOW_ENDED); one not yet started is deleted (SUPPRESSION_WINDOW_CANCELLED). Writes '
  'one audit row in the subject''s lane and returns the window as it ended (0240).';

COMMENT ON FUNCTION public.audit_actor_source() IS
  'The actor_source a function writing its own audit_trail row records: user for a person, '
  'ingestion for the ingestion principal, service for any other machine identity, migration for '
  'the owner''s session with no token. log_audit_trail_event()''s ladder without the X-Aber-Actor '
  'header (0193). Called by the capture and playback gates, by log_display_name_change() (0203), '
  'by end_person_sessions() and record_person_email_change() (0207), by end_my_session() and '
  'end_my_other_sessions() (0211), by end_person_session() (0212), by '
  'record_broker_account_created() and record_broker_account_deleted() (0218), by '
  'record_service_logs_read() (0225), by acknowledge_alert() and '
  'withdraw_alert_acknowledgement() (0231), and by schedule_alert_suppression_window(), '
  'change_alert_suppression_window() and end_alert_suppression_window() (0240).';

-- -------------------------------------------------------------------------------------------------
-- 7. Who may call what
-- -------------------------------------------------------------------------------------------------
-- A signed-in person calls the three writers; each checks the roles itself. No machine path writes
-- a window.
REVOKE ALL ON FUNCTION public.schedule_alert_suppression_window(text, uuid, timestamp with time zone, timestamp with time zone, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.schedule_alert_suppression_window(text, uuid, timestamp with time zone, timestamp with time zone, text) TO authenticated;
REVOKE ALL ON FUNCTION public.change_alert_suppression_window(uuid, timestamp with time zone, timestamp with time zone, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.change_alert_suppression_window(uuid, timestamp with time zone, timestamp with time zone, text) TO authenticated;
REVOKE ALL ON FUNCTION public.end_alert_suppression_window(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.end_alert_suppression_window(uuid) TO authenticated;

-- -------------------------------------------------------------------------------------------------
-- What this file and 0001 did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_name   text;
  v_column text;
  v_type   text;
  v_fn     text;
  v_op     text;
BEGIN
  -- The window: RLS on, one read policy, and nothing but the writers' path to a write.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.alert_suppression_windows'::regclass
                    AND relrowsecurity) THEN
    RAISE EXCEPTION '0240: alert_suppression_windows has no row level security';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'alert_suppression_windows'
                AND (cmd <> 'SELECT' OR policyname <> 'alert_suppression_windows_select_authenticated')) THEN
    RAISE EXCEPTION '0240: alert_suppression_windows has a policy other than its read policy';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.alert_suppression_windows', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.alert_suppression_windows', 'SELECT') THEN
    RAISE EXCEPTION '0240: authenticated or service_role cannot read alert_suppression_windows';
  END IF;
  -- One privilege per call: has_table_privilege() answers true when ANY of a list is held.
  FOREACH v_op IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] LOOP
    IF has_table_privilege('authenticated', 'public.alert_suppression_windows', v_op)
       OR has_table_privilege('service_role', 'public.alert_suppression_windows', v_op)
       OR has_table_privilege('anon', 'public.alert_suppression_windows', v_op) THEN
      RAISE EXCEPTION '0240: a browser or service role may % alert_suppression_windows past its writers', v_op;
    END IF;
  END LOOP;
  IF has_table_privilege('anon', 'public.alert_suppression_windows', 'SELECT') THEN
    RAISE EXCEPTION '0240: anon may read alert_suppression_windows';
  END IF;
  FOREACH v_name IN ARRAY ARRAY['alert_suppression_windows_one_subject', 'alert_suppression_windows_ends_after_start',
                                'alert_suppression_windows_reason_valid', 'alert_suppression_windows_ended_is_whole',
                                'alert_suppression_windows_pkey'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = v_name AND conrelid = 'public.alert_suppression_windows'::regclass
                      AND convalidated) THEN
      RAISE EXCEPTION '0240: % is missing or not validated', v_name;
    END IF;
  END LOOP;

  -- The stamp: nullable, undefaulted, read by everyone, written by nobody past the functions.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'platform_alerts'
                    AND column_name = 'suppression_window_id' AND data_type = 'uuid'
                    AND is_nullable = 'YES' AND column_default IS NULL) THEN
    RAISE EXCEPTION '0240: platform_alerts.suppression_window_id is missing, not uuid, NOT NULL or defaulted';
  END IF;
  IF NOT has_column_privilege('authenticated', 'public.platform_alerts', 'suppression_window_id', 'SELECT')
     OR has_column_privilege('authenticated', 'public.platform_alerts', 'suppression_window_id', 'INSERT')
     OR has_column_privilege('authenticated', 'public.platform_alerts', 'suppression_window_id', 'UPDATE') THEN
    RAISE EXCEPTION '0240: authenticated may not read platform_alerts.suppression_window_id, or may write it';
  END IF;
  FOR v_name, v_op IN VALUES ('trg_platform_alerts_stamp_suppression', '7'),
                             -- ROW (1), BEFORE (2) and UPDATE (16).
                             ('trg_platform_alerts_keep_suppression', '19') LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                    WHERE t.tgrelid = 'public.platform_alerts'::regclass AND t.tgname = v_name
                      AND NOT t.tgisinternal AND t.tgenabled = 'O'
                      AND t.tgfoid = 'public.platform_alerts_stamp_suppression()'::regprocedure
                      AND t.tgtype = v_op::int2) THEN
      RAISE EXCEPTION '0240: % is not attached as this file declares it', v_name;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = 'stamp_platform_alerts_suppression' AND schedule = '* * * * *'
                    AND command = 'SELECT public.stamp_platform_alerts_suppression()') THEN
    RAISE EXCEPTION '0240: the stamp_platform_alerts_suppression job is not scheduled every minute';
  END IF;

  -- The view: every column it returned before, then the four this file adds, under the caller's RLS.
  FOR v_column, v_type IN VALUES ('suppressed', 'boolean'), ('suppressing_window_id', 'uuid'),
                                 ('suppression_reason', 'text'),
                                 ('suppressed_until', 'timestamp with time zone') LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'platform_alerts_active'
                      AND column_name = v_column AND data_type = v_type) THEN
      RAISE EXCEPTION '0240: platform_alerts_active does not return % as %; 0001 states the view', v_column, v_type;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_class
                  WHERE oid = 'public.platform_alerts_active'::regclass
                    AND 'security_invoker=true' = ANY (reloptions)) THEN
    RAISE EXCEPTION '0240: platform_alerts_active lost security_invoker, so it would read past the table''s RLS';
  END IF;

  -- The predicate: one form, STABLE, run as its caller, by the dashboard and the sender alone.
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'platform_alert_suppressing_window'
         AND pronamespace = 'public'::regnamespace) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_proc
                     WHERE oid = 'public.platform_alert_suppressing_window(text, uuid, timestamp with time zone)'::regprocedure
                       AND provolatile = 's' AND NOT prosecdef AND 'search_path=public' = ANY (proconfig)
                       AND prorettype = 'uuid'::regtype) THEN
    RAISE EXCEPTION '0240: platform_alert_suppressing_window is not one STABLE, SECURITY INVOKER, pinned function returning uuid';
  END IF;
  v_fn := 'public.platform_alert_suppressing_window(text, uuid, timestamp with time zone)';
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0240: % is not executable by authenticated and service_role alone', v_fn;
  END IF;
  -- Nothing covers a platform alert, or an alert with no subject, whatever the windows.
  IF public.platform_alert_suppressing_window('platform', '00000000-0000-4000-8000-000000000000', now()) IS NOT NULL
     OR public.platform_alert_suppressing_window('device', NULL, now()) IS NOT NULL THEN
    RAISE EXCEPTION '0240: platform_alert_suppressing_window covers a platform alert or one with no subject';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY['public.schedule_alert_suppression_window(text, uuid, timestamp with time zone, timestamp with time zone, text)',
                              'public.change_alert_suppression_window(uuid, timestamp with time zone, timestamp with time zone, text)',
                              'public.end_alert_suppression_window(uuid)'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn::regprocedure
                    AND prosecdef AND 'search_path=public' = ANY (proconfig)) THEN
      RAISE EXCEPTION '0240: % is not SECURITY DEFINER with its search_path pinned', v_fn;
    END IF;
    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0240: authenticated may not execute %; the drawers call it', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0240: anon or service_role may execute %', v_fn;
    END IF;
  END LOOP;
  FOREACH v_fn IN ARRAY ARRAY['public.platform_alerts_stamp_suppression()', 'public.stamp_platform_alerts_suppression()',
                              'public.alert_suppression_window_audit_identity(public.alert_suppression_windows)'] LOOP
    IF has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('anon', v_fn, 'EXECUTE')
       OR has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0240: % is callable from outside the database', v_fn;
    END IF;
  END LOOP;

  -- A request with no person behind it is refused before anything is read.
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.schedule_alert_suppression_window('device', '00000000-0000-4000-8000-000000000000',
                                                     NULL, now() + interval '1 hour', 'self-check');
    RAISE EXCEPTION '0240: schedule_alert_suppression_window() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.change_alert_suppression_window('00000000-0000-4000-8000-000000000000', NULL, NULL, 'self-check');
    RAISE EXCEPTION '0240: change_alert_suppression_window() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.end_alert_suppression_window('00000000-0000-4000-8000-000000000000');
    RAISE EXCEPTION '0240: end_alert_suppression_window() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$check$;

NOTIFY pgrst, 'reload schema';
