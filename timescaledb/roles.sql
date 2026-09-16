-- =============================================================================================
-- Database roles on the historian.
--
-- Applied on every boot by the chart's maintenance hook Job,
-- after aggregates.sql and storage.sql, because it grants on objects those files create. An
-- empty `-v bi_reader_password` skips the role rather than creating one with a blank password.
--
-- Not a Supabase migration: `public.telemetry` over there is a postgres_fdw projection, and a
-- GRANT issued there grants nothing on these views.
--
-- `powerbi_reader` may read the three rollups and nothing else: not raw `telemetry`, not
-- `telemetry_latest`, not `assets`. A continuous aggregate is a view executed with its owner's
-- privileges, so the reader needs no privilege on `telemetry` even with real-time aggregation on.
-- `test_bi_reader_grants.py` asserts both halves. The role attributes are stated explicitly.
-- =============================================================================================

\set ON_ERROR_STOP on

SELECT set_config('acs_cymru.bi_reader_password', :'bi_reader_password', false);

-- The two least-privilege historian roles. DEFAULTED TO EMPTY so this file still runs against a
-- caller that has not been taught to pass them -- the Helm maintenance Job and any operator running
-- it by hand -- and each role then skips itself rather than being created with a blank password.
\if :{?ingest_writer_password}
\else
  \set ingest_writer_password ''
\endif
\if :{?fdw_reader_password}
\else
  \set fdw_reader_password ''
\endif
SELECT set_config('acs_cymru.ingest_writer_password', :'ingest_writer_password', false);
SELECT set_config('acs_cymru.fdw_reader_password', :'fdw_reader_password', false);

DO $$
DECLARE
  v_password text := btrim(coalesce(current_setting('acs_cymru.bi_reader_password', true), ''));
  v_role     CONSTANT text := 'powerbi_reader';
  v_dbname   CONSTANT text := current_database();
BEGIN
  IF v_password = '' THEN
    RAISE NOTICE
      'roles: % not configured (bi_reader_password is empty); skipping. Set BI_READER_PASSWORD '
      'to enable read-only BI access to the telemetry rollups.', v_role;
    RETURN;
  END IF;

  -- CREATE then ALTER rather than DROP then CREATE: dropping a role fails while any session is
  -- connected as it. ALTER also rotates the password on every boot.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
    EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', v_role);
    RAISE NOTICE 'roles: created %', v_role;
  END IF;

  EXECUTE format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT '
                 'PASSWORD %L', v_role, v_password);

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', v_dbname, v_role);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', v_role);

  -- The allow-list. Named one at a time rather than `GRANT SELECT ON ALL TABLES IN SCHEMA public`,
  -- which would sweep in `telemetry`, `assets` and every future table the moment it is created.
  EXECUTE format('GRANT SELECT ON public.telemetry_1m TO %I', v_role);
  EXECUTE format('GRANT SELECT ON public.telemetry_5m TO %I', v_role);
  EXECUTE format('GRANT SELECT ON public.telemetry_1h TO %I', v_role);

  -- REVOKED EXPLICITLY, not merely left ungranted. These are the objects a well-meaning
  -- `GRANT ... ON ALL TABLES` would have caught, and re-revoking on every boot is what makes this
  -- file the authority on the role's reach rather than a description of how it was first set up.
  EXECUTE format('REVOKE ALL ON public.telemetry FROM %I', v_role);
  EXECUTE format('REVOKE ALL ON public.assets FROM %I', v_role);
  EXECUTE format('REVOKE ALL ON public.telemetry_latest FROM %I', v_role);

  -- Future tables must not become readable by default either. This governs objects created by
  -- the role running this file, which is the same role that runs aggregates.sql.
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', v_role);

  RAISE NOTICE
    'roles: % may SELECT telemetry_1m/5m/1h and nothing else (raw telemetry, assets and '
    'telemetry_latest explicitly revoked).', v_role;
END $$;

