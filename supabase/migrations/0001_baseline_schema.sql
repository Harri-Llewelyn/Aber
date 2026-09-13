-- =============================================================================================
-- Migration: 0001_baseline_schema.sql
-- ACS-Cymru Asset Tracking Platform -- consolidated schema baseline (public beta)
-- =============================================================================================
--
-- The squashed structural baseline: pure DDL, generated from a pg_dump of a database the
-- pre-beta chain built (the chain is preserved under `supabase/migrations/archive/`). Baseline
-- data lives in `0002_seed_data.sql`.
--
-- IDEMPOTENT, AND THAT IS NOT OPTIONAL. `supabase-db-init` replays every `/migrations/*.sql` on
-- every boot with no ledger, so every statement survives re-execution: `CREATE TABLE IF NOT
-- EXISTS`, `CREATE OR REPLACE` for functions and views, `DROP ... IF EXISTS` ahead of every
-- constraint, policy and trigger.
--
-- Not here: the `storage.buckets` row (storage-api owns that schema and migrates it after
-- db-init has finished; `scripts/storage-init.mjs` creates the bucket), and anything owned by
-- GoTrue, Realtime or storage-api. The policies on `storage.objects` are here, because that
-- table exists from the image's stub onward.
--
-- PSQL VARIABLES. `supabase-db-init` passes `-v ts_host ts_port ts_dbname ts_user ts_password`.
-- Each is defaulted below so this file is still runnable standalone.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 0. Deferred function-body validation
-- ---------------------------------------------------------------------------------------------
-- Required: PL/pgSQL resolves type references in a DECLARE block at CREATE time, and no single
-- ordering satisfies every dependency between policies, functions, tables and views. Syntax is
-- still checked; the deferred semantic checks run on first call, which the self-checks below do.
SET check_function_bodies = false;

-- ---------------------------------------------------------------------------------------------
-- 1. Extensions
-- ---------------------------------------------------------------------------------------------
-- Each is created into the schema the original migration chose: pg_net in `extensions` is where
-- Supabase expects it, and supabase_vault in `vault` makes `vault.decrypted_secrets` resolvable.

CREATE EXTENSION IF NOT EXISTS postgres_fdw;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;

-- pgjwt is declared explicitly: the 17.x image ships the extension but no longer creates it, and
-- `extensions.sign()` is what the webhook dispatcher calls. Supabase has announced pgjwt's end
-- for Postgres 17; removing it is this line plus the signer in the dispatcher.
CREATE EXTENSION IF NOT EXISTS pgjwt WITH SCHEMA extensions;

-- Vault holds only secrets that must be read *from SQL* -- in practice the Node-RED admin token
-- the quarantine webhook attaches to its outbound request. Neither browser-facing role may read
-- the store, so the revocation is part of the structure rather than of the seeding.
REVOKE ALL ON vault.secrets           FROM anon, authenticated;
REVOKE ALL ON vault.decrypted_secrets FROM anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 2. Realtime bootstrap schema
-- ---------------------------------------------------------------------------------------------
-- `supabase-realtime` crash-loops on boot if this schema does not already exist -- it migrates
-- into it rather than creating it. Nothing else in this file uses it.

CREATE SCHEMA IF NOT EXISTS _realtime;
GRANT ALL ON SCHEMA _realtime TO supabase_admin;
REVOKE ALL ON SCHEMA _realtime FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- 3. TimescaleDB foreign data wrapper
-- ---------------------------------------------------------------------------------------------
-- TimescaleDB is a separate container reachable only from this database; the FDW gives the SPA
-- a normal PostgREST collection. Must come before section 4: `DROP SERVER ... CASCADE` drops
-- the foreign table and the `public.telemetry` view, which section 4 re-creates.

\if :{?ts_host}
\else
\set ts_host 'timescaledb'
\endif
\if :{?ts_port}
\else
\set ts_port '5432'
\endif
\if :{?ts_dbname}
\else
\set ts_dbname 'postgres'
\endif
\if :{?ts_user}
\else
\set ts_user 'postgres'
\endif
\if :{?ts_password}
\else
\set ts_password 'postgres'
\endif

-- Foreign objects live in their own schema, kept out of PGRST_DB_SCHEMAS so the raw foreign
-- table is never routable; only the public view is exposed.
CREATE SCHEMA IF NOT EXISTS timescale;

-- Recreated on every run so the connection settings stay in step with the chart's values and
-- timescaledb/init/001_schema.sql. The CASCADE drops the whole telemetry read surface until the
-- rollup views are rebuilt later in the chain; a file aborting in between leaves PostgREST
-- answering `telemetry` with a missing-relation error until the next successful replay.
-- ---------------------------------------------------------------------------------------------
-- The FDW's own credential. Two "not set" cases: UNDEFINED (a hand run passes no variable, and
-- psql aborts on an undefined :'var', so `\if :{?name}` is tested first) and BLANK (db-init
-- always passes it, so an unset FDW_READER_PASSWORD arrives defined and empty; the SQL below
-- decides that). Both fields switch on the user: a blank user with a non-blank password is a
-- typo, not a half-configured state.
\if :{?ts_fdw_user}
\else
  \set ts_fdw_user ''
\endif
\if :{?ts_fdw_password}
\else
  \set ts_fdw_password ''
\endif

SELECT CASE WHEN btrim(:'ts_fdw_user') = '' THEN :'ts_user'     ELSE :'ts_fdw_user'     END
         AS ts_fdw_user,
       CASE WHEN btrim(:'ts_fdw_user') = '' THEN :'ts_password' ELSE :'ts_fdw_password' END
         AS ts_fdw_password
\gset

-- The link to the historian is verified when the chart serves TLS: db-init passes the CA's path on
-- THIS server's filesystem and the mode follows. Empty means the chart runs without TLS, and the
-- link negotiates nothing.
\if :{?ts_sslrootcert}
\else
  \set ts_sslrootcert ''
\endif
SELECT btrim(:'ts_sslrootcert') <> '' AS ts_tls,
       CASE WHEN btrim(:'ts_sslrootcert') = '' THEN 'prefer' ELSE 'verify-full' END AS ts_sslmode
\gset

DROP SERVER IF EXISTS timescaledb_server CASCADE;

CREATE SERVER timescaledb_server
  FOREIGN DATA WRAPPER postgres_fdw
  OPTIONS (host :'ts_host', port :'ts_port', dbname :'ts_dbname', sslmode :'ts_sslmode');

\if :ts_tls
  ALTER SERVER timescaledb_server OPTIONS (ADD sslrootcert :'ts_sslrootcert');
\endif

-- `postgres` keeps its own mapping for admin access. A second mapping FOR PUBLIC covers every
-- other local role, since the view runs security_invoker and each querying role needs its own
-- path through the FDW. `anon` reaches none of it.
--
-- The public mapping runs as `fdw_reader` (timescaledb/roles.sql: SELECT on the projected
-- objects, no write) when one is configured, not as the historian superuser, so a widened local
-- grant or a new foreign table cannot inherit superuser reach on the historian. The admin
-- mapping is left alone: it is what a human debugging the FDW connects through. Falls back to
-- `ts_user` when FDW_READER_PASSWORD is unset, because roles.sql skips a role with no password.
CREATE USER MAPPING FOR postgres
  SERVER timescaledb_server
  OPTIONS (user :'ts_user', password :'ts_password');

CREATE USER MAPPING FOR PUBLIC
  SERVER timescaledb_server
  OPTIONS (user :'ts_fdw_user', password :'ts_fdw_password');

-- ---------------------------------------------------------------------------------------------
-- 3b. The dashboard reader
-- ---------------------------------------------------------------------------------------------
\if :{?bi_reader_password}
\else
\set bi_reader_password ''
\endif

-- Staged through a GUC: psql substitutes :variables while lexing and does NOT descend into
-- dollar-quoted blocks, so a :'bi_reader_password' inside the DO below would never be replaced.
SELECT set_config('acs_cymru.bi_reader_password', :'bi_reader_password', false);

-- ---------------------------------------------------------------------------------------------
-- 3a. Default privileges, narrowed BEFORE anything is created
-- ---------------------------------------------------------------------------------------------
-- ALTER DEFAULT PRIVILEGES applies only to objects created after it runs, so these precede
-- every object in this file. The image's bootstrap grants anon, authenticated and service_role
-- ALL on every table, sequence and function created afterwards; a dump cannot state that these
-- were withdrawn. PUBLIC is absent from the list because the image's recorded default for
-- functions does not include it; PostgreSQL's hardwired EXECUTE-to-PUBLIC is removed by the
-- sweep in section 6.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

DO $roles$
DECLARE
    v_password text := btrim(coalesce(current_setting('acs_cymru.bi_reader_password', true), ''));
    v_role     CONSTANT text := 'grafana_reader';
BEGIN
    IF v_password = '' THEN
        RAISE NOTICE
          '% not configured (bi_reader_password is empty); skipping. Set BI_READER_PASSWORD to '
          'let Grafana read the storage footprint.', v_role;
        RETURN;
    END IF;

    -- CREATE then ALTER rather than DROP then CREATE: dropping a role fails while any session is
    -- connected as it. The ALTER also rotates the password on every boot. The attributes are set
    -- on CREATE only: from PostgreSQL 16 naming SUPERUSER or NOSUPERUSER in ALTER ROLE counts as
    -- setting the attribute, which only a superuser may do, and `postgres` is not one here.
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
        EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', v_role);
        RAISE NOTICE 'created %', v_role;
    END IF;

    EXECUTE format('ALTER ROLE %I WITH LOGIN PASSWORD %L', v_role, v_password);

    -- REVOKE EVERYTHING FIRST. Supabase's own bootstrap issues broad DEFAULT PRIVILEGES in this
    -- schema, so a role created afterwards inherits reach nobody intended. The narrow grants this
    -- role actually needs are issued beside the objects they name, further down.
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', v_role);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', v_role);
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', v_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', v_role);

    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), v_role);
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', v_role);
END
$roles$;

-- ---------------------------------------------------------------------------------------------
-- 4. public and timescale, generated from the end state of the chain
-- ---------------------------------------------------------------------------------------------
-- Every object below is taken from a dump of a database the whole chain built, so each one is
-- its final form and appears exactly once. Comments inside function bodies survive the dump;
-- the narrative between objects lives in the archived migrations.

-- SCHEMA public :: COMMENT
--

COMMENT ON SCHEMA public IS 'standard public schema';

--

-- active_schema_version(uuid) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.active_schema_version(schema_id uuid) RETURNS uuid
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
DECLARE
  v_id     UUID := schema_id;
  v_status TEXT;
  v_next   UUID;
  hops     INTEGER := 0;
BEGIN
  LOOP
    SELECT s.status INTO v_status FROM public.schemas s WHERE s.id = v_id;
    -- Not archived (or gone) means this is already the answer: an active version is the head, and
    -- a draft was deliberately attached by someone trialling it.
    IF v_status IS NULL OR v_status <> 'archived' THEN
      RETURN v_id;
    END IF;

    -- Drafts are excluded: an unpublished version is not in force, and forwarding a live binding
    -- onto one would activate it by the back door.
    SELECT s.id INTO v_next
      FROM public.schemas s
     WHERE s.parent_schema_id = v_id AND s.status IN ('active', 'archived')
     ORDER BY s.version
     LIMIT 1;

    -- An archived version whose successor was deleted: the chain ends, so it stays where it is.
    -- Better a stale pointer than a NULL one, which would read as "this device has no model".
    IF v_next IS NULL THEN
      RETURN v_id;
    END IF;

    v_id := v_next;
    hops := hops + 1;
    -- A cycle is unreachable (a CHECK forbids self-parenting, the guard freezes parent_schema_id,
    -- and a fork only ever points at a row that already exists), but an unbounded loop inside a
    -- migration is not a risk worth carrying on reasoning alone.
    IF hops > 1000 THEN
      RAISE EXCEPTION 'schema lineage from % does not terminate', schema_id;
    END IF;
  END LOOP;
END;
$$;

--

-- FUNCTION active_schema_version(schema_id uuid) :: COMMENT
--

COMMENT ON FUNCTION public.active_schema_version(schema_id uuid) IS 'Follows a lineage forward from any version to the one currently in force. Returns the input unchanged when it is already active, is a draft, or has no published successor.';

--

-- approve_quarantined_device(uuid, uuid, uuid, uuid, text, uuid, text, boolean, boolean) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.approve_quarantined_device(p_device_id uuid, p_actor_id uuid, p_gateway_id uuid DEFAULT NULL::uuid, p_merge_into_device_id uuid DEFAULT NULL::uuid, p_asset_name text DEFAULT NULL::text, p_cell_id uuid DEFAULT NULL::uuid, p_location_scope text DEFAULT NULL::text, p_set_cell boolean DEFAULT false, p_set_location_scope boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_quarantined public.devices%ROWTYPE;
  v_candidate   public.devices%ROWTYPE;
  v_result      public.devices%ROWTYPE;
  v_actor_role  text;
  v_cell        uuid := p_cell_id;
BEGIN
  -- Authorization is re-derived from the database rather than taken on trust. The edge function
  -- checks too; this is the check that still holds if the RPC is ever reached another way.
  SELECT r.name INTO v_actor_role
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
   WHERE ur.user_id = p_actor_id::text
   LIMIT 1;

  IF v_actor_role IS NULL OR v_actor_role NOT IN ('Administrator', 'Shopfloor_Manager') THEN
    RAISE EXCEPTION 'actor % is not permitted to approve quarantined devices', p_actor_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Attribute every trigger-written audit row in this transaction to the operator. SET LOCAL, so
  -- it is discarded at COMMIT and cannot bleed into the connection's next user.
  PERFORM set_config('acs_cymru.actor_id', p_actor_id::text, true);

  SELECT * INTO v_quarantined FROM public.devices WHERE id = p_device_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quarantined device % not found', p_device_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- ---------------------------------------------------------------------------------------
  -- Merge path: absorb a discovered duplicate into the row that was already provisioned.
  -- ---------------------------------------------------------------------------------------
  IF p_merge_into_device_id IS NOT NULL THEN
    IF p_merge_into_device_id = p_device_id THEN
      RAISE EXCEPTION 'cannot merge device % into itself', p_device_id
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Locked in a deterministic order relative to the row above would be ideal, but these are
    -- two named ids and the transaction is short; the FOR UPDATE is what stops a concurrent
    -- approval racing this one into two live rows.
    SELECT * INTO v_candidate FROM public.devices WHERE id = p_merge_into_device_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'target device % not found', p_merge_into_device_id
        USING ERRCODE = 'no_data_found';
    END IF;

    -- asset_config is keyed by sparkplug_id, not by row id, so the recorded birth parameters
    -- have to be re-keyed onto the surviving row.
    UPDATE public.asset_config
       SET asset_id = v_candidate.sparkplug_id
     WHERE asset_id = v_quarantined.sparkplug_id;

    -- reported_identity carries over deliberately: the physical device keeps publishing under
    -- the id it announced, and that is what ingestion has to keep resolving. Without it the
    -- merged device is re-quarantined on its very next birth. The candidate's deliberately
    -- provisioned fields (gateway_id, schema_id, connection_method) are left alone.
    UPDATE public.devices
       SET status            = v_quarantined.status,
           first_dbirth_at   = COALESCE(v_candidate.first_dbirth_at, v_quarantined.first_dbirth_at),
           reported_identity = v_quarantined.reported_identity,
           identity_source   = v_quarantined.identity_source,
           quarantine_reason = NULL,
           is_quarantined    = false
     WHERE id = v_candidate.id
    RETURNING * INTO v_result;

    DELETE FROM public.devices WHERE id = v_quarantined.id;

    RETURN jsonb_build_object(
      'merged', true,
      'device', to_jsonb(v_result),
      'discarded_device_id', v_quarantined.id
    );
  END IF;

  -- ---------------------------------------------------------------------------------------
  -- Straight approval.
  -- ---------------------------------------------------------------------------------------
  -- Mirrors devices_site_wide_has_no_cell: a site-wide asset cannot also name a cell, so it is
  -- cleared here rather than left to a constraint violation.
  IF p_set_location_scope AND p_location_scope = 'site_wide' THEN
    v_cell := NULL;
  END IF;

  UPDATE public.devices
     SET is_quarantined    = false,
         quarantine_reason = NULL,
         gateway_id        = p_gateway_id,
         -- LOCATION IS OMITTED WHEN NOT ANSWERED, NEVER DEFAULTED. devices.cell_id is
         -- NULL-means-inherit with no column default, so writing a value the operator did not
         -- choose would switch inheritance off permanently for every device approved this way.
         -- The p_set_* flags are what distinguish "not supplied" from "explicitly cleared" --
         -- a plain NULL argument cannot express the difference.
         cell_id           = CASE WHEN p_set_cell           THEN v_cell           ELSE cell_id END,
         location_scope    = CASE WHEN p_set_location_scope THEN p_location_scope ELSE location_scope END,
         name              = COALESCE(NULLIF(btrim(COALESCE(p_asset_name, '')), ''), name)
   WHERE id = p_device_id
  RETURNING * INTO v_result;

  RETURN jsonb_build_object('merged', false, 'device', to_jsonb(v_result));
END;
$$;

--

-- FUNCTION approve_quarantined_device(p_device_id uuid, p_actor_id uuid, p_gateway_id uuid, p_merge_into_device_id uuid, p_asset_name text, p_cell_id uuid, p_location_scope text, p_set_cell boolean, p_set_location_scope boolean) :: COMMENT
--

COMMENT ON FUNCTION public.approve_quarantined_device(p_device_id uuid, p_actor_id uuid, p_gateway_id uuid, p_merge_into_device_id uuid, p_asset_name text, p_cell_id uuid, p_location_scope text, p_set_cell boolean, p_set_location_scope boolean) IS 'Atomically approves or merges a quarantined device. Re-checks the actor role against public.user_roles and attributes the resulting digital_thread rows to that actor.';

--

-- audit_domain_for(text, text) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.audit_domain_for(p_entity_type text, p_action text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
    -- Identity and authority. Every act on these is Administrator-only to perform, so it is
    -- Administrator-and-Auditor to read.
    WHEN p_entity_type IN ('service_principals', 'user_roles', 'system_settings')
      THEN 'security'

    -- The asset trail: the shopfloor's own history, which is what a Shopfloor_Manager manages.
    -- CREDENTIAL_ISSUED lands here on `gateways` deliberately -- see the header. A Manager may
    -- mint a virtual gateway's broker credential, so a Manager may read that one was minted.
    WHEN p_entity_type IN ('cells', 'devices', 'gateways', 'links')
      THEN 'asset'

    -- FAIL-CLOSED. A new entity_type nobody classified is restricted rather than exposed. The
    -- cost is a lane a Manager cannot see and will report; the alternative is a privileged act
    -- they can, and will not.
    ELSE 'security'
  END
$$;

--

-- FUNCTION audit_domain_for(p_entity_type text, p_action text) :: COMMENT
--

COMMENT ON FUNCTION public.audit_domain_for(p_entity_type text, p_action text) IS 'Which lane a digital_thread row belongs in. The rule is WHO MAY PERFORM the act, not what the act is about -- see 0070. Unrecognised input is ''security'': the safe failure is a row a Shopfloor_Manager cannot see, not a privileged act they can.';

--

-- authorize_virtual_gateway_credential(uuid) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.authorize_virtual_gateway_credential(p_gateway_id uuid) RETURNS TABLE(sparkplug_id text, gateway_name text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_gateway public.gateways%ROWTYPE;
BEGIN
  -- Fail closed, and before anything observable happens. The same allow-list as the write policies
  -- on `gateways` and as 0025's issuing RPC: minting a broker credential is a gateway-management
  -- act, and there is no reading of it that makes it less than that.
  IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'insufficient privileges to mint a gateway broker credential'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_gateway FROM public.gateways WHERE id = p_gateway_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gateway % does not exist', p_gateway_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- The mirror image of the enrolment path: that refuses a host-run gateway because there is no
  -- appliance to carry a bundle to; this requires one, because a remote appliance mints its
  -- credential on the appliance itself and never through a browser.
  IF v_gateway.deployment <> 'host' THEN
    RAISE EXCEPTION
      'gateway % runs on an appliance; use an enrolment bundle so the credential is minted there '
      'rather than shown in a browser', v_gateway.name
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- ARCHIVED IS REFUSED, following 0037. That migration made archiving withdraw an outstanding
  -- enrolment bundle, having found that a bundle downloaded and never instantiated stayed
  -- redeemable after the gateway was archived -- issuing a real broker credential and resurrecting
  -- the row to ONLINE. Minting directly is the same hole reached in one step instead of two.
  IF v_gateway.is_archived THEN
    RAISE EXCEPTION 'gateway % is archived; restore it before minting a credential', v_gateway.name
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY SELECT v_gateway.sparkplug_id, v_gateway.name;
END;
$$;

--

-- FUNCTION authorize_virtual_gateway_credential(p_gateway_id uuid) :: COMMENT
--

COMMENT ON FUNCTION public.authorize_virtual_gateway_credential(p_gateway_id uuid) IS 'Gate for minting a VIRTUAL gateway''s broker credential: checks has_role(), refuses a physical or archived gateway, and returns the generated sparkplug_id the account must be named after. The mirror of issue_gateway_enrollment_token(), which refuses exactly the gateways this accepts.';

--

-- capped_capture_manifest(jsonb) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.capped_capture_manifest(p_manifest jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public'
    AS $$
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
$$;

--

-- clear_credential_revoked_on_enrolment() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.clear_credential_revoked_on_enrolment() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.is_archived IS FALSE AND COALESCE(OLD.is_archived, false) IS TRUE THEN
    NEW.credential_revoked_at := NULL;
  END IF;
  RETURN NEW;
END $$;

--

-- cold_storage_rows() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.cold_storage_rows() RETURNS TABLE(chunk_name text, range_start timestamp with time zone, range_end timestamp with time zone, row_count bigint, object_key text, object_bytes bigint, state text, on_cold_storage boolean, claimed_at timestamp with time zone, dropped_at timestamp with time zone, last_error text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
    -- Gated on the same three roles the bucket admits (`telemetry_archive_read_privileged` in
    -- supabase/storage-policies.sql), checked here because a hidden tab is not a gate and this
    -- function is SECURITY DEFINER.
    SELECT m.chunk_name,
           m.range_start,
           m.range_end,
           m.row_count,
           m.object_key,
           m.object_bytes,
           CASE
               WHEN m.dropped_at  IS NOT NULL THEN 'archived'
               WHEN m.verified_at IS NOT NULL THEN 'verified'
               WHEN m.exported_at IS NOT NULL THEN 'exported'
               WHEN m.last_error  IS NOT NULL THEN 'failed'
               ELSE 'claimed'
           END AS state,
           m.dropped_at IS NOT NULL AS on_cold_storage,
           m.claimed_at,
           m.dropped_at,
           m.last_error
      FROM timescale.telemetry_archive_manifest m
     WHERE public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Auditor'])
     ORDER BY m.range_start DESC;
$$;

--

-- FUNCTION cold_storage_rows() :: COMMENT
--

COMMENT ON FUNCTION public.cold_storage_rows() IS 'The cold telemetry catalogue, read over the FDW from the historian''s manifest. `state` is derived here so no consumer re-implements the claimed->exported->verified->dropped ordering that timescaledb/cold_archive.sql enforces with CHECK constraints.';

--

-- consume_gateway_enrollment_token(text) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.consume_gateway_enrollment_token(p_token text) RETURNS TABLE(gateway_id uuid, sparkplug_id text, sparkplug_group text, gateway_name text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_hash       text;
  v_gateway_id uuid;
BEGIN
  -- Shape-checked before it is hashed, so a malformed value cannot reach the index at all.
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;

  v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  -- An archived gateway is decommissioned: there is no appliance it is legitimate to hand a
  -- credential to. A refused token is not burned: the UPDATE matches nothing, `consumed_at` stays
  -- NULL, and the row remains for the trigger to withdraw or to expire on its own.
  UPDATE public.gateway_enrollment_tokens t
     SET consumed_at = now()
    FROM public.gateways g
   WHERE t.token_hash = v_hash
     AND t.consumed_at IS NULL
     AND t.expires_at > now()
     AND g.id = t.gateway_id
     AND NOT g.is_archived
  RETURNING t.gateway_id INTO v_gateway_id;

  IF v_gateway_id IS NULL THEN
    RETURN;
  END IF;

  -- The identity the appliance needs on the wire. `sparkplug_id` is the generated column the ACL
  -- pins the topic's edge-node segment to, and `sparkplug_group` is the other half of the address
  -- resolve_gateway() looks up first -- an appliance told only the node id falls through to the
  -- group-agnostic arm, which works until two groups exist.
  RETURN QUERY
  SELECT g.id, g.sparkplug_id, g.sparkplug_group, g.name
    FROM public.gateways g
   WHERE g.id = v_gateway_id;
END $_$;

--

-- FUNCTION consume_gateway_enrollment_token(p_token text) :: COMMENT
--

COMMENT ON FUNCTION public.consume_gateway_enrollment_token(p_token text) IS 'Atomically claim a live enrolment token and return the gateway''s wire identity. Returns NO ROWS for an unknown, expired, already-consumed token or an ARCHIVED gateway (0037) -- the four are deliberately indistinguishable. Called by the enroll-gateway edge function with the service-role key; the token itself is the authorisation, so no role is checked.';

--

-- create_service_principal(text, text) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.create_service_principal(p_role_name text, p_note text DEFAULT NULL::text) RETURNS TABLE(principal_id uuid, roles text[])
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  -- Read-only roles only. See the header: a machine identity holding a privileged role becomes an
  -- unrevocable write credential the moment a token is signed for it.
  c_allowed  CONSTANT text[] := ARRAY['Operator', 'Auditor'];
  v_role_id  integer;
  v_id       uuid;
BEGIN
  -- ADMINISTRATOR ONLY, matching list_service_principals() (0042) and narrower than the credential
  -- RPCs in 0041. Creating an identity that can reach the stack is an access-control act, and
  -- `authz:manage` is granted to Administrator alone.
  IF NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'insufficient privileges to create a service principal'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_role_name IS NULL OR NOT (p_role_name = ANY(c_allowed)) THEN
    RAISE EXCEPTION
      'create_service_principal: role must be one of %, got %. A machine identity holding a '
      'privileged role would be an unrevocable write credential once a token is signed for it.',
      array_to_string(c_allowed, ', '), coalesce(p_role_name, 'null')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- BY NAME, not by a hardcoded id -- 0034's reasoning: `roles.id` is an integer assigned by 0001,
  -- and a migration that hardcodes it is asserting a fact about a sequence.
  SELECT id INTO v_role_id FROM public.roles WHERE name = p_role_name;
  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'create_service_principal: the % role does not exist', p_role_name
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- A NOTE IS BOUNDED. It reaches the audit row below, which is append-only and cannot be pruned.
  IF p_note IS NOT NULL AND length(p_note) > 200 THEN
    RAISE EXCEPTION 'create_service_principal: p_note must be 200 characters or fewer'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_id := gen_random_uuid();

  -- ONLY `id`. See the header -- this is what makes the account unable to sign in, and it is a
  -- property of the INSERT rather than of anybody's intent.
  INSERT INTO auth.users (id) VALUES (v_id);
  INSERT INTO public.user_roles (user_id, role_id) VALUES (v_id::text, v_role_id);

  -- RECORDED HERE, AND ATTRIBUTED TO A PERSON, which is the one way this differs from 0043. That
  -- function is called by a host script holding a machine credential and cannot name anybody; this
  -- one is called by an Administrator with a session, so `auth.uid()` is the attribution rather
  -- than a claim -- the same reasoning as 0041's record_gateway_credential_issued().
  INSERT INTO public.digital_thread (
    entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
    causation_id, recorded_at
  ) VALUES (
    'service_principals',
    v_id,
    'INSERT',
    NULL,
    jsonb_build_object(
      'roles',       to_jsonb(ARRAY[p_role_name]),
      'note',        p_note,
      'can_sign_in', false
    ),
    auth.uid(),
    'user',
    txid_current(),
    now()
  );

  RETURN QUERY SELECT v_id, ARRAY[p_role_name];
END;
$$;

--

-- FUNCTION create_service_principal(p_role_name text, p_note text) :: COMMENT
--

COMMENT ON FUNCTION public.create_service_principal(p_role_name text, p_note text) IS 'Create a machine identity that cannot sign in, holding one read-only role. Administrator only. Writes to auth.users the way 0034 does -- id alone, so the account has no email, no password and no identity provider. Refuses a privileged role: once a token is signed for a principal it cannot be revoked.';

--

-- custom_access_token_hook(jsonb) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  claims jsonb;
  role_name text;
BEGIN
  SELECT r.name INTO role_name
  FROM public.user_roles ur
  JOIN public.roles r ON r.id = ur.role_id
  WHERE ur.user_id = (event->>'user_id')
  LIMIT 1;

  claims := event->'claims';

  IF role_name IS NOT NULL THEN
    claims := jsonb_set(
      COALESCE(claims, '{}'::jsonb),
      '{app_metadata,role}',
      to_jsonb(role_name),
      true
    );
  END IF;

  RETURN jsonb_set(event, '{claims}', claims, true);
END;
$$;

--

-- digital_thread_page(integer, boolean, text, text, uuid[], timestamp with time zone, timestamp with time zone) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.digital_thread_page(p_limit integer DEFAULT 200, p_include_purged boolean DEFAULT false, p_entity_type text DEFAULT NULL::text, p_action text DEFAULT NULL::text, p_entity_ids uuid[] DEFAULT NULL::uuid[], p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
WITH matching AS (
    SELECT t.*,
           -- Scoped to the three asset types: only entity types that name one of those tables can be
           -- purged from it. `service_principals` is an auth.users row with no public table to probe and
           -- would otherwise answer "absent from all three" and be hidden as deleted.
           t.entity_type IN ('cells', 'gateways', 'devices')
       AND NOT EXISTS (SELECT 1 FROM public.cells    c WHERE c.id = t.entity_id)
       AND NOT EXISTS (SELECT 1 FROM public.gateways g WHERE g.id = t.entity_id)
       AND NOT EXISTS (SELECT 1 FROM public.devices  d WHERE d.id = t.entity_id)
               AS is_purged
      FROM public.digital_thread t
     WHERE (p_entity_type IS NULL OR t.entity_type = p_entity_type)
       AND (p_action      IS NULL OR t.action      = p_action)
       AND (p_entity_ids  IS NULL OR t.entity_id   = ANY (p_entity_ids))
       AND (p_since       IS NULL OR t.recorded_at >= p_since)
       AND (p_until       IS NULL OR t.recorded_at <= p_until)
),
visible AS (
    SELECT * FROM matching
     WHERE p_include_purged OR NOT is_purged
     ORDER BY recorded_at DESC
     LIMIT greatest(1, least(coalesce(p_limit, 200), 1000))
)
SELECT jsonb_build_object(
    'events', coalesce(
        (SELECT jsonb_agg(to_jsonb(v) - 'is_purged' ORDER BY v.recorded_at DESC) FROM visible v),
        '[]'::jsonb),
    'purged_assets', (SELECT count(DISTINCT entity_id) FROM matching WHERE is_purged),
    'truncated', (SELECT count(*) FROM visible) >= greatest(1, least(coalesce(p_limit, 200), 1000))
);
$$;

--

-- FUNCTION digital_thread_page(p_limit integer, p_include_purged boolean, p_entity_type text, p_action text, p_entity_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone) :: COMMENT
--

COMMENT ON FUNCTION public.digital_thread_page(p_limit integer, p_include_purged boolean, p_entity_type text, p_action text, p_entity_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone) IS 'One page of the Digital Thread, with deleted assets filtered server-side and counted over the whole match rather than the page. `is_purged` applies only to cells, gateways and devices -- an entity type with no table behind it cannot have been deleted from one.';

--

-- directory_liveness_job_map() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.directory_liveness_job_map() RETURNS TABLE(prometheus_job text, service_name text)
    LANGUAGE sql IMMUTABLE
    AS $$
    SELECT * FROM (VALUES
        ('prometheus',    'Prometheus Metrics Store'),
        ('grafana',       'Grafana Dashboards'),
        ('ingestion',     'Ingestion Metrics Endpoint'),
        ('node',          'Host Metrics Exporter (node_exporter)'),
        ('envoy',         'Supabase API Gateway (Envoy)'),
        ('supabase-rest', 'Supabase PostgREST API')
    ) AS t(prometheus_job, service_name);
$$;

--

-- FUNCTION directory_liveness_job_map() :: COMMENT
--

COMMENT ON FUNCTION public.directory_liveness_job_map() IS 'Prometheus scrape job -> directory_services.service_name, for the six services whose liveness is genuinely observed. Everything not named here is written UNKNOWN.';

--

-- dispatch_device_quarantine_webhook() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.dispatch_device_quarantine_webhook() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'vault'
    AS $$
DECLARE
  ep          RECORD;
  hdrs        JSONB;
  signing_key TEXT;
  issued_at   INT;
BEGIN
  FOR ep IN
    SELECT * FROM public.webhook_endpoints
    WHERE event_key = 'device.quarantined' AND is_enabled
  LOOP
    hdrs := jsonb_build_object('Content-Type', 'application/json');

    IF ep.secret_name IS NOT NULL THEN
      SELECT decrypted_secret INTO signing_key
      FROM vault.decrypted_secrets
      WHERE name = ep.secret_name;

      -- Only attach credentials when there are any. A stack mid-upgrade, or one whose
      -- NODERED_WEBHOOK_JWT_SECRET is unset, stores nothing -- and sending a literal "Bearer "
      -- would be worse than sending nothing. Node-RED refuses either way; this keeps the
      -- failure legible in its log rather than as a malformed header.
      IF signing_key IS NOT NULL AND signing_key <> '' THEN
        issued_at := extract(epoch FROM NOW())::INT;

        -- A CAPABILITY, NOT AN IDENTITY. `aud` and `scope` are what settings.js checks, and
        -- they authorise exactly one thing: posting to the quarantine hook. The 60-second life
        -- is what makes it safe for a flow to be able to read it out of msg.req.headers.
        hdrs := hdrs || jsonb_build_object(
          'Authorization',
          'Bearer ' || extensions.sign(
            json_build_object(
              'iss',   'acs-cymru-supabase',
              'aud',   'node-red-hooks',
              'sub',   'webhook:device.quarantined',
              'scope', 'hooks:quarantine',
              'iat',   issued_at,
              'exp',   issued_at + 60
            ),
            signing_key,
            'HS256'
          )
        );
      END IF;
    END IF;

    PERFORM net.http_post(
      url     := ep.url,
      headers := hdrs,
      body    := jsonb_build_object(
        'event',             'device.quarantined',
        'device_id',         NEW.id,
        -- The identifier an operator can actually match against MQTT and TimescaleDB.
        'sparkplug_id',      NEW.sparkplug_id,
        'name',              NEW.name,
        'gateway_id',        NEW.gateway_id,
        'reported_identity', NEW.reported_identity,
        'quarantine_reason', NEW.quarantine_reason,
        'identity_source',   NEW.identity_source,
        'occurred_at',       NOW()
      ),
      timeout_milliseconds := 3000
    );
  END LOOP;

  RETURN NULL;  -- AFTER trigger; return value is ignored
END $$;

--

-- enforce_digital_thread_append_only() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.enforce_digital_thread_append_only() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  -- Scope: a trigger cannot constrain a role that can issue DDL (`postgres`, `supabase_admin`).
  -- What it closes is every path over PostgREST, including `service_role`, which cannot execute
  -- DDL. Clearing audit rows therefore requires a genuine administrative connection.
  IF current_user IN ('postgres', 'supabase_admin') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  RAISE EXCEPTION
    'public.digital_thread is append-only: % is not permitted (attempted by role %)',
    TG_OP, current_user
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Audit rows are written only by log_digital_thread_event(). Correcting history '
                 'is not a supported operation; record a compensating change instead.';
END;
$$;

--

-- FUNCTION enforce_digital_thread_append_only() :: COMMENT
--

COMMENT ON FUNCTION public.enforce_digital_thread_append_only() IS 'Rejects UPDATE and DELETE on public.digital_thread for every application role, including service_role. Owner roles are exempt because they can drop the trigger anyway.';

--

-- enforce_metric_catalog_immutability() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.enforce_metric_catalog_immutability() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name OR NEW.datatype IS DISTINCT FROM OLD.datatype THEN
    RAISE EXCEPTION 'metric_catalog.name and .datatype are immutable once created; deprecate this entry and create a new one instead';
  END IF;
  RETURN NEW;
END;
$$;

--

-- enforce_metric_group_spelling() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.enforce_metric_group_spelling() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  incoming_group TEXT;
  canonical TEXT;
BEGIN
  -- Derived from NEW.name rather than read from NEW.metric_group: generated columns are computed
  -- *after* BEFORE triggers run, so NEW.metric_group is still NULL at this point. Keep this
  -- expression identical to the generated column in migration 0016.
  incoming_group := CASE WHEN strpos(NEW.name, '/') > 0
                         THEN NULLIF(split_part(NEW.name, '/', 1), '') END;

  IF incoming_group IS NULL THEN
    RETURN NEW;  -- Ungrouped metrics are permitted; the convention is encouraged, not required.
  END IF;

  -- Checked against both the registry and the groups already in use, so a group that entered the
  -- catalog without being registered still governs the spelling of everything that follows it.
  SELECT known.name INTO canonical
    FROM (
      SELECT name FROM public.metric_groups
      UNION
      SELECT DISTINCT metric_group FROM public.metric_catalog WHERE metric_group IS NOT NULL
    ) AS known
   WHERE lower(known.name) = lower(incoming_group)
     AND known.name <> incoming_group
   LIMIT 1;

  IF canonical IS NOT NULL THEN
    RAISE EXCEPTION
      'metric group ''%'' differs only in case from the existing group ''%''. Metric names are '
      'immutable, so allowing both would permanently fork the taxonomy. Name this metric ''%/%'' '
      'instead.',
      incoming_group, canonical, canonical, substr(NEW.name, length(incoming_group) + 2);
  END IF;

  RETURN NEW;
END;
$$;

--

-- enforce_schema_version_provenance() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.enforce_schema_version_provenance() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  -- Same role split as the guard above: migrations seed rows directly and fork_schema() runs as
  -- the owner, so both are past this. What it stops is the only remaining path -- a PostgREST
  -- client POSTing a row that names its own version or parent, which is how "auto-incremented"
  -- would otherwise be a UI convention rather than a database fact.
  IF current_user NOT IN ('authenticated', 'anon', 'service_role') THEN
    RETURN NEW;
  END IF;

  IF NEW.version <> 1 OR NEW.parent_schema_id IS NOT NULL THEN
    RAISE EXCEPTION
      'a schema version cannot be created directly; use fork_schema() to derive v% from its parent',
      NEW.version
      USING ERRCODE = 'check_violation',
            HINT = 'Direct inserts always start a new lineage at v1.';
  END IF;

  RETURN NEW;
END;
$$;

--

-- ensure_cron_job(text, text, text) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.ensure_cron_job(p_name text, p_schedule text, p_command text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'cron'
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = p_name) THEN
    PERFORM cron.unschedule(p_name);
  END IF;
  PERFORM cron.schedule(p_name, p_schedule, p_command);
END $$;

--

-- FUNCTION ensure_cron_job(p_name text, p_schedule text, p_command text) :: COMMENT
--

COMMENT ON FUNCTION public.ensure_cron_job(p_name text, p_schedule text, p_command text) IS 'Unschedule-then-schedule, so replaying this migration does not accumulate duplicate jobs.';

--

-- ensure_gateway_status_view() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.ensure_gateway_status_view() RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  DROP VIEW IF EXISTS public.gateway_status;

  -- security_invoker is load-bearing. Without it the view executes as its owner (postgres)
  -- and silently bypasses the RLS on public.gateways, exposing every gateway to any role
  -- holding SELECT on the view. With it, each caller's own policies apply exactly as on the
  -- base table. Requires PG15+; this stack is on supabase/postgres 17.6.
  CREATE VIEW public.gateway_status
  WITH (security_invoker = true) AS
  SELECT
    g.*,
    -- Mirrors gatewayLiveStatus(): the ENROLMENT states win outright (a gateway mid-installation is
    -- not a fault), then a stored OFFLINE (an explicit NDEATH is not staleness), then a gateway that
    -- has never reported keeps its stored status, and anything else ages out.
    CASE
      WHEN g.status IN ('PENDING_ENROLLMENT', 'AWAITING_BIRTH')      THEN g.status
      WHEN g.status = 'OFFLINE'                                      THEN 'OFFLINE'
      WHEN g.last_heartbeat IS NULL                                  THEN g.status
      WHEN NOW() - g.last_heartbeat > INTERVAL '90 seconds'          THEN 'STALE'
      ELSE g.status
    END AS live_status,
    -- Mirrors isHeartbeatStale(): a gateway that has never reported is NOT stale (false),
    -- which is why this is not simply `live_status = 'STALE'`.
    (g.last_heartbeat IS NOT NULL
     AND NOW() - g.last_heartbeat > INTERVAL '90 seconds')           AS is_stale,
    EXTRACT(EPOCH FROM (NOW() - g.last_heartbeat))::BIGINT           AS heartbeat_age_seconds
  FROM public.gateways g;

  COMMENT ON VIEW public.gateway_status IS
    'public.gateways with heartbeat staleness derived at read time. Mirrors '
    'frontend/src/utils/gatewayStatus.js -- keep the 90s threshold AND the pending-state '
    'short-circuit in step. Deliberately a view, not a stored column or a pg_cron writer: writing '
    'status would append to the immutable digital_thread audit table on every sweep and would be '
    'stale between ticks. Rebuilt by public.ensure_gateway_status_view() -- call it after adding a '
    'gateways column.';

  -- DROP VIEW discards the grants with the view, so they are re-applied here rather than
  -- left outside the function where they would silently stop being re-run.
  REVOKE ALL ON public.gateway_status FROM PUBLIC, anon, authenticated;
  GRANT SELECT ON public.gateway_status TO authenticated;
END $$;

--

-- FUNCTION ensure_gateway_status_view() :: COMMENT
--

COMMENT ON FUNCTION public.ensure_gateway_status_view() IS 'Drop-and-recreate public.gateway_status. Called here and by any later migration that adds a column to public.gateways -- the view selects g.*, which CREATE OR REPLACE VIEW cannot widen in place once a new column lands ahead of the derived ones.';

--

-- ensure_shadow_devices(uuid) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.ensure_shadow_devices(p_capture_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_capture   public.captures;
    v_gateway   public.gateways;
    v_wire_id   text;
    v_origin    public.devices;
    v_shadow_id uuid;
    v_map       jsonb := '{}'::jsonb;
BEGIN
    IF NOT public.may_manage_captures() THEN
        RAISE EXCEPTION
          'ensure_shadow_devices: creating playback lanes requires Administrator or '
          'Shopfloor_Manager'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_capture FROM public.captures WHERE id = p_capture_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ensure_shadow_devices: no capture %', p_capture_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- THE SINGLE SHADOW GATEWAY, found by its flag rather than by the pinned id above. An operator
    -- may legitimately want a second one -- two playbacks at once need two edge nodes, since
    -- playback_jobs allows only one RUNNING per target -- and looking it up by flag means that
    -- works without this function being edited. More than one is ambiguous and says so.
    SELECT * INTO v_gateway FROM public.gateways
     WHERE is_shadow AND NOT is_archived
     ORDER BY created_at
     LIMIT 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION
          'ensure_shadow_devices: this stack has no playback gateway. One is seeded by migration '
          '0060; if it was archived, restore it or mark another gateway is_shadow.'
            USING ERRCODE = 'no_data_found';
    END IF;

    FOR v_wire_id IN
        SELECT jsonb_array_elements_text(coalesce(v_capture.manifest -> 'device_ids', '[]'::jsonb))
    LOOP
        SELECT * INTO v_origin FROM public.devices WHERE sparkplug_id = v_wire_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION
              'ensure_shadow_devices: the capture records device %, which this stack does not '
              'know. A playback lane stands in for a real machine, and there is none here to '
              'stand in for.', v_wire_id
                USING ERRCODE = 'foreign_key_violation';
        END IF;

        -- THE ORIGINAL MAY ITSELF BE A SHADOW if someone captured a playback. Refused: the lane
        -- already exists and is the one to replay onto, and a shadow of a shadow is a chain whose
        -- far end nobody can name.
        IF v_origin.shadow_of IS NOT NULL THEN
            RAISE EXCEPTION
              'ensure_shadow_devices: % is itself a playback lane. Replay onto it directly rather '
              'than shadowing it.', v_origin.name
                USING ERRCODE = 'check_violation';
        END IF;

        SELECT id INTO v_shadow_id FROM public.devices
         WHERE gateway_id = v_gateway.id AND shadow_of = v_origin.id;

        IF NOT FOUND THEN
            INSERT INTO public.devices (
                name, gateway_id, shadow_of, status, schema_id, conformance_policy, description
            ) VALUES (
                left(v_origin.name, 96) || ' (replay)',
                v_gateway.id,
                v_origin.id,
                'OFFLINE',
                -- THE CONTRACT, COPIED. See this migration's header: without it a replay is either
                -- unjudged or wholly rejected, and both look like a broken capture.
                v_origin.schema_id,
                v_origin.conformance_policy,
                'Replays recordings of ' || v_origin.name || '. Not a machine: its readings are '
                'genuine but were observed elsewhere, at another time.'
            )
            RETURNING id INTO v_shadow_id;

            -- The many-to-many half of the same contract. `device_schemas` unions this with
            -- devices.schema_id, so copying only one of the two silently narrows what the shadow
            -- is judged against for every device provisioned with submodels.
            INSERT INTO public.device_submodels (device_id, schema_id, submodel_key)
            SELECT v_shadow_id, ds.schema_id, ds.submodel_key
              FROM public.device_submodels ds
             WHERE ds.device_id = v_origin.id;
        END IF;

        v_map := v_map || jsonb_build_object(
            v_wire_id,
            (SELECT sparkplug_id FROM public.devices WHERE id = v_shadow_id)
        );
    END LOOP;

    IF v_map = '{}'::jsonb THEN
        RAISE EXCEPTION
          'ensure_shadow_devices: capture % names no devices, so there is nothing to replay as. A '
          'gateway-scoped capture that recorded only node-level messages has no device data in it.',
          p_capture_id
            USING ERRCODE = 'no_data_found';
    END IF;

    RETURN v_map;
END;
$$;

--

-- FUNCTION ensure_shadow_devices(p_capture_id uuid) :: COMMENT
--

COMMENT ON FUNCTION public.ensure_shadow_devices(p_capture_id uuid) IS 'Find or create one shadow device per device named in a capture''s manifest, bound to the playback gateway, and return the device map start_playback_job() takes. Reuses an existing lane rather than minting per playback, so a comparison chart holds still between runs. Copies the metric contract (schema_id and device_submodels) and nothing else -- notably not the nameplate, whose serial number identifies one physical object. See 0060''s header.';

--

-- fork_schema(uuid, text) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.fork_schema(parent_schema_id uuid, change_description text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  -- Copied out of the parameters immediately, and the parameters never referenced again. Both are
  -- named after columns of `schemas` -- which is what the brief specifies and what the RPC's JSON
  -- body must use -- and plpgsql would raise "column reference is ambiguous" on the first
  -- `WHERE id = parent_schema_id`. A DECLARE initialiser has no table in scope, so the copy is
  -- unambiguous.
  v_parent_id  UUID := parent_schema_id;
  v_change     TEXT := NULLIF(btrim(COALESCE(change_description, '')), '');
  parent       public.schemas%ROWTYPE;
  child        public.schemas%ROWTYPE;
  v_base       TEXT;
  v_next       INTEGER;
  v_name       TEXT;
  v_suffix     INTEGER := 1;
BEGIN
  -- Fail closed, and check authority before anything else observable happens. Same allow-list as
  -- the RLS write policies on `schemas` and as approve-quarantine: forking is a schema-management
  -- act, so it carries schema-management authority.
  IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'insufficient privileges to version a schema'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_parent_id IS NULL THEN
    RAISE EXCEPTION 'parent_schema_id is required' USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- FOR UPDATE, not a bare SELECT: two operators forking the same schema at the same moment would
  -- otherwise both read version N and both insert N+1. The partial unique index catches the
  -- collision either way, but the lock turns a confusing constraint violation into a wait.
  SELECT * INTO parent FROM public.schemas WHERE id = v_parent_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'schema % not found', v_parent_id USING ERRCODE = 'no_data_found';
  END IF;

  -- Only the head of a lineage may be forked. Forking an archived version would produce a second
  -- claimant to the same version number, and forking a draft would branch something that has never
  -- been in force -- edit the draft instead, which is what a draft is for.
  IF parent.status <> 'active' THEN
    RAISE EXCEPTION 'only an active schema can be versioned; "%" is %', parent.schema_name, parent.status
      USING ERRCODE = 'check_violation',
            HINT = 'Fork the active version of this lineage.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.schemas s
              WHERE s.parent_schema_id = v_parent_id AND s.status = 'draft') THEN
    RAISE EXCEPTION 'a draft version of "%" already exists; publish or delete it first', parent.schema_name
      USING ERRCODE = 'unique_violation';
  END IF;

  v_next := parent.version + 1;
  v_base := public.schema_version_base_name(parent.schema_name);
  v_name := v_base || '_v' || v_next;

  -- A discarded draft leaves its name behind, so the obvious one can already be taken. Suffixing
  -- beats failing: the operator asked for a version, not for a naming negotiation.
  WHILE EXISTS (SELECT 1 FROM public.schemas s WHERE s.schema_name = v_name) LOOP
    v_suffix := v_suffix + 1;
    v_name := v_base || '_v' || v_next || '_' || v_suffix;
  END LOOP;

  -- THE METRIC LINKS ARE THE DEFINITION. There is no `schema_metrics` table in this database --
  -- a schema's membership of the catalog lives in `schema_definition.properties` / `.required`,
  -- which is what `modelledMetrics()` in deviceTags.js and its Python mirror in validate.py both
  -- read. Copying the JSONB document IS duplicating the parent's metric links; a join table would
  -- have to be copied row by row here instead.
  INSERT INTO public.schemas (
    schema_name, description, schema_definition,
    semantic_id, semantic_id_type,
    version, parent_schema_id, status, change_description
  ) VALUES (
    v_name, parent.description, parent.schema_definition,
    parent.semantic_id, parent.semantic_id_type,
    v_next, parent.id, 'draft', v_change
  )
  RETURNING * INTO child;

  RETURN to_jsonb(child);
END;
$$;

--

-- FUNCTION fork_schema(parent_schema_id uuid, change_description text) :: COMMENT
--

COMMENT ON FUNCTION public.fork_schema(parent_schema_id uuid, change_description text) IS 'Derives the next draft version of an active schema, copying its definition. The version number is computed, never supplied.';

SET default_tablespace = '';

SET default_table_access_method = heap;

--

-- gateways :: TABLE
--

CREATE TABLE IF NOT EXISTS public.gateways (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    cell_id uuid,
    access_url text,
    status text DEFAULT 'OFFLINE'::text,
    created_at timestamp with time zone DEFAULT now(),
    is_archived boolean DEFAULT false,
    archived_at timestamp with time zone,
    auto_delete_at timestamp with time zone,
    last_heartbeat timestamp with time zone,
    is_virtual boolean DEFAULT false NOT NULL,
    sparkplug_id text GENERATED ALWAYS AS (('gwy'::text || substr(encode(uuid_send(id), 'hex'::text), 1, 21))) STORED,
    location_scope text DEFAULT 'cell'::text NOT NULL,
    sparkplug_group text DEFAULT 'ACS-Cymru'::text NOT NULL,
    description text,
    enrolled_at timestamp with time zone,
    agent_version text,
    health_reported_at timestamp with time zone,
    uptime_seconds bigint,
    load_1m real,
    mem_available_bytes bigint,
    disk_free_bytes bigint,
    cert_expires_at timestamp with time zone,
    flow_hash text,
    credential_revoked_at timestamp with time zone,
    is_simulated boolean DEFAULT false NOT NULL,
    is_shadow boolean DEFAULT false NOT NULL,
    deployment text NOT NULL,
    CONSTRAINT gateways_deployment_valid CHECK ((deployment = ANY (ARRAY['host'::text, 'remote'::text]))),
    CONSTRAINT gateways_location_scope_valid CHECK ((location_scope = ANY (ARRAY['cell'::text, 'site_wide'::text]))),
    CONSTRAINT gateways_shadow_is_simulated CHECK (((NOT is_shadow) OR is_simulated)),
    CONSTRAINT gateways_simulated_is_host CHECK (((NOT is_simulated) OR (deployment = 'host'::text))),
    CONSTRAINT gateways_site_wide_has_no_cell CHECK (((location_scope <> 'site_wide'::text) OR (cell_id IS NULL))),
    CONSTRAINT gateways_sparkplug_group_format CHECK (((sparkplug_group <> ''::text) AND (sparkplug_group !~ '[/+#]'::text))),
    CONSTRAINT gateways_synthetic_has_no_cell CHECK ((((NOT is_simulated) AND (NOT is_shadow)) OR (cell_id IS NULL)))
);

ALTER TABLE ONLY public.gateways REPLICA IDENTITY FULL;

--

-- COLUMN gateways.status :: COMMENT
--

COMMENT ON COLUMN public.gateways.status IS 'Free text, deliberately unconstrained -- a Gateway_Status metric in an NBIRTH payload overrides whatever the message type implies, so the domain is not closed. The values this platform writes are: PENDING_ENROLLMENT (a physical gateway awaiting its bundle redemption), AWAITING_BIRTH (enrolled, holds a credential, has not yet published), ONLINE and OFFLINE (written by the ingestion daemon from node-level Sparkplug messages). STALE is DERIVED at read time by public.gateway_status and is never stored.';

--

-- COLUMN gateways.last_heartbeat :: COMMENT
--

COMMENT ON COLUMN public.gateways.last_heartbeat IS 'When the ingestion daemon last received a Sparkplug B node-level message (NBIRTH/NDATA/NDEATH) from this edge node -- receipt time, not the payload timestamp, so it stays comparable with server time regardless of edge clock drift. NULL means no heartbeat has ever arrived.';

--

-- COLUMN gateways.is_virtual :: COMMENT
--

COMMENT ON COLUMN public.gateways.is_virtual IS 'RETIRED. Nothing reads this column: `deployment` (0064) carries the question it was being asked -- where the connector runs -- with one meaning instead of three. It is still written, by sync_gateway_deployment(), so it cannot drift into being wrong; it is not dropped because 0036 names it in a function signature and calls that function in its own self-check, and every migration replays on every boot. Remove it at the next baseline squash, with 0066.';

--

-- COLUMN gateways.sparkplug_id :: COMMENT
--

COMMENT ON COLUMN public.gateways.sparkplug_id IS 'Immutable Sparkplug B edge node id, derived from the primary key. This is what appears in the MQTT topic (spBv1.0/<group>/<TYPE>/<sparkplug_id>). Never editable; rename the gateway freely without affecting ingestion.';

--

-- COLUMN gateways.location_scope :: COMMENT
--

COMMENT ON COLUMN public.gateways.location_scope IS '''cell'' or ''site_wide''. A site-wide gateway -- typically is_virtual -- is a host-level proxy with no physical cell. Scope is not inherited by its devices; they resolve to Unassigned until an operator files them.';

--

-- COLUMN gateways.sparkplug_group :: COMMENT
--

COMMENT ON COLUMN public.gateways.sparkplug_group IS 'Sparkplug B Group ID -- the second topic segment. With sparkplug_id it forms the edge node address Factory+ resolves as (group, node). Editable: unlike sparkplug_id it is a configuration choice, not an issued identity.';

--

-- COLUMN gateways.description :: COMMENT
--

COMMENT ON COLUMN public.gateways.description IS 'Optional operator note. Free text, carries no semantics, and is read by nothing.';

--

-- COLUMN gateways.enrolled_at :: COMMENT
--

COMMENT ON COLUMN public.gateways.enrolled_at IS 'When this gateway last redeemed an enrolment token and received a broker credential. NULL for a virtual gateway and for a physical one that has never enrolled. Re-enrolment overwrites it.';

--

-- COLUMN gateways.agent_version :: COMMENT
--

COMMENT ON COLUMN public.gateways.agent_version IS 'Version stamp of the bundle the appliance is running. Written at enrolment and REFRESHED from the Agent_Version metric on every node-level message that carries one, so an appliance upgraded in place is visible without re-enrolment. Lets the fleet''s vintage be seen without reaching into every appliance. NULL for a virtual gateway and for one that has never enrolled.';

--

-- COLUMN gateways.health_reported_at :: COMMENT
--

COMMENT ON COLUMN public.gateways.health_reported_at IS 'When a node-level message last carried at least one recognised health metric. Distinct from last_heartbeat, which moves on every node-level message including those carrying none: NULL here alongside a recent last_heartbeat means the appliance is alive on a bundle that does not report health, which is a different situation from one that has stopped reporting it.';

--

-- COLUMN gateways.uptime_seconds :: COMMENT
--

COMMENT ON COLUMN public.gateways.uptime_seconds IS 'Seconds since the appliance''s Node-RED runtime started, from the Uptime_s metric. Process uptime, not host uptime -- a restarted container resets it while the machine stays up.';

--

-- COLUMN gateways.load_1m :: COMMENT
--

COMMENT ON COLUMN public.gateways.load_1m IS 'Host 1-minute load average, from node_exporter''s node_load1 via the Load_1m metric. Not normalised by core count, so compare a gateway against itself over time rather than against another gateway.';

--

-- COLUMN gateways.mem_available_bytes :: COMMENT
--

COMMENT ON COLUMN public.gateways.mem_available_bytes IS 'Host MemAvailable in bytes, from node_exporter''s node_memory_MemAvailable_bytes. Available, not free: it counts reclaimable cache, which is the number that predicts whether an allocation will succeed.';

--

-- COLUMN gateways.disk_free_bytes :: COMMENT
--

COMMENT ON COLUMN public.gateways.disk_free_bytes IS 'Free bytes on the appliance''s root filesystem, from node_exporter''s node_filesystem_avail_bytes. The metric that earns the collector: an appliance that fills its disk stops publishing and reports nothing about why.';

--

-- COLUMN gateways.cert_expires_at :: COMMENT
--

COMMENT ON COLUMN public.gateways.cert_expires_at IS 'notAfter of the CA this appliance trusts for the broker, reported by the appliance itself. The CA is hand-distributed into every appliance''s trust store, so re-minting it takes the whole fleet offline at once with no other signal -- this is what makes that a dated warning instead of an outage. Reported, not observed: it is what the appliance HAS, which is the question.';

--

-- COLUMN gateways.flow_hash :: COMMENT
--

COMMENT ON COLUMN public.gateways.flow_hash IS 'SHA-256 of the flow this appliance was provisioned with, computed by its bootstrap at enrolment. Answers "which bundle''s flow is on that gateway" without a shell on it. It does NOT detect local edits: an operator who changes the flow in the Node-RED editor keeps reporting the hash of what was installed, because the appliance has no way to hash its own running flow without the admin API and a credential to call it with.';

--

-- COLUMN gateways.credential_revoked_at :: COMMENT
--

COMMENT ON COLUMN public.gateways.credential_revoked_at IS 'When this gateway''s broker credential was last rotated to a password nobody recorded, which is how this platform revokes. NULL on a gateway that is not archived, and on an archived one whose revocation has not yet succeeded -- the sweep in 0038 retries those. Set back to NULL by re-enrolment, because that issues a fresh working credential.';

--

-- COLUMN gateways.is_simulated :: COMMENT
--

COMMENT ON COLUMN public.gateways.is_simulated IS 'True when this gateway''s telemetry is generated rather than observed -- a broker playback target, or a simulator. Devices INHERIT this through their gateway_id and carry no flag of their own (see 0052''s header): the containment rules a stored device-level copy would need two triggers to maintain are given for nothing by the join. Distinct from is_virtual, which is about whether an edge appliance exists, not about whether the readings are real -- a physical appliance replaying a capture is virtual=false, simulated=true.';

--

-- COLUMN gateways.is_shadow :: COMMENT
--

COMMENT ON COLUMN public.gateways.is_shadow IS 'True when this gateway exists only to publish recorded captures -- its devices are replay lanes for real machines rather than machines. Implies is_simulated (a CHECK enforces it), and takes precedence over it in device_locations: the readings are genuine, so "replayed" is more informative than "synthetic". Devices INHERIT this through gateway_id and carry no flag of their own (see 0052).';

--

-- COLUMN gateways.deployment :: COMMENT
--

COMMENT ON COLUMN public.gateways.deployment IS 'Where this gateway''s connector runs: ''host'' (inside this stack) or ''remote'' (an edge appliance on the plant network). This is the axis every behaviour branching on is_virtual was actually about -- bundles, flow backups, enrolment. Kept in step with is_virtual by sync_gateway_deployment() until that column is retired.';

--

-- gateway_has_broker_credential(public.gateways) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.gateway_has_broker_credential(g public.gateways) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT
        (g.deployment = 'remote' AND g.enrolled_at IS NOT NULL)
     OR (g.deployment = 'host' AND EXISTS (
            SELECT 1 FROM public.digital_thread dt
             WHERE dt.entity_type = 'gateways'
               AND dt.entity_id   = g.id
               AND dt.action      = 'CREDENTIAL_ISSUED'
               AND (g.credential_revoked_at IS NULL OR dt.recorded_at > g.credential_revoked_at)
        ));
$$;

--

-- FUNCTION gateway_has_broker_credential(g public.gateways) :: COMMENT
--

COMMENT ON FUNCTION public.gateway_has_broker_credential(g public.gateways) IS 'Does an account exist at the broker for this gateway, by either route it can arrive -- a remote appliance completing enrolment, or the CREDENTIAL_ISSUED row a host-run mint leaves -- minus revocation. Cannot admit a gateway that never held one, which is what lets revocation use it without creating accounts through the add-only credential service (0063).';

--

-- gateway_health_rows() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.gateway_health_rows() RETURNS TABLE(sparkplug_id text, gateway_name text, live_status text, is_stale boolean, is_virtual boolean, heartbeat_age_seconds bigint, health_reported_at timestamp with time zone, health_age_seconds bigint, uptime_seconds bigint, load_1m real, mem_available_bytes bigint, disk_free_bytes bigint, cert_expires_at timestamp with time zone, cert_expires_in_days numeric, agent_version text, flow_hash text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
    SELECT
        g.sparkplug_id,
        g.name,
        g.live_status,
        g.is_stale,
        g.is_virtual,
        g.heartbeat_age_seconds,
        g.health_reported_at,
        EXTRACT(EPOCH FROM (now() - g.health_reported_at))::bigint,
        g.uptime_seconds,
        g.load_1m,
        g.mem_available_bytes,
        g.disk_free_bytes,
        g.cert_expires_at,
        -- DERIVED HERE SO THE ALERT RULE AND THE PANEL CANNOT DISAGREE. A rule computing its own
        -- day count from the timestamp, and a stat panel computing another, is two expressions to
        -- keep in step for one number an operator acts on. Fractional on purpose: rounding to
        -- whole days would make a threshold of 30 fire a day early or late depending on the hour.
        EXTRACT(EPOCH FROM (g.cert_expires_at - now())) / 86400.0,
        g.agent_version,
        g.flow_hash
      FROM public.gateway_status g
     -- A DECOMMISSIONED APPLIANCE IS NOT A FAULT. Archived gateways are excluded for the same
     -- reason 0029 excludes them from `gateway_stale`: showing them trains an operator to ignore
     -- the panel that is meant to be scanned.
     WHERE NOT g.is_archived
$$;

--

-- FUNCTION gateway_health_rows() :: COMMENT
--

COMMENT ON FUNCTION public.gateway_health_rows() IS 'One row per live gateway: its identity, its heartbeat freshness, and the appliance health it reports (0035). SECURITY DEFINER so the Grafana reader needs no privilege on `gateways`. Carries NOTHING about devices, cells or quarantine -- that inventory is the boundary 0029 drew and this does not cross it.';

--

-- gateway_holds_a_credential(public.gateways) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.gateway_holds_a_credential(g public.gateways) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$ SELECT g.deployment = 'remote' AND g.enrolled_at IS NOT NULL $$;

--

-- FUNCTION gateway_holds_a_credential(g public.gateways) :: COMMENT
--

COMMENT ON FUNCTION public.gateway_holds_a_credential(g public.gateways) IS 'True for a REMOTE appliance that completed enrolment, and false for everything else -- which includes every host-run gateway, whose credential leaves no enrolment behind. Ask gateway_has_broker_credential() instead when the question is "does an account exist at the broker": this one is about enrolment, and mistaking the two is what 0056, 0062 and 0063 each had to correct.';

--

-- handle_new_user() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  default_role_id   INT;
  default_role_name CONSTANT TEXT := 'Operator';
BEGIN
  -- Respect a role the caller already declared. GoTrue signup supplies only
  -- {"provider":"email","providers":["email"]}, whereas seed.sql personas and
  -- admin-provisioned users carry an explicit role. Without this guard the trigger
  -- fires while seed.sql is inserting auth.users -- before its user_roles INSERT has
  -- run -- and every persona ends up with a spurious second 'Operator' mapping.
  IF COALESCE(NEW.raw_app_meta_data, '{}'::jsonb) ->> 'role' IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT id INTO default_role_id
  FROM public.roles
  WHERE name = default_role_name;

  -- RBAC roles are seeded by 0002_seed_data.sql. If they are missing the database is
  -- half-provisioned; leave the user alone rather than aborting GoTrue's signup.
  IF default_role_id IS NULL THEN
    RAISE WARNING 'handle_new_user: role % not found; leaving user % unassigned',
      default_role_name, NEW.id;
    RETURN NEW;
  END IF;

  -- Never override an explicit mapping (e.g. the seeded personas).
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = NEW.id::text) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.user_roles (user_id, role_id)
  VALUES (NEW.id::text, default_role_id)
  ON CONFLICT (user_id, role_id) DO NOTHING;

  UPDATE auth.users
  SET raw_app_meta_data =
        jsonb_set(
          COALESCE(raw_app_meta_data, '{}'::jsonb),
          '{role}',
          to_jsonb(default_role_name),
          true
        )
  WHERE id = NEW.id;

  RETURN NEW;
END;
$$;

--

-- has_role(text[]) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.has_role(allowed_roles text[]) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    WHERE ur.user_id = auth.uid()::text
      AND r.name = ANY (allowed_roles)
  );
$$;

--

-- ingest_capture_progress(uuid, bigint, bigint, integer, boolean) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.ingest_capture_progress(p_job_id uuid, p_messages bigint, p_bytes bigint, p_elapsed_seconds integer, p_birth_captured boolean DEFAULT false) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;

--

-- ingest_claim_capture_job() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.ingest_claim_capture_job() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;

--

-- ingest_claim_rebirth_requests() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.ingest_claim_rebirth_requests() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_rows jsonb;
BEGIN
    PERFORM public.require_ingestion_caller('ingest_claim_rebirth_requests');

    -- ALL OF THEM, not one at a time. A rebirth is a single publish with no buffer behind it, so a
    -- daemon that took one per poll would trickle four requests out over twelve seconds for no
    -- reason -- unlike a capture, where one at a time is the whole point.
    WITH claimed AS (
        UPDATE public.rebirth_requests
           SET status = 'SENT', sent_at = now()
         WHERE id IN (SELECT id FROM public.rebirth_requests WHERE status = 'PENDING'
                       ORDER BY requested_at FOR UPDATE SKIP LOCKED)
        RETURNING id, edge_node_id, sparkplug_group
    )
    SELECT coalesce(jsonb_agg(to_jsonb(claimed)), '[]'::jsonb) INTO v_rows FROM claimed;

    -- MARKED SENT ON CLAIM, and corrected afterwards if the publish did not happen. The opposite
    -- order -- claim, publish, then mark -- leaves a row PENDING if the daemon dies mid-publish,
    -- and the next poll would send it again. A rebirth sent twice is harmless; a request that
    -- silently repeats forever because nothing closed it is not.
    RETURN v_rows;
END;
$$;

--

-- ingest_fail_capture(uuid, text) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.ingest_fail_capture(p_job_id uuid, p_error text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    PERFORM public.require_ingestion_caller('ingest_fail_capture');

    UPDATE public.capture_jobs
       SET status = 'FAILED', finished_at = now(),
           -- Truncated, because this is whatever the exception said and a driver can produce a
           -- great deal of it. The page shows this string.
           error = left(coalesce(nullif(btrim(p_error), ''), 'unspecified failure'), 2000)
     WHERE id = p_job_id AND status IN ('PENDING', 'RECORDING');
END;
$$;

--

-- ingest_finalise_capture(uuid, bigint, integer, jsonb) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.ingest_finalise_capture(p_job_id uuid, p_size_bytes bigint, p_message_count integer, p_manifest jsonb DEFAULT '{}'::jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;

--

-- ingest_mark_device_offline(uuid) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.ingest_mark_device_offline(p_device_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_rows integer;
BEGIN
    PERFORM public.require_ingestion_caller('ingest_mark_device_offline');

    IF p_device_id IS NULL THEN
        RAISE EXCEPTION 'ingest_mark_device_offline: p_device_id is required'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    UPDATE public.devices d
       SET status = 'OFFLINE'
     WHERE d.id = p_device_id
       AND d.status IS DISTINCT FROM 'OFFLINE';

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows > 0;
END;
$$;

--

-- ingest_reconcile_capture_jobs() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.ingest_reconcile_capture_jobs() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;

--

-- ingest_record_declared_metrics(uuid, text[], timestamp with time zone) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.ingest_record_declared_metrics(p_device_id uuid, p_metrics text[], p_observed_at timestamp with time zone DEFAULT now()) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_rows integer;
BEGIN
    PERFORM public.require_ingestion_caller('ingest_record_declared_metrics');

    IF p_device_id IS NULL THEN
        RAISE EXCEPTION 'ingest_record_declared_metrics: p_device_id is required'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    UPDATE public.devices d
       SET last_birth_metrics    = p_metrics,
           last_birth_metrics_at = p_observed_at
     WHERE d.id = p_device_id
       AND d.last_birth_metrics IS DISTINCT FROM p_metrics;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows > 0;
END;
$$;

--

-- ingest_record_gateway_health(uuid, text, timestamp with time zone, jsonb) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.ingest_record_gateway_health(p_gateway_id uuid, p_status text, p_heartbeat_at timestamp with time zone, p_health jsonb DEFAULT NULL::jsonb) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_rows integer;
    v_has_health boolean;
BEGIN
    PERFORM public.require_ingestion_caller('ingest_record_gateway_health');

    IF p_gateway_id IS NULL THEN
        RAISE EXCEPTION 'ingest_record_gateway_health: p_gateway_id is required'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    IF p_status IS NULL OR btrim(p_status) = '' THEN
        RAISE EXCEPTION 'ingest_record_gateway_health: p_status is required'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    IF upper(p_status) IN ('PENDING_ENROLLMENT', 'AWAITING_BIRTH', 'STALE') THEN
        RAISE EXCEPTION
            'ingest_record_gateway_health: % is reserved to the platform and may not be asserted '
            'by a gateway about itself -- it would short-circuit the staleness arm of '
            'public.gateway_status and leave a silent gateway looking healthy', p_status
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- The same cap ingestion.py applies (MAX_GATEWAY_STATUS_LENGTH). A gateway supplies this
    -- string, so it is length-checked rather than trusted.
    IF length(p_status) > 32 THEN
        RAISE EXCEPTION 'ingest_record_gateway_health: status is % characters, limit is 32',
            length(p_status)
            USING ERRCODE = 'string_data_right_truncation';
    END IF;

    v_has_health := p_health IS NOT NULL AND jsonb_typeof(p_health) = 'object'
                    AND p_health <> '{}'::jsonb;

    UPDATE public.gateways g
       SET status         = p_status,
           last_heartbeat = COALESCE(p_heartbeat_at, now()),
           -- STAMPED ONLY WHEN SOMETHING WAS RECOGNISED, which is what makes the column mean what
           -- 0035 says it means: an appliance on a bundle predating health reporting leaves this
           -- NULL, reading as "does not report health" rather than "has stopped reporting it".
           health_reported_at  = CASE WHEN v_has_health
                                      THEN COALESCE(p_heartbeat_at, now())
                                      ELSE g.health_reported_at END,
           uptime_seconds      = COALESCE((p_health->>'uptime_seconds')::bigint,      g.uptime_seconds),
           load_1m             = COALESCE((p_health->>'load_1m')::real,               g.load_1m),
           mem_available_bytes = COALESCE((p_health->>'mem_available_bytes')::bigint, g.mem_available_bytes),
           disk_free_bytes     = COALESCE((p_health->>'disk_free_bytes')::bigint,     g.disk_free_bytes),
           cert_expires_at     = COALESCE((p_health->>'cert_expires_at')::timestamptz, g.cert_expires_at),
           flow_hash           = COALESCE( p_health->>'flow_hash',                    g.flow_hash),
           -- `agent_version` is stamped once at enrolment by 0025 and REFRESHED here, which is
           -- the whole complaint 0035 answers. It is part of GATEWAY_HEALTH_METRICS in
           -- ingestion.py and belongs in this list; omitting it would drop the reading silently,
           -- leaving the page showing whatever version enrolled however long ago.
           agent_version       = COALESCE( p_health->>'agent_version',                g.agent_version)
     WHERE g.id = p_gateway_id;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
        RAISE EXCEPTION 'ingest_record_gateway_health: no gateway with id %', p_gateway_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    RETURN true;
END;
$$;

--

-- ingest_record_rebirth_outcome(uuid, boolean, text) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.ingest_record_rebirth_outcome(p_id uuid, p_throttled boolean DEFAULT false, p_error text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    PERFORM public.require_ingestion_caller('ingest_record_rebirth_outcome');

    UPDATE public.rebirth_requests
       SET status    = CASE WHEN p_error IS NULL THEN 'SENT' ELSE 'FAILED' END,
           throttled = coalesce(p_throttled, false),
           error     = left(nullif(btrim(coalesce(p_error, '')), ''), 2000)
     WHERE id = p_id;
END;
$$;

--

-- ingest_register_quarantined_device(text, uuid, text, text, text, text[], timestamp with time zone) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.ingest_register_quarantined_device(p_name text, p_gateway_id uuid, p_reported_identity text, p_quarantine_reason text, p_identity_source text, p_declared_metrics text[] DEFAULT NULL::text[], p_observed_at timestamp with time zone DEFAULT now()) RETURNS TABLE(id uuid, name text, sparkplug_id text, reported_identity text, gateway_id uuid, is_quarantined boolean, first_dbirth_at timestamp with time zone, last_birth_metrics text[], status text, identity_source text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
-- The RETURNS TABLE names are `_DEVICE_COLUMNS` verbatim, so several of them -- `id`, `name`,
-- `status` -- are also column names on `devices`. Resolve in favour of the column: this function
-- never assigns to an output variable, it returns a query.
#variable_conflict use_column
BEGIN
    PERFORM public.require_ingestion_caller('ingest_register_quarantined_device');

    IF p_name IS NULL OR btrim(p_name) = '' THEN
        RAISE EXCEPTION 'ingest_register_quarantined_device: p_name is required'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    IF NOT public.is_valid_quarantine_reason(p_quarantine_reason) THEN
        RAISE EXCEPTION
            'ingest_register_quarantined_device: % is not a recognised quarantine reason',
            coalesce(p_quarantine_reason, 'NULL')
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF p_identity_source IS NULL OR p_identity_source NOT IN
       ('sparkplug_id', 'reported_identity', 'instance_uuid', 'legacy_name') THEN
        RAISE EXCEPTION 'ingest_register_quarantined_device: % is not a recognised identity source',
            coalesce(p_identity_source, 'NULL')
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- A gateway_id that names nothing would leave an orphan the dashboard cannot file. NULL is
    -- allowed -- a device can announce itself through an edge node the platform has never seen,
    -- and that is precisely one of the cases this function is for.
    IF p_gateway_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.gateways g WHERE g.id = p_gateway_id) THEN
        RAISE EXCEPTION 'ingest_register_quarantined_device: no gateway with id %', p_gateway_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- Wrapped in a CTE because `RETURN QUERY INSERT ... RETURNING` is not accepted; RETURN QUERY
    -- takes a query, and a data-modifying statement only becomes one inside WITH.
    RETURN QUERY
    WITH inserted AS (
        INSERT INTO public.devices (
            name, status, is_quarantined, first_dbirth_at, reported_identity,
            quarantine_reason, identity_source, gateway_id,
            last_birth_metrics, last_birth_metrics_at
        )
        VALUES (
            p_name,
            'ONLINE',        -- pinned: a DBIRTH just arrived, by definition
            true,            -- pinned: this function is the quarantine path and nothing else
            p_observed_at,
            p_reported_identity,
            p_quarantine_reason,
            p_identity_source,
            p_gateway_id,
            p_declared_metrics,
            CASE WHEN p_declared_metrics IS NULL THEN NULL ELSE p_observed_at END
        )
        RETURNING devices.id, devices.name, devices.sparkplug_id, devices.reported_identity,
                  devices.gateway_id, devices.is_quarantined, devices.first_dbirth_at,
                  devices.last_birth_metrics, devices.status, devices.identity_source
    )
    SELECT inserted.id, inserted.name, inserted.sparkplug_id, inserted.reported_identity,
           inserted.gateway_id, inserted.is_quarantined, inserted.first_dbirth_at,
           inserted.last_birth_metrics, inserted.status, inserted.identity_source
      FROM inserted;
END;
$$;

--

-- ingest_requarantine_device(uuid, text, text) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.ingest_requarantine_device(p_device_id uuid, p_quarantine_reason text, p_reported_identity text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_rows integer;
BEGIN
    PERFORM public.require_ingestion_caller('ingest_requarantine_device');

    IF p_device_id IS NULL THEN
        RAISE EXCEPTION 'ingest_requarantine_device: p_device_id is required'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    IF NOT public.is_valid_quarantine_reason(p_quarantine_reason) THEN
        RAISE EXCEPTION 'ingest_requarantine_device: % is not a recognised quarantine reason',
            coalesce(p_quarantine_reason, 'NULL')
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    UPDATE public.devices d
       SET is_quarantined    = true,
           quarantine_reason = p_quarantine_reason,
           reported_identity = p_reported_identity
     WHERE d.id = p_device_id;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
        RAISE EXCEPTION 'ingest_requarantine_device: no device with id %', p_device_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    RETURN true;
END;
$$;

--

-- ingest_set_device_state(uuid, text, text, timestamp with time zone) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.ingest_set_device_state(p_device_id uuid, p_status text DEFAULT NULL::text, p_identity_source text DEFAULT NULL::text, p_first_dbirth_at timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_rows integer;
BEGIN
    PERFORM public.require_ingestion_caller('ingest_set_device_state');

    IF p_device_id IS NULL THEN
        RAISE EXCEPTION 'ingest_set_device_state: p_device_id is required'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    IF p_identity_source IS NOT NULL AND p_identity_source NOT IN
       ('sparkplug_id', 'reported_identity', 'instance_uuid', 'legacy_name') THEN
        RAISE EXCEPTION 'ingest_set_device_state: % is not a recognised identity source',
            p_identity_source
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- This gate deliberately cannot quarantine or un-quarantine. Those are separate functions
    -- with their own vocabulary checks, and folding them together here would let the ordinary
    -- per-birth write clear a quarantine flag by omission.
    UPDATE public.devices d
       SET status          = COALESCE(p_status, d.status),
           identity_source = COALESCE(p_identity_source, d.identity_source),
           first_dbirth_at = COALESCE(d.first_dbirth_at, p_first_dbirth_at)
     WHERE d.id = p_device_id
       AND (
            (p_status          IS NOT NULL AND d.status          IS DISTINCT FROM p_status)
         OR (p_identity_source IS NOT NULL AND d.identity_source IS DISTINCT FROM p_identity_source)
         OR (p_first_dbirth_at IS NOT NULL AND d.first_dbirth_at IS NULL)
       );

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows > 0;
END;
$$;

--

-- ingest_store_birth_parameters(text, jsonb, timestamp with time zone) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.ingest_store_birth_parameters(p_asset_id text, p_rows jsonb, p_observed_at timestamp with time zone DEFAULT now()) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_rows integer;
BEGIN
    PERFORM public.require_ingestion_caller('ingest_store_birth_parameters');

    IF p_asset_id IS NULL OR btrim(p_asset_id) = '' THEN
        RAISE EXCEPTION 'ingest_store_birth_parameters: p_asset_id is required'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
        RAISE EXCEPTION 'ingest_store_birth_parameters: p_rows must be a JSON array, got %',
            coalesce(jsonb_typeof(p_rows), 'null')
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- The asset must be one this platform knows. `asset_config.asset_id` is loose text with no
    -- foreign key -- it holds a `sparkplug_id`, not a uuid -- so nothing else would catch a batch
    -- written against an id that names no device.
    IF NOT EXISTS (SELECT 1 FROM public.devices d WHERE d.sparkplug_id = p_asset_id) THEN
        RAISE EXCEPTION 'ingest_store_birth_parameters: no device with sparkplug_id %', p_asset_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    INSERT INTO public.asset_config (asset_id, metric_name, val_double, val_string, val_bool,
                                     datatype, updated_at)
    SELECT p_asset_id,
           r.metric_name,
           r.val_double,
           r.val_string,
           r.val_bool,
           r.datatype,
           p_observed_at
      FROM jsonb_to_recordset(p_rows) AS r(
               metric_name text,
               val_double  double precision,
               val_string  text,
               val_bool    boolean,
               datatype    integer
           )
     WHERE r.metric_name IS NOT NULL
    ON CONFLICT (asset_id, metric_name) DO UPDATE
       SET val_double = EXCLUDED.val_double,
           val_string = EXCLUDED.val_string,
           val_bool   = EXCLUDED.val_bool,
           datatype   = EXCLUDED.datatype,
           updated_at = EXCLUDED.updated_at;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows;
END;
$$;

--

-- is_active_capture_object(text) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.is_active_capture_object(p_name text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.capture_jobs j
         WHERE j.status = 'RECORDING' AND j.storage_path = p_name
    );
$$;

--

-- FUNCTION is_active_capture_object(p_name text) :: COMMENT
--

COMMENT ON FUNCTION public.is_active_capture_object(p_name text) IS 'True when a storage object path is the destination of a capture job that is RECORDING right now. Confines the ingestion daemon''s authority over broker-captures to the single file it is producing: with no capture in flight the daemon can reach nothing in the bucket at all.';

--

-- is_active_playback_capture(text) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.is_active_playback_capture(p_name text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.playback_jobs j
         WHERE j.status = 'RUNNING' AND j.capture_storage_path = p_name
    );
$$;

--

-- FUNCTION is_active_playback_capture(p_name text) :: COMMENT
--

COMMENT ON FUNCTION public.is_active_playback_capture(p_name text) IS 'True when a storage object is the capture of a playback job that is RUNNING right now. Confines the playback worker''s read of broker-captures to the single file it is publishing: with no playback in flight the worker can reach nothing in the bucket at all.';

--

-- is_capture_subject_prefix(text) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.is_capture_subject_prefix(p_folder text) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
    SELECT EXISTS (SELECT 1 FROM public.gateways g WHERE g.sparkplug_id = p_folder)
        OR EXISTS (SELECT 1 FROM public.devices  d WHERE d.sparkplug_id = p_folder);
$$;

--

-- FUNCTION is_capture_subject_prefix(p_folder text) :: COMMENT
--

COMMENT ON FUNCTION public.is_capture_subject_prefix(p_folder text) IS 'True when a storage folder names a real gateway or device. The prefix rule for broker-captures, which files by the SUBJECT RECORDED rather than by the gateway a capture plays back as.';

--

-- is_ingestion_caller() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.is_ingestion_caller() RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
    -- One arm: Service_Ingestor only. `service_role` bypasses RLS and can write these tables
    -- directly; what this stops is `service_role` using the narrow gates, so "who may call these"
    -- stays a statement about one identity.
    SELECT COALESCE(auth.uid()::text = 'b0000000-0000-4000-8000-000000000002', false);
$$;

--

-- FUNCTION is_ingestion_caller() :: COMMENT
--

COMMENT ON FUNCTION public.is_ingestion_caller() IS 'True only for the Service_Ingestor principal (0046). Guards every ingest_* write gate. The transitional service_role arm was removed by 0048 -- see Machine Identities in supabase/README.md.';

--

-- is_machine_principal(uuid) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.is_machine_principal(p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    -- SECURITY DEFINER because `auth.users` is GoTrue's and an ordinary caller cannot read it.
    -- It answers a yes/no about one id and returns nothing else, so it leaks no more than the
    -- caller already supplied.
    SELECT EXISTS (
        SELECT 1
          FROM auth.users u
         WHERE u.id = p_user_id
           AND u.email IS NULL
           AND (u.encrypted_password IS NULL OR u.encrypted_password = '')
           AND NOT EXISTS (SELECT 1 FROM auth.identities i WHERE i.user_id = u.id)
    );
$$;

--

-- FUNCTION is_machine_principal(p_user_id uuid) :: COMMENT
--

COMMENT ON FUNCTION public.is_machine_principal(p_user_id uuid) IS 'True for a seeded or minted machine identity -- no email, no password, no identity provider, and therefore unable to sign in. The predicate is 0042''s, deliberately unchanged: a second definition of "is this a service account" would be worse than none. Used by log_digital_thread_event() to keep a machine''s writes from being recorded as a human''s.';

--

-- is_playback_caller() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.is_playback_caller() RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
    -- ONE ARM, like `is_ingestion_caller()` after 0048. No transitional `service_role` arm: nothing
    -- has ever handed this worker that key, so admitting it would widen the gates on day one for a
    -- migration path that does not exist.
    SELECT COALESCE(auth.uid()::text = 'b0000000-0000-4000-8000-000000000003', false);
$$;

--

-- FUNCTION is_playback_caller() :: COMMENT
--

COMMENT ON FUNCTION public.is_playback_caller() IS 'True only for the Service_Playback principal (0056). Guards every playback_* worker gate. Deliberately distinct from is_ingestion_caller(): the two processes hold different broker rights -- the daemon may publish only NCMD rebirth requests, the worker may publish asset data as one gateway -- and a shared predicate would let either use the other''s gates.';

--

-- is_valid_quarantine_reason(text) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.is_valid_quarantine_reason(p_reason text) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$
    SELECT p_reason IS NOT NULL AND EXISTS (
        SELECT 1
          FROM unnest(ARRAY['UNKNOWN_DEVICE', 'MALFORMED_IDENTITY',
                            'IDENTITY_MISMATCH', 'GATEWAY_MISMATCH']) AS code
         WHERE p_reason = code OR p_reason LIKE code || ': %'
    );
$$;

--

-- FUNCTION is_valid_quarantine_reason(p_reason text) :: COMMENT
--

COMMENT ON FUNCTION public.is_valid_quarantine_reason(p_reason text) IS 'True when the reason is one of the four quarantine codes, bare or followed by ": <detail>". Both shapes are produced by ingestion.py -- see 0047''s header for why this is a prefix check rather than an equality check.';

--

-- issue_gateway_enrollment_token(uuid, integer) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.issue_gateway_enrollment_token(p_gateway_id uuid, p_ttl_minutes integer DEFAULT 30) RETURNS TABLE(token text, expires_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_token    text;
  v_expires  timestamp with time zone;
  v_gateway  public.gateways%ROWTYPE;
BEGIN
  -- Fail closed, and check authority before anything observable happens. Same allow-list as the
  -- write policies on `gateways`: issuing a bundle is a gateway-management act.
  IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'insufficient privileges to issue a gateway enrolment token'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- BOUNDED, because the TTL arrives from a client. A 30-minute default matches the time it takes
  -- to carry a bundle to an appliance and boot it; the ceiling is a day, past which a "short-lived
  -- single-use claim" is neither.
  IF p_ttl_minutes IS NULL OR p_ttl_minutes < 1 OR p_ttl_minutes > 1440 THEN
    RAISE EXCEPTION 'p_ttl_minutes must be between 1 and 1440 (got %)', p_ttl_minutes
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_gateway FROM public.gateways WHERE id = p_gateway_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gateway % does not exist', p_gateway_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- A host-run gateway has no appliance to enrol: `deployment = 'host'` means the connector runs
  -- inside this stack, and a bundle for one would produce a credential nothing could present.
  IF v_gateway.deployment = 'host' THEN
    RAISE EXCEPTION 'gateway % runs on this host; enrolment bundles are for appliances only',
      v_gateway.name
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Invalidate any live token for this gateway FIRST. Two reasons, and the second is structural:
  -- re-issuing must kill the bundle already downloaded (otherwise "regenerate" hands out a second
  -- valid claim rather than replacing the first), and the partial unique index permits only one
  -- unconsumed row per gateway.
  UPDATE public.gateway_enrollment_tokens
     SET consumed_at = now()
   WHERE gateway_id = p_gateway_id
     AND consumed_at IS NULL;

  -- 32 bytes, hex-encoded. `extensions.gen_random_bytes` is pgcrypto, already relied on by 0002 and
  -- 0006 for the OAuth client secret hashes -- the same extension, in the same schema.
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_expires := now() + make_interval(mins => p_ttl_minutes);

  INSERT INTO public.gateway_enrollment_tokens (gateway_id, token_hash, expires_at, created_by)
  VALUES (
    p_gateway_id,
    encode(extensions.digest(v_token, 'sha256'), 'hex'),
    v_expires,
    -- Nullable and carries no FK on purpose: auth.uid() is NULL when this is called with the
    -- service-role key (provisioning scripts, tests), and recording who asked is useful while
    -- failing because nobody did is not. It is provenance, not a constraint.
    auth.uid()
  );

  -- The gateway enters the lifecycle here rather than at creation, so a row created before this
  -- migration -- or one whose bundle is being re-issued after a failed enrolment -- lands in the
  -- same state as a new one. Guarded on an actual change: `gateways` carries the digital_thread
  -- trigger, and an unconditional write would append an audit row on every re-issue.
  IF v_gateway.status IS DISTINCT FROM 'PENDING_ENROLLMENT' THEN
    UPDATE public.gateways
       SET status = 'PENDING_ENROLLMENT'
     WHERE id = p_gateway_id;
  END IF;

  RETURN QUERY SELECT v_token, v_expires;
END $$;

--

-- FUNCTION issue_gateway_enrollment_token(p_gateway_id uuid, p_ttl_minutes integer) :: COMMENT
--

COMMENT ON FUNCTION public.issue_gateway_enrollment_token(p_gateway_id uuid, p_ttl_minutes integer) IS 'Mint a single-use enrolment token for a physical gateway and move it to PENDING_ENROLLMENT. Returns the raw token ONCE -- only its SHA-256 is stored. Requires Administrator or Shopfloor_Manager. Re-issuing consumes any previous live token, so a regenerated bundle invalidates the one already downloaded.';

--

-- list_service_principals() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.list_service_principals() RETURNS TABLE(principal_id uuid, roles text[], created_at timestamp with time zone, can_sign_in boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  -- ADMINISTRATOR ONLY, and narrower than the page's other reads on purpose. A gateway's
  -- credential state is operational -- a Shopfloor_Manager acts on it. The list of machine
  -- identities that can reach the stack is an access-control question, and `authz:manage` is
  -- granted to Administrator alone.
  IF NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'insufficient privileges to list service principals'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT u.id,
         coalesce(array_agg(r.name ORDER BY r.name) FILTER (WHERE r.name IS NOT NULL), '{}'::text[]),
         u.created_at,
         -- RETURNED RATHER THAN ASSUMED, even though the WHERE clause makes it false for every row.
         -- It is the property that makes listing these safe, and a page that states it is a page
         -- whose claim can be checked. If this ever comes back true, the predicate below has
         -- stopped meaning what its name says.
         false
    FROM auth.users u
    LEFT JOIN public.user_roles ur ON ur.user_id = u.id::text
    LEFT JOIN public.roles r ON r.id = ur.role_id
   WHERE u.email IS NULL
     AND (u.encrypted_password IS NULL OR u.encrypted_password = '')
   GROUP BY u.id, u.created_at
   ORDER BY u.created_at;
END;
$$;

--

-- FUNCTION list_service_principals() :: COMMENT
--

COMMENT ON FUNCTION public.list_service_principals() IS 'Machine identities that can reach this stack: auth.users rows with no email and no password, which cannot sign in through GoTrue and are presented only by a JWT signed outside it. Administrator only. Returns no email, no token and nothing derived from one.';

--

-- log_digital_thread_event() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.log_digital_thread_event() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_old_data  JSONB := NULL;
    v_new_data  JSONB := NULL;
    v_entity_id UUID;
    v_actor     UUID;
    v_source    TEXT;
    v_declared  TEXT;
    v_role      TEXT;
BEGIN
    -- -----------------------------------------------------------------------------------------
    -- Suppression. UPDATE only: an INSERT or DELETE is always an event.
    -- -----------------------------------------------------------------------------------------
    -- One comparison covers both cases, because subtracting an absent key is a no-op: identical
    -- rows are a no-op write, and rows differing only in last_heartbeat are liveness telemetry.
    -- `IS NOT DISTINCT FROM` so a NULL on either side compares as equal.
    IF TG_OP = 'UPDATE'
       AND (to_jsonb(NEW) - 'last_heartbeat') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'last_heartbeat')
    THEN
        RETURN NEW;
    END IF;

    IF (TG_OP = 'DELETE') THEN
        v_old_data := to_jsonb(OLD);
        v_entity_id := OLD.id;
    ELSIF (TG_OP = 'UPDATE') THEN
        v_old_data := to_jsonb(OLD);
        v_new_data := to_jsonb(NEW);
        v_entity_id := NEW.id;
    ELSIF (TG_OP = 'INSERT') THEN
        v_new_data := to_jsonb(NEW);
        v_entity_id := NEW.id;
    END IF;

    -- -----------------------------------------------------------------------------------------
    -- Who
    -- -----------------------------------------------------------------------------------------
    v_actor := auth.uid();

    IF v_actor IS NULL THEN
        -- Set with SET LOCAL by a SECURITY DEFINER RPC acting on a user's behalf -- the
        -- approve-quarantine path, where the request arrives on the service-role key but a
        -- specific operator authorised it. See 0003.
        BEGIN
            v_actor := NULLIF(current_setting('acs_cymru.actor_id', true), '')::UUID;
        EXCEPTION WHEN others THEN
            v_actor := NULL;
        END;
    END IF;

    -- -----------------------------------------------------------------------------------------
    -- What kind of actor
    -- -----------------------------------------------------------------------------------------
    -- A person, not merely a `sub`: machine principals carry one too. A machine falls through to
    -- the declared-header path below and is recorded as what it is, while `changed_by` still
    -- receives v_actor so the row names it.
    IF v_actor IS NOT NULL AND NOT public.is_machine_principal(v_actor) THEN
        v_source := 'user';
    ELSE
        -- A caller may declare itself with an `X-ACS-Cymru-Actor` request header, which PostgREST
        -- exposes as request.headers. That is how the ingestion daemon is told apart from an edge
        -- function; the branch above declines to read a machine's `sub` as evidence of a person.
        BEGIN
            v_declared := NULLIF(
                current_setting('request.headers', true)::json ->> 'x-acs-cymru-actor', ''
            );
        EXCEPTION WHEN others THEN
            v_declared := NULL;
        END;

        IF v_declared IN ('ingestion', 'service', 'migration') THEN
            -- 'user' is deliberately NOT accepted from a header: claiming a human author is
            -- exactly the assertion a client must not be able to make about itself.
            v_source := v_declared;
        ELSE
            -- Which role is calling, and not `current_user`: this function is SECURITY DEFINER, so
            -- `current_user` is the owner (`postgres`). PostgREST connects as `authenticator` and SET ROLEs,
            -- so `role` holds the effective role; a direct psql session reports 'none', where
            -- `session_user` is the honest answer.
            v_role := NULLIF(current_setting('role', true), 'none');
            IF v_role IS NULL OR v_role = '' THEN
                v_role := session_user;
            END IF;

            IF v_role IN ('postgres', 'supabase_admin') THEN
                v_source := 'migration';
            ELSE
                -- service_role with nothing declared: automation we cannot name more precisely.
                v_source := 'service';
            END IF;
        END IF;
    END IF;

    INSERT INTO public.digital_thread (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        TG_TABLE_NAME, v_entity_id, TG_OP, v_old_data, v_new_data, v_actor, v_source,
        txid_current(), NOW()
    );

    RETURN COALESCE(NEW, OLD);
END;
$$;

--

-- log_role_assignment() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.log_role_assignment() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_row     record;
  v_action  text;
  v_actor   uuid;
  v_source  text;
  v_role    text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := OLD;
    v_action := 'ROLE_REVOKED';
  ELSE
    v_row := NEW;
    v_action := 'ROLE_GRANTED';
  END IF;

  -- Attribution, the short form. The full ladder in `log_digital_thread_event()` distinguishes an
  -- ingestion write from an edge function by request header; neither ever touches this table.
  -- What reaches it is a person with a session, or a migration -- so the two arms that matter are
  -- `auth.uid()` and the role the statement is running as.
  v_actor := auth.uid();
  IF v_actor IS NOT NULL AND NOT public.is_machine_principal(v_actor) THEN
    v_source := 'user';
  ELSE
    -- `current_user` is the function OWNER inside a SECURITY DEFINER body -- always `postgres` --
    -- which is the bug 0026's header records as having labelled every ingestion write
    -- 'migration'. `role` is what PostgREST SET ROLEs to; a psql session never sets it and
    -- reports 'none', where `session_user` is the honest answer.
    v_role := NULLIF(current_setting('role', true), 'none');
    IF v_role IS NULL OR v_role = '' THEN
      v_role := session_user;
    END IF;
    v_source := CASE WHEN v_role IN ('postgres', 'supabase_admin') THEN 'migration' ELSE 'service' END;
  END IF;

  INSERT INTO public.digital_thread (
    entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
    causation_id, recorded_at
  ) VALUES (
    'user_roles',
    v_row.user_id::uuid,
    v_action,
    CASE WHEN TG_OP = 'DELETE'
      THEN jsonb_build_object('role_id', OLD.role_id,
                              'role', (SELECT name FROM public.roles WHERE id = OLD.role_id))
      ELSE NULL END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL
      ELSE jsonb_build_object('role_id', NEW.role_id,
                              'role', (SELECT name FROM public.roles WHERE id = NEW.role_id))
      END,
    v_actor,
    v_source,
    txid_current(),
    now()
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

--

-- FUNCTION log_role_assignment() :: COMMENT
--

COMMENT ON FUNCTION public.log_role_assignment() IS 'Audit trigger for public.user_roles. Separate from log_digital_thread_event() because that function reads NEW.id and user_roles has no id column -- its key is (user_id, role_id).';

--

-- may_manage_captures() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.may_manage_captures() RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
    SELECT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']);
$$;

--

-- platform_health_rows() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.platform_health_rows() RETURNS TABLE(condition text, sparkplug_id text, subject text, value numeric, detail text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
    -- ---------------------------------------------------------------------------------------
    -- A gateway that has stopped heartbeating.
    -- Reads `gateway_status.is_stale` rather than re-deriving it: that view owns the 90s
    -- threshold (mirrored into the frontend, checked by check-mirror-drift.mjs). The alert rule
    -- adds its own `for:` on top. Archived gateways are excluded.
    -- ---------------------------------------------------------------------------------------
    SELECT 'gateway_stale'::text,
           g.sparkplug_id,
           g.name,
           g.heartbeat_age_seconds::numeric,
           format('%s has not reported for %s seconds', g.name, g.heartbeat_age_seconds)
      FROM public.gateway_status g
     WHERE g.is_stale
       AND NOT g.is_archived

    UNION ALL

    -- ---------------------------------------------------------------------------------------
    -- An enrolment that never completed: a physical gateway redeems its token, lands in
    -- AWAITING_BIRTH, and leaves that state on its first NBIRTH. Age is measured from
    -- `enrolled_at`.
    -- ---------------------------------------------------------------------------------------
    SELECT 'enrolment_stuck'::text,
           g.sparkplug_id,
           g.name,
           EXTRACT(EPOCH FROM (now() - g.enrolled_at))::numeric,
           format('%s has been AWAITING_BIRTH since %s', g.name, g.enrolled_at)
      FROM public.gateways g
     WHERE g.status = 'AWAITING_BIRTH'
       AND g.enrolled_at IS NOT NULL
       AND NOT g.is_archived

    UNION ALL

    -- ---------------------------------------------------------------------------------------
    -- The quarantine queue: fleet-wide, so one row with no subject (`entity_type = 'platform'`).
    -- Emitted even at zero, so a rule can tell "nothing is quarantined" from "the datasource is
    -- down" without relying on NoData handling.
    -- ---------------------------------------------------------------------------------------
    SELECT 'quarantine_depth'::text,
           NULL::text,
           'fleet'::text,
           count(*)::numeric,
           format('%s device(s) awaiting an approval decision', count(*))
      FROM public.devices d
     WHERE d.is_quarantined
       AND NOT d.is_archived
    UNION ALL

    -- ---------------------------------------------------------------------------------------
    -- Devices that SHOULD be publishing. See this migration's header for why each exclusion is
    -- here and why zero is the answer that disables the alert rather than a gap in it.
    -- ---------------------------------------------------------------------------------------
    SELECT 'expected_publishers'::text,
           NULL::text,
           'fleet'::text,
           count(*)::numeric,
           format('%s device(s) registered, unarchived, unquarantined and bound to a gateway',
                  count(*))
      FROM public.devices d
     WHERE NOT d.is_archived
       AND NOT d.is_quarantined
       AND d.gateway_id IS NOT NULL
$$;

--

-- FUNCTION platform_health_rows() :: COMMENT
--

COMMENT ON FUNCTION public.platform_health_rows() IS 'One row per platform condition worth alerting on: stale gateways, stuck enrolments, the quarantine queue depth, and how many devices are expected to be publishing. SECURITY DEFINER so the Grafana reader needs no privilege on gateways or devices -- it emits a count and, where the condition names an asset, that asset''s wire id, and nothing else about it.';

--

-- platform_storage_rows() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.platform_storage_rows() RETURNS TABLE(tier text, relation text, table_bytes bigint, index_bytes bigint, toast_bytes bigint, total_bytes bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
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
$$;

--

-- FUNCTION platform_storage_rows() :: COMMENT
--

COMMENT ON FUNCTION public.platform_storage_rows() IS 'Byte counts for every ordinary table in the Supabase public schema, tiered so an audit trail that is never pruned is distinguishable from reference data that never grows. SECURITY DEFINER so the dashboard reader needs no privilege on the tables it reports the size of.';

--

-- playback_claim_job() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.playback_claim_job() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_job public.playback_jobs;
BEGIN
    PERFORM public.require_playback_caller('playback_claim_job');

    SELECT * INTO v_job
      FROM public.playback_jobs
     WHERE status = 'PENDING'
     ORDER BY created_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    UPDATE public.playback_jobs
       SET status = 'RUNNING', started_at = now()
     WHERE id = v_job.id;

    -- THE STATUS IN THE RETURNED ROW IS THE NEW ONE. `v_job` was read before the UPDATE, so
    -- returning it unmodified would tell the worker the job is still PENDING -- and the storage
    -- read arm it is about to depend on keys on RUNNING.
    RETURN to_jsonb(v_job) || jsonb_build_object('status', 'RUNNING', 'started_at', now());
END;
$$;

--

-- playback_finish(uuid, integer, text) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.playback_finish(p_job_id uuid, p_messages_sent integer, p_error text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    PERFORM public.require_playback_caller('playback_finish');

    -- ONE FUNCTION FOR BOTH OUTCOMES, unlike capture's pair, because a playback that stops early
    -- has still published everything it published -- there is no artifact to write on success and
    -- nothing to roll back on failure. The distinction is a status and a string.
    UPDATE public.playback_jobs
       SET status = CASE WHEN p_error IS NULL THEN 'COMPLETED' ELSE 'FAILED' END,
           finished_at = now(),
           messages_sent = greatest(coalesce(p_messages_sent, messages_sent), 0),
           error = left(nullif(btrim(coalesce(p_error, '')), ''), 2000)
     WHERE id = p_job_id AND status IN ('PENDING', 'RUNNING');
END;
$$;

--

-- playback_progress(uuid, integer, integer, integer) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.playback_progress(p_job_id uuid, p_messages_sent integer, p_messages_total integer, p_elapsed_seconds integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_stop boolean;
BEGIN
    PERFORM public.require_playback_caller('playback_progress');

    UPDATE public.playback_jobs
       SET messages_sent   = greatest(coalesce(p_messages_sent, 0), 0),
           messages_total  = greatest(coalesce(p_messages_total, messages_total), 0),
           elapsed_seconds = greatest(coalesce(p_elapsed_seconds, 0), 0)
     WHERE id = p_job_id AND status = 'RUNNING'
    RETURNING stop_requested INTO v_stop;

    -- Cancelled, or reconciled away by a restart. Telling the worker to stop is the right answer to
    -- both: there is nothing left for it to complete into.
    IF NOT FOUND THEN
        RETURN true;
    END IF;
    RETURN coalesce(v_stop, false);
END;
$$;

--

-- playback_reconcile_jobs() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.playback_reconcile_jobs() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_n integer;
BEGIN
    PERFORM public.require_playback_caller('playback_reconcile_jobs');

    WITH swept AS (
        UPDATE public.playback_jobs
           SET status = 'FAILED', finished_at = now(),
               error = 'the playback worker restarted while this job was ' || lower(status)
                       || '; publishing stopped partway'
         WHERE status IN ('PENDING', 'RUNNING')
        RETURNING 1
    )
    SELECT count(*) INTO v_n FROM swept;
    RETURN v_n;
END;
$$;

--

-- playback_report_credentials(text[]) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.playback_report_credentials(p_edge_nodes text[]) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    PERFORM public.require_playback_caller('playback_report_credentials');

    -- COERCED TO A SORTED, DE-DUPLICATED SET rather than stored as sent. The worker builds this
    -- from a JSON object whose key order is not defined, so storing it verbatim would rewrite the
    -- row -- and therefore wake every Realtime subscriber -- on a heartbeat that changed nothing.
    UPDATE public.playback_worker_status
       SET held_edge_nodes = COALESCE(
             (SELECT array_agg(DISTINCT node ORDER BY node)
                FROM unnest(coalesce(p_edge_nodes, '{}')) AS node
               WHERE node IS NOT NULL AND btrim(node) <> ''),
             '{}'
           ),
           reported_at = now()
     WHERE id;
END;
$$;

--

-- FUNCTION playback_report_credentials(p_edge_nodes text[]) :: COMMENT
--

COMMENT ON FUNCTION public.playback_report_credentials(p_edge_nodes text[]) IS 'The playback worker reporting which gateways it can authenticate as. The only writer of playback_worker_status. Called on startup and on a heartbeat, so a stale reported_at means the worker is down rather than credential-less.';

--

-- playback_target_must_be_shadow() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.playback_target_must_be_shadow() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_gateway public.gateways;
BEGIN
    SELECT * INTO v_gateway FROM public.gateways WHERE id = NEW.target_gateway_id;

    IF NOT FOUND OR NOT v_gateway.is_shadow THEN
        RAISE EXCEPTION
          'playback: % is not a playback gateway. A capture must be published onto an edge node '
          'nothing else publishes as -- two publishers share one Sparkplug seq counter, and the '
          'daemon reads the interleaving as permanent message loss and asks the live node for a '
          'rebirth mid-playback. Choose the Playback gateway (0060).',
          coalesce(v_gateway.name, NEW.target_gateway_id::text)
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

--

-- prevent_active_schema_mutation() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.prevent_active_schema_mutation() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  -- Everything a caller is allowed to move on a frozen row. `status` alone: a published version's
  -- name, definition, description, semantic id, version number and parent are all part of what
  -- devices were provisioned against or of the historical record, and none of them is correctable
  -- in place -- the correction is a new version, which is the whole point of this migration.
  allowed CONSTANT text[] := ARRAY['status'];
BEGIN
  -- Transition legality binds EVERY caller, including migrations and the SECURITY DEFINER RPCs
  -- below, which is why it sits above the role bypass. Backwards transitions are what would let
  -- history be rewritten: re-opening an archived version as a draft would make the row mutable
  -- again while devices are still attached to its successor.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'draft'  AND NEW.status IN ('active', 'archived'))
      OR (OLD.status = 'active' AND NEW.status = 'archived')
    ) THEN
      RAISE EXCEPTION
        'illegal schema status transition % -> % for "%" (v%)',
        OLD.status, NEW.status, OLD.schema_name, OLD.version
        USING ERRCODE = 'check_violation',
              HINT = 'Legal transitions are draft->active, draft->archived and active->archived.';
    END IF;
  END IF;

  -- See the header: migrations 0019 and 0033 rewrite seeded schemas by name on every boot, and the
  -- RPCs below run as the owner. Only app-facing roles are held to immutability.
  IF current_user NOT IN ('authenticated', 'anon', 'service_role') THEN
    RETURN NEW;
  END IF;

  IF OLD.status NOT IN ('active', 'archived') THEN
    RETURN NEW;
  END IF;

  -- Deny-list by default. Anything outside `allowed` that actually changed is a mutation of a
  -- frozen row, whether or not this migration knew the column existed.
  IF (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
    RAISE EXCEPTION
      'schema "%" is % (v%) and immutable; create v% with fork_schema() instead',
      OLD.schema_name, OLD.status, OLD.version, OLD.version + 1
      USING ERRCODE = 'check_violation',
            HINT = 'Only a draft version can be edited. Fork this schema, edit the draft, then publish it.';
  END IF;

  RETURN NEW;
END;
$$;

--

-- FUNCTION prevent_active_schema_mutation() :: COMMENT
--

COMMENT ON FUNCTION public.prevent_active_schema_mutation() IS 'Freezes every column except `status` on an active or archived schema, and rejects illegal status transitions for all callers.';

--

-- prune_platform_alerts(interval) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.prune_platform_alerts(p_retain interval DEFAULT NULL::interval) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
    v_days    numeric;
    v_retain  interval;
    v_cutoff  timestamptz;
    v_deleted integer;
BEGIN
    IF p_retain IS NULL THEN
        SELECT (value #>> '{}')::numeric INTO v_days
          FROM public.system_settings
         WHERE key = 'alerts.retention_days';

        -- `make_interval(days => numeric)` does not exist -- the days argument is an integer and
        -- the overload resolution fails rather than rounding. Seconds takes a double, which is
        -- why 0030 used this form and why it is kept.
        v_retain := COALESCE(make_interval(secs => v_days::double precision * 86400.0),
                             interval '7 days');
    ELSE
        v_retain := p_retain;
    END IF;

    v_cutoff := now() - v_retain;

    DELETE FROM public.platform_alerts a
     WHERE
        -- Closed, and old enough. `ends_at` is when it stopped firing, which is the only honest
        -- age for a resolved occurrence.
        (a.status = 'resolved' AND a.ends_at < v_cutoff)
        -- Or superseded: an older occurrence of the same fingerprint that a newer one replaced.
        -- THE NEWEST ROW OF A FINGERPRINT IS NEVER MATCHED HERE, which is what keeps a long-firing
        -- alert alive past the window -- `recorded_at` is stamped once and never refreshed, so a
        -- flat age cutoff would delete the CURRENT STATE of a live alert and the dashboard pill
        -- would vanish while Grafana still had it firing.
        OR (a.recorded_at < v_cutoff
            AND EXISTS (SELECT 1 FROM public.platform_alerts n
                         WHERE n.fingerprint = a.fingerprint
                           AND (n.starts_at, n.recorded_at) > (a.starts_at, a.recorded_at)));

    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

--

-- FUNCTION prune_platform_alerts(p_retain interval) :: COMMENT
--

COMMENT ON FUNCTION public.prune_platform_alerts(p_retain interval) IS 'Delete alert occurrences older than the retention window, EXCEPT the newest occurrence of any fingerprint -- so an alert that has been firing longer than the window is never removed while it is still the current state. Returns the number of rows deleted. Scheduled as prune_platform_alerts; see the migration header for why the obvious one-line predicate is wrong.';

--

-- publish_schema_version(uuid) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.publish_schema_version(draft_schema_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_draft_id       UUID := draft_schema_id;
  draft            public.schemas%ROWTYPE;
  parent           public.schemas%ROWTYPE;
  published        public.schemas%ROWTYPE;
  v_submodels      INTEGER := 0;
  v_legacy         INTEGER := 0;
  v_merged         INTEGER := 0;
BEGIN
  IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'insufficient privileges to publish a schema version'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_draft_id IS NULL THEN
    RAISE EXCEPTION 'draft_schema_id is required' USING ERRCODE = 'null_value_not_allowed';
  END IF;

  SELECT * INTO draft FROM public.schemas WHERE id = v_draft_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'schema % not found', v_draft_id USING ERRCODE = 'no_data_found';
  END IF;

  IF draft.status <> 'draft' THEN
    RAISE EXCEPTION 'schema "%" is %, not a draft', draft.schema_name, draft.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF draft.parent_schema_id IS NOT NULL THEN
    SELECT * INTO parent FROM public.schemas WHERE id = draft.parent_schema_id FOR UPDATE;

    -- Rebind before archiving, so no window exists in which a device points at an archived schema.
    -- A device already carrying both versions as submodels would collide on `uq_device_submodels`
    -- when repointed, so the redundant old-version rows are dropped first.
    DELETE FROM public.device_submodels old_link
     WHERE old_link.schema_id = parent.id
       AND EXISTS (
         SELECT 1 FROM public.device_submodels new_link
          WHERE new_link.device_id = old_link.device_id
            AND new_link.schema_id = draft.id
       );
    GET DIAGNOSTICS v_merged = ROW_COUNT;

    UPDATE public.device_submodels SET schema_id = draft.id WHERE schema_id = parent.id;
    GET DIAGNOSTICS v_submodels = ROW_COUNT;

    -- The legacy 1:1 pointer moves too: `devices.schema_id` is the fallback arm of the
    -- `device_schemas` view. This UPDATE fires `log_digital_thread_event()`, so the rebinding lands
    -- in the audit trail per device.
    UPDATE public.devices SET schema_id = draft.id WHERE schema_id = parent.id;
    GET DIAGNOSTICS v_legacy = ROW_COUNT;

    IF parent.status = 'active' THEN
      UPDATE public.schemas SET status = 'archived' WHERE id = parent.id;
    END IF;
  END IF;

  UPDATE public.schemas SET status = 'active' WHERE id = draft.id RETURNING * INTO published;

  RETURN jsonb_build_object(
    'schema', to_jsonb(published),
    'archived_schema_id', parent.id,
    'archived_schema_name', parent.schema_name,
    'devices_rebound', v_submodels + v_legacy,
    'submodels_rebound', v_submodels,
    'legacy_pointers_rebound', v_legacy,
    'duplicate_submodels_removed', v_merged
  );
END;
$$;

--

-- FUNCTION publish_schema_version(draft_schema_id uuid) :: COMMENT
--

COMMENT ON FUNCTION public.publish_schema_version(draft_schema_id uuid) IS 'Activates a draft version, archives its parent, and atomically repoints every device_submodels row and legacy devices.schema_id from the parent to it.';

--

-- record_gateway_credential_issued(uuid) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.record_gateway_credential_issued(p_gateway_id uuid) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_gateway public.gateways%ROWTYPE;
  v_id      bigint;
BEGIN
  IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'insufficient privileges to record a gateway credential issue'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_gateway FROM public.gateways WHERE id = p_gateway_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gateway % does not exist', p_gateway_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  INSERT INTO public.digital_thread (
    entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
    causation_id, recorded_at
  ) VALUES (
    'gateways',
    v_gateway.id,
    'CREDENTIAL_ISSUED',
    NULL,
    -- The identity as it was at the time: `name` is mutable and the gateway may later be renamed or
    -- purged. No password and no hash of one: this table is readable by any holder of
    -- `digital_thread:read` and its rows cannot be deleted.
    jsonb_build_object(
      'name',           v_gateway.name,
      'sparkplug_id',   v_gateway.sparkplug_id,
      'deployment',     v_gateway.deployment,
      'mqtt_username',  v_gateway.sparkplug_id,
      'issued_at',      now()
    ),
    -- Not NULL, unlike 0026's: that function records a DAEMON's judgement and pins actor_source to
    -- 'ingestion'. This one records a PERSON's act, and the person is the reason the row exists.
    auth.uid(),
    'user',
    txid_current(),
    now()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

--

-- FUNCTION record_gateway_credential_issued(p_gateway_id uuid) :: COMMENT
--

COMMENT ON FUNCTION public.record_gateway_credential_issued(p_gateway_id uuid) IS 'Record that a broker credential was minted for a virtual gateway, as a CREDENTIAL_ISSUED row in digital_thread attributed to the calling operator. Carries the wire identity and never the password: the audit trail is append-only and the secret is reveal-once.';

--

-- record_gateway_credential_issued_by_service(uuid, jsonb) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.record_gateway_credential_issued_by_service(p_gateway_id uuid, p_context jsonb DEFAULT '{}'::jsonb) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_gateway public.gateways%ROWTYPE;
  v_id      bigint;
BEGIN
  IF p_gateway_id IS NULL THEN
    RAISE EXCEPTION 'record_gateway_credential_issued_by_service: p_gateway_id is required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  SELECT * INTO v_gateway FROM public.gateways WHERE id = p_gateway_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_gateway_credential_issued_by_service: gateway % does not exist',
      p_gateway_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- AN ARCHIVED GATEWAY IS REFUSED, and this is the one check that is not bookkeeping. 0037
  -- withdraws enrolment on archive precisely so a decommissioned appliance cannot come back through
  -- a credential; a provisioning run that reissued one and recorded it as routine would document
  -- the thing 0037 exists to prevent, in the table an auditor reads to check it did not happen.
  IF v_gateway.is_archived THEN
    RAISE EXCEPTION
      'record_gateway_credential_issued_by_service: % is archived. Archiving withdraws enrolment '
      '(0037), so a credential issued to it now is one nothing on this platform will honour.',
      v_gateway.sparkplug_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.digital_thread (
    entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
    causation_id, recorded_at
  ) VALUES (
    'gateways',
    v_gateway.id,
    -- THE SAME ACTION 0041 WRITES, deliberately. The inventory asks "does this gateway hold a
    -- credential", and an answer that depended on which route minted it would need every reader to
    -- know both names. The ROUTE is visible in `actor_source` for anyone who needs it.
    'CREDENTIAL_ISSUED',
    NULL,
    jsonb_build_object(
      'name',           v_gateway.name,
      'sparkplug_id',   v_gateway.sparkplug_id,
      'deployment',     v_gateway.deployment,
      'mqtt_username',  v_gateway.sparkplug_id,
      'issued_at',      now(),
      -- A ROTATION IS A REPLACEMENT AT THE BROKER, unlike a re-minted JWT, which is an ADDITION.
      -- mosquitto holds one password per username, so rotating invalidates the previous one --
      -- which means the inventory must not count two rows for one gateway as two live credentials.
      'rotated',        coalesce((p_context ->> 'rotated')::boolean, false),
      -- ASSERTED BY THE CALLER AND LABELLED AS SUCH -- 0043's convention, verbatim. Only these
      -- keys are lifted out of p_context: storing it wholesale would let a caller add fields that
      -- look authoritative.
      'claimed',        jsonb_build_object(
                          'os_user', p_context ->> 'os_user',
                          'host',    p_context ->> 'host',
                          'script',  p_context ->> 'script'
                        )
    ),
    -- NULL, and pinned 'service'. The caller holds a machine credential, so the row cannot name a
    -- person and does not pretend to.
    NULL,
    'service',
    txid_current(),
    now()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

--

-- FUNCTION record_gateway_credential_issued_by_service(p_gateway_id uuid, p_context jsonb) :: COMMENT
--

COMMENT ON FUNCTION public.record_gateway_credential_issued_by_service(p_gateway_id uuid, p_context jsonb) IS 'Record that a host script issued a broker credential to a gateway, as a CREDENTIAL_ISSUED row in digital_thread. Reachable by service_role ALONE -- 0041''s pair is the operator path and gates on has_role(), which no host script can satisfy. actor_source is pinned to ''service'' and changed_by to NULL; the host and OS user are stored under `claimed` because the database cannot verify either. Carries the wire identity and never the password.';

--

-- record_ingestion_rejection(uuid, jsonb, timestamp with time zone) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.record_ingestion_rejection(p_device_id uuid, p_violations jsonb, p_observed_at timestamp with time zone DEFAULT now()) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_device     RECORD;
    v_count      INTEGER;
    v_id         BIGINT;
    -- A CAP, not a guess. The daemon already deduplicates per device, but a payload with a
    -- thousand unmodelled metrics would otherwise put a thousand objects into one jsonb column of
    -- an append-only table that cannot be pruned. Fifty names is far more than an operator will
    -- read and enough to diagnose any real fault; the total is recorded separately so the
    -- truncation is visible rather than silent.
    c_max_listed CONSTANT INTEGER := 50;
BEGIN
    -- The gate stated in the body: the grant below is to `authenticated`, and without this any
    -- signed-in user could forge SCHEMA_REJECTION rows into an append-only table. Same shape as the
    -- other `ingest_*` gates: granted broadly, gated on identity inside.
    PERFORM public.require_ingestion_caller('record_ingestion_rejection');

    IF p_device_id IS NULL THEN
        RAISE EXCEPTION 'record_ingestion_rejection: p_device_id is required'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    IF jsonb_typeof(p_violations) <> 'array' THEN
        RAISE EXCEPTION 'record_ingestion_rejection: p_violations must be a JSON array, got %',
            coalesce(jsonb_typeof(p_violations), 'null')
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    v_count := jsonb_array_length(p_violations);
    IF v_count = 0 THEN
        -- Nothing was refused, so there is nothing to record. Returning NULL rather than raising:
        -- the daemon computing an empty violation list is the ordinary healthy case, and a caller
        -- should not have to guard against its own success.
        RETURN NULL;
    END IF;

    -- FAIL ON AN UNKNOWN DEVICE rather than writing an audit row about an entity that does not
    -- exist. `entity_id` is a bare uuid with no foreign key -- deliberately, so history survives a
    -- purge -- which means nothing else would catch a typo'd id, and the row would sit in the
    -- thread forever describing nothing.
    SELECT id, name, sparkplug_id, schema_id INTO v_device
      FROM public.devices WHERE id = p_device_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'record_ingestion_rejection: no device with id %', p_device_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    INSERT INTO public.digital_thread (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'devices',
        v_device.id,
        'SCHEMA_REJECTION',
        NULL,
        jsonb_build_object(
            -- The identity as it was AT THE TIME. `name` is mutable and the device may later be
            -- renamed or purged; an audit row that could only be read by joining to a live row
            -- would lose its meaning in exactly the cases it matters most.
            'name',            v_device.name,
            'sparkplug_id',    v_device.sparkplug_id,
            'schema_id',       v_device.schema_id,
            'observed_at',     p_observed_at,
            'violation_count', v_count,
            'violations',      CASE
                                 WHEN v_count <= c_max_listed THEN p_violations
                                 ELSE (
                                   SELECT jsonb_agg(value)
                                     FROM jsonb_array_elements(p_violations) WITH ORDINALITY t(value, n)
                                    WHERE n <= c_max_listed
                                 )
                               END,
            'truncated',       v_count > c_max_listed
        ),
        NULL,
        -- PINNED, not taken from a header. This function is the daemon's only route into the
        -- table, and what it records about the author is not negotiable by its caller.
        'ingestion',
        txid_current(),
        now()
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

--

-- FUNCTION record_ingestion_rejection(p_device_id uuid, p_violations jsonb, p_observed_at timestamp with time zone) :: COMMENT
--

COMMENT ON FUNCTION public.record_ingestion_rejection(p_device_id uuid, p_violations jsonb, p_observed_at timestamp with time zone) IS 'Record a Sparkplug payload the ingestion daemon refused, as a SCHEMA_REJECTION row in digital_thread. The violation list is capped at 50 entries with the true count kept alongside. actor_source is pinned to ''ingestion'' and changed_by to NULL: this is the narrow gate that replaces service_role''s direct INSERT on the audit table. Callable only by the Service_Ingestor principal (0051), which is what makes the grant to `authenticated` safe.';

--

-- record_service_token_issued(uuid, text, timestamp with time zone, jsonb) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.record_service_token_issued(p_principal_id uuid, p_jti text, p_expires_at timestamp with time zone, p_context jsonb DEFAULT '{}'::jsonb) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_roles    text[];
  v_is_service boolean;
  v_ttl_days numeric;
  v_id       bigint;
BEGIN
  IF p_principal_id IS NULL THEN
    RAISE EXCEPTION 'record_service_token_issued: p_principal_id is required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- A `jti` DOES NOT ENABLE REVOCATION and nothing here pretends otherwise. It exists so two
  -- tokens for one principal can be told apart -- so an operator holding a token can check whether
  -- it is the one this row describes, and so a re-mint is visibly a second credential rather than
  -- a replacement. Bounded because it lands in an append-only table that cannot be pruned.
  IF p_jti IS NULL OR length(p_jti) = 0 OR length(p_jti) > 64 THEN
    RAISE EXCEPTION 'record_service_token_issued: p_jti must be 1-64 characters (got %)',
      coalesce(length(p_jti)::text, 'null')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_expires_at IS NULL OR p_expires_at <= now() THEN
    RAISE EXCEPTION 'record_service_token_issued: p_expires_at must be in the future (got %)',
      coalesce(p_expires_at::text, 'null')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- THE CEILING. See the header: the script refuses this too, and because it records before it
  -- prints, a refusal here means the token never reaches anybody.
  v_ttl_days := extract(epoch FROM (p_expires_at - now())) / 86400.0;
  IF v_ttl_days > public.service_token_max_days() THEN
    RAISE EXCEPTION
      'record_service_token_issued: a token may not outlive % days (asked for %). These tokens '
      'cannot be revoked -- rotating SUPABASE_JWT_SECRET is the only way to invalidate one, and '
      'that invalidates every token in the stack.',
      public.service_token_max_days(), round(v_ttl_days, 1)
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The subject must be a service principal: no email and no password means nothing can present
  -- this identity except a JWT signed outside GoTrue. A token minted against a human login would
  -- be a permanent, unrevocable escalation of that person's session.
  SELECT (u.email IS NULL AND (u.encrypted_password IS NULL OR u.encrypted_password = ''))
    INTO v_is_service
    FROM auth.users u WHERE u.id = p_principal_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_service_token_issued: no principal with id %', p_principal_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NOT v_is_service THEN
    RAISE EXCEPTION
      'record_service_token_issued: % can sign in, so it is a person''s account and not a service '
      'principal. A long-lived token for it could not be revoked.', p_principal_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- WHAT THE TOKEN COULD DO AT THE MOMENT IT WAS SIGNED, captured rather than left to a join. 0026
  -- gives the reason: an audit row readable only by joining to a live row loses its meaning in
  -- exactly the cases it matters most -- and a role removed later does not shorten a token that
  -- was signed while it was held.
  SELECT coalesce(array_agg(r.name ORDER BY r.name), '{}'::text[])
    INTO v_roles
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
   WHERE ur.user_id = p_principal_id::text;

  INSERT INTO public.digital_thread (
    entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
    causation_id, recorded_at
  ) VALUES (
    -- NOT A TABLE NAME, which every other entity_type is. There is no public table of service
    -- principals -- they are auth.users rows, and auth is GoTrue's schema. DigitalThreadTab
    -- renders this type explicitly for that reason; see the note there.
    'service_principals',
    p_principal_id,
    'TOKEN_MINTED',
    NULL,
    jsonb_build_object(
      'jti',          p_jti,
      'issued_at',    now(),
      'expires_at',   p_expires_at,
      'ttl_days',     round(v_ttl_days, 1),
      'roles',        to_jsonb(v_roles),
      -- ASSERTED BY THE CALLER AND LABELLED AS SUCH. The database cannot verify either value, and
      -- a key called `issued_by` would have read as an attribution. Only these two are lifted out
      -- of p_context: storing it wholesale would let a caller add fields that look authoritative.
      'claimed',      jsonb_build_object(
                        'os_user', p_context ->> 'os_user',
                        'host',    p_context ->> 'host'
                      )
    ),
    -- NULL, like 0026's. There is no person here to name: the caller holds a machine credential.
    NULL,
    -- PINNED, not taken from a header. 'user' is refused from a header by
    -- log_digital_thread_event() precisely because claiming a human author is the assertion a
    -- client must not be able to make about itself; the same reasoning applies to a function.
    'service',
    txid_current(),
    now()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

--

-- FUNCTION record_service_token_issued(p_principal_id uuid, p_jti text, p_expires_at timestamp with time zone, p_context jsonb) :: COMMENT
--

COMMENT ON FUNCTION public.record_service_token_issued(p_principal_id uuid, p_jti text, p_expires_at timestamp with time zone, p_context jsonb) IS 'Record that a long-lived JWT was signed for a service principal, as a TOKEN_MINTED row in digital_thread. Refuses a human account and any expiry beyond service_token_max_days(). actor_source is pinned to ''service'' and changed_by to NULL: the caller holds a machine credential, so the row cannot name a person and does not pretend to.';

--

-- refresh_directory_liveness() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.refresh_directory_liveness() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'net'
    AS $$
DECLARE
    v_prev      bigint;
    v_status    integer;
    v_body      jsonb;
    v_observed  integer := 0;
    v_url       CONSTANT text := 'http://prometheus:9090/api/v1/query?query=up';
BEGIN
    SELECT request_id INTO v_prev FROM public.directory_liveness_probe WHERE id;

    -- ---- Collect the previous run's answer, if there was one. --------------------------------
    IF v_prev IS NOT NULL THEN
        SELECT status_code, CASE WHEN content IS NULL THEN NULL ELSE content::jsonb END
          INTO v_status, v_body
          FROM net._http_response WHERE id = v_prev;

        -- A 200 WITH A BODY IS THE ONLY THING THAT WRITES ACTIVE. Every other outcome -- no row
        -- yet, a timeout, a non-200, unparseable content -- falls through to the UNKNOWN sweep
        -- below. Leaving the previous values in place would be the original defect again: a status
        -- that describes an observation nobody made.
        IF v_status = 200 AND v_body IS NOT NULL AND v_body->>'status' = 'success' THEN
            WITH observed AS (
                SELECT r->'metric'->>'job'  AS job,
                       (r->'value'->>1)     AS up
                  FROM jsonb_array_elements(v_body->'data'->'result') AS r
            ), mapped AS (
                SELECT m.service_name, o.up
                  FROM public.directory_liveness_job_map() m
                  JOIN observed o ON o.job = m.prometheus_job
            )
            UPDATE public.directory_services d
               SET status = CASE WHEN mapped.up = '1' THEN 'ACTIVE' ELSE 'DOWN' END,
                   -- ONLY AN UP READING MOVES THE HEARTBEAT. For DOWN it is cleared rather than
                   -- frozen: "last seen at X" and "not up now" are different claims, and a
                   -- lingering timestamp beside a red status reads as the former.
                   last_heartbeat = CASE WHEN mapped.up = '1' THEN now() ELSE NULL END
              FROM mapped
             WHERE d.service_name = mapped.service_name;

            GET DIAGNOSTICS v_observed = ROW_COUNT;
        END IF;
    END IF;

    -- ---- Everything unobserved is set UNKNOWN on EVERY run. ----------------------------------
    -- Not only on the first. If a job disappears from prometheus.yml, or a service is renamed so
    -- the map stops matching, its row must fall back to UNKNOWN rather than keeping the last
    -- ACTIVE it was ever given -- which would be a fabricated status with a real timestamp, the
    -- most convincing kind.
    UPDATE public.directory_services
       SET status = 'UNKNOWN', last_heartbeat = NULL
     WHERE service_name NOT IN (SELECT service_name FROM public.directory_liveness_job_map())
       AND (status <> 'UNKNOWN' OR last_heartbeat IS NOT NULL);

    -- ---- Fire the next request. ---------------------------------------------------------------
    -- AFTER the collection, so a failure above does not cost this run its probe.
    UPDATE public.directory_liveness_probe
       SET request_id = net.http_get(v_url, timeout_milliseconds := 4000),
           requested_at = now()
     WHERE id;

    RETURN v_observed;
END;
$$;

--

-- FUNCTION refresh_directory_liveness() :: COMMENT
--

COMMENT ON FUNCTION public.refresh_directory_liveness() IS 'Collects the previous Prometheus `up` probe, writes ACTIVE/DOWN for the six observed services and UNKNOWN for the rest, then queues the next probe. Returns how many rows were written from a real observation. Run every minute by cron; safe to call by hand.';

--

-- refuse_archiving_the_last_shadow_gateway() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.refuse_archiving_the_last_shadow_gateway() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  -- ON THE TRANSITION ONLY. An ordinary edit to an already-archived gateway must not be refused,
  -- and neither must un-archiving one -- which is the repair this error tells an operator to make.
  IF NOT NEW.is_archived OR COALESCE(OLD.is_archived, false) THEN
    RETURN NEW;
  END IF;

  IF NOT NEW.is_shadow THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.gateways g
     WHERE g.is_shadow AND NOT g.is_archived AND g.id <> NEW.id
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'gateway % is the only playback gateway on this stack, and archiving it would leave broker '
    'playback with no edge node to publish as. ensure_shadow_devices() (0060) looks it up by the '
    'is_shadow flag, so the failure would arrive later, at the moment somebody starts a job. Mark '
    'another gateway is_shadow first, then archive this one.',
    NEW.name
    USING ERRCODE = 'restrict_violation';
END $$;

--

-- FUNCTION refuse_archiving_the_last_shadow_gateway() :: COMMENT
--

COMMENT ON FUNCTION public.refuse_archiving_the_last_shadow_gateway() IS 'Refuses the archive that would leave a stack with no un-archived shadow gateway. Not a ban on archiving one: swapping in a replacement first is legitimate and is what 0060''s own error text tells an operator to do.';

--

-- register_uploaded_capture(text, uuid, text, bigint, integer, jsonb, text, boolean) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.register_uploaded_capture(p_subject_kind text, p_subject_id uuid, p_storage_path text, p_size_bytes bigint, p_message_count integer, p_manifest jsonb DEFAULT '{}'::jsonb, p_note text DEFAULT NULL::text, p_replace boolean DEFAULT false) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;

--

-- release_gateway_enrollment_token(text) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.release_gateway_enrollment_token(p_token text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_hash     text;
  v_released integer;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RETURN false;
  END IF;

  v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  UPDATE public.gateway_enrollment_tokens t
     SET consumed_at = NULL
   WHERE t.token_hash = v_hash
     AND t.consumed_at IS NOT NULL
     AND t.expires_at > now()
     AND NOT EXISTS (
       SELECT 1 FROM public.gateway_enrollment_tokens o
        WHERE o.gateway_id = t.gateway_id
          AND o.consumed_at IS NULL
     );

  GET DIAGNOSTICS v_released = ROW_COUNT;
  RETURN v_released = 1;
END $_$;

--

-- FUNCTION release_gateway_enrollment_token(p_token text) :: COMMENT
--

COMMENT ON FUNCTION public.release_gateway_enrollment_token(p_token text) IS 'Undo a claim made by consume_gateway_enrollment_token() when the credential could not be issued, so the appliance can retry with the same bundle. Refuses to release an expired token or one that has since been superseded by a re-issue -- both would restore a row the partial unique index counts, blocking the operator from issuing a replacement. Returns whether it released.';

--

-- relocate_devices(jsonb) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.relocate_devices(p_moves jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_move      jsonb;
  v_device_id uuid;
  v_scope     text;
  v_cell      uuid;
  v_raw_cell  text;
  v_len       integer;
  v_applied   integer := 0;
  v_unchanged integer := 0;
  v_before    public.devices%ROWTYPE;
  v_after     public.devices%ROWTYPE;
  v_results   jsonb := '[]'::jsonb;
  v_changed   boolean;
BEGIN
  -- Fail closed, before anything observable happens. SECURITY DEFINER means RLS does not apply
  -- inside this function, so the allow-list `devices_update_privileged` uses is re-derived here.
  IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'insufficient privileges to relocate devices'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_moves IS NULL OR jsonb_typeof(p_moves) <> 'array' THEN
    RAISE EXCEPTION 'p_moves must be a JSON array of moves, got %',
                    COALESCE(jsonb_typeof(p_moves), 'null')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_len := jsonb_array_length(p_moves);

  -- An empty batch is a CALLER BUG, not a no-op, and it is raised rather than absorbed. The page
  -- disables Apply at zero staged moves; a request arriving here with none means that guard is
  -- gone, and answering "success, nothing done" would make the regression invisible.
  IF v_len = 0 THEN
    RAISE EXCEPTION 'p_moves is empty; nothing to relocate'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- A ceiling, because there is not one anywhere else. Every row below takes a FOR UPDATE lock
  -- held until commit, so an unbounded array is an unbounded lock hold on `devices` by an
  -- ordinary authenticated user. 200 is far above any plausible rearrange gesture -- the page
  -- renders one draggable chip per device -- and far below anything that would matter.
  IF v_len > 200 THEN
    RAISE EXCEPTION 'a relocation batch is limited to 200 moves; got %', v_len
      USING ERRCODE = 'program_limit_exceeded',
            HINT = 'Apply the rearrangement in smaller batches.';
  END IF;

  -- ONE DEVICE MAY APPEAR ONCE. Dragging a chip twice before applying is a legitimate gesture and
  -- the page collapses it to a single staged entry keyed by device -- but if two entries ever do
  -- arrive, "last one wins" would silently discard an instruction the operator gave. The whole
  -- point of a batch is that its outcome is stated, so an ambiguous batch is refused instead.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_moves) m
     GROUP BY m ->> 'device_id'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'p_moves names the same device more than once; a batch must state one destination per device'
      USING ERRCODE = 'cardinality_violation';
  END IF;

  -- ORDERED BY device_id, AND THAT ORDER IS LOAD-BEARING. Each iteration takes a row lock held
  -- until commit, so two operators applying overlapping batches in opposite orders would deadlock
  -- and one of them would lose a rearrangement to a message about a lock. A total order over the
  -- locked rows makes that impossible, and the primary key is the cheapest one available.
  FOR v_move IN
    SELECT m FROM jsonb_array_elements(p_moves) m ORDER BY m ->> 'device_id'
  LOOP
    IF jsonb_typeof(v_move) <> 'object' THEN
      RAISE EXCEPTION 'every element of p_moves must be an object, got %', jsonb_typeof(v_move)
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF (v_move ->> 'device_id') IS NULL THEN
      RAISE EXCEPTION 'every move must name a device_id' USING ERRCODE = 'null_value_not_allowed';
    END IF;

    BEGIN
      v_device_id := (v_move ->> 'device_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'device_id % is not a uuid', v_move ->> 'device_id'
        USING ERRCODE = 'invalid_parameter_value';
    END;

    -- REQUIRED, NOT DEFAULTED TO 'cell'. Defaulting would mean a caller that simply forgot the
    -- key silently clears `site_wide` off an asset deliberately marked as having no cell -- an
    -- assertion an operator made, undone by an omission. Absent is not the same as 'cell' here,
    -- so absent is an error.
    v_scope := v_move ->> 'location_scope';
    IF v_scope IS NULL THEN
      RAISE EXCEPTION 'move for device % must state location_scope (cell or site_wide)', v_device_id
        USING ERRCODE = 'null_value_not_allowed';
    END IF;
    IF v_scope NOT IN ('cell', 'site_wide') THEN
      RAISE EXCEPTION 'location_scope % is not valid for device %; expected cell or site_wide',
                      v_scope, v_device_id
        USING ERRCODE = 'check_violation';
    END IF;

    -- Empty string reads as absent, the same normalisation `emptyToNull()` performs on the
    -- single-device path in frontend/src/api.js. Two spellings of "no cell" is how a
    -- `WHERE cell_id IS NULL` starts missing rows.
    v_raw_cell := NULLIF(btrim(COALESCE(v_move ->> 'cell_id', '')), '');
    IF v_raw_cell IS NULL THEN
      v_cell := NULL;
    ELSE
      BEGIN
        v_cell := v_raw_cell::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'cell_id % is not a uuid', v_raw_cell
          USING ERRCODE = 'invalid_parameter_value';
      END;
    END IF;

    -- Mirrors devices_site_wide_has_no_cell, and mirrors locationFieldsFrom() in
    -- frontend/src/api.js which normalises the same way on the single-device path. FORCED rather
    -- than rejected: "site-wide, in cell 3" is not a refusal case, it is an incompletely cleared
    -- form, and the CHECK constraint would refuse it with a message naming a constraint.
    IF v_scope = 'site_wide' THEN
      v_cell := NULL;
    END IF;

    -- FOR UPDATE, for the ordering reason above and because the no-op comparison below has to be
    -- read against a row nobody else can move underneath it.
    SELECT * INTO v_before FROM public.devices WHERE id = v_device_id FOR UPDATE;
    IF NOT FOUND THEN
      -- THE WHOLE BATCH FAILS, and that is the behaviour this item asks for. A half-applied
      -- rearrangement is the failure mode deferring the commit exists to remove, so one unknown
      -- device rolls back the other five moves rather than leaving them applied and unrecorded.
      RAISE EXCEPTION 'device % not found; no part of this batch was applied', v_device_id
        USING ERRCODE = 'no_data_found';
    END IF;

    IF v_cell IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.cells c WHERE c.id = v_cell) THEN
      RAISE EXCEPTION 'cell % not found; no part of this batch was applied', v_cell
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- THE GATEWAY IS DELIBERATELY LEFT ALONE, exactly as the single-device drop path leaves it.
    -- A drop says where the machine IS; it says nothing about which connector reaches it, and
    -- rewiring the data path to express a location is the coupling archived migration 0036
    -- removed. Only these two columns move.
    UPDATE public.devices
       SET cell_id        = v_cell,
           location_scope = v_scope
     WHERE id = v_device_id
    RETURNING * INTO v_after;

    v_changed := v_before.cell_id IS DISTINCT FROM v_after.cell_id
              OR v_before.location_scope IS DISTINCT FROM v_after.location_scope;

    -- A move that changes nothing is COUNTED, but not called applied. The audit trigger already
    -- suppresses the no-op row -- `to_jsonb(NEW) - 'last_heartbeat' IS NOT DISTINCT FROM OLD` in
    -- 0005 -- so reporting it as applied would promise a thread row that deliberately does not
    -- exist. Dragging a device back where it started is the ordinary way this arises.
    IF v_changed THEN
      v_applied := v_applied + 1;
    ELSE
      v_unchanged := v_unchanged + 1;
    END IF;

    v_results := v_results || jsonb_build_object(
      'device_id',      v_after.id,
      'cell_id',        v_after.cell_id,
      'location_scope', v_after.location_scope,
      'changed',        v_changed
    );
  END LOOP;

  RETURN jsonb_build_object(
    -- REPORTED, NOT GENERATED. This is the transaction the UPDATEs above ran in, which is the
    -- same number `log_digital_thread_event()` stamped on every row it wrote -- so a caller can
    -- follow it straight into the Digital Thread's "Same transaction" view. NULL when nothing
    -- changed, because the trigger then wrote no row at all: handing back a transaction id with
    -- no rows under it would be a link to an empty result.
    'causation_id', CASE WHEN v_applied > 0 THEN txid_current() ELSE NULL END,
    'requested',    v_len,
    'applied',      v_applied,
    'unchanged',    v_unchanged,
    'devices',      v_results
  );
END;
$$;

--

-- FUNCTION relocate_devices(p_moves jsonb) :: COMMENT
--

COMMENT ON FUNCTION public.relocate_devices(p_moves jsonb) IS 'Apply a batch of device relocations in ONE transaction, so the whole rearrangement shares a single digital_thread causation_id. Refuses the batch outright on an unknown device, an unknown cell, a duplicate device or a missing location_scope -- a half-applied batch is the failure mode this exists to remove. Authority: Administrator or Shopfloor_Manager.';

--

-- request_capture_stop(uuid) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.request_capture_stop(p_job_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;

--

-- request_gateway_rebirth(uuid) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.request_gateway_rebirth(p_gateway_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_gateway public.gateways;
    v_id      uuid;
BEGIN
    -- THE SAME AUTHORITY AS RECORDING, not a lower one. A rebirth is harmless to the process and
    -- still momentarily affects the live stream for every subscriber to that node, so it belongs
    -- with the acts an operator takes deliberately rather than with the pages anyone may read.
    IF NOT public.may_manage_captures() THEN
        RAISE EXCEPTION
          'request_gateway_rebirth: requires Administrator or Shopfloor_Manager'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_gateway FROM public.gateways WHERE id = p_gateway_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'request_gateway_rebirth: no gateway %', p_gateway_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF v_gateway.is_archived THEN
        RAISE EXCEPTION
          'request_gateway_rebirth: gateway % is archived, so nothing is listening for the request.',
          v_gateway.name USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- ALREADY ASKED. Reported rather than left to the unique index, so the message says what is
    -- happening instead of naming a constraint.
    IF EXISTS (
        SELECT 1 FROM public.rebirth_requests
         WHERE gateway_id = p_gateway_id AND status = 'PENDING'
    ) THEN
        RAISE EXCEPTION
          'request_gateway_rebirth: a rebirth request for % is already waiting to be sent.',
          v_gateway.name USING ERRCODE = 'unique_violation';
    END IF;

    INSERT INTO public.rebirth_requests
        (gateway_id, edge_node_id, sparkplug_group, requested_by)
    VALUES
        (v_gateway.id, v_gateway.sparkplug_id, v_gateway.sparkplug_group, auth.uid())
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

--

-- FUNCTION request_gateway_rebirth(p_gateway_id uuid) :: COMMENT
--

COMMENT ON FUNCTION public.request_gateway_rebirth(p_gateway_id uuid) IS 'Ask an edge node to republish its birth certificate. The only way a rebirth_requests row is created. The daemon sends it; this only records that somebody asked.';

--

-- request_playback_stop(uuid) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.request_playback_stop(p_job_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_status text;
BEGIN
    IF NOT public.may_manage_captures() THEN
        RAISE EXCEPTION 'request_playback_stop: requires Administrator or Shopfloor_Manager'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT status INTO v_status FROM public.playback_jobs WHERE id = p_job_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'request_playback_stop: no playback job %', p_job_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF v_status NOT IN ('PENDING', 'RUNNING') THEN
        RETURN false;
    END IF;

    -- A PENDING job the worker has never claimed is cancelled outright, for 0055's reason: setting
    -- a flag on it would leave the row PENDING forever if the worker is down, and the per-target
    -- index would then block every future playback onto that gateway with nothing to point at.
    IF v_status = 'PENDING' THEN
        UPDATE public.playback_jobs
           SET status = 'CANCELLED', stop_requested = true, finished_at = now(),
               error = 'cancelled before the worker claimed it'
         WHERE id = p_job_id;
        RETURN true;
    END IF;

    UPDATE public.playback_jobs SET stop_requested = true WHERE id = p_job_id;
    RETURN true;
END;
$$;

--

-- require_ingestion_caller(text) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.require_ingestion_caller(p_fn text) RETURNS void
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
BEGIN
    IF NOT public.is_ingestion_caller() THEN
        -- 42501, the same code a failed RLS WITH CHECK raises, so a caller that loses this
        -- privilege fails the way it would have failed against the policy.
        RAISE EXCEPTION '%: only the ingestion principal may call this', p_fn
            USING ERRCODE = 'insufficient_privilege';
    END IF;
END;
$$;

--

-- require_playback_caller(text) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.require_playback_caller(p_fn text) RETURNS void
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
BEGIN
    IF NOT public.is_playback_caller() THEN
        -- 42501, the same code a failed RLS WITH CHECK raises, so a caller that loses this
        -- privilege fails the way it would have failed against a policy.
        RAISE EXCEPTION '%: only the playback worker may call this', p_fn
            USING ERRCODE = 'insufficient_privilege';
    END IF;
END;
$$;

--

-- revoke_anon_function_privileges() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.revoke_anon_function_privileges() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  fn        oid;
  all_fns   oid[];
  keep_auth oid[] := ARRAY[]::oid[];
  keep_svc  oid[] := ARRAY[]::oid[];
  v_before  int;
BEGIN
  SELECT coalesce(array_agg(p.oid), ARRAY[]::oid[]) INTO all_fns
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public';

  SELECT count(*) INTO v_before
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND has_function_privilege('anon', p.oid, 'EXECUTE');

  -- ---------------------------------------------------------------------------------------------
  -- A direct grant, not an effective privilege. has_function_privilege() answers TRUE when the
  -- only thing granting EXECUTE is PUBLIC, which the revoke loop below is about to remove, so
  -- asking it here made the sweep copy the privilege it was removing onto `authenticated` on a
  -- first boot. aclexplode() lists grants actually made to the role; a NULL proacl yields no
  -- rows, which is the right answer.
  -- ---------------------------------------------------------------------------------------------
  FOREACH fn IN ARRAY all_fns LOOP
    IF EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
                WHERE p.oid = fn AND a.grantee = 'authenticated'::regrole
                  AND a.privilege_type = 'EXECUTE') THEN
      keep_auth := keep_auth || fn;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
                WHERE p.oid = fn AND a.grantee = 'service_role'::regrole
                  AND a.privilege_type = 'EXECUTE') THEN
      keep_svc := keep_svc || fn;
    END IF;
  END LOOP;

  FOREACH fn IN ARRAY all_fns LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', fn::regprocedure);
  END LOOP;

  FOREACH fn IN ARRAY keep_auth LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn::regprocedure);
  END LOOP;
  FOREACH fn IN ARRAY keep_svc LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn::regprocedure);
  END LOOP;

  -- The number this call actually corrected, so a boot log says whether it did anything. On a
  -- settled database it is 0 on every boot, which is the house rule for a replayed migration.
  RETURN v_before;
END;
$$;

--

-- FUNCTION revoke_anon_function_privileges() :: COMMENT
--

COMMENT ON FUNCTION public.revoke_anon_function_privileges() IS 'Revoke EXECUTE from PUBLIC and anon on every function in public, restoring what authenticated and service_role held. MUST BE CALLED BY THE LAST MIGRATION THAT CREATES A FUNCTION -- see 0071. PostgreSQL grants EXECUTE to PUBLIC on creation, so a function added after the sweep is anon-executable until the next call.';

--

-- revoke_credential_on_decommission() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.revoke_credential_on_decommission() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The only attempt this one gets; see 0038's header.
    IF public.gateway_has_broker_credential(OLD) THEN
      PERFORM public.revoke_gateway_credential(OLD.sparkplug_id);
    END IF;
    RETURN OLD;
  END IF;

  -- On the TRANSITION, so an ordinary edit to an already-archived gateway does not re-rotate a
  -- credential that was revoked weeks ago and re-stamp when it happened.
  IF NEW.is_archived AND NOT COALESCE(OLD.is_archived, false)
     AND public.gateway_has_broker_credential(NEW) THEN
    IF public.revoke_gateway_credential(NEW.sparkplug_id) THEN
      -- Stamped OPTIMISTICALLY, because net.http_post is asynchronous and cannot report back
      -- inside this transaction. The sweep re-reads net._http_response and CLEARS this stamp if
      -- the call did not succeed, which is what turns an optimistic write into an eventually
      -- correct one.
      UPDATE public.gateways SET credential_revoked_at = now() WHERE id = NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END $$;

--

-- FUNCTION revoke_credential_on_decommission() :: COMMENT
--

COMMENT ON FUNCTION public.revoke_credential_on_decommission() IS 'Rotates a decommissioned gateway''s broker credential to a password nobody records. Gated on gateway_has_broker_credential() (0056), NOT gateway_holds_a_credential() (0038): the latter asks about physical enrolment and therefore refused every virtual gateway, which is every gateway a provisioned stack has. The gate still cannot admit a gateway that never held an account, so 0040''s guarantee -- revocation never CREATES one -- is preserved.';

--

-- revoke_gateway_credential(text) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.revoke_gateway_credential(p_sparkplug_id text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_url    text;
  v_anon   text;
  v_secret text;
BEGIN
  IF p_sparkplug_id IS NULL OR p_sparkplug_id !~ '^gwy[0-9a-f]{21}$' THEN
    RETURN false;
  END IF;

  SELECT decrypted_secret INTO v_url    FROM vault.decrypted_secrets WHERE name = 'supabase_functions_url';
  SELECT decrypted_secret INTO v_anon   FROM vault.decrypted_secrets WHERE name = 'supabase_anon_key';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'gateway_revoke_secret';

  -- A STACK WITH NOTHING CONFIGURED DOES NOTHING rather than sending a bare "Bearer ". The call
  -- would answer 401 or 503 either way; not making it keeps the failure legible as "not
  -- configured" rather than as "rejected". Same reasoning as 0006's webhook signer.
  IF coalesce(v_url,'') = '' OR coalesce(v_anon,'') = '' OR coalesce(v_secret,'') = '' THEN
    RETURN false;
  END IF;

  -- Through the gateway to the edge function, not straight at the credential service: the chart
  -- admits only `supabase-functions` to that service. `apikey` gets past the gateway;
  -- `x-revoke-secret` is what authorises the act.
  PERFORM net.http_post(
    url     := rtrim(v_url, '/') || '/revoke-gateway-credential',
    headers := jsonb_build_object(
                 'Content-Type',    'application/json',
                 'apikey',          v_anon,
                 'Authorization',   'Bearer ' || v_anon,
                 'x-revoke-secret', v_secret),
    body    := jsonb_build_object('sparkplug_id', p_sparkplug_id)
  );

  RETURN true;
END $_$;

--

-- FUNCTION revoke_gateway_credential(p_sparkplug_id text) :: COMMENT
--

COMMENT ON FUNCTION public.revoke_gateway_credential(p_sparkplug_id text) IS 'Rotate a gateway''s broker account to a password nobody records, which is how this platform revokes -- the credential service is add-only by design and must not gain a delete verb. Returns false when the service is not configured. ASYNCHRONOUS: net.http_post queues the request, so a true return means "asked", not "revoked". The sweep is what makes archive eventually correct.';

--

-- schema_version_base_name(text) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.schema_version_base_name(schema_name text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $_$
  SELECT regexp_replace(COALESCE(schema_name, ''), '_v[0-9]+$', '');
$_$;

--

-- FUNCTION schema_version_base_name(schema_name text) :: COMMENT
--

COMMENT ON FUNCTION public.schema_version_base_name(schema_name text) IS 'The lineage stem of a versioned schema name. Mirrored by baseSchemaName() in frontend/src/utils/schemaVersion.js -- keep the two in step.';

--

-- seed_setting(text, jsonb, text, text, text, text, text) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.seed_setting(p_key text, p_value jsonb, p_value_type text, p_category text, p_label text, p_description text DEFAULT NULL::text, p_fallback_source text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
    INSERT INTO public.system_settings
        (key, value, value_type, category, label, description, fallback_source)
    VALUES
        (p_key, p_value, p_value_type, p_category, p_label, p_description, p_fallback_source)
    ON CONFLICT (key) DO UPDATE SET
        value_type      = EXCLUDED.value_type,
        category        = EXCLUDED.category,
        label           = EXCLUDED.label,
        description     = EXCLUDED.description,
        fallback_source = EXCLUDED.fallback_source;
END;
$$;

--

-- FUNCTION seed_setting(p_key text, p_value jsonb, p_value_type text, p_category text, p_label text, p_description text, p_fallback_source text) :: COMMENT
--

COMMENT ON FUNCTION public.seed_setting(p_key text, p_value jsonb, p_value_type text, p_category text, p_label text, p_description text, p_fallback_source text) IS 'Declare a setting from a migration. Inserts on first boot and refreshes only the metadata afterwards, so an operator''s value survives every replay. Not reachable through PostgREST.';

--

-- service_token_max_days() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.service_token_max_days() RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$ SELECT 90 $$;

--

-- FUNCTION service_token_max_days() :: COMMENT
--

COMMENT ON FUNCTION public.service_token_max_days() IS 'The longest life a service-principal token may be recorded with (90 days). Mirrored by the --days ceiling in scripts/mint-mcp-token.mjs; these tokens cannot be revoked, so the expiry is the only bound that exists.';

--

-- stamp_audit_domain() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.stamp_audit_domain() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.audit_domain := public.audit_domain_for(NEW.entity_type, NEW.action);
  RETURN NEW;
END;
$$;

--

-- start_capture_job(text, uuid, text, integer, boolean) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.start_capture_job(p_subject_kind text, p_subject_id uuid, p_note text DEFAULT NULL::text, p_max_seconds integer DEFAULT 300, p_replace boolean DEFAULT false) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
    -- `p_replace` makes overwriting a stored capture something the caller has to say; an API caller
    -- that never saw the modal is refused with the note of the capture it was about to destroy.
    -- Nothing is destroyed here: the old row and object survive until `ingest_finalise_capture()`
    -- swaps them at the end.
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
    -- The partial unique index enforces this; the lookup exists so the refusal names the job in
    -- the way rather than a 23505.
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
    -- The storage path is derived from the subject: at most one object per subject, so a
    -- replacement overwrites the key, and the path satisfies the bucket's prefix policy by
    -- construction.
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
$$;

--

-- FUNCTION start_capture_job(p_subject_kind text, p_subject_id uuid, p_note text, p_max_seconds integer, p_replace boolean) :: COMMENT
--

COMMENT ON FUNCTION public.start_capture_job(p_subject_kind text, p_subject_id uuid, p_note text, p_max_seconds integer, p_replace boolean) IS 'Queue a broker capture of one gateway or one device. The only way a capture_jobs row is created. Refuses without Administrator or Shopfloor_Manager, refuses a second concurrent capture, and refuses to overwrite a stored capture unless p_replace is true -- which is what makes the replace confirmation a property of the schema rather than of the frontend.';

--

-- start_playback_job(uuid, uuid, jsonb, numeric) :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.start_playback_job(p_capture_id uuid, p_target_gateway_id uuid, p_device_map jsonb DEFAULT '{}'::jsonb, p_speed numeric DEFAULT 1.0) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_gateway  public.gateways;
    v_capture  public.captures;
    v_running  RECORD;
    v_key      text;
    v_target   text;
    v_job_id   uuid;
BEGIN
    IF NOT public.may_manage_captures() THEN
        RAISE EXCEPTION
          'start_playback_job: publishing a capture requires Administrator or Shopfloor_Manager'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_capture FROM public.captures WHERE id = p_capture_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'start_playback_job: no capture %', p_capture_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    SELECT * INTO v_gateway FROM public.gateways WHERE id = p_target_gateway_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'start_playback_job: no gateway %', p_target_gateway_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- ------------------------------------------------------------------------------------
    -- TIER ONE: the target must be marked simulated
    -- ------------------------------------------------------------------------------------
    -- A refusal, not a warning: the historian records a replayed reading identically to an
    -- observed one, and `is_simulated` is the only thing that says otherwise.
    IF NOT v_gateway.is_simulated THEN
        RAISE EXCEPTION
          'start_playback_job: gateway % is not marked simulated. Publishing a capture onto it '
          'would write synthetic telemetry that nothing downstream can tell from observed data. '
          'Mark it simulated (0052) or choose a playback target.', v_gateway.name
            USING ERRCODE = 'check_violation';
    END IF;

    IF v_gateway.is_archived THEN
        RAISE EXCEPTION 'start_playback_job: gateway % is archived.', v_gateway.name
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- ------------------------------------------------------------------------------------
    -- TIER TWO, the database half: the target must hold a broker credential
    -- ------------------------------------------------------------------------------------
    -- Not `status = 'ONLINE'`: a playback target is legitimately OFFLINE until a playback runs.
    -- This proves the credential exists, not that the worker holds it (the worker refuses for
    -- itself). `gateway_has_broker_credential()`, not `gateway_holds_a_credential()`, which means
    -- "physical and enrolled" and excludes every virtual gateway.
    IF NOT public.gateway_has_broker_credential(v_gateway) THEN
        RAISE EXCEPTION
          'start_playback_job: gateway % holds no broker credential, so nothing can authenticate '
          'as it. Issue one from the Access Control page first -- that is also how you obtain the '
          'password the playback worker needs.', v_gateway.name
            USING ERRCODE = 'check_violation';
    END IF;

    -- ------------------------------------------------------------------------------------
    -- The device map
    -- ------------------------------------------------------------------------------------
    -- Every target must be a device of this gateway: publishing another gateway's device segment
    -- is exactly what `verify_gateway_binding()` quarantines.
    FOR v_key, v_target IN SELECT key, value FROM jsonb_each_text(coalesce(p_device_map, '{}'::jsonb))
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM public.devices d
             WHERE d.sparkplug_id = v_target AND d.gateway_id = p_target_gateway_id
               AND NOT d.is_archived
        ) THEN
            RAISE EXCEPTION
              'start_playback_job: % maps to %, which is not an active device of gateway %.',
              v_key, v_target, v_gateway.name
                USING ERRCODE = 'foreign_key_violation';
        END IF;
    END LOOP;

    -- ------------------------------------------------------------------------------------
    -- One playback per target, reported rather than left to the index
    -- ------------------------------------------------------------------------------------
    SELECT j.id, j.status INTO v_running
      FROM public.playback_jobs j
     WHERE j.target_gateway_id = p_target_gateway_id AND j.status IN ('PENDING', 'RUNNING')
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION
          'start_playback_job: a playback onto % is already %. Two publishers on one edge node '
          'interleave their sequence numbers, which the daemon reports as permanent message loss.',
          v_gateway.name, lower(v_running.status)
            USING ERRCODE = 'unique_violation';
    END IF;

    INSERT INTO public.playback_jobs (
        capture_id, capture_storage_path, target_gateway_id, target_edge_node_id,
        sparkplug_group, device_map, speed, status, requested_by
    ) VALUES (
        v_capture.id, v_capture.storage_path, v_gateway.id, v_gateway.sparkplug_id,
        v_gateway.sparkplug_group, coalesce(p_device_map, '{}'::jsonb),
        least(greatest(coalesce(p_speed, 1.0), 0.01), 60), 'PENDING', auth.uid()
    )
    RETURNING id INTO v_job_id;

    RETURN v_job_id;
END;
$$;

--

-- FUNCTION start_playback_job(p_capture_id uuid, p_target_gateway_id uuid, p_device_map jsonb, p_speed numeric) :: COMMENT
--

COMMENT ON FUNCTION public.start_playback_job(p_capture_id uuid, p_target_gateway_id uuid, p_device_map jsonb, p_speed numeric) IS 'Queue a capture for publication onto a simulated gateway. The only way a playback_jobs row is created. Refuses a target that is not is_simulated, one holding no broker credential, a device map naming devices of another gateway, and a second concurrent playback onto the same edge node. See 0056''s header for the three tiers this is the first of.';

--

-- sweep_gateway_credential_revocations() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.sweep_gateway_credential_revocations() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_row     record;
  v_asked   int := 0;
BEGIN
  -- FIRST, UNDO OPTIMISM THAT TURNED OUT TO BE WRONG. A stamp written by the trigger means the
  -- request was QUEUED. If pg_net recorded a non-2xx answer, or recorded nothing at all within
  -- five minutes, the revocation did not happen and the stamp is a lie -- clearing it puts the
  -- gateway back into the retry set below.
  UPDATE public.gateways g
     SET credential_revoked_at = NULL
   WHERE g.is_archived
     AND g.credential_revoked_at IS NOT NULL
     AND g.credential_revoked_at < now() - interval '5 minutes'
     AND NOT EXISTS (
       SELECT 1 FROM net._http_response r
        WHERE r.created >= g.credential_revoked_at - interval '1 minute'
          AND r.status_code BETWEEN 200 AND 299
     );

  FOR v_row IN
    SELECT sparkplug_id FROM public.gateways g
     WHERE g.is_archived
       AND g.credential_revoked_at IS NULL
       AND public.gateway_has_broker_credential(g)
     LIMIT 200
  LOOP
    IF public.revoke_gateway_credential(v_row.sparkplug_id) THEN
      UPDATE public.gateways SET credential_revoked_at = now()
       WHERE sparkplug_id = v_row.sparkplug_id;
      v_asked := v_asked + 1;
    END IF;
  END LOOP;

  RETURN v_asked;
END $$;

--

-- FUNCTION sweep_gateway_credential_revocations() :: COMMENT
--

COMMENT ON FUNCTION public.sweep_gateway_credential_revocations() IS 'Retries broker-credential revocation for archived gateways whose trigger call did not land, and clears stamps that pg_net shows were never answered. Run by pg_cron every 15 minutes. Gated on gateway_has_broker_credential() since 0063. Does nothing for DELETED gateways -- their row is gone; scripts/revoke-orphaned-broker-accounts.mjs is the sweep for those.';

--

-- sync_gateway_deployment() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.sync_gateway_deployment() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  v_implied text;
BEGIN
  v_implied := CASE WHEN NEW.is_virtual THEN 'host' ELSE 'remote' END;

  IF TG_OP = 'INSERT' THEN
    -- Unspecified is NULL, because the column has no default. See the note on the ALTER above.
    IF NEW.deployment IS NULL THEN
      NEW.deployment := v_implied;
    ELSE
      NEW.is_virtual := (NEW.deployment = 'host');
    END IF;
    RETURN NEW;
  END IF;

  -- On UPDATE, whichever column moved wins. Both columns are two-valued and the row starts in
  -- agreement, so an update that changes both flips both and agrees again; there is no
  -- disagreement case to refuse. The INSERT arm above needs its rule because `is_virtual` has a
  -- column default.
  IF NEW.deployment IS DISTINCT FROM OLD.deployment THEN
    NEW.is_virtual := (NEW.deployment = 'host');
  ELSIF NEW.is_virtual IS DISTINCT FROM OLD.is_virtual THEN
    NEW.deployment := v_implied;
  END IF;

  RETURN NEW;
END $$;

--

-- FUNCTION sync_gateway_deployment() :: COMMENT
--

COMMENT ON FUNCTION public.sync_gateway_deployment() IS 'Keeps gateways.deployment and gateways.is_virtual in agreement while both exist. Transitional: it goes when is_virtual does. deployment wins when a caller names it; a caller naming both and disagreeing is refused.';

--

-- system_settings_stamp() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.system_settings_stamp() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
    NEW.updated_at := now();
    -- `auth.uid()`, not `current_setting('request.jwt.claim.sub')`: that GUC is the pre-v10
    -- PostgREST convention and the pinned version sets `request.jwt.claims` instead. NULL under
    -- service_role and during migrations, which is correct.
    NEW.updated_by := auth.uid();
    -- The key is part of the closed set, so an UPDATE may not rename one out from under its
    -- reader. Blocked here rather than by a policy because a policy cannot see the OLD row's key
    -- and the NEW one at once in a USING clause that also has to permit ordinary edits.
    IF NEW.key IS DISTINCT FROM OLD.key THEN
        RAISE EXCEPTION
            'system_settings.key is immutable (attempted % -> %). A setting key names the value '
            'some code reads; renaming one here would silently disconnect it from that reader. '
            'Add the new key in a migration alongside its consumer.', OLD.key, NEW.key;
    END IF;
    IF NEW.value_type IS DISTINCT FROM OLD.value_type THEN
        RAISE EXCEPTION
            'system_settings.value_type is immutable for %. The reader was written against one '
            'type; changing it here breaks that reader without touching its code.', OLD.key;
    END IF;
    RETURN NEW;
END;
$$;

--

-- withdraw_gateway_enrollment_tokens() :: FUNCTION
--

CREATE OR REPLACE FUNCTION public.withdraw_gateway_enrollment_tokens() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  -- ON THE TRANSITION, NOT ON THE VALUE. `UPDATE OF is_archived` fires whenever the column appears
  -- in a SET list, including when it is set to the value it already held -- and an archived
  -- gateway is written to by ordinary edits. Without this guard every such write would re-stamp
  -- `consumed_at` on rows that were consumed long ago, rewriting when a token died.
  IF NEW.is_archived AND NOT COALESCE(OLD.is_archived, false) THEN
    UPDATE public.gateway_enrollment_tokens
       SET consumed_at = now()
     WHERE gateway_id = NEW.id
       AND consumed_at IS NULL;
  END IF;
  RETURN NEW;
END $$;

--

-- FUNCTION withdraw_gateway_enrollment_tokens() :: COMMENT
--

COMMENT ON FUNCTION public.withdraw_gateway_enrollment_tokens() IS 'Burns any unredeemed enrolment token when a gateway is archived. SECURITY DEFINER because the operator archiving the gateway has no grant on gateway_enrollment_tokens -- RLS is on with no policy, deliberately, so the table is reachable only by service_role and by definers like this.';

--

-- ashrae223_vocabulary :: TABLE
--

CREATE TABLE IF NOT EXISTS public.ashrae223_vocabulary (
    name text NOT NULL,
    concept_kind text NOT NULL,
    label text NOT NULL,
    description text,
    subclass_of text,
    semantic_id text NOT NULL,
    CONSTRAINT ashrae223_vocabulary_kind_valid CHECK ((concept_kind = ANY (ARRAY['Class'::text, 'AbstractClass'::text, 'Concept'::text, 'Relation'::text, 'EnumerationKind'::text]))),
    CONSTRAINT ashrae223_vocabulary_semantic_id_namespace CHECK ((semantic_id ~~ 'http://data.ashrae.org/standard223#%'::text))
);

--

-- TABLE ashrae223_vocabulary :: COMMENT
--

COMMENT ON TABLE public.ashrae223_vocabulary IS 'ASHRAE 223P semantic concepts, generated from the open223 ontology (Apache-2.0). Reference data, not deployment state -- a row is a concept the standard defines. ⚠ The standard is still in public review; concepts may move before publication.';

--

-- COLUMN ashrae223_vocabulary.subclass_of :: COMMENT
--

COMMENT ON COLUMN public.ashrae223_vocabulary.subclass_of IS 'Immediate s223 superclass, or NULL at the top of the hierarchy. Used to give the vocabulary panel browsable sections.';

--

-- asset_config :: TABLE
--

CREATE TABLE IF NOT EXISTS public.asset_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    asset_id text NOT NULL,
    metric_name text NOT NULL,
    val_double double precision,
    val_string text,
    val_bool boolean,
    datatype integer,
    updated_at timestamp with time zone DEFAULT now()
);

--

-- capture_jobs :: TABLE
--

CREATE TABLE IF NOT EXISTS public.capture_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subject_kind text NOT NULL,
    gateway_id uuid,
    device_id uuid,
    sparkplug_group text NOT NULL,
    edge_node_id text NOT NULL,
    device_sparkplug_id text,
    subject_sparkplug_id text NOT NULL,
    storage_path text NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    note text,
    max_seconds integer DEFAULT 7200 NOT NULL,
    max_messages integer DEFAULT 100000 NOT NULL,
    max_bytes bigint DEFAULT 52428800 NOT NULL,
    messages bigint DEFAULT 0 NOT NULL,
    bytes bigint DEFAULT 0 NOT NULL,
    elapsed_seconds integer DEFAULT 0 NOT NULL,
    birth_captured boolean DEFAULT false NOT NULL,
    stop_requested boolean DEFAULT false NOT NULL,
    capture_id uuid,
    error text,
    requested_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    CONSTRAINT capture_jobs_caps_are_bounded CHECK (
        max_seconds  BETWEEN 5 AND 7200
    AND max_messages BETWEEN 1 AND 100000
    AND max_bytes    BETWEEN 1024 AND 52428800
    ),
    CONSTRAINT capture_jobs_status_valid CHECK ((status = ANY (ARRAY['PENDING'::text, 'RECORDING'::text, 'COMPLETED'::text, 'FAILED'::text, 'CANCELLED'::text]))),
    CONSTRAINT capture_jobs_subject_is_coherent CHECK ((((subject_kind = 'gateway'::text) AND (gateway_id IS NOT NULL) AND (device_sparkplug_id IS NULL)) OR ((subject_kind = 'device'::text) AND (device_id IS NOT NULL) AND (device_sparkplug_id IS NOT NULL)))),
    CONSTRAINT capture_jobs_subject_kind_valid CHECK ((subject_kind = ANY (ARRAY['gateway'::text, 'device'::text])))
);

ALTER TABLE ONLY public.capture_jobs REPLICA IDENTITY FULL;

--

-- TABLE capture_jobs :: COMMENT
--

COMMENT ON TABLE public.capture_jobs IS 'One row per recording ATTEMPTED, including the ones that failed. At most one row is PENDING or RECORDING at a time across the whole stack (capture_jobs_single_flight). Written only through the gates in 0055 -- there is no direct-write RLS policy -- and pushed to the Capture page by Realtime as the daemon updates its progress columns.';

--

-- COLUMN capture_jobs.stop_requested :: COMMENT
--

COMMENT ON COLUMN public.capture_jobs.stop_requested IS 'Set by request_capture_stop(); observed by the daemon on its next message, which then flushes and completes. A column rather than an endpoint because the daemon hosts no REST tier, and because a flag survives a page reload.';

--

-- captures :: TABLE
--

CREATE TABLE IF NOT EXISTS public.captures (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    subject_kind text NOT NULL,
    gateway_id uuid,
    device_id uuid,
    subject_sparkplug_id text NOT NULL,
    storage_path text NOT NULL,
    size_bytes bigint NOT NULL,
    message_count integer NOT NULL,
    note text,
    manifest jsonb DEFAULT '{}'::jsonb NOT NULL,
    source text DEFAULT 'recorded'::text NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT captures_message_count_check CHECK ((message_count >= 0)),
    CONSTRAINT captures_size_bytes_check CHECK ((size_bytes >= 0)),
    CONSTRAINT captures_source_valid CHECK ((source = ANY (ARRAY['recorded'::text, 'uploaded'::text]))),
    CONSTRAINT captures_subject_is_coherent CHECK ((((subject_kind = 'gateway'::text) AND (gateway_id IS NOT NULL) AND (device_id IS NULL)) OR ((subject_kind = 'device'::text) AND (device_id IS NOT NULL)))),
    CONSTRAINT captures_subject_kind_valid CHECK ((subject_kind = ANY (ARRAY['gateway'::text, 'device'::text])))
);

--

-- TABLE captures :: COMMENT
--

COMMENT ON TABLE public.captures IS 'The capture that EXISTS for a subject -- at most one per gateway and one per device, enforced by two partial unique indexes. Written by ingest_finalise_capture() for a recorded capture and by register_uploaded_capture() for one uploaded through the browser; both paths land here so that playback has a single way to name a capture. Distinct from capture_jobs, which records the ACT of recording and has no row at all for an uploaded file. See 0055''s header.';

--

-- COLUMN captures.manifest :: COMMENT
--

COMMENT ON COLUMN public.captures.manifest IS 'What is in the file, so the list can describe a capture nobody has downloaded: metric_names (capped at 50, with metric_name_count beside it), topic_count, observed_rate_hz, birth_captured, and the edge_node_ids / device_ids the recording publishes under. birth_captured=false means the recording contains no NBIRTH/DBIRTH, so an alias-optimised gateway will replay as unresolved_alias and drop every metric -- from a file that otherwise looks complete. Note it means the NODE''s birth: announcing a DEVICE takes a DBIRTH, and only that sets a device ONLINE. device_ids is what the playback dialog builds its device map from, which is why it is here rather than read out of a file that may be 100 MiB.';

--

-- cells :: TABLE
--

CREATE TABLE IF NOT EXISTS public.cells (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    grafana_url text,
    created_at timestamp with time zone DEFAULT now(),
    is_archived boolean DEFAULT false,
    archived_at timestamp with time zone,
    auto_delete_at timestamp with time zone,
    icon text DEFAULT 'Factory'::text NOT NULL,
    CONSTRAINT cells_icon_valid CHECK ((icon = ANY (ARRAY['Factory'::text, 'Bot'::text, 'Cog'::text, 'CircuitBoard'::text, 'Gauge'::text, 'Building2'::text, 'Truck'::text, 'Zap'::text])))
);

ALTER TABLE ONLY public.cells REPLICA IDENTITY FULL;

--

-- COLUMN cells.icon :: COMMENT
--

COMMENT ON COLUMN public.cells.icon IS 'Icon key for this cell, rendered by the dashboard from a bundled SVG set. A closed set (see cells_icon_valid) rather than free text: the column is a lookup key, never markup or a URL.';

--

-- devices :: TABLE
--

CREATE TABLE IF NOT EXISTS public.devices (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    gateway_id uuid,
    status text DEFAULT 'OFFLINE'::text,
    is_quarantined boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    is_archived boolean DEFAULT false,
    archived_at timestamp with time zone,
    auto_delete_at timestamp with time zone,
    asset_type text,
    connection_method text,
    first_dbirth_at timestamp with time zone,
    schema_id uuid,
    sparkplug_id text GENERATED ALWAYS AS (('dev'::text || substr(encode(uuid_send(id), 'hex'::text), 1, 21))) STORED,
    reported_identity text,
    quarantine_reason text,
    identity_source text,
    last_birth_metrics text[],
    last_birth_metrics_at timestamp with time zone,
    model_3d_path text,
    cell_id uuid,
    location_scope text DEFAULT 'cell'::text NOT NULL,
    description text,
    conformance_policy text DEFAULT 'audit'::text NOT NULL,
    shadow_of uuid,
    CONSTRAINT devices_conformance_policy_valid CHECK ((conformance_policy = ANY (ARRAY['audit'::text, 'enforce'::text]))),
    CONSTRAINT devices_location_scope_valid CHECK ((location_scope = ANY (ARRAY['cell'::text, 'site_wide'::text]))),
    CONSTRAINT devices_model_3d_path_shape CHECK (((model_3d_path IS NULL) OR (model_3d_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]+\.(gltf|glb|obj|stl)$'::text))),
    CONSTRAINT devices_shadow_of_is_not_self CHECK (((shadow_of IS NULL) OR (shadow_of <> id))),
    CONSTRAINT devices_site_wide_has_no_cell CHECK (((location_scope <> 'site_wide'::text) OR (cell_id IS NULL)))
);

ALTER TABLE ONLY public.devices REPLICA IDENTITY FULL;

--

-- COLUMN devices.sparkplug_id :: COMMENT
--

COMMENT ON COLUMN public.devices.sparkplug_id IS 'Immutable Sparkplug B device id, derived from the primary key. This is what appears in the MQTT topic and keys telemetry in TimescaleDB and birth parameters in asset_config.';

--

-- COLUMN devices.reported_identity :: COMMENT
--

COMMENT ON COLUMN public.devices.reported_identity IS 'The Sparkplug B device id this device actually published under, when it differs from the platform-issued sparkplug_id. NULL means the device uses its issued id.';

--

-- COLUMN devices.quarantine_reason :: COMMENT
--

COMMENT ON COLUMN public.devices.quarantine_reason IS 'Why this device is in the quarantine queue, as "<CODE>" or "<CODE>: <detail>": UNKNOWN_DEVICE (well-formed id, never seen), MALFORMED_IDENTITY (id failed the 24-char gwy/dev format check), IDENTITY_MISMATCH (topic device id and Asset_ID payload metric disagreed), or GATEWAY_MISMATCH (announced by an edge node it is not bound to, or one that is unregistered or archived). Enforced by is_valid_quarantine_reason() (0047), not by a CHECK -- the detail suffix is free text and only the code is pinned.';

--

-- COLUMN devices.identity_source :: COMMENT
--

COMMENT ON COLUMN public.devices.identity_source IS 'How ingestion last resolved this device: ''sparkplug_id'' (current scheme) or ''legacy_name'' (matched by name during the migration window). Drives the deprecation badge in the UI.';

--

-- COLUMN devices.model_3d_path :: COMMENT
--

COMMENT ON COLUMN public.devices.model_3d_path IS 'Object key of this device''s 3D model within the asset-3d-models bucket (<device_uuid>/<filename>). Never a URL -- the public URL is composed at export time from a configurable base.';

--

-- COLUMN devices.cell_id :: COMMENT
--

COMMENT ON COLUMN public.devices.cell_id IS 'Explicit location override. NULL means inherit from gateways.cell_id -- deliberately no default, since an explicit value wins over inheritance and a default would make inheritance unreachable. Resolve through public.device_locations, never by reading this column alone.';

--

-- COLUMN devices.location_scope :: COMMENT
--

COMMENT ON COLUMN public.devices.location_scope IS '''cell'' (located in, or awaiting, a cell) or ''site_wide'' (asserted to have no single cell -- BMS, AGV, ambient sensor). Distinct from cell_id IS NULL, which means undecided.';

--

-- COLUMN devices.description :: COMMENT
--

COMMENT ON COLUMN public.devices.description IS 'Optional operator note. Free text, carries no semantics, and is read by nothing -- typed identification belongs in device_nameplate.';

--

-- COLUMN devices.conformance_policy :: COMMENT
--

COMMENT ON COLUMN public.devices.conformance_policy IS '''audit'' (default) evaluates every DDATA metric against the device''s attached schemas and records what fails, writing the sample regardless -- the behaviour since 0026. ''enforce'' additionally DROPS a metric whose value contradicts a constraint its bound schema states. Per device and not per daemon: enforcement is a judgement about one asset''s schema being trustworthy enough to reject against, and a fleet is not uniform. An unmodelled metric is dropped only when a schema closes the set with additionalProperties: false.';

--

-- COLUMN devices.shadow_of :: COMMENT
--

COMMENT ON COLUMN public.devices.shadow_of IS 'For a shadow device: the real machine whose recordings this lane replays. NULL for every ordinary device. This is PROVENANCE, not a copy of a gateway flag -- whether a device is synthetic still derives from gateways.is_shadow / is_simulated (see 0052 and 0059), and this stores the one thing the gateway cannot know. Set only by ensure_shadow_devices().';

--

-- device_locations :: VIEW
--

-- Dropped first: 0097 recreates this view with two more columns, and CREATE OR REPLACE cannot
-- take them away again on the next replay. The grants below are re-applied there too.
DROP VIEW IF EXISTS public.device_locations;
CREATE OR REPLACE VIEW public.device_locations WITH (security_invoker='true') AS
 SELECT d.id AS device_id,
    d.gateway_id,
    d.cell_id AS explicit_cell_id,
    g.cell_id AS gateway_cell_id,
    d.location_scope,
        CASE
            WHEN COALESCE(g.is_shadow, false) THEN NULL::uuid
            WHEN COALESCE(g.is_simulated, false) THEN NULL::uuid
            WHEN (d.location_scope = 'site_wide'::text) THEN NULL::uuid
            ELSE COALESCE(d.cell_id, g.cell_id)
        END AS effective_cell_id,
        CASE
            WHEN COALESCE(g.is_shadow, false) THEN 'shadow'::text
            WHEN COALESCE(g.is_simulated, false) THEN 'simulated'::text
            WHEN (d.location_scope = 'site_wide'::text) THEN 'site_wide'::text
            WHEN (d.cell_id IS NOT NULL) THEN 'explicit'::text
            WHEN (g.cell_id IS NOT NULL) THEN 'inherited'::text
            ELSE 'unassigned'::text
        END AS location_source,
    ((d.location_scope = 'cell'::text) AND (d.cell_id IS NOT NULL) AND (g.cell_id IS NOT NULL) AND (d.cell_id <> g.cell_id)) AS cell_mismatch
   FROM (public.devices d
     LEFT JOIN public.gateways g ON ((g.id = d.gateway_id)));

--

-- VIEW device_locations :: COMMENT
--

COMMENT ON VIEW public.device_locations IS 'Effective cell per device, and which arm answered. Precedence: shadow (a replay lane behind a playback gateway) and simulated (synthetic telemetry) resolve to NO cell and take priority over everything else; then site-wide assets, which have none by assertion; then explicit devices.cell_id, then inherited gateways.cell_id, else unassigned. The first two are the gateway''s flags and are inherited -- devices store no copy. Mirrors frontend/src/utils/cellResolution.js -- keep the two in step. Derived at read time and never stored, so flipping a gateway''s flag or cell reclassifies its devices immediately.';

--

-- device_nameplate :: TABLE
--

CREATE TABLE IF NOT EXISTS public.device_nameplate (
    device_id uuid NOT NULL,
    manufacturer_name text,
    manufacturer_product_designation text,
    manufacturer_product_type text,
    serial_number text,
    year_of_construction text,
    date_of_manufacture date,
    hardware_version text,
    firmware_version text,
    software_version text,
    country_of_origin text,
    uri_of_the_product text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT device_nameplate_uri_shape CHECK (((uri_of_the_product IS NULL) OR (uri_of_the_product ~* '^[a-z][a-z0-9+.-]*:'::text))),
    CONSTRAINT device_nameplate_year_shape CHECK (((year_of_construction IS NULL) OR (year_of_construction ~ '^[0-9]{4}$'::text)))
);

--

-- TABLE device_nameplate :: COMMENT
--

COMMENT ON TABLE public.device_nameplate IS 'Operator-supplied IDTA 02006 Digital Nameplate data, one row per device. The FALLBACK source: where a device publishes its own identification as birth metrics (OPC 40001 Machinery Manufacturer, SerialNumber, YearOfConstruction), the exporter prefers what the device said. Deliberately not in asset_config, which ingestion overwrites from every DBIRTH.';

--

-- COLUMN device_nameplate.updated_by :: COMMENT
--

COMMENT ON COLUMN public.device_nameplate.updated_by IS 'Who last edited this nameplate. A nameplate is an assertion about an asset, so who made it is part of the record -- the same reason digital_thread exists.';

--

-- device_submodels :: TABLE
--

CREATE TABLE IF NOT EXISTS public.device_submodels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    schema_id uuid NOT NULL,
    submodel_key text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT device_submodels_key_is_id_short CHECK (((submodel_key IS NULL) OR (submodel_key ~ '^[A-Za-z_][A-Za-z0-9_]*$'::text)))
);

--

-- TABLE device_submodels :: COMMENT
--

COMMENT ON TABLE public.device_submodels IS 'Schemas attached to a device, one AAS Submodel each. Supersedes the 1:1 devices.schema_id, which is retained as a fallback for devices with no rows here.';

--

-- device_schemas :: VIEW
--

CREATE OR REPLACE VIEW public.device_schemas WITH (security_invoker='true') AS
 SELECT ds.device_id,
    ds.schema_id,
    ds.submodel_key,
    'device_submodels'::text AS source
   FROM public.device_submodels ds
UNION
 SELECT d.id AS device_id,
    d.schema_id,
    NULL::text AS submodel_key,
    'devices.schema_id'::text AS source
   FROM public.devices d
  WHERE ((d.schema_id IS NOT NULL) AND (NOT (EXISTS ( SELECT 1
           FROM public.device_submodels ds
          WHERE (ds.device_id = d.id)))));

--

-- VIEW device_schemas :: COMMENT
--

COMMENT ON VIEW public.device_schemas IS 'Every schema attached to a device: device_submodels rows, plus the legacy devices.schema_id for devices that have none.';

--

-- digital_thread :: TABLE
--

CREATE TABLE IF NOT EXISTS public.digital_thread (
    id bigint NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    action text NOT NULL,
    old_data jsonb,
    new_data jsonb,
    changed_by uuid,
    recorded_at timestamp with time zone DEFAULT now(),
    actor_source text,
    causation_id bigint,
    audit_domain text NOT NULL,
    CONSTRAINT digital_thread_actor_source_check CHECK (((actor_source IS NULL) OR (actor_source = ANY (ARRAY['user'::text, 'ingestion'::text, 'migration'::text, 'service'::text])))),
    CONSTRAINT digital_thread_audit_domain_check CHECK ((audit_domain = ANY (ARRAY['asset'::text, 'security'::text])))
);

--

-- COLUMN digital_thread.actor_source :: COMMENT
--

COMMENT ON COLUMN public.digital_thread.actor_source IS 'What kind of actor made the change: user | ingestion | migration | service. Complements changed_by, which names WHICH user and is NULL for every machine-originated write.';

--

-- COLUMN digital_thread.causation_id :: COMMENT
--

COMMENT ON COLUMN public.digital_thread.causation_id IS 'The transaction that wrote this row (txid_current()). Rows sharing it were written by ONE act -- an operator approval that also rebound a schema, a delete that cascaded. NOT a global identifier: it is unique only within this database, and only until the epoch counter is reset by a restore from a dump. Group by it; never store it as a foreign reference.';

--

-- COLUMN digital_thread.audit_domain :: COMMENT
--

COMMENT ON COLUMN public.digital_thread.audit_domain IS 'asset | security. Stamped by trg_digital_thread_stamp_domain from audit_domain_for(); callers do not supply it and cannot override it. Decides which SELECT policy admits the row.';

--

-- digital_thread_id_seq :: SEQUENCE
--

CREATE SEQUENCE IF NOT EXISTS public.digital_thread_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--

-- digital_thread_id_seq :: SEQUENCE OWNED BY
--

ALTER SEQUENCE public.digital_thread_id_seq OWNED BY public.digital_thread.id;

--

-- directory_liveness_probe :: TABLE
--

CREATE TABLE IF NOT EXISTS public.directory_liveness_probe (
    id boolean DEFAULT true NOT NULL,
    request_id bigint,
    requested_at timestamp with time zone,
    CONSTRAINT directory_liveness_probe_id_check CHECK (id)
);

--

-- TABLE directory_liveness_probe :: COMMENT
--

COMMENT ON TABLE public.directory_liveness_probe IS 'The single in-flight pg_net request id for the Prometheus liveness probe. One row by CHECK (id), because two concurrent probes would race to write the same directory rows from different observations.';

--

-- directory_services :: TABLE
--

CREATE TABLE IF NOT EXISTS public.directory_services (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    service_name text NOT NULL,
    service_type text NOT NULL,
    endpoint_url text NOT NULL,
    status text DEFAULT 'UNKNOWN'::text NOT NULL,
    last_heartbeat timestamp with time zone DEFAULT now(),
    registered_schema_id uuid,
    CONSTRAINT directory_services_status_valid CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'DOWN'::text, 'UNKNOWN'::text])))
);

--

-- COLUMN directory_services.status :: COMMENT
--

COMMENT ON COLUMN public.directory_services.status IS 'Observed liveness: ACTIVE (Prometheus reports up=1), DOWN (up=0), or UNKNOWN (nothing observes this service). Written only by refresh_directory_liveness(). UNKNOWN is not a failure -- nine of the fifteen registered services have no exporter, and saying so is the point.';

--

-- COLUMN directory_services.last_heartbeat :: COMMENT
--

COMMENT ON COLUMN public.directory_services.last_heartbeat IS 'When this service was last OBSERVED up. NULL whenever status is not ACTIVE, including UNKNOWN: a timestamp on a row nothing probes would imply a freshness it does not have, which is the defect this column had before 0054 -- it held the moment the row was seeded.';

--

-- gateway_enrollment_tokens :: TABLE
--

CREATE TABLE IF NOT EXISTS public.gateway_enrollment_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    gateway_id uuid NOT NULL,
    token_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    CONSTRAINT gateway_enrollment_tokens_expiry_after_creation CHECK ((expires_at > created_at)),
    CONSTRAINT gateway_enrollment_tokens_hash_is_sha256 CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))
);

--

-- TABLE gateway_enrollment_tokens :: COMMENT
--

COMMENT ON TABLE public.gateway_enrollment_tokens IS 'Single-use, short-lived claims that let a physical gateway appliance exchange its downloaded bundle for a broker credential exactly once. NOT READABLE BY ANY BROWSER-FACING ROLE -- RLS is enabled with no policy for anon or authenticated, so only service_role (which bypasses RLS) can see it, and only the enroll-gateway edge function holds that key. Deliberately a separate table rather than columns on public.gateways: that table is world-readable to authenticated users, its full row is copied into digital_thread on every write, and public.gateway_status selects g.*.';

--

-- gateway_health :: VIEW
--

CREATE OR REPLACE VIEW public.gateway_health AS
 SELECT now() AS collected_at,
    sparkplug_id,
    gateway_name,
    live_status,
    is_stale,
    is_virtual,
    heartbeat_age_seconds,
    health_reported_at,
    health_age_seconds,
    uptime_seconds,
    load_1m,
    mem_available_bytes,
    disk_free_bytes,
    cert_expires_at,
    cert_expires_in_days,
    agent_version,
    flow_hash
   FROM public.gateway_health_rows() r(sparkplug_id, gateway_name, live_status, is_stale, is_virtual, heartbeat_age_seconds, health_reported_at, health_age_seconds, uptime_seconds, load_1m, mem_available_bytes, disk_free_bytes, cert_expires_at, cert_expires_in_days, agent_version, flow_hash);

--

-- VIEW gateway_health :: COMMENT
--

COMMENT ON VIEW public.gateway_health IS 'The fleet''s current condition, one row per non-archived gateway. Read by the `supabase` datasource: backs the gateway variable and the panels in the "Gateway Fleet Health" dashboard, and the certificate-expiry alert rule. Current values only -- the trends are Prometheus gauges exported by the ingestion daemon.';

--

-- gateway_status :: VIEW
--

-- THE VIEW IS BUILT BY ITS FUNCTION, NOT BY THE DUMPED STATEMENT THAT USED TO STAND HERE. pg_dump
-- writes a view's column list out explicitly, and CREATE OR REPLACE VIEW cannot narrow a view: once
-- a later migration adds a gateways column and rebuilds this view through
-- ensure_gateway_status_view() (g.* now five columns wider), the explicit list here has FEWER
-- columns than the live view and every subsequent boot fails in this file with
-- "cannot drop columns from view". Found by 0095, the first migration since the squash to add a
-- gateways column. The function drops and recreates, which is the only shape that survives both a
-- fresh database and a replay.
SELECT public.ensure_gateway_status_view();

--

-- VIEW gateway_status :: COMMENT
--

COMMENT ON VIEW public.gateway_status IS 'public.gateways with heartbeat staleness derived at read time. Mirrors frontend/src/utils/gatewayStatus.js -- keep the 90s threshold AND the pending-state short-circuit in step. Deliberately a view, not a stored column or a pg_cron writer: writing status would append to the immutable digital_thread audit table on every sweep and would be stale between ticks. Rebuilt by public.ensure_gateway_status_view() -- call it after adding a gateways column.';

--

-- idta_submodel_templates :: TABLE
--

CREATE TABLE IF NOT EXISTS public.idta_submodel_templates (
    template_id text NOT NULL,
    template_name text NOT NULL,
    template_version text NOT NULL,
    id_short text NOT NULL,
    semantic_id text NOT NULL,
    semantic_id_type text NOT NULL,
    description text,
    is_mandatory boolean DEFAULT false NOT NULL,
    ordinal integer NOT NULL,
    CONSTRAINT idta_submodel_templates_id_short_shape CHECK ((id_short ~ '^[A-Za-z][A-Za-z0-9_]*$'::text)),
    CONSTRAINT idta_submodel_templates_semantic_id_type_valid CHECK ((semantic_id_type = ANY (ARRAY['IRI'::text, 'IRDI'::text])))
);

--

-- TABLE idta_submodel_templates :: COMMENT
--

COMMENT ON TABLE public.idta_submodel_templates IS 'IDTA Asset Administration Shell submodel-template elements. Reference data, not deployment state -- a row here is an element the template defines, not a value a device holds. semantic_id is issued by IDTA/IEC CDD/ECLASS and must never be minted locally.';

--

-- COLUMN idta_submodel_templates.is_mandatory :: COMMENT
--

COMMENT ON COLUMN public.idta_submodel_templates.is_mandatory IS 'Whether the template marks this element as mandatory. Recorded so the exporter can report what a shell would need to claim conformance -- it does NOT claim it; see the exporter.';

--

-- COLUMN idta_submodel_templates.ordinal :: COMMENT
--

COMMENT ON COLUMN public.idta_submodel_templates.ordinal IS 'Order the element appears in the published template, so the exported submodel reads like the specification rather than like a hash map.';

--

-- iso22400_vocabulary :: TABLE
--

CREATE TABLE IF NOT EXISTS public.iso22400_vocabulary (
    name text NOT NULL,
    kpi_id text NOT NULL,
    description text,
    category text,
    unit text,
    formula text,
    semantic_id text
);

--

-- TABLE iso22400_vocabulary :: COMMENT
--

COMMENT ON TABLE public.iso22400_vocabulary IS 'ISO 22400-2 key performance indicator definitions. Reference data, not deployment state -- a row here is a KPI the standard defines, not a metric a device publishes.';

--

-- links :: TABLE
--

CREATE TABLE IF NOT EXISTS public.links (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    display_name text NOT NULL,
    url text NOT NULL,
    link_tag text DEFAULT 'other'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

--

-- metric_catalog :: TABLE
--

CREATE TABLE IF NOT EXISTS public.metric_catalog (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    datatype integer NOT NULL,
    description text,
    deprecated boolean DEFAULT false NOT NULL,
    superseded_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    metric_group text GENERATED ALWAYS AS (
CASE
    WHEN (strpos(name, '/'::text) > 0) THEN NULLIF(split_part(name, '/'::text, 1), ''::text)
    ELSE NULL::text
END) STORED,
    category text,
    units text,
    sub_type text,
    standard text,
    semantic_id text,
    semantic_id_type text,
    permitted_values text[],
    CONSTRAINT metric_catalog_category_valid CHECK (((category IS NULL) OR (category = ANY (ARRAY['SAMPLE'::text, 'EVENT'::text, 'CONDITION'::text])))),
    CONSTRAINT metric_catalog_name_format CHECK ((name ~ '^[A-Za-z0-9_]+(/[A-Za-z0-9_]+)*$'::text)),
    CONSTRAINT metric_catalog_permitted_values_shape CHECK (((permitted_values IS NULL) OR ((cardinality(permitted_values) > 0) AND (array_position(permitted_values, NULL::text) IS NULL) AND (''::text <> ALL (permitted_values))))),
    CONSTRAINT metric_catalog_semantic_id_type_valid CHECK (((semantic_id_type IS NULL) OR (semantic_id_type = ANY (ARRAY['IRI'::text, 'IRDI'::text, 'ModelReference'::text]))))
);

--

-- COLUMN metric_catalog.semantic_id :: COMMENT
--

COMMENT ON COLUMN public.metric_catalog.semantic_id IS 'AAS (IEC 63278) semanticId for this metric -- the globally-resolvable identity of the concept it measures. NULL means unmapped, which is a legitimate state for a local extension.';

--

-- COLUMN metric_catalog.semantic_id_type :: COMMENT
--

COMMENT ON COLUMN public.metric_catalog.semantic_id_type IS 'Which kind of AAS Reference semantic_id is: IRI, IRDI, or ModelReference.';

--

-- COLUMN metric_catalog.permitted_values :: COMMENT
--

COMMENT ON COLUMN public.metric_catalog.permitted_values IS 'The values a discrete metric is allowed to report, from its standard vocabulary. NULL means unconstrained -- most metrics are, and a continuous SAMPLE always is. Deliberately NOT frozen by enforce_metric_catalog_immutability: it is a transcribed assertion about a standard, not a wire contract a device is configured against. See this migration''s header.';

--

-- metric_groups :: TABLE
--

CREATE TABLE IF NOT EXISTS public.metric_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now(),
    standard text,
    CONSTRAINT metric_groups_name_is_one_segment CHECK (((name <> ''::text) AND (strpos(name, '/'::text) = 0)))
);

--

-- mtconnect_vocabulary :: TABLE
--

CREATE TABLE IF NOT EXISTS public.mtconnect_vocabulary (
    kind text NOT NULL,
    name text NOT NULL,
    category text,
    semantic_id text
);

--

-- TABLE mtconnect_vocabulary :: COMMENT
--

COMMENT ON TABLE public.mtconnect_vocabulary IS 'MTConnect controlled vocabularies, generated from the Apache-2.0 mtconnect/schema repository. Reference data, not deployment state.';

--

-- COLUMN mtconnect_vocabulary.semantic_id :: COMMENT
--

COMMENT ON COLUMN public.mtconnect_vocabulary.semantic_id IS 'Local-namespace IRI for this vocabulary concept. Minted by this deployment, not issued by MTConnect -- see archived migration 0032.';

--

-- one_shot_migrations :: TABLE
--

CREATE TABLE IF NOT EXISTS public.one_shot_migrations (
    key text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    note text
);

--

-- TABLE one_shot_migrations :: COMMENT
--

COMMENT ON TABLE public.one_shot_migrations IS 'Ledger for migrations that must run exactly once, rather than on every boot like the rest of the chain. Claimed by INSERT ... ON CONFLICT DO NOTHING inside the same transaction as the work it guards. Written only by the migration owner (postgres): service_role holds SELECT and no write since 0053, because deleting a claim re-arms a destructive one-shot and the next boot reports success exactly as the first did.';

--

-- opcua_vocabulary :: TABLE
--

CREATE TABLE IF NOT EXISTS public.opcua_vocabulary (
    name text NOT NULL,
    companion_spec text NOT NULL,
    node_id text,
    description text,
    datatype text,
    unit text,
    semantic_id text
);

--

-- TABLE opcua_vocabulary :: COMMENT
--

COMMENT ON TABLE public.opcua_vocabulary IS 'OPC UA companion specification data points (OPC 40001 Machinery, OPC 40010 Robotics). Reference data, not deployment state. node_id holds a browse path, not a resolvable numeric NodeId -- see the migration header.';

--

-- permissions :: TABLE
--

CREATE TABLE IF NOT EXISTS public.permissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text
);

--

-- platform_alerts :: TABLE
--

CREATE TABLE IF NOT EXISTS public.platform_alerts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    fingerprint text NOT NULL,
    entity_type text DEFAULT 'device'::text NOT NULL,
    entity_id uuid,
    sparkplug_id text,
    alert_name text NOT NULL,
    severity text DEFAULT 'warning'::text NOT NULL,
    status text NOT NULL,
    summary text,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT platform_alerts_asset_has_wire_id CHECK (((entity_type = 'platform'::text) OR (sparkplug_id IS NOT NULL))),
    CONSTRAINT platform_alerts_entity_type_valid CHECK ((entity_type = ANY (ARRAY['device'::text, 'gateway'::text, 'platform'::text]))),
    CONSTRAINT platform_alerts_resolved_has_end CHECK (((status <> 'resolved'::text) OR (ends_at IS NOT NULL))),
    CONSTRAINT platform_alerts_severity_valid CHECK ((severity = ANY (ARRAY['critical'::text, 'warning'::text, 'info'::text]))),
    CONSTRAINT platform_alerts_status_valid CHECK ((status = ANY (ARRAY['firing'::text, 'resolved'::text])))
);

ALTER TABLE ONLY public.platform_alerts REPLICA IDENTITY FULL;

--

-- TABLE platform_alerts :: COMMENT
--

COMMENT ON TABLE public.platform_alerts IS 'One row per Grafana alert OCCURRENCE -- machine conditions and platform conditions alike -- delivered by the grafana-alert-webhook edge function. Append-only on (fingerprint, starts_at); an occurrence transitions firing -> resolved in place.';

--

-- COLUMN platform_alerts.entity_type :: COMMENT
--

COMMENT ON COLUMN public.platform_alerts.entity_type IS 'What the alert is about: device | gateway | platform. The dashboard reddens an asset only for its own kind, so this is read before entity_id anywhere a colour or a link is derived.';

--

-- COLUMN platform_alerts.entity_id :: COMMENT
--

COMMENT ON COLUMN public.platform_alerts.entity_id IS 'The subject row id, or NULL for a platform-scoped alert or an id that matched nothing. Carries no foreign key on purpose -- see the column definition.';

--

-- COLUMN platform_alerts.sparkplug_id :: COMMENT
--

COMMENT ON COLUMN public.platform_alerts.sparkplug_id IS 'The immutable Sparkplug id of the asset the alert was raised for, taken from the Grafana label. Never a display name. NULL only for entity_type = platform, which has no single subject.';

--

-- platform_alerts_active :: VIEW
--

CREATE OR REPLACE VIEW public.platform_alerts_active WITH (security_invoker='true') AS
 SELECT id,
    fingerprint,
    entity_type,
    entity_id,
    sparkplug_id,
    alert_name,
    severity,
    status,
    summary,
    starts_at,
    ends_at,
    recorded_at
   FROM ( SELECT DISTINCT ON (a.fingerprint) a.id,
            a.fingerprint,
            a.entity_type,
            a.entity_id,
            a.sparkplug_id,
            a.alert_name,
            a.severity,
            a.status,
            a.summary,
            a.starts_at,
            a.ends_at,
            a.recorded_at
           FROM public.platform_alerts a
          ORDER BY a.fingerprint, a.starts_at DESC, a.recorded_at DESC) newest
  WHERE (status = 'firing'::text);

--

-- VIEW platform_alerts_active :: COMMENT
--

COMMENT ON VIEW public.platform_alerts_active IS 'Currently firing alerts, one row per Grafana fingerprint (the newest occurrence). A later resolved occurrence supersedes an earlier firing one, so a missed resolve cannot pin a stale alert.';

--

-- platform_health :: VIEW
--

CREATE OR REPLACE VIEW public.platform_health AS
 SELECT now() AS collected_at,
    condition,
    sparkplug_id,
    subject,
    value,
    detail
   FROM public.platform_health_rows() r(condition, sparkplug_id, subject, value, detail);

--

-- VIEW platform_health :: COMMENT
--

COMMENT ON VIEW public.platform_health IS 'The platform''s own condition, long-form so a Grafana rule over one `condition` value produces one alert instance per subject. Read by the `supabase` datasource; see grafana/provisioning/alerting/alert-rules.yaml.';

--

-- playback_jobs :: TABLE
--

CREATE TABLE IF NOT EXISTS public.playback_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    capture_id uuid,
    capture_storage_path text NOT NULL,
    target_gateway_id uuid NOT NULL,
    target_edge_node_id text NOT NULL,
    sparkplug_group text NOT NULL,
    device_map jsonb DEFAULT '{}'::jsonb NOT NULL,
    speed numeric DEFAULT 1.0 NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    messages_total integer DEFAULT 0 NOT NULL,
    messages_sent integer DEFAULT 0 NOT NULL,
    elapsed_seconds integer DEFAULT 0 NOT NULL,
    stop_requested boolean DEFAULT false NOT NULL,
    error text,
    requested_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    CONSTRAINT playback_jobs_device_map_is_object CHECK ((jsonb_typeof(device_map) = 'object'::text)),
    CONSTRAINT playback_jobs_speed_is_sane CHECK (((speed > (0)::numeric) AND (speed <= (60)::numeric))),
    CONSTRAINT playback_jobs_status_valid CHECK ((status = ANY (ARRAY['PENDING'::text, 'RUNNING'::text, 'COMPLETED'::text, 'FAILED'::text, 'CANCELLED'::text])))
);

ALTER TABLE ONLY public.playback_jobs REPLICA IDENTITY FULL;

--

-- TABLE playback_jobs :: COMMENT
--

COMMENT ON TABLE public.playback_jobs IS 'One row per playback attempted. At most one is PENDING or RUNNING per TARGET GATEWAY -- two publishers on one edge node interleave sequence numbers. Written only through the gates in 0056; there is no direct-write policy. Progress is pushed to the page by Realtime.';

--

-- playback_worker_status :: TABLE
--

CREATE TABLE IF NOT EXISTS public.playback_worker_status (
    id boolean DEFAULT true NOT NULL,
    held_edge_nodes text[] DEFAULT '{}'::text[] NOT NULL,
    reported_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT playback_worker_status_id_check CHECK (id)
);

--

-- TABLE playback_worker_status :: COMMENT
--

COMMENT ON TABLE public.playback_worker_status IS 'What the playback worker can actually publish as: the gateway sparkplug_ids it holds broker passwords for, and when it last said so. One row by CHECK (id). Written only by playback_report_credentials(), read by the playback dialog so a target the worker cannot authenticate as is refused before a job is queued rather than after. Holds no secret -- a sparkplug_id is a public identifier and the passwords are deliberately not here.';

--

-- COLUMN playback_worker_status.reported_at :: COMMENT
--

COMMENT ON COLUMN public.playback_worker_status.reported_at IS 'Heartbeat. An empty held_edge_nodes with a RECENT timestamp means the worker is running and holds no credentials; a stale timestamp means the worker is not running. Those are different problems and the page says which.';

--

-- rebirth_requests :: TABLE
--

CREATE TABLE IF NOT EXISTS public.rebirth_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    gateway_id uuid NOT NULL,
    edge_node_id text NOT NULL,
    sparkplug_group text NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    throttled boolean DEFAULT false NOT NULL,
    error text,
    requested_by uuid,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    CONSTRAINT rebirth_requests_status_valid CHECK ((status = ANY (ARRAY['PENDING'::text, 'SENT'::text, 'FAILED'::text])))
);

ALTER TABLE ONLY public.rebirth_requests REPLICA IDENTITY FULL;

--

-- TABLE rebirth_requests :: COMMENT
--

COMMENT ON TABLE public.rebirth_requests IS 'A person asking an edge node to republish its birth certificate. The daemon claims PENDING rows and publishes Node Control/Rebirth, which is the only NCMD this stack sends and the only one mosquitto.acl permits it. Not a general command channel: writing a metric VALUE is actuation and is deliberately not reachable from here. See 0058''s header.';

--

-- role_permissions :: TABLE
--

CREATE TABLE IF NOT EXISTS public.role_permissions (
    role_id integer NOT NULL,
    permission_id uuid NOT NULL
);

--

-- roles :: TABLE
--

CREATE TABLE IF NOT EXISTS public.roles (
    id integer NOT NULL,
    name text NOT NULL,
    description text
);

--

-- roles_id_seq :: SEQUENCE
--

CREATE SEQUENCE IF NOT EXISTS public.roles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--

-- roles_id_seq :: SEQUENCE OWNED BY
--

ALTER SEQUENCE public.roles_id_seq OWNED BY public.roles.id;

--

-- schema_bootstrap :: TABLE
--

CREATE TABLE IF NOT EXISTS public.schema_bootstrap (
    id boolean DEFAULT true NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT schema_bootstrap_id_check CHECK (id)
);

--

-- TABLE schema_bootstrap :: COMMENT
--

COMMENT ON TABLE public.schema_bootstrap IS 'One row. completed_at IS NULL means db-init is part-way through the migration chain; a non-null completed_at means it reached the end of seed.sql on this boot. Written by db-init, not by a migration -- a migration cannot know whether the files after it succeeded.';

--

-- COLUMN schema_bootstrap.completed_at :: COMMENT
--

COMMENT ON COLUMN public.schema_bootstrap.completed_at IS 'Cleared at the start of every boot and stamped after seed.sql. The e2e-validate Job gates on it.';

--

-- schemas :: TABLE
--

CREATE TABLE IF NOT EXISTS public.schemas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    schema_name text NOT NULL,
    description text,
    schema_definition jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    semantic_id text,
    semantic_id_type text,
    version integer DEFAULT 1 NOT NULL,
    parent_schema_id uuid,
    status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    change_description text,
    CONSTRAINT schemas_parent_not_self CHECK (((parent_schema_id IS NULL) OR (parent_schema_id <> id))),
    CONSTRAINT schemas_semantic_id_type_valid CHECK (((semantic_id_type IS NULL) OR (semantic_id_type = ANY (ARRAY['IRI'::text, 'IRDI'::text, 'ModelReference'::text])))),
    CONSTRAINT schemas_status_valid CHECK (((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('active'::character varying)::text, ('archived'::character varying)::text]))),
    CONSTRAINT schemas_version_lineage_coherent CHECK ((((version = 1) AND (parent_schema_id IS NULL)) OR ((version > 1) AND (parent_schema_id IS NOT NULL)))),
    CONSTRAINT schemas_version_positive CHECK ((version >= 1))
);

--

-- COLUMN schemas.semantic_id :: COMMENT
--

COMMENT ON COLUMN public.schemas.semantic_id IS 'AAS semanticId for the Submodel this schema corresponds to, e.g. an IDTA submodel template id.';

--

-- COLUMN schemas.version :: COMMENT
--

COMMENT ON COLUMN public.schemas.version IS 'Auto-incremented lineage position. Never supplied by a caller -- fork_schema() derives it from the parent.';

--

-- COLUMN schemas.parent_schema_id :: COMMENT
--

COMMENT ON COLUMN public.schemas.parent_schema_id IS 'The version this one was forked from. NULL only for a v1 root.';

--

-- COLUMN schemas.status :: COMMENT
--

COMMENT ON COLUMN public.schemas.status IS 'draft (editable) | active (in force, immutable) | archived (superseded, immutable).';

--

-- COLUMN schemas.change_description :: COMMENT
--

COMMENT ON COLUMN public.schemas.change_description IS 'Why this version exists. Captured at fork time; immutable once the version is published.';

--

-- storage_footprint :: FOREIGN TABLE
--

CREATE FOREIGN TABLE IF NOT EXISTS timescale.storage_footprint (
    collected_at timestamp with time zone,
    source text,
    tier text,
    relation text,
    chunks bigint,
    table_bytes bigint,
    index_bytes bigint,
    toast_bytes bigint,
    total_bytes bigint,
    uncompressed_bytes bigint,
    compressed_bytes bigint,
    oldest_data timestamp with time zone,
    newest_data timestamp with time zone
)
SERVER timescaledb_server
OPTIONS (
    schema_name 'public',
    table_name 'storage_footprint'
);

--

-- storage_footprint :: VIEW
--

CREATE OR REPLACE VIEW public.storage_footprint AS
 SELECT f.collected_at,
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
 SELECT now() AS collected_at,
    'platform'::text AS source,
    p.tier,
    p.relation,
    NULL::bigint AS chunks,
    p.table_bytes,
    p.index_bytes,
    p.toast_bytes,
    p.total_bytes,
    NULL::bigint AS uncompressed_bytes,
    NULL::bigint AS compressed_bytes,
    NULL::timestamp with time zone AS oldest_data,
    NULL::timestamp with time zone AS newest_data
   FROM public.platform_storage_rows() p(tier, relation, table_bytes, index_bytes, toast_bytes, total_bytes);

--

-- VIEW storage_footprint :: COMMENT
--

COMMENT ON VIEW public.storage_footprint IS 'Every relation this platform stores, from both databases: the historian over postgres_fdw and the Supabase public schema locally. Bytes by kind, chunk count and compression for hypertables, and the time span the chunks cover. Read by Grafana as the `supabase` datasource.';

--

-- system_settings :: TABLE
--

CREATE TABLE IF NOT EXISTS public.system_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    value jsonb NOT NULL,
    value_type text NOT NULL,
    category text NOT NULL,
    label text NOT NULL,
    description text,
    fallback_source text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    min_value numeric,
    max_value numeric,
    CONSTRAINT system_settings_key_format CHECK ((key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'::text)),
    CONSTRAINT system_settings_value_matches_type CHECK (
CASE value_type
    WHEN 'string'::text THEN (jsonb_typeof(value) = 'string'::text)
    WHEN 'number'::text THEN (jsonb_typeof(value) = 'number'::text)
    WHEN 'boolean'::text THEN (jsonb_typeof(value) = 'boolean'::text)
    WHEN 'json'::text THEN (jsonb_typeof(value) = ANY (ARRAY['object'::text, 'array'::text]))
    ELSE NULL::boolean
END),
    CONSTRAINT system_settings_value_type_known CHECK ((value_type = ANY (ARRAY['string'::text, 'number'::text, 'boolean'::text, 'json'::text]))),
    CONSTRAINT system_settings_value_within_bounds CHECK (((value_type <> 'number'::text) OR (((min_value IS NULL) OR (((value #>> '{}'::text[]))::numeric >= min_value)) AND ((max_value IS NULL) OR (((value #>> '{}'::text[]))::numeric <= max_value)))))
);

--

-- TABLE system_settings :: COMMENT
--

COMMENT ON TABLE public.system_settings IS 'Runtime configuration an Administrator may change without a container restart. The key set is closed: RLS grants UPDATE only, and new keys arrive by migration beside the code that reads them. Nothing secret belongs here -- every authenticated user can read this table.';

--

-- COLUMN system_settings.min_value :: COMMENT
--

COMMENT ON COLUMN public.system_settings.min_value IS 'Inclusive lower bound for a number setting. NULL means unbounded. Enforced by CHECK, not by the reader: a value the table accepts and the consumer then ignores is a setting that lies.';

--

-- COLUMN system_settings.max_value :: COMMENT
--

COMMENT ON COLUMN public.system_settings.max_value IS 'Inclusive upper bound for a number setting. NULL means unbounded.';

--

-- telemetry :: FOREIGN TABLE
--

CREATE FOREIGN TABLE IF NOT EXISTS timescale.telemetry (
    "time" timestamp with time zone NOT NULL,
    asset_id text NOT NULL,
    metric_name text NOT NULL,
    val_double double precision,
    val_string text,
    val_bool boolean
)
SERVER timescaledb_server
OPTIONS (
    schema_name 'public',
    table_name 'telemetry'
);

--

-- telemetry :: VIEW
--

CREATE OR REPLACE VIEW public.telemetry WITH (security_invoker='true') AS
 SELECT "time",
    asset_id,
    metric_name,
    val_double,
    val_string,
    val_bool
   FROM timescale.telemetry;

--

-- VIEW telemetry :: COMMENT
--

COMMENT ON VIEW public.telemetry IS 'Read-only PostgREST projection of the standalone TimescaleDB telemetry hypertable, reached over postgres_fdw. Filter with asset_id / metric_name / time and always pass a limit -- postgres_fdw pushes WHERE clauses to the remote but not LIMIT, so an unbounded query materialises the whole matching range locally.';

--

-- telemetry_1h :: FOREIGN TABLE
--

CREATE FOREIGN TABLE IF NOT EXISTS timescale.telemetry_1h (
    bucket timestamp with time zone NOT NULL,
    asset_id text NOT NULL,
    metric_name text NOT NULL,
    sum_double double precision,
    n_double bigint,
    min_double double precision,
    max_double double precision,
    last_double double precision,
    last_string text,
    last_bool boolean,
    n_rows bigint
)
SERVER timescaledb_server
OPTIONS (
    schema_name 'public',
    table_name 'telemetry_1h'
);

--

-- telemetry_1h :: VIEW
--

CREATE OR REPLACE VIEW public.telemetry_1h WITH (security_invoker='true') AS
 SELECT bucket,
    asset_id,
    metric_name,
    (sum_double / (NULLIF(n_double, 0))::double precision) AS avg_double,
    min_double,
    max_double,
    last_double,
    last_string,
    last_bool,
    n_double,
    n_rows
   FROM timescale.telemetry_1h t;

--

-- VIEW telemetry_1h :: COMMENT
--

COMMENT ON VIEW public.telemetry_1h IS 'Hourly rollup, aggregated from telemetry_5m. Retained far longer than the raw hypertable, so it answers questions about periods the raw retention window has already dropped.';

--

-- telemetry_1m :: FOREIGN TABLE
--

CREATE FOREIGN TABLE IF NOT EXISTS timescale.telemetry_1m (
    bucket timestamp with time zone NOT NULL,
    asset_id text NOT NULL,
    metric_name text NOT NULL,
    sum_double double precision,
    n_double bigint,
    min_double double precision,
    max_double double precision,
    last_double double precision,
    last_string text,
    last_bool boolean,
    n_rows bigint
)
SERVER timescaledb_server
OPTIONS (
    schema_name 'public',
    table_name 'telemetry_1m'
);

--

-- telemetry_1m :: VIEW
--

CREATE OR REPLACE VIEW public.telemetry_1m WITH (security_invoker='true') AS
 SELECT bucket,
    asset_id,
    metric_name,
    (sum_double / (NULLIF(n_double, 0))::double precision) AS avg_double,
    min_double,
    max_double,
    last_double,
    last_string,
    last_bool,
    n_double,
    n_rows
   FROM timescale.telemetry_1m t;

--

-- VIEW telemetry_1m :: COMMENT
--

COMMENT ON VIEW public.telemetry_1m IS 'One-minute rollup of the telemetry hypertable. avg_double is derived from the stored sum and count; min/max are preserved because an average hides the excursion. last_string/last_bool carry state metrics, which cannot be averaged. Filter with bucket / asset_id / metric_name.';

--

-- telemetry_5m :: FOREIGN TABLE
--

CREATE FOREIGN TABLE IF NOT EXISTS timescale.telemetry_5m (
    bucket timestamp with time zone NOT NULL,
    asset_id text NOT NULL,
    metric_name text NOT NULL,
    sum_double double precision,
    n_double bigint,
    min_double double precision,
    max_double double precision,
    last_double double precision,
    last_string text,
    last_bool boolean,
    n_rows bigint
)
SERVER timescaledb_server
OPTIONS (
    schema_name 'public',
    table_name 'telemetry_5m'
);

--

-- telemetry_5m :: VIEW
--

CREATE OR REPLACE VIEW public.telemetry_5m WITH (security_invoker='true') AS
 SELECT bucket,
    asset_id,
    metric_name,
    (sum_double / (NULLIF(n_double, 0))::double precision) AS avg_double,
    min_double,
    max_double,
    last_double,
    last_string,
    last_bool,
    n_double,
    n_rows
   FROM timescale.telemetry_5m t;

--

-- VIEW telemetry_5m :: COMMENT
--

COMMENT ON VIEW public.telemetry_5m IS 'Five-minute rollup, aggregated from telemetry_1m. See telemetry_1m.';

--

-- telemetry_latest :: FOREIGN TABLE
--

CREATE FOREIGN TABLE IF NOT EXISTS timescale.telemetry_latest (
    "time" timestamp with time zone NOT NULL,
    asset_id text NOT NULL,
    metric_name text NOT NULL,
    val_double double precision,
    val_string text,
    val_bool boolean
)
SERVER timescaledb_server
OPTIONS (
    schema_name 'public',
    table_name 'telemetry_latest'
);

--

-- telemetry_latest :: VIEW
--

CREATE OR REPLACE VIEW public.telemetry_latest WITH (security_invoker='true') AS
 SELECT "time",
    asset_id,
    metric_name,
    val_double,
    val_string,
    val_bool
   FROM timescale.telemetry_latest t;

--

-- VIEW telemetry_latest :: COMMENT
--

COMMENT ON VIEW public.telemetry_latest IS 'Newest sample per (asset_id, metric_name), evaluated on the TimescaleDB side so postgres_fdw ships one row per series instead of a time window. Filter with asset_id. This is what the dashboard''s latest-value routes read; public.telemetry remains the raw record for exports.';

--

-- user_roles :: TABLE
--

CREATE TABLE IF NOT EXISTS public.user_roles (
    user_id text NOT NULL,
    role_id integer NOT NULL
);

--

-- TABLE user_roles :: COMMENT
--

COMMENT ON TABLE public.user_roles IS 'Role assignment per auth user. Includes three seeded machine principals that cannot sign in: b0000000-0000-4000-8000-000000000001, the read-only principal the MCP client authenticates as (0034); b0000000-0000-4000-8000-000000000002, Service_Ingestor, the identity the ingestion daemon authenticates as (0046); and b0000000-0000-4000-8000-000000000003, Service_Playback, the identity the playback worker authenticates as (0056). All three hold Operator and write nothing directly -- every write goes through a SECURITY DEFINER gate that checks which of them is calling.';

--

-- webhook_endpoints :: TABLE
--

CREATE TABLE IF NOT EXISTS public.webhook_endpoints (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_key text NOT NULL,
    url text NOT NULL,
    secret_name text,
    is_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--

-- TABLE webhook_endpoints :: COMMENT
--

COMMENT ON TABLE public.webhook_endpoints IS 'Outbound webhook targets. Managed by migration only -- there is deliberately no INSERT/UPDATE/DELETE RLS policy, so no API caller can point the database at a host of their choosing.';

--

-- telemetry_archive_manifest :: FOREIGN TABLE
--

CREATE FOREIGN TABLE IF NOT EXISTS timescale.telemetry_archive_manifest (
    chunk_schema text,
    chunk_name text,
    range_start timestamp with time zone,
    range_end timestamp with time zone,
    row_count bigint,
    object_key text,
    object_bytes bigint,
    object_etag text,
    format text,
    claimed_at timestamp with time zone,
    exported_at timestamp with time zone,
    verified_at timestamp with time zone,
    dropped_at timestamp with time zone,
    last_error text
)
SERVER timescaledb_server
OPTIONS (
    schema_name 'public',
    table_name 'telemetry_archive_manifest'
);

--

-- digital_thread id :: DEFAULT
--

ALTER TABLE ONLY public.digital_thread ALTER COLUMN id SET DEFAULT nextval('public.digital_thread_id_seq'::regclass);

--

-- roles id :: DEFAULT
--

ALTER TABLE ONLY public.roles ALTER COLUMN id SET DEFAULT nextval('public.roles_id_seq'::regclass);

--

-- ashrae223_vocabulary ashrae223_vocabulary_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'ashrae223_vocabulary_pkey'
                    AND conrelid = 'public.ashrae223_vocabulary'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.ashrae223_vocabulary
        ADD CONSTRAINT ashrae223_vocabulary_pkey PRIMARY KEY (name);
    
    --
  END IF;
END $c$;

-- asset_config asset_config_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'asset_config_pkey'
                    AND conrelid = 'public.asset_config'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.asset_config
        ADD CONSTRAINT asset_config_pkey PRIMARY KEY (id);
    
    --
  END IF;
END $c$;

-- capture_jobs capture_jobs_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'capture_jobs_pkey'
                    AND conrelid = 'public.capture_jobs'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.capture_jobs
        ADD CONSTRAINT capture_jobs_pkey PRIMARY KEY (id);
    
    --
  END IF;
END $c$;

-- captures captures_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'captures_pkey'
                    AND conrelid = 'public.captures'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.captures
        ADD CONSTRAINT captures_pkey PRIMARY KEY (id);
    
    --
  END IF;
END $c$;

-- captures captures_storage_path_key :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'captures_storage_path_key'
                    AND conrelid = 'public.captures'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.captures
        ADD CONSTRAINT captures_storage_path_key UNIQUE (storage_path);
    
    --
  END IF;
END $c$;

-- cells cells_name_key :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'cells_name_key'
                    AND conrelid = 'public.cells'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.cells
        ADD CONSTRAINT cells_name_key UNIQUE (name);
    
    --
  END IF;
END $c$;

-- cells cells_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'cells_pkey'
                    AND conrelid = 'public.cells'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.cells
        ADD CONSTRAINT cells_pkey PRIMARY KEY (id);
    
    --
  END IF;
END $c$;

-- device_nameplate device_nameplate_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'device_nameplate_pkey'
                    AND conrelid = 'public.device_nameplate'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.device_nameplate
        ADD CONSTRAINT device_nameplate_pkey PRIMARY KEY (device_id);
    
    --
  END IF;
END $c$;

-- device_submodels device_submodels_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'device_submodels_pkey'
                    AND conrelid = 'public.device_submodels'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.device_submodels
        ADD CONSTRAINT device_submodels_pkey PRIMARY KEY (id);
    
    --
  END IF;
END $c$;

-- devices devices_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'devices_pkey'
                    AND conrelid = 'public.devices'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.devices
        ADD CONSTRAINT devices_pkey PRIMARY KEY (id);
    
    --
  END IF;
END $c$;

-- digital_thread digital_thread_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'digital_thread_pkey'
                    AND conrelid = 'public.digital_thread'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.digital_thread
        ADD CONSTRAINT digital_thread_pkey PRIMARY KEY (id);
    
    --
  END IF;
END $c$;

-- directory_liveness_probe directory_liveness_probe_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'directory_liveness_probe_pkey'
                    AND conrelid = 'public.directory_liveness_probe'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.directory_liveness_probe
        ADD CONSTRAINT directory_liveness_probe_pkey PRIMARY KEY (id);
    
    --
  END IF;
END $c$;

-- directory_services directory_services_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'directory_services_pkey'
                    AND conrelid = 'public.directory_services'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.directory_services
        ADD CONSTRAINT directory_services_pkey PRIMARY KEY (id);
    
    --
  END IF;
END $c$;

-- directory_services directory_services_service_name_key :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'directory_services_service_name_key'
                    AND conrelid = 'public.directory_services'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.directory_services
        ADD CONSTRAINT directory_services_service_name_key UNIQUE (service_name);
    
    --
  END IF;
END $c$;

-- gateway_enrollment_tokens gateway_enrollment_tokens_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gateway_enrollment_tokens_pkey'
                    AND conrelid = 'public.gateway_enrollment_tokens'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.gateway_enrollment_tokens
        ADD CONSTRAINT gateway_enrollment_tokens_pkey PRIMARY KEY (id);
    
    --
  END IF;
END $c$;

-- gateways gateways_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gateways_pkey'
                    AND conrelid = 'public.gateways'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.gateways
        ADD CONSTRAINT gateways_pkey PRIMARY KEY (id);
    
    --
  END IF;
END $c$;

-- idta_submodel_templates idta_submodel_templates_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'idta_submodel_templates_pkey'
                    AND conrelid = 'public.idta_submodel_templates'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.idta_submodel_templates
        ADD CONSTRAINT idta_submodel_templates_pkey PRIMARY KEY (template_id, id_short);
    
    --
  END IF;
END $c$;

-- iso22400_vocabulary iso22400_vocabulary_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'iso22400_vocabulary_pkey'
                    AND conrelid = 'public.iso22400_vocabulary'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.iso22400_vocabulary
        ADD CONSTRAINT iso22400_vocabulary_pkey PRIMARY KEY (name);
    
    --
  END IF;
END $c$;

-- links links_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'links_pkey'
                    AND conrelid = 'public.links'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.links
        ADD CONSTRAINT links_pkey PRIMARY KEY (id);
    
    --
  END IF;
END $c$;

-- metric_catalog metric_catalog_name_key :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'metric_catalog_name_key'
                    AND conrelid = 'public.metric_catalog'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.metric_catalog
        ADD CONSTRAINT metric_catalog_name_key UNIQUE (name);
    
    --
  END IF;
END $c$;

-- metric_catalog metric_catalog_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'metric_catalog_pkey'
                    AND conrelid = 'public.metric_catalog'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.metric_catalog
        ADD CONSTRAINT metric_catalog_pkey PRIMARY KEY (id);
    
    --
  END IF;
END $c$;

-- metric_groups metric_groups_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'metric_groups_pkey'
                    AND conrelid = 'public.metric_groups'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.metric_groups
        ADD CONSTRAINT metric_groups_pkey PRIMARY KEY (id);
    
    --
  END IF;
END $c$;

-- mtconnect_vocabulary mtconnect_vocabulary_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'mtconnect_vocabulary_pkey'
                    AND conrelid = 'public.mtconnect_vocabulary'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.mtconnect_vocabulary
        ADD CONSTRAINT mtconnect_vocabulary_pkey PRIMARY KEY (kind, name);
    
    --
  END IF;
END $c$;

-- one_shot_migrations one_shot_migrations_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'one_shot_migrations_pkey'
                    AND conrelid = 'public.one_shot_migrations'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.one_shot_migrations
        ADD CONSTRAINT one_shot_migrations_pkey PRIMARY KEY (key);
    
    --
  END IF;
END $c$;

-- opcua_vocabulary opcua_vocabulary_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'opcua_vocabulary_pkey'
                    AND conrelid = 'public.opcua_vocabulary'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.opcua_vocabulary
        ADD CONSTRAINT opcua_vocabulary_pkey PRIMARY KEY (companion_spec, name);
    
    --
  END IF;
END $c$;

-- permissions permissions_name_key :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'permissions_name_key'
                    AND conrelid = 'public.permissions'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.permissions
        ADD CONSTRAINT permissions_name_key UNIQUE (name);
    
    --
  END IF;
END $c$;

-- permissions permissions_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'permissions_pkey'
                    AND conrelid = 'public.permissions'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.permissions
        ADD CONSTRAINT permissions_pkey PRIMARY KEY (id);
    
    --
  END IF;
END $c$;

-- platform_alerts platform_alerts_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'platform_alerts_pkey'
                    AND conrelid = 'public.platform_alerts'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.platform_alerts
        ADD CONSTRAINT platform_alerts_pkey PRIMARY KEY (id);
    
    --
  END IF;
END $c$;

-- playback_jobs playback_jobs_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'playback_jobs_pkey'
                    AND conrelid = 'public.playback_jobs'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.playback_jobs
        ADD CONSTRAINT playback_jobs_pkey PRIMARY KEY (id);
    
    --
  END IF;
END $c$;

-- playback_worker_status playback_worker_status_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'playback_worker_status_pkey'
                    AND conrelid = 'public.playback_worker_status'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.playback_worker_status
        ADD CONSTRAINT playback_worker_status_pkey PRIMARY KEY (id);
    
    --
  END IF;
END $c$;

-- rebirth_requests rebirth_requests_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'rebirth_requests_pkey'
                    AND conrelid = 'public.rebirth_requests'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.rebirth_requests
        ADD CONSTRAINT rebirth_requests_pkey PRIMARY KEY (id);
    
    --
  END IF;
END $c$;

-- role_permissions role_permissions_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'role_permissions_pkey'
                    AND conrelid = 'public.role_permissions'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.role_permissions
        ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (role_id, permission_id);
    
    --
  END IF;
END $c$;

-- roles roles_name_key :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'roles_name_key'
                    AND conrelid = 'public.roles'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.roles
        ADD CONSTRAINT roles_name_key UNIQUE (name);
    
    --
  END IF;
END $c$;

-- roles roles_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'roles_pkey'
                    AND conrelid = 'public.roles'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.roles
        ADD CONSTRAINT roles_pkey PRIMARY KEY (id);
    
    --
  END IF;
END $c$;

-- schema_bootstrap schema_bootstrap_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'schema_bootstrap_pkey'
                    AND conrelid = 'public.schema_bootstrap'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.schema_bootstrap
        ADD CONSTRAINT schema_bootstrap_pkey PRIMARY KEY (id);
    
    --
  END IF;
END $c$;

-- schemas schemas_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'schemas_pkey'
                    AND conrelid = 'public.schemas'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.schemas
        ADD CONSTRAINT schemas_pkey PRIMARY KEY (id);
    
    --
  END IF;
END $c$;

-- schemas schemas_schema_name_key :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'schemas_schema_name_key'
                    AND conrelid = 'public.schemas'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.schemas
        ADD CONSTRAINT schemas_schema_name_key UNIQUE (schema_name);
    
    --
  END IF;
END $c$;

-- system_settings system_settings_key_key :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'system_settings_key_key'
                    AND conrelid = 'public.system_settings'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.system_settings
        ADD CONSTRAINT system_settings_key_key UNIQUE (key);
    
    --
  END IF;
END $c$;

-- system_settings system_settings_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'system_settings_pkey'
                    AND conrelid = 'public.system_settings'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.system_settings
        ADD CONSTRAINT system_settings_pkey PRIMARY KEY (id);
    
    --
  END IF;
END $c$;

-- asset_config uq_asset_config_metric :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'uq_asset_config_metric'
                    AND conrelid = 'public.asset_config'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.asset_config
        ADD CONSTRAINT uq_asset_config_metric UNIQUE (asset_id, metric_name);
    
    --
  END IF;
END $c$;

-- device_submodels uq_device_submodels :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'uq_device_submodels'
                    AND conrelid = 'public.device_submodels'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.device_submodels
        ADD CONSTRAINT uq_device_submodels UNIQUE (device_id, schema_id);
    
    --
  END IF;
END $c$;

-- platform_alerts uq_platform_alerts_event :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'uq_platform_alerts_event'
                    AND conrelid = 'public.platform_alerts'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.platform_alerts
        ADD CONSTRAINT uq_platform_alerts_event UNIQUE (fingerprint, starts_at);
    
    --
  END IF;
END $c$;

-- user_roles user_roles_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'user_roles_pkey'
                    AND conrelid = 'public.user_roles'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.user_roles
        ADD CONSTRAINT user_roles_pkey PRIMARY KEY (user_id, role_id);
    
    --
  END IF;
END $c$;

-- webhook_endpoints webhook_endpoints_event_key_url_key :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'webhook_endpoints_event_key_url_key'
                    AND conrelid = 'public.webhook_endpoints'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.webhook_endpoints
        ADD CONSTRAINT webhook_endpoints_event_key_url_key UNIQUE (event_key, url);
    
    --
  END IF;
END $c$;

-- webhook_endpoints webhook_endpoints_pkey :: CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'webhook_endpoints_pkey'
                    AND conrelid = 'public.webhook_endpoints'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.webhook_endpoints
        ADD CONSTRAINT webhook_endpoints_pkey PRIMARY KEY (id);
    
    --
  END IF;
END $c$;

-- capture_jobs_single_flight :: INDEX
--

CREATE UNIQUE INDEX IF NOT EXISTS capture_jobs_single_flight ON public.capture_jobs USING btree ((true)) WHERE (status = ANY (ARRAY['PENDING'::text, 'RECORDING'::text]));

--

-- captures_one_per_device :: INDEX
--

CREATE UNIQUE INDEX IF NOT EXISTS captures_one_per_device ON public.captures USING btree (device_id) WHERE (subject_kind = 'device'::text);

--

-- captures_one_per_gateway :: INDEX
--

CREATE UNIQUE INDEX IF NOT EXISTS captures_one_per_gateway ON public.captures USING btree (gateway_id) WHERE (subject_kind = 'gateway'::text);

--

-- gateway_enrollment_tokens_hash_key :: INDEX
--

CREATE UNIQUE INDEX IF NOT EXISTS gateway_enrollment_tokens_hash_key ON public.gateway_enrollment_tokens USING btree (token_hash);

--

-- gateway_enrollment_tokens_one_live_per_gateway :: INDEX
--

CREATE UNIQUE INDEX IF NOT EXISTS gateway_enrollment_tokens_one_live_per_gateway ON public.gateway_enrollment_tokens USING btree (gateway_id) WHERE (consumed_at IS NULL);

--

-- idx_capture_jobs_created_at :: INDEX
--

CREATE INDEX IF NOT EXISTS idx_capture_jobs_created_at ON public.capture_jobs USING btree (created_at DESC);

--

-- idx_device_submodels_device :: INDEX
--

CREATE INDEX IF NOT EXISTS idx_device_submodels_device ON public.device_submodels USING btree (device_id);

--

-- idx_device_submodels_schema :: INDEX
--

CREATE INDEX IF NOT EXISTS idx_device_submodels_schema ON public.device_submodels USING btree (schema_id);

--

-- idx_devices_cell_id :: INDEX
--

CREATE INDEX IF NOT EXISTS idx_devices_cell_id ON public.devices USING btree (cell_id) WHERE (cell_id IS NOT NULL);

--

-- idx_devices_name :: INDEX
--

CREATE INDEX IF NOT EXISTS idx_devices_name ON public.devices USING btree (name);

--

-- idx_devices_reported_identity :: INDEX
--

CREATE INDEX IF NOT EXISTS idx_devices_reported_identity ON public.devices USING btree (reported_identity) WHERE (reported_identity IS NOT NULL);

--

-- idx_devices_sparkplug_id :: INDEX
--

CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_sparkplug_id ON public.devices USING btree (sparkplug_id);

--

-- idx_digital_thread_causation :: INDEX
--

CREATE INDEX IF NOT EXISTS idx_digital_thread_causation ON public.digital_thread USING btree (causation_id) WHERE (causation_id IS NOT NULL);

--

-- idx_digital_thread_domain :: INDEX
--

CREATE INDEX IF NOT EXISTS idx_digital_thread_domain ON public.digital_thread USING btree (audit_domain, recorded_at DESC);

--

-- idx_gateways_group_sparkplug_id :: INDEX
--

CREATE INDEX IF NOT EXISTS idx_gateways_group_sparkplug_id ON public.gateways USING btree (sparkplug_group, sparkplug_id);

--

-- idx_gateways_name :: INDEX
--

CREATE INDEX IF NOT EXISTS idx_gateways_name ON public.gateways USING btree (name);

--

-- idx_gateways_sparkplug_id :: INDEX
--

CREATE UNIQUE INDEX IF NOT EXISTS idx_gateways_sparkplug_id ON public.gateways USING btree (sparkplug_id);

--

-- idx_links_entity :: INDEX
--

CREATE INDEX IF NOT EXISTS idx_links_entity ON public.links USING btree (entity_type, entity_id);

--

-- idx_metric_catalog_group :: INDEX
--

CREATE INDEX IF NOT EXISTS idx_metric_catalog_group ON public.metric_catalog USING btree (metric_group);

--

-- idx_metric_catalog_semantic_id :: INDEX
--

CREATE INDEX IF NOT EXISTS idx_metric_catalog_semantic_id ON public.metric_catalog USING btree (semantic_id) WHERE (semantic_id IS NOT NULL);

--

-- idx_platform_alerts_entity :: INDEX
--

CREATE INDEX IF NOT EXISTS idx_platform_alerts_entity ON public.platform_alerts USING btree (entity_type, entity_id);

--

-- idx_platform_alerts_sparkplug_started :: INDEX
--

CREATE INDEX IF NOT EXISTS idx_platform_alerts_sparkplug_started ON public.platform_alerts USING btree (sparkplug_id, starts_at DESC);

--

-- idx_platform_alerts_status_started :: INDEX
--

CREATE INDEX IF NOT EXISTS idx_platform_alerts_status_started ON public.platform_alerts USING btree (status, starts_at DESC);

--

-- idx_playback_jobs_created_at :: INDEX
--

CREATE INDEX IF NOT EXISTS idx_playback_jobs_created_at ON public.playback_jobs USING btree (created_at DESC);

--

-- idx_rebirth_requests_requested_at :: INDEX
--

CREATE INDEX IF NOT EXISTS idx_rebirth_requests_requested_at ON public.rebirth_requests USING btree (requested_at DESC);

--

-- idx_schemas_parent :: INDEX
--

CREATE INDEX IF NOT EXISTS idx_schemas_parent ON public.schemas USING btree (parent_schema_id);

--

-- idx_schemas_status :: INDEX
--

CREATE INDEX IF NOT EXISTS idx_schemas_status ON public.schemas USING btree (status);

--

-- playback_jobs_one_per_target :: INDEX
--

CREATE UNIQUE INDEX IF NOT EXISTS playback_jobs_one_per_target ON public.playback_jobs USING btree (target_gateway_id) WHERE (status = ANY (ARRAY['PENDING'::text, 'RUNNING'::text]));

--

-- rebirth_requests_one_pending_per_gateway :: INDEX
--

CREATE UNIQUE INDEX IF NOT EXISTS rebirth_requests_one_pending_per_gateway ON public.rebirth_requests USING btree (gateway_id) WHERE (status = 'PENDING'::text);

--

-- uq_devices_shadow_per_gateway :: INDEX
--

CREATE UNIQUE INDEX IF NOT EXISTS uq_devices_shadow_per_gateway ON public.devices USING btree (gateway_id, shadow_of) WHERE (shadow_of IS NOT NULL);

--

-- uq_metric_groups_name_ci :: INDEX
--

CREATE UNIQUE INDEX IF NOT EXISTS uq_metric_groups_name_ci ON public.metric_groups USING btree (lower(name));

--

-- uq_schemas_one_draft_per_parent :: INDEX
--

CREATE UNIQUE INDEX IF NOT EXISTS uq_schemas_one_draft_per_parent ON public.schemas USING btree (parent_schema_id) WHERE (((status)::text = 'draft'::text) AND (parent_schema_id IS NOT NULL));

--

-- system_settings system_settings_stamp_trg :: TRIGGER
DROP TRIGGER IF EXISTS system_settings_stamp_trg ON public.system_settings;
--

CREATE TRIGGER system_settings_stamp_trg BEFORE UPDATE ON public.system_settings FOR EACH ROW EXECUTE FUNCTION public.system_settings_stamp();

--

-- cells trg_cells_digital_thread :: TRIGGER
DROP TRIGGER IF EXISTS trg_cells_digital_thread ON public.cells;
--

CREATE TRIGGER trg_cells_digital_thread AFTER INSERT OR DELETE OR UPDATE ON public.cells FOR EACH ROW EXECUTE FUNCTION public.log_digital_thread_event();

--

-- devices trg_device_quarantine_webhook_insert :: TRIGGER
DROP TRIGGER IF EXISTS trg_device_quarantine_webhook_insert ON public.devices;
--

CREATE TRIGGER trg_device_quarantine_webhook_insert AFTER INSERT ON public.devices FOR EACH ROW WHEN ((new.is_quarantined IS TRUE)) EXECUTE FUNCTION public.dispatch_device_quarantine_webhook();

--

-- devices trg_device_quarantine_webhook_update :: TRIGGER
DROP TRIGGER IF EXISTS trg_device_quarantine_webhook_update ON public.devices;
--

CREATE TRIGGER trg_device_quarantine_webhook_update AFTER UPDATE OF is_quarantined ON public.devices FOR EACH ROW WHEN (((new.is_quarantined IS TRUE) AND (old.is_quarantined IS DISTINCT FROM true))) EXECUTE FUNCTION public.dispatch_device_quarantine_webhook();

--

-- devices trg_devices_digital_thread :: TRIGGER
DROP TRIGGER IF EXISTS trg_devices_digital_thread ON public.devices;
--

CREATE TRIGGER trg_devices_digital_thread AFTER INSERT OR DELETE OR UPDATE ON public.devices FOR EACH ROW EXECUTE FUNCTION public.log_digital_thread_event();

--

-- digital_thread trg_digital_thread_append_only :: TRIGGER
DROP TRIGGER IF EXISTS trg_digital_thread_append_only ON public.digital_thread;
--

CREATE TRIGGER trg_digital_thread_append_only BEFORE DELETE OR UPDATE ON public.digital_thread FOR EACH ROW EXECUTE FUNCTION public.enforce_digital_thread_append_only();

--

-- digital_thread trg_digital_thread_stamp_domain :: TRIGGER
DROP TRIGGER IF EXISTS trg_digital_thread_stamp_domain ON public.digital_thread;
--

CREATE TRIGGER trg_digital_thread_stamp_domain BEFORE INSERT ON public.digital_thread FOR EACH ROW EXECUTE FUNCTION public.stamp_audit_domain();

--

-- schemas trg_enforce_schema_version_provenance :: TRIGGER
DROP TRIGGER IF EXISTS trg_enforce_schema_version_provenance ON public.schemas;
--

CREATE TRIGGER trg_enforce_schema_version_provenance BEFORE INSERT ON public.schemas FOR EACH ROW EXECUTE FUNCTION public.enforce_schema_version_provenance();

--

-- gateways trg_gateways_clear_credential_revoked :: TRIGGER
DROP TRIGGER IF EXISTS trg_gateways_clear_credential_revoked ON public.gateways;
--

CREATE TRIGGER trg_gateways_clear_credential_revoked BEFORE UPDATE OF is_archived ON public.gateways FOR EACH ROW EXECUTE FUNCTION public.clear_credential_revoked_on_enrolment();

--

-- gateways trg_gateways_digital_thread :: TRIGGER
DROP TRIGGER IF EXISTS trg_gateways_digital_thread ON public.gateways;
--

CREATE TRIGGER trg_gateways_digital_thread AFTER INSERT OR DELETE OR UPDATE ON public.gateways FOR EACH ROW EXECUTE FUNCTION public.log_digital_thread_event();

--

-- gateways trg_gateways_keep_a_playback_target :: TRIGGER
DROP TRIGGER IF EXISTS trg_gateways_keep_a_playback_target ON public.gateways;
--

CREATE TRIGGER trg_gateways_keep_a_playback_target BEFORE UPDATE OF is_archived ON public.gateways FOR EACH ROW EXECUTE FUNCTION public.refuse_archiving_the_last_shadow_gateway();

--

-- gateways trg_gateways_revoke_credential_delete :: TRIGGER
DROP TRIGGER IF EXISTS trg_gateways_revoke_credential_delete ON public.gateways;
--

CREATE TRIGGER trg_gateways_revoke_credential_delete BEFORE DELETE ON public.gateways FOR EACH ROW EXECUTE FUNCTION public.revoke_credential_on_decommission();

--

-- gateways trg_gateways_revoke_credential_update :: TRIGGER
DROP TRIGGER IF EXISTS trg_gateways_revoke_credential_update ON public.gateways;
--

CREATE TRIGGER trg_gateways_revoke_credential_update AFTER UPDATE OF is_archived ON public.gateways FOR EACH ROW EXECUTE FUNCTION public.revoke_credential_on_decommission();

--

-- gateways trg_gateways_sync_deployment :: TRIGGER
DROP TRIGGER IF EXISTS trg_gateways_sync_deployment ON public.gateways;
--

CREATE TRIGGER trg_gateways_sync_deployment BEFORE INSERT OR UPDATE OF deployment, is_virtual ON public.gateways FOR EACH ROW EXECUTE FUNCTION public.sync_gateway_deployment();

--

-- gateways trg_gateways_withdraw_enrolment :: TRIGGER
DROP TRIGGER IF EXISTS trg_gateways_withdraw_enrolment ON public.gateways;
--

CREATE TRIGGER trg_gateways_withdraw_enrolment AFTER UPDATE OF is_archived ON public.gateways FOR EACH ROW EXECUTE FUNCTION public.withdraw_gateway_enrollment_tokens();

--

-- metric_catalog trg_metric_catalog_immutability :: TRIGGER
DROP TRIGGER IF EXISTS trg_metric_catalog_immutability ON public.metric_catalog;
--

CREATE TRIGGER trg_metric_catalog_immutability BEFORE UPDATE ON public.metric_catalog FOR EACH ROW EXECUTE FUNCTION public.enforce_metric_catalog_immutability();

--

-- metric_catalog trg_metric_group_spelling :: TRIGGER
DROP TRIGGER IF EXISTS trg_metric_group_spelling ON public.metric_catalog;
--

CREATE TRIGGER trg_metric_group_spelling BEFORE INSERT ON public.metric_catalog FOR EACH ROW EXECUTE FUNCTION public.enforce_metric_group_spelling();

--

-- playback_jobs trg_playback_target_must_be_shadow :: TRIGGER
DROP TRIGGER IF EXISTS trg_playback_target_must_be_shadow ON public.playback_jobs;
--

CREATE TRIGGER trg_playback_target_must_be_shadow BEFORE INSERT ON public.playback_jobs FOR EACH ROW EXECUTE FUNCTION public.playback_target_must_be_shadow();

--

-- schemas trg_prevent_active_schema_mutation :: TRIGGER
DROP TRIGGER IF EXISTS trg_prevent_active_schema_mutation ON public.schemas;
--

CREATE TRIGGER trg_prevent_active_schema_mutation BEFORE UPDATE ON public.schemas FOR EACH ROW EXECUTE FUNCTION public.prevent_active_schema_mutation();

--

-- schemas trg_schemas_digital_thread :: TRIGGER
DROP TRIGGER IF EXISTS trg_schemas_digital_thread ON public.schemas;
--

CREATE TRIGGER trg_schemas_digital_thread AFTER INSERT OR DELETE OR UPDATE ON public.schemas FOR EACH ROW EXECUTE FUNCTION public.log_digital_thread_event();

--

-- system_settings trg_system_settings_digital_thread :: TRIGGER
DROP TRIGGER IF EXISTS trg_system_settings_digital_thread ON public.system_settings;
--

CREATE TRIGGER trg_system_settings_digital_thread AFTER INSERT OR DELETE ON public.system_settings FOR EACH ROW EXECUTE FUNCTION public.log_digital_thread_event();

--

-- system_settings trg_system_settings_digital_thread_update :: TRIGGER
DROP TRIGGER IF EXISTS trg_system_settings_digital_thread_update ON public.system_settings;
--

CREATE TRIGGER trg_system_settings_digital_thread_update AFTER UPDATE ON public.system_settings FOR EACH ROW WHEN ((((to_jsonb(new.*) - 'updated_at'::text) - 'updated_by'::text) IS DISTINCT FROM ((to_jsonb(old.*) - 'updated_at'::text) - 'updated_by'::text))) EXECUTE FUNCTION public.log_digital_thread_event();

--

-- user_roles trg_user_roles_digital_thread :: TRIGGER
DROP TRIGGER IF EXISTS trg_user_roles_digital_thread ON public.user_roles;
--

CREATE TRIGGER trg_user_roles_digital_thread AFTER INSERT OR DELETE OR UPDATE ON public.user_roles FOR EACH ROW EXECUTE FUNCTION public.log_role_assignment();

--

-- capture_jobs capture_jobs_capture_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'capture_jobs_capture_id_fkey'
                    AND conrelid = 'public.capture_jobs'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.capture_jobs
        ADD CONSTRAINT capture_jobs_capture_id_fkey FOREIGN KEY (capture_id) REFERENCES public.captures(id) ON DELETE SET NULL;
    
    --
  END IF;
END $c$;

-- capture_jobs capture_jobs_device_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'capture_jobs_device_id_fkey'
                    AND conrelid = 'public.capture_jobs'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.capture_jobs
        ADD CONSTRAINT capture_jobs_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;
    
    --
  END IF;
END $c$;

-- capture_jobs capture_jobs_gateway_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'capture_jobs_gateway_id_fkey'
                    AND conrelid = 'public.capture_jobs'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.capture_jobs
        ADD CONSTRAINT capture_jobs_gateway_id_fkey FOREIGN KEY (gateway_id) REFERENCES public.gateways(id) ON DELETE CASCADE;
    
    --
  END IF;
END $c$;

-- captures captures_device_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'captures_device_id_fkey'
                    AND conrelid = 'public.captures'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.captures
        ADD CONSTRAINT captures_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;
    
    --
  END IF;
END $c$;

-- captures captures_gateway_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'captures_gateway_id_fkey'
                    AND conrelid = 'public.captures'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.captures
        ADD CONSTRAINT captures_gateway_id_fkey FOREIGN KEY (gateway_id) REFERENCES public.gateways(id) ON DELETE CASCADE;
    
    --
  END IF;
END $c$;

-- device_nameplate device_nameplate_device_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'device_nameplate_device_id_fkey'
                    AND conrelid = 'public.device_nameplate'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.device_nameplate
        ADD CONSTRAINT device_nameplate_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;
    
    --
  END IF;
END $c$;

-- device_submodels device_submodels_device_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'device_submodels_device_id_fkey'
                    AND conrelid = 'public.device_submodels'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.device_submodels
        ADD CONSTRAINT device_submodels_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;
    
    --
  END IF;
END $c$;

-- device_submodels device_submodels_schema_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'device_submodels_schema_id_fkey'
                    AND conrelid = 'public.device_submodels'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.device_submodels
        ADD CONSTRAINT device_submodels_schema_id_fkey FOREIGN KEY (schema_id) REFERENCES public.schemas(id) ON DELETE CASCADE;
    
    --
  END IF;
END $c$;

-- devices devices_cell_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'devices_cell_id_fkey'
                    AND conrelid = 'public.devices'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.devices
        ADD CONSTRAINT devices_cell_id_fkey FOREIGN KEY (cell_id) REFERENCES public.cells(id) ON DELETE SET NULL;
    
    --
  END IF;
END $c$;

-- devices devices_gateway_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'devices_gateway_id_fkey'
                    AND conrelid = 'public.devices'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.devices
        ADD CONSTRAINT devices_gateway_id_fkey FOREIGN KEY (gateway_id) REFERENCES public.gateways(id) ON DELETE SET NULL;
    
    --
  END IF;
END $c$;

-- devices devices_schema_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'devices_schema_id_fkey'
                    AND conrelid = 'public.devices'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.devices
        ADD CONSTRAINT devices_schema_id_fkey FOREIGN KEY (schema_id) REFERENCES public.schemas(id) ON DELETE SET NULL;
    
    --
  END IF;
END $c$;

-- devices devices_shadow_of_fkey :: FK CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'devices_shadow_of_fkey'
                    AND conrelid = 'public.devices'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.devices
        ADD CONSTRAINT devices_shadow_of_fkey FOREIGN KEY (shadow_of) REFERENCES public.devices(id) ON DELETE SET NULL;
    
    --
  END IF;
END $c$;

-- digital_thread digital_thread_changed_by_fkey :: FK CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'digital_thread_changed_by_fkey'
                    AND conrelid = 'public.digital_thread'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.digital_thread
        ADD CONSTRAINT digital_thread_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES auth.users(id);
    
    --
  END IF;
END $c$;

-- directory_services directory_services_registered_schema_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'directory_services_registered_schema_id_fkey'
                    AND conrelid = 'public.directory_services'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.directory_services
        ADD CONSTRAINT directory_services_registered_schema_id_fkey FOREIGN KEY (registered_schema_id) REFERENCES public.schemas(id) ON DELETE SET NULL;
    
    --
  END IF;
END $c$;

-- gateway_enrollment_tokens gateway_enrollment_tokens_gateway_fk :: FK CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gateway_enrollment_tokens_gateway_fk'
                    AND conrelid = 'public.gateway_enrollment_tokens'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.gateway_enrollment_tokens
        ADD CONSTRAINT gateway_enrollment_tokens_gateway_fk FOREIGN KEY (gateway_id) REFERENCES public.gateways(id) ON DELETE CASCADE;
    
    --
  END IF;
END $c$;

-- gateways gateways_cell_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gateways_cell_id_fkey'
                    AND conrelid = 'public.gateways'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.gateways
        ADD CONSTRAINT gateways_cell_id_fkey FOREIGN KEY (cell_id) REFERENCES public.cells(id) ON DELETE CASCADE;
    
    --
  END IF;
END $c$;

-- metric_catalog metric_catalog_superseded_by_fkey :: FK CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'metric_catalog_superseded_by_fkey'
                    AND conrelid = 'public.metric_catalog'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.metric_catalog
        ADD CONSTRAINT metric_catalog_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES public.metric_catalog(id) ON DELETE SET NULL;
    
    --
  END IF;
END $c$;

-- playback_jobs playback_jobs_capture_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'playback_jobs_capture_id_fkey'
                    AND conrelid = 'public.playback_jobs'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.playback_jobs
        ADD CONSTRAINT playback_jobs_capture_id_fkey FOREIGN KEY (capture_id) REFERENCES public.captures(id) ON DELETE SET NULL;
    
    --
  END IF;
END $c$;

-- playback_jobs playback_jobs_target_gateway_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'playback_jobs_target_gateway_id_fkey'
                    AND conrelid = 'public.playback_jobs'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.playback_jobs
        ADD CONSTRAINT playback_jobs_target_gateway_id_fkey FOREIGN KEY (target_gateway_id) REFERENCES public.gateways(id) ON DELETE CASCADE;
    
    --
  END IF;
END $c$;

-- rebirth_requests rebirth_requests_gateway_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'rebirth_requests_gateway_id_fkey'
                    AND conrelid = 'public.rebirth_requests'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.rebirth_requests
        ADD CONSTRAINT rebirth_requests_gateway_id_fkey FOREIGN KEY (gateway_id) REFERENCES public.gateways(id) ON DELETE CASCADE;
    
    --
  END IF;
END $c$;

-- role_permissions role_permissions_permission_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'role_permissions_permission_id_fkey'
                    AND conrelid = 'public.role_permissions'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.role_permissions
        ADD CONSTRAINT role_permissions_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON DELETE CASCADE;
    
    --
  END IF;
END $c$;

-- role_permissions role_permissions_role_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'role_permissions_role_id_fkey'
                    AND conrelid = 'public.role_permissions'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.role_permissions
        ADD CONSTRAINT role_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;
    
    --
  END IF;
END $c$;

-- schemas schemas_parent_schema_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'schemas_parent_schema_id_fkey'
                    AND conrelid = 'public.schemas'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.schemas
        ADD CONSTRAINT schemas_parent_schema_id_fkey FOREIGN KEY (parent_schema_id) REFERENCES public.schemas(id) ON DELETE SET NULL;
    
    --
  END IF;
END $c$;

-- user_roles user_roles_role_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'user_roles_role_id_fkey'
                    AND conrelid = 'public.user_roles'::regclass) THEN
    --
    
    ALTER TABLE ONLY public.user_roles
        ADD CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;
    
    --
  END IF;
END $c$;

-- ashrae223_vocabulary :: ROW SECURITY
--

ALTER TABLE public.ashrae223_vocabulary ENABLE ROW LEVEL SECURITY;

--

-- ashrae223_vocabulary ashrae223_vocabulary_select_authenticated :: POLICY
DROP POLICY IF EXISTS ashrae223_vocabulary_select_authenticated ON public.ashrae223_vocabulary;
--

CREATE POLICY ashrae223_vocabulary_select_authenticated ON public.ashrae223_vocabulary FOR SELECT TO authenticated USING (true);

--

-- asset_config :: ROW SECURITY
--

ALTER TABLE public.asset_config ENABLE ROW LEVEL SECURITY;

--

-- asset_config asset_config_delete_privileged :: POLICY
DROP POLICY IF EXISTS asset_config_delete_privileged ON public.asset_config;
--

CREATE POLICY asset_config_delete_privileged ON public.asset_config FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- asset_config asset_config_insert_privileged :: POLICY
DROP POLICY IF EXISTS asset_config_insert_privileged ON public.asset_config;
--

CREATE POLICY asset_config_insert_privileged ON public.asset_config FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- asset_config asset_config_select_authenticated :: POLICY
DROP POLICY IF EXISTS asset_config_select_authenticated ON public.asset_config;
--

CREATE POLICY asset_config_select_authenticated ON public.asset_config FOR SELECT TO authenticated USING (true);

--

-- asset_config asset_config_update_privileged :: POLICY
DROP POLICY IF EXISTS asset_config_update_privileged ON public.asset_config;
--

CREATE POLICY asset_config_update_privileged ON public.asset_config FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- capture_jobs :: ROW SECURITY
--

ALTER TABLE public.capture_jobs ENABLE ROW LEVEL SECURITY;

--

-- capture_jobs capture_jobs_select_privileged :: POLICY
DROP POLICY IF EXISTS capture_jobs_select_privileged ON public.capture_jobs;
--

CREATE POLICY capture_jobs_select_privileged ON public.capture_jobs FOR SELECT TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text, 'Auditor'::text]));

--

-- captures :: ROW SECURITY
--

ALTER TABLE public.captures ENABLE ROW LEVEL SECURITY;

--

-- captures captures_delete_privileged :: POLICY
DROP POLICY IF EXISTS captures_delete_privileged ON public.captures;
--

CREATE POLICY captures_delete_privileged ON public.captures FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- captures captures_select_privileged :: POLICY
DROP POLICY IF EXISTS captures_select_privileged ON public.captures;
--

CREATE POLICY captures_select_privileged ON public.captures FOR SELECT TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text, 'Auditor'::text]));

--

-- cells :: ROW SECURITY
--

ALTER TABLE public.cells ENABLE ROW LEVEL SECURITY;

--

-- cells cells_delete_privileged :: POLICY
DROP POLICY IF EXISTS cells_delete_privileged ON public.cells;
--

CREATE POLICY cells_delete_privileged ON public.cells FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- cells cells_insert_privileged :: POLICY
DROP POLICY IF EXISTS cells_insert_privileged ON public.cells;
--

CREATE POLICY cells_insert_privileged ON public.cells FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- cells cells_select_authenticated :: POLICY
DROP POLICY IF EXISTS cells_select_authenticated ON public.cells;
--

CREATE POLICY cells_select_authenticated ON public.cells FOR SELECT TO authenticated USING (true);

--

-- cells cells_update_privileged :: POLICY
DROP POLICY IF EXISTS cells_update_privileged ON public.cells;
--

CREATE POLICY cells_update_privileged ON public.cells FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- device_nameplate :: ROW SECURITY
--

ALTER TABLE public.device_nameplate ENABLE ROW LEVEL SECURITY;

--

-- device_nameplate device_nameplate_delete_privileged :: POLICY
DROP POLICY IF EXISTS device_nameplate_delete_privileged ON public.device_nameplate;
--

CREATE POLICY device_nameplate_delete_privileged ON public.device_nameplate FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- device_nameplate device_nameplate_insert_privileged :: POLICY
DROP POLICY IF EXISTS device_nameplate_insert_privileged ON public.device_nameplate;
--

CREATE POLICY device_nameplate_insert_privileged ON public.device_nameplate FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- device_nameplate device_nameplate_select_authenticated :: POLICY
DROP POLICY IF EXISTS device_nameplate_select_authenticated ON public.device_nameplate;
--

CREATE POLICY device_nameplate_select_authenticated ON public.device_nameplate FOR SELECT TO authenticated USING (true);

--

-- device_nameplate device_nameplate_update_privileged :: POLICY
DROP POLICY IF EXISTS device_nameplate_update_privileged ON public.device_nameplate;
--

CREATE POLICY device_nameplate_update_privileged ON public.device_nameplate FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- device_submodels :: ROW SECURITY
--

ALTER TABLE public.device_submodels ENABLE ROW LEVEL SECURITY;

--

-- device_submodels device_submodels_delete_privileged :: POLICY
DROP POLICY IF EXISTS device_submodels_delete_privileged ON public.device_submodels;
--

CREATE POLICY device_submodels_delete_privileged ON public.device_submodels FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- device_submodels device_submodels_insert_privileged :: POLICY
DROP POLICY IF EXISTS device_submodels_insert_privileged ON public.device_submodels;
--

CREATE POLICY device_submodels_insert_privileged ON public.device_submodels FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- device_submodels device_submodels_select_authenticated :: POLICY
DROP POLICY IF EXISTS device_submodels_select_authenticated ON public.device_submodels;
--

CREATE POLICY device_submodels_select_authenticated ON public.device_submodels FOR SELECT TO authenticated USING (true);

--

-- device_submodels device_submodels_update_privileged :: POLICY
DROP POLICY IF EXISTS device_submodels_update_privileged ON public.device_submodels;
--

CREATE POLICY device_submodels_update_privileged ON public.device_submodels FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- devices :: ROW SECURITY
--

ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;

--

-- devices devices_delete_privileged :: POLICY
DROP POLICY IF EXISTS devices_delete_privileged ON public.devices;
--

CREATE POLICY devices_delete_privileged ON public.devices FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- devices devices_insert_privileged :: POLICY
DROP POLICY IF EXISTS devices_insert_privileged ON public.devices;
--

CREATE POLICY devices_insert_privileged ON public.devices FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- devices devices_select_authenticated :: POLICY
DROP POLICY IF EXISTS devices_select_authenticated ON public.devices;
--

CREATE POLICY devices_select_authenticated ON public.devices FOR SELECT TO authenticated USING (true);

--

-- devices devices_update_privileged :: POLICY
DROP POLICY IF EXISTS devices_update_privileged ON public.devices;
--

CREATE POLICY devices_update_privileged ON public.devices FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- digital_thread :: ROW SECURITY
--

ALTER TABLE public.digital_thread ENABLE ROW LEVEL SECURITY;

--

-- digital_thread digital_thread_select_asset :: POLICY
DROP POLICY IF EXISTS digital_thread_select_asset ON public.digital_thread;
--

CREATE POLICY digital_thread_select_asset ON public.digital_thread FOR SELECT TO authenticated USING (((audit_domain = 'asset'::text) AND public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text, 'Auditor'::text])));

--

-- digital_thread digital_thread_select_security :: POLICY
DROP POLICY IF EXISTS digital_thread_select_security ON public.digital_thread;
--

CREATE POLICY digital_thread_select_security ON public.digital_thread FOR SELECT TO authenticated USING (((audit_domain = 'security'::text) AND public.has_role(ARRAY['Administrator'::text, 'Auditor'::text])));

--

-- directory_liveness_probe :: ROW SECURITY
--

ALTER TABLE public.directory_liveness_probe ENABLE ROW LEVEL SECURITY;

--

-- directory_services :: ROW SECURITY
--

ALTER TABLE public.directory_services ENABLE ROW LEVEL SECURITY;

--

-- directory_services directory_services_delete_privileged :: POLICY
DROP POLICY IF EXISTS directory_services_delete_privileged ON public.directory_services;
--

CREATE POLICY directory_services_delete_privileged ON public.directory_services FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- directory_services directory_services_insert_privileged :: POLICY
DROP POLICY IF EXISTS directory_services_insert_privileged ON public.directory_services;
--

CREATE POLICY directory_services_insert_privileged ON public.directory_services FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- directory_services directory_services_select_authenticated :: POLICY
DROP POLICY IF EXISTS directory_services_select_authenticated ON public.directory_services;
--

CREATE POLICY directory_services_select_authenticated ON public.directory_services FOR SELECT TO authenticated USING (true);

--

-- directory_services directory_services_update_privileged :: POLICY
DROP POLICY IF EXISTS directory_services_update_privileged ON public.directory_services;
--

CREATE POLICY directory_services_update_privileged ON public.directory_services FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- gateway_enrollment_tokens :: ROW SECURITY
--

ALTER TABLE public.gateway_enrollment_tokens ENABLE ROW LEVEL SECURITY;

--

-- gateways :: ROW SECURITY
--

ALTER TABLE public.gateways ENABLE ROW LEVEL SECURITY;

--

-- gateways gateways_delete_privileged :: POLICY
DROP POLICY IF EXISTS gateways_delete_privileged ON public.gateways;
--

CREATE POLICY gateways_delete_privileged ON public.gateways FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- gateways gateways_insert_privileged :: POLICY
DROP POLICY IF EXISTS gateways_insert_privileged ON public.gateways;
--

CREATE POLICY gateways_insert_privileged ON public.gateways FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- gateways gateways_select_authenticated :: POLICY
DROP POLICY IF EXISTS gateways_select_authenticated ON public.gateways;
--

CREATE POLICY gateways_select_authenticated ON public.gateways FOR SELECT TO authenticated USING (true);

--

-- gateways gateways_update_privileged :: POLICY
DROP POLICY IF EXISTS gateways_update_privileged ON public.gateways;
--

CREATE POLICY gateways_update_privileged ON public.gateways FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- idta_submodel_templates :: ROW SECURITY
--

ALTER TABLE public.idta_submodel_templates ENABLE ROW LEVEL SECURITY;

--

-- idta_submodel_templates idta_submodel_templates_select_authenticated :: POLICY
DROP POLICY IF EXISTS idta_submodel_templates_select_authenticated ON public.idta_submodel_templates;
--

CREATE POLICY idta_submodel_templates_select_authenticated ON public.idta_submodel_templates FOR SELECT TO authenticated USING (true);

--

-- iso22400_vocabulary :: ROW SECURITY
--

ALTER TABLE public.iso22400_vocabulary ENABLE ROW LEVEL SECURITY;

--

-- iso22400_vocabulary iso22400_vocabulary_select_authenticated :: POLICY
DROP POLICY IF EXISTS iso22400_vocabulary_select_authenticated ON public.iso22400_vocabulary;
--

CREATE POLICY iso22400_vocabulary_select_authenticated ON public.iso22400_vocabulary FOR SELECT TO authenticated USING (true);

--

-- links :: ROW SECURITY
--

ALTER TABLE public.links ENABLE ROW LEVEL SECURITY;

--

-- links links_delete_privileged :: POLICY
DROP POLICY IF EXISTS links_delete_privileged ON public.links;
--

CREATE POLICY links_delete_privileged ON public.links FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- links links_insert_privileged :: POLICY
DROP POLICY IF EXISTS links_insert_privileged ON public.links;
--

CREATE POLICY links_insert_privileged ON public.links FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- links links_select_authenticated :: POLICY
DROP POLICY IF EXISTS links_select_authenticated ON public.links;
--

CREATE POLICY links_select_authenticated ON public.links FOR SELECT TO authenticated USING (true);

--

-- links links_update_privileged :: POLICY
DROP POLICY IF EXISTS links_update_privileged ON public.links;
--

CREATE POLICY links_update_privileged ON public.links FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- metric_catalog :: ROW SECURITY
--

ALTER TABLE public.metric_catalog ENABLE ROW LEVEL SECURITY;

--

-- metric_catalog metric_catalog_insert_privileged :: POLICY
DROP POLICY IF EXISTS metric_catalog_insert_privileged ON public.metric_catalog;
--

CREATE POLICY metric_catalog_insert_privileged ON public.metric_catalog FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text]));

--

-- metric_catalog metric_catalog_select_authenticated :: POLICY
DROP POLICY IF EXISTS metric_catalog_select_authenticated ON public.metric_catalog;
--

CREATE POLICY metric_catalog_select_authenticated ON public.metric_catalog FOR SELECT TO authenticated USING (true);

--

-- metric_catalog metric_catalog_update_privileged :: POLICY
DROP POLICY IF EXISTS metric_catalog_update_privileged ON public.metric_catalog;
--

CREATE POLICY metric_catalog_update_privileged ON public.metric_catalog FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text]));

--

-- metric_groups :: ROW SECURITY
--

ALTER TABLE public.metric_groups ENABLE ROW LEVEL SECURITY;

--

-- metric_groups metric_groups_insert_privileged :: POLICY
DROP POLICY IF EXISTS metric_groups_insert_privileged ON public.metric_groups;
--

CREATE POLICY metric_groups_insert_privileged ON public.metric_groups FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text]));

--

-- metric_groups metric_groups_select_authenticated :: POLICY
DROP POLICY IF EXISTS metric_groups_select_authenticated ON public.metric_groups;
--

CREATE POLICY metric_groups_select_authenticated ON public.metric_groups FOR SELECT TO authenticated USING (true);

--

-- metric_groups metric_groups_update_privileged :: POLICY
DROP POLICY IF EXISTS metric_groups_update_privileged ON public.metric_groups;
--

CREATE POLICY metric_groups_update_privileged ON public.metric_groups FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text]));

--

-- mtconnect_vocabulary :: ROW SECURITY
--

ALTER TABLE public.mtconnect_vocabulary ENABLE ROW LEVEL SECURITY;

--

-- mtconnect_vocabulary mtconnect_vocabulary_select_authenticated :: POLICY
DROP POLICY IF EXISTS mtconnect_vocabulary_select_authenticated ON public.mtconnect_vocabulary;
--

CREATE POLICY mtconnect_vocabulary_select_authenticated ON public.mtconnect_vocabulary FOR SELECT TO authenticated USING (true);

--

-- one_shot_migrations :: ROW SECURITY
--

ALTER TABLE public.one_shot_migrations ENABLE ROW LEVEL SECURITY;

--

-- opcua_vocabulary :: ROW SECURITY
--

ALTER TABLE public.opcua_vocabulary ENABLE ROW LEVEL SECURITY;

--

-- opcua_vocabulary opcua_vocabulary_select_authenticated :: POLICY
DROP POLICY IF EXISTS opcua_vocabulary_select_authenticated ON public.opcua_vocabulary;
--

CREATE POLICY opcua_vocabulary_select_authenticated ON public.opcua_vocabulary FOR SELECT TO authenticated USING (true);

--

-- permissions :: ROW SECURITY
--

ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;

--

-- permissions permissions_select_authenticated :: POLICY
DROP POLICY IF EXISTS permissions_select_authenticated ON public.permissions;
--

CREATE POLICY permissions_select_authenticated ON public.permissions FOR SELECT TO authenticated USING (true);

--

-- platform_alerts :: ROW SECURITY
--

ALTER TABLE public.platform_alerts ENABLE ROW LEVEL SECURITY;

--

-- platform_alerts platform_alerts_all_service_role :: POLICY
DROP POLICY IF EXISTS platform_alerts_all_service_role ON public.platform_alerts;
--

CREATE POLICY platform_alerts_all_service_role ON public.platform_alerts TO service_role USING (true) WITH CHECK (true);

--

-- platform_alerts platform_alerts_select_authenticated :: POLICY
DROP POLICY IF EXISTS platform_alerts_select_authenticated ON public.platform_alerts;
--

CREATE POLICY platform_alerts_select_authenticated ON public.platform_alerts FOR SELECT TO authenticated USING (true);

--

-- playback_jobs :: ROW SECURITY
--

ALTER TABLE public.playback_jobs ENABLE ROW LEVEL SECURITY;

--

-- playback_jobs playback_jobs_select_privileged :: POLICY
DROP POLICY IF EXISTS playback_jobs_select_privileged ON public.playback_jobs;
--

CREATE POLICY playback_jobs_select_privileged ON public.playback_jobs FOR SELECT TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text, 'Auditor'::text]));

--

-- playback_worker_status :: ROW SECURITY
--

ALTER TABLE public.playback_worker_status ENABLE ROW LEVEL SECURITY;

--

-- playback_worker_status playback_worker_status_select_privileged :: POLICY
DROP POLICY IF EXISTS playback_worker_status_select_privileged ON public.playback_worker_status;
--

CREATE POLICY playback_worker_status_select_privileged ON public.playback_worker_status FOR SELECT TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text, 'Auditor'::text]));

--

-- rebirth_requests :: ROW SECURITY
--

ALTER TABLE public.rebirth_requests ENABLE ROW LEVEL SECURITY;

--

-- rebirth_requests rebirth_requests_select_privileged :: POLICY
DROP POLICY IF EXISTS rebirth_requests_select_privileged ON public.rebirth_requests;
--

CREATE POLICY rebirth_requests_select_privileged ON public.rebirth_requests FOR SELECT TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text, 'Auditor'::text]));

--

-- role_permissions :: ROW SECURITY
--

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

--

-- role_permissions role_permissions_select_authenticated :: POLICY
DROP POLICY IF EXISTS role_permissions_select_authenticated ON public.role_permissions;
--

CREATE POLICY role_permissions_select_authenticated ON public.role_permissions FOR SELECT TO authenticated USING (true);

--

-- roles :: ROW SECURITY
--

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;

--

-- roles roles_select_authenticated :: POLICY
DROP POLICY IF EXISTS roles_select_authenticated ON public.roles;
--

CREATE POLICY roles_select_authenticated ON public.roles FOR SELECT TO authenticated USING (true);

--

-- schema_bootstrap :: ROW SECURITY
--

ALTER TABLE public.schema_bootstrap ENABLE ROW LEVEL SECURITY;

--

-- schemas :: ROW SECURITY
--

ALTER TABLE public.schemas ENABLE ROW LEVEL SECURITY;

--

-- schemas schemas_delete_privileged :: POLICY
DROP POLICY IF EXISTS schemas_delete_privileged ON public.schemas;
--

CREATE POLICY schemas_delete_privileged ON public.schemas FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text]));

--

-- schemas schemas_insert_privileged :: POLICY
DROP POLICY IF EXISTS schemas_insert_privileged ON public.schemas;
--

CREATE POLICY schemas_insert_privileged ON public.schemas FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text]));

--

-- schemas schemas_select_authenticated :: POLICY
DROP POLICY IF EXISTS schemas_select_authenticated ON public.schemas;
--

CREATE POLICY schemas_select_authenticated ON public.schemas FOR SELECT TO authenticated USING (true);

--

-- schemas schemas_update_privileged :: POLICY
DROP POLICY IF EXISTS schemas_update_privileged ON public.schemas;
--

CREATE POLICY schemas_update_privileged ON public.schemas FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text]));

--

-- system_settings :: ROW SECURITY
--

ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

--

-- system_settings system_settings_all_service_role :: POLICY
DROP POLICY IF EXISTS system_settings_all_service_role ON public.system_settings;
--

CREATE POLICY system_settings_all_service_role ON public.system_settings TO service_role USING (true) WITH CHECK (true);

--

-- system_settings system_settings_select_authenticated :: POLICY
DROP POLICY IF EXISTS system_settings_select_authenticated ON public.system_settings;
--

CREATE POLICY system_settings_select_authenticated ON public.system_settings FOR SELECT TO authenticated USING (true);

--

-- system_settings system_settings_update_admin :: POLICY
DROP POLICY IF EXISTS system_settings_update_admin ON public.system_settings;
--

CREATE POLICY system_settings_update_admin ON public.system_settings FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text]));

--

-- user_roles :: ROW SECURITY
--

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

--

-- user_roles user_roles_select_own_or_privileged :: POLICY
DROP POLICY IF EXISTS user_roles_select_own_or_privileged ON public.user_roles;
--

CREATE POLICY user_roles_select_own_or_privileged ON public.user_roles FOR SELECT TO authenticated USING (((user_id = (auth.uid())::text) OR public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])));

--

-- webhook_endpoints :: ROW SECURITY
--

ALTER TABLE public.webhook_endpoints ENABLE ROW LEVEL SECURITY;

--

-- webhook_endpoints webhook_endpoints_select_privileged :: POLICY
DROP POLICY IF EXISTS webhook_endpoints_select_privileged ON public.webhook_endpoints;
--

CREATE POLICY webhook_endpoints_select_privileged ON public.webhook_endpoints FOR SELECT TO authenticated USING (public.has_role(ARRAY['Administrator'::text]));

--

-- SCHEMA public :: ACL
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO grafana_reader';
  END IF;
END $g$;
--

-- SCHEMA timescale :: ACL
--

GRANT USAGE ON SCHEMA timescale TO authenticated;
GRANT USAGE ON SCHEMA timescale TO service_role;

--

-- FUNCTION active_schema_version(schema_id uuid) :: ACL
--

REVOKE ALL ON FUNCTION public.active_schema_version(schema_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.active_schema_version(schema_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.active_schema_version(schema_id uuid) TO authenticated;

--

-- FUNCTION approve_quarantined_device(p_device_id uuid, p_actor_id uuid, p_gateway_id uuid, p_merge_into_device_id uuid, p_asset_name text, p_cell_id uuid, p_location_scope text, p_set_cell boolean, p_set_location_scope boolean) :: ACL
--

REVOKE ALL ON FUNCTION public.approve_quarantined_device(p_device_id uuid, p_actor_id uuid, p_gateway_id uuid, p_merge_into_device_id uuid, p_asset_name text, p_cell_id uuid, p_location_scope text, p_set_cell boolean, p_set_location_scope boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.approve_quarantined_device(p_device_id uuid, p_actor_id uuid, p_gateway_id uuid, p_merge_into_device_id uuid, p_asset_name text, p_cell_id uuid, p_location_scope text, p_set_cell boolean, p_set_location_scope boolean) TO service_role;

--

-- FUNCTION audit_domain_for(p_entity_type text, p_action text) :: ACL
--

REVOKE ALL ON FUNCTION public.audit_domain_for(p_entity_type text, p_action text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.audit_domain_for(p_entity_type text, p_action text) TO service_role;

--

-- FUNCTION authorize_virtual_gateway_credential(p_gateway_id uuid) :: ACL
--

REVOKE ALL ON FUNCTION public.authorize_virtual_gateway_credential(p_gateway_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.authorize_virtual_gateway_credential(p_gateway_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.authorize_virtual_gateway_credential(p_gateway_id uuid) TO authenticated;

--

-- FUNCTION capped_capture_manifest(p_manifest jsonb) :: ACL
--

REVOKE ALL ON FUNCTION public.capped_capture_manifest(p_manifest jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.capped_capture_manifest(p_manifest jsonb) TO service_role;
GRANT ALL ON FUNCTION public.capped_capture_manifest(p_manifest jsonb) TO authenticated;

--

-- FUNCTION clear_credential_revoked_on_enrolment() :: ACL
--

REVOKE ALL ON FUNCTION public.clear_credential_revoked_on_enrolment() FROM PUBLIC;
GRANT ALL ON FUNCTION public.clear_credential_revoked_on_enrolment() TO service_role;

--

-- FUNCTION cold_storage_rows() :: ACL
--

REVOKE ALL ON FUNCTION public.cold_storage_rows() FROM PUBLIC;
GRANT ALL ON FUNCTION public.cold_storage_rows() TO service_role;
GRANT ALL ON FUNCTION public.cold_storage_rows() TO authenticated;

--

-- FUNCTION consume_gateway_enrollment_token(p_token text) :: ACL
--

REVOKE ALL ON FUNCTION public.consume_gateway_enrollment_token(p_token text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.consume_gateway_enrollment_token(p_token text) TO service_role;

--

-- FUNCTION create_service_principal(p_role_name text, p_note text) :: ACL
--

REVOKE ALL ON FUNCTION public.create_service_principal(p_role_name text, p_note text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_service_principal(p_role_name text, p_note text) TO service_role;
GRANT ALL ON FUNCTION public.create_service_principal(p_role_name text, p_note text) TO authenticated;

--

-- FUNCTION custom_access_token_hook(event jsonb) :: ACL
--

REVOKE ALL ON FUNCTION public.custom_access_token_hook(event jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.custom_access_token_hook(event jsonb) TO service_role;
GRANT ALL ON FUNCTION public.custom_access_token_hook(event jsonb) TO supabase_auth_admin;

--

-- FUNCTION digital_thread_page(p_limit integer, p_include_purged boolean, p_entity_type text, p_action text, p_entity_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone) :: ACL
--

REVOKE ALL ON FUNCTION public.digital_thread_page(p_limit integer, p_include_purged boolean, p_entity_type text, p_action text, p_entity_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.digital_thread_page(p_limit integer, p_include_purged boolean, p_entity_type text, p_action text, p_entity_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone) TO service_role;
GRANT ALL ON FUNCTION public.digital_thread_page(p_limit integer, p_include_purged boolean, p_entity_type text, p_action text, p_entity_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone) TO authenticated;

--

-- FUNCTION directory_liveness_job_map() :: ACL
--

REVOKE ALL ON FUNCTION public.directory_liveness_job_map() FROM PUBLIC;
GRANT ALL ON FUNCTION public.directory_liveness_job_map() TO service_role;

--

-- FUNCTION dispatch_device_quarantine_webhook() :: ACL
--

REVOKE ALL ON FUNCTION public.dispatch_device_quarantine_webhook() FROM PUBLIC;
GRANT ALL ON FUNCTION public.dispatch_device_quarantine_webhook() TO service_role;
GRANT ALL ON FUNCTION public.dispatch_device_quarantine_webhook() TO authenticated;

--

-- FUNCTION enforce_digital_thread_append_only() :: ACL
--

REVOKE ALL ON FUNCTION public.enforce_digital_thread_append_only() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enforce_digital_thread_append_only() TO service_role;

--

-- FUNCTION enforce_metric_catalog_immutability() :: ACL
--

REVOKE ALL ON FUNCTION public.enforce_metric_catalog_immutability() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enforce_metric_catalog_immutability() TO service_role;
GRANT ALL ON FUNCTION public.enforce_metric_catalog_immutability() TO authenticated;

--

-- FUNCTION enforce_metric_group_spelling() :: ACL
--

REVOKE ALL ON FUNCTION public.enforce_metric_group_spelling() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enforce_metric_group_spelling() TO service_role;
GRANT ALL ON FUNCTION public.enforce_metric_group_spelling() TO authenticated;

--

-- FUNCTION enforce_schema_version_provenance() :: ACL
--

REVOKE ALL ON FUNCTION public.enforce_schema_version_provenance() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enforce_schema_version_provenance() TO service_role;
GRANT ALL ON FUNCTION public.enforce_schema_version_provenance() TO authenticated;

--

-- FUNCTION ensure_cron_job(p_name text, p_schedule text, p_command text) :: ACL
--

REVOKE ALL ON FUNCTION public.ensure_cron_job(p_name text, p_schedule text, p_command text) FROM PUBLIC;

--

-- FUNCTION ensure_gateway_status_view() :: ACL
--

REVOKE ALL ON FUNCTION public.ensure_gateway_status_view() FROM PUBLIC;
GRANT ALL ON FUNCTION public.ensure_gateway_status_view() TO service_role;

--

-- FUNCTION ensure_shadow_devices(p_capture_id uuid) :: ACL
--

REVOKE ALL ON FUNCTION public.ensure_shadow_devices(p_capture_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ensure_shadow_devices(p_capture_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.ensure_shadow_devices(p_capture_id uuid) TO authenticated;

--

-- FUNCTION fork_schema(parent_schema_id uuid, change_description text) :: ACL
--

REVOKE ALL ON FUNCTION public.fork_schema(parent_schema_id uuid, change_description text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.fork_schema(parent_schema_id uuid, change_description text) TO service_role;
GRANT ALL ON FUNCTION public.fork_schema(parent_schema_id uuid, change_description text) TO authenticated;

--

-- TABLE gateways :: ACL
--

GRANT ALL ON TABLE public.gateways TO service_role;
GRANT ALL ON TABLE public.gateways TO authenticated;

--

-- FUNCTION gateway_has_broker_credential(g public.gateways) :: ACL
--

REVOKE ALL ON FUNCTION public.gateway_has_broker_credential(g public.gateways) FROM PUBLIC;
GRANT ALL ON FUNCTION public.gateway_has_broker_credential(g public.gateways) TO service_role;
GRANT ALL ON FUNCTION public.gateway_has_broker_credential(g public.gateways) TO authenticated;

--

-- FUNCTION gateway_health_rows() :: ACL
--

REVOKE ALL ON FUNCTION public.gateway_health_rows() FROM PUBLIC;
GRANT ALL ON FUNCTION public.gateway_health_rows() TO service_role;
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
    EXECUTE 'GRANT ALL ON FUNCTION public.gateway_health_rows() TO grafana_reader';
  END IF;
END $g$;
--

-- FUNCTION gateway_holds_a_credential(g public.gateways) :: ACL
--

REVOKE ALL ON FUNCTION public.gateway_holds_a_credential(g public.gateways) FROM PUBLIC;
GRANT ALL ON FUNCTION public.gateway_holds_a_credential(g public.gateways) TO service_role;

--

-- FUNCTION handle_new_user() :: ACL
--

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;
GRANT ALL ON FUNCTION public.handle_new_user() TO service_role;

--

-- FUNCTION has_role(allowed_roles text[]) :: ACL
--

REVOKE ALL ON FUNCTION public.has_role(allowed_roles text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.has_role(allowed_roles text[]) TO service_role;
GRANT ALL ON FUNCTION public.has_role(allowed_roles text[]) TO authenticated;

--

-- FUNCTION ingest_capture_progress(p_job_id uuid, p_messages bigint, p_bytes bigint, p_elapsed_seconds integer, p_birth_captured boolean) :: ACL
--

REVOKE ALL ON FUNCTION public.ingest_capture_progress(p_job_id uuid, p_messages bigint, p_bytes bigint, p_elapsed_seconds integer, p_birth_captured boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_capture_progress(p_job_id uuid, p_messages bigint, p_bytes bigint, p_elapsed_seconds integer, p_birth_captured boolean) TO service_role;
GRANT ALL ON FUNCTION public.ingest_capture_progress(p_job_id uuid, p_messages bigint, p_bytes bigint, p_elapsed_seconds integer, p_birth_captured boolean) TO authenticated;

--

-- FUNCTION ingest_claim_capture_job() :: ACL
--

REVOKE ALL ON FUNCTION public.ingest_claim_capture_job() FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_claim_capture_job() TO service_role;
GRANT ALL ON FUNCTION public.ingest_claim_capture_job() TO authenticated;

--

-- FUNCTION ingest_claim_rebirth_requests() :: ACL
--

REVOKE ALL ON FUNCTION public.ingest_claim_rebirth_requests() FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_claim_rebirth_requests() TO service_role;
GRANT ALL ON FUNCTION public.ingest_claim_rebirth_requests() TO authenticated;

--

-- FUNCTION ingest_fail_capture(p_job_id uuid, p_error text) :: ACL
--

REVOKE ALL ON FUNCTION public.ingest_fail_capture(p_job_id uuid, p_error text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_fail_capture(p_job_id uuid, p_error text) TO service_role;
GRANT ALL ON FUNCTION public.ingest_fail_capture(p_job_id uuid, p_error text) TO authenticated;

--

-- FUNCTION ingest_finalise_capture(p_job_id uuid, p_size_bytes bigint, p_message_count integer, p_manifest jsonb) :: ACL
--

REVOKE ALL ON FUNCTION public.ingest_finalise_capture(p_job_id uuid, p_size_bytes bigint, p_message_count integer, p_manifest jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_finalise_capture(p_job_id uuid, p_size_bytes bigint, p_message_count integer, p_manifest jsonb) TO service_role;
GRANT ALL ON FUNCTION public.ingest_finalise_capture(p_job_id uuid, p_size_bytes bigint, p_message_count integer, p_manifest jsonb) TO authenticated;

--

-- FUNCTION ingest_mark_device_offline(p_device_id uuid) :: ACL
--

REVOKE ALL ON FUNCTION public.ingest_mark_device_offline(p_device_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_mark_device_offline(p_device_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.ingest_mark_device_offline(p_device_id uuid) TO authenticated;

--

-- FUNCTION ingest_reconcile_capture_jobs() :: ACL
--

REVOKE ALL ON FUNCTION public.ingest_reconcile_capture_jobs() FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_reconcile_capture_jobs() TO service_role;
GRANT ALL ON FUNCTION public.ingest_reconcile_capture_jobs() TO authenticated;

--

-- FUNCTION ingest_record_declared_metrics(p_device_id uuid, p_metrics text[], p_observed_at timestamp with time zone) :: ACL
--

REVOKE ALL ON FUNCTION public.ingest_record_declared_metrics(p_device_id uuid, p_metrics text[], p_observed_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_record_declared_metrics(p_device_id uuid, p_metrics text[], p_observed_at timestamp with time zone) TO service_role;
GRANT ALL ON FUNCTION public.ingest_record_declared_metrics(p_device_id uuid, p_metrics text[], p_observed_at timestamp with time zone) TO authenticated;

--

-- FUNCTION ingest_record_gateway_health(p_gateway_id uuid, p_status text, p_heartbeat_at timestamp with time zone, p_health jsonb) :: ACL
--

REVOKE ALL ON FUNCTION public.ingest_record_gateway_health(p_gateway_id uuid, p_status text, p_heartbeat_at timestamp with time zone, p_health jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_record_gateway_health(p_gateway_id uuid, p_status text, p_heartbeat_at timestamp with time zone, p_health jsonb) TO service_role;
GRANT ALL ON FUNCTION public.ingest_record_gateway_health(p_gateway_id uuid, p_status text, p_heartbeat_at timestamp with time zone, p_health jsonb) TO authenticated;

--

-- FUNCTION ingest_record_rebirth_outcome(p_id uuid, p_throttled boolean, p_error text) :: ACL
--

REVOKE ALL ON FUNCTION public.ingest_record_rebirth_outcome(p_id uuid, p_throttled boolean, p_error text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_record_rebirth_outcome(p_id uuid, p_throttled boolean, p_error text) TO service_role;
GRANT ALL ON FUNCTION public.ingest_record_rebirth_outcome(p_id uuid, p_throttled boolean, p_error text) TO authenticated;

--

-- FUNCTION ingest_register_quarantined_device(p_name text, p_gateway_id uuid, p_reported_identity text, p_quarantine_reason text, p_identity_source text, p_declared_metrics text[], p_observed_at timestamp with time zone) :: ACL
--

REVOKE ALL ON FUNCTION public.ingest_register_quarantined_device(p_name text, p_gateway_id uuid, p_reported_identity text, p_quarantine_reason text, p_identity_source text, p_declared_metrics text[], p_observed_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_register_quarantined_device(p_name text, p_gateway_id uuid, p_reported_identity text, p_quarantine_reason text, p_identity_source text, p_declared_metrics text[], p_observed_at timestamp with time zone) TO service_role;
GRANT ALL ON FUNCTION public.ingest_register_quarantined_device(p_name text, p_gateway_id uuid, p_reported_identity text, p_quarantine_reason text, p_identity_source text, p_declared_metrics text[], p_observed_at timestamp with time zone) TO authenticated;

--

-- FUNCTION ingest_requarantine_device(p_device_id uuid, p_quarantine_reason text, p_reported_identity text) :: ACL
--

REVOKE ALL ON FUNCTION public.ingest_requarantine_device(p_device_id uuid, p_quarantine_reason text, p_reported_identity text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_requarantine_device(p_device_id uuid, p_quarantine_reason text, p_reported_identity text) TO service_role;
GRANT ALL ON FUNCTION public.ingest_requarantine_device(p_device_id uuid, p_quarantine_reason text, p_reported_identity text) TO authenticated;

--

-- FUNCTION ingest_set_device_state(p_device_id uuid, p_status text, p_identity_source text, p_first_dbirth_at timestamp with time zone) :: ACL
--

REVOKE ALL ON FUNCTION public.ingest_set_device_state(p_device_id uuid, p_status text, p_identity_source text, p_first_dbirth_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_set_device_state(p_device_id uuid, p_status text, p_identity_source text, p_first_dbirth_at timestamp with time zone) TO service_role;
GRANT ALL ON FUNCTION public.ingest_set_device_state(p_device_id uuid, p_status text, p_identity_source text, p_first_dbirth_at timestamp with time zone) TO authenticated;

--

-- FUNCTION ingest_store_birth_parameters(p_asset_id text, p_rows jsonb, p_observed_at timestamp with time zone) :: ACL
--

REVOKE ALL ON FUNCTION public.ingest_store_birth_parameters(p_asset_id text, p_rows jsonb, p_observed_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_store_birth_parameters(p_asset_id text, p_rows jsonb, p_observed_at timestamp with time zone) TO service_role;
GRANT ALL ON FUNCTION public.ingest_store_birth_parameters(p_asset_id text, p_rows jsonb, p_observed_at timestamp with time zone) TO authenticated;

--

-- FUNCTION is_active_capture_object(p_name text) :: ACL
--

REVOKE ALL ON FUNCTION public.is_active_capture_object(p_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_active_capture_object(p_name text) TO service_role;
GRANT ALL ON FUNCTION public.is_active_capture_object(p_name text) TO authenticated;

--

-- FUNCTION is_active_playback_capture(p_name text) :: ACL
--

REVOKE ALL ON FUNCTION public.is_active_playback_capture(p_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_active_playback_capture(p_name text) TO service_role;
GRANT ALL ON FUNCTION public.is_active_playback_capture(p_name text) TO authenticated;

--

-- FUNCTION is_capture_subject_prefix(p_folder text) :: ACL
--

REVOKE ALL ON FUNCTION public.is_capture_subject_prefix(p_folder text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_capture_subject_prefix(p_folder text) TO service_role;
GRANT ALL ON FUNCTION public.is_capture_subject_prefix(p_folder text) TO authenticated;

--

-- FUNCTION is_ingestion_caller() :: ACL
--

REVOKE ALL ON FUNCTION public.is_ingestion_caller() FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_ingestion_caller() TO service_role;
GRANT ALL ON FUNCTION public.is_ingestion_caller() TO authenticated;

--

-- FUNCTION is_machine_principal(p_user_id uuid) :: ACL
--

REVOKE ALL ON FUNCTION public.is_machine_principal(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_machine_principal(p_user_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.is_machine_principal(p_user_id uuid) TO authenticated;

--

-- FUNCTION is_playback_caller() :: ACL
--

REVOKE ALL ON FUNCTION public.is_playback_caller() FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_playback_caller() TO service_role;
GRANT ALL ON FUNCTION public.is_playback_caller() TO authenticated;

--

-- FUNCTION is_valid_quarantine_reason(p_reason text) :: ACL
--

REVOKE ALL ON FUNCTION public.is_valid_quarantine_reason(p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_valid_quarantine_reason(p_reason text) TO service_role;
GRANT ALL ON FUNCTION public.is_valid_quarantine_reason(p_reason text) TO authenticated;

--

-- FUNCTION issue_gateway_enrollment_token(p_gateway_id uuid, p_ttl_minutes integer) :: ACL
--

REVOKE ALL ON FUNCTION public.issue_gateway_enrollment_token(p_gateway_id uuid, p_ttl_minutes integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.issue_gateway_enrollment_token(p_gateway_id uuid, p_ttl_minutes integer) TO service_role;
GRANT ALL ON FUNCTION public.issue_gateway_enrollment_token(p_gateway_id uuid, p_ttl_minutes integer) TO authenticated;

--

-- FUNCTION list_service_principals() :: ACL
--

REVOKE ALL ON FUNCTION public.list_service_principals() FROM PUBLIC;
GRANT ALL ON FUNCTION public.list_service_principals() TO service_role;
GRANT ALL ON FUNCTION public.list_service_principals() TO authenticated;

--

-- FUNCTION log_digital_thread_event() :: ACL
--

REVOKE ALL ON FUNCTION public.log_digital_thread_event() FROM PUBLIC;
GRANT ALL ON FUNCTION public.log_digital_thread_event() TO service_role;

--

-- FUNCTION log_role_assignment() :: ACL
--

REVOKE ALL ON FUNCTION public.log_role_assignment() FROM PUBLIC;
GRANT ALL ON FUNCTION public.log_role_assignment() TO service_role;

--

-- FUNCTION may_manage_captures() :: ACL
--

REVOKE ALL ON FUNCTION public.may_manage_captures() FROM PUBLIC;
GRANT ALL ON FUNCTION public.may_manage_captures() TO service_role;
GRANT ALL ON FUNCTION public.may_manage_captures() TO authenticated;

--

-- FUNCTION platform_health_rows() :: ACL
--

REVOKE ALL ON FUNCTION public.platform_health_rows() FROM PUBLIC;
GRANT ALL ON FUNCTION public.platform_health_rows() TO service_role;
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
    EXECUTE 'GRANT ALL ON FUNCTION public.platform_health_rows() TO grafana_reader';
  END IF;
END $g$;
--

-- FUNCTION platform_storage_rows() :: ACL
--

REVOKE ALL ON FUNCTION public.platform_storage_rows() FROM PUBLIC;
GRANT ALL ON FUNCTION public.platform_storage_rows() TO service_role;
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
    EXECUTE 'GRANT ALL ON FUNCTION public.platform_storage_rows() TO grafana_reader';
  END IF;
END $g$;
--

-- FUNCTION playback_claim_job() :: ACL
--

REVOKE ALL ON FUNCTION public.playback_claim_job() FROM PUBLIC;
GRANT ALL ON FUNCTION public.playback_claim_job() TO service_role;
GRANT ALL ON FUNCTION public.playback_claim_job() TO authenticated;

--

-- FUNCTION playback_finish(p_job_id uuid, p_messages_sent integer, p_error text) :: ACL
--

REVOKE ALL ON FUNCTION public.playback_finish(p_job_id uuid, p_messages_sent integer, p_error text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.playback_finish(p_job_id uuid, p_messages_sent integer, p_error text) TO service_role;
GRANT ALL ON FUNCTION public.playback_finish(p_job_id uuid, p_messages_sent integer, p_error text) TO authenticated;

--

-- FUNCTION playback_progress(p_job_id uuid, p_messages_sent integer, p_messages_total integer, p_elapsed_seconds integer) :: ACL
--

REVOKE ALL ON FUNCTION public.playback_progress(p_job_id uuid, p_messages_sent integer, p_messages_total integer, p_elapsed_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.playback_progress(p_job_id uuid, p_messages_sent integer, p_messages_total integer, p_elapsed_seconds integer) TO service_role;
GRANT ALL ON FUNCTION public.playback_progress(p_job_id uuid, p_messages_sent integer, p_messages_total integer, p_elapsed_seconds integer) TO authenticated;

--

-- FUNCTION playback_reconcile_jobs() :: ACL
--

REVOKE ALL ON FUNCTION public.playback_reconcile_jobs() FROM PUBLIC;
GRANT ALL ON FUNCTION public.playback_reconcile_jobs() TO service_role;
GRANT ALL ON FUNCTION public.playback_reconcile_jobs() TO authenticated;

--

-- FUNCTION playback_report_credentials(p_edge_nodes text[]) :: ACL
--

REVOKE ALL ON FUNCTION public.playback_report_credentials(p_edge_nodes text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.playback_report_credentials(p_edge_nodes text[]) TO service_role;
GRANT ALL ON FUNCTION public.playback_report_credentials(p_edge_nodes text[]) TO authenticated;

--

-- FUNCTION playback_target_must_be_shadow() :: ACL
--

REVOKE ALL ON FUNCTION public.playback_target_must_be_shadow() FROM PUBLIC;
GRANT ALL ON FUNCTION public.playback_target_must_be_shadow() TO service_role;

--

-- FUNCTION prevent_active_schema_mutation() :: ACL
--

REVOKE ALL ON FUNCTION public.prevent_active_schema_mutation() FROM PUBLIC;
GRANT ALL ON FUNCTION public.prevent_active_schema_mutation() TO service_role;
GRANT ALL ON FUNCTION public.prevent_active_schema_mutation() TO authenticated;

--

-- FUNCTION prune_platform_alerts(p_retain interval) :: ACL
--

REVOKE ALL ON FUNCTION public.prune_platform_alerts(p_retain interval) FROM PUBLIC;

--

-- FUNCTION publish_schema_version(draft_schema_id uuid) :: ACL
--

REVOKE ALL ON FUNCTION public.publish_schema_version(draft_schema_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.publish_schema_version(draft_schema_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.publish_schema_version(draft_schema_id uuid) TO authenticated;

--

-- FUNCTION record_gateway_credential_issued(p_gateway_id uuid) :: ACL
--

REVOKE ALL ON FUNCTION public.record_gateway_credential_issued(p_gateway_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_gateway_credential_issued(p_gateway_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.record_gateway_credential_issued(p_gateway_id uuid) TO authenticated;

--

-- FUNCTION record_gateway_credential_issued_by_service(p_gateway_id uuid, p_context jsonb) :: ACL
--

REVOKE ALL ON FUNCTION public.record_gateway_credential_issued_by_service(p_gateway_id uuid, p_context jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_gateway_credential_issued_by_service(p_gateway_id uuid, p_context jsonb) TO service_role;

--

-- FUNCTION record_ingestion_rejection(p_device_id uuid, p_violations jsonb, p_observed_at timestamp with time zone) :: ACL
--

REVOKE ALL ON FUNCTION public.record_ingestion_rejection(p_device_id uuid, p_violations jsonb, p_observed_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_ingestion_rejection(p_device_id uuid, p_violations jsonb, p_observed_at timestamp with time zone) TO service_role;
GRANT ALL ON FUNCTION public.record_ingestion_rejection(p_device_id uuid, p_violations jsonb, p_observed_at timestamp with time zone) TO authenticated;

--

-- FUNCTION record_service_token_issued(p_principal_id uuid, p_jti text, p_expires_at timestamp with time zone, p_context jsonb) :: ACL
--

REVOKE ALL ON FUNCTION public.record_service_token_issued(p_principal_id uuid, p_jti text, p_expires_at timestamp with time zone, p_context jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_service_token_issued(p_principal_id uuid, p_jti text, p_expires_at timestamp with time zone, p_context jsonb) TO service_role;

--

-- FUNCTION refresh_directory_liveness() :: ACL
--

REVOKE ALL ON FUNCTION public.refresh_directory_liveness() FROM PUBLIC;
GRANT ALL ON FUNCTION public.refresh_directory_liveness() TO service_role;

--

-- FUNCTION refuse_archiving_the_last_shadow_gateway() :: ACL
--

REVOKE ALL ON FUNCTION public.refuse_archiving_the_last_shadow_gateway() FROM PUBLIC;
GRANT ALL ON FUNCTION public.refuse_archiving_the_last_shadow_gateway() TO service_role;

--

-- FUNCTION register_uploaded_capture(p_subject_kind text, p_subject_id uuid, p_storage_path text, p_size_bytes bigint, p_message_count integer, p_manifest jsonb, p_note text, p_replace boolean) :: ACL
--

REVOKE ALL ON FUNCTION public.register_uploaded_capture(p_subject_kind text, p_subject_id uuid, p_storage_path text, p_size_bytes bigint, p_message_count integer, p_manifest jsonb, p_note text, p_replace boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.register_uploaded_capture(p_subject_kind text, p_subject_id uuid, p_storage_path text, p_size_bytes bigint, p_message_count integer, p_manifest jsonb, p_note text, p_replace boolean) TO service_role;
GRANT ALL ON FUNCTION public.register_uploaded_capture(p_subject_kind text, p_subject_id uuid, p_storage_path text, p_size_bytes bigint, p_message_count integer, p_manifest jsonb, p_note text, p_replace boolean) TO authenticated;

--

-- FUNCTION release_gateway_enrollment_token(p_token text) :: ACL
--

REVOKE ALL ON FUNCTION public.release_gateway_enrollment_token(p_token text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.release_gateway_enrollment_token(p_token text) TO service_role;

--

-- FUNCTION relocate_devices(p_moves jsonb) :: ACL
--

REVOKE ALL ON FUNCTION public.relocate_devices(p_moves jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.relocate_devices(p_moves jsonb) TO service_role;
GRANT ALL ON FUNCTION public.relocate_devices(p_moves jsonb) TO authenticated;

--

-- FUNCTION request_capture_stop(p_job_id uuid) :: ACL
--

REVOKE ALL ON FUNCTION public.request_capture_stop(p_job_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.request_capture_stop(p_job_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.request_capture_stop(p_job_id uuid) TO authenticated;

--

-- FUNCTION request_gateway_rebirth(p_gateway_id uuid) :: ACL
--

REVOKE ALL ON FUNCTION public.request_gateway_rebirth(p_gateway_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.request_gateway_rebirth(p_gateway_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.request_gateway_rebirth(p_gateway_id uuid) TO authenticated;

--

-- FUNCTION request_playback_stop(p_job_id uuid) :: ACL
--

REVOKE ALL ON FUNCTION public.request_playback_stop(p_job_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.request_playback_stop(p_job_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.request_playback_stop(p_job_id uuid) TO authenticated;

--

-- FUNCTION require_ingestion_caller(p_fn text) :: ACL
--

REVOKE ALL ON FUNCTION public.require_ingestion_caller(p_fn text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.require_ingestion_caller(p_fn text) TO service_role;
GRANT ALL ON FUNCTION public.require_ingestion_caller(p_fn text) TO authenticated;

--

-- FUNCTION require_playback_caller(p_fn text) :: ACL
--

REVOKE ALL ON FUNCTION public.require_playback_caller(p_fn text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.require_playback_caller(p_fn text) TO service_role;
GRANT ALL ON FUNCTION public.require_playback_caller(p_fn text) TO authenticated;

--

-- FUNCTION revoke_anon_function_privileges() :: ACL
--

REVOKE ALL ON FUNCTION public.revoke_anon_function_privileges() FROM PUBLIC;

--

-- FUNCTION revoke_credential_on_decommission() :: ACL
--

REVOKE ALL ON FUNCTION public.revoke_credential_on_decommission() FROM PUBLIC;
GRANT ALL ON FUNCTION public.revoke_credential_on_decommission() TO service_role;

--

-- FUNCTION revoke_gateway_credential(p_sparkplug_id text) :: ACL
--

REVOKE ALL ON FUNCTION public.revoke_gateway_credential(p_sparkplug_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.revoke_gateway_credential(p_sparkplug_id text) TO service_role;

--

-- FUNCTION schema_version_base_name(schema_name text) :: ACL
--

REVOKE ALL ON FUNCTION public.schema_version_base_name(schema_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.schema_version_base_name(schema_name text) TO service_role;
GRANT ALL ON FUNCTION public.schema_version_base_name(schema_name text) TO authenticated;

--

-- FUNCTION seed_setting(p_key text, p_value jsonb, p_value_type text, p_category text, p_label text, p_description text, p_fallback_source text) :: ACL
--

REVOKE ALL ON FUNCTION public.seed_setting(p_key text, p_value jsonb, p_value_type text, p_category text, p_label text, p_description text, p_fallback_source text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.seed_setting(p_key text, p_value jsonb, p_value_type text, p_category text, p_label text, p_description text, p_fallback_source text) TO service_role;

--

-- FUNCTION service_token_max_days() :: ACL
--

REVOKE ALL ON FUNCTION public.service_token_max_days() FROM PUBLIC;
GRANT ALL ON FUNCTION public.service_token_max_days() TO service_role;
GRANT ALL ON FUNCTION public.service_token_max_days() TO authenticated;

--

-- FUNCTION stamp_audit_domain() :: ACL
--

REVOKE ALL ON FUNCTION public.stamp_audit_domain() FROM PUBLIC;
GRANT ALL ON FUNCTION public.stamp_audit_domain() TO service_role;

--

-- FUNCTION start_capture_job(p_subject_kind text, p_subject_id uuid, p_note text, p_max_seconds integer, p_replace boolean) :: ACL
--

REVOKE ALL ON FUNCTION public.start_capture_job(p_subject_kind text, p_subject_id uuid, p_note text, p_max_seconds integer, p_replace boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.start_capture_job(p_subject_kind text, p_subject_id uuid, p_note text, p_max_seconds integer, p_replace boolean) TO service_role;
GRANT ALL ON FUNCTION public.start_capture_job(p_subject_kind text, p_subject_id uuid, p_note text, p_max_seconds integer, p_replace boolean) TO authenticated;

--

-- FUNCTION start_playback_job(p_capture_id uuid, p_target_gateway_id uuid, p_device_map jsonb, p_speed numeric) :: ACL
--

REVOKE ALL ON FUNCTION public.start_playback_job(p_capture_id uuid, p_target_gateway_id uuid, p_device_map jsonb, p_speed numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.start_playback_job(p_capture_id uuid, p_target_gateway_id uuid, p_device_map jsonb, p_speed numeric) TO service_role;
GRANT ALL ON FUNCTION public.start_playback_job(p_capture_id uuid, p_target_gateway_id uuid, p_device_map jsonb, p_speed numeric) TO authenticated;

--

-- FUNCTION sweep_gateway_credential_revocations() :: ACL
--

REVOKE ALL ON FUNCTION public.sweep_gateway_credential_revocations() FROM PUBLIC;
GRANT ALL ON FUNCTION public.sweep_gateway_credential_revocations() TO service_role;

--

-- FUNCTION sync_gateway_deployment() :: ACL
--

REVOKE ALL ON FUNCTION public.sync_gateway_deployment() FROM PUBLIC;
GRANT ALL ON FUNCTION public.sync_gateway_deployment() TO service_role;

--

-- FUNCTION system_settings_stamp() :: ACL
--

REVOKE ALL ON FUNCTION public.system_settings_stamp() FROM PUBLIC;
GRANT ALL ON FUNCTION public.system_settings_stamp() TO service_role;

--

-- FUNCTION withdraw_gateway_enrollment_tokens() :: ACL
--

REVOKE ALL ON FUNCTION public.withdraw_gateway_enrollment_tokens() FROM PUBLIC;
GRANT ALL ON FUNCTION public.withdraw_gateway_enrollment_tokens() TO service_role;

--

-- TABLE ashrae223_vocabulary :: ACL
--

GRANT ALL ON TABLE public.ashrae223_vocabulary TO service_role;
GRANT SELECT ON TABLE public.ashrae223_vocabulary TO authenticated;

--

-- TABLE asset_config :: ACL
--

GRANT ALL ON TABLE public.asset_config TO service_role;
GRANT ALL ON TABLE public.asset_config TO authenticated;

--

-- TABLE capture_jobs :: ACL
--

GRANT ALL ON TABLE public.capture_jobs TO service_role;
GRANT SELECT ON TABLE public.capture_jobs TO authenticated;

--

-- TABLE captures :: ACL
--

GRANT ALL ON TABLE public.captures TO service_role;
GRANT SELECT,DELETE ON TABLE public.captures TO authenticated;

--

-- TABLE cells :: ACL
--

GRANT ALL ON TABLE public.cells TO service_role;
GRANT ALL ON TABLE public.cells TO authenticated;

--

-- TABLE devices :: ACL
--

GRANT ALL ON TABLE public.devices TO service_role;
GRANT ALL ON TABLE public.devices TO authenticated;

--

-- TABLE device_locations :: ACL
--

GRANT ALL ON TABLE public.device_locations TO service_role;
GRANT SELECT ON TABLE public.device_locations TO authenticated;

--

-- TABLE device_nameplate :: ACL
--

GRANT ALL ON TABLE public.device_nameplate TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.device_nameplate TO authenticated;

--

-- TABLE device_submodels :: ACL
--

GRANT ALL ON TABLE public.device_submodels TO service_role;
GRANT ALL ON TABLE public.device_submodels TO authenticated;

--

-- TABLE device_schemas :: ACL
--

GRANT ALL ON TABLE public.device_schemas TO service_role;
GRANT ALL ON TABLE public.device_schemas TO authenticated;

--

-- TABLE digital_thread :: ACL
--

GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE public.digital_thread TO service_role;
GRANT SELECT ON TABLE public.digital_thread TO authenticated;

--

-- TABLE directory_liveness_probe :: ACL
--

GRANT ALL ON TABLE public.directory_liveness_probe TO service_role;

--

-- TABLE directory_services :: ACL
--

GRANT ALL ON TABLE public.directory_services TO service_role;
GRANT ALL ON TABLE public.directory_services TO authenticated;

--

-- TABLE gateway_enrollment_tokens :: ACL
--

GRANT ALL ON TABLE public.gateway_enrollment_tokens TO service_role;

--

-- TABLE gateway_health :: ACL
--

GRANT ALL ON TABLE public.gateway_health TO service_role;
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
    EXECUTE 'GRANT SELECT ON TABLE public.gateway_health TO grafana_reader';
  END IF;
END $g$;
--

-- TABLE gateway_status :: ACL
--

GRANT ALL ON TABLE public.gateway_status TO service_role;
GRANT SELECT ON TABLE public.gateway_status TO authenticated;

--

-- TABLE idta_submodel_templates :: ACL
--

GRANT ALL ON TABLE public.idta_submodel_templates TO service_role;
GRANT SELECT ON TABLE public.idta_submodel_templates TO authenticated;

--

-- TABLE iso22400_vocabulary :: ACL
--

GRANT ALL ON TABLE public.iso22400_vocabulary TO service_role;
GRANT SELECT ON TABLE public.iso22400_vocabulary TO authenticated;

--

-- TABLE links :: ACL
--

GRANT ALL ON TABLE public.links TO service_role;
GRANT ALL ON TABLE public.links TO authenticated;

--

-- TABLE metric_catalog :: ACL
--

GRANT ALL ON TABLE public.metric_catalog TO service_role;
GRANT ALL ON TABLE public.metric_catalog TO authenticated;

--

-- TABLE metric_groups :: ACL
--

GRANT ALL ON TABLE public.metric_groups TO service_role;
GRANT ALL ON TABLE public.metric_groups TO authenticated;

--

-- TABLE mtconnect_vocabulary :: ACL
--

GRANT ALL ON TABLE public.mtconnect_vocabulary TO service_role;
GRANT SELECT ON TABLE public.mtconnect_vocabulary TO authenticated;

--

-- TABLE one_shot_migrations :: ACL
--

GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE public.one_shot_migrations TO service_role;

--

-- TABLE opcua_vocabulary :: ACL
--

GRANT ALL ON TABLE public.opcua_vocabulary TO service_role;
GRANT SELECT ON TABLE public.opcua_vocabulary TO authenticated;

--

-- TABLE permissions :: ACL
--

GRANT ALL ON TABLE public.permissions TO service_role;
GRANT ALL ON TABLE public.permissions TO authenticated;

--

-- TABLE platform_alerts :: ACL
--

GRANT ALL ON TABLE public.platform_alerts TO service_role;
GRANT SELECT ON TABLE public.platform_alerts TO authenticated;

--

-- TABLE platform_alerts_active :: ACL
--

GRANT ALL ON TABLE public.platform_alerts_active TO service_role;
GRANT SELECT ON TABLE public.platform_alerts_active TO authenticated;

--

-- TABLE platform_health :: ACL
--

GRANT ALL ON TABLE public.platform_health TO service_role;
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
    EXECUTE 'GRANT SELECT ON TABLE public.platform_health TO grafana_reader';
  END IF;
END $g$;
--

-- TABLE playback_jobs :: ACL
--

GRANT ALL ON TABLE public.playback_jobs TO service_role;
GRANT SELECT ON TABLE public.playback_jobs TO authenticated;

--

-- TABLE playback_worker_status :: ACL
--

GRANT ALL ON TABLE public.playback_worker_status TO service_role;
GRANT SELECT ON TABLE public.playback_worker_status TO authenticated;

--

-- TABLE rebirth_requests :: ACL
--

GRANT ALL ON TABLE public.rebirth_requests TO service_role;
GRANT SELECT ON TABLE public.rebirth_requests TO authenticated;

--

-- TABLE role_permissions :: ACL
--

GRANT ALL ON TABLE public.role_permissions TO service_role;
GRANT ALL ON TABLE public.role_permissions TO authenticated;

--

-- TABLE roles :: ACL
--

GRANT ALL ON TABLE public.roles TO service_role;
GRANT ALL ON TABLE public.roles TO authenticated;

--

-- SEQUENCE roles_id_seq :: ACL
--

GRANT ALL ON SEQUENCE public.roles_id_seq TO service_role;
GRANT ALL ON SEQUENCE public.roles_id_seq TO anon;
GRANT ALL ON SEQUENCE public.roles_id_seq TO authenticated;

--

-- TABLE schema_bootstrap :: ACL
--

GRANT ALL ON TABLE public.schema_bootstrap TO service_role;

--

-- TABLE schemas :: ACL
--

GRANT ALL ON TABLE public.schemas TO service_role;
GRANT ALL ON TABLE public.schemas TO authenticated;

--

-- TABLE storage_footprint :: ACL
--

GRANT ALL ON TABLE public.storage_footprint TO service_role;
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
    EXECUTE 'GRANT SELECT ON TABLE public.storage_footprint TO grafana_reader';
  END IF;
END $g$;
--

-- TABLE system_settings :: ACL
--

GRANT ALL ON TABLE public.system_settings TO service_role;
GRANT SELECT ON TABLE public.system_settings TO authenticated;

--

-- COLUMN system_settings.value :: ACL
--

GRANT UPDATE(value) ON TABLE public.system_settings TO authenticated;

--

-- TABLE telemetry :: ACL
--

GRANT SELECT ON TABLE timescale.telemetry TO authenticated;
GRANT SELECT ON TABLE timescale.telemetry TO service_role;

--

-- TABLE telemetry :: ACL
--

GRANT ALL ON TABLE public.telemetry TO service_role;
GRANT ALL ON TABLE public.telemetry TO authenticated;

--

-- TABLE telemetry_1h :: ACL
--

GRANT SELECT ON TABLE timescale.telemetry_1h TO authenticated;
GRANT SELECT ON TABLE timescale.telemetry_1h TO service_role;

--

-- TABLE telemetry_1h :: ACL
--

GRANT ALL ON TABLE public.telemetry_1h TO service_role;
GRANT SELECT ON TABLE public.telemetry_1h TO authenticated;

--

-- TABLE telemetry_1m :: ACL
--

GRANT SELECT ON TABLE timescale.telemetry_1m TO authenticated;
GRANT SELECT ON TABLE timescale.telemetry_1m TO service_role;

--

-- TABLE telemetry_1m :: ACL
--

GRANT ALL ON TABLE public.telemetry_1m TO service_role;
GRANT SELECT ON TABLE public.telemetry_1m TO authenticated;

--

-- TABLE telemetry_5m :: ACL
--

GRANT SELECT ON TABLE timescale.telemetry_5m TO authenticated;
GRANT SELECT ON TABLE timescale.telemetry_5m TO service_role;

--

-- TABLE telemetry_5m :: ACL
--

GRANT ALL ON TABLE public.telemetry_5m TO service_role;
GRANT SELECT ON TABLE public.telemetry_5m TO authenticated;

--

-- TABLE telemetry_latest :: ACL
--

GRANT SELECT ON TABLE timescale.telemetry_latest TO authenticated;
GRANT SELECT ON TABLE timescale.telemetry_latest TO service_role;

--

-- TABLE telemetry_latest :: ACL
--

GRANT ALL ON TABLE public.telemetry_latest TO service_role;
GRANT SELECT ON TABLE public.telemetry_latest TO authenticated;

--

-- TABLE user_roles :: ACL
--

GRANT ALL ON TABLE public.user_roles TO service_role;
GRANT ALL ON TABLE public.user_roles TO authenticated;

--

-- TABLE webhook_endpoints :: ACL
--

GRANT ALL ON TABLE public.webhook_endpoints TO service_role;
GRANT ALL ON TABLE public.webhook_endpoints TO authenticated;

--

-- DEFAULT PRIVILEGES FOR SEQUENCES :: DEFAULT ACL
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;

--

-- DEFAULT PRIVILEGES FOR SEQUENCES :: DEFAULT ACL
--

--

-- DEFAULT PRIVILEGES FOR FUNCTIONS :: DEFAULT ACL
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;

--

-- DEFAULT PRIVILEGES FOR FUNCTIONS :: DEFAULT ACL
--

--

-- DEFAULT PRIVILEGES FOR TABLES :: DEFAULT ACL
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;

--

-- DEFAULT PRIVILEGES FOR TABLES :: DEFAULT ACL
--

--
-- PostgreSQL database dump complete
--

-- ---------------------------------------------------------------------------------------------
-- 5. Realtime publication
-- ---------------------------------------------------------------------------------------------
-- `telemetry` is absent: it is a postgres_fdw foreign table whose rows enter TimescaleDB's WAL,
-- and adding it would silently emit nothing. REPLICA IDENTITY FULL is required: Realtime
-- evaluates RLS against the old row too.
--
-- `digital_thread` is absent because an unauthenticated subscriber still receives the change
-- envelope (payload redacted, 401 attached), so the fact and timing of an audit write would leak
-- to anyone who can reach the socket, and nothing subscribes to it. A publication governs
-- logical replication only; grants and RLS on the table are untouched. Asset-edit timing still
-- leaks through the three published tables, accepted because the dashboard needs them live.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime WITH (publish = 'insert, update, delete');
  END IF;
END $$;

-- SET TABLE is absolute, not additive: it replaces the publication's whole membership, which is
-- what lets a narrowing reach an existing database on the next replay.
--
-- The membership is computed: `platform_alerts` is created by a later file, so a literal list
-- naming it fails on a fresh database, and a list omitting it would drop it from the
-- publication on every replay. The intended set is declared here and intersected with the
-- tables that exist. Adding a table to realtime means adding its name here as well as
-- publishing it where it is created.
DO $$
DECLARE
  -- Every table this platform intends to publish, in one place. Order is not significant.
  -- `areas` and `area_floors` are the Site Map's shape; 0098 publishes them where the floors
  -- are created.
  intended CONSTANT text[] := ARRAY['cells', 'gateways', 'devices', 'platform_alerts', 'areas', 'area_floors'];
  members  text;
BEGIN
  SELECT string_agg(format('public.%I', t), ', ' ORDER BY t)
    INTO members
    FROM unnest(intended) AS t
   WHERE to_regclass('public.' || quote_ident(t)) IS NOT NULL;

  IF members IS NULL THEN
    RAISE EXCEPTION
      'realtime publication: none of the intended tables (%) exist', array_to_string(intended, ', ');
  END IF;

  EXECUTE 'ALTER PUBLICATION supabase_realtime SET TABLE ' || members;
  RAISE NOTICE 'realtime publication membership: %', members;
END $$;

ALTER TABLE public.cells          REPLICA IDENTITY FULL;
ALTER TABLE public.gateways       REPLICA IDENTITY FULL;
ALTER TABLE public.devices        REPLICA IDENTITY FULL;

-- Returned to the default now that the table is unpublished. FULL only ever affected UPDATE and
-- DELETE, which 0003's append-only trigger refuses anyway, so this changes no behaviour -- it
-- stops the file asserting a replication requirement for a table that is not replicated.
ALTER TABLE public.digital_thread REPLICA IDENTITY DEFAULT;

-- ---------------------------------------------------------------------------------------------
-- 6. Privileges withdrawn
-- ---------------------------------------------------------------------------------------------
-- These cannot be read off a dump, which describes what is granted rather than what must not
-- be. The image's default privileges hand anon, authenticated and service_role full rights on
-- every sequence created after them.
REVOKE ALL ON SEQUENCE public.digital_thread_id_seq FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.digital_thread_id_seq FROM service_role;

-- APPEND-ONLY IS ENFORCED BY THE ABSENCE OF A GRANT, which is precisely what a dump cannot state.
-- `service_role` is the credential ingestion and every edge function hold, so these two tables --
-- the audit trail and the ledger that stops a one-shot migration running twice -- are the two the
-- squash must not hand back write access to. A generated baseline grants ALL by default and the
-- only trace of the mistake would be four extra words in one ACL line.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.digital_thread FROM service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.one_shot_migrations FROM service_role;

-- Three functions nothing outside a migration may call: two maintenance routines that pg_cron
-- invokes as the superuser it runs under, and the sweep above. Revoked from service_role as well,
-- because holding the service key is not a reason to be able to rewrite the cron schedule.
REVOKE ALL ON FUNCTION public.ensure_cron_job(p_name text, p_schedule text, p_command text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prune_platform_alerts(interval)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.revoke_anon_function_privileges()
  FROM PUBLIC, anon, authenticated, service_role;

-- The anon sweep, which has to run last: PostgreSQL grants EXECUTE to PUBLIC on every function
-- as it is created and no default-privilege setting prevents it. The helper re-grants
-- `authenticated` and `service_role` what they held before, so it narrows reach without
-- deciding policy.
DO $sweep$
DECLARE
  v_corrected integer;
BEGIN
  v_corrected := public.revoke_anon_function_privileges();
  IF v_corrected > 0 THEN
    RAISE NOTICE 'withdrew anon/PUBLIC EXECUTE from % function(s).', v_corrected;
  END IF;
END
$sweep$;

-- ---------------------------------------------------------------------------------------------
-- 7. Structural self-checks
-- ---------------------------------------------------------------------------------------------
-- The two invariants that fail silently if the structure is wrong.

DO $$
BEGIN
  -- The versioning guard. A trigger that failed to attach would leave published schemas quietly
  -- editable while every other symptom looked correct.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'trg_prevent_active_schema_mutation' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'baseline incomplete: schema immutability trigger is not attached';
  END IF;

  -- Realtime evaluates RLS against the old row; with the default replica identity change events
  -- are silently withheld. The set is derived from the publication, not listed here, so section
  -- 5 and this assertion cannot contradict each other.
  IF EXISTS (
    SELECT 1
      FROM pg_publication_tables pt
      JOIN pg_class c      ON c.relname = pt.tablename
      JOIN pg_namespace n  ON n.oid = c.relnamespace AND n.nspname = pt.schemaname
     WHERE pt.pubname = 'supabase_realtime'
       AND c.relreplident <> 'f'
  ) THEN
    RAISE EXCEPTION 'baseline incomplete: a published table is not REPLICA IDENTITY FULL';
  END IF;
END $$;
