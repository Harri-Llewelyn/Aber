-- =============================================================================================
-- 0055: capture orchestration -- the tables and gates behind the Capture page
-- =============================================================================================
--
-- `ingestion/capture.py record` opens its own MQTT subscription from a terminal. A browser cannot:
-- mosquitto listens on 1883 TCP with no WebSocket listener, and the recording principal's password
-- is a server-side secret that a bundle would publish -- which is the exact thing mosquitto.acl was
-- rewritten to prevent. So a capture started from the dashboard is NEW BEHAVIOUR IN THE INGESTION
-- DAEMON with a page in front of it, and this file is the contract between the two.
--
-- THE DAEMON IS THE HOST, AND THERE IS NO SECOND PRINCIPAL. It already holds the `spBv1.0/#`
-- subscription and the credential, so a capture job costs no new broker connection -- `on_message()`
-- appends to a buffer while a job is active and the topic matches. A separate capture service would
-- need its own broker account AND would split the `seq` stream: `_last_seq` is keyed
-- `(group, edge_node)`, so a second subscriber makes the daemon's own gap detection fire
-- permanently. That is roadmap item 1's `$share` finding arriving from the other direction, and it
-- is why "a capture daemon principal with read-only access to the topic tree" is a principal this
-- design does not create.
--
-- ---------------------------------------------------------------------------------------------
-- TWO TABLES, BECAUSE THEY ANSWER DIFFERENT QUESTIONS
--
-- `capture_jobs` records an ACT that happened once: who asked, when it started, how far it got, why
-- it failed. `captures` records the ARTIFACT that exists now. They are separate because a capture
-- UPLOADED THROUGH THE BROWSER NEVER HAD A JOB -- there is no act to point at -- and because
-- roadmap item 17's playback half needs `playback_jobs.capture_id` to reference something that both
-- paths produce. Folding the artifact into the job row would leave two ways to name a capture, a
-- job id for recorded ones and a storage path for uploaded ones, which is the kind of split that
-- ends up handled in four places and wrongly in one.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
--
-- NO DIGITAL-THREAD TRIGGER ON EITHER TABLE, and its absence is a decision rather than an omission.
-- `log_digital_thread_event()` is opt-in per table -- `cells`, `devices` and `gateways` each name it
-- explicitly -- so adding it here would look like consistency. It would write one row per progress
-- tick into an append-only table no application role can prune, which is 0005's heartbeat problem
-- exactly. A capture is not an asset lifecycle event.
--
-- NO TELEMETRY. A capture is a file in Storage plus two rows here; the `telemetry` hypertable is not
-- written by this feature at all. Worth stating because a gate scoped to "metadata and telemetry
-- records" would be scoped to something that does not happen.
--
-- ---------------------------------------------------------------------------------------------
-- IDEMPOTENT. CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, DROP-then-ADD for constraints,
-- CREATE OR REPLACE for functions, DROP-then-CREATE for policies, and a guarded ALTER PUBLICATION.
-- db-init replays every migration on every boot in filename order.
--
-- Related: 0026 and 0047 (the gate pattern and `require_ingestion_caller()`), 0048 (the principal),
--          0051 (what a missing grant costs), 0052 (`gateways.is_simulated`),
--          0023 (adding a table to the `supabase_realtime` publication),
--          supabase/storage-policies.sql (the `broker-captures` bucket), README.md item 17.
-- =============================================================================================

SET search_path TO public;


-- ---------------------------------------------------------------------------------------------
-- 1. The artifact
-- ---------------------------------------------------------------------------------------------
-- SUBJECT IS TWO NULLABLE FOREIGN KEYS AND A DISCRIMINATOR, NOT A POLYMORPHIC `subject_id uuid`.
-- A bare uuid pointing at either table cannot be a foreign key, so a deleted gateway would leave a
-- capture row referring to nothing, and the page would render a subject that no longer exists.
-- Two columns and a CHECK cost one constraint and buy referential integrity in both directions.
CREATE TABLE IF NOT EXISTS public.captures (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_kind          text        NOT NULL,
    gateway_id            uuid        REFERENCES public.gateways(id) ON DELETE CASCADE,
    device_id             uuid        REFERENCES public.devices(id)  ON DELETE CASCADE,

    -- THE STORAGE PREFIX, AND A FACT ABOUT THE FILE RATHER THAN A JOIN. `storage.objects` is
    -- confined by a policy that reads the leading folder of the path, so the path has to be
    -- derivable without reading this table -- and after the subject row is deleted this is the
    -- only remaining record of where the bytes were.
    subject_sparkplug_id  text        NOT NULL,
    storage_path          text        NOT NULL UNIQUE,

    size_bytes            bigint      NOT NULL CHECK (size_bytes >= 0),
    message_count         integer     NOT NULL CHECK (message_count >= 0),

    -- The operator's one-line label, given when the capture was started. Shown on the list and,
    -- critically, inside the replace confirmation -- see `start_capture_job()`.
    note                  text,

    -- WHAT IS IN THE FILE, SO THE PAGE CAN SAY SO WITHOUT DOWNLOADING IT. Metric names seen, the
    -- topic count, the observed rate, and `birth_captured`. The last is the one that earns its
    -- place: it makes the alias trap visible on the list rather than something discovered when a
    -- playback ingests nothing. See `ingest_finalise_capture()`.
    manifest              jsonb       NOT NULL DEFAULT '{}'::jsonb,

    source                text        NOT NULL DEFAULT 'recorded',
    recorded_at           timestamptz NOT NULL DEFAULT now(),
    created_at            timestamptz NOT NULL DEFAULT now(),
    created_by            uuid
);

ALTER TABLE public.captures DROP CONSTRAINT IF EXISTS captures_subject_kind_valid;
ALTER TABLE public.captures ADD CONSTRAINT captures_subject_kind_valid
    CHECK (subject_kind IN ('gateway', 'device'));

ALTER TABLE public.captures DROP CONSTRAINT IF EXISTS captures_source_valid;
ALTER TABLE public.captures ADD CONSTRAINT captures_source_valid
    CHECK (source IN ('recorded', 'uploaded'));

-- THE DISCRIMINATOR AND THE KEYS MUST AGREE, or a device capture with a NULL device_id would be
-- filed under a prefix nothing points at.
ALTER TABLE public.captures DROP CONSTRAINT IF EXISTS captures_subject_is_coherent;
ALTER TABLE public.captures ADD CONSTRAINT captures_subject_is_coherent
    CHECK (
        (subject_kind = 'gateway' AND gateway_id IS NOT NULL AND device_id IS NULL)
     OR (subject_kind = 'device'  AND device_id  IS NOT NULL)
    );