-- ---------------------------------------------------------------------------------------------
-- grafana_reader -- the internal engineering read surface
-- ---------------------------------------------------------------------------------------------
-- A second role rather than a wider `powerbi_reader`: Power BI is an external business tool that
-- should see aggregated buckets only, and Grafana is an internal console whose job is the raw
-- signal. A datasource health check passes on connect and says nothing about whether a panel can
-- run. Still read-only.
DO $$
DECLARE
  v_password text := btrim(coalesce(current_setting('acs_cymru.bi_reader_password', true), ''));
  v_role     CONSTANT text := 'grafana_reader';
  v_dbname   CONSTANT text := current_database();
BEGIN
  IF v_password = '' THEN
    RAISE NOTICE 'roles: % not configured (no password); skipping.', v_role;
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
    EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', v_role);
    RAISE NOTICE 'roles: created %', v_role;
  END IF;

  EXECUTE format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT '
                 'PASSWORD %L', v_role, v_password);

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', v_dbname, v_role);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', v_role);

  -- The rollups, plus what an engineering dashboard genuinely reads.
  EXECUTE format('GRANT SELECT ON public.telemetry_1m, public.telemetry_5m, public.telemetry_1h '
                 'TO %I', v_role);
  EXECUTE format('GRANT SELECT ON public.telemetry TO %I', v_role);
  EXECUTE format('GRANT SELECT ON public.telemetry_latest TO %I', v_role);
  EXECUTE format('GRANT SELECT ON public.assets TO %I', v_role);

  -- The cold archive catalogue, read only: every FDW session from the platform database opens as
  -- this role, so without it `cold_storage_rows()` fails inside a dashboard panel. Guarded on the
  -- table existing because a first boot applies cold_archive.sql after this file.
  IF to_regclass('public.telemetry_archive_manifest') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT ON public.telemetry_archive_manifest TO %I', v_role);
  END IF;

  -- telemetry_gapfill() is how a report-by-exception series MUST be read -- a missing bucket means
  -- unchanged, not unknown, so charting a rollup directly renders steady operation as a hole.
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION public.telemetry_gapfill(timestamptz, timestamptz, interval, '
    'text[], text[]) TO %I', v_role);

  -- pg_monitor for the historian I/O panels. A read-only membership: it grants visibility into
  -- pg_stat_* and nothing else.
  EXECUTE format('GRANT pg_monitor TO %I', v_role);

  -- The storage footprint, created by storage.sql (which runs before this file). Bytes and chunk
  -- time-spans only: storage_footprint_rows() is SECURITY DEFINER so this grant need not widen to
  -- the hypertables. Not granted to powerbi_reader: the size of the telemetry is an operations
  -- question.
  EXECUTE format('GRANT SELECT ON public.storage_footprint TO %I', v_role);

  -- And EXECUTE on the function behind it, which SELECT on the view does not imply: a function
  -- called in a view body is checked against the calling role.
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.storage_footprint_rows() TO %I', v_role);

  RAISE NOTICE
    'roles: % may read the rollups, raw telemetry, telemetry_latest, assets, telemetry_gapfill() '
    'and pg_stat_* -- read-only throughout.', v_role;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------------------------
