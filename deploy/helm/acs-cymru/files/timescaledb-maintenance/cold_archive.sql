-- =============================================================================================
-- Cold telemetry archival — the manifest, and the invariant that makes dropping a chunk safe
--
--
-- Reconciled on every boot by timescaledb-maintenance, like retention.sql and aggregates.sql.
-- Idempotent by construction: every object here is CREATE ... IF NOT EXISTS or CREATE OR REPLACE.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT PROBLEM THIS SOLVES, STATED AS IT ACTUALLY IS TODAY
--
-- `retention.sql` adds a TimescaleDB retention policy that DROPS raw chunks older than
-- TIMESCALE_RETAIN_FOR (90 days by default). That is a permanent deletion of plant history, run by
-- a background job, with nothing written down about what went. For a demonstrator that is fine. For
-- a facility that has to answer "what did line 2 do in March" eighteen months later, it is the
-- whole problem.
--
-- Cold archival replaces `delete` with `move`: the chunk is written to Parquet on object storage,
-- the object is read back and verified, the manifest records where it went, and ONLY THEN is the
-- chunk dropped.
--
-- ---------------------------------------------------------------------------------------------
-- THE ORDER IS THE FEATURE, AND ONE CHECK CONSTRAINT ENFORCES IT
--
--     CHECK (dropped_at IS NULL OR verified_at IS NOT NULL)
--
-- A chunk cannot be recorded as dropped unless it was first recorded as verified. That is a
-- database rule rather than a careful sequence in a Python file, because the failure it prevents is
-- silent and permanent: an exporter that uploads, half-fails, and drops anyway destroys telemetry
-- and leaves a manifest row claiming it is safe on object storage.
--
-- The exporter is still the thing that must not drop early -- this constraint cannot stop
-- `drop_chunks()` being called, only stop the LIE being recorded. That asymmetry is why
-- `cold_tier_droppable()` exists below and why the exporter is required to select through it: the
-- list of chunks it is allowed to drop is computed here, from the manifest, not assembled by the
-- caller.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THE MANIFEST LIVES HERE AND NOT IN SUPABASE
--
-- It describes chunks, and chunks are here. A manifest in the other database could drift from the
-- hypertable it claims to describe with nothing able to notice, and the exporter would have to
-- write two databases in one logical transaction that cannot be one.
--
-- The dashboard still reads it: `0068` maps it over the existing postgres_fdw bridge, exactly as
-- `0027` does for `storage_footprint`. One writer here, one reader there.
--
-- Related: timescaledb/retention.sql (the policy this stands down), timescaledb/storage.sql
--          (the same shape of reconciled view), supabase/migrations/0068_cold_storage.sql.
-- =============================================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------------------------
-- 1. The manifest
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.telemetry_archive_manifest (
    -- KEYED BY THE CHUNK, not by a surrogate id. A chunk is the unit that is exported and dropped,
    -- and TimescaleDB names them uniquely within a schema, so the natural key is the real one --
    -- and it makes "have we already done this one" a primary-key lookup rather than a policy.
    chunk_schema    text        NOT NULL,
    chunk_name      text        NOT NULL,

    -- The chunk's time range, copied at claim time. KEPT RATHER THAN JOINED: once the chunk is
    -- dropped, `timescaledb_information.chunks` forgets it existed, and a manifest that could no
    -- longer say WHICH MONTH an object holds would be a catalogue of opaque filenames.
    range_start     timestamptz NOT NULL,
    range_end       timestamptz NOT NULL,

    -- Counted before the export, compared after. The verification step re-reads the object and
    -- checks this number, which is what makes `verified_at` mean something.
    row_count       bigint      NOT NULL,

    object_key      text,
    object_bytes    bigint,
    -- Whatever the storage backend returns to identify the bytes it stored. Recorded rather than
    -- interpreted: it is evidence for a human comparing two systems, not something this schema
    -- claims to be able to recompute.
    object_etag     text,
    format          text        NOT NULL DEFAULT 'parquet',

    claimed_at      timestamptz NOT NULL DEFAULT now(),
    exported_at     timestamptz,
    verified_at     timestamptz,
    dropped_at      timestamptz,
    -- Set when an attempt fails, cleared when one succeeds. A row that has been sitting with a
    -- `last_error` for a week is the thing an operator needs to see, and deleting failed rows would
    -- hide exactly that.
    last_error      text,

    CONSTRAINT telemetry_archive_manifest_pkey PRIMARY KEY (chunk_schema, chunk_name),

    -- THE INVARIANT. See the header: a chunk may not be recorded as dropped unless it was recorded
    -- as verified first.
    CONSTRAINT telemetry_archive_manifest_dropped_implies_verified
        CHECK (dropped_at IS NULL OR verified_at IS NOT NULL),

    -- And verification cannot precede the export it verifies. Cheap to state, and it catches an
    -- exporter that stamps its columns in the wrong order -- which is the shape of the bug the
    -- constraint above exists to survive.
    CONSTRAINT telemetry_archive_manifest_verified_implies_exported
        CHECK (verified_at IS NULL OR exported_at IS NOT NULL),

    CONSTRAINT telemetry_archive_manifest_format_valid
        CHECK (format IN ('parquet')),

    CONSTRAINT telemetry_archive_manifest_range_ordered
        CHECK (range_end > range_start)
);

