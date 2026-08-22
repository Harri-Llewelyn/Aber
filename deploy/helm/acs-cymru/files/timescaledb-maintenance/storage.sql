-- =============================================================================================
-- Storage footprint -- what the historian is actually spending disk on, and how far back it goes.
--
-- Applied on EVERY boot by the `timescaledb-maintenance` service (Compose) and the
-- `timescaledb-maintenance` hook Job (Helm), alongside retention.sql, aggregates.sql and
-- roles.sql. It takes no psql variables.
--
-- ORDERING IS LOAD-BEARING: this runs AFTER aggregates.sql, because the rollups it reports on are
-- created there, and BEFORE roles.sql, which grants `grafana_reader` SELECT on the view below.
-- Run it first and it creates a view over hypertables that do not exist yet -- which SUCCEEDS,
-- because a view body is not resolved until it is queried, and then fails in a dashboard panel
-- instead of here.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THIS IS A VIEW AND NOT A GRAFANA QUERY.
--
-- The obvious version of this feature is a panel with `SELECT hypertable_detailed_size(...)` typed
-- into it. Three things make that the wrong place:
--
--   * `hypertable_detailed_size()` takes ONE hypertable. Reporting raw and three rollups means
--     four calls unioned together, and a continuous aggregate is not addressable by that function
--     directly -- you have to resolve its MATERIALIZATION hypertable through
--     timescaledb_information first. That is real logic, and logic in a dashboard JSON blob is
--     logic nothing tests and nobody finds.
--
--   * `hypertable_compression_stats()` RAISES on a hypertable with no compression policy. A panel
--     that queries it directly goes red on any stack running `TIMESCALE_COMPRESS_AFTER=never` --
--     a supported configuration -- and reads as a broken dashboard rather than a chosen setting.
--
--   * Supabase has to read the same numbers over postgres_fdw, and postgres_fdw maps RELATIONS.
--     It cannot map a set-returning function call. Something relation-shaped has to exist here
--     regardless, so it may as well be the only definition.
--
-- ---------------------------------------------------------------------------------------------
-- IT REPORTS BYTES AND HORIZONS, NEVER READINGS. Every column below is metadata about storage:
-- sizes, chunk counts, and the time range the chunks span. No observation, asset id or metric name
-- crosses this boundary, which is what makes it safe to expose to a dashboard role that is
-- deliberately not allowed to read the historian's contents.
-- =============================================================================================

\set ON_ERROR_STOP on


