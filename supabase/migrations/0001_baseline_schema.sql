-- =============================================================================================
-- Migration: 0001_baseline_schema.sql
-- ACS-Cymru Asset Tracking Platform -- consolidated schema baseline (public beta)
-- =============================================================================================
--
-- WHAT THIS IS. The squashed structural baseline for the public beta. It replaces the 38
-- incremental migrations `20260101000000` .. `20260101000037`, which are preserved verbatim under
-- `supabase/migrations/archive/` -- they are not deleted, because they carry the reasoning behind
-- most of the decisions this file only shows the outcome of, and the READMEs still cite them by
-- number.
--
-- SCOPE: PURE DDL. No INSERT, no seeding, no data of any kind. Baseline data lives in
-- `0002_seed_data.sql` and nothing here depends on it having run.
--
-- IT IS IDEMPOTENT, AND THAT IS NOT OPTIONAL. `supabase-db-init` replays every
-- `/migrations/*.sql` on every boot -- there is no applied-migrations ledger. A plain `pg_dump`
-- baseline would install correctly on the first boot and then fail on the second with
-- "relation already exists", taking the whole stack down with it. Every statement below is
-- therefore written to survive re-execution: `CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE`
-- for functions and views, and `DROP ... IF EXISTS` ahead of every constraint, policy and
-- trigger. That is the same discipline the 38 migrations were written with.
--
-- HOW IT WAS PRODUCED, and how to reproduce it: the full chain was replayed onto a virgin
-- `supabase/postgres:15.6.1.143`, `pg_dump --schema-only --schema=public` was taken as the
-- completeness oracle, and the result was mechanically rewritten into the idempotent form above.
-- Equivalence is not asserted -- it is checked, by diffing a dump of a database built from the
-- old chain against a dump of one built from this file. Anything this file missed shows up in
-- that diff.
--
-- WHAT IS DELIBERATELY NOT HERE:
--   * the `storage.buckets` row for `asset-3d-models`. storage-api owns the `storage` schema and
--     migrates it on boot, and `supabase-db-init` finishes long before storage-api starts -- so a
--     migration could create the bucket row but not mark it public, and it would come up private
--     on a fresh stack. `scripts/storage-init.mjs` creates it afterwards. The POLICIES on
--     `storage.objects` are here, because that table exists from the image's stub onward.
--   * anything owned by GoTrue, Realtime or storage-api in their own schemas.
--
-- PSQL VARIABLES. `supabase-db-init` passes `-v ts_host ts_port ts_dbname ts_user ts_password`.
-- Each is defaulted below so this file is still runnable standalone, exactly as the migration it
-- came from was.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 0. Deferred function-body validation
-- ---------------------------------------------------------------------------------------------
-- REQUIRED, not tidiness. PL/pgSQL resolves type references in a function's DECLARE block at
-- CREATE time, so `fork_schema()` -- which declares `public.schemas%ROWTYPE` -- cannot be created
-- before the table exists. No single ordering satisfies every such dependency in both directions
-- (policies reference functions, functions reference tables, views reference both), which is why
-- pg_dump emits this same setting at the top of every dump it produces.
--
-- It defers SEMANTIC checks only. Syntax errors in a body are still rejected here, and the
-- deferred checks all run the first time each function is called -- which the migration's own
-- self-checks below, and the test suites, do.
SET check_function_bodies = false;


-- ---------------------------------------------------------------------------------------------
-- 1. Extensions
-- ---------------------------------------------------------------------------------------------
-- Each is created into the schema the original migration chose, and those choices are load
-- bearing: pg_net in `extensions` is where Supabase expects it, and supabase_vault in `vault` is
-- what makes `vault.decrypted_secrets` resolvable from the webhook dispatcher.

CREATE EXTENSION IF NOT EXISTS postgres_fdw;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;

-- pgjwt: DECLARED HERE FROM THE PG17 BUMP ONWARD, and its absence from this list until then was
-- not an oversight -- it was a dependency on a default. Supabase enabled pgjwt on every project up
-- to Postgres 17, so `extensions.sign()` simply existed and 0006 could call it. The 17.6.1.160
-- image still SHIPS the extension but no longer CREATES it, so the first thing that noticed was
-- 0006's own self-check, several migrations later, reporting a missing function rather than a
-- missing extension.
--
-- Being explicit is the improvement here regardless of version: a required extension belongs in
-- the list of required extensions. It also reduces removing pgjwt to a two-line change -- this
-- declaration and the signer in 0006 -- which is what the deprecation eventually forces. Supabase
-- has announced pgjwt's end for Postgres 17 and removed it from the hosted platform; the
-- self-hosted image retaining it is a reprieve, not a reversal.
-- See docs/postgres-17-migration-plan.md, Phase 1.
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
-- TimescaleDB is a separate container on its own port and is not reachable from the browser --
-- only Kong is. The FDW keeps TimescaleDB authoritative for time-series storage while giving the
-- SPA a normal PostgREST collection to query.
--
-- MUST COME BEFORE THE PUBLIC SCHEMA SECTION. `DROP SERVER ... CASCADE` below drops the foreign
-- table *and* the `public.telemetry` view that selects from it; the view is then re-created in
-- section 4 as part of the ordinary public DDL. Moving this section after that one would leave
-- the view dropped on every replay.

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

-- Recreated on every run so connection settings and column definitions stay in step with
-- docker-compose.yml and timescaledb/init/001_schema.sql.
DROP SERVER IF EXISTS timescaledb_server CASCADE;

CREATE SERVER timescaledb_server
  FOREIGN DATA WRAPPER postgres_fdw
  OPTIONS (host :'ts_host', port :'ts_port', dbname :'ts_dbname');

-- `postgres` keeps its own mapping for admin access. A second mapping FOR PUBLIC covers every
-- other local role (authenticated, service_role), since the view runs security_invoker and each
-- querying role needs its own path through the FDW. `anon` still reaches none of it -- it has
-- SELECT on neither the view nor the foreign table.
CREATE USER MAPPING FOR postgres
  SERVER timescaledb_server
  OPTIONS (user :'ts_user', password :'ts_password');

CREATE USER MAPPING FOR PUBLIC
  SERVER timescaledb_server
  OPTIONS (user :'ts_user', password :'ts_password');

CREATE FOREIGN TABLE timescale.telemetry (
    "time"      TIMESTAMPTZ      NOT NULL,
    asset_id    TEXT             NOT NULL,
    metric_name TEXT             NOT NULL,
    val_double  DOUBLE PRECISION,
    val_string  TEXT,
    val_bool    BOOLEAN
)
SERVER timescaledb_server
OPTIONS (schema_name 'public', table_name 'telemetry');

GRANT USAGE ON SCHEMA timescale TO authenticated, service_role;
GRANT SELECT ON timescale.telemetry TO authenticated, service_role;


-- ---------------------------------------------------------------------------------------------
-- 4. public schema
-- ---------------------------------------------------------------------------------------------
-- Tables, sequences, constraints, indexes, views, functions, triggers, RLS policies and grants.
-- Object order below is pg_dump's dependency order and should be preserved: the views depend on
-- the functions, the policies depend on `public.has_role()`, and the triggers depend on both.
--
-- Each object keeps its `-- Name: ...; Type: ...` banner so this section stays navigable.
-- Name: active_schema_version(uuid); Type: FUNCTION; Schema: public; Owner: -
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

-- Name: FUNCTION active_schema_version(schema_id uuid); Type: COMMENT; Schema: public; Owner: -
COMMENT ON FUNCTION public.active_schema_version(schema_id uuid) IS 'Follows a lineage forward from any version to the one currently in force. Returns the input unchanged when it is already active, is a draft, or has no published successor.';

-- Name: custom_access_token_hook(jsonb); Type: FUNCTION; Schema: public; Owner: -
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

-- Name: dispatch_device_quarantine_webhook(); Type: FUNCTION; Schema: public; Owner: -
CREATE OR REPLACE FUNCTION public.dispatch_device_quarantine_webhook() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'vault'
    AS $$
DECLARE
  ep    RECORD;
  hdrs  JSONB;
  token TEXT;
BEGIN
  FOR ep IN
    SELECT * FROM public.webhook_endpoints
    WHERE event_key = 'device.quarantined' AND is_enabled
  LOOP
    hdrs := jsonb_build_object('Content-Type', 'application/json');

    IF ep.secret_name IS NOT NULL THEN
      SELECT decrypted_secret INTO token
      FROM vault.decrypted_secrets
      WHERE name = ep.secret_name;

      -- Only attach credentials when there are any. The default stack runs Node-RED without
      -- adminAuth and stores no token, and sending a literal "Bearer " would be worse than
      -- sending nothing.
      IF token IS NOT NULL AND token <> '' THEN
        hdrs := hdrs || jsonb_build_object('Authorization', 'Bearer ' || token);
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

-- Name: enforce_metric_catalog_immutability(); Type: FUNCTION; Schema: public; Owner: -
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

-- Name: enforce_metric_group_spelling(); Type: FUNCTION; Schema: public; Owner: -
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

-- Name: enforce_schema_version_provenance(); Type: FUNCTION; Schema: public; Owner: -
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

-- Name: ensure_cron_job(text, text, text); Type: FUNCTION; Schema: public; Owner: -
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

-- Name: FUNCTION ensure_cron_job(p_name text, p_schedule text, p_command text); Type: COMMENT; Schema: public; Owner: -
COMMENT ON FUNCTION public.ensure_cron_job(p_name text, p_schedule text, p_command text) IS 'Unschedule-then-schedule, so replaying this migration does not accumulate duplicate jobs.';

-- Name: ensure_gateway_status_view(); Type: FUNCTION; Schema: public; Owner: -
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
    -- Mirrors gatewayLiveStatus(): a stored OFFLINE wins outright (an explicit NDEATH is not
    -- staleness), a gateway that has never reported keeps its stored status rather than being
    -- called stale, and anything else ages out.
    CASE
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
    'frontend/src/utils/gatewayStatus.js -- keep the 90s threshold in step. Deliberately a '
    'view, not a stored column or a pg_cron writer: writing status would append to the '
    'immutable digital_thread audit table on every sweep and would be stale between ticks. '
    'Rebuilt by public.ensure_gateway_status_view() -- call it after adding a gateways column.';

  -- DROP VIEW discards the grants with the view, so they are re-applied here rather than
  -- left outside the function where they would silently stop being re-run.
  --
  -- The revoke names `authenticated` and runs BEFORE the grant: Supabase's default privileges
  -- grant ALL on a new table in `public` to anon and authenticated, so the recreated view
  -- arrives holding INSERT/UPDATE/DELETE and a bare GRANT SELECT would leave them there. This
  -- view is not auto-updatable, so nothing could have written through it, but the privilege
  -- should say what is meant.
  REVOKE ALL ON public.gateway_status FROM PUBLIC, anon, authenticated;
  GRANT SELECT ON public.gateway_status TO authenticated;
END $$;

