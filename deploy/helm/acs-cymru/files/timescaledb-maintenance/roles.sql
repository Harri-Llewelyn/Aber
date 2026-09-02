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

  -- The cold archive catalogue, READ ONLY. This is the role every FDW session from the platform
  -- database opens as, so without it `cold_storage_rows()` (0068) fails inside a dashboard panel
  -- rather than at deploy -- the same failure 0027's foreign table documents. Guarded on the
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

  -- The storage footprint, created by storage.sql -- which is why THAT file must run before this
  -- one, and does in both runners. Bytes and chunk time-spans only: storage_footprint_rows() is
  -- SECURITY DEFINER precisely so this grant does not have to be widened to the hypertables it
  -- reports on.
  --
  -- NOT ALSO GRANTED TO powerbi_reader. The size of the telemetry is an operations question, and
  -- that role exists to answer business ones from aggregated buckets.
  EXECUTE format('GRANT SELECT ON public.storage_footprint TO %I', v_role);

  -- AND EXECUTE ON THE FUNCTION BEHIND IT, which SELECT on the view does not imply. A
  -- non-security_invoker view checks TABLE access as its owner, but a function called in the view
  -- body is still checked against the CALLING role -- so without this the role has SELECT on a view
  -- it cannot run, and the error names the function rather than the missing grant.
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.storage_footprint_rows() TO %I', v_role);

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

    -- Separate from the block above so the message names the cause. This one fails when
    -- storage.sql did not run, or ran AFTER this file -- an ordering fault, not a grant fault, and
    -- one that otherwise presents as a data-lifecycle panel that is empty on a fresh volume and
    -- correct everywhere else.
    IF to_regclass('public.storage_footprint') IS NULL THEN
      RAISE EXCEPTION
        'roles self-check: public.storage_footprint does not exist. storage.sql must run BEFORE '
        'roles.sql -- check the ordering in docker-compose.yml and in the Helm maintenance Job.';
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
-- ingest_writer -- the ingestion daemon, which is the process most exposed to the plant network
-- ---------------------------------------------------------------------------------------------
-- IT CONNECTED AS `postgres` UNTIL NOW. The daemon is, in this repository's own words, "the process
-- most exposed to the plant network", and it held superuser on the historian: it could DROP the
-- hypertable, rewrite any observation, and read everything. The README's security-model table has
-- listed "append-only historian writes" as an ingestion-layer control the whole time, and nothing
-- in the database enforced it -- append-only was a property of the Python.
--
-- This is the same debt the stack has already paid twice on the OTHER database: Grafana moved off
-- the superuser onto grafana_reader, and the daemon moved off SUPABASE_SERVICE_ROLE_KEY onto
-- Service_Ingestor (0046-0048, 0051). This is the historian's turn.
--
-- =============================================================================================
-- THE GRANT LIST IS MEASURED, NOT REASONED. Every line below was determined by running the
-- daemon's two actual statements as a probe role and removing privileges until they broke.
--
--   assets      INSERT, UPDATE, SELECT
--   telemetry   INSERT, SELECT
--
-- SELECT IS NOT OPTIONAL AND THAT SURPRISED ME. Both statements carry an ON CONFLICT clause --
-- `DO UPDATE` on assets, `DO NOTHING` on telemetry -- and inferring the arbiter index requires
-- SELECT on the target. With INSERT and UPDATE alone, `permission denied for table assets`. So
-- this role is APPEND-ONLY, not write-only, and the tempting specification of "INSERT on
-- telemetry, INSERT/UPDATE on assets, nothing else" was wrong about the minimum.
--
-- The distinction that matters is preserved regardless: it can add rows and it cannot change or
-- remove one. The self-check below asserts exactly that, in both directions.
--
-- THE HYPERTABLE GRANT REACHES THE CHUNKS, verified rather than assumed -- a probe insert that
-- passed the privilege check and then failed a foreign key named `_hyper_1_5_chunk`, which is the
-- chunk rather than the parent. Had it not propagated, ingestion would have broken at the moment a
-- NEW chunk was created, days after the change, with nothing connecting the two.
--
-- WHAT IT DELIBERATELY CANNOT REACH: the rollups. The daemon writes raw observations; the
-- aggregates are derived from them by TimescaleDB itself, and a writer that could read them is a
-- writer that could be talked into reporting on them.
-- =============================================================================================