-- ONE STORED CAPTURE PER SUBJECT, IN THE DATABASE. "A new recording replaces the old" is the whole
-- storage model -- it is what bounds the bucket -- and two browser tabs cannot race a partial
-- unique index. Two indexes rather than one over a coalesced expression, because the two subject
-- kinds live in different columns and an index over `COALESCE(device_id, gateway_id)` would
-- collide a device with a gateway that happened to share a uuid.
CREATE UNIQUE INDEX IF NOT EXISTS captures_one_per_gateway
    ON public.captures (gateway_id) WHERE subject_kind = 'gateway';
CREATE UNIQUE INDEX IF NOT EXISTS captures_one_per_device
    ON public.captures (device_id)  WHERE subject_kind = 'device';

COMMENT ON TABLE public.captures IS
  'The capture that EXISTS for a subject -- at most one per gateway and one per device, enforced by '
  'two partial unique indexes. Written by ingest_finalise_capture() for a recorded capture and by '
  'register_uploaded_capture() for one uploaded through the browser; both paths land here so that '
  'playback has a single way to name a capture. Distinct from capture_jobs, which records the ACT '
  'of recording and has no row at all for an uploaded file. See 0055''s header.';

COMMENT ON COLUMN public.captures.manifest IS
  'What is in the file, so the list can describe a capture nobody has downloaded: metric_names '
  '(capped at 50, with metric_name_count beside it), topic_count, observed_rate_hz, '
  'birth_captured, and the edge_node_ids / device_ids the recording publishes under. '
  'birth_captured=false means the recording contains no NBIRTH/DBIRTH, so an alias-optimised '
  'gateway will replay as unresolved_alias and drop every metric -- from a file that otherwise '
  'looks complete. Note it means the NODE''s birth: announcing a DEVICE takes a DBIRTH, and only '
  'that sets a device ONLINE. device_ids is what the playback dialog builds its device map from, '
  'which is why it is here rather than read out of a file that may be 100 MiB.';


-- ---------------------------------------------------------------------------------------------
-- 2. The act
-- ---------------------------------------------------------------------------------------------
-- THE TOPIC-MATCHING COLUMNS ARE DENORMALISED ON PURPOSE. The daemon matches every message against
-- the active job inside `on_message()`, which is the hot path for the whole fleet; resolving a
-- subject to its sparkplug ids there would mean a join per message. The gate computes them once,
-- at the only moment they can change.
CREATE TABLE IF NOT EXISTS public.capture_jobs (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_kind          text        NOT NULL,
    gateway_id            uuid        REFERENCES public.gateways(id) ON DELETE CASCADE,
    device_id             uuid        REFERENCES public.devices(id)  ON DELETE CASCADE,

    -- Everything the daemon needs to decide whether a message belongs to this job, without a join.
    sparkplug_group       text        NOT NULL,
    edge_node_id          text        NOT NULL,
    device_sparkplug_id   text,
    subject_sparkplug_id  text        NOT NULL,
    storage_path          text        NOT NULL,

    status                text        NOT NULL DEFAULT 'PENDING',
    note                  text,

    -- THE THREE CAPS, WHICH HAVE TO AGREE WITH THE BUCKET. Defaults and bounds are stated here
    -- rather than in the daemon so that the limit an operator sees on the page and the limit the
    -- recording actually honours are the same number. See the CHECK constraints below for why
    -- 50 MiB rather than the 500 MB originally proposed.
    max_seconds           integer     NOT NULL DEFAULT 7200,
    max_messages          integer     NOT NULL DEFAULT 100000,
    max_bytes             bigint      NOT NULL DEFAULT 52428800,

    -- Progress. Updated by the daemon roughly once a second and pushed to the page by Realtime.
    messages              bigint      NOT NULL DEFAULT 0,
    bytes                 bigint      NOT NULL DEFAULT 0,
    elapsed_seconds       integer     NOT NULL DEFAULT 0,
    birth_captured        boolean     NOT NULL DEFAULT false,

    -- ENDING EARLY IS A COLUMN, NOT A CALL. The daemon serves exactly one HTTP endpoint --
    -- Prometheus /metrics -- so there is no REST tier to host `POST /captures/{id}/stop`, and
    -- `/api/v1/...` is a client-side convention inside frontend/src/api.js that maps onto
    -- PostgREST rather than a server. A flag the daemon observes on its next message also survives
    -- a page reload, which a fired-off POST would not.
    stop_requested        boolean     NOT NULL DEFAULT false,

    capture_id            uuid        REFERENCES public.captures(id) ON DELETE SET NULL,
    error                 text,

    requested_by          uuid,
    created_at            timestamptz NOT NULL DEFAULT now(),
    started_at            timestamptz,
    finished_at           timestamptz
);

ALTER TABLE public.capture_jobs DROP CONSTRAINT IF EXISTS capture_jobs_status_valid;
ALTER TABLE public.capture_jobs ADD CONSTRAINT capture_jobs_status_valid
    CHECK (status IN ('PENDING', 'RECORDING', 'COMPLETED', 'FAILED', 'CANCELLED'));

ALTER TABLE public.capture_jobs DROP CONSTRAINT IF EXISTS capture_jobs_subject_kind_valid;
ALTER TABLE public.capture_jobs ADD CONSTRAINT capture_jobs_subject_kind_valid
    CHECK (subject_kind IN ('gateway', 'device'));

ALTER TABLE public.capture_jobs DROP CONSTRAINT IF EXISTS capture_jobs_subject_is_coherent;
ALTER TABLE public.capture_jobs ADD CONSTRAINT capture_jobs_subject_is_coherent
    CHECK (
        (subject_kind = 'gateway' AND gateway_id IS NOT NULL AND device_sparkplug_id IS NULL)
     OR (subject_kind = 'device'  AND device_id  IS NOT NULL AND device_sparkplug_id IS NOT NULL)
    );

-- THE CAPS ARE BOUNDED, NOT MERELY DEFAULTED, and the size bound is the one that matters.
--
-- 500 MB CANNOT BE STORED. `broker-captures` is created by scripts/storage-init.mjs with a
-- file_size_limit, and a capture that reached a 500 MB cap would terminate SUCCESSFULLY and then
-- fail to upload -- the worst possible ordering, because the recording is gone by then. The three
-- caps have to be mutually consistent and consistent with the bucket, or the outermost one is
-- decorative. 100,000 messages at a few hundred bytes each is roughly 40 MB, so 50 MiB is the
-- smallest size cap that still lets the MESSAGE cap bind first; the bucket is raised to 100 MiB in
-- the same commit, which leaves headroom for a chattier fleet than this one.
--
-- IT IS ALSO BUFFERED IN THE DAEMON'S MEMORY, which is the stronger argument. The Helm chart
-- declares no memory limit for `ingestion`, so a 500 MB buffer is not refused -- it is bounded by
-- node pressure, and the process is killed, taking ingestion for the whole fleet with it.
ALTER TABLE public.capture_jobs DROP CONSTRAINT IF EXISTS capture_jobs_caps_are_bounded;
ALTER TABLE public.capture_jobs ADD CONSTRAINT capture_jobs_caps_are_bounded
    CHECK (
        max_seconds  BETWEEN 5 AND 7200
    AND max_messages BETWEEN 1 AND 100000
    AND max_bytes    BETWEEN 1024 AND 52428800
    );