COMMENT ON TABLE public.telemetry_archive_manifest IS
  'One row per telemetry chunk that has been claimed for cold archival. The CHECK constraints '
  'encode the ordering that makes this safe: exported, then verified, then dropped. A row with '
  'dropped_at set is telemetry that now exists ONLY as the object named by object_key.';

COMMENT ON COLUMN public.telemetry_archive_manifest.row_count IS
  'Counted before export and re-checked against the written object. It is what verified_at means.';

COMMENT ON COLUMN public.telemetry_archive_manifest.dropped_at IS
  'When the raw chunk was removed. Until this is set the data is in BOTH places, which is the only '
  'safe intermediate state — the other order loses data if anything fails in between.';

-- The query the dashboard asks: what is on cold storage, newest first.
CREATE INDEX IF NOT EXISTS telemetry_archive_manifest_range_idx
    ON public.telemetry_archive_manifest (range_start DESC);

-- And the query the exporter asks: what is outstanding.
CREATE INDEX IF NOT EXISTS telemetry_archive_manifest_pending_idx
    ON public.telemetry_archive_manifest (claimed_at)
    WHERE dropped_at IS NULL;


-- ---------------------------------------------------------------------------------------------
-- 2. What is eligible to leave
-- ---------------------------------------------------------------------------------------------
-- ONLY FULLY-ELAPSED CHUNKS. `range_end < now() - threshold` rather than `range_start`, so a chunk
-- is never exported while rows can still land in it. Sparkplug data arrives late routinely -- a
-- gateway that was offline republishes on reconnect -- and a chunk exported at its midpoint would
-- be missing whatever arrived afterwards, with the manifest asserting a row_count that was true
-- once.
--
-- ALREADY-CLAIMED CHUNKS ARE EXCLUDED WHOLE, including failed ones. A retry is a decision an
-- operator makes by clearing `last_error`, not something the candidate list makes for them by
-- silently re-offering a chunk that failed for a reason nobody has looked at yet.
CREATE OR REPLACE FUNCTION public.cold_tier_candidates(p_older_than interval)
RETURNS TABLE (
    chunk_schema text,
    chunk_name   text,
    range_start  timestamptz,
    range_end    timestamptz
)
LANGUAGE sql STABLE
SET search_path TO 'public', 'pg_catalog'
AS $fn$
    SELECT c.chunk_schema::text,
           c.chunk_name::text,
           c.range_start,
           c.range_end
      FROM timescaledb_information.chunks c
     WHERE c.hypertable_name = 'telemetry'
       AND c.range_end < now() - p_older_than
       AND NOT EXISTS (
             SELECT 1 FROM public.telemetry_archive_manifest m
              WHERE m.chunk_schema = c.chunk_schema::text
                AND m.chunk_name   = c.chunk_name::text)
     ORDER BY c.range_end;
$fn$;

COMMENT ON FUNCTION public.cold_tier_candidates(interval) IS
  'Telemetry chunks fully older than the threshold and not yet claimed. Bounded on range_end, not '
  'range_start, so a chunk still accepting late-arriving rows is never exported.';


