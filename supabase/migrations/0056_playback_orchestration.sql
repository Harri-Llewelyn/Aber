-- =============================================================================================
-- 0056: playback orchestration -- a worker that publishes, and the three tiers that confine it
-- =============================================================================================
--
-- 0055 made recording a dashboard act. This is the other direction: publishing a stored capture
-- back into the stack as a simulated gateway, through the real broker and down the real ingestion
-- path. Driven from the page rather than from a terminal, because a feature reachable only over SSH
-- is not reachable by most of the people this dashboard exists for -- and because the page knows the
-- target gateway and the devices bound to it, so it can build the device map from dropdowns instead
-- of asking somebody to type 24-character ids.
--
-- ---------------------------------------------------------------------------------------------
-- A SEPARATE PRINCIPAL, AND NOT THE INGESTION DAEMON. THIS IS THE WHOLE SHAPE OF THE FILE.
--
-- `mosquitto.acl` grants the ingestion principal `read spBv1.0/#` and `write spBv1.0/+/NCMD/+` --
-- rebirth requests and nothing else. Teaching it to publish asset data would widen the one account
-- the entire ACL is built around, and `verify_gateway_binding()` cannot tell a forged message under
-- a correctly bound device from a real one. So playback gets its own identity.
--
-- THE SEQ OBJECTION THAT RULED OUT A SEPARATE PRINCIPAL FOR CAPTURE DOES NOT APPLY HERE, and it is
-- worth saying because the two decisions look contradictory. That objection was about a second
-- SUBSCRIBER: `_last_seq` in ingestion.py is keyed `(group, edge_node)`, so two consumers split the
-- stream and gap detection fires permanently. A playback worker only PUBLISHES. It holds no
-- subscription and takes nothing away from the daemon.
--
-- ---------------------------------------------------------------------------------------------
-- TWO IDENTITIES, ON PURPOSE, AND THEY ARE NOT THE SAME KIND OF THING
--
--   * `Service_Playback` is a SUPABASE principal (this file). It reads the queue, reads the capture
--     and writes status. It holds `Operator`, like every other machine identity here.
--   * The MQTT identity is THE TARGET GATEWAY'S OWN -- username equals that gateway's
--     `sparkplug_id` -- supplied to the worker as a secret, the way `MQTT_VALIDATOR_USER` is.
--
-- One says what it may do in the database; the other says what the broker will carry. Keeping them
-- separate is what lets the second be per-target while the first is fixed.
--
-- THE ACL NEEDS NO NEW RULE, AND THAT IS THE POINT OF DOING IT THIS WAY. `pattern readwrite
-- spBv1.0/+/+/%u/#` confines a client to the edge node whose id it authenticated as -- so a worker
-- connected as `gwyAAA…` cannot publish under `gwyBBB…`, and the broker drops the attempt at the
-- network protocol layer before any subscriber sees it. That is the same mechanism every gateway on
-- this stack already uses.
--
-- WHY NOT A TOPIC-SHAPED RULE. `spBv1.0/+/+/simulated_#` does not parse -- MQTT's `#` is a wildcard
-- only as an entire filter or immediately after a `/` -- and mosquitto REFUSES TO START on it,
-- measured against the pinned image. The namespace it names could not exist anyway: the edge-node
-- segment is a GENERATED column, `'gwy'` plus 21 hex characters of the row's uuid, so no gateway can
-- be given an id beginning `simulated_`. `is_simulated` is a database predicate and cannot be an
-- ACL rule; the confinement `%u` already provides is what that rule was reaching for.
--
-- ---------------------------------------------------------------------------------------------
-- THREE TIERS, WHICH IS THE HOUSE PATTERN
--
--   the job gate           `playback_jobs` refuses a target where `is_simulated = false`, in the
--                          database rather than in the UI
--   credential possession  the worker holds broker credentials only for gateways issued as playback
--                          targets, so it cannot authenticate as a real one
--   the broker ACL         each credential is confined to its own edge node by `%u`, so even a
--                          compromised worker reaches exactly one gateway
--
-- A VALIDATION GATE IS ONLY A GATE IF IT IS THE ONLY WAY IN, so `playback_jobs` takes no direct
-- write from any application role -- same as 0055, and for the same reason: a policy that let
-- `authenticated` INSERT, or UPDATE a row back to PENDING, would leave the function as one of two
-- doors and the one the UI happens to use rather than the one an API caller has to.
--
-- IDEMPOTENT. db-init replays every migration on every boot in filename order.
--
-- Related: 0038 (`gateway_holds_a_credential()`), 0046 (the principal pattern), 0048 (machine
--          principals are not users), 0052 (`is_simulated`), 0055 (captures, and the storage arm
--          this mirrors), supabase/storage-policies.sql, README.md item 17 §5.
-- =============================================================================================