-- Name: FUNCTION ensure_gateway_status_view(); Type: COMMENT; Schema: public; Owner: -
COMMENT ON FUNCTION public.ensure_gateway_status_view() IS 'Drop-and-recreate public.gateway_status. Called here and by any later migration that adds a column to public.gateways -- the view selects g.*, which CREATE OR REPLACE VIEW cannot widen in place once a new column lands ahead of the derived ones.';

-- Name: fork_schema(uuid, text); Type: FUNCTION; Schema: public; Owner: -
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

-- Name: FUNCTION fork_schema(parent_schema_id uuid, change_description text); Type: COMMENT; Schema: public; Owner: -
COMMENT ON FUNCTION public.fork_schema(parent_schema_id uuid, change_description text) IS 'Derives the next draft version of an active schema, copying its definition. The version number is computed, never supplied.';

-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
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

-- Name: has_role(text[]); Type: FUNCTION; Schema: public; Owner: -
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

-- Name: log_digital_thread_event(); Type: FUNCTION; Schema: public; Owner: -
CREATE OR REPLACE FUNCTION public.log_digital_thread_event() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_old_data JSONB := NULL;
    v_new_data JSONB := NULL;
    v_entity_id UUID;
BEGIN
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

    INSERT INTO public.digital_thread (
        entity_type,
        entity_id,
        action,
        old_data,
        new_data,
        changed_by,
        recorded_at
    ) VALUES (
        TG_TABLE_NAME,
        v_entity_id,
        TG_OP,
        v_old_data,
        v_new_data,
        auth.uid(),
        NOW()
    );

    RETURN COALESCE(NEW, OLD);
END;
$$;

-- Name: prevent_active_schema_mutation(); Type: FUNCTION; Schema: public; Owner: -
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

-- Name: FUNCTION prevent_active_schema_mutation(); Type: COMMENT; Schema: public; Owner: -
COMMENT ON FUNCTION public.prevent_active_schema_mutation() IS 'Freezes every column except `status` on an active or archived schema, and rejects illegal status transitions for all callers.';

-- Name: publish_schema_version(uuid); Type: FUNCTION; Schema: public; Owner: -
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

    -- REBIND BEFORE ARCHIVING, so no window exists in which a device points at an archived schema.
    -- The whole function is one transaction, so this is ordering for readability rather than for
    -- observability -- but the read-backwards rule from the 3D-model upload applies: write the
    -- pointer, then retire what it pointed at.
    --
    -- A device already carrying BOTH versions as submodels would collide on
    -- `uq_device_submodels (device_id, schema_id)` when the old row is repointed. That is a real
    -- state -- someone can attach a draft to a device to try it out before publishing -- so the
    -- redundant old-version rows are dropped first rather than allowed to abort the publish.
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

    -- The legacy 1:1 pointer moves too. Migration 0034 kept `devices.schema_id` as the fallback
    -- arm of the `device_schemas` view, and migrations 0021/0033 still write it -- a device
    -- provisioned only through that column would otherwise stay pinned to an archived version and
    -- start reporting the new version's metrics as Unmodelled. This UPDATE also fires
    -- `log_digital_thread_event()`, so the rebinding lands in the audit trail per device, which is
    -- where the history of "what was this machine judged against, when" belongs.
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

-- Name: FUNCTION publish_schema_version(draft_schema_id uuid); Type: COMMENT; Schema: public; Owner: -
COMMENT ON FUNCTION public.publish_schema_version(draft_schema_id uuid) IS 'Activates a draft version, archives its parent, and atomically repoints every device_submodels row and legacy devices.schema_id from the parent to it.';

-- Name: schema_version_base_name(text); Type: FUNCTION; Schema: public; Owner: -
CREATE OR REPLACE FUNCTION public.schema_version_base_name(schema_name text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $_$
  SELECT regexp_replace(COALESCE(schema_name, ''), '_v[0-9]+$', '');
$_$;

-- Name: FUNCTION schema_version_base_name(schema_name text); Type: COMMENT; Schema: public; Owner: -
COMMENT ON FUNCTION public.schema_version_base_name(schema_name text) IS 'The lineage stem of a versioned schema name. Mirrored by baseSchemaName() in frontend/src/utils/schemaVersion.js -- keep the two in step.';

-- Name: asset_config; Type: TABLE; Schema: public; Owner: -
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

-- Name: cells; Type: TABLE; Schema: public; Owner: -
CREATE TABLE IF NOT EXISTS public.cells (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    grafana_url text,
    created_at timestamp with time zone DEFAULT now(),
    is_archived boolean DEFAULT false,
    archived_at timestamp with time zone,
    auto_delete_at timestamp with time zone
);

ALTER TABLE ONLY public.cells REPLICA IDENTITY FULL;

-- Name: devices; Type: TABLE; Schema: public; Owner: -
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
    CONSTRAINT devices_location_scope_valid CHECK ((location_scope = ANY (ARRAY['cell'::text, 'site_wide'::text]))),
    CONSTRAINT devices_model_3d_path_shape CHECK (((model_3d_path IS NULL) OR (model_3d_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]+\.(gltf|glb|obj|stl)$'::text))),
    CONSTRAINT devices_site_wide_has_no_cell CHECK (((location_scope <> 'site_wide'::text) OR (cell_id IS NULL)))
);

ALTER TABLE ONLY public.devices REPLICA IDENTITY FULL;

-- Name: COLUMN devices.sparkplug_id; Type: COMMENT; Schema: public; Owner: -
COMMENT ON COLUMN public.devices.sparkplug_id IS 'Immutable Sparkplug B device id, derived from the primary key. This is what appears in the MQTT topic and keys telemetry in TimescaleDB and birth parameters in asset_config.';

-- Name: COLUMN devices.reported_identity; Type: COMMENT; Schema: public; Owner: -
COMMENT ON COLUMN public.devices.reported_identity IS 'The Sparkplug B device id this device actually published under, when it differs from the platform-issued sparkplug_id. NULL means the device uses its issued id.';

-- Name: COLUMN devices.quarantine_reason; Type: COMMENT; Schema: public; Owner: -
COMMENT ON COLUMN public.devices.quarantine_reason IS 'Why this device is in the quarantine queue: UNKNOWN_DEVICE (well-formed id, never seen), MALFORMED_IDENTITY (id failed the 24-char gwy/dev format check), or IDENTITY_MISMATCH (topic device id and Asset_ID payload metric disagreed).';

-- Name: COLUMN devices.identity_source; Type: COMMENT; Schema: public; Owner: -
COMMENT ON COLUMN public.devices.identity_source IS 'How ingestion last resolved this device: ''sparkplug_id'' (current scheme) or ''legacy_name'' (matched by name during the migration window). Drives the deprecation badge in the UI.';

-- Name: COLUMN devices.model_3d_path; Type: COMMENT; Schema: public; Owner: -
COMMENT ON COLUMN public.devices.model_3d_path IS 'Object key of this device''s 3D model within the asset-3d-models bucket (<device_uuid>/<filename>). Never a URL -- the public URL is composed at export time from a configurable base.';

-- Name: COLUMN devices.cell_id; Type: COMMENT; Schema: public; Owner: -
COMMENT ON COLUMN public.devices.cell_id IS 'Explicit location override. NULL means inherit from gateways.cell_id -- deliberately no default, since an explicit value wins over inheritance and a default would make inheritance unreachable. Resolve through public.device_locations, never by reading this column alone.';

-- Name: COLUMN devices.location_scope; Type: COMMENT; Schema: public; Owner: -
COMMENT ON COLUMN public.devices.location_scope IS '''cell'' (located in, or awaiting, a cell) or ''site_wide'' (asserted to have no single cell -- BMS, AGV, ambient sensor). Distinct from cell_id IS NULL, which means undecided.';

-- Name: gateways; Type: TABLE; Schema: public; Owner: -
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
    -- ip_address was removed by 0004. Nothing in the monitoring flow read it: it is not part of
    -- the gateway search haystack, no view or function derives from it, ingestion resolves edge
    -- nodes by sparkplug_id, and the AAS exporter does not emit it. Dropped here as well as in
    -- 0004 so a fresh install never creates it -- see 0004's header for why both are needed.
    is_virtual boolean DEFAULT false NOT NULL,
    sparkplug_id text GENERATED ALWAYS AS (('gwy'::text || substr(encode(uuid_send(id), 'hex'::text), 1, 21))) STORED,
    location_scope text DEFAULT 'cell'::text NOT NULL,
    CONSTRAINT gateways_location_scope_valid CHECK ((location_scope = ANY (ARRAY['cell'::text, 'site_wide'::text]))),
    CONSTRAINT gateways_site_wide_has_no_cell CHECK (((location_scope <> 'site_wide'::text) OR (cell_id IS NULL)))
);

ALTER TABLE ONLY public.gateways REPLICA IDENTITY FULL;

-- Name: COLUMN gateways.last_heartbeat; Type: COMMENT; Schema: public; Owner: -
COMMENT ON COLUMN public.gateways.last_heartbeat IS 'When the ingestion daemon last received a Sparkplug B node-level message (NBIRTH/NDATA/NDEATH) from this edge node -- receipt time, not the payload timestamp, so it stays comparable with server time regardless of edge clock drift. NULL means no heartbeat has ever arrived.';

-- Name: COLUMN gateways.sparkplug_id; Type: COMMENT; Schema: public; Owner: -
COMMENT ON COLUMN public.gateways.sparkplug_id IS 'Immutable Sparkplug B edge node id, derived from the primary key. This is what appears in the MQTT topic (spBv1.0/<group>/<TYPE>/<sparkplug_id>). Never editable; rename the gateway freely without affecting ingestion.';

-- Name: COLUMN gateways.location_scope; Type: COMMENT; Schema: public; Owner: -
COMMENT ON COLUMN public.gateways.location_scope IS '''cell'' or ''site_wide''. A site-wide gateway -- typically is_virtual -- is a host-level proxy with no physical cell. Scope is not inherited by its devices; they resolve to Unassigned until an operator files them.';

-- Name: device_locations; Type: VIEW; Schema: public; Owner: -
CREATE OR REPLACE VIEW public.device_locations WITH (security_invoker='true') AS
 SELECT d.id AS device_id,
    d.gateway_id,
    d.cell_id AS explicit_cell_id,
    g.cell_id AS gateway_cell_id,
    d.location_scope,
        CASE
            WHEN (d.location_scope = 'site_wide'::text) THEN NULL::uuid
            ELSE COALESCE(d.cell_id, g.cell_id)
        END AS effective_cell_id,
        CASE
            WHEN (d.location_scope = 'site_wide'::text) THEN 'site_wide'::text
            WHEN (d.cell_id IS NOT NULL) THEN 'explicit'::text
            WHEN (g.cell_id IS NOT NULL) THEN 'inherited'::text
            ELSE 'unassigned'::text
        END AS location_source,
    ((d.location_scope = 'cell'::text) AND (d.cell_id IS NOT NULL) AND (g.cell_id IS NOT NULL) AND (d.cell_id <> g.cell_id)) AS cell_mismatch
   FROM (public.devices d
     LEFT JOIN public.gateways g ON ((g.id = d.gateway_id)));

-- Name: VIEW device_locations; Type: COMMENT; Schema: public; Owner: -
COMMENT ON VIEW public.device_locations IS 'Effective cell per device: explicit devices.cell_id, else inherited gateways.cell_id, else unassigned; site-wide assets resolve to no cell. Mirrors frontend/src/utils/cellResolution.js -- keep the two in step. Derived at read time and never stored, so editing a gateway''s cell reclassifies its devices immediately.';

-- Name: device_submodels; Type: TABLE; Schema: public; Owner: -
CREATE TABLE IF NOT EXISTS public.device_submodels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    schema_id uuid NOT NULL,
    submodel_key text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT device_submodels_key_is_id_short CHECK (((submodel_key IS NULL) OR (submodel_key ~ '^[A-Za-z_][A-Za-z0-9_]*$'::text)))
);

-- Name: TABLE device_submodels; Type: COMMENT; Schema: public; Owner: -
COMMENT ON TABLE public.device_submodels IS 'Schemas attached to a device, one AAS Submodel each. Supersedes the 1:1 devices.schema_id, which is retained as a fallback for devices with no rows here.';

-- Name: device_schemas; Type: VIEW; Schema: public; Owner: -
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

-- Name: VIEW device_schemas; Type: COMMENT; Schema: public; Owner: -
COMMENT ON VIEW public.device_schemas IS 'Every schema attached to a device: device_submodels rows, plus the legacy devices.schema_id for devices that have none.';

-- Name: digital_thread; Type: TABLE; Schema: public; Owner: -
CREATE TABLE IF NOT EXISTS public.digital_thread (
    id bigint NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    action text NOT NULL,
    old_data jsonb,
    new_data jsonb,
    changed_by uuid,
    recorded_at timestamp with time zone DEFAULT now()
);

ALTER TABLE ONLY public.digital_thread REPLICA IDENTITY FULL;

-- Name: digital_thread_id_seq; Type: SEQUENCE; Schema: public; Owner: -
CREATE SEQUENCE IF NOT EXISTS public.digital_thread_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- Name: digital_thread_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
ALTER SEQUENCE public.digital_thread_id_seq OWNED BY public.digital_thread.id;

-- Name: directory_services; Type: TABLE; Schema: public; Owner: -
CREATE TABLE IF NOT EXISTS public.directory_services (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    service_name text NOT NULL,
    service_type text NOT NULL,
    endpoint_url text NOT NULL,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    last_heartbeat timestamp with time zone DEFAULT now(),
    registered_schema_id uuid
);

-- Name: documents; Type: TABLE; Schema: public; Owner: -
CREATE TABLE IF NOT EXISTS public.documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_type text NOT NULL,
    entity_id text NOT NULL,
    display_name text NOT NULL,
    url text NOT NULL,
    document_tag text DEFAULT 'other'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);

