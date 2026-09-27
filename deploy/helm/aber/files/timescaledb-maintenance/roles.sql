-- Database roles on the historian, applied on every boot after aggregates.sql, storage.sql and
-- cold_archive.sql, since it grants on what they create. Each role's block is the authority on its
-- reach: grants and revokes are re-issued every boot, and each role is CREATEd then ALTERed rather
-- than dropped, because a drop fails while a session is connected and ALTER rotates the password.
-- Variables: bi_reader_password (empty skips powerbi_reader and grafana_reader), ingest_writer_password
-- and fdw_reader_password (required). Not a Supabase migration: public.telemetry there is a
-- postgres_fdw projection, and a GRANT there grants nothing here. Reasoning: timescaledb/README.md.
\set ON_ERROR_STOP on

SELECT set_config('aber.bi_reader_password', :'bi_reader_password', false);

-- Defaulted to empty so a caller that passes neither still runs; each role then skips itself rather
-- than being created with a blank password.
\if :{?ingest_writer_password}
\else
  \set ingest_writer_password ''
\endif
\if :{?fdw_reader_password}
\else
  \set fdw_reader_password ''
\endif
SELECT set_config('aber.ingest_writer_password', :'ingest_writer_password', false);
SELECT set_config('aber.fdw_reader_password', :'fdw_reader_password', false);

DO $$
DECLARE
  v_password text := btrim(coalesce(current_setting('aber.bi_reader_password', true), ''));
  -- powerbi_reader: the three rollups and nothing else. A continuous aggregate runs with its owner's
  -- privileges, so no grant on telemetry is needed even with real-time aggregation on.
  v_role     CONSTANT text := 'powerbi_reader';
  v_dbname   CONSTANT text := current_database();
BEGIN
  IF v_password = '' THEN
    RAISE NOTICE
      'roles: % not configured (bi_reader_password is empty); skipping. Set BI_READER_PASSWORD '
      'to enable read-only BI access to the telemetry rollups.', v_role;
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

  -- Named one at a time: ON ALL TABLES would sweep in telemetry, assets and every future table.
  EXECUTE format('GRANT SELECT ON public.telemetry_1m TO %I', v_role);
  EXECUTE format('GRANT SELECT ON public.telemetry_5m TO %I', v_role);
  EXECUTE format('GRANT SELECT ON public.telemetry_1h TO %I', v_role);

  -- Revoked explicitly rather than left ungranted: re-revoking on every boot makes this file the
  -- authority on the role's reach.
  EXECUTE format('REVOKE ALL ON public.telemetry FROM %I', v_role);
  EXECUTE format('REVOKE ALL ON public.assets FROM %I', v_role);
  EXECUTE format('REVOKE ALL ON public.telemetry_latest FROM %I', v_role);

  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', v_role);

  RAISE NOTICE
    'roles: % may SELECT telemetry_1m/5m/1h and nothing else (raw telemetry, assets and '
    'telemetry_latest explicitly revoked).', v_role;
END $$;

DO $$
DECLARE
  v_password text := btrim(coalesce(current_setting('aber.bi_reader_password', true), ''));
  -- grafana_reader: the rollups plus what an engineering dashboard genuinely reads. A second role
  -- because Power BI is external and sees buckets only; still read-only.
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

  EXECUTE format('GRANT SELECT ON public.telemetry_1m, public.telemetry_5m, public.telemetry_1h '
                 'TO %I', v_role);
  EXECUTE format('GRANT SELECT ON public.telemetry TO %I', v_role);
  EXECUTE format('GRANT SELECT ON public.telemetry_latest TO %I', v_role);
  EXECUTE format('GRANT SELECT ON public.assets TO %I', v_role);

  IF to_regclass('public.telemetry_archive_manifest') IS NOT NULL THEN
    -- The cold archive catalogue: every FDW session from the platform opens as this role. Guarded
    -- because a first boot applies cold_archive.sql after this file.
    EXECUTE format('GRANT SELECT ON public.telemetry_archive_manifest TO %I', v_role);
  END IF;

  -- telemetry_gapfill() is how a report-by-exception series must be read: a missing bucket means
  -- unchanged, not unknown.
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION public.telemetry_gapfill(timestamptz, timestamptz, interval, '
    'text[], text[]) TO %I', v_role);

  -- pg_monitor for the I/O panels, a read-only membership. WITH INHERIT TRUE is load-bearing: this
  -- role is NOINHERIT, PostgreSQL 16 fixes inheritance on the grant at grant time, and ALTER ROLE ...
  -- INHERIT does not revise it. Measured held-but-inert before this said so.
  EXECUTE format('GRANT pg_monitor TO %I WITH INHERIT TRUE', v_role);

  -- The footprint (storage.sql, before this file): bytes only, so no widening. Not for
  -- powerbi_reader: the size of the telemetry is an operations question.
  EXECUTE format('GRANT SELECT ON public.storage_footprint TO %I', v_role);

  -- EXECUTE too: SELECT on the view does not imply it, since a function in a view body is checked
  -- against the caller.
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.storage_footprint_rows() TO %I', v_role);

  RAISE NOTICE
    'roles: % may read the rollups, raw telemetry, telemetry_latest, assets, telemetry_gapfill() '
    'and pg_stat_* -- read-only throughout.', v_role;