-- SINGLE-FLIGHT, GLOBALLY, IN THE DATABASE. This schema is single-tenant and the page shows ONE
-- running card, so a lock per gateway would permit N concurrent captures and contradict the
-- interface. An index over a constant expression is how Postgres spells "at most one row matching
-- this predicate".
--
-- PENDING IS INSIDE THE PREDICATE AS WELL AS RECORDING, which the roadmap entry did not say. A job
-- the daemon has not claimed yet still occupies the single card, and leaving it out would let two
-- tabs queue two jobs that then run one after the other -- which is concurrency arriving by the
-- back door, a second later.
CREATE UNIQUE INDEX IF NOT EXISTS capture_jobs_single_flight
    ON public.capture_jobs ((true)) WHERE status IN ('PENDING', 'RECORDING');

CREATE INDEX IF NOT EXISTS idx_capture_jobs_created_at
    ON public.capture_jobs (created_at DESC);

COMMENT ON TABLE public.capture_jobs IS
  'One row per recording ATTEMPTED, including the ones that failed. At most one row is PENDING or '
  'RECORDING at a time across the whole stack (capture_jobs_single_flight). Written only through '
  'the gates in 0055 -- there is no direct-write RLS policy -- and pushed to the Capture page by '
  'Realtime as the daemon updates its progress columns.';

COMMENT ON COLUMN public.capture_jobs.stop_requested IS
  'Set by request_capture_stop(); observed by the daemon on its next message, which then flushes '
  'and completes. A column rather than an endpoint because the daemon hosts no REST tier, and '
  'because a flag survives a page reload.';


-- ---------------------------------------------------------------------------------------------
-- 3. RLS -- the gates are the only door
-- ---------------------------------------------------------------------------------------------
-- A VALIDATION GATE IS ONLY A GATE IF IT IS THE ONLY WAY IN. A policy letting `authenticated`
-- INSERT `capture_jobs` would leave the function as one of two doors -- and the one the UI happens
-- to use, not the one an API caller has to. PostgREST exposes every table it can see, so "the
-- frontend only calls the RPC" is a statement about the frontend, not about the schema.
--
-- Same shape as 0047: the table takes NO direct write from any application role, the RPC is the
-- only path, and the checks live inside it.
ALTER TABLE public.captures     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capture_jobs ENABLE ROW LEVEL SECURITY;