-- ---------------------------------------------------------------------------------------------
-- 1. The collector
-- ---------------------------------------------------------------------------------------------
-- SECURITY DEFINER, and the justification is narrow. `grafana_reader` is deliberately not a member
-- of anything that could enumerate chunk internals, and `powerbi_reader` is narrower still. Rather
-- than widen either role -- which would grant reach over the hypertables themselves -- the function
-- runs as its owner and returns only the aggregate byte counts. The widest thing a caller can
-- learn from it is how large the telemetry is, which is what they came to ask.
--
-- STABLE, not VOLATILE: it reads catalogs and writes nothing, so a planner may call it once per
-- query rather than once per row.
CREATE OR REPLACE FUNCTION public.storage_footprint_rows()
RETURNS TABLE (
    tier               text,
    relation           text,
    chunks             bigint,
    table_bytes        bigint,
    index_bytes        bigint,
    toast_bytes        bigint,
    total_bytes        bigint,
    uncompressed_bytes bigint,
    compressed_bytes   bigint,
    oldest_data        timestamptz,
    newest_data        timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
DECLARE
    spec     record;
    v_size   record;
    -- Two scalars rather than a second `record`. A RECORD variable cannot be reset with a plain
    -- `:= NULL` -- PL/pgSQL raises rather than clearing it -- so an exception handler that meant
    -- to discard a failed read would leave the PREVIOUS hypertable's compression figures in place
    -- and attribute them to this one.
    v_before bigint;
    v_after  bigint;
    v_toast  bigint;
BEGIN
    -- -----------------------------------------------------------------------------------------
    -- Hypertables: raw telemetry, and each rollup through its materialisation hypertable.
    -- -----------------------------------------------------------------------------------------
    -- A continuous aggregate is a VIEW over a hidden hypertable in `_timescaledb_internal`, and
    -- that hidden table is where its bytes live. Resolving it through
    -- timescaledb_information.continuous_aggregates rather than guessing the name is what keeps
    -- this working across TimescaleDB upgrades, which have renamed that schema before.
    FOR spec IN
        SELECT
            'raw'::text                       AS tier,
            'telemetry'::text                 AS label,
            format('%I.%I', h.hypertable_schema, h.hypertable_name)::regclass AS target
          FROM timescaledb_information.hypertables h
         WHERE h.hypertable_schema = 'public'
           AND h.hypertable_name   = 'telemetry'

        UNION ALL

        SELECT
            'rollup'::text,
            c.view_name::text,
            format('%I.%I', c.materialization_hypertable_schema,
                            c.materialization_hypertable_name)::regclass
          FROM timescaledb_information.continuous_aggregates c
         WHERE c.view_schema = 'public'
    LOOP
        -- Sizes. Wrapped because a hypertable can be dropped between the catalog read above and
        -- this call -- unlikely, but the failure mode is a dashboard panel erroring rather than
        -- one row being absent, and the second is plainly better.
        BEGIN
            SELECT s.table_bytes, s.index_bytes, s.toast_bytes, s.total_bytes
              INTO v_size
              FROM hypertable_detailed_size(spec.target) s;
        EXCEPTION WHEN others THEN
            CONTINUE;
        END;

        -- Compression. THIS IS THE CALL THAT RAISES on an uncompressed hypertable, which is why
        -- the whole feature is not simply a query in a panel. Both columns stay NULL when there is
        -- no compression policy, and NULL is the honest answer: "not compressed" and "compressed
        -- to zero bytes" must not render the same way.
        v_before := NULL;
        v_after  := NULL;
        BEGIN
            SELECT sum(cs.before_compression_total_bytes)::bigint,
                   sum(cs.after_compression_total_bytes)::bigint
              INTO v_before, v_after
              FROM hypertable_compression_stats(spec.target) cs;
        EXCEPTION WHEN others THEN
            v_before := NULL;
            v_after  := NULL;
        END;

        tier               := spec.tier;
        relation           := spec.label;
        table_bytes        := coalesce(v_size.table_bytes, 0);
        index_bytes        := coalesce(v_size.index_bytes, 0);
        toast_bytes        := coalesce(v_size.toast_bytes, 0);
        total_bytes        := coalesce(v_size.total_bytes, 0);
        uncompressed_bytes := v_before;
        compressed_bytes   := v_after;

        -- THE LIFECYCLE HALF, and the cheap way to get it. `range_start` / `range_end` are chunk
        -- BOUNDARIES held in the catalog, so this is a metadata read -- whereas
        -- `SELECT min(time) FROM telemetry` is a scan of the whole hypertable, which is precisely
        -- the query a storage dashboard must not be the reason for.
        --
        -- It therefore reports the SPAN THE CHUNKS COVER, which is a slight overstatement of the
        -- span the data covers: the newest chunk extends past the newest row. That is the right
        -- trade for a retention readout, where the question is how far back the store reaches.
        SELECT count(*)::bigint, min(ch.range_start), max(ch.range_end)
          INTO chunks, oldest_data, newest_data
          FROM timescaledb_information.chunks ch
         WHERE format('%I.%I', ch.hypertable_schema, ch.hypertable_name)::regclass = spec.target;

        RETURN NEXT;
    END LOOP;

    -- -----------------------------------------------------------------------------------------
    -- Plain tables: the historian's own non-hypertable relations.
    -- -----------------------------------------------------------------------------------------
    -- `assets` is the only one today. Enumerated by catalog rather than named, so a table added to
    -- the historian later appears here without anyone remembering to add it -- the opposite choice
    -- from roles.sql's allow-list, and for the opposite reason: a grant that sweeps too wide is a
    -- security hole, while a size report that misses a table is just wrong.
    FOR spec IN
        SELECT c.oid::regclass AS target, c.relname::text AS label
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind = 'r'
           AND NOT EXISTS (
                 SELECT 1 FROM timescaledb_information.hypertables h
                  WHERE h.hypertable_schema = n.nspname
                    AND h.hypertable_name   = c.relname
               )
         ORDER BY c.relname
    LOOP
        -- SPLIT TO MATCH hypertable_detailed_size()'s SEMANTICS, so the two tiers are comparable
        -- in one chart. `pg_table_size()` INCLUDES the TOAST relation and the visibility map;
        -- `hypertable_detailed_size().table_bytes` does not. Subtracting TOAST back out is what
        -- makes a stacked bar of table/index/toast add up to the same total on both sides.
        SELECT coalesce(pg_total_relation_size(c.reltoastrelid), 0)
          INTO v_toast
          FROM pg_class c WHERE c.oid = spec.target;

        tier               := 'metadata';
        relation           := spec.label;
        chunks             := NULL;
        table_bytes        := pg_table_size(spec.target) - v_toast;
        index_bytes        := pg_indexes_size(spec.target);
        toast_bytes        := v_toast;
        total_bytes        := pg_total_relation_size(spec.target);
        uncompressed_bytes := NULL;
        compressed_bytes   := NULL;
        oldest_data        := NULL;
        newest_data        := NULL;
        RETURN NEXT;
    END LOOP;
END;
$fn$;

COMMENT ON FUNCTION public.storage_footprint_rows() IS
  'Byte counts and chunk time-spans for every hypertable, continuous aggregate and plain table in '
  'the historian. SECURITY DEFINER so a dashboard role that may not read telemetry can still be '
  'told how large it is; returns no observation, asset id or metric name.';


-- ---------------------------------------------------------------------------------------------
-- 2. The relation postgres_fdw maps and Grafana queries
-- ---------------------------------------------------------------------------------------------
-- `collected_at` is stamped here rather than by the reader. Over the FDW a stale plan or a cached
-- foreign scan is genuinely hard to tell from a stalled maintenance job, and a panel showing a
-- timestamp that stops advancing says which one it is.
DROP VIEW IF EXISTS public.storage_footprint;
CREATE VIEW public.storage_footprint AS
SELECT
    now() AS collected_at,
    'historian'::text AS source,
    r.tier,
    r.relation,
    r.chunks,
    r.table_bytes,
    r.index_bytes,
    r.toast_bytes,
    r.total_bytes,
    r.uncompressed_bytes,
    r.compressed_bytes,
    r.oldest_data,
    r.newest_data
  FROM public.storage_footprint_rows() r;

COMMENT ON VIEW public.storage_footprint IS
  'One row per stored relation: bytes by kind, chunk count, compression before/after, and the '
  'time span the chunks cover. Read directly by Grafana and mapped into Supabase over '
  'postgres_fdw as timescale.storage_footprint (migration 0027).';


-- ---------------------------------------------------------------------------------------------
-- 3. Self-check
-- ---------------------------------------------------------------------------------------------
-- The view resolves lazily, so creating it proves nothing about whether it runs. Selecting from it
-- once here is the difference between finding a broken column reference now and finding it in a
-- dashboard panel on a stack somebody else is demonstrating.
DO $selfcheck$
DECLARE
    v_rows integer;
    v_raw  integer;
BEGIN
    SELECT count(*) INTO v_rows FROM public.storage_footprint;

    IF v_rows = 0 THEN
        RAISE EXCEPTION
            'storage self-check: public.storage_footprint returned no rows. The historian always '
            'has at least the telemetry hypertable, so an empty result means the catalog queries '
            'match nothing -- most likely a TimescaleDB upgrade renamed an information view.';
    END IF;

    SELECT count(*) INTO v_raw
      FROM public.storage_footprint WHERE tier = 'raw';

    IF v_raw <> 1 THEN
        RAISE EXCEPTION
            'storage self-check: expected exactly one raw-tier row (public.telemetry), found %',
            v_raw;
    END IF;

    RAISE NOTICE 'storage self-check passed: storage_footprint reports % relation(s).', v_rows;
END;
$selfcheck$;