SET search_path TO public;


-- ---------------------------------------------------------------------------------------------
-- 1. The principal
-- ---------------------------------------------------------------------------------------------
-- Minimal by construction, exactly as 0046's is: no email, no password, no identity provider. THIS
-- ACCOUNT CANNOT SIGN IN, and 0042's predicate holds for it, so it appears in the Service
-- Identities list on the Access Control page beside the identities that page created itself.
--
-- SEEDED HERE RATHER THAN CREATED THROUGH `create_service_principal()`, for 0046's two reasons: the
-- RLS job applies migrations and never runs the seed, so a principal defined there would not exist
-- where its privileges are tested; and a fixed part of the deployment belongs in a migration, while
-- a thing somebody decided to create belongs behind the page that records who decided it.
INSERT INTO auth.users (id)
VALUES ('b0000000-0000-4000-8000-000000000003')
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
    v_operator integer;
BEGIN
    -- BY NAME, not by a hardcoded id: `roles.id` is an integer assigned by 0001, and a migration
    -- that hardcodes it is asserting a fact about a sequence.
    SELECT id INTO v_operator FROM public.roles WHERE name = 'Operator';
    IF v_operator IS NULL THEN
        RAISE EXCEPTION '0056: the Operator role is missing; 0001 did not run cleanly.';
    END IF;

    -- `Operator`, NOT `Auditor`, and the reason is 0046's applied to a different process. The
    -- difference between the two is that an Auditor can read the digital thread. This worker writes
    -- nothing to it and reads nothing from it, so granting Auditor would hand a credential that
    -- lives in a process holding BROKER PUBLISH RIGHTS the ability to read every attributed change
    -- anyone has ever made to this stack, in support of a code path that does not exist.
    INSERT INTO public.user_roles (user_id, role_id)
    VALUES ('b0000000-0000-4000-8000-000000000003', v_operator)
    ON CONFLICT (user_id, role_id) DO NOTHING;
END $$;

COMMENT ON TABLE public.user_roles IS
  'Role assignment per auth user. Includes three seeded machine principals that cannot sign in: '
  'b0000000-0000-4000-8000-000000000001, the read-only principal the MCP client authenticates as '
  '(0034); b0000000-0000-4000-8000-000000000002, Service_Ingestor, the identity the ingestion '
  'daemon authenticates as (0046); and b0000000-0000-4000-8000-000000000003, Service_Playback, the '
  'identity the playback worker authenticates as (0056). All three hold Operator and write nothing '
  'directly -- every write goes through a SECURITY DEFINER gate that checks which of them is '
  'calling.';


CREATE OR REPLACE FUNCTION public.is_playback_caller()
    RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $fn$
    -- ONE ARM, like `is_ingestion_caller()` after 0048. No transitional `service_role` arm: nothing
    -- has ever handed this worker that key, so admitting it would widen the gates on day one for a
    -- migration path that does not exist.
    SELECT COALESCE(auth.uid()::text = 'b0000000-0000-4000-8000-000000000003', false);
$fn$;

COMMENT ON FUNCTION public.is_playback_caller() IS
  'True only for the Service_Playback principal (0056). Guards every playback_* worker gate. '
  'Deliberately distinct from is_ingestion_caller(): the two processes hold different broker '
  'rights -- the daemon may publish only NCMD rebirth requests, the worker may publish asset data '
  'as one gateway -- and a shared predicate would let either use the other''s gates.';


CREATE OR REPLACE FUNCTION public.require_playback_caller(p_fn text)
    RETURNS void
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $fn$
BEGIN
    IF NOT public.is_playback_caller() THEN
        -- 42501, the same code a failed RLS WITH CHECK raises, so a caller that loses this
        -- privilege fails the way it would have failed against a policy.
        RAISE EXCEPTION '%: only the playback worker may call this', p_fn
            USING ERRCODE = 'insufficient_privilege';
    END IF;
END;
$fn$;