-- READ MATCHES THE BUCKET. Administrator, Shopfloor_Manager and Auditor can already read
-- `broker-captures` itself, so listing what is in it reveals nothing further. Operator cannot read
-- the bucket and cannot read this, which keeps the two answers from disagreeing.
DROP POLICY IF EXISTS "captures_select_privileged" ON public.captures;
CREATE POLICY "captures_select_privileged" ON public.captures
    FOR SELECT TO authenticated
    USING (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Auditor']));

-- DELETE IS DIRECT, AND IT IS THE ONE WRITE THAT IS. Removing a capture is the operator's own act
-- on their own session -- the same session that deletes the object from Storage, where an RPC
-- could not follow it. Auditor is absent for the reason the bucket's policies give at length: an
-- auditor who can delete a capture can delete the evidence they exist to examine.
DROP POLICY IF EXISTS "captures_delete_privileged" ON public.captures;
CREATE POLICY "captures_delete_privileged" ON public.captures
    FOR DELETE TO authenticated
    USING (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

DROP POLICY IF EXISTS "capture_jobs_select_privileged" ON public.capture_jobs;
CREATE POLICY "capture_jobs_select_privileged" ON public.capture_jobs
    FOR SELECT TO authenticated
    USING (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Auditor']));

-- No INSERT or UPDATE policy on either table, for any role. That is the access control.


-- ---------------------------------------------------------------------------------------------
-- 4. Who may start one
-- ---------------------------------------------------------------------------------------------
-- The same authority the bucket's INSERT policy requires, and it has to be: a capture the operator
-- can start is a capture the operator's session will later have to delete.
CREATE OR REPLACE FUNCTION public.may_manage_captures()
    RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $fn$
    SELECT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']);
$fn$;


-- ---------------------------------------------------------------------------------------------
-- 4b. What may be the leading folder of a capture object
-- ---------------------------------------------------------------------------------------------
-- USED BY supabase/storage-policies.sql, NOT BY ANYTHING IN THIS FILE, and it lives here for the
-- reason `public.has_role()` does: that script runs after db-init and can depend on this schema,
-- but a migration cannot depend on `storage.objects`, which storage-api creates for itself.
--
-- THE `devices` ARM IS NEW. Captures are filed BY THE SUBJECT RECORDED -- the CLI files by playback
-- TARGET because a hand-uploaded file offers no other fact, but a page that records from a subject
-- knows the subject, and that is what makes the two tabs coherent. Today's policy admits gateway
-- ids only, so a `dev...` prefix would be refused for a reason its filename does not suggest.
--
-- NOT SECURITY DEFINER, deliberately. It replaces an EXISTS that was evaluated as the caller, and
-- promoting it would admit prefixes the caller cannot see -- a quiet widening of a policy, which is
-- the last place to put one. Both tables carry `SELECT ... USING (true)` for `authenticated`, so
-- every principal that can reach the bucket can already answer this question.
CREATE OR REPLACE FUNCTION public.is_capture_subject_prefix(p_folder text)
    RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $fn$
    SELECT EXISTS (SELECT 1 FROM public.gateways g WHERE g.sparkplug_id = p_folder)
        OR EXISTS (SELECT 1 FROM public.devices  d WHERE d.sparkplug_id = p_folder);
$fn$;

COMMENT ON FUNCTION public.is_capture_subject_prefix(text) IS
  'True when a storage folder names a real gateway or device. The prefix rule for broker-captures, '
  'which files by the SUBJECT RECORDED rather than by the gateway a capture plays back as.';


-- ---------------------------------------------------------------------------------------------
-- 4c. The one object the daemon is allowed to touch, right now
-- ---------------------------------------------------------------------------------------------
-- THE DAEMON'S AUTHORITY OVER THE BUCKET IS SCOPED TO THE CAPTURE IT IS CURRENTLY MAKING, and this
-- predicate is what says so. Not "the ingestion principal may write captures" -- that would be an
-- account with standing authority over every capture on the stack, held by the process most
-- exposed to the plant network. This is "the ingestion principal may write THE OBJECT NAMED BY THE
-- JOB IT IS RUNNING", which is nothing at all when no capture is in flight.
--
-- IT ALSO HAS TO ADMIT READS, AND THAT IS NOT WHAT THE FIRST VERSION DID. Write-only looked right
-- and was measured to be impossible: each subject has one capture object, so a re-record OVERWRITES
-- it, storage-js spells overwrite as `upsert: true`, and storage-api serves that as
-- `INSERT ... ON CONFLICT DO UPDATE` -- which Postgres evaluates against the SELECT policy as well
-- as the UPDATE one, because the statement has to see the row it conflicts with. A principal that
-- cannot read an object cannot overwrite it:
--
--   ingestion daemon           upsert=n  200
--   ingestion daemon (upsert)  upsert=y  400  new row violates row-level security policy
--
-- Confined this way the read arm gives up very little. The daemon may read back the file it is in
-- the middle of writing -- which it holds in memory anyway -- and no other, so the captures already
-- stored stay out of its reach exactly as intended.
--
-- SECURITY DEFINER, and that is required rather than convenient: `capture_jobs` is readable only by
-- the three privileged roles, and the daemon holds `Operator`. It answers a yes/no about one path
-- and returns nothing else, so it discloses no more than the policy that calls it already decides.
CREATE OR REPLACE FUNCTION public.is_active_capture_object(p_name text)
    RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
    SELECT EXISTS (
        SELECT 1 FROM public.capture_jobs j
         WHERE j.status = 'RECORDING' AND j.storage_path = p_name
    );
$fn$;

COMMENT ON FUNCTION public.is_active_capture_object(text) IS
  'True when a storage object path is the destination of a capture job that is RECORDING right '
  'now. Confines the ingestion daemon''s authority over broker-captures to the single file it is '
  'producing: with no capture in flight the daemon can reach nothing in the bucket at all.';


-- ---------------------------------------------------------------------------------------------
-- 5. Starting a capture
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_capture_job(
    p_subject_kind text,
    p_subject_id   uuid,
    p_note         text    DEFAULT NULL,
    p_max_seconds  integer DEFAULT 300,
    p_replace      boolean DEFAULT false
) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_gateway   RECORD;
    v_device    RECORD;
    v_gateway_id          uuid;
    v_device_id           uuid;
    v_device_sparkplug    text;
    v_subject_sparkplug   text;
    v_existing            RECORD;
    v_running             RECORD;
    v_job_id              uuid;
BEGIN
    IF NOT public.may_manage_captures() THEN
        RAISE EXCEPTION
          'start_capture_job: recording the broker requires Administrator or Shopfloor_Manager'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF p_subject_kind NOT IN ('gateway', 'device') THEN
        RAISE EXCEPTION 'start_capture_job: p_subject_kind must be ''gateway'' or ''device'', got %',
            coalesce(p_subject_kind, '<null>') USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- --------------------------------------------------------------------------------------
    -- Resolve the subject to the identities the daemon matches on
    -- --------------------------------------------------------------------------------------
    IF p_subject_kind = 'gateway' THEN
        SELECT g.id, g.sparkplug_id, g.sparkplug_group, g.is_archived
          INTO v_gateway
          FROM public.gateways g WHERE g.id = p_subject_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'start_capture_job: no gateway %', p_subject_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;
        IF v_gateway.is_archived THEN
            RAISE EXCEPTION
              'start_capture_job: gateway % is archived. An archived gateway publishes nothing, so '
              'the capture would run its full duration and produce an empty file.', p_subject_id
                USING ERRCODE = 'invalid_parameter_value';
        END IF;
        v_gateway_id        := v_gateway.id;
        v_subject_sparkplug := v_gateway.sparkplug_id;

    ELSE
        SELECT d.id, d.sparkplug_id, d.gateway_id, d.is_archived
          INTO v_device
          FROM public.devices d WHERE d.id = p_subject_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'start_capture_job: no device %', p_subject_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;
        IF v_device.is_archived THEN
            RAISE EXCEPTION 'start_capture_job: device % is archived.', p_subject_id
                USING ERRCODE = 'invalid_parameter_value';
        END IF;
        IF v_device.gateway_id IS NULL THEN
            -- A quarantined device can sit with no gateway. There is no edge node to match on and
            -- none to request a rebirth from, so the capture has nothing to subscribe to.
            RAISE EXCEPTION
              'start_capture_job: device % is not bound to a gateway, so there is no edge node to '
              'record from. Resolve its quarantine first.', p_subject_id
                USING ERRCODE = 'invalid_parameter_value';
        END IF;

        SELECT g.id, g.sparkplug_id, g.sparkplug_group
          INTO v_gateway
          FROM public.gateways g WHERE g.id = v_device.gateway_id;

        v_gateway_id        := v_gateway.id;
        v_device_id         := v_device.id;
        v_device_sparkplug  := v_device.sparkplug_id;
        v_subject_sparkplug := v_device.sparkplug_id;
    END IF;

    -- --------------------------------------------------------------------------------------
    -- The replace decision, made here rather than in the browser
    -- --------------------------------------------------------------------------------------
    -- THE MODAL IS A PRECONDITION IN THE DATABASE, NOT A UI CONVENTION. `p_replace` exists so that
    -- overwriting a stored capture is something the caller has to SAY, and an API caller that has
    -- never seen the modal is refused with the note of the capture it was about to destroy. The
    -- destroy-a-rare-fault risk is the whole reason the note field exists, and a check only the
    -- frontend performs does not mitigate it.
    --
    -- NOTHING IS DESTROYED HERE. The old row and the old object both survive until the replacement
    -- exists -- `ingest_finalise_capture()` swaps them at the end. A capture destroyed at START by
    -- a recording that then fails is a capture destroyed for nothing.
    SELECT c.id, c.note, c.recorded_at INTO v_existing
      FROM public.captures c
     WHERE (p_subject_kind = 'gateway' AND c.subject_kind = 'gateway' AND c.gateway_id = v_gateway_id)
        OR (p_subject_kind = 'device'  AND c.subject_kind = 'device'  AND c.device_id  = v_device_id);

    IF FOUND AND NOT p_replace THEN
        -- THE REFUSAL NAMES WHAT IT IS PROTECTING, note included. "Overwrite the capture of Line 1
        -- Gateway from 27 Aug 14:30 -- pre-trip bearing vibration baseline?" is a different
        -- decision from the same question without that line, and mitigating the
        -- destroy-a-rare-fault risk is the entire reason the note field exists.
        RAISE EXCEPTION
          'start_capture_job: a capture of this subject already exists (recorded %). Recording '
          'again replaces it. Call with p_replace := true to confirm.',
          to_char(v_existing.recorded_at, 'DD Mon YYYY HH24:MI')
              || coalesce(' -- ' || v_existing.note, '')
            USING ERRCODE = 'unique_violation';
    END IF;

    -- --------------------------------------------------------------------------------------
    -- Single-flight, reported rather than left to the index
    -- --------------------------------------------------------------------------------------
    -- The partial unique index is what ENFORCES this, and it stays: two tabs cannot race it. This
    -- lookup exists only so the refusal names the job in the way -- `23505 duplicate key value
    -- violates unique constraint "capture_jobs_single_flight"` is true and tells an operator
    -- nothing about which capture is already running.
    SELECT j.id, j.status, j.subject_sparkplug_id INTO v_running
      FROM public.capture_jobs j
     WHERE j.status IN ('PENDING', 'RECORDING')
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION
          'start_capture_job: a capture of % is already %. One capture runs at a time on this '
          'stack; stop that one first.', v_running.subject_sparkplug_id, lower(v_running.status)
            USING ERRCODE = 'unique_violation';
    END IF;

    -- --------------------------------------------------------------------------------------
    -- The row
    -- --------------------------------------------------------------------------------------
    -- THE STORAGE PATH IS DETERMINISTIC AND DERIVED FROM THE SUBJECT, which is what makes an
    -- orphaned object impossible: there is at most one object per subject, so a replacement
    -- overwrites the key rather than leaving the previous file behind for a browser to sweep. It
    -- also means the path satisfies the bucket's prefix policy by construction rather than because
    -- the daemon assembled it correctly.
    INSERT INTO public.capture_jobs (
        subject_kind, gateway_id, device_id,
        sparkplug_group, edge_node_id, device_sparkplug_id,
        subject_sparkplug_id, storage_path,
        status, note, max_seconds, requested_by
    ) VALUES (
        p_subject_kind, v_gateway_id, v_device_id,
        v_gateway.sparkplug_group, v_gateway.sparkplug_id, v_device_sparkplug,
        v_subject_sparkplug, v_subject_sparkplug || '/capture.json',
        'PENDING', nullif(btrim(coalesce(p_note, '')), ''),
        least(greatest(coalesce(p_max_seconds, 300), 5), 7200),
        auth.uid()
    )
    RETURNING id INTO v_job_id;

    RETURN v_job_id;
END;
$fn$;

COMMENT ON FUNCTION public.start_capture_job(text, uuid, text, integer, boolean) IS
  'Queue a broker capture of one gateway or one device. The only way a capture_jobs row is created. '
  'Refuses without Administrator or Shopfloor_Manager, refuses a second concurrent capture, and '
  'refuses to overwrite a stored capture unless p_replace is true -- which is what makes the '
  'replace confirmation a property of the schema rather than of the frontend.';


-- ---------------------------------------------------------------------------------------------
-- 6. Ending one early
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_capture_stop(p_job_id uuid)
    RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_status text;
BEGIN
    IF NOT public.may_manage_captures() THEN
        RAISE EXCEPTION 'request_capture_stop: requires Administrator or Shopfloor_Manager'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT status INTO v_status FROM public.capture_jobs WHERE id = p_job_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'request_capture_stop: no capture job %', p_job_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- NOT AN ERROR ON A FINISHED JOB. The page can only send this from a card it is already
    -- watching, and the job may complete between the click and the call -- which is the ordinary
    -- case when somebody stops a capture just as its duration cap expires. Raising there would
    -- show a failure for something that did exactly what was asked.
    IF v_status NOT IN ('PENDING', 'RECORDING') THEN
        RETURN false;
    END IF;

    -- A PENDING JOB THE DAEMON HAS NEVER SEEN IS CANCELLED OUTRIGHT. Setting stop_requested on it
    -- would leave the row PENDING forever if the daemon is down, and the single-flight index would
    -- then block every future capture on this stack with nothing to point at.
    IF v_status = 'PENDING' THEN
        UPDATE public.capture_jobs
           SET status = 'CANCELLED', stop_requested = true, finished_at = now(),
               error = 'cancelled before the daemon claimed it'
         WHERE id = p_job_id;
        RETURN true;
    END IF;

    UPDATE public.capture_jobs SET stop_requested = true WHERE id = p_job_id;
    RETURN true;
END;
$fn$;


-- ---------------------------------------------------------------------------------------------
-- 7. A capture that arrived through the browser
-- ---------------------------------------------------------------------------------------------
-- NO JOB ROW, BECAUSE NO RECORDING HAPPENED. This is the second writer of `captures` and the
-- reason the artifact is a table of its own.
--
-- THE BROWSER BUILDS THE MANIFEST, and it can: `uploadCapture()` already parses the file to check
-- that it carries `acs_capture_version` and a `messages` array, so the same pass fills these
-- fields. Without it every uploaded capture would show blank next to every recorded one and the
-- column would read as broken rather than absent.
CREATE OR REPLACE FUNCTION public.register_uploaded_capture(
    p_subject_kind  text,
    p_subject_id    uuid,
    p_storage_path  text,
    p_size_bytes    bigint,
    p_message_count integer,
    p_manifest      jsonb   DEFAULT '{}'::jsonb,
    p_note          text    DEFAULT NULL,
    p_replace       boolean DEFAULT false
) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_gateway_id        uuid;
    v_device_id         uuid;
    v_subject_sparkplug text;
    v_capture_id        uuid;
BEGIN
    IF NOT public.may_manage_captures() THEN
        RAISE EXCEPTION 'register_uploaded_capture: requires Administrator or Shopfloor_Manager'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF p_subject_kind = 'gateway' THEN
        SELECT g.id, g.sparkplug_id INTO v_gateway_id, v_subject_sparkplug
          FROM public.gateways g WHERE g.id = p_subject_id;
    ELSIF p_subject_kind = 'device' THEN
        SELECT d.id, d.sparkplug_id, d.gateway_id
          INTO v_device_id, v_subject_sparkplug, v_gateway_id
          FROM public.devices d WHERE d.id = p_subject_id;
    ELSE
        RAISE EXCEPTION 'register_uploaded_capture: p_subject_kind must be ''gateway'' or ''device'''
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF v_subject_sparkplug IS NULL THEN
        RAISE EXCEPTION 'register_uploaded_capture: no % %', p_subject_kind, p_subject_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- THE PATH IS CHECKED AGAINST THE SUBJECT RATHER THAN TRUSTED. The bucket's own policy confines
    -- the leading folder to a real gateway or device, but it cannot know which subject THIS row
    -- claims -- so without this a caller could file an object under one subject's prefix and record
    -- it here as another's, and the list would offer a capture that downloads somebody else's file.
    IF p_storage_path IS DISTINCT FROM (v_subject_sparkplug || '/capture.json') THEN
        RAISE EXCEPTION
          'register_uploaded_capture: p_storage_path must be %/capture.json for this subject, got %',
          v_subject_sparkplug, coalesce(p_storage_path, '<null>')
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.captures c
         WHERE (p_subject_kind = 'gateway' AND c.subject_kind = 'gateway' AND c.gateway_id = v_gateway_id)
            OR (p_subject_kind = 'device'  AND c.subject_kind = 'device'  AND c.device_id  = v_device_id)
    ) AND NOT p_replace THEN
        RAISE EXCEPTION
          'register_uploaded_capture: a capture of this subject already exists. Uploading replaces '
          'it. Call with p_replace := true to confirm.'
            USING ERRCODE = 'unique_violation';
    END IF;

    DELETE FROM public.captures c
     WHERE (p_subject_kind = 'gateway' AND c.subject_kind = 'gateway' AND c.gateway_id = v_gateway_id)
        OR (p_subject_kind = 'device'  AND c.subject_kind = 'device'  AND c.device_id  = v_device_id);

    INSERT INTO public.captures (
        subject_kind, gateway_id, device_id, subject_sparkplug_id, storage_path,
        size_bytes, message_count, note, manifest, source, created_by
    ) VALUES (
        p_subject_kind, v_gateway_id,
        v_device_id, v_subject_sparkplug, p_storage_path,
        greatest(coalesce(p_size_bytes, 0), 0), greatest(coalesce(p_message_count, 0), 0),
        nullif(btrim(coalesce(p_note, '')), ''),
        public.capped_capture_manifest(coalesce(p_manifest, '{}'::jsonb)),
        'uploaded', auth.uid()
    )
    RETURNING id INTO v_capture_id;

    RETURN v_capture_id;
END;
$fn$;


-- ---------------------------------------------------------------------------------------------
-- 8. The manifest cap, in one place so the two writers cannot disagree
-- ---------------------------------------------------------------------------------------------
-- THE SAME CAP `record_ingestion_rejection()` APPLIES TO ITS VIOLATIONS, AND FOR THE SAME REASON: a
-- chatty device would otherwise put a thousand metric names into a JSONB column. The true count is
-- kept beside the list, because a truncation nobody can see is worse than a short list.
CREATE OR REPLACE FUNCTION public.capped_capture_manifest(p_manifest jsonb)
    RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public'
    AS $fn$
DECLARE
    c_max_listed CONSTANT integer := 50;
    v_names      jsonb;
    v_total      integer;
BEGIN
    IF p_manifest IS NULL OR jsonb_typeof(p_manifest) <> 'object' THEN
        RETURN '{}'::jsonb;
    END IF;

    -- IS DISTINCT FROM, NOT <>. A manifest with no `metric_names` key at all yields NULL here, and
    -- `NULL <> 'array'` is NULL -- which IF treats as false, so the guard would fall THROUGH into
    -- `jsonb_array_length(NULL)` on exactly the input it exists to reject. An uploaded capture
    -- whose manifest omitted the key would have taken this path.
    IF jsonb_typeof(p_manifest -> 'metric_names') IS DISTINCT FROM 'array' THEN
        RETURN p_manifest;
    END IF;

    v_total := jsonb_array_length(p_manifest -> 'metric_names');
    IF v_total <= c_max_listed THEN
        RETURN jsonb_set(p_manifest, '{metric_name_count}', to_jsonb(v_total));
    END IF;

    SELECT jsonb_agg(value ORDER BY ord) INTO v_names
      FROM (
        SELECT value, ordinality AS ord
          FROM jsonb_array_elements(p_manifest -> 'metric_names') WITH ORDINALITY AS t(value, ordinality)
         ORDER BY ordinality
         LIMIT c_max_listed
      ) capped;

    RETURN jsonb_set(
             jsonb_set(p_manifest, '{metric_names}', coalesce(v_names, '[]'::jsonb)),
             '{metric_name_count}', to_jsonb(v_total)
           );
END;
$fn$;


-- ---------------------------------------------------------------------------------------------
-- 9. The daemon's gates
-- ---------------------------------------------------------------------------------------------
-- ALL FOUR ARE GRANTED TO `authenticated` AND GATED ON IDENTITY INSIDE, which is 0047's pattern and
-- is required rather than stylistic: the daemon authenticates as `Service_Ingestor`, an ordinary
-- `authenticated` principal holding `Operator`. A grant to `service_role` alone would be a grant to
-- a key the daemon no longer holds -- that is exactly the defect 0051 fixed.

-- Claim the queued job, if there is one. Returns NULL when there is nothing to do, which is the
-- ordinary answer on almost every poll.
CREATE OR REPLACE FUNCTION public.ingest_claim_capture_job()
    RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_job public.capture_jobs;
BEGIN
    PERFORM public.require_ingestion_caller('ingest_claim_capture_job');

    -- SKIP LOCKED is belt and braces here -- the single-flight index already means there is at most
    -- one claimable row, and there is one daemon. It costs nothing and keeps the function correct
    -- if either of those ever stops being true.
    SELECT * INTO v_job
      FROM public.capture_jobs
     WHERE status = 'PENDING'
     ORDER BY created_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    UPDATE public.capture_jobs
       SET status = 'RECORDING', started_at = now()
     WHERE id = v_job.id;

    RETURN to_jsonb(v_job) || jsonb_build_object('status', 'RECORDING', 'started_at', now());
END;
$fn$;


-- Report progress, and learn whether to stop -- in ONE round trip. The daemon calls this about once
-- a second while recording; splitting "tell me the progress" from "should I stop" would double that
-- for no gain, and would let the two answers come from different instants.
CREATE OR REPLACE FUNCTION public.ingest_capture_progress(
    p_job_id          uuid,
    p_messages        bigint,
    p_bytes           bigint,
    p_elapsed_seconds integer,
    p_birth_captured  boolean DEFAULT false
) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_stop boolean;
BEGIN
    PERFORM public.require_ingestion_caller('ingest_capture_progress');

    UPDATE public.capture_jobs
       SET messages        = greatest(coalesce(p_messages, 0), 0),
           bytes           = greatest(coalesce(p_bytes, 0), 0),
           elapsed_seconds = greatest(coalesce(p_elapsed_seconds, 0), 0),
           -- ONCE TRUE, ALWAYS TRUE. A birth arrives once, near the start; a later tick reporting
           -- `false` because nothing has arrived SINCE would erase the fact that one did.
           birth_captured  = capture_jobs.birth_captured OR coalesce(p_birth_captured, false)
     WHERE id = p_job_id AND status = 'RECORDING'
    RETURNING stop_requested INTO v_stop;

    IF NOT FOUND THEN
        -- The job was cancelled, or reconciled away by a restart. Telling the daemon to stop is the
        -- right answer to both: there is nothing left for it to finalise into.
        RETURN true;
    END IF;

    RETURN coalesce(v_stop, false);
END;
$fn$;


-- The recording succeeded and the bytes are in Storage. Swap the artifact.
CREATE OR REPLACE FUNCTION public.ingest_finalise_capture(
    p_job_id        uuid,
    p_size_bytes    bigint,
    p_message_count integer,
    p_manifest      jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_job        public.capture_jobs;
    v_capture_id uuid;
BEGIN
    PERFORM public.require_ingestion_caller('ingest_finalise_capture');

    SELECT * INTO v_job FROM public.capture_jobs WHERE id = p_job_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ingest_finalise_capture: no capture job %', p_job_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF v_job.status <> 'RECORDING' THEN
        RAISE EXCEPTION 'ingest_finalise_capture: job % is %, not RECORDING', p_job_id, v_job.status
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- THE SWAP HAPPENS HERE, IN ONE TRANSACTION, AND NOT WHEN THE JOB STARTED. The previous capture
    -- survived the entire recording; if the recording had failed it would still be there. The
    -- storage OBJECT was overwritten in place by the upload that preceded this call -- the path is
    -- deterministic per subject -- so there is no orphan for anybody to sweep afterwards.
    DELETE FROM public.captures c
     WHERE (v_job.subject_kind = 'gateway' AND c.subject_kind = 'gateway' AND c.gateway_id = v_job.gateway_id)
        OR (v_job.subject_kind = 'device'  AND c.subject_kind = 'device'  AND c.device_id  = v_job.device_id);

    INSERT INTO public.captures (
        subject_kind, gateway_id, device_id, subject_sparkplug_id, storage_path,
        size_bytes, message_count, note, manifest, source, recorded_at, created_by
    ) VALUES (
        v_job.subject_kind, v_job.gateway_id, v_job.device_id,
        v_job.subject_sparkplug_id, v_job.storage_path,
        greatest(coalesce(p_size_bytes, 0), 0), greatest(coalesce(p_message_count, 0), 0),
        v_job.note,
        public.capped_capture_manifest(coalesce(p_manifest, '{}'::jsonb)),
        'recorded', coalesce(v_job.started_at, now()), v_job.requested_by
    )
    RETURNING id INTO v_capture_id;

    UPDATE public.capture_jobs
       SET status = 'COMPLETED', finished_at = now(), capture_id = v_capture_id,
           messages = greatest(coalesce(p_message_count, 0), 0),
           bytes    = greatest(coalesce(p_size_bytes, 0), 0)
     WHERE id = p_job_id;

    RETURN v_capture_id;
END;
$fn$;


CREATE OR REPLACE FUNCTION public.ingest_fail_capture(p_job_id uuid, p_error text)
    RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
BEGIN
    PERFORM public.require_ingestion_caller('ingest_fail_capture');

    UPDATE public.capture_jobs
       SET status = 'FAILED', finished_at = now(),
           -- Truncated, because this is whatever the exception said and a driver can produce a
           -- great deal of it. The page shows this string.
           error = left(coalesce(nullif(btrim(p_error), ''), 'unspecified failure'), 2000)
     WHERE id = p_job_id AND status IN ('PENDING', 'RECORDING');
END;
$fn$;


-- STARTUP RECONCILIATION, AND IT IS NOT OPTIONAL. Without it a restart mid-capture leaves a row at
-- RECORDING forever: the page shows a card counting down that never clears, and -- worse -- the
-- single-flight index blocks every future capture on this stack, because the abandoned row still
-- matches the predicate. Nothing errors, and the feature is simply dead until somebody finds the
-- row by hand.
CREATE OR REPLACE FUNCTION public.ingest_reconcile_capture_jobs()
    RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
DECLARE
    v_n integer;
BEGIN
    PERFORM public.require_ingestion_caller('ingest_reconcile_capture_jobs');

    -- PENDING IS SWEPT TOO, not only RECORDING. A job queued while the daemon was down has no
    -- buffer to resume and no rebirth was ever requested for it, so claiming it later would produce
    -- a capture whose window began at an arbitrary earlier moment.
    WITH swept AS (
        UPDATE public.capture_jobs
           SET status = 'FAILED', finished_at = now(),
               error = 'the ingestion daemon restarted while this job was '
                       || lower(status) || '; the recording did not survive'
         WHERE status IN ('PENDING', 'RECORDING')
        RETURNING 1
    )
    SELECT count(*) INTO v_n FROM swept;

    RETURN v_n;
END;
$fn$;


-- ---------------------------------------------------------------------------------------------
-- 10. Realtime
-- ---------------------------------------------------------------------------------------------
-- WITHOUT THIS THE RUNNING CARD NEVER MOVES AND NOTHING ERRORS. The publication currently carries
-- `cells`, `devices`, `gateways` and `platform_alerts` only; a subscription to a table outside it
-- reaches SUBSCRIBED and then receives nothing, which is indistinguishable in the browser from a
-- capture that is not progressing.
--
-- `captures` is deliberately NOT added. The list is refetched when a job completes, and a table in
-- the publication is one more stream of WAL for every connected dashboard to filter.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
         WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'capture_jobs'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.capture_jobs;
        RAISE NOTICE '0055: capture_jobs added to the supabase_realtime publication.';
    END IF;
END $$;

-- REPLICA IDENTITY FULL, so an UPDATE carries the whole row rather than only the changed columns
-- plus the key. The page renders the card from the payload it is handed; with the default identity
-- a progress tick would arrive naming `messages` and `bytes` and nothing else, and the card would
-- lose the subject it is describing.
ALTER TABLE public.capture_jobs REPLICA IDENTITY FULL;


-- ---------------------------------------------------------------------------------------------
-- 11. Grants
-- ---------------------------------------------------------------------------------------------
-- REVOKE FIRST, AND IT IS NOT DEFENSIVE PUNCTUATION -- WITHOUT IT THE GRANTS BELOW ARE DECORATIVE.
--
-- This database carries `ALTER DEFAULT PRIVILEGES ... IN SCHEMA public GRANT ALL ON TABLES TO anon,
-- authenticated, service_role`, inherited from the Supabase image. Both tables above were therefore
-- BORN holding `arwdDxtm` for all three roles, `anon` included -- so a bare `GRANT SELECT` adds a
-- privilege that was already there and narrows nothing at all. Measured, not assumed:
--
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_name = 'capture_jobs';
--   -> anon, authenticated, service_role each with DELETE, INSERT, SELECT, TRUNCATE, UPDATE, ...
--
-- WHAT THAT COSTS, precisely. RLS still denies -- there is no `anon` policy and no write policy --
-- so nothing is reachable today. But the access control then rests on RLS ALONE, with nothing
-- behind it, and a future migration that adds a policy for a narrow purpose inherits a grant layer
-- that permits everything. `supabase/storage-policies.sql` found the same default on `storage` and
-- narrowed it for the same reason; this is that decision applied here.
--
-- IT ALSO SILENTLY UNDOES ITSELF. The default privilege applies at CREATE TABLE, so a later
-- migration that drops and recreates either table re-widens both roles with nothing to say so --
-- which is why the self-check at the end of this file asserts the narrowing rather than trusting
-- these three lines to have been the last word.
REVOKE ALL ON public.captures     FROM anon, authenticated;
REVOKE ALL ON public.capture_jobs FROM anon, authenticated;

GRANT SELECT ON public.captures     TO authenticated;
GRANT DELETE ON public.captures     TO authenticated;   -- RLS narrows this to the two write roles
GRANT SELECT ON public.capture_jobs TO authenticated;

REVOKE ALL ON FUNCTION public.may_manage_captures() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.may_manage_captures() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.is_capture_subject_prefix(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_capture_subject_prefix(text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.is_active_capture_object(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_active_capture_object(text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.capped_capture_manifest(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.capped_capture_manifest(jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.start_capture_job(text, uuid, text, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_capture_job(text, uuid, text, integer, boolean)
    TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.request_capture_stop(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_capture_stop(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.register_uploaded_capture(text, uuid, text, bigint, integer, jsonb, text, boolean)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_uploaded_capture(text, uuid, text, bigint, integer, jsonb, text, boolean)
    TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.ingest_claim_capture_job() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ingest_claim_capture_job() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.ingest_capture_progress(uuid, bigint, bigint, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ingest_capture_progress(uuid, bigint, bigint, integer, boolean)
    TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.ingest_finalise_capture(uuid, bigint, integer, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ingest_finalise_capture(uuid, bigint, integer, jsonb)
    TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.ingest_fail_capture(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ingest_fail_capture(uuid, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.ingest_reconcile_capture_jobs() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ingest_reconcile_capture_jobs() TO authenticated, service_role;


-- ---------------------------------------------------------------------------------------------
-- 12. Self-check
-- ---------------------------------------------------------------------------------------------
-- WHAT CAN ACTUALLY FAIL HERE, rather than what is easy to assert. Re-running the migration
-- reconciles every object above, so checking that a table exists immediately after creating it is
-- vacuous. Three things are not:
--
--   1. THE DIRECT-WRITE DOOR. An INSERT or UPDATE policy added later -- by a migration that only
--      wanted the page to work without an RPC -- would leave `start_capture_job()` as one of two
--      doors and silently retire every check inside it. Nothing would error; captures would simply
--      start being creatable by anyone signed in.
--   2. THE DIGITAL-THREAD TRIGGER. Adding it would look like consistency with `devices` and
--      `gateways`, and would write a row per progress tick into an append-only table.
--   3. THE PUBLICATION. Absent, the running card never moves and no error is raised anywhere.
--
-- The grants are checked too, because 0051 is the whole reason this file exists in the shape it
-- does: a missing EXECUTE answers 42501, the daemon logs it and carries on, and the symptom is a
-- capture that never appears rather than a failure anybody sees.
DO $selfcheck$
DECLARE
    v_write_policies integer;
    v_triggers       integer;
    v_missing        text;
    v_wide           text;
BEGIN
    -- 0. THE GRANT LAYER, WHICH RE-WIDENS ITSELF IF EITHER TABLE IS EVER RECREATED. See the note
    --    above the REVOKEs: `ALTER DEFAULT PRIVILEGES` hands `anon` and `authenticated` every
    --    privilege on any new table in this schema, so the narrowing is a property of THIS
    --    migration having run last rather than of the table definition.
    SELECT string_agg(format('%s on %s to %s', privilege_type, table_name, grantee), '; ')
      INTO v_wide
      FROM information_schema.role_table_grants
     WHERE table_schema = 'public'
       AND table_name IN ('captures', 'capture_jobs')
       AND ((grantee = 'anon')
         OR (grantee = 'authenticated' AND privilege_type IN ('INSERT', 'UPDATE', 'TRUNCATE'))
         OR (grantee = 'authenticated' AND privilege_type = 'DELETE' AND table_name = 'capture_jobs'));
    IF v_wide IS NOT NULL THEN
        RAISE EXCEPTION
          '0055 self-check: the grant layer is wider than the gates. Found: %. `anon` must hold '
          'nothing on either table and `authenticated` only SELECT (plus DELETE on captures) -- '
          'everything else goes through the SECURITY DEFINER gates. This schema''s default '
          'privileges GRANT ALL on every new public table, so recreating either table re-widens '
          'both roles with nothing to say so.', v_wide;
    END IF;

    SELECT count(*) INTO v_write_policies FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('captures', 'capture_jobs')
       AND cmd IN ('INSERT', 'UPDATE')
       AND 'authenticated' = ANY (roles);
    IF v_write_policies <> 0 THEN
        RAISE EXCEPTION
          '0055 self-check: % INSERT/UPDATE polic(ies) on captures or capture_jobs admit '
          '`authenticated`. These tables take no direct write from any application role -- the gates '
          'in this migration are the only door, and a policy beside them retires every check they '
          'perform without anything erroring. See section 3.', v_write_policies;
    END IF;

    SELECT count(*) INTO v_triggers FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc  p ON p.oid = t.tgfoid
     WHERE c.relname IN ('captures', 'capture_jobs')
       AND p.proname = 'log_digital_thread_event';
    IF v_triggers <> 0 THEN
        RAISE EXCEPTION
          '0055 self-check: log_digital_thread_event() is attached to captures or capture_jobs. '
          'The daemon updates capture_jobs roughly once a second while recording, so this writes '
          'one audit row per progress tick into an append-only table no application role can prune '
          '-- 0005''s heartbeat problem. A capture is not an asset lifecycle event.';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
         WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'capture_jobs'
    ) THEN
        RAISE EXCEPTION
          '0055 self-check: capture_jobs is not in the supabase_realtime publication, so the '
          'running card on the Capture page would reach SUBSCRIBED and then receive nothing -- '
          'which looks exactly like a capture that has stalled.';
    END IF;

    -- Every gate the daemon calls must be executable by `authenticated`, which is the role its
    -- narrow credential presents. This is 0051's defect, asserted rather than left to be
    -- rediscovered from the shape of the data.
    SELECT string_agg(fn, ', ') INTO v_missing
      FROM unnest(ARRAY[
             'ingest_claim_capture_job',
             'ingest_capture_progress',
             'ingest_finalise_capture',
             'ingest_fail_capture',
             'ingest_reconcile_capture_jobs'
           ]) AS fn
     WHERE NOT EXISTS (
        SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = fn
           AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
     );
    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION
          '0055 self-check: `authenticated` cannot EXECUTE %. The daemon holds an ordinary '
          'authenticated principal (0048), so a gate granted only to service_role answers 42501, '
          'is caught and logged, and the capture simply never appears. That is 0051.', v_missing;
    END IF;

    RAISE NOTICE
      '0055 self-check: captures and capture_jobs take no direct write, carry no digital-thread '
      'trigger, capture_jobs is published to Realtime, and all five daemon gates are executable.';
END;
$selfcheck$;
