-- Cold telemetry archival: the manifest, and the invariant that makes dropping a chunk safe. A chunk
-- is exported to object storage, read back and verified, recorded, and only then dropped; one CHECK,
-- `dropped_at IS NULL OR verified_at IS NOT NULL`, enforces the order. It cannot stop drop_chunks()
-- being called, only the lie being recorded, which is why cold_tier_droppable() and
-- cold_tier_drop_verified() exist. Reconciled on every boot, idempotent; the dashboard reads the
-- manifest over postgres_fdw. Reasoning: timescaledb/README.md.
\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS public.telemetry_archive_manifest (
    -- Keyed by the chunk, the unit that is exported and dropped; 'have we done this one' is a
    -- primary-key lookup.
    chunk_schema    text        NOT NULL,
    chunk_name      text        NOT NULL,

    -- Copied at claim time: once the chunk is dropped, the catalog forgets its range.
    range_start     timestamptz NOT NULL,
    range_end       timestamptz NOT NULL,

    -- Counted before export and re-checked after; it is what verified_at means.
    row_count       bigint      NOT NULL,

    object_key      text,
    object_bytes    bigint,
    -- Recorded, not interpreted.
    object_etag     text,
    format          text        NOT NULL DEFAULT 'parquet',

    claimed_at      timestamptz NOT NULL DEFAULT now(),
    exported_at     timestamptz,
    verified_at     timestamptz,
    dropped_at      timestamptz,
    -- Set on failure, cleared on success. A row sitting with an error is what an operator needs to see.
    last_error      text,

    CONSTRAINT telemetry_archive_manifest_pkey PRIMARY KEY (chunk_schema, chunk_name),

    -- The invariant.
    CONSTRAINT telemetry_archive_manifest_dropped_implies_verified
        CHECK (dropped_at IS NULL OR verified_at IS NOT NULL),

    -- And verification cannot precede the export it verifies.
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

-- The dashboard's question: what is on cold storage, newest first.
CREATE INDEX IF NOT EXISTS telemetry_archive_manifest_range_idx
    ON public.telemetry_archive_manifest (range_start DESC);

-- The exporter's: what is outstanding.
CREATE INDEX IF NOT EXISTS telemetry_archive_manifest_pending_idx
    ON public.telemetry_archive_manifest (claimed_at)
    WHERE dropped_at IS NULL;

-- Fully elapsed chunks only (range_end), since Sparkplug data arrives late. Claimed chunks are
-- excluded, failed ones included: a retry is an operator clearing last_error.
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

-- The exporter selects through this, so the rule lives beside the data it protects.
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

-- SECURITY DEFINER: ingest_writer has DELETE revoked on telemetry, and this is the one exception,
-- whose body is the rule. Drops a verified oldest-first PREFIX: drop_chunks(older_than) is a
-- boundary, so one call per verified chunk would delete never-exported chunks before it.
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

    -- Stamped inside the same transaction as the drop: if either fails, neither happens.
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

REVOKE ALL ON FUNCTION public.cold_tier_drop_verified() FROM PUBLIC;

-- The invariant is exercised, not trusted: a constraint dropped by hand looks like one never added.
-- Rolled back.
DO $selfcheck$
DECLARE
    v_refused boolean;
BEGIN
    BEGIN
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

        INSERT INTO public.telemetry_archive_manifest
            (chunk_schema, chunk_name, range_start, range_end, row_count,
             object_key, object_bytes, exported_at, verified_at, dropped_at)
        -- (c) the correctly ordered row is accepted: a guard that admits nothing is as broken as one that
        -- admits anything.
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