-- ---------------------------------------------------------------------------------------------
-- 2. The job
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.playback_jobs (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    -- SET NULL RATHER THAN CASCADE, with the path kept beside it. A playback that ran is a thing
    -- that happened, and deleting the capture afterwards should not erase the record of it having
    -- been played -- particularly since a playback writes telemetry that outlives both rows.
    capture_id             uuid REFERENCES public.captures(id) ON DELETE SET NULL,
    capture_storage_path   text        NOT NULL,

    target_gateway_id      uuid        NOT NULL REFERENCES public.gateways(id) ON DELETE CASCADE,
    -- Denormalised for the same reason `capture_jobs.edge_node_id` is: the worker publishes on a
    -- schedule and must not join per message, and this is also the MQTT USERNAME it connects as.
    target_edge_node_id    text        NOT NULL,
    sparkplug_group        text        NOT NULL,

    -- `{"<captured dev id>": "<target dev id>"}`. Every captured device must be mapped: an
    -- unmapped id would publish under the target gateway carrying another gateway's device
    -- segment, which `verify_gateway_binding()` quarantines -- and that reads as a fleet problem.
    device_map             jsonb       NOT NULL DEFAULT '{}'::jsonb,

    speed                  numeric     NOT NULL DEFAULT 1.0,
    status                 text        NOT NULL DEFAULT 'PENDING',

    messages_total         integer     NOT NULL DEFAULT 0,
    messages_sent          integer     NOT NULL DEFAULT 0,
    elapsed_seconds        integer     NOT NULL DEFAULT 0,
    stop_requested         boolean     NOT NULL DEFAULT false,
    error                  text,

    requested_by           uuid,
    created_at             timestamptz NOT NULL DEFAULT now(),
    started_at             timestamptz,
    finished_at            timestamptz
);

ALTER TABLE public.playback_jobs DROP CONSTRAINT IF EXISTS playback_jobs_status_valid;
ALTER TABLE public.playback_jobs ADD CONSTRAINT playback_jobs_status_valid
    CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'));

-- NO BURST MODE, AND `speed = 0` STAYS REFUSED. Speed divides both the send schedule and the
-- timestamp rebasing, so as it rises every message converges on one millisecond -- and the
-- historian inserts `ON CONFLICT (time, asset_id, metric_name) DO NOTHING`. A burst replay of
-- 100,000 messages would write one row per metric and silently discard the rest: a
-- successful-looking run against an almost-empty table. Publishing flat out while still advancing
-- timestamps by the recorded intervals is a different feature with a different argument, and is not
-- this one. 60x is the ceiling because an hour of capture in a minute is already the fastest thing
-- anybody has asked for.
ALTER TABLE public.playback_jobs DROP CONSTRAINT IF EXISTS playback_jobs_speed_is_sane;
ALTER TABLE public.playback_jobs ADD CONSTRAINT playback_jobs_speed_is_sane
    CHECK (speed > 0 AND speed <= 60);

ALTER TABLE public.playback_jobs DROP CONSTRAINT IF EXISTS playback_jobs_device_map_is_object;
ALTER TABLE public.playback_jobs ADD CONSTRAINT playback_jobs_device_map_is_object
    CHECK (jsonb_typeof(device_map) = 'object');

-- SINGLE-FLIGHT PER TARGET GATEWAY, WHICH IS NOT WHAT 0055 DOES, and the difference is the
-- invariant rather than a preference. Capture is single-flight GLOBALLY because the daemon holds
-- one buffer and the page shows one card. Playback conflicts only on the EDGE NODE: two playbacks
-- publishing as the same gateway interleave their sequence numbers, which is exactly the gap
-- detection failure this design avoids elsewhere. Two playbacks to different simulated gateways
-- interfere with nothing.
--
-- The worker still runs them one at a time -- it is a single process with a queue -- so a job for
-- another gateway waits rather than being refused. That is a property of the worker and can change
-- without touching this index; the index is the property that must not.
CREATE UNIQUE INDEX IF NOT EXISTS playback_jobs_one_per_target
    ON public.playback_jobs (target_gateway_id) WHERE status IN ('PENDING', 'RUNNING');

CREATE INDEX IF NOT EXISTS idx_playback_jobs_created_at
    ON public.playback_jobs (created_at DESC);

COMMENT ON TABLE public.playback_jobs IS
  'One row per playback attempted. At most one is PENDING or RUNNING per TARGET GATEWAY -- two '
  'publishers on one edge node interleave sequence numbers. Written only through the gates in '
  '0056; there is no direct-write policy. Progress is pushed to the page by Realtime.';


