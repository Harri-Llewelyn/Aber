-- =============================================================================================
-- Migration: 0027_storage_footprint.sql
-- One place that answers "what is this platform storing, and how far back does it go"
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- Takes one psql variable, supplied by db-init from the same environment Grafana reads:
--
--     -v bi_reader_password='...'
--
-- An empty value SKIPS the role, exactly as timescaledb/roles.sql does. An operator who has not
-- configured a dashboard reader should end up with no role, not with an unauthenticated one.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THE VIEW IS HERE AND NOT ONLY ON THE HISTORIAN.
--
-- The storage question spans two databases and neither can answer it alone. TimescaleDB knows what
-- the telemetry costs; it knows nothing about `digital_thread`, which is the table this platform
-- promises never to prune and therefore the one whose growth actually needs watching. Supabase
-- knows the reverse. `timescaledb/storage.sql` produces the historian's half and this file joins
-- it to the platform's own, over the postgres_fdw link that already exists for `public.telemetry`.
--
-- THE FDW DIRECTION IS THE ONLY ONE AVAILABLE, and it decides where the union has to live. Supabase
-- reaches TimescaleDB; nothing reaches back. So the combined view can only exist here, which is
-- also why Grafana grows a second datasource rather than querying the historian for both halves.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT `grafana_reader` MAY SEE, AND WHY IT IS A NEW ROLE.
--
-- Grafana previously held the `postgres` superuser credential for the historian and that was
-- removed deliberately -- a service fronted by browser SSO must not carry the key that owns the
-- database. Repeating the mistake against Supabase, where the same credential bypasses RLS and can
-- rewrite the audit trail, would be strictly worse. This role may SELECT ONE VIEW and holds no
-- other privilege in the database.
--
-- It reuses the name and password of the historian's `grafana_reader` on purpose: it is the same
-- consumer, and a second secret to rotate for the same tool is a second secret to forget. The
-- privileges are granted per database and share nothing but the credential.
-- =============================================================================================

SET check_function_bodies = false;

\if :{?bi_reader_password}
\else
\set bi_reader_password ''
\endif

-- Handed to PL/pgSQL through a GUC. The indirection is required, not stylistic: psql interpolates
-- `:'var'` while lexing and does NOT descend into dollar-quoted strings, so a `:'bi_reader_password'`
-- written inside the DO block below would reach the server as those literal characters and fail as
-- a syntax error. Same arrangement as timescaledb/roles.sql and retention.sql.
SELECT set_config('acs_cymru.bi_reader_password', :'bi_reader_password', false);


-- ---------------------------------------------------------------------------------------------
-- 1. The historian's half, over the FDW
-- ---------------------------------------------------------------------------------------------
-- Column names and types must match `public.storage_footprint` on the remote EXACTLY. postgres_fdw
-- does not verify this at creation time -- it maps whatever it is told -- so a mismatch surfaces as
-- a runtime error in a dashboard panel. The self-check at the end reads the table once for that
-- reason.
--
-- RECREATED, NOT `IF NOT EXISTS`: 0001 issues `DROP SERVER ... CASCADE` on every boot, which takes
-- every foreign table in `timescale` with it. This file must therefore assume nothing survives,
-- which is the same reason 0010 recreates its own mappings.
DROP FOREIGN TABLE IF EXISTS timescale.storage_footprint CASCADE;
CREATE FOREIGN TABLE timescale.storage_footprint (
    collected_at       TIMESTAMPTZ,
    source             TEXT,
    tier               TEXT,
    relation           TEXT,
    chunks             BIGINT,
    table_bytes        BIGINT,
    index_bytes        BIGINT,
    toast_bytes        BIGINT,
    total_bytes        BIGINT,
    uncompressed_bytes BIGINT,
    compressed_bytes   BIGINT,
    oldest_data        TIMESTAMPTZ,
    newest_data        TIMESTAMPTZ
)
SERVER timescaledb_server
OPTIONS (schema_name 'public', table_name 'storage_footprint');