-- A grant that silently did not apply is indistinguishable from one that did until a BI tool
-- connects days later.
DO $$
DECLARE
  v_role CONSTANT text := 'powerbi_reader';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
    RETURN;  -- not configured; the skip above already said so
  END IF;

  IF NOT has_table_privilege(v_role, 'public.telemetry_1h', 'SELECT') THEN
    RAISE EXCEPTION 'roles self-check: % cannot SELECT telemetry_1h', v_role;
  END IF;

  IF has_table_privilege(v_role, 'public.telemetry', 'SELECT') THEN
    RAISE EXCEPTION
      'roles self-check: % can SELECT raw telemetry, which it must not', v_role;
  END IF;

  IF has_table_privilege(v_role, 'public.telemetry_latest', 'SELECT') THEN
    RAISE EXCEPTION
      'roles self-check: % can SELECT telemetry_latest, which it must not', v_role;
  END IF;

  RAISE NOTICE 'roles self-check passed: % reads the rollups and cannot reach raw telemetry.',
    v_role;

  -- The other direction, for the internal role: it must be able to read what the shipped dashboard
  -- queries. Asserted because "Database Connection OK" is a CONNECT test and says nothing about
  -- whether a panel can run -- which is how four broken panels went unnoticed.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
    IF NOT (has_table_privilege('grafana_reader', 'public.telemetry', 'SELECT')
        AND has_table_privilege('grafana_reader', 'public.telemetry_latest', 'SELECT')
        AND has_table_privilege('grafana_reader', 'public.assets', 'SELECT')
        AND has_table_privilege('grafana_reader', 'public.telemetry_1h', 'SELECT')) THEN
      RAISE EXCEPTION
        'roles self-check: grafana_reader cannot read one of telemetry / telemetry_latest / '
        'assets / telemetry_1h, so the provisioned dashboard has panels that will fail';
    END IF;

    -- Separate from the block above so the message names the cause: storage.sql did not run, or ran
    -- after this file.
    IF to_regclass('public.storage_footprint') IS NULL THEN
      RAISE EXCEPTION
        'roles self-check: public.storage_footprint does not exist. storage.sql must run BEFORE '
        'roles.sql -- check the ordering in the Helm maintenance Job.';
    END IF;

    IF NOT has_table_privilege('grafana_reader', 'public.storage_footprint', 'SELECT') THEN
      RAISE EXCEPTION
        'roles self-check: grafana_reader cannot read storage_footprint, so the data-lifecycle '
        'panels will fail';
    END IF;
    RAISE NOTICE 'roles self-check passed: grafana_reader can read every object the dashboard queries.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- ingest_writer -- the ingestion daemon, the process most exposed to the plant network
-- ---------------------------------------------------------------------------------------------
-- The grant list is measured, not reasoned: every line was determined by running the daemon's
-- two statements as a probe role and removing privileges until they broke.
--
--   assets      INSERT, UPDATE, SELECT
--   telemetry   INSERT, SELECT
--
-- SELECT is required: both statements carry ON CONFLICT, and inferring the arbiter index needs
-- SELECT on the target. So the role is append-only, not write-only: it can add rows and cannot
-- change or remove one, which the self-check asserts in both directions. The hypertable grant
-- reaches the chunks (verified by a probe insert failing a foreign key named on a chunk). It
-- deliberately cannot reach the rollups.

DO $$
DECLARE
  v_password text := btrim(coalesce(current_setting('acs_cymru.ingest_writer_password', true), ''));
  v_role     CONSTANT text := 'ingest_writer';
  v_dbname   CONSTANT text := current_database();
BEGIN
  -- Required, unlike the two readers above: the daemon must connect as something, and the only
  -- alternative is the superuser this role replaces.
  IF v_password = '' THEN
    RAISE EXCEPTION
      'roles: ingest_writer_password is empty. The ingestion daemon connects to the historian as '
      'this role, and without it the only credential available is the superuser -- which can DROP '
      'the hypertable and rewrite any observation. Set INGEST_WRITER_PASSWORD (npm run setup mints '
      'one) and re-run.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
    EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', v_role);
    RAISE NOTICE 'roles: created %', v_role;
  END IF;

  EXECUTE format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT '
                 'PASSWORD %L', v_role, v_password);

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', v_dbname, v_role);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', v_role);

  EXECUTE format('GRANT INSERT, UPDATE, SELECT ON public.assets TO %I', v_role);
  EXECUTE format('GRANT INSERT, SELECT ON public.telemetry TO %I', v_role);

  -- Cold archival: the exporter runs as this role and writes the manifest, so it needs INSERT and
  -- UPDATE there, and still no DELETE on the manifest and nothing on telemetry beyond INSERT.
  -- Dropping an archived chunk goes through cold_tier_drop_verified(), which is SECURITY DEFINER so
  -- the daemon can ask for a drop the manifest has verified without holding DELETE. Guarded on the
  -- table existing because a first boot orders the two files the other way round.
  IF to_regclass('public.telemetry_archive_manifest') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.telemetry_archive_manifest TO %I', v_role);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON public.telemetry_archive_manifest FROM %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.cold_tier_candidates(interval) TO %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.cold_tier_droppable() TO %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.cold_tier_drop_verified() TO %I', v_role);
  END IF;

  -- REVOKED EXPLICITLY rather than left ungranted, for the same reason the readers above do it:
  -- this file is the authority on the role's reach, not a description of how it was first set up.
  -- DELETE and TRUNCATE are the two that make "append-only" true, so they are named.
  EXECUTE format('REVOKE DELETE, TRUNCATE ON public.telemetry FROM %I', v_role);
  EXECUTE format('REVOKE UPDATE ON public.telemetry FROM %I', v_role);
  EXECUTE format('REVOKE DELETE, TRUNCATE ON public.assets FROM %I', v_role);
  -- The rollups: derived data this writer has no business reading, revoked by name.
  EXECUTE format('REVOKE ALL ON public.telemetry_1m FROM %I', v_role);
  EXECUTE format('REVOKE ALL ON public.telemetry_5m FROM %I', v_role);
  EXECUTE format('REVOKE ALL ON public.telemetry_1h FROM %I', v_role);

  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', v_role);

  RAISE NOTICE
    'roles: % may INSERT into telemetry and upsert assets, and cannot UPDATE, DELETE or TRUNCATE '
    'either.', v_role;