-- ---------------------------------------------------------------------------------------------
-- 3. RLS
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.playback_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "playback_jobs_select_privileged" ON public.playback_jobs;
CREATE POLICY "playback_jobs_select_privileged" ON public.playback_jobs
    FOR SELECT TO authenticated
    USING (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Auditor']));

-- No INSERT, UPDATE or DELETE policy for any role. That is the access control.


-- ---------------------------------------------------------------------------------------------
-- 4. The capture the worker is allowed to read, right now
-- ---------------------------------------------------------------------------------------------
-- THE WORKER MUST READ THE CAPTURE OUT OF STORAGE, and `broker_captures_read_privileged` admits
-- Administrator, Shopfloor_Manager and Auditor. A worker holding `Operator` gets 42501 -- the same
-- class of defect as 0051, with the same symptom of a job that fails for a reason nothing surfaces.
-- A read gate is a prerequisite here exactly as the write gate was for capture.
--
-- SCOPED TO THE RUNNING JOB, mirroring `is_active_capture_object()`. Not "the playback worker may
-- read captures" -- that is standing authority over every recording on the stack, held by a process
-- that also holds broker publish rights. This is "the playback worker may read THE CAPTURE NAMED BY
-- THE JOB IT IS RUNNING", which is nothing at all when no playback is in flight.
--
-- SECURITY DEFINER because `playback_jobs` is readable only by the three privileged roles and the
-- worker holds `Operator`. It answers a yes/no about one path and returns nothing else.
-- ---------------------------------------------------------------------------------------------
-- 4b. Does this gateway hold a broker credential the platform issued?
-- ---------------------------------------------------------------------------------------------
-- `gateway_holds_a_credential()` IS NOT THE PREDICATE FOR THIS, AND THE ROADMAP SAID IT WAS. Item
-- 17 §5 names it directly. It is:
--
--     SELECT NOT g.is_virtual AND g.enrolled_at IS NOT NULL
--
-- which answers "is this a PHYSICAL appliance that has completed enrolment". For playback targets
-- that is inverted: it refuses every virtual gateway -- which is what a playback target normally is
-- -- and admits only real hardware, which is precisely what a playback must never publish as. 0041
-- had already written this down when it added the mint-a-virtual-credential path: "a virtual
-- gateway is outside its scope by definition".
--
-- Measured before it was read: an end-to-end run created a simulated virtual gateway, minted its
-- credential through the same edge function the Access Control page calls, and was still refused.
--
-- SO THE QUESTION HAS TO BE ASKED OF BOTH ROUTES, because a credential arrives by one of two:
--
--   physical   `enrolled_at`, stamped when the appliance redeemed its enrolment token.
--   virtual    a `CREDENTIAL_ISSUED` row in the digital thread, written by
--              `record_gateway_credential_issued()` (0041). There is NO COLUMN for it -- the audit
--              row is the record, which is deliberate: the password exists in one browser for one
--              minute and is never stored.
--
-- AND REVOCATION IS SUBTRACTED. 0038 stamps `credential_revoked_at` on archive and delete and
-- clears it on re-enrolment, so an issuance older than a revocation does not count. Without that
-- arm a decommissioned gateway would stay a valid playback target forever on the strength of an
-- append-only row that cannot be deleted.
--
-- SECURITY DEFINER because `digital_thread` is readable only by privileged roles and an Auditor,
-- and this is called from a gate whose caller may hold neither. It answers a yes/no about one
-- gateway. STABLE, not IMMUTABLE: it reads two tables, and the older function beside it is marked
-- IMMUTABLE only because it reads nothing but its argument.
CREATE OR REPLACE FUNCTION public.gateway_has_broker_credential(g public.gateways)
    RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
    SELECT
        (NOT g.is_virtual AND g.enrolled_at IS NOT NULL)
     OR (g.is_virtual AND EXISTS (
            SELECT 1 FROM public.digital_thread dt
             WHERE dt.entity_type = 'gateways'
               AND dt.entity_id   = g.id
               AND dt.action      = 'CREDENTIAL_ISSUED'
               AND (g.credential_revoked_at IS NULL OR dt.recorded_at > g.credential_revoked_at)
        ));
$fn$;

COMMENT ON FUNCTION public.gateway_has_broker_credential(public.gateways) IS
  'True when the platform has issued this gateway a broker credential by EITHER route -- physical '
  'enrolment or the virtual mint in 0041 -- and has not revoked it since. Distinct from '
  'gateway_holds_a_credential(), which asks only about physical enrolment and therefore excludes '
  'every virtual gateway by definition (see 0041). Use this one to ask whether anything can '
  'authenticate as a gateway; use that one to ask whether an appliance completed enrolment.';


CREATE OR REPLACE FUNCTION public.is_active_playback_capture(p_name text)
    RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
    SELECT EXISTS (
        SELECT 1 FROM public.playback_jobs j
         WHERE j.status = 'RUNNING' AND j.capture_storage_path = p_name
    );
$fn$;

COMMENT ON FUNCTION public.is_active_playback_capture(text) IS
  'True when a storage object is the capture of a playback job that is RUNNING right now. Confines '
  'the playback worker''s read of broker-captures to the single file it is publishing: with no '
  'playback in flight the worker can reach nothing in the bucket at all.';


-- ---------------------------------------------------------------------------------------------
-- 5. Starting a playback
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_playback_job(
    p_capture_id        uuid,
    p_target_gateway_id uuid,
    p_device_map        jsonb   DEFAULT '{}'::jsonb,
    p_speed             numeric DEFAULT 1.0
) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_gateway  public.gateways;
    v_capture  public.captures;
    v_running  RECORD;
    v_key      text;
    v_target   text;
    v_job_id   uuid;
BEGIN
    IF NOT public.may_manage_captures() THEN
        RAISE EXCEPTION
          'start_playback_job: publishing a capture requires Administrator or Shopfloor_Manager'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_capture FROM public.captures WHERE id = p_capture_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'start_playback_job: no capture %', p_capture_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    SELECT * INTO v_gateway FROM public.gateways WHERE id = p_target_gateway_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'start_playback_job: no gateway %', p_target_gateway_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- ------------------------------------------------------------------------------------
    -- TIER ONE: the target must be marked simulated
    -- ------------------------------------------------------------------------------------
    -- REFUSAL, NOT A WARNING, and this is what turns 0052's marking from a label into a
    -- precondition. `capture.py play` can only warn, having no view of the directory. Here the
    -- answer is available, so a capture cannot be published onto a gateway whose telemetry anyone
    -- downstream believes is real -- the historian records a replayed reading identically to an
    -- observed one, and `is_simulated` is the only thing that says otherwise.
    IF NOT v_gateway.is_simulated THEN
        RAISE EXCEPTION
          'start_playback_job: gateway % is not marked simulated. Publishing a capture onto it '
          'would write synthetic telemetry that nothing downstream can tell from observed data. '
          'Mark it simulated (0052) or choose a playback target.', v_gateway.name
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_gateway.is_archived THEN
        RAISE EXCEPTION 'start_playback_job: gateway % is archived.', v_gateway.name
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- ------------------------------------------------------------------------------------
    -- TIER TWO, the database half: the target must hold a broker credential
    -- ------------------------------------------------------------------------------------
    -- AND NOT `status = 'ONLINE'`, which is the tempting check and is wrong. A playback target is
    -- legitimately OFFLINE: nothing publishes as it until a playback runs, so requiring liveness
    -- would refuse every FIRST playback and pass only after one had already succeeded.
    --
    -- This does not prove the WORKER holds the credential -- nothing in the database can know that,
    -- and the worker refuses for itself when it does not. It proves the credential EXISTS, which is
    -- what turns "the broker will reject this" into an answer available before the job is queued.
    --
    -- `gateway_has_broker_credential()`, NOT `gateway_holds_a_credential()` which item 17 §5 names:
    -- that one means "physical and enrolled" and excludes every virtual gateway by definition. See
    -- section 4b above -- this was measured, not argued.
    IF NOT public.gateway_has_broker_credential(v_gateway) THEN
        RAISE EXCEPTION
          'start_playback_job: gateway % holds no broker credential, so nothing can authenticate '
          'as it. Issue one from the Access Control page first -- that is also how you obtain the '
          'password the playback worker needs.', v_gateway.name
            USING ERRCODE = 'check_violation';
    END IF;

    -- ------------------------------------------------------------------------------------
    -- The device map
    -- ------------------------------------------------------------------------------------
    -- EVERY TARGET MUST BE A DEVICE OF THIS GATEWAY. Publishing under the target gateway's edge
    -- node with a device segment belonging to another gateway is exactly what
    -- `verify_gateway_binding()` quarantines -- so an unchecked map produces a playback that
    -- "succeeds" and quarantines a device, which reads as a fleet fault rather than a mapping one.
    FOR v_key, v_target IN SELECT key, value FROM jsonb_each_text(coalesce(p_device_map, '{}'::jsonb))
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM public.devices d
             WHERE d.sparkplug_id = v_target AND d.gateway_id = p_target_gateway_id
               AND NOT d.is_archived
        ) THEN
            RAISE EXCEPTION
              'start_playback_job: % maps to %, which is not an active device of gateway %.',
              v_key, v_target, v_gateway.name
                USING ERRCODE = 'foreign_key_violation';
        END IF;
    END LOOP;

    -- ------------------------------------------------------------------------------------
    -- One playback per target, reported rather than left to the index
    -- ------------------------------------------------------------------------------------
    SELECT j.id, j.status INTO v_running
      FROM public.playback_jobs j
     WHERE j.target_gateway_id = p_target_gateway_id AND j.status IN ('PENDING', 'RUNNING')
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION
          'start_playback_job: a playback onto % is already %. Two publishers on one edge node '
          'interleave their sequence numbers, which the daemon reports as permanent message loss.',
          v_gateway.name, lower(v_running.status)
            USING ERRCODE = 'unique_violation';
    END IF;

    INSERT INTO public.playback_jobs (
        capture_id, capture_storage_path, target_gateway_id, target_edge_node_id,
        sparkplug_group, device_map, speed, status, requested_by
    ) VALUES (
        v_capture.id, v_capture.storage_path, v_gateway.id, v_gateway.sparkplug_id,
        v_gateway.sparkplug_group, coalesce(p_device_map, '{}'::jsonb),
        least(greatest(coalesce(p_speed, 1.0), 0.01), 60), 'PENDING', auth.uid()
    )
    RETURNING id INTO v_job_id;

    RETURN v_job_id;