-- ---------------------------------------------------------------------------------------------
-- 2. The platform's own half
-- ---------------------------------------------------------------------------------------------
-- Enumerated from the catalog rather than listed by name. A size report that silently omits a
-- table added later is worse than useless -- it under-reports the total and nothing says so --
-- and unlike a GRANT, sweeping wide here costs nothing.
--
-- THE TIERS ARE THE POINT OF THE WHOLE PANEL. "Storage is 4 GB" tells an operator nothing they can
-- act on; "3.6 GB of it is raw telemetry that retention will drop, 300 MB is an audit trail that
-- nothing will ever drop" tells them what to do next. `digital_thread` gets its own tier for
-- exactly that reason: it is the one relation here with no retention policy by design.
CREATE OR REPLACE FUNCTION public.platform_storage_rows()
RETURNS TABLE (
    tier        text,
    relation    text,
    table_bytes bigint,
    index_bytes bigint,
    toast_bytes bigint,
    total_bytes bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_catalog'
AS $fn$
    SELECT
        CASE
          WHEN c.relname = 'digital_thread' THEN 'audit'
          WHEN c.relname = 'platform_alerts' THEN 'alerts'
          -- The standards vocabularies are seeded reference data, not operational state. They are
          -- large (ASHRAE 223P alone is a six-figure INSERT chain in 0013) and they never grow at
          -- runtime, so folding them into `metadata` would put a fixed cost in the same bar as the
          -- one an operator is watching move.
          WHEN c.relname LIKE '%\_vocabulary' THEN 'vocabulary'
          ELSE 'metadata'
        END::text,
        c.relname::text,
        (pg_table_size(c.oid) - coalesce(pg_total_relation_size(c.reltoastrelid), 0))::bigint,
        pg_indexes_size(c.oid)::bigint,
        coalesce(pg_total_relation_size(c.reltoastrelid), 0)::bigint,
        pg_total_relation_size(c.oid)::bigint
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
     ORDER BY pg_total_relation_size(c.oid) DESC;
$fn$;

COMMENT ON FUNCTION public.platform_storage_rows() IS
  'Byte counts for every ordinary table in the Supabase public schema, tiered so an audit trail '
  'that is never pruned is distinguishable from reference data that never grows. SECURITY DEFINER '
  'so the dashboard reader needs no privilege on the tables it reports the size of.';


-- ---------------------------------------------------------------------------------------------
-- 3. The union -- the relation Grafana actually queries
-- ---------------------------------------------------------------------------------------------
-- `source` is what a panel groups by to answer "historian or platform"; `tier` is what it groups
-- by to answer "and what kind of data". Keeping both means one query serves the stacked breakdown
-- and the lifecycle table without a second round trip.
CREATE OR REPLACE VIEW public.storage_footprint AS
SELECT
    f.collected_at,
    f.source,
    f.tier,
    f.relation,
    f.chunks,
    f.table_bytes,
    f.index_bytes,
    f.toast_bytes,
    f.total_bytes,
    f.uncompressed_bytes,
    f.compressed_bytes,
    f.oldest_data,
    f.newest_data
  FROM timescale.storage_footprint f

UNION ALL

SELECT
    now(),
    'platform'::text,
    p.tier,
    p.relation,
    NULL::bigint,
    p.table_bytes,
    p.index_bytes,
    p.toast_bytes,
    p.total_bytes,
    -- Compression and chunk horizons are hypertable concepts. NULL rather than 0 or now(): a
    -- platform table is not "uncompressed to zero bytes", it is a relation the question does not
    -- apply to, and a chart that plots 0 for it draws a claim nobody made.
    NULL::bigint,
    NULL::bigint,
    NULL::timestamptz,
    NULL::timestamptz
  FROM public.platform_storage_rows() p;

COMMENT ON VIEW public.storage_footprint IS
  'Every relation this platform stores, from both databases: the historian over postgres_fdw and '
  'the Supabase public schema locally. Bytes by kind, chunk count and compression for hypertables, '
  'and the time span the chunks cover. Read by Grafana as the `supabase` datasource.';

-- NOT A POSTGREST ENDPOINT, and this revoke is what makes that true rather than merely intended.
--
-- `public` IS in PGRST_DB_SCHEMAS, so PostgREST routes every relation in it -- and Supabase's
-- bootstrap sets ALTER DEFAULT PRIVILEGES granting `anon` and `authenticated` SELECT on tables
-- created in this schema. A view added here is therefore browser-readable BY DEFAULT unless
-- something says otherwise, which is the opposite of what most people assume when they read
-- "internal view".
--
-- The exposure would be mild -- table names and byte counts, no telemetry, no asset identity --
-- and it is revoked anyway, because the dashboard has no use for it and the narrower grant costs
-- nothing. `docs/openapi.yaml` documents no path for it, and check-docs-drift.mjs records the
-- reason in NOT_PUBLISHED so the absence reads as a decision rather than an omission.
--
-- The two SECURITY DEFINER functions are revoked for the same reason: they are the view's
-- implementation, and leaving them executable would route around it.
REVOKE ALL ON public.storage_footprint FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.platform_storage_rows() FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------------------------
-- 4. The dashboard reader
-- ---------------------------------------------------------------------------------------------
DO $roles$
DECLARE
    v_password text := btrim(coalesce(current_setting('acs_cymru.bi_reader_password', true), ''));
    v_role     CONSTANT text := 'grafana_reader';
BEGIN
    IF v_password = '' THEN
        RAISE NOTICE
          '0027: % not configured (bi_reader_password is empty); skipping. Set BI_READER_PASSWORD '
          'to let Grafana read the storage footprint.', v_role;
        RETURN;
    END IF;

    -- CREATE then ALTER rather than DROP then CREATE: dropping a role fails while any session is
    -- connected as it, which on a stack with Grafana running is most of the time. ALTER also
    -- rotates the password on every boot, so changing the environment variable is all a rotation
    -- takes. Same reasoning, and the same shape, as timescaledb/roles.sql.
    --
    -- THE ATTRIBUTES ARE DECLARED ON CREATE AND NOT REPEATED ON ALTER, and that asymmetry is NOT
    -- cosmetic -- it is the one place this file cannot mirror timescaledb/roles.sql.
    --
    -- `postgres` IS A SUPERUSER ON THE HISTORIAN AND IS NOT ONE HERE. The Supabase image reserves
    -- that for `supabase_admin` and leaves `postgres` with CREATEROLE only. From PostgreSQL 16,
    -- naming SUPERUSER *or* NOSUPERUSER in ALTER ROLE counts as SETTING the attribute, which only a
    -- superuser may do -- so the identical statement that succeeds against TimescaleDB fails here
    -- with "Only roles with the SUPERUSER attribute may alter roles with the SUPERUSER attribute",
    -- a message that names neither the real cause nor this line.
    --
    -- CREATE ROLE ... NOSUPERUSER is fine, because there it agrees with the default rather than
    -- changing anything. So the attributes are stated once, where they can be, and the ALTER
    -- carries only what a rotation actually needs.
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
        EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', v_role);
        RAISE NOTICE '0027: created %', v_role;
    END IF;

    EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', v_role, v_password);

    -- REVOKE EVERYTHING FIRST, THEN GRANT THE ONE THING. Stated in that order because it is the
    -- order the statements must run in, and an earlier version of this block interleaved them and
    -- revoked away a grant it had just made.
    --
    -- The revokes are not paranoia about a role that was just created: Supabase's own bootstrap
    -- issues broad DEFAULT PRIVILEGES in this schema, so a role created afterwards can inherit
    -- reach nobody intended. Re-revoking on every boot makes this file the authority on what the
    -- role may touch rather than a description of how it was first set up.
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', v_role);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', v_role);
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', v_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', v_role);

    -- `auth`, `storage` and `vault` are deliberately NOT revoked here, because there is nothing to
    -- revoke: Supabase grants those schemas to named roles rather than to PUBLIC, so a role created
    -- above starts with no reach into them. Issuing the REVOKE anyway would only add a statement
    -- that fails if one of those schemas is absent on some future image.

    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), v_role);
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', v_role);
    EXECUTE format('GRANT SELECT ON public.storage_footprint TO %I', v_role);

    -- EXECUTE ON THE TWO FUNCTIONS THE VIEW CALLS, and this is the part that is easy to get wrong.
    --
    -- A non-security_invoker VIEW checks access to the TABLES it reads as its OWNER -- that is the
    -- standard indirection, and it is why this role needs no privilege on `pg_class`, on the
    -- foreign table, or on the tables being measured. FUNCTION EXECUTE IS NOT COVERED BY IT: a
    -- function called in a view body is still checked against the CALLING role. Revoking EXECUTE
    -- from PUBLIC above (so the view is not reachable around) therefore locks the view's own reader
    -- out of it, and the symptom is "permission denied for function platform_storage_rows" from a
    -- SELECT on a view the role plainly has SELECT on.
    --
    -- Granting it back here is safe for the same reason the view is: both functions return byte
    -- counts and chunk time-spans, never an observation, an asset id or a metric name.
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.platform_storage_rows() TO %I', v_role);

    RAISE NOTICE
      '0027: % may SELECT public.storage_footprint and nothing else in this database.', v_role;
