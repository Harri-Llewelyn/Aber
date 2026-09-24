-- =============================================================================================
-- Storage footprint: what the historian is spending disk on, and how far back it goes.
--
-- Applied on every boot by the chart's maintenance hook Job.
-- Runs after aggregates.sql (it reports on the rollups) and before roles.sql (which grants on the
-- view); run first, the view creates successfully and fails in a dashboard panel instead.
--
-- A view rather than a Grafana query: `hypertable_detailed_size()` takes one hypertable and a
-- continuous aggregate must be resolved to its materialisation hypertable first;
-- `hypertable_compression_stats()` raises on a hypertable with no compression policy, which is a
-- supported configuration; and postgres_fdw maps relations, not function calls.
--
-- It reports bytes and horizons, never readings, which is what makes it safe to expose to a
-- dashboard role that may not read the historian's contents.
-- =============================================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------------------------
-- 1. The collector
-- ---------------------------------------------------------------------------------------------
-- SECURITY DEFINER, so neither reader role has to be widened to the hypertables; it returns only
-- aggregate byte counts. STABLE: it reads catalogs and writes nothing.
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
    -- Two scalars rather than a second `record`: a RECORD variable cannot be reset with `:= NULL`, so
    -- an exception handler would leave the previous hypertable's figures in place.
    v_before bigint;
    v_after  bigint;
    v_toast  bigint;
BEGIN
    -- -----------------------------------------------------------------------------------------
    -- Hypertables: raw telemetry, and each rollup through its materialisation hypertable, resolved
    -- through timescaledb_information.continuous_aggregates rather than by guessing the name.
    -- -----------------------------------------------------------------------------------------
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

        -- Compression: the call that raises on an uncompressed hypertable. Both columns stay NULL when
        -- there is no policy; "not compressed" and "compressed to zero bytes" must not render the same.
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

        -- The lifecycle half: `range_start` / `range_end` are chunk boundaries in the catalog, a
        -- metadata read, where `min(time)` would scan the hypertable. It reports the span the chunks
        -- cover, a slight overstatement of the span the data covers.
        SELECT count(*)::bigint, min(ch.range_start), max(ch.range_end)
          INTO chunks, oldest_data, newest_data
          FROM timescaledb_information.chunks ch
         WHERE format('%I.%I', ch.hypertable_schema, ch.hypertable_name)::regclass = spec.target;

        RETURN NEXT;
    END LOOP;

    -- -----------------------------------------------------------------------------------------
    -- Plain tables, enumerated by catalog rather than named, so a table added later appears here
    -- without anyone remembering: a size report that misses a table is wrong, where roles.sql's
    -- allow-list is the opposite choice for the opposite reason.
    -- -----------------------------------------------------------------------------------------
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
        -- Split to match hypertable_detailed_size()'s semantics: `pg_table_size()` includes TOAST and
        -- `table_bytes` does not, so subtracting TOAST out makes the two tiers add up the same way.
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

-- PostgreSQL grants EXECUTE to PUBLIC on creation, which let every role that can connect call a
-- SECURITY DEFINER function, powerbi_reader included. Revoked on every boot; roles.sql grants it
-- to the roles that read the footprint.
REVOKE ALL ON FUNCTION public.storage_footprint_rows() FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- 2. The relation postgres_fdw maps and Grafana queries
-- ---------------------------------------------------------------------------------------------
-- `collected_at` is stamped here so a panel can tell a stalled maintenance job from a cached
-- foreign scan.
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
  'postgres_fdw as timescale.storage_footprint (archived migration 0027).';

-- ---------------------------------------------------------------------------------------------
-- 3. Self-check
-- ---------------------------------------------------------------------------------------------
-- The view resolves lazily, so selecting from it once here finds a broken column reference now
-- rather than in a panel.
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