END;
$fn$;

COMMENT ON FUNCTION public.start_playback_job(uuid, uuid, jsonb, numeric) IS
  'Queue a capture for publication onto a simulated gateway. The only way a playback_jobs row is '
  'created. Refuses a target that is not is_simulated, one holding no broker credential, a device '
  'map naming devices of another gateway, and a second concurrent playback onto the same edge '
  'node. See 0056''s header for the three tiers this is the first of.';


CREATE OR REPLACE FUNCTION public.request_playback_stop(p_job_id uuid)
    RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_status text;
BEGIN
    IF NOT public.may_manage_captures() THEN
        RAISE EXCEPTION 'request_playback_stop: requires Administrator or Shopfloor_Manager'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT status INTO v_status FROM public.playback_jobs WHERE id = p_job_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'request_playback_stop: no playback job %', p_job_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF v_status NOT IN ('PENDING', 'RUNNING') THEN
        RETURN false;
    END IF;

    -- A PENDING job the worker has never claimed is cancelled outright, for 0055's reason: setting
    -- a flag on it would leave the row PENDING forever if the worker is down, and the per-target
    -- index would then block every future playback onto that gateway with nothing to point at.
    IF v_status = 'PENDING' THEN
        UPDATE public.playback_jobs
           SET status = 'CANCELLED', stop_requested = true, finished_at = now(),
               error = 'cancelled before the worker claimed it'
         WHERE id = p_job_id;
        RETURN true;
    END IF;

    UPDATE public.playback_jobs SET stop_requested = true WHERE id = p_job_id;
    RETURN true;