END $$;

DO $$
DECLARE
  -- metrics_reader: the postgres_exporter sidecar, and the only role here with NO PASSWORD, which is
  -- its security argument. pg_hba admits the network on scram-sha-256 only, so a passwordless role
  -- authenticates from loopback alone, where the sidecar is; pg_monitor is proportionate because it is
  -- reachable from nowhere else. Takes no variable.
  v_role CONSTANT text := 'metrics_reader';
  v_dbname CONSTANT text := current_database();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
    -- INHERIT, unlike the others; see the pg_monitor grant.
    EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT', v_role);
    RAISE NOTICE 'roles: created %', v_role;
  END IF;

  -- PASSWORD NULL on every boot, not only at creation: a password set by hand would open the network
  -- path.
  EXECUTE format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT '
                 'PASSWORD NULL', v_role);

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', v_dbname, v_role);

  -- WITH INHERIT TRUE for the reason on grafana_reader. Without it the exporter serves no WAL series
  -- and reports no error.
  EXECUTE format('GRANT pg_monitor TO %I WITH INHERIT TRUE', v_role);

  -- Not covered by pg_monitor, which stops at the server's own statistics views; the exporter's
  -- custom queries read this. Guarded because the Job's ordering is asserted below rather than assumed.
  IF to_regclass('public.storage_footprint') IS NOT NULL THEN
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', v_role);
    EXECUTE format('GRANT SELECT ON public.storage_footprint TO %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.storage_footprint_rows() TO %I', v_role);
  END IF;

  RAISE NOTICE
    'roles: % holds pg_monitor and no password, so it reads pg_stat_* from the sidecar on '
    'loopback and cannot authenticate from the network.', v_role;
END $$;

DO $$
DECLARE
  -- Self-check. A grant that silently did not apply is indistinguishable from one that did until a
  -- BI tool connects days later.
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

  IF to_regprocedure('public.storage_footprint_rows()') IS NOT NULL
     AND has_function_privilege(v_role, 'public.storage_footprint_rows()', 'EXECUTE') THEN
    RAISE EXCEPTION
      'roles self-check: % can execute storage_footprint_rows(), which it must not', v_role;
  END IF;

  RAISE NOTICE 'roles self-check passed: % reads the rollups and cannot reach raw telemetry.',
    v_role;

  -- The other direction: grafana_reader must read what the shipped dashboard queries. A CONNECT test
  -- says nothing about whether a panel can run.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
    IF NOT (has_table_privilege('grafana_reader', 'public.telemetry', 'SELECT')
        AND has_table_privilege('grafana_reader', 'public.telemetry_latest', 'SELECT')
        AND has_table_privilege('grafana_reader', 'public.assets', 'SELECT')
        AND has_table_privilege('grafana_reader', 'public.telemetry_1h', 'SELECT')) THEN
      RAISE EXCEPTION
        'roles self-check: grafana_reader cannot read one of telemetry / telemetry_latest / '
        'assets / telemetry_1h, so the provisioned dashboard has panels that will fail';
    END IF;

    -- Separate so the message names the cause: storage.sql did not run, or ran after this file.
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

DO $$
DECLARE
  v_password text := btrim(coalesce(current_setting('aber.ingest_writer_password', true), ''));
  -- ingest_writer: the daemon, the process most exposed to the plant network. The grant list is
  -- measured, not reasoned: each line found by running its two statements as a probe role. SELECT
  -- because both carry ON CONFLICT. Append-only, and never the rollups.
  v_role     CONSTANT text := 'ingest_writer';
  v_dbname   CONSTANT text := current_database();