-- Name: gateway_status; Type: VIEW; Schema: public; Owner: -
--
-- BUILT BY THE FUNCTION, NOT INLINE, and that is load bearing rather than tidy.
--
-- pg_dump expanded this view into an EXPLICIT COLUMN LIST when the baseline was squashed, while
-- ensure_gateway_status_view() selects `g.*`. Those two drift apart the moment a later migration
-- adds a column to public.gateways: 0008 adds `sparkplug_group` and rebuilds the view with `g.*`,
-- so the view gains a column -- and then THIS statement replays on the next boot with the older,
-- narrower list and PostgreSQL refuses:
--
--     ERROR:  cannot drop columns from view
--
-- db-init runs with ON_ERROR_STOP=1, so that is not a warning: the stack never comes up again,
-- and it happens on the SECOND boot rather than the first, which is the worst time to find out.
-- 0004 hit the same wall from the opposite direction when a column was REMOVED.
--
-- Calling the function leaves ONE definition of this view in the repository. The function drops
-- and recreates rather than replacing -- which is also what re-applies the grants, since DROP VIEW
-- discards them.
SELECT public.ensure_gateway_status_view();
-- No COMMENT ON VIEW here: the function sets it, along with the grants, because DROP VIEW
-- discards both. A copy outside would be the same drift this change removes.

-- Name: iso22400_vocabulary; Type: TABLE; Schema: public; Owner: -
CREATE TABLE IF NOT EXISTS public.iso22400_vocabulary (
    name text NOT NULL,
    kpi_id text NOT NULL,
    description text,
    category text,
    unit text,
    formula text,
    semantic_id text
);

-- Name: TABLE iso22400_vocabulary; Type: COMMENT; Schema: public; Owner: -
COMMENT ON TABLE public.iso22400_vocabulary IS 'ISO 22400-2 key performance indicator definitions. Reference data, not deployment state -- a row here is a KPI the standard defines, not a metric a device publishes.';

-- Name: metric_catalog; Type: TABLE; Schema: public; Owner: -
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
    CONSTRAINT metric_catalog_category_valid CHECK (((category IS NULL) OR (category = ANY (ARRAY['SAMPLE'::text, 'EVENT'::text, 'CONDITION'::text])))),
    CONSTRAINT metric_catalog_semantic_id_type_valid CHECK (((semantic_id_type IS NULL) OR (semantic_id_type = ANY (ARRAY['IRI'::text, 'IRDI'::text, 'ModelReference'::text]))))
);

-- Name: COLUMN metric_catalog.semantic_id; Type: COMMENT; Schema: public; Owner: -
COMMENT ON COLUMN public.metric_catalog.semantic_id IS 'AAS (IEC 63278) semanticId for this metric -- the globally-resolvable identity of the concept it measures. NULL means unmapped, which is a legitimate state for a local extension.';

-- Name: COLUMN metric_catalog.semantic_id_type; Type: COMMENT; Schema: public; Owner: -
COMMENT ON COLUMN public.metric_catalog.semantic_id_type IS 'Which kind of AAS Reference semantic_id is: IRI, IRDI, or ModelReference.';

-- Name: metric_groups; Type: TABLE; Schema: public; Owner: -
CREATE TABLE IF NOT EXISTS public.metric_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now(),
    standard text,
    CONSTRAINT metric_groups_name_is_one_segment CHECK (((name <> ''::text) AND (strpos(name, '/'::text) = 0)))
);

-- Name: mtconnect_vocabulary; Type: TABLE; Schema: public; Owner: -
CREATE TABLE IF NOT EXISTS public.mtconnect_vocabulary (
    kind text NOT NULL,
    name text NOT NULL,
    category text,
    semantic_id text
);

-- Name: TABLE mtconnect_vocabulary; Type: COMMENT; Schema: public; Owner: -
COMMENT ON TABLE public.mtconnect_vocabulary IS 'MTConnect controlled vocabularies, generated from the Apache-2.0 mtconnect/schema repository. Reference data, not deployment state.';

-- Name: COLUMN mtconnect_vocabulary.semantic_id; Type: COMMENT; Schema: public; Owner: -
COMMENT ON COLUMN public.mtconnect_vocabulary.semantic_id IS 'Local-namespace IRI for this vocabulary concept. Minted by this deployment, not issued by MTConnect -- see migration 0032.';

-- Name: opcua_vocabulary; Type: TABLE; Schema: public; Owner: -
CREATE TABLE IF NOT EXISTS public.opcua_vocabulary (
    name text NOT NULL,
    companion_spec text NOT NULL,
    node_id text,
    description text,
    datatype text,
    unit text,
    semantic_id text
);

-- Name: TABLE opcua_vocabulary; Type: COMMENT; Schema: public; Owner: -
COMMENT ON TABLE public.opcua_vocabulary IS 'OPC UA companion specification data points (OPC 40001 Machinery, OPC 40010 Robotics). Reference data, not deployment state. node_id holds a browse path, not a resolvable numeric NodeId -- see the migration header.';

-- Name: permissions; Type: TABLE; Schema: public; Owner: -
CREATE TABLE IF NOT EXISTS public.permissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text
);

-- Name: role_permissions; Type: TABLE; Schema: public; Owner: -
CREATE TABLE IF NOT EXISTS public.role_permissions (
    role_id integer NOT NULL,
    permission_id uuid NOT NULL
);

-- Name: roles; Type: TABLE; Schema: public; Owner: -
CREATE TABLE IF NOT EXISTS public.roles (
    id integer NOT NULL,
    name text NOT NULL,
    description text
);

-- Name: roles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
CREATE SEQUENCE IF NOT EXISTS public.roles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

-- Name: roles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
ALTER SEQUENCE public.roles_id_seq OWNED BY public.roles.id;

-- Name: schemas; Type: TABLE; Schema: public; Owner: -
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
    CONSTRAINT schemas_status_valid CHECK (((status)::text = ANY ((ARRAY['draft'::character varying, 'active'::character varying, 'archived'::character varying])::text[]))),
    CONSTRAINT schemas_version_lineage_coherent CHECK ((((version = 1) AND (parent_schema_id IS NULL)) OR ((version > 1) AND (parent_schema_id IS NOT NULL)))),
    CONSTRAINT schemas_version_positive CHECK ((version >= 1))
);

-- Name: COLUMN schemas.semantic_id; Type: COMMENT; Schema: public; Owner: -
COMMENT ON COLUMN public.schemas.semantic_id IS 'AAS semanticId for the Submodel this schema corresponds to, e.g. an IDTA submodel template id.';

-- Name: COLUMN schemas.version; Type: COMMENT; Schema: public; Owner: -
COMMENT ON COLUMN public.schemas.version IS 'Auto-incremented lineage position. Never supplied by a caller -- fork_schema() derives it from the parent.';

-- Name: COLUMN schemas.parent_schema_id; Type: COMMENT; Schema: public; Owner: -
COMMENT ON COLUMN public.schemas.parent_schema_id IS 'The version this one was forked from. NULL only for a v1 root.';

-- Name: COLUMN schemas.status; Type: COMMENT; Schema: public; Owner: -
COMMENT ON COLUMN public.schemas.status IS 'draft (editable) | active (in force, immutable) | archived (superseded, immutable).';

-- Name: COLUMN schemas.change_description; Type: COMMENT; Schema: public; Owner: -
COMMENT ON COLUMN public.schemas.change_description IS 'Why this version exists. Captured at fork time; immutable once the version is published.';

-- Name: telemetry; Type: VIEW; Schema: public; Owner: -
CREATE OR REPLACE VIEW public.telemetry WITH (security_invoker='true') AS
 SELECT telemetry."time",
    telemetry.asset_id,
    telemetry.metric_name,
    telemetry.val_double,
    telemetry.val_string,
    telemetry.val_bool
   FROM timescale.telemetry;