END;
$fn$;


-- ---------------------------------------------------------------------------------------------
-- 6. The worker's gates
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.playback_claim_job()
    RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_job public.playback_jobs;
BEGIN
    PERFORM public.require_playback_caller('playback_claim_job');

    SELECT * INTO v_job
      FROM public.playback_jobs
     WHERE status = 'PENDING'
     ORDER BY created_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    UPDATE public.playback_jobs
       SET status = 'RUNNING', started_at = now()
     WHERE id = v_job.id;

    -- THE STATUS IN THE RETURNED ROW IS THE NEW ONE. `v_job` was read before the UPDATE, so
    -- returning it unmodified would tell the worker the job is still PENDING -- and the storage
    -- read arm it is about to depend on keys on RUNNING.
    RETURN to_jsonb(v_job) || jsonb_build_object('status', 'RUNNING', 'started_at', now());
END;
$fn$;


CREATE OR REPLACE FUNCTION public.playback_progress(
    p_job_id          uuid,
    p_messages_sent   integer,
    p_messages_total  integer,
    p_elapsed_seconds integer
) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_stop boolean;
BEGIN
    PERFORM public.require_playback_caller('playback_progress');

    UPDATE public.playback_jobs
       SET messages_sent   = greatest(coalesce(p_messages_sent, 0), 0),
           messages_total  = greatest(coalesce(p_messages_total, messages_total), 0),
           elapsed_seconds = greatest(coalesce(p_elapsed_seconds, 0), 0)
     WHERE id = p_job_id AND status = 'RUNNING'
    RETURNING stop_requested INTO v_stop;

    -- Cancelled, or reconciled away by a restart. Telling the worker to stop is the right answer to
    -- both: there is nothing left for it to complete into.
    IF NOT FOUND THEN
        RETURN true;
    END IF;
    RETURN coalesce(v_stop, false);