BEGIN
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

  IF to_regclass('public.telemetry_archive_manifest') IS NOT NULL THEN
    -- Cold archival runs as this role: it writes the manifest and asks cold_tier_drop_verified()
    -- (SECURITY DEFINER) for drops it may not perform itself. Guarded: a first boot creates the manifest
    -- after this file.
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.telemetry_archive_manifest TO %I', v_role);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON public.telemetry_archive_manifest FROM %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.cold_tier_candidates(interval) TO %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.cold_tier_droppable() TO %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.cold_tier_drop_verified() TO %I', v_role);
  END IF;
  -- Reports whether archiving is on, which decides what retention may drop.
  IF to_regprocedure('public.cold_archive_report_armed(boolean)') IS NOT NULL THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.cold_archive_report_armed(boolean) TO %I', v_role);
  END IF;

  -- DELETE and TRUNCATE are what make append-only true, so they are named.
  EXECUTE format('REVOKE DELETE, TRUNCATE ON public.telemetry FROM %I', v_role);
  EXECUTE format('REVOKE UPDATE ON public.telemetry FROM %I', v_role);
  EXECUTE format('REVOKE DELETE, TRUNCATE ON public.assets FROM %I', v_role);
  -- The rollups: derived data this writer has no business reading.
  EXECUTE format('REVOKE ALL ON public.telemetry_1m FROM %I', v_role);
  EXECUTE format('REVOKE ALL ON public.telemetry_5m FROM %I', v_role);
  EXECUTE format('REVOKE ALL ON public.telemetry_1h FROM %I', v_role);

  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', v_role);

  RAISE NOTICE
    'roles: % may INSERT into telemetry and upsert assets, and cannot UPDATE, DELETE or TRUNCATE '
    'either.', v_role;
END $$;

DO $$
DECLARE
  v_password text := btrim(coalesce(current_setting('aber.fdw_reader_password', true), ''));
  -- fdw_reader: what Supabase's foreign tables connect as. Read-only over the projection; without it
  -- the user mapping runs as the superuser.
  v_role     CONSTANT text := 'fdw_reader';
  v_dbname   CONSTANT text := current_database();
BEGIN
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
  -- telemetry_horizons (archived migration 0111), guarded because a first boot applies aggregates.sql
  -- after this file. Without this grant the export dialog labels every resolution 'reach unknown',
  -- silently.
  IF to_regclass('public.telemetry_horizons') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT ON public.telemetry_horizons TO %I', v_role);
  END IF;
  IF to_regclass('public.storage_footprint') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT ON public.storage_footprint TO %I', v_role);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.storage_footprint_rows() TO %I', v_role);
  END IF;

  EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.telemetry FROM %I', v_role);
  EXECUTE format('REVOKE ALL ON public.assets FROM %I', v_role);

  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', v_role);

  RAISE NOTICE
    'roles: % may SELECT the seven objects Supabase projects and cannot write any of them.', v_role;
END $$;

DO $$
BEGIN
  -- Self-check, both directions: 'can insert' passes on a secret superuser, 'cannot delete' on a role
  -- that can do nothing at all.
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

DO $$
DECLARE
  v_role text;
BEGIN
  -- A pg_monitor membership held but not inherited is the one failure nothing downstream reports: the
  -- exporter starts, the scrape succeeds, and the series are absent. Asserted for each role granted it.
  FOREACH v_role IN ARRAY ARRAY['metrics_reader', 'grafana_reader'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role);

    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
        JOIN pg_roles g ON g.oid = m.roleid
        JOIN pg_roles r ON r.oid = m.member
       WHERE g.rolname = 'pg_monitor' AND r.rolname = v_role AND m.inherit_option
    ) THEN
      RAISE EXCEPTION
        'roles self-check: % holds pg_monitor without INHERIT, so the membership does nothing. '
        'PostgreSQL fixes inheritance on the GRANT from the role''s rolinherit at grant time, and '
        'ALTER ROLE ... INHERIT does not revise it -- re-issue the grant WITH INHERIT TRUE.',
        v_role;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_authid WHERE rolname = 'metrics_reader' AND rolpassword IS NOT NULL)
  THEN
    RAISE EXCEPTION
      'roles self-check: metrics_reader has a password, so it can authenticate over the network. '
      'It holds pg_monitor precisely because it was reachable only from loopback.';
  END IF;

  RAISE NOTICE
    'roles self-check passed: every pg_monitor membership is inherited, and metrics_reader has '
    'no password.';
END $$;