-- ---------------------------------------------------------------------------------------------
-- 3. What is safe to delete
-- ---------------------------------------------------------------------------------------------
-- THE EXPORTER IS REQUIRED TO SELECT THROUGH THIS RATHER THAN ASSEMBLE ITS OWN LIST, and that is
-- the point of it existing as a function at all. The CHECK constraint above can stop a false
-- manifest row being written; it cannot stop `drop_chunks()` being called on the wrong chunk. This
-- can, by being the only place that answers the question -- so the rule lives beside the data it
-- protects instead of in whichever caller asked last.
CREATE OR REPLACE FUNCTION public.cold_tier_droppable()
RETURNS TABLE (
    chunk_schema text,
    chunk_name   text,
    object_key   text
)
LANGUAGE sql STABLE
SET search_path TO 'public', 'pg_catalog'
AS $fn$
    SELECT m.chunk_schema, m.chunk_name, m.object_key
      FROM public.telemetry_archive_manifest m
     WHERE m.verified_at IS NOT NULL
       AND m.dropped_at IS NULL
       AND m.object_key IS NOT NULL
     ORDER BY m.range_end;
$fn$;

COMMENT ON FUNCTION public.cold_tier_droppable() IS
  'Chunks whose export has been verified and whose raw rows are therefore redundant. The only '
  'supported source for what drop_chunks() may be pointed at.';