END;
$fn$;


CREATE OR REPLACE FUNCTION public.playback_finish(
    p_job_id        uuid,
    p_messages_sent integer,
    p_error         text DEFAULT NULL
) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
BEGIN
    PERFORM public.require_playback_caller('playback_finish');

    -- ONE FUNCTION FOR BOTH OUTCOMES, unlike capture's pair, because a playback that stops early
    -- has still published everything it published -- there is no artifact to write on success and
    -- nothing to roll back on failure. The distinction is a status and a string.
    UPDATE public.playback_jobs
       SET status = CASE WHEN p_error IS NULL THEN 'COMPLETED' ELSE 'FAILED' END,
           finished_at = now(),
           messages_sent = greatest(coalesce(p_messages_sent, messages_sent), 0),
           error = left(nullif(btrim(coalesce(p_error, '')), ''), 2000)
     WHERE id = p_job_id AND status IN ('PENDING', 'RUNNING');
END;
$fn$;


-- STARTUP RECONCILIATION, and the consequence of omitting it is worse here than for capture. A row
-- left at RUNNING keeps matching the per-target index, so every future playback onto that gateway
-- is refused -- and `is_active_playback_capture()` keeps returning true for its capture, leaving
-- the worker a standing read of one object in the bucket for as long as the row survives.
CREATE OR REPLACE FUNCTION public.playback_reconcile_jobs()
    RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_n integer;
BEGIN
    PERFORM public.require_playback_caller('playback_reconcile_jobs');

    WITH swept AS (
        UPDATE public.playback_jobs
           SET status = 'FAILED', finished_at = now(),
               error = 'the playback worker restarted while this job was ' || lower(status)
                       || '; publishing stopped partway'
         WHERE status IN ('PENDING', 'RUNNING')
        RETURNING 1
    )
    SELECT count(*) INTO v_n FROM swept;
    RETURN v_n;
END;
$fn$;


-- ---------------------------------------------------------------------------------------------
-- 7. Realtime
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
         WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'playback_jobs'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.playback_jobs;
        RAISE NOTICE '0056: playback_jobs added to the supabase_realtime publication.';
    END IF;
END $$;

ALTER TABLE public.playback_jobs REPLICA IDENTITY FULL;


-- ---------------------------------------------------------------------------------------------
-- 8. Grants
-- ---------------------------------------------------------------------------------------------
-- REVOKE FIRST, for 0055's reason: this schema's default privileges GRANT ALL on every new public
-- table to anon, authenticated and service_role, so the table was born with `anon` holding INSERT,
-- UPDATE and DELETE and RLS as the only thing in front of it.
REVOKE ALL ON public.playback_jobs FROM anon, authenticated;
GRANT SELECT ON public.playback_jobs TO authenticated;