-- Name: VIEW telemetry; Type: COMMENT; Schema: public; Owner: -
COMMENT ON VIEW public.telemetry IS 'Read-only PostgREST projection of the standalone TimescaleDB telemetry hypertable, reached over postgres_fdw. Filter with asset_id / metric_name / time and always pass a limit -- postgres_fdw pushes WHERE clauses to the remote but not LIMIT, so an unbounded query materialises the whole matching range locally.';

-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
CREATE TABLE IF NOT EXISTS public.user_roles (
    user_id text NOT NULL,
    role_id integer NOT NULL
);

-- Name: webhook_endpoints; Type: TABLE; Schema: public; Owner: -
CREATE TABLE IF NOT EXISTS public.webhook_endpoints (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_key text NOT NULL,
    url text NOT NULL,
    secret_name text,
    is_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Name: TABLE webhook_endpoints; Type: COMMENT; Schema: public; Owner: -
COMMENT ON TABLE public.webhook_endpoints IS 'Outbound webhook targets. Managed by migration only -- there is deliberately no INSERT/UPDATE/DELETE RLS policy, so no API caller can point the database at a host of their choosing.';

-- Name: digital_thread id; Type: DEFAULT; Schema: public; Owner: -
ALTER TABLE ONLY public.digital_thread ALTER COLUMN id SET DEFAULT nextval('public.digital_thread_id_seq'::regclass);

-- Name: roles id; Type: DEFAULT; Schema: public; Owner: -
ALTER TABLE ONLY public.roles ALTER COLUMN id SET DEFAULT nextval('public.roles_id_seq'::regclass);

-- Name: asset_config asset_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'asset_config_pkey' AND conrelid = 'public.asset_config'::regclass
  ) THEN
    ALTER TABLE ONLY public.asset_config
        ADD CONSTRAINT asset_config_pkey PRIMARY KEY (id);
  END IF;
END $baseline$;

-- Name: cells cells_name_key; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'cells_name_key' AND conrelid = 'public.cells'::regclass
  ) THEN
    ALTER TABLE ONLY public.cells
        ADD CONSTRAINT cells_name_key UNIQUE (name);
  END IF;
END $baseline$;

-- Name: cells cells_pkey; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'cells_pkey' AND conrelid = 'public.cells'::regclass
  ) THEN
    ALTER TABLE ONLY public.cells
        ADD CONSTRAINT cells_pkey PRIMARY KEY (id);
  END IF;
END $baseline$;

-- Name: device_submodels device_submodels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'device_submodels_pkey' AND conrelid = 'public.device_submodels'::regclass
  ) THEN
    ALTER TABLE ONLY public.device_submodels
        ADD CONSTRAINT device_submodels_pkey PRIMARY KEY (id);
  END IF;
END $baseline$;

-- Name: devices devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'devices_pkey' AND conrelid = 'public.devices'::regclass
  ) THEN
    ALTER TABLE ONLY public.devices
        ADD CONSTRAINT devices_pkey PRIMARY KEY (id);
  END IF;
END $baseline$;

-- Name: digital_thread digital_thread_pkey; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'digital_thread_pkey' AND conrelid = 'public.digital_thread'::regclass
  ) THEN
    ALTER TABLE ONLY public.digital_thread
        ADD CONSTRAINT digital_thread_pkey PRIMARY KEY (id);
  END IF;
END $baseline$;

-- Name: directory_services directory_services_pkey; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'directory_services_pkey' AND conrelid = 'public.directory_services'::regclass
  ) THEN
    ALTER TABLE ONLY public.directory_services
        ADD CONSTRAINT directory_services_pkey PRIMARY KEY (id);
  END IF;
END $baseline$;

-- Name: directory_services directory_services_service_name_key; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'directory_services_service_name_key' AND conrelid = 'public.directory_services'::regclass
  ) THEN
    ALTER TABLE ONLY public.directory_services
        ADD CONSTRAINT directory_services_service_name_key UNIQUE (service_name);
  END IF;
END $baseline$;

-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'documents_pkey' AND conrelid = 'public.documents'::regclass
  ) THEN
    ALTER TABLE ONLY public.documents
        ADD CONSTRAINT documents_pkey PRIMARY KEY (id);
  END IF;
END $baseline$;

-- Name: gateways gateways_pkey; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'gateways_pkey' AND conrelid = 'public.gateways'::regclass
  ) THEN
    ALTER TABLE ONLY public.gateways
        ADD CONSTRAINT gateways_pkey PRIMARY KEY (id);
  END IF;
END $baseline$;

-- Name: iso22400_vocabulary iso22400_vocabulary_pkey; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'iso22400_vocabulary_pkey' AND conrelid = 'public.iso22400_vocabulary'::regclass
  ) THEN
    ALTER TABLE ONLY public.iso22400_vocabulary
        ADD CONSTRAINT iso22400_vocabulary_pkey PRIMARY KEY (name);
  END IF;
END $baseline$;

-- Name: metric_catalog metric_catalog_name_key; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'metric_catalog_name_key' AND conrelid = 'public.metric_catalog'::regclass
  ) THEN
    ALTER TABLE ONLY public.metric_catalog
        ADD CONSTRAINT metric_catalog_name_key UNIQUE (name);
  END IF;
END $baseline$;

-- Name: metric_catalog metric_catalog_pkey; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'metric_catalog_pkey' AND conrelid = 'public.metric_catalog'::regclass
  ) THEN
    ALTER TABLE ONLY public.metric_catalog
        ADD CONSTRAINT metric_catalog_pkey PRIMARY KEY (id);
  END IF;
END $baseline$;

-- Name: metric_groups metric_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'metric_groups_pkey' AND conrelid = 'public.metric_groups'::regclass
  ) THEN
    ALTER TABLE ONLY public.metric_groups
        ADD CONSTRAINT metric_groups_pkey PRIMARY KEY (id);
  END IF;
END $baseline$;

-- Name: mtconnect_vocabulary mtconnect_vocabulary_pkey; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'mtconnect_vocabulary_pkey' AND conrelid = 'public.mtconnect_vocabulary'::regclass
  ) THEN
    ALTER TABLE ONLY public.mtconnect_vocabulary
        ADD CONSTRAINT mtconnect_vocabulary_pkey PRIMARY KEY (kind, name);
  END IF;
END $baseline$;

-- Name: opcua_vocabulary opcua_vocabulary_pkey; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'opcua_vocabulary_pkey' AND conrelid = 'public.opcua_vocabulary'::regclass
  ) THEN
    ALTER TABLE ONLY public.opcua_vocabulary
        ADD CONSTRAINT opcua_vocabulary_pkey PRIMARY KEY (companion_spec, name);
  END IF;
END $baseline$;

-- Name: permissions permissions_name_key; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'permissions_name_key' AND conrelid = 'public.permissions'::regclass
  ) THEN
    ALTER TABLE ONLY public.permissions
        ADD CONSTRAINT permissions_name_key UNIQUE (name);
  END IF;
END $baseline$;

-- Name: permissions permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'permissions_pkey' AND conrelid = 'public.permissions'::regclass
  ) THEN
    ALTER TABLE ONLY public.permissions
        ADD CONSTRAINT permissions_pkey PRIMARY KEY (id);
  END IF;
END $baseline$;

-- Name: role_permissions role_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'role_permissions_pkey' AND conrelid = 'public.role_permissions'::regclass
  ) THEN
    ALTER TABLE ONLY public.role_permissions
        ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (role_id, permission_id);
  END IF;
END $baseline$;

-- Name: roles roles_name_key; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'roles_name_key' AND conrelid = 'public.roles'::regclass
  ) THEN
    ALTER TABLE ONLY public.roles
        ADD CONSTRAINT roles_name_key UNIQUE (name);
  END IF;
END $baseline$;

-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'roles_pkey' AND conrelid = 'public.roles'::regclass
  ) THEN
    ALTER TABLE ONLY public.roles
        ADD CONSTRAINT roles_pkey PRIMARY KEY (id);
  END IF;
END $baseline$;

-- Name: schemas schemas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'schemas_pkey' AND conrelid = 'public.schemas'::regclass
  ) THEN
    ALTER TABLE ONLY public.schemas
        ADD CONSTRAINT schemas_pkey PRIMARY KEY (id);
  END IF;
END $baseline$;

-- Name: schemas schemas_schema_name_key; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'schemas_schema_name_key' AND conrelid = 'public.schemas'::regclass
  ) THEN
    ALTER TABLE ONLY public.schemas
        ADD CONSTRAINT schemas_schema_name_key UNIQUE (schema_name);
  END IF;
END $baseline$;

-- Name: asset_config uq_asset_config_metric; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'uq_asset_config_metric' AND conrelid = 'public.asset_config'::regclass
  ) THEN
    ALTER TABLE ONLY public.asset_config
        ADD CONSTRAINT uq_asset_config_metric UNIQUE (asset_id, metric_name);
  END IF;
END $baseline$;

-- Name: device_submodels uq_device_submodels; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'uq_device_submodels' AND conrelid = 'public.device_submodels'::regclass
  ) THEN
    ALTER TABLE ONLY public.device_submodels
        ADD CONSTRAINT uq_device_submodels UNIQUE (device_id, schema_id);
  END IF;
END $baseline$;

-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'user_roles_pkey' AND conrelid = 'public.user_roles'::regclass
  ) THEN
    ALTER TABLE ONLY public.user_roles
        ADD CONSTRAINT user_roles_pkey PRIMARY KEY (user_id, role_id);
  END IF;
END $baseline$;

-- Name: webhook_endpoints webhook_endpoints_event_key_url_key; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'webhook_endpoints_event_key_url_key' AND conrelid = 'public.webhook_endpoints'::regclass
  ) THEN
    ALTER TABLE ONLY public.webhook_endpoints
        ADD CONSTRAINT webhook_endpoints_event_key_url_key UNIQUE (event_key, url);
  END IF;
END $baseline$;

-- Name: webhook_endpoints webhook_endpoints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'webhook_endpoints_pkey' AND conrelid = 'public.webhook_endpoints'::regclass
  ) THEN
    ALTER TABLE ONLY public.webhook_endpoints
        ADD CONSTRAINT webhook_endpoints_pkey PRIMARY KEY (id);
  END IF;
END $baseline$;

-- Name: idx_device_submodels_device; Type: INDEX; Schema: public; Owner: -
CREATE INDEX IF NOT EXISTS idx_device_submodels_device ON public.device_submodels USING btree (device_id);

-- Name: idx_device_submodels_schema; Type: INDEX; Schema: public; Owner: -
CREATE INDEX IF NOT EXISTS idx_device_submodels_schema ON public.device_submodels USING btree (schema_id);

-- Name: idx_devices_cell_id; Type: INDEX; Schema: public; Owner: -
CREATE INDEX IF NOT EXISTS idx_devices_cell_id ON public.devices USING btree (cell_id) WHERE (cell_id IS NOT NULL);

-- Name: idx_devices_name; Type: INDEX; Schema: public; Owner: -
CREATE INDEX IF NOT EXISTS idx_devices_name ON public.devices USING btree (name);

