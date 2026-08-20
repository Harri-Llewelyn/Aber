-- =============================================================================================
-- Read-only database roles on the historian.
--
-- Applied on EVERY boot by the `timescaledb-maintenance` service (Compose) and hook Job (Helm),
-- alongside retention.sql and aggregates.sql. It takes one psql variable:
--
--     -v bi_reader_password='...'
--
-- An empty value SKIPS the role entirely rather than creating one with a blank password. An
-- operator who has not configured BI should end up with no role, not with an unauthenticated one.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THIS IS NOT A SUPABASE MIGRATION.
--
-- The rollups live HERE, in the standalone historian. `public.telemetry` in Supabase is a
-- postgres_fdw projection, and the Supabase migration runner never opens a connection to this
-- database -- so a GRANT issued over there grants nothing on these views. It would apply cleanly,
-- report success, and leave the BI tool with no access at all.
--
-- ORDERING IS LOAD-BEARING: this file runs AFTER aggregates.sql, because it grants on objects that
-- file creates. Running it first produces "relation telemetry_1h does not exist" on a fresh
-- volume and only there, which is the worst kind of ordering bug -- it passes on every stack that
-- already has the rollups.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT THIS ROLE MAY READ, AND WHY THE LIST IS SHORT
--
-- The three rollups, and nothing else:
--
--   * NOT raw `telemetry`. A BI tool reading raw defeats the entire purpose of the rollups -- it
--     is the query pattern the aggregates exist to keep off the hypertable -- and read access to
--     every individual observation is a far wider grant than a KPI dashboard needs.
--   * NOT `telemetry_latest`. It is a DISTINCT ON over raw and carries the same exposure.
--   * NOT `assets`. Nothing in a rollup needs the display label, and the asset list is inventory
--     rather than measurement.
--
-- A CONTINUOUS AGGREGATE IS A VIEW, AND THAT IS WHAT MAKES THIS WORK. With
-- `materialized_only = false` (set by aggregates.sql, so a live dashboard sees the current
-- bucket) a query against telemetry_1h unions the materialised data with the raw hypertable tail.
-- The reader still needs no privilege on `telemetry`, because a non-security_invoker view executes
-- with its OWNER's privileges -- the standard PostgreSQL indirection. The grant list above is
-- therefore genuinely sufficient AND genuinely restrictive: the reader can see aggregated buckets
-- and cannot select a single raw observation. `test_bi_reader_grants.py` asserts both halves,
-- because "sufficient" here rests on a property of views that is easy to assume and easy to lose.
--
-- NOSUPERUSER / NOCREATEDB / NOCREATEROLE / NOINHERIT are stated explicitly rather than left to
-- defaults, because this file is the description of what the role is allowed to be.
-- =============================================================================================

\set ON_ERROR_STOP on

SELECT set_config('acs_cymru.bi_reader_password', :'bi_reader_password', false);


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

  -- CREATE then ALTER rather than DROP then CREATE: dropping a role that owns nothing still
  -- fails while any session is connected as it, which on a stack with a BI tool attached is most
  -- of the time. ALTER also rotates the password on every boot, so changing the environment
  -- variable is all that a rotation takes.
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
-- grafana_reader -- the INTERNAL engineering read surface
-- ---------------------------------------------------------------------------------------------
-- WHY A SECOND ROLE RATHER THAN WIDENING THE FIRST. Grafana and Power BI are not the same kind of
-- consumer and conflating them was a mistake worth naming: Power BI is an EXTERNAL business tool
-- that should see aggregated buckets and nothing else, while Grafana is an INTERNAL engineering
-- console whose whole job is the raw signal -- the excursion, the state transition, the individual
-- observation. Granting `powerbi_reader` what Grafana needs would have quietly handed an external
-- tool every reading in the historian, which is exactly what the narrow grant existed to prevent.
--
-- FOUND BY REPOINTING GRAFANA AND THEN READING ITS PANELS. The datasource health check passes on
-- CONNECT, so "Database Connection OK" said nothing about whether any panel could run -- four of
-- them could not. A connection test is not a permission test.
--
-- Still strictly read-only, and still no writes anywhere: this is a wider READ, not a wider role.
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

  -- telemetry_gapfill() is how a report-by-exception series MUST be read -- a missing bucket means
  -- unchanged, not unknown, so charting a rollup directly renders steady operation as a hole.
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION public.telemetry_gapfill(timestamptz, timestamptz, interval, '
    'text[], text[]) TO %I', v_role);

  -- pg_monitor for the historian I/O panels. A read-only membership: it grants visibility into
  -- pg_stat_* and nothing else.
  EXECUTE format('GRANT pg_monitor TO %I', v_role);

  RAISE NOTICE
    'roles: % may read the rollups, raw telemetry, telemetry_latest, assets, telemetry_gapfill() '
    'and pg_stat_* -- read-only throughout.', v_role;
END $$;


-- ---------------------------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------------------------
-- A grant that silently did not apply is indistinguishable from one that did until a BI tool
-- connects, which is typically days later and on someone else's machine.
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
    RAISE NOTICE 'roles self-check passed: grafana_reader can read every object the dashboard queries.';
  END IF;
END $$;