END $$;

-- ---------------------------------------------------------------------------------------------
-- fdw_reader -- what Supabase's foreign tables connect as
-- ---------------------------------------------------------------------------------------------
-- Read-only, and only the projection (telemetry, telemetry_latest, the three rollups,
-- telemetry_horizons and storage_footprint). Nothing on the Supabase side writes through the FDW, so INSERT would be a
-- grant with no caller. Without this role the public user mapping runs as the historian
-- superuser, so a widened local grant or a new foreign table would inherit superuser reach.

DO $$
DECLARE
  v_password text := btrim(coalesce(current_setting('acs_cymru.fdw_reader_password', true), ''));
  v_role     CONSTANT text := 'fdw_reader';
  v_dbname   CONSTANT text := current_database();
BEGIN
  -- Required for the same reason: Supabase's FDW mapping authenticates as SOMETHING on every
  -- query, and the alternative is the superuser.
  IF v_password = '' THEN
    RAISE EXCEPTION
      'roles: fdw_reader_password is empty. Supabase''s postgres_fdw user mapping authenticates as '
      'this role; without it every dashboard query reaches this database with superuser rights. '
      'Set FDW_READER_PASSWORD (npm run setup mints one) and re-run.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
    EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', v_role);
    RAISE NOTICE 'roles: created %', v_role;
  END IF;

  EXECUTE format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT '
                 'PASSWORD %L', v_role, v_password);

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', v_dbname, v_role);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', v_role);

  EXECUTE format('GRANT SELECT ON public.telemetry TO %I', v_role);
  EXECUTE format('GRANT SELECT ON public.telemetry_latest TO %I', v_role);
  EXECUTE format('GRANT SELECT ON public.telemetry_1m TO %I', v_role);
  EXECUTE format('GRANT SELECT ON public.telemetry_5m TO %I', v_role);
  EXECUTE format('GRANT SELECT ON public.telemetry_1h TO %I', v_role);
  -- How far back each resolution reaches (migration 0111). Guarded on the view existing because a
  -- first boot applies aggregates.sql after this file, as the archive manifest is.
  --
  -- WITHOUT THIS GRANT THE FAILURE IS SILENT AT THE DASHBOARD. The Supabase-side view is
  -- security_invoker, so the remote query runs as this role; the export dialog swallows a failed
  -- horizons lookup and labels every resolution "reach unknown", which is indistinguishable from a
  -- stack that has not answered yet. Found in a browser, not by a test.
  IF to_regclass('public.telemetry_horizons') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT ON public.telemetry_horizons TO %I', v_role);
  END IF;
  IF to_regclass('public.storage_footprint') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT ON public.storage_footprint TO %I', v_role);
  END IF;

  -- No writes, stated rather than implied.
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.telemetry FROM %I', v_role);
  EXECUTE format('REVOKE ALL ON public.assets FROM %I', v_role);

  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', v_role);

  RAISE NOTICE
    'roles: % may SELECT the seven objects Supabase projects and cannot write any of them.', v_role;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Self-check: both directions, for both roles