-- Name: idx_devices_reported_identity; Type: INDEX; Schema: public; Owner: -
CREATE INDEX IF NOT EXISTS idx_devices_reported_identity ON public.devices USING btree (reported_identity) WHERE (reported_identity IS NOT NULL);

-- Name: idx_devices_sparkplug_id; Type: INDEX; Schema: public; Owner: -
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_sparkplug_id ON public.devices USING btree (sparkplug_id);

-- Name: idx_documents_entity; Type: INDEX; Schema: public; Owner: -
CREATE INDEX IF NOT EXISTS idx_documents_entity ON public.documents USING btree (entity_type, entity_id);

-- Name: idx_gateways_name; Type: INDEX; Schema: public; Owner: -
CREATE INDEX IF NOT EXISTS idx_gateways_name ON public.gateways USING btree (name);

-- Name: idx_gateways_sparkplug_id; Type: INDEX; Schema: public; Owner: -
CREATE UNIQUE INDEX IF NOT EXISTS idx_gateways_sparkplug_id ON public.gateways USING btree (sparkplug_id);

-- Name: idx_metric_catalog_group; Type: INDEX; Schema: public; Owner: -
CREATE INDEX IF NOT EXISTS idx_metric_catalog_group ON public.metric_catalog USING btree (metric_group);

-- Name: idx_metric_catalog_semantic_id; Type: INDEX; Schema: public; Owner: -
CREATE INDEX IF NOT EXISTS idx_metric_catalog_semantic_id ON public.metric_catalog USING btree (semantic_id) WHERE (semantic_id IS NOT NULL);

-- Name: idx_schemas_parent; Type: INDEX; Schema: public; Owner: -
CREATE INDEX IF NOT EXISTS idx_schemas_parent ON public.schemas USING btree (parent_schema_id);

-- Name: idx_schemas_status; Type: INDEX; Schema: public; Owner: -
CREATE INDEX IF NOT EXISTS idx_schemas_status ON public.schemas USING btree (status);

-- Name: uq_metric_groups_name_ci; Type: INDEX; Schema: public; Owner: -
CREATE UNIQUE INDEX IF NOT EXISTS uq_metric_groups_name_ci ON public.metric_groups USING btree (lower(name));

-- Name: uq_schemas_one_draft_per_parent; Type: INDEX; Schema: public; Owner: -
CREATE UNIQUE INDEX IF NOT EXISTS uq_schemas_one_draft_per_parent ON public.schemas USING btree (parent_schema_id) WHERE (((status)::text = 'draft'::text) AND (parent_schema_id IS NOT NULL));

-- Name: cells trg_cells_digital_thread; Type: TRIGGER; Schema: public; Owner: -
DROP TRIGGER IF EXISTS trg_cells_digital_thread ON public.cells;
CREATE TRIGGER trg_cells_digital_thread AFTER INSERT OR DELETE OR UPDATE ON public.cells FOR EACH ROW EXECUTE FUNCTION public.log_digital_thread_event();

-- Name: devices trg_device_quarantine_webhook_insert; Type: TRIGGER; Schema: public; Owner: -
DROP TRIGGER IF EXISTS trg_device_quarantine_webhook_insert ON public.devices;
CREATE TRIGGER trg_device_quarantine_webhook_insert AFTER INSERT ON public.devices FOR EACH ROW WHEN ((new.is_quarantined IS TRUE)) EXECUTE FUNCTION public.dispatch_device_quarantine_webhook();

-- Name: devices trg_device_quarantine_webhook_update; Type: TRIGGER; Schema: public; Owner: -
DROP TRIGGER IF EXISTS trg_device_quarantine_webhook_update ON public.devices;
CREATE TRIGGER trg_device_quarantine_webhook_update AFTER UPDATE OF is_quarantined ON public.devices FOR EACH ROW WHEN (((new.is_quarantined IS TRUE) AND (old.is_quarantined IS DISTINCT FROM true))) EXECUTE FUNCTION public.dispatch_device_quarantine_webhook();

-- Name: devices trg_devices_digital_thread; Type: TRIGGER; Schema: public; Owner: -
DROP TRIGGER IF EXISTS trg_devices_digital_thread ON public.devices;
CREATE TRIGGER trg_devices_digital_thread AFTER INSERT OR DELETE OR UPDATE ON public.devices FOR EACH ROW EXECUTE FUNCTION public.log_digital_thread_event();

-- Name: schemas trg_enforce_schema_version_provenance; Type: TRIGGER; Schema: public; Owner: -
DROP TRIGGER IF EXISTS trg_enforce_schema_version_provenance ON public.schemas;
CREATE TRIGGER trg_enforce_schema_version_provenance BEFORE INSERT ON public.schemas FOR EACH ROW EXECUTE FUNCTION public.enforce_schema_version_provenance();

-- Name: gateways trg_gateways_digital_thread; Type: TRIGGER; Schema: public; Owner: -
DROP TRIGGER IF EXISTS trg_gateways_digital_thread ON public.gateways;
CREATE TRIGGER trg_gateways_digital_thread AFTER INSERT OR DELETE OR UPDATE ON public.gateways FOR EACH ROW EXECUTE FUNCTION public.log_digital_thread_event();

-- Name: metric_catalog trg_metric_catalog_immutability; Type: TRIGGER; Schema: public; Owner: -
DROP TRIGGER IF EXISTS trg_metric_catalog_immutability ON public.metric_catalog;
CREATE TRIGGER trg_metric_catalog_immutability BEFORE UPDATE ON public.metric_catalog FOR EACH ROW EXECUTE FUNCTION public.enforce_metric_catalog_immutability();

-- Name: metric_catalog trg_metric_group_spelling; Type: TRIGGER; Schema: public; Owner: -
DROP TRIGGER IF EXISTS trg_metric_group_spelling ON public.metric_catalog;
CREATE TRIGGER trg_metric_group_spelling BEFORE INSERT ON public.metric_catalog FOR EACH ROW EXECUTE FUNCTION public.enforce_metric_group_spelling();

-- Name: schemas trg_prevent_active_schema_mutation; Type: TRIGGER; Schema: public; Owner: -
DROP TRIGGER IF EXISTS trg_prevent_active_schema_mutation ON public.schemas;
CREATE TRIGGER trg_prevent_active_schema_mutation BEFORE UPDATE ON public.schemas FOR EACH ROW EXECUTE FUNCTION public.prevent_active_schema_mutation();

-- Name: device_submodels device_submodels_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'device_submodels_device_id_fkey' AND conrelid = 'public.device_submodels'::regclass
  ) THEN
    ALTER TABLE ONLY public.device_submodels
        ADD CONSTRAINT device_submodels_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;
  END IF;
END $baseline$;

-- Name: device_submodels device_submodels_schema_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'device_submodels_schema_id_fkey' AND conrelid = 'public.device_submodels'::regclass
  ) THEN
    ALTER TABLE ONLY public.device_submodels
        ADD CONSTRAINT device_submodels_schema_id_fkey FOREIGN KEY (schema_id) REFERENCES public.schemas(id) ON DELETE CASCADE;
  END IF;
END $baseline$;

-- Name: devices devices_cell_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'devices_cell_id_fkey' AND conrelid = 'public.devices'::regclass
  ) THEN
    ALTER TABLE ONLY public.devices
        ADD CONSTRAINT devices_cell_id_fkey FOREIGN KEY (cell_id) REFERENCES public.cells(id) ON DELETE SET NULL;
  END IF;
END $baseline$;

-- Name: devices devices_gateway_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'devices_gateway_id_fkey' AND conrelid = 'public.devices'::regclass
  ) THEN
    ALTER TABLE ONLY public.devices
        ADD CONSTRAINT devices_gateway_id_fkey FOREIGN KEY (gateway_id) REFERENCES public.gateways(id) ON DELETE SET NULL;
  END IF;
END $baseline$;

-- Name: devices devices_schema_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'devices_schema_id_fkey' AND conrelid = 'public.devices'::regclass
  ) THEN
    ALTER TABLE ONLY public.devices
        ADD CONSTRAINT devices_schema_id_fkey FOREIGN KEY (schema_id) REFERENCES public.schemas(id) ON DELETE SET NULL;
  END IF;
END $baseline$;

-- Name: digital_thread digital_thread_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'digital_thread_changed_by_fkey' AND conrelid = 'public.digital_thread'::regclass
  ) THEN
    ALTER TABLE ONLY public.digital_thread
        ADD CONSTRAINT digital_thread_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES auth.users(id);
  END IF;
END $baseline$;

-- Name: directory_services directory_services_registered_schema_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'directory_services_registered_schema_id_fkey' AND conrelid = 'public.directory_services'::regclass
  ) THEN
    ALTER TABLE ONLY public.directory_services
        ADD CONSTRAINT directory_services_registered_schema_id_fkey FOREIGN KEY (registered_schema_id) REFERENCES public.schemas(id) ON DELETE SET NULL;
  END IF;
END $baseline$;

-- Name: gateways gateways_cell_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'gateways_cell_id_fkey' AND conrelid = 'public.gateways'::regclass
  ) THEN
    ALTER TABLE ONLY public.gateways
        ADD CONSTRAINT gateways_cell_id_fkey FOREIGN KEY (cell_id) REFERENCES public.cells(id) ON DELETE CASCADE;
  END IF;
END $baseline$;

-- Name: metric_catalog metric_catalog_superseded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'metric_catalog_superseded_by_fkey' AND conrelid = 'public.metric_catalog'::regclass
  ) THEN
    ALTER TABLE ONLY public.metric_catalog
        ADD CONSTRAINT metric_catalog_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES public.metric_catalog(id) ON DELETE SET NULL;
  END IF;
END $baseline$;

-- Name: role_permissions role_permissions_permission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'role_permissions_permission_id_fkey' AND conrelid = 'public.role_permissions'::regclass
  ) THEN
    ALTER TABLE ONLY public.role_permissions
        ADD CONSTRAINT role_permissions_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON DELETE CASCADE;
  END IF;
END $baseline$;

-- Name: role_permissions role_permissions_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'role_permissions_role_id_fkey' AND conrelid = 'public.role_permissions'::regclass
  ) THEN
    ALTER TABLE ONLY public.role_permissions
        ADD CONSTRAINT role_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;
  END IF;
END $baseline$;

-- Name: schemas schemas_parent_schema_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'schemas_parent_schema_id_fkey' AND conrelid = 'public.schemas'::regclass
  ) THEN
    ALTER TABLE ONLY public.schemas
        ADD CONSTRAINT schemas_parent_schema_id_fkey FOREIGN KEY (parent_schema_id) REFERENCES public.schemas(id) ON DELETE SET NULL;
  END IF;
END $baseline$;

-- Name: user_roles user_roles_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'user_roles_role_id_fkey' AND conrelid = 'public.user_roles'::regclass
  ) THEN
    ALTER TABLE ONLY public.user_roles
        ADD CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;
  END IF;