REVOKE ALL ON FUNCTION public.is_playback_caller() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_playback_caller() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.require_playback_caller(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.require_playback_caller(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_active_playback_capture(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active_playback_capture(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.gateway_has_broker_credential(public.gateways) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gateway_has_broker_credential(public.gateways)
    TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.start_playback_job(uuid, uuid, jsonb, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_playback_job(uuid, uuid, jsonb, numeric)
    TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.request_playback_stop(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_playback_stop(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.playback_claim_job() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.playback_claim_job() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.playback_progress(uuid, integer, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.playback_progress(uuid, integer, integer, integer)
    TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.playback_finish(uuid, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.playback_finish(uuid, integer, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.playback_reconcile_jobs() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.playback_reconcile_jobs() TO authenticated, service_role;


-- ---------------------------------------------------------------------------------------------
-- 9. Self-check
-- ---------------------------------------------------------------------------------------------
DO $selfcheck$
DECLARE
    v_wide           text;
    v_write_policies integer;
    v_triggers       integer;
    v_missing        text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = 'b0000000-0000-4000-8000-000000000003') THEN
        RAISE EXCEPTION '0056 self-check: the Service_Playback principal was not created.';
    END IF;

    -- THE TWO PRINCIPALS MUST NOT BE THE SAME ONE. A future edit that pointed
    -- `is_playback_caller()` at the ingestion uuid would silently give the daemon every playback
    -- gate -- and the daemon's broker account may publish nothing but NCMD, so the failure would be
    -- a job that runs, reports success, and moves nothing.
    IF public.is_playback_caller() = public.is_ingestion_caller() AND public.is_playback_caller() THEN
        RAISE EXCEPTION
          '0056 self-check: is_playback_caller() and is_ingestion_caller() admit the same caller. '
          'They guard different broker rights and must name different principals.';
    END IF;

    -- THE TWO CREDENTIAL PREDICATES MUST STAY DIFFERENT, and this is the check that would have
    -- caught the defect this migration was written with. `gateway_holds_a_credential()` means
    -- "physical and enrolled"; a virtual gateway holding a freshly minted credential must be
    -- admitted by the new one and refused by the old one. If a later edit collapses them, every
    -- playback target on a virtual fleet stops being startable -- and the refusal names a
    -- credential that visibly exists, which is the hardest kind of message to act on.
    IF EXISTS (SELECT 1 FROM public.gateways WHERE is_virtual AND NOT is_archived) THEN
        PERFORM 1 FROM public.gateways g
         WHERE g.is_virtual AND NOT g.is_archived
           AND public.gateway_holds_a_credential(g);
        IF FOUND THEN
            RAISE EXCEPTION
              '0056 self-check: gateway_holds_a_credential() admitted a VIRTUAL gateway. It is '
              'defined as `NOT is_virtual AND enrolled_at IS NOT NULL` and 0041 relies on virtual '
              'gateways being outside its scope. Playback must use '
              'gateway_has_broker_credential() instead -- see section 4b.';
        END IF;
    END IF;

    SELECT count(*) INTO v_write_policies FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'playback_jobs'
       AND cmd IN ('INSERT', 'UPDATE', 'DELETE') AND 'authenticated' = ANY (roles);
    IF v_write_policies <> 0 THEN
        RAISE EXCEPTION
          '0056 self-check: % write polic(ies) on playback_jobs admit `authenticated`. The gates '
          'in this migration are the only door -- a policy beside them retires the is_simulated '
          'refusal and the credential check without anything erroring.', v_write_policies;
    END IF;

    SELECT count(*) INTO v_triggers FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc  p ON p.oid = t.tgfoid
     WHERE c.relname = 'playback_jobs' AND p.proname = 'log_digital_thread_event';
    IF v_triggers <> 0 THEN
        RAISE EXCEPTION
          '0056 self-check: log_digital_thread_event() is attached to playback_jobs. The worker '
          'updates progress once a second, so this writes one audit row per tick into an '
          'append-only table no application role can prune.';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
         WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'playback_jobs'
    ) THEN
        RAISE EXCEPTION
          '0056 self-check: playback_jobs is not in the supabase_realtime publication, so the '
          'running card would reach SUBSCRIBED and receive nothing.';
    END IF;

    SELECT string_agg(format('%s on playback_jobs to %s', privilege_type, grantee), '; ')
      INTO v_wide
      FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND table_name = 'playback_jobs'
       AND (grantee = 'anon'
         OR (grantee = 'authenticated' AND privilege_type <> 'SELECT'));
    IF v_wide IS NOT NULL THEN
        RAISE EXCEPTION
          '0056 self-check: the grant layer is wider than the gates. Found: %. This schema''s '
          'default privileges GRANT ALL on every new public table, so recreating this table '
          're-widens both roles with nothing to say so.', v_wide;
    END IF;

    SELECT string_agg(fn, ', ') INTO v_missing
      FROM unnest(ARRAY[
             'playback_claim_job', 'playback_progress', 'playback_finish', 'playback_reconcile_jobs'
           ]) AS fn
     WHERE NOT EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = fn
           AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
     );
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION
          '0056 self-check: `authenticated` cannot EXECUTE %. The worker holds an ordinary '
          'authenticated principal, so a gate granted only to service_role answers 42501, is '
          'caught and logged, and the playback simply never runs. That is 0051.', v_missing;
    END IF;

    RAISE NOTICE
      '0056 self-check: Service_Playback exists and is distinct from Service_Ingestor, '
      'playback_jobs takes no direct write, carries no digital-thread trigger, is published to '
      'Realtime, and all four worker gates are executable.';
END;
$selfcheck$;