-- ---------------------------------------------------------------------------------------------
-- "ingest_writer can insert" passes on a role that is secretly superuser; "ingest_writer cannot
-- delete" passes on a role that cannot do anything at all.
DO $$
BEGIN
  -- No `IF EXISTS` guard: both roles are required above, so absence is already an error.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ingest_writer') THEN
    IF NOT (has_table_privilege('ingest_writer', 'public.telemetry', 'INSERT')
        AND has_table_privilege('ingest_writer', 'public.telemetry', 'SELECT')
        AND has_table_privilege('ingest_writer', 'public.assets', 'INSERT')
        AND has_table_privilege('ingest_writer', 'public.assets', 'UPDATE')
        AND has_table_privilege('ingest_writer', 'public.assets', 'SELECT')) THEN
      RAISE EXCEPTION
        'roles self-check: ingest_writer is missing a privilege its two statements need. SELECT is '
        'required on both tables because each INSERT carries an ON CONFLICT clause, and inferring '
        'the arbiter index reads the target. Without it the daemon stops writing telemetry.';
    END IF;

    IF has_table_privilege('ingest_writer', 'public.telemetry', 'UPDATE')
       OR has_table_privilege('ingest_writer', 'public.telemetry', 'DELETE')
       OR has_table_privilege('ingest_writer', 'public.telemetry', 'TRUNCATE') THEN
      RAISE EXCEPTION
        'roles self-check: ingest_writer can change or remove telemetry. "Append-only historian '
        'writes" is a claim the README makes in its security model, and this role is what makes it '
        'a database fact rather than a property of the Python.';
    END IF;

    IF (SELECT rolsuper FROM pg_roles WHERE rolname = 'ingest_writer') THEN
      RAISE EXCEPTION 'roles self-check: ingest_writer is a superuser, which defeats the entire role.';
    END IF;

    RAISE NOTICE
      'roles self-check passed: ingest_writer can append telemetry and cannot rewrite or delete it.';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fdw_reader') THEN
    IF NOT has_table_privilege('fdw_reader', 'public.telemetry', 'SELECT') THEN
      RAISE EXCEPTION
        'roles self-check: fdw_reader cannot read telemetry, so every dashboard query through the '
        'foreign table returns permission denied.';
    END IF;
    IF has_table_privilege('fdw_reader', 'public.telemetry', 'INSERT')
       OR has_table_privilege('fdw_reader', 'public.telemetry', 'UPDATE')
       OR has_table_privilege('fdw_reader', 'public.telemetry', 'DELETE') THEN
      RAISE EXCEPTION
        'roles self-check: fdw_reader can write telemetry. It exists so that a Supabase-side FDW '
        'session is a READER on this database; a writable mapping is the superuser problem again '
        'with a different name.';
    END IF;
    IF (SELECT rolsuper FROM pg_roles WHERE rolname = 'fdw_reader') THEN
      RAISE EXCEPTION 'roles self-check: fdw_reader is a superuser, which defeats the entire role.';
    END IF;

    -- Asserted because its absence is SILENT at the dashboard rather than loud: the export
    -- dialog's horizons lookup fails closed and labels every resolution "reach unknown", which
    -- reads exactly like a stack that has not answered yet. Guarded on the view existing, as the
    -- grant above is, because a first boot applies aggregates.sql after this file.
    IF to_regclass('public.telemetry_horizons') IS NOT NULL
       AND NOT has_table_privilege('fdw_reader', 'public.telemetry_horizons', 'SELECT') THEN
      RAISE EXCEPTION
        'roles self-check: fdw_reader cannot read telemetry_horizons, so the telemetry export '
        'dialog cannot tell which resolutions still cover a range -- and it fails quietly, '
        'reporting every resolution as "reach unknown".';
    END IF;

    RAISE NOTICE 'roles self-check passed: fdw_reader reads the projection and writes nothing.';
  END IF;
END $$;