END $baseline$;

-- Name: asset_config; Type: ROW SECURITY; Schema: public; Owner: -
ALTER TABLE public.asset_config ENABLE ROW LEVEL SECURITY;

-- Name: asset_config asset_config_delete_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS asset_config_delete_privileged ON public.asset_config;
CREATE POLICY asset_config_delete_privileged ON public.asset_config FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: asset_config asset_config_insert_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS asset_config_insert_privileged ON public.asset_config;
CREATE POLICY asset_config_insert_privileged ON public.asset_config FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: asset_config asset_config_select_authenticated; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS asset_config_select_authenticated ON public.asset_config;
CREATE POLICY asset_config_select_authenticated ON public.asset_config FOR SELECT TO authenticated USING (true);

-- Name: asset_config asset_config_update_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS asset_config_update_privileged ON public.asset_config;
CREATE POLICY asset_config_update_privileged ON public.asset_config FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: cells; Type: ROW SECURITY; Schema: public; Owner: -
ALTER TABLE public.cells ENABLE ROW LEVEL SECURITY;

-- Name: cells cells_delete_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS cells_delete_privileged ON public.cells;
CREATE POLICY cells_delete_privileged ON public.cells FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: cells cells_insert_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS cells_insert_privileged ON public.cells;
CREATE POLICY cells_insert_privileged ON public.cells FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: cells cells_select_authenticated; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS cells_select_authenticated ON public.cells;
CREATE POLICY cells_select_authenticated ON public.cells FOR SELECT TO authenticated USING (true);

-- Name: cells cells_update_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS cells_update_privileged ON public.cells;
CREATE POLICY cells_update_privileged ON public.cells FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: device_submodels; Type: ROW SECURITY; Schema: public; Owner: -
ALTER TABLE public.device_submodels ENABLE ROW LEVEL SECURITY;

-- Name: device_submodels device_submodels_delete_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS device_submodels_delete_privileged ON public.device_submodels;
CREATE POLICY device_submodels_delete_privileged ON public.device_submodels FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: device_submodels device_submodels_insert_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS device_submodels_insert_privileged ON public.device_submodels;
CREATE POLICY device_submodels_insert_privileged ON public.device_submodels FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: device_submodels device_submodels_select_authenticated; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS device_submodels_select_authenticated ON public.device_submodels;
CREATE POLICY device_submodels_select_authenticated ON public.device_submodels FOR SELECT TO authenticated USING (true);

-- Name: device_submodels device_submodels_update_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS device_submodels_update_privileged ON public.device_submodels;
CREATE POLICY device_submodels_update_privileged ON public.device_submodels FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: devices; Type: ROW SECURITY; Schema: public; Owner: -
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;

-- Name: devices devices_delete_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS devices_delete_privileged ON public.devices;
CREATE POLICY devices_delete_privileged ON public.devices FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: devices devices_insert_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS devices_insert_privileged ON public.devices;
CREATE POLICY devices_insert_privileged ON public.devices FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: devices devices_select_authenticated; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS devices_select_authenticated ON public.devices;
CREATE POLICY devices_select_authenticated ON public.devices FOR SELECT TO authenticated USING (true);

-- Name: devices devices_update_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS devices_update_privileged ON public.devices;
CREATE POLICY devices_update_privileged ON public.devices FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: digital_thread; Type: ROW SECURITY; Schema: public; Owner: -
ALTER TABLE public.digital_thread ENABLE ROW LEVEL SECURITY;

-- Name: digital_thread digital_thread_select_privileged_or_auditor; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS digital_thread_select_privileged_or_auditor ON public.digital_thread;
CREATE POLICY digital_thread_select_privileged_or_auditor ON public.digital_thread FOR SELECT TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text, 'Auditor'::text]));

-- Name: directory_services; Type: ROW SECURITY; Schema: public; Owner: -
ALTER TABLE public.directory_services ENABLE ROW LEVEL SECURITY;

-- Name: directory_services directory_services_delete_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS directory_services_delete_privileged ON public.directory_services;
CREATE POLICY directory_services_delete_privileged ON public.directory_services FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: directory_services directory_services_insert_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS directory_services_insert_privileged ON public.directory_services;
CREATE POLICY directory_services_insert_privileged ON public.directory_services FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: directory_services directory_services_select_authenticated; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS directory_services_select_authenticated ON public.directory_services;
CREATE POLICY directory_services_select_authenticated ON public.directory_services FOR SELECT TO authenticated USING (true);

-- Name: directory_services directory_services_update_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS directory_services_update_privileged ON public.directory_services;
CREATE POLICY directory_services_update_privileged ON public.directory_services FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: documents; Type: ROW SECURITY; Schema: public; Owner: -
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;

-- Name: documents documents_delete_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS documents_delete_privileged ON public.documents;
CREATE POLICY documents_delete_privileged ON public.documents FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: documents documents_insert_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS documents_insert_privileged ON public.documents;
CREATE POLICY documents_insert_privileged ON public.documents FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: documents documents_select_authenticated; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS documents_select_authenticated ON public.documents;
CREATE POLICY documents_select_authenticated ON public.documents FOR SELECT TO authenticated USING (true);

-- Name: documents documents_update_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS documents_update_privileged ON public.documents;
CREATE POLICY documents_update_privileged ON public.documents FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: gateways; Type: ROW SECURITY; Schema: public; Owner: -
ALTER TABLE public.gateways ENABLE ROW LEVEL SECURITY;

-- Name: gateways gateways_delete_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS gateways_delete_privileged ON public.gateways;
CREATE POLICY gateways_delete_privileged ON public.gateways FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: gateways gateways_insert_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS gateways_insert_privileged ON public.gateways;
CREATE POLICY gateways_insert_privileged ON public.gateways FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: gateways gateways_select_authenticated; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS gateways_select_authenticated ON public.gateways;
CREATE POLICY gateways_select_authenticated ON public.gateways FOR SELECT TO authenticated USING (true);

-- Name: gateways gateways_update_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS gateways_update_privileged ON public.gateways;
CREATE POLICY gateways_update_privileged ON public.gateways FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: iso22400_vocabulary; Type: ROW SECURITY; Schema: public; Owner: -
ALTER TABLE public.iso22400_vocabulary ENABLE ROW LEVEL SECURITY;

-- Name: iso22400_vocabulary iso22400_vocabulary_select_authenticated; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS iso22400_vocabulary_select_authenticated ON public.iso22400_vocabulary;
CREATE POLICY iso22400_vocabulary_select_authenticated ON public.iso22400_vocabulary FOR SELECT TO authenticated USING (true);

-- Name: metric_catalog; Type: ROW SECURITY; Schema: public; Owner: -
ALTER TABLE public.metric_catalog ENABLE ROW LEVEL SECURITY;

-- Name: metric_catalog metric_catalog_insert_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS metric_catalog_insert_privileged ON public.metric_catalog;
CREATE POLICY metric_catalog_insert_privileged ON public.metric_catalog FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: metric_catalog metric_catalog_select_authenticated; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS metric_catalog_select_authenticated ON public.metric_catalog;
CREATE POLICY metric_catalog_select_authenticated ON public.metric_catalog FOR SELECT TO authenticated USING (true);

-- Name: metric_catalog metric_catalog_update_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS metric_catalog_update_privileged ON public.metric_catalog;
CREATE POLICY metric_catalog_update_privileged ON public.metric_catalog FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: metric_groups; Type: ROW SECURITY; Schema: public; Owner: -
ALTER TABLE public.metric_groups ENABLE ROW LEVEL SECURITY;

-- Name: metric_groups metric_groups_insert_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS metric_groups_insert_privileged ON public.metric_groups;
CREATE POLICY metric_groups_insert_privileged ON public.metric_groups FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: metric_groups metric_groups_select_authenticated; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS metric_groups_select_authenticated ON public.metric_groups;
CREATE POLICY metric_groups_select_authenticated ON public.metric_groups FOR SELECT TO authenticated USING (true);

-- Name: metric_groups metric_groups_update_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS metric_groups_update_privileged ON public.metric_groups;
CREATE POLICY metric_groups_update_privileged ON public.metric_groups FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: mtconnect_vocabulary; Type: ROW SECURITY; Schema: public; Owner: -
ALTER TABLE public.mtconnect_vocabulary ENABLE ROW LEVEL SECURITY;

-- Name: mtconnect_vocabulary mtconnect_vocabulary_select_authenticated; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS mtconnect_vocabulary_select_authenticated ON public.mtconnect_vocabulary;
CREATE POLICY mtconnect_vocabulary_select_authenticated ON public.mtconnect_vocabulary FOR SELECT TO authenticated USING (true);

-- Name: opcua_vocabulary; Type: ROW SECURITY; Schema: public; Owner: -
ALTER TABLE public.opcua_vocabulary ENABLE ROW LEVEL SECURITY;

-- Name: opcua_vocabulary opcua_vocabulary_select_authenticated; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS opcua_vocabulary_select_authenticated ON public.opcua_vocabulary;
CREATE POLICY opcua_vocabulary_select_authenticated ON public.opcua_vocabulary FOR SELECT TO authenticated USING (true);

-- Name: permissions; Type: ROW SECURITY; Schema: public; Owner: -
ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;

-- Name: permissions permissions_select_authenticated; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS permissions_select_authenticated ON public.permissions;
CREATE POLICY permissions_select_authenticated ON public.permissions FOR SELECT TO authenticated USING (true);

-- Name: role_permissions; Type: ROW SECURITY; Schema: public; Owner: -
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

-- Name: role_permissions role_permissions_select_authenticated; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS role_permissions_select_authenticated ON public.role_permissions;
CREATE POLICY role_permissions_select_authenticated ON public.role_permissions FOR SELECT TO authenticated USING (true);

-- Name: roles; Type: ROW SECURITY; Schema: public; Owner: -
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;

-- Name: roles roles_select_authenticated; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS roles_select_authenticated ON public.roles;
CREATE POLICY roles_select_authenticated ON public.roles FOR SELECT TO authenticated USING (true);

-- Name: schemas; Type: ROW SECURITY; Schema: public; Owner: -
ALTER TABLE public.schemas ENABLE ROW LEVEL SECURITY;

-- Name: schemas schemas_delete_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS schemas_delete_privileged ON public.schemas;
CREATE POLICY schemas_delete_privileged ON public.schemas FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: schemas schemas_insert_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS schemas_insert_privileged ON public.schemas;
CREATE POLICY schemas_insert_privileged ON public.schemas FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: schemas schemas_select_authenticated; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS schemas_select_authenticated ON public.schemas;
CREATE POLICY schemas_select_authenticated ON public.schemas FOR SELECT TO authenticated USING (true);

-- Name: schemas schemas_update_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS schemas_update_privileged ON public.schemas;
CREATE POLICY schemas_update_privileged ON public.schemas FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