-- ---------------------------------------------------------------------------------------------
-- 3b. The drop itself, which the exporter may CALL but could not perform
-- ---------------------------------------------------------------------------------------------
-- SECURITY DEFINER, AND THAT IS THE POINT RATHER THAN A CONVENIENCE.
--
-- `roles.sql` revokes DELETE and TRUNCATE on `public.telemetry` from `ingest_writer` explicitly,
-- and says why: "DELETE and TRUNCATE are the two that make append-only true". The exporter runs as
-- that role. Granting it the ability to drop chunks would undo the one property the historian's
-- role split exists to guarantee -- for the whole table, permanently, so that a job could delete
-- something a manifest said was safe.
--
-- So it gets no such privilege. It gets the ability to ask for THIS, which drops only what the
-- manifest has already verified. The daemon still cannot delete a single telemetry row of its own
-- choosing; the narrow exception is one function, owned by the superuser, whose body is the rule.
--
-- ---------------------------------------------------------------------------------------------
-- A VERIFIED PREFIX, NOT A SET, AND THE DIFFERENCE IS A DATA-LOSS BUG
--
-- `drop_chunks(relation, older_than => X)` is a BOUNDARY, not a selection: it drops every chunk
-- older than X. Calling it once per verified chunk -- the obvious implementation -- would delete
-- every chunk older than each one, INCLUDING chunks never exported. A single verified chunk from
-- the middle of the history would take everything before it.
--
-- TimescaleDB offers no supported "drop exactly this chunk", so the boundary is computed: walk the
-- chunks oldest-first, advance while each is verified, stop at the first that is not. Everything
-- before that point is provably archived. In practice archival runs oldest-first and the verified
-- set IS a prefix -- right up until the run where it is not, which is the run that would have lost
-- data.
CREATE OR REPLACE FUNCTION public.cold_tier_drop_verified()
RETURNS TABLE (dropped_chunk text, object_key text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
    v_boundary timestamptz := NULL;
    v_chunk    record;
BEGIN
    FOR v_chunk IN
        SELECT c.chunk_schema::text AS chunk_schema,
               c.chunk_name::text   AS chunk_name,
               c.range_end
          FROM timescaledb_information.chunks c
         WHERE c.hypertable_name = 'telemetry'
         ORDER BY c.range_end
    LOOP
        -- The first chunk that is NOT verified-and-undropped ends the prefix. Everything after it
        -- stays, however many of them are verified.
        IF NOT EXISTS (
            SELECT 1 FROM public.telemetry_archive_manifest m
             WHERE m.chunk_schema = v_chunk.chunk_schema
               AND m.chunk_name   = v_chunk.chunk_name
               AND m.verified_at IS NOT NULL
               AND m.dropped_at IS NULL
               AND m.object_key IS NOT NULL
        ) THEN
            EXIT;
        END IF;
        v_boundary := v_chunk.range_end;
    END LOOP;

    IF v_boundary IS NULL THEN
        RETURN;
    END IF;

    -- STAMPED FIRST, INSIDE THE SAME TRANSACTION AS THE DROP. If the drop fails the stamp rolls
    -- back with it; if the stamp fails nothing is dropped. The one ordering that cannot happen is
    -- rows gone with no record of where they went.
    RETURN QUERY
    UPDATE public.telemetry_archive_manifest m
       SET dropped_at = now()
      FROM timescaledb_information.chunks c
     WHERE c.hypertable_name = 'telemetry'
       AND c.chunk_schema::text = m.chunk_schema
       AND c.chunk_name::text   = m.chunk_name
       AND c.range_end <= v_boundary
       AND m.verified_at IS NOT NULL
       AND m.dropped_at IS NULL
    RETURNING m.chunk_name, m.object_key;

    PERFORM public.drop_chunks('public.telemetry', older_than => v_boundary);
END $fn$;

COMMENT ON FUNCTION public.cold_tier_drop_verified() IS
  'Drops the longest oldest-first run of chunks whose export is verified, and stamps their manifest '
  'rows in the same transaction. SECURITY DEFINER because ingest_writer has DELETE and TRUNCATE '
  'revoked on telemetry deliberately -- the exporter may ask for this and cannot delete otherwise.';

-- The exporter is the only intended caller and it holds no privilege of its own here.
REVOKE ALL ON FUNCTION public.cold_tier_drop_verified() FROM PUBLIC;


-- ---------------------------------------------------------------------------------------------
-- 4. Self-check
-- ---------------------------------------------------------------------------------------------
-- THE INVARIANT IS EXERCISED, NOT TRUSTED. It is one CHECK constraint standing between a bug and
-- permanently deleted plant history, so it is worth three writes on every boot to know it is
-- actually there -- a constraint dropped by a hand-edited database looks exactly like one that
-- was never added.
--
-- Rolled back: this table is small and real, and a self-check that left rows behind would put
-- fictional chunk names in an operator's catalogue.
DO $selfcheck$
DECLARE
    v_refused boolean;
BEGIN
    BEGIN
        -- (a) dropped without verified is refused
        v_refused := false;
        BEGIN
            INSERT INTO public.telemetry_archive_manifest
                (chunk_schema, chunk_name, range_start, range_end, row_count, dropped_at)
            VALUES ('_selfcheck', '_a', now() - interval '2 days', now() - interval '1 day', 1, now());
        EXCEPTION WHEN check_violation THEN
            v_refused := true;
        END;
        IF NOT v_refused THEN
            RAISE EXCEPTION
              'cold_archive self-check: a chunk was recordable as DROPPED without being VERIFIED. '
              'That constraint is the only thing standing between an export bug and permanently '
              'deleted telemetry.';
        END IF;

        -- (b) verified without exported is refused
        v_refused := false;
        BEGIN
            INSERT INTO public.telemetry_archive_manifest
                (chunk_schema, chunk_name, range_start, range_end, row_count, verified_at)
            VALUES ('_selfcheck', '_b', now() - interval '2 days', now() - interval '1 day', 1, now());
        EXCEPTION WHEN check_violation THEN
            v_refused := true;
        END;
        IF NOT v_refused THEN
            RAISE EXCEPTION
              'cold_archive self-check: a chunk was recordable as VERIFIED without being EXPORTED.';
        END IF;

        -- (c) and the whole ordered sequence is accepted, so the constraints are not simply
        --     refusing everything -- a guard that admits nothing is as broken as one that admits
        --     anything, and it would stop archival dead rather than loudly.
        INSERT INTO public.telemetry_archive_manifest
            (chunk_schema, chunk_name, range_start, range_end, row_count,
             object_key, object_bytes, exported_at, verified_at, dropped_at)
        VALUES ('_selfcheck', '_c', now() - interval '2 days', now() - interval '1 day', 1,
                'selfcheck/_c.parquet', 1, now(), now(), now());

        RAISE EXCEPTION 'rollback_selfcheck';
    EXCEPTION
        WHEN raise_exception THEN
            IF SQLERRM <> 'rollback_selfcheck' THEN RAISE; END IF;
    END;

    RAISE NOTICE
      'cold_archive self-check passed: dropped requires verified, verified requires exported, and '
      'a correctly ordered row is accepted. Probe rolled back.';
END;
$selfcheck$;