DO $$
DECLARE
  v_password text := btrim(coalesce(current_setting('acs_cymru.ingest_writer_password', true), ''));
  v_role     CONSTANT text := 'ingest_writer';
  v_dbname   CONSTANT text := current_database();
BEGIN
  -- REQUIRED, UNLIKE THE TWO READERS ABOVE, and the difference is not an inconsistency. BI and
  -- Grafana are optional consumers: a stack with neither is a stack that skips those roles and is
  -- complete. The ingestion daemon is not optional -- it must connect to this database as
  -- SOMETHING, and the only alternative to this role is the superuser it was created to replace.
  -- Skipping quietly would leave the stack running with the exact property this file exists to
  -- remove, and reporting that as a NOTICE nobody reads is how it stayed that way for months.
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

  -- COLD ARCHIVAL. The exporter runs as this role and writes the manifest, so it
  -- needs INSERT and UPDATE there -- but note what it still does NOT get: DELETE on the manifest,
  -- and nothing at all on telemetry beyond the INSERT above. The revokes below still stand.
  --
  -- Dropping an archived chunk is reached through cold_tier_drop_verified(), which is SECURITY
  -- DEFINER for exactly this reason: it lets the daemon ASK for a drop the manifest has already
  -- verified, without holding the DELETE that would let it remove anything else. Guarded on the
  -- table existing because roles.sql also runs on stacks that have not applied cold_archive.sql
  -- yet -- a first boot orders the two the other way round.
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
-- fdw_reader -- what Supabase's foreign tables connect AS
-- ---------------------------------------------------------------------------------------------
-- `0001` creates `USER MAPPING FOR PUBLIC` against timescaledb_server with the historian's
-- superuser. Every FDW session opened on behalf of `authenticated` or `service_role` therefore runs
-- on THIS side as superuser, and the only containment is the LOCAL grant over in Supabase --
-- SELECT on `timescale.*`. The remote end contributes nothing.
--
-- No application role can abuse that today. What makes it worth closing is that nothing stops the
-- next change from doing so: a widened local grant, or a new foreign table added against the same
-- server, silently inherits superuser reach on the historian. The mapping also parks the superuser
-- password in `pg_user_mappings`, which the backup runbook already has to warn about.
--
-- READ-ONLY, AND ONLY THE PROJECTION. The five foreign tables Supabase defines are telemetry,
-- telemetry_latest, telemetry_1m, telemetry_5m, telemetry_1h and storage_footprint. Nothing on the
-- Supabase side writes through the FDW -- `public.telemetry` is a security_invoker VIEW over a
-- foreign table and the historian is written only by the daemon -- so INSERT would be a grant with
-- no caller.

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
  IF to_regclass('public.storage_footprint') IS NOT NULL THEN
    EXECUTE format('GRANT SELECT ON public.storage_footprint TO %I', v_role);
  END IF;

  -- No writes, stated rather than implied.
  EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.telemetry FROM %I', v_role);
  EXECUTE format('REVOKE ALL ON public.assets FROM %I', v_role);

  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', v_role);

  RAISE NOTICE
    'roles: % may SELECT the six objects Supabase projects and cannot write any of them.', v_role;
END $$;


-- ---------------------------------------------------------------------------------------------
-- Self-check: both directions, for both roles
-- ---------------------------------------------------------------------------------------------
-- ASSERTING ONLY THE GRANTS WOULD BE HALF A CHECK. "ingest_writer can insert" passes just as well
-- on a role that is secretly superuser; "ingest_writer cannot delete" passes on a role that cannot
-- do anything at all and has silently stopped the fleet's telemetry. Both halves, or neither is
-- worth running.
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

    RAISE NOTICE 'roles self-check passed: fdw_reader reads the projection and writes nothing.';
  END IF;
END $$;