-- Name: user_roles; Type: ROW SECURITY; Schema: public; Owner: -
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- Name: user_roles user_roles_select_own_or_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS user_roles_select_own_or_privileged ON public.user_roles;
CREATE POLICY user_roles_select_own_or_privileged ON public.user_roles FOR SELECT TO authenticated USING (((user_id = (auth.uid())::text) OR public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])));

-- Name: webhook_endpoints; Type: ROW SECURITY; Schema: public; Owner: -
ALTER TABLE public.webhook_endpoints ENABLE ROW LEVEL SECURITY;

-- Name: webhook_endpoints webhook_endpoints_select_privileged; Type: POLICY; Schema: public; Owner: -
DROP POLICY IF EXISTS webhook_endpoints_select_privileged ON public.webhook_endpoints;
CREATE POLICY webhook_endpoints_select_privileged ON public.webhook_endpoints FOR SELECT TO authenticated USING (public.has_role(ARRAY['Administrator'::text]));

-- ---------------------------------------------------------------------------------------------
-- Privilege reset (must precede every GRANT below)
-- ---------------------------------------------------------------------------------------------
-- THIS IS A CORRECTNESS FIX, NOT BELT-AND-BRACES, and leaving it out is a silent privilege
-- escalation that the schema diff is what caught.
--
-- The Supabase image ships `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon,
-- authenticated` in `public`, so a freshly created table arrives already holding
-- SELECT/INSERT/UPDATE/DELETE/TRUNCATE for BOTH browser-facing roles before this file says a word.
-- The incremental migrations dealt with that by REVOKE-ing after each CREATE -- but a privilege
-- that has been revoked leaves NO trace in pg_dump, which records only positive grants. So a
-- baseline generated from a dump silently reinstates every one of those default grants and drops
-- every revoke.
--
-- Measured, not theorised: without this block the rebuilt database handed `anon` GRANT ALL on
-- cells, devices, digital_thread, documents, directory_services, device_submodels and every view,
-- and upgraded `authenticated` on digital_thread from SELECT to ALL -- on an append-only audit
-- table whose immutability is the point.
--
-- Resetting to nothing and letting the dumped GRANTs below re-establish the real ACL is what makes
-- the two databases equivalent. `postgres`, `service_role` and the supabase_* roles are
-- deliberately untouched: the migrations never managed those, and revoking them here would change
-- behaviour rather than preserve it.

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;

-- Name: FUNCTION active_schema_version(schema_id uuid); Type: ACL; Schema: public; Owner: -
GRANT ALL ON FUNCTION public.active_schema_version(schema_id uuid) TO anon;

GRANT ALL ON FUNCTION public.active_schema_version(schema_id uuid) TO authenticated;

GRANT ALL ON FUNCTION public.active_schema_version(schema_id uuid) TO service_role;

-- Name: FUNCTION custom_access_token_hook(event jsonb); Type: ACL; Schema: public; Owner: -
REVOKE ALL ON FUNCTION public.custom_access_token_hook(event jsonb) FROM PUBLIC;

GRANT ALL ON FUNCTION public.custom_access_token_hook(event jsonb) TO service_role;

GRANT ALL ON FUNCTION public.custom_access_token_hook(event jsonb) TO supabase_auth_admin;

-- Name: FUNCTION dispatch_device_quarantine_webhook(); Type: ACL; Schema: public; Owner: -
REVOKE ALL ON FUNCTION public.dispatch_device_quarantine_webhook() FROM PUBLIC;

GRANT ALL ON FUNCTION public.dispatch_device_quarantine_webhook() TO anon;

GRANT ALL ON FUNCTION public.dispatch_device_quarantine_webhook() TO authenticated;

GRANT ALL ON FUNCTION public.dispatch_device_quarantine_webhook() TO service_role;

-- Name: FUNCTION enforce_metric_catalog_immutability(); Type: ACL; Schema: public; Owner: -
GRANT ALL ON FUNCTION public.enforce_metric_catalog_immutability() TO anon;

GRANT ALL ON FUNCTION public.enforce_metric_catalog_immutability() TO authenticated;

GRANT ALL ON FUNCTION public.enforce_metric_catalog_immutability() TO service_role;

-- Name: FUNCTION enforce_metric_group_spelling(); Type: ACL; Schema: public; Owner: -
GRANT ALL ON FUNCTION public.enforce_metric_group_spelling() TO anon;

GRANT ALL ON FUNCTION public.enforce_metric_group_spelling() TO authenticated;

GRANT ALL ON FUNCTION public.enforce_metric_group_spelling() TO service_role;

-- Name: FUNCTION enforce_schema_version_provenance(); Type: ACL; Schema: public; Owner: -
GRANT ALL ON FUNCTION public.enforce_schema_version_provenance() TO anon;

GRANT ALL ON FUNCTION public.enforce_schema_version_provenance() TO authenticated;

GRANT ALL ON FUNCTION public.enforce_schema_version_provenance() TO service_role;

-- Name: FUNCTION ensure_cron_job(p_name text, p_schedule text, p_command text); Type: ACL; Schema: public; Owner: -
REVOKE ALL ON FUNCTION public.ensure_cron_job(p_name text, p_schedule text, p_command text) FROM PUBLIC;

GRANT ALL ON FUNCTION public.ensure_cron_job(p_name text, p_schedule text, p_command text) TO anon;

GRANT ALL ON FUNCTION public.ensure_cron_job(p_name text, p_schedule text, p_command text) TO authenticated;

GRANT ALL ON FUNCTION public.ensure_cron_job(p_name text, p_schedule text, p_command text) TO service_role;

-- Name: FUNCTION ensure_gateway_status_view(); Type: ACL; Schema: public; Owner: -
REVOKE ALL ON FUNCTION public.ensure_gateway_status_view() FROM PUBLIC;

GRANT ALL ON FUNCTION public.ensure_gateway_status_view() TO service_role;

-- Name: FUNCTION fork_schema(parent_schema_id uuid, change_description text); Type: ACL; Schema: public; Owner: -
REVOKE ALL ON FUNCTION public.fork_schema(parent_schema_id uuid, change_description text) FROM PUBLIC;

GRANT ALL ON FUNCTION public.fork_schema(parent_schema_id uuid, change_description text) TO authenticated;

GRANT ALL ON FUNCTION public.fork_schema(parent_schema_id uuid, change_description text) TO service_role;

-- Name: FUNCTION handle_new_user(); Type: ACL; Schema: public; Owner: -
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;

GRANT ALL ON FUNCTION public.handle_new_user() TO service_role;

-- Name: FUNCTION has_role(allowed_roles text[]); Type: ACL; Schema: public; Owner: -
REVOKE ALL ON FUNCTION public.has_role(allowed_roles text[]) FROM PUBLIC;

GRANT ALL ON FUNCTION public.has_role(allowed_roles text[]) TO authenticated;

GRANT ALL ON FUNCTION public.has_role(allowed_roles text[]) TO service_role;

-- Name: FUNCTION log_digital_thread_event(); Type: ACL; Schema: public; Owner: -
REVOKE ALL ON FUNCTION public.log_digital_thread_event() FROM PUBLIC;

GRANT ALL ON FUNCTION public.log_digital_thread_event() TO service_role;

-- Name: FUNCTION prevent_active_schema_mutation(); Type: ACL; Schema: public; Owner: -
GRANT ALL ON FUNCTION public.prevent_active_schema_mutation() TO anon;

GRANT ALL ON FUNCTION public.prevent_active_schema_mutation() TO authenticated;

GRANT ALL ON FUNCTION public.prevent_active_schema_mutation() TO service_role;

-- Name: FUNCTION publish_schema_version(draft_schema_id uuid); Type: ACL; Schema: public; Owner: -
REVOKE ALL ON FUNCTION public.publish_schema_version(draft_schema_id uuid) FROM PUBLIC;

GRANT ALL ON FUNCTION public.publish_schema_version(draft_schema_id uuid) TO authenticated;

GRANT ALL ON FUNCTION public.publish_schema_version(draft_schema_id uuid) TO service_role;

-- Name: FUNCTION schema_version_base_name(schema_name text); Type: ACL; Schema: public; Owner: -
GRANT ALL ON FUNCTION public.schema_version_base_name(schema_name text) TO anon;

GRANT ALL ON FUNCTION public.schema_version_base_name(schema_name text) TO authenticated;

GRANT ALL ON FUNCTION public.schema_version_base_name(schema_name text) TO service_role;

-- Name: TABLE asset_config; Type: ACL; Schema: public; Owner: -
GRANT ALL ON TABLE public.asset_config TO authenticated;

GRANT ALL ON TABLE public.asset_config TO service_role;

-- Name: TABLE cells; Type: ACL; Schema: public; Owner: -
GRANT ALL ON TABLE public.cells TO authenticated;

GRANT ALL ON TABLE public.cells TO service_role;

-- Name: TABLE devices; Type: ACL; Schema: public; Owner: -
GRANT ALL ON TABLE public.devices TO authenticated;

GRANT ALL ON TABLE public.devices TO service_role;

-- Name: TABLE gateways; Type: ACL; Schema: public; Owner: -
GRANT ALL ON TABLE public.gateways TO authenticated;

GRANT ALL ON TABLE public.gateways TO service_role;

-- Name: TABLE device_locations; Type: ACL; Schema: public; Owner: -
GRANT ALL ON TABLE public.device_locations TO service_role;

GRANT SELECT ON TABLE public.device_locations TO authenticated;

-- Name: TABLE device_submodels; Type: ACL; Schema: public; Owner: -
GRANT ALL ON TABLE public.device_submodels TO authenticated;

GRANT ALL ON TABLE public.device_submodels TO service_role;

-- Name: TABLE device_schemas; Type: ACL; Schema: public; Owner: -
GRANT ALL ON TABLE public.device_schemas TO authenticated;

GRANT ALL ON TABLE public.device_schemas TO service_role;

-- Name: TABLE digital_thread; Type: ACL; Schema: public; Owner: -
-- SELECT ONLY. The original chain reached this state by issuing `REVOKE INSERT, UPDATE, DELETE`
-- against a prior `GRANT ALL`, which silently left TRUNCATE, REFERENCES and TRIGGER behind --
-- and TRUNCATE bypasses RLS, so the SELECT policy did not constrain it. Granted positively here
-- so the privilege set is what it says it is. 0003 adds the trigger that also binds service_role,
-- and re-revokes for databases built before this line was corrected.
GRANT SELECT ON TABLE public.digital_thread TO authenticated;

GRANT ALL ON TABLE public.digital_thread TO service_role;

-- Name: SEQUENCE digital_thread_id_seq; Type: ACL; Schema: public; Owner: -
-- anon and authenticated are deliberately absent: audit rows are written exclusively by the
-- SECURITY DEFINER trigger, which runs as the owner and needs no grant to either.

GRANT ALL ON SEQUENCE public.digital_thread_id_seq TO service_role;

-- Name: TABLE directory_services; Type: ACL; Schema: public; Owner: -
GRANT ALL ON TABLE public.directory_services TO authenticated;