END;
$roles$;


-- ---------------------------------------------------------------------------------------------
-- 5. Self-check
-- ---------------------------------------------------------------------------------------------
DO $selfcheck$
DECLARE
    v_remote      integer;
    v_local       integer;
    v_audit       integer;
    v_unreachable boolean := false;
BEGIN
    -- -----------------------------------------------------------------------------------------
    -- The remote half. READING IT IS THE ONLY THING THAT PROVES THE MAPPING RESOLVES: postgres_fdw
    -- is lazy, so a foreign table over a relation that does not exist -- or whose columns disagree
    -- -- is created perfectly and fails at the first SELECT, which would be in a dashboard panel.
    --
    -- "THE HISTORIAN IS UNREACHABLE" IS A DIFFERENT FACT FROM "THE MAPPING IS WRONG", and only the
    -- second is what this is about. 0010 draws the same distinction for the same reason and the
    -- reasoning is worth repeating rather than cross-referencing: the RLS/edge-function CI job
    -- applies this whole chain against a BARE POSTGRES with no TimescaleDB anywhere, because what
    -- it tests is authorisation and it has no use for a historian. Failing there would make the
    -- migrations refuse to apply where nothing is wrong -- and, worse, would couple every Supabase
    -- boot to TimescaleDB being up, so a historian taken down for maintenance would stop the whole
    -- stack applying migrations.
    --
    -- So a connection failure (SQLSTATE class 08) SKIPS and anything else FAILS. A missing remote
    -- relation or a column-type disagreement arrives as 42P01 or 42804 and still stops the boot,
    -- which is the case worth catching.
    -- -----------------------------------------------------------------------------------------
    BEGIN
        SELECT count(*) INTO v_remote FROM timescale.storage_footprint;
    EXCEPTION
        WHEN connection_exception THEN
            v_unreachable := true;
        WHEN others THEN
            RAISE EXCEPTION
                '0027 self-check: timescale.storage_footprint is mapped but not readable (%). The '
                'remote view is created by timescaledb/storage.sql, which timescaledb-maintenance '
                'applies BEFORE db-init. Check that it ran and succeeded.', SQLERRM;
    END;

    IF v_unreachable THEN
        RAISE NOTICE
            '0027 self-check: the historian is unreachable, so the remote half was not verified. '
            'Expected where Supabase is applied without TimescaleDB (the RLS CI job); a problem '
            'anywhere else.';
    ELSIF v_remote = 0 THEN
        RAISE EXCEPTION
            '0027 self-check: timescale.storage_footprint resolved but returned no rows. The '
            'historian always has at least the telemetry hypertable, so an empty result means '
            'storage.sql created the view against a database with no hypertables.';
    END IF;

    -- -----------------------------------------------------------------------------------------
    -- The local half, which is verifiable with or without a historian -- so it is asserted against
    -- platform_storage_rows() DIRECTLY rather than through the union. Going through the view would
    -- make every local assertion below unverifiable in exactly the CI job that applies this chain
    -- most often.
    -- -----------------------------------------------------------------------------------------
    SELECT count(*) INTO v_local FROM public.platform_storage_rows();
    IF v_local = 0 THEN
        RAISE EXCEPTION
            '0027 self-check: platform_storage_rows() matched no tables in the public schema';
    END IF;

    -- The tier that motivated the feature. If `digital_thread` is not classified as audit, the
    -- storage breakdown silently folds the one never-pruned table into general metadata.
    SELECT count(*) INTO v_audit
      FROM public.platform_storage_rows()
     WHERE tier = 'audit' AND relation = 'digital_thread';
    IF v_audit <> 1 THEN
        RAISE EXCEPTION
            '0027 self-check: digital_thread is not reported in the audit tier (found % rows)',
            v_audit;
    END IF;

    -- THE ATTRIBUTES THIS FILE CAN NO LONGER RECONCILE. Because `postgres` is not a superuser
    -- here, the ALTER above sets only LOGIN and PASSWORD -- so an existing role that acquired
    -- CREATEROLE or SUPERUSER by some other route would keep it, silently, on every boot. This
    -- cannot fix that; it can refuse to pretend otherwise, which is the difference between a
    -- limitation and a hole.
    IF EXISTS (
        SELECT 1 FROM pg_roles
         WHERE rolname = 'grafana_reader'
           AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls)
    ) THEN
        RAISE EXCEPTION
            '0027 self-check: grafana_reader holds SUPERUSER, CREATEROLE, CREATEDB or BYPASSRLS. '
            'This migration cannot remove those (postgres is not a superuser on the Supabase '
            'image); drop the role and let the next boot recreate it.';
    END IF;

    -- The narrow grant, asserted from the other direction. `GRANT USAGE ON SCHEMA public` exposes
    -- no table by itself, but Supabase's bootstrap sets default privileges in this schema and a
    -- role created afterwards can inherit reach nobody intended -- which is what the REVOKE block
    -- above exists to undo. digital_thread is the one to name: it is the table whose SIZE this
    -- feature reports, and reporting a size must never require reading the contents.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader')
       AND has_table_privilege('grafana_reader', 'public.digital_thread', 'SELECT') THEN
        RAISE EXCEPTION
            '0027 self-check: grafana_reader can read digital_thread. It may SELECT '
            'storage_footprint and nothing else.';
    END IF;

    RAISE NOTICE
        '0027 self-check passed: % platform relation(s) reported%.',
        v_local,
        CASE WHEN v_unreachable THEN ' (historian not verified -- unreachable)'
             ELSE format(', plus %s from the historian', v_remote) END;
END;
$selfcheck$;