GRANT ALL ON TABLE public.directory_services TO service_role;

-- Name: TABLE documents; Type: ACL; Schema: public; Owner: -
GRANT ALL ON TABLE public.documents TO authenticated;

GRANT ALL ON TABLE public.documents TO service_role;

-- Name: TABLE gateway_status; Type: ACL; Schema: public; Owner: -
GRANT ALL ON TABLE public.gateway_status TO service_role;

GRANT SELECT ON TABLE public.gateway_status TO authenticated;

-- Name: TABLE iso22400_vocabulary; Type: ACL; Schema: public; Owner: -
GRANT ALL ON TABLE public.iso22400_vocabulary TO service_role;

GRANT SELECT ON TABLE public.iso22400_vocabulary TO authenticated;

-- Name: TABLE metric_catalog; Type: ACL; Schema: public; Owner: -
GRANT ALL ON TABLE public.metric_catalog TO authenticated;

GRANT ALL ON TABLE public.metric_catalog TO service_role;

-- Name: TABLE metric_groups; Type: ACL; Schema: public; Owner: -
GRANT ALL ON TABLE public.metric_groups TO authenticated;

GRANT ALL ON TABLE public.metric_groups TO service_role;

-- Name: TABLE mtconnect_vocabulary; Type: ACL; Schema: public; Owner: -
GRANT ALL ON TABLE public.mtconnect_vocabulary TO service_role;

GRANT SELECT ON TABLE public.mtconnect_vocabulary TO authenticated;

-- Name: TABLE opcua_vocabulary; Type: ACL; Schema: public; Owner: -
GRANT ALL ON TABLE public.opcua_vocabulary TO service_role;

GRANT SELECT ON TABLE public.opcua_vocabulary TO authenticated;

-- Name: TABLE permissions; Type: ACL; Schema: public; Owner: -
GRANT ALL ON TABLE public.permissions TO authenticated;

GRANT ALL ON TABLE public.permissions TO service_role;

-- Name: TABLE role_permissions; Type: ACL; Schema: public; Owner: -
GRANT ALL ON TABLE public.role_permissions TO authenticated;

GRANT ALL ON TABLE public.role_permissions TO service_role;

-- Name: TABLE roles; Type: ACL; Schema: public; Owner: -
GRANT ALL ON TABLE public.roles TO authenticated;

GRANT ALL ON TABLE public.roles TO service_role;

-- Name: SEQUENCE roles_id_seq; Type: ACL; Schema: public; Owner: -
GRANT ALL ON SEQUENCE public.roles_id_seq TO anon;

GRANT ALL ON SEQUENCE public.roles_id_seq TO authenticated;

GRANT ALL ON SEQUENCE public.roles_id_seq TO service_role;

-- Name: TABLE schemas; Type: ACL; Schema: public; Owner: -
GRANT ALL ON TABLE public.schemas TO authenticated;

GRANT ALL ON TABLE public.schemas TO service_role;

-- Name: TABLE telemetry; Type: ACL; Schema: public; Owner: -
GRANT ALL ON TABLE public.telemetry TO authenticated;

GRANT ALL ON TABLE public.telemetry TO service_role;

-- Name: TABLE user_roles; Type: ACL; Schema: public; Owner: -
GRANT ALL ON TABLE public.user_roles TO authenticated;

GRANT ALL ON TABLE public.user_roles TO service_role;

-- Name: TABLE webhook_endpoints; Type: ACL; Schema: public; Owner: -
GRANT ALL ON TABLE public.webhook_endpoints TO authenticated;

GRANT ALL ON TABLE public.webhook_endpoints TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 4b. EXECUTE parity for functions the incremental chain left open to PUBLIC
-- ---------------------------------------------------------------------------------------------
-- The privilege reset above revokes EXECUTE from PUBLIC on every function in `public`, which is
-- how the `GRANT ALL ... TO anon` that the image's default privileges hand out gets cleared. Six
-- functions had no explicit REVOKE in the incremental chain and therefore kept PostgreSQL's
-- default `EXECUTE TO PUBLIC`; the grants below restore exactly that, so this squash changes no
-- behaviour.
--
-- FIVE OF THE SIX ARE TRIGGER FUNCTIONS, for which the grant is inert -- a trigger is fired by the
-- executor, which does not check EXECUTE on the function it calls. Revoking them would be a
-- reasonable hardening pass in the spirit of the advisor work the chain already did, and it is
-- deliberately NOT bundled in here: a migration squash that also quietly tightened privileges
-- would be impossible to review as either one thing or the other.

GRANT EXECUTE ON FUNCTION public.enforce_metric_catalog_immutability()  TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_metric_group_spelling()        TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_schema_version_provenance()    TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.prevent_active_schema_mutation()       TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.schema_version_base_name(TEXT)         TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.active_schema_version(UUID)            TO PUBLIC;


-- ---------------------------------------------------------------------------------------------
-- 5. Realtime publication
-- ---------------------------------------------------------------------------------------------
-- `telemetry` is absent deliberately and is not an oversight: it is a postgres_fdw foreign table
-- whose rows enter TimescaleDB's WAL, never Supabase's. Adding it to the publication does not
-- error -- it silently emits nothing, which is the worse failure.
--
-- REPLICA IDENTITY FULL is required rather than cosmetic: Realtime evaluates RLS against the old
-- row too, and with the default identity it only has the primary key.
--
-- `digital_thread` IS ALSO ABSENT, AND FOR A DIFFERENT REASON -- it was published until this was
-- narrowed. An UNAUTHENTICATED subscriber still receives the change ENVELOPE: Realtime redacts
-- the payload to `{}` and attaches a 401, but the message itself arrives, so the mere FACT and
-- TIMING of a change leaks to anyone who can reach the socket. Kong's `key-auth` does not close
-- that: the anon key is a registered key that is necessarily shipped to every browser.
--
-- The envelope is upstream Realtime behaviour and cannot be fixed here, so what is available is
-- to publish less. `digital_thread` is the audit log -- it times quarantine decisions, approvals
-- and reconfiguration, which is the most operationally sensitive stream in the publication -- and
-- NOTHING SUBSCRIBES TO IT. All four consumers (Overview, Cells, Devices, Gateways) subscribe to
-- ['cells','gateways','devices'] only, so removing it costs no behaviour at all.
--
-- THIS IS NOT AN ACCESS CHANGE. A publication governs logical replication and nothing else: the
-- grants and the RLS policies on `digital_thread` are untouched, so authenticated users and API
-- clients read the audit log through PostgREST exactly as before. The Digital Thread tab already
-- refreshes by polling.
--
-- The residual, accepted knowingly: asset-edit timing still leaks through the three tables that
-- ARE published, because the dashboard genuinely needs them live.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime WITH (publish = 'insert, update, delete');
  END IF;
END $$;

-- SET TABLE is ABSOLUTE, not additive -- it replaces the publication's whole membership. That is
-- what lets this narrowing reach a database that already exists without a follow-up migration:
-- every boot replays this file, and the next replay drops `digital_thread` from the set. A
-- separate 0010 doing the removal would instead fight this statement forever, re-adding and
-- re-dropping the table on each boot (the 0030/0032 lesson).
--
-- ---------------------------------------------------------------------------------------------
-- THE MEMBERSHIP IS NOW COMPUTED, AND THE ABSOLUTENESS ABOVE IS EXACTLY WHY IT HAD TO BE.
--
-- `device_alerts` is created by 0023, which runs AFTER this file on every boot. A literal
-- `SET TABLE ..., public.device_alerts` therefore fails on a fresh database -- the table does not
-- exist yet -- and ON_ERROR_STOP=1 makes that a failed boot. But listing it nowhere is worse: this
-- statement is absolute, so the next replay of 0001 would silently DROP it from the publication
-- again, and the frontend's alert subscription would go dead on the second boot with nothing
-- logged. That is the 0030/0032 lesson arriving from the other direction.
--
-- So: the INTENDED set is declared here, and the statement publishes the intersection of that set
-- with the tables that actually exist. On a fresh database's first boot `device_alerts` is absent
-- and the publication comes up with three tables; 0023 then creates it and adds it itself, so
-- realtime works on that same boot. Every later boot finds it present and keeps it.
--
-- Adding a table to realtime means adding its name HERE as well as publishing it where it is
-- created. A table added only at its own migration lasts exactly until the next restart.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  -- Every table this platform intends to publish, in one place. Order is not significant.
  intended CONSTANT text[] := ARRAY['cells', 'gateways', 'devices', 'device_alerts'];
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
-- 6. Storage policies for the 3D model bucket -- MOVED OUT OF THIS FILE
-- ---------------------------------------------------------------------------------------------
-- They now live in `supabase/storage-policies.sql`, applied by the `supabase-storage-policies`
-- service (Compose) and Job (Helm) AFTER `supabase-storage` reports healthy.
--
-- THIS SECTION NUMBER IS DELIBERATELY LEFT IN PLACE. The policies were here, this is where a
-- reader looking for storage access control will come, and an empty gap between 5 and 7 would
-- read as an accident.
--
-- WHY THEY COULD NOT STAY. This section attached policies to `storage.objects` and relied on that
-- table existing from first boot, which was true only because `supabase/postgres:15.6.1.143`
-- shipped a STUB storage schema (buckets/objects/migrations). `supabase/postgres:17.6.1.160`
-- ships the schema EMPTY -- so this file aborted on `relation "storage.objects" does not exist`
-- and took the whole boot with it.
--
-- It is not an ordering problem that could be solved by moving this section later in the file:
-- `storage.objects` is created by storage-api's OWN migrations when the supabase-storage service
-- boots, and that service depends on db-init having COMPLETED. No migration can attach a policy
-- to a table that, by construction, cannot exist until every migration has finished.
--
-- Same reasoning that already put the bucket ROW in scripts/storage-init.mjs rather than here.
-- The parts of `storage` that a migration cannot own are exactly the parts storage-api creates
-- for itself, and the boundary moved when the image stopped shipping the stub.


-- ---------------------------------------------------------------------------------------------
-- 7. Structural self-checks
-- ---------------------------------------------------------------------------------------------
-- The two invariants that fail SILENTLY if the structure is wrong, so they are asserted rather
-- than assumed. A schema that is merely missing a table announces itself on the first query;
-- these two do not.

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

  -- Realtime evaluates RLS against the old row; with the default replica identity it only has
  -- the primary key, and change events are silently withheld rather than erroring.
  --
  -- THE SET IS DERIVED FROM THE PUBLICATION, NOT LISTED HERE. It was listed, and the list is what
  -- broke: narrowing the publication to drop `digital_thread` left this check still demanding FULL
  -- on a table that is no longer replicated, so section 5 and this assertion contradicted each
  -- other and db-init failed with a message about replica identity -- naming neither the
  -- publication nor the change that had actually been made. A check that restates a constant
  -- rather than reading it is a second source of truth, and it fails on the day the first one
  -- changes.
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

NOTIFY pgrst, 'reload schema';
