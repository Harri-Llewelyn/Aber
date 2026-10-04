-- =============================================================================================
-- Migration: 0001_baseline_schema.sql
-- Aber -- the schema baseline of release 1.0
-- =============================================================================================
--
-- The squashed structural baseline: pure DDL, generated from a pg_dump of a database the whole
-- chain before 1.0 built (the chain is kept under `supabase/migrations/archive/`). Baseline data
-- lives in `0002_seed_data.sql`.
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

-- Vault holds only secrets that must be read *from SQL* -- the webhook signing key and the keys
-- the pg_net callers attach to their requests. Neither browser-facing role may read the store,
-- so the revocation is part of the structure rather than of the seeding.
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
SELECT set_config('aber.bi_reader_password', :'bi_reader_password', false);

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
    v_password text := btrim(coalesce(current_setting('aber.bi_reader_password', true), ''));
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
--
-- `audit_trail`'s monthly partitions are NOT here. They are created at run time by the
-- function archived migration 0079 installs, so the months present on the day of the dump are not schema; the
-- partitioned parent and the DEFAULT partition are, and both are below.

-- public :: SCHEMA
CREATE SCHEMA IF NOT EXISTS public;


ALTER SCHEMA public OWNER TO pg_database_owner;

--

-- SCHEMA public :: COMMENT
COMMENT ON SCHEMA public IS 'standard public schema';

--

-- timescale :: SCHEMA
CREATE SCHEMA IF NOT EXISTS timescale;


ALTER SCHEMA timescale OWNER TO postgres;

--

-- active_schema_version(uuid) :: FUNCTION
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


ALTER FUNCTION public.active_schema_version(schema_id uuid) OWNER TO postgres;

--

-- FUNCTION active_schema_version(schema_id uuid) :: COMMENT
COMMENT ON FUNCTION public.active_schema_version(schema_id uuid) IS 'Follows a lineage forward from any version to the one currently in force. Returns the input unchanged when it is already active, is a draft, or has no published successor.';

--

-- approve_proposal(uuid) :: FUNCTION
CREATE OR REPLACE FUNCTION public.approve_proposal(p_proposal_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_proposal  public.change_proposals%ROWTYPE;
    v_device    public.devices%ROWTYPE;
    v_merged    public.devices%ROWTYPE;
    v_plate     public.device_nameplate%ROWTYPE;
    v_plate_new public.device_nameplate%ROWTYPE;
    v_area      public.areas%ROWTYPE;
    v_area_new  public.areas%ROWTYPE;
    v_cell      public.cells%ROWTYPE;
    v_cell_new  public.cells%ROWTYPE;
    v_gateway   public.gateways%ROWTYPE;
    v_gw_new    public.gateways%ROWTYPE;
    v_actor     uuid := auth.uid();
    v_allowed   text[];
    v_key       text;
    v_trail    bigint;
BEGIN
    -- The outer gate is the union of everybody who may decide anything; the lane's own gate below
    -- is the one that decides.
    IF NOT (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
            OR public.has_authority(ARRAY['cell:manage', 'gateway:manage'])) THEN
        RAISE EXCEPTION 'not permitted to decide change proposals'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_proposal FROM public.change_proposals
     WHERE id = p_proposal_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'proposal % not found', p_proposal_id USING ERRCODE = 'no_data_found';
    END IF;

    IF NOT public.may_decide_proposal(v_proposal.entity_type) THEN
        RAISE EXCEPTION 'not permitted to decide proposals on %', v_proposal.entity_type
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF v_proposal.status <> 'open' THEN
        RAISE EXCEPTION 'proposal % is already %', p_proposal_id, v_proposal.status
            USING ERRCODE = 'check_violation';
    END IF;

    -- Re-validated, not trusted: the patch may have been edited since the insert trigger checked
    -- it, and the allowlist may have narrowed.
    v_allowed := public.proposable_columns(v_proposal.entity_type);
    FOREACH v_key IN ARRAY ARRAY(SELECT jsonb_object_keys(v_proposal.patch)) LOOP
        IF NOT (v_key = ANY (v_allowed)) THEN
            RAISE EXCEPTION 'proposal % names % , which is not proposable on %',
                p_proposal_id, v_key, v_proposal.entity_type
                USING ERRCODE = 'invalid_parameter_value';
        END IF;
    END LOOP;

    -- Already true is not approvable: the repair is a rejection naming what happened.
    IF public.proposal_is_already_true(p_proposal_id) THEN
        RAISE EXCEPTION
            'this change is already in place -- somebody made it while the proposal was open; reject it with that as the reason rather than recording an approval that changes nothing'
            USING ERRCODE = 'check_violation';
    END IF;

    -- Attribute every trigger-written audit row in this transaction to the approver. SET LOCAL,
    -- so it is discarded at COMMIT.
    PERFORM set_config('aber.actor_id', v_actor::text, true);

    IF v_proposal.entity_type = 'devices' THEN
        SELECT * INTO v_device FROM public.devices
         WHERE id = v_proposal.entity_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'device % no longer exists', v_proposal.entity_id
                USING ERRCODE = 'no_data_found';
        END IF;

        SELECT * INTO v_merged FROM jsonb_populate_record(v_device, v_proposal.patch);

        UPDATE public.devices
           SET name              = v_merged.name,
               description       = v_merged.description,
               asset_type        = v_merged.asset_type,
               connection_method = v_merged.connection_method,
               cell_id           = v_merged.cell_id,
               area_id           = v_merged.area_id,
               location_scope    = v_merged.location_scope,
               model_3d_path     = v_merged.model_3d_path
         WHERE id = v_device.id;

    ELSIF v_proposal.entity_type = 'device_nameplate' THEN
        -- A device with no nameplate row yet is the normal case: the row is created by whoever
        -- first asserts something about the asset.
        INSERT INTO public.device_nameplate (device_id) VALUES (v_proposal.entity_id)
        ON CONFLICT (device_id) DO NOTHING;

        SELECT * INTO v_plate FROM public.device_nameplate
         WHERE device_id = v_proposal.entity_id FOR UPDATE;

        SELECT * INTO v_plate_new FROM jsonb_populate_record(v_plate, v_proposal.patch);

        UPDATE public.device_nameplate
           SET manufacturer_name                = v_plate_new.manufacturer_name,
               manufacturer_product_designation = v_plate_new.manufacturer_product_designation,
               manufacturer_product_type        = v_plate_new.manufacturer_product_type,
               serial_number                    = v_plate_new.serial_number,
               year_of_construction             = v_plate_new.year_of_construction,
               date_of_manufacture              = v_plate_new.date_of_manufacture,
               hardware_version                 = v_plate_new.hardware_version,
               firmware_version                 = v_plate_new.firmware_version,
               software_version                 = v_plate_new.software_version,
               country_of_origin                = v_plate_new.country_of_origin,
               uri_of_the_product               = v_plate_new.uri_of_the_product,
               updated_at                       = now(),
               -- The proposer: a nameplate is an assertion about the asset, and who made it is
               -- part of the record.
               updated_by                       = v_proposal.proposed_by
         WHERE device_id = v_proposal.entity_id;

    ELSIF v_proposal.entity_type = 'areas' THEN
        SELECT * INTO v_area FROM public.areas
         WHERE id = v_proposal.entity_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'area % no longer exists', v_proposal.entity_id
                USING ERRCODE = 'no_data_found';
        END IF;

        SELECT * INTO v_area_new FROM jsonb_populate_record(v_area, v_proposal.patch);

        -- `areas_name_topic_safe`, `areas_name_key` and `areas_icon_valid` run on this UPDATE, so a
        -- taken name, a topic separator or an unknown icon aborts the approval with the database's
        -- own sentence and the proposal stays open.
        UPDATE public.areas
           SET name        = v_area_new.name,
               description = v_area_new.description,
               icon        = v_area_new.icon
         WHERE id = v_area.id;

    ELSIF v_proposal.entity_type = 'cells' THEN
        SELECT * INTO v_cell FROM public.cells
         WHERE id = v_proposal.entity_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'cell % no longer exists', v_proposal.entity_id
                USING ERRCODE = 'no_data_found';
        END IF;

        SELECT * INTO v_cell_new FROM jsonb_populate_record(v_cell, v_proposal.patch);

        -- The table's CHECKs, the area foreign key and place_cell_in_its_area() run on this
        -- UPDATE, so an unknown icon, a deleted area or a place too close to a neighbour aborts
        -- the approval rather than being stored.
        UPDATE public.cells
           SET name        = v_cell_new.name,
               grafana_url = v_cell_new.grafana_url,
               icon        = v_cell_new.icon,
               area_id     = v_cell_new.area_id,
               plan_x      = v_cell_new.plan_x,
               plan_y      = v_cell_new.plan_y,
               description = v_cell_new.description
         WHERE id = v_cell.id;

    ELSIF v_proposal.entity_type = 'gateways' THEN
        SELECT * INTO v_gateway FROM public.gateways
         WHERE id = v_proposal.entity_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'gateway % no longer exists', v_proposal.entity_id
                USING ERRCODE = 'no_data_found';
        END IF;

        SELECT * INTO v_gw_new FROM jsonb_populate_record(v_gateway, v_proposal.patch);

        -- The location CHECKs guard this statement; a relocation that breaks one fails here, inside
        -- the approver's transaction, and the proposal stays open with the database's own sentence.
        UPDATE public.gateways
           SET name           = v_gw_new.name,
               description    = v_gw_new.description,
               cell_id        = v_gw_new.cell_id,
               area_id        = v_gw_new.area_id,
               location_scope = v_gw_new.location_scope,
               access_url     = v_gw_new.access_url
         WHERE id = v_gateway.id;

    END IF;
    -- No `schemas` or link branch: those lanes are withdrawn and may_decide_proposal() refuses
    -- them above.

    -- The row that names both parties; the target's own audit trigger records only the approver.
    -- causation_id is this transaction, which the trigger also stamped on the target's row, so
    -- the two group as one act.
    INSERT INTO public.audit_trail
        (entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
         causation_id, audit_domain)
    VALUES (
        v_proposal.entity_type,
        v_proposal.entity_id,
        'PROPOSAL_APPLIED',
        NULL,
        jsonb_build_object(
            'proposal_id',       v_proposal.id,
            'proposed_by',       v_proposal.proposed_by,
            'proposed_by_email', v_proposal.proposed_by_email,
            'approved_by',       v_actor,
            'patch',             v_proposal.patch,
            'rationale',         v_proposal.rationale
        ),
        v_actor,
        'user',
        txid_current(),
        public.audit_domain_for(v_proposal.entity_type, 'PROPOSAL_APPLIED')
    )
    RETURNING id INTO v_trail;

    PERFORM set_config('aber.proposal_transition', 'on', true);

    UPDATE public.change_proposals
       SET status = 'applied', decided_by = v_actor, decided_at = now(),
           applied_trail_id = v_trail
     WHERE id = p_proposal_id;

    RETURN jsonb_build_object(
        'id', p_proposal_id, 'status', 'applied', 'trail_id', v_trail
    );
END;
$$;


ALTER FUNCTION public.approve_proposal(p_proposal_id uuid) OWNER TO postgres;

--

-- FUNCTION approve_proposal(p_proposal_id uuid) :: COMMENT
COMMENT ON FUNCTION public.approve_proposal(p_proposal_id uuid) IS 'Approving IS applying: the lane''s own gate is re-checked server-side, the patch re-validated against proposable_columns(), and the change written in this transaction so every CHECK and foreign key on the target runs now -- an invalid change aborts the approval instead of becoming an audit record of something that did not happen. A proposal whose values are already in place is refused for the same reason. The PROPOSAL_APPLIED row names both parties and carries this transaction as its causation_id, as the target''s own audit row does, so the two group as one act.';

--

-- approve_quarantined_device(uuid, uuid, uuid, uuid, text, uuid, text, boolean, boolean, uuid, boolean) :: FUNCTION
CREATE OR REPLACE FUNCTION public.approve_quarantined_device(p_device_id uuid, p_actor_id uuid, p_gateway_id uuid DEFAULT NULL::uuid, p_merge_into_device_id uuid DEFAULT NULL::uuid, p_asset_name text DEFAULT NULL::text, p_cell_id uuid DEFAULT NULL::uuid, p_location_scope text DEFAULT NULL::text, p_set_cell boolean DEFAULT false, p_set_location_scope boolean DEFAULT false, p_area_id uuid DEFAULT NULL::uuid, p_set_area boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_quarantined public.devices%ROWTYPE;
  v_candidate   public.devices%ROWTYPE;
  v_result      public.devices%ROWTYPE;
  v_actor_role  text;
  v_cell        uuid := p_cell_id;
  v_area        uuid := p_area_id;
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
  PERFORM set_config('aber.actor_id', p_actor_id::text, true);

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

    -- Two named ids and a short transaction; the FOR UPDATE is what stops a concurrent approval
    -- racing this one into two live rows.
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
  -- Mirrors the scope CHECKs: a site-wide asset names neither cell nor area, an area-wide one
  -- names its area and no cell, a cell-scoped one names no area. Cleared here rather than left
  -- to a constraint violation the caller cannot interpret.
  IF p_set_location_scope AND p_location_scope = 'site_wide' THEN
    v_cell := NULL;
    v_area := NULL;
  ELSIF p_set_location_scope AND p_location_scope = 'area_wide' THEN
    v_cell := NULL;
    IF v_area IS NULL THEN
      RAISE EXCEPTION 'an area_wide device must name its area'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSIF p_set_location_scope THEN
    v_area := NULL;
  END IF;

  UPDATE public.devices
     SET is_quarantined    = false,
         quarantine_reason = NULL,
         gateway_id        = p_gateway_id,
         -- LOCATION IS OMITTED WHEN NOT ANSWERED, NEVER DEFAULTED. devices.cell_id is
         -- NULL-means-inherit with no column default, so writing a value the operator did not
         -- choose would switch inheritance off permanently for every device approved this way.
         -- The p_set_* flags are what distinguish "not supplied" from "explicitly cleared" --
         -- a plain NULL argument cannot express the difference. A wide scope clears the cell
         -- whether or not one was supplied, since the CHECK would refuse the pair.
         cell_id           = CASE WHEN p_set_cell OR (p_set_location_scope AND p_location_scope <> 'cell')
                                  THEN v_cell ELSE cell_id END,
         area_id           = CASE WHEN p_set_area OR p_set_location_scope THEN v_area ELSE area_id END,
         location_scope    = CASE WHEN p_set_location_scope THEN p_location_scope ELSE location_scope END,
         name              = COALESCE(NULLIF(btrim(COALESCE(p_asset_name, '')), ''), name)
   WHERE id = p_device_id
  RETURNING * INTO v_result;

  RETURN jsonb_build_object('merged', false, 'device', to_jsonb(v_result));
END;
$$;


ALTER FUNCTION public.approve_quarantined_device(p_device_id uuid, p_actor_id uuid, p_gateway_id uuid, p_merge_into_device_id uuid, p_asset_name text, p_cell_id uuid, p_location_scope text, p_set_cell boolean, p_set_location_scope boolean, p_area_id uuid, p_set_area boolean) OWNER TO postgres;

--

-- FUNCTION approve_quarantined_device(p_device_id uuid, p_actor_id uuid, p_gateway_id uuid, p_merge_into_device_id uuid, p_asset_name text, p_cell_id uuid, p_location_scope text, p_set_cell boolean, p_set_location_scope boolean, p_area_id uuid, p_set_area boolean) :: COMMENT
COMMENT ON FUNCTION public.approve_quarantined_device(p_device_id uuid, p_actor_id uuid, p_gateway_id uuid, p_merge_into_device_id uuid, p_asset_name text, p_cell_id uuid, p_location_scope text, p_set_cell boolean, p_set_location_scope boolean, p_area_id uuid, p_set_area boolean) IS 'Atomically approves or merges a quarantined device. Re-checks the actor role against public.user_roles and attributes the resulting audit_trail rows to that actor. Takes the three location scopes; location is written only when answered.';

--

-- archive_credential_is_set() :: FUNCTION
CREATE OR REPLACE FUNCTION public.archive_credential_is_set() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
    SELECT public.has_role(ARRAY['Administrator'])
       AND EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'archive_secret_access_key');
$$;


ALTER FUNCTION public.archive_credential_is_set() OWNER TO postgres;

--

-- FUNCTION archive_credential_is_set() :: COMMENT
COMMENT ON FUNCTION public.archive_credential_is_set() IS 'True when a cold archive credential is in the vault AND the caller may be told. False for everyone else, which reads as "not configured" -- correct for a page they cannot configure.';

--

-- archive_destination_guard() :: FUNCTION
CREATE OR REPLACE FUNCTION public.archive_destination_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
    v_written bigint;
BEGIN
    IF NEW.key NOT IN ('archive.endpoint', 'archive.bucket')
       OR NEW.value IS NOT DISTINCT FROM OLD.value
       -- Setting one for the first time is not a change.
       OR coalesce(OLD.value #>> '{}', '') = '' THEN
        RETURN NEW;
    END IF;

    BEGIN
        SELECT count(*) INTO v_written FROM timescale.telemetry_archive_manifest;
    EXCEPTION WHEN OTHERS THEN
        -- The historian is unreachable, so whether anything has been written cannot be known.
        -- ALLOWED, with a warning, rather than refused: refusing would make an unrelated outage
        -- block first-time configuration, and the destructive case this guards is a deliberate
        -- act by somebody who can read the warning.
        RAISE WARNING
            'the cold archive manifest could not be read, so % is being changed without checking '
            'whether objects have already been written under the old destination.', NEW.key;
        RETURN NEW;
    END;

    IF v_written > 0 THEN
        RAISE EXCEPTION
            '% cannot be changed: % object(s) are already catalogued under the current '
            'destination, and renaming it does not move them -- the manifest would point at a '
            'bucket nothing is in, while cold_archive --drop kept deleting the only other copy. '
            'Follow the destination change procedure in supabase/README.md.',
            NEW.key, v_written;
    END IF;

    RETURN NEW;
END;
$$;


ALTER FUNCTION public.archive_destination_guard() OWNER TO postgres;

--

-- FUNCTION archive_destination_guard() :: COMMENT
COMMENT ON FUNCTION public.archive_destination_guard() IS 'Refuses a change to the archive endpoint or bucket once anything has been written there. A trigger rather than a policy because RLS cannot see OLD and NEW at once, the same reason system_settings_read_only_guard() is one.';

--

-- assert_principal_not_revoked(uuid) :: FUNCTION
CREATE OR REPLACE FUNCTION public.assert_principal_not_revoked(p_principal_id uuid) RETURNS void
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.revoked_service_principals WHERE principal_id = p_principal_id) THEN
    RAISE EXCEPTION
      'principal % has been revoked, so a token for it would be refused on its first request. '
      'Reinstate it before issuing one.', p_principal_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;


ALTER FUNCTION public.assert_principal_not_revoked(p_principal_id uuid) OWNER TO postgres;

--

-- audit_domain_for(text, text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.audit_domain_for(p_entity_type text, p_action text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
    -- Identity and authority. Every act on these is Administrator-only to perform AND the table
    -- itself is Administrator-only to read, which is what makes the lane agree with its contents.
    WHEN p_entity_type IN ('service_principals', 'user_roles', 'system_settings')
      THEN 'security'

    -- The asset trail: the shopfloor's own history. CREDENTIAL_ISSUED lands here on `gateways`
    -- deliberately: a Manager may mint a host-run gateway's broker credential. `schemas` and
    -- `metric_catalog` are Administrator-only writes to tables every authenticated user reads.
    WHEN p_entity_type IN ('areas', 'cells', 'devices', 'gateways', 'links',
                           'schemas', 'device_nameplate', 'change_proposals',
                           'cell_links', 'gateway_links', 'device_links',
                           'metric_catalog')
      THEN 'asset'

    -- Fail-closed: a new entity_type nobody classified is restricted rather than exposed.
    ELSE 'security'
  END
$$;


ALTER FUNCTION public.audit_domain_for(p_entity_type text, p_action text) OWNER TO postgres;

--

-- FUNCTION audit_domain_for(p_entity_type text, p_action text) :: COMMENT
COMMENT ON FUNCTION public.audit_domain_for(p_entity_type text, p_action text) IS 'Which lane an audit_trail row belongs in. The rule is WHO MAY PERFORM the act, not what the act is about -- see 0070 -- with `schemas` (0120) and `metric_catalog` (0143) the exceptions, because their own tables are readable by every authenticated user. Unrecognised input is ''security'': the safe failure is a row a Shopfloor_Manager cannot see, not a privileged act they can.';

--

-- audit_telemetry_columns() :: FUNCTION
CREATE OR REPLACE FUNCTION public.audit_telemetry_columns() RETURNS text[]
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    SET search_path TO 'public'
    AS $$
    SELECT ARRAY[
        'last_heartbeat',
        'health_reported_at',
        'uptime_seconds',
        'load_1m',
        'mem_available_bytes',
        'disk_free_bytes',
        'flow_hash'
    ]::text[];
$$;


ALTER FUNCTION public.audit_telemetry_columns() OWNER TO postgres;

--

-- FUNCTION audit_telemetry_columns() :: COMMENT
COMMENT ON FUNCTION public.audit_telemetry_columns() IS 'The gateways columns a heartbeat rewrites: liveness and the health readings (0035), and flow_hash, whose change ingest_record_gateway_health() records as its own FLOW_DEPLOYED row. log_audit_trail_event() subtracts these before deciding whether an UPDATE is an event.';

--

-- audit_trail_backup_job_ids_matching(text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.audit_trail_backup_job_ids_matching(p_pattern text) RETURNS uuid[]
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT coalesce(array_agg(j.id), '{}'::uuid[])
    FROM public.backup_jobs j
    LEFT JOIN public.backups b ON b.id = j.backup_id
   WHERE p_pattern IS NOT NULL
     AND public.has_role(ARRAY['Administrator', 'Auditor'])
     AND (j.note ILIKE p_pattern OR b.stamp ILIKE p_pattern)
$$;


ALTER FUNCTION public.audit_trail_backup_job_ids_matching(p_pattern text) OWNER TO postgres;

--

-- FUNCTION audit_trail_backup_job_ids_matching(p_pattern text) :: COMMENT
COMMENT ON FUNCTION public.audit_trail_backup_job_ids_matching(p_pattern text) IS 'The ids of backup jobs whose note, or the stamp of the backup they produced, matches a LIKE pattern -- the two things the Backups page identifies a job by and neither of which is in its audit payload. For audit_trail_page()''s search. Administrator and Auditor only, matching the roles audit_trail_select_security admits, and an empty array rather than an error for anybody else because this is part of a query rather than a request of its own.';

--

-- audit_trail_page(integer, boolean, text, text, uuid[], timestamp with time zone, timestamp with time zone, timestamp with time zone, bigint, text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.audit_trail_page(p_limit integer DEFAULT 200, p_include_purged boolean DEFAULT false, p_entity_type text DEFAULT NULL::text, p_action text DEFAULT NULL::text, p_entity_ids uuid[] DEFAULT NULL::uuid[], p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_until timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_recorded_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id bigint DEFAULT NULL::bigint, p_search text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $_$
WITH term AS (
    SELECT CASE WHEN p_search IS NULL OR btrim(p_search) = '' THEN NULL ELSE btrim(p_search) END AS raw
),
pattern AS (
    -- The search as a LIKE pattern, built once. THE METACHARACTERS ARE ESCAPED: the box promises
    -- a substring of a name or an id, and an unescaped '%' would silently return the whole trail
    -- to somebody who typed a percentage into it. Backslash is the default LIKE escape, so the
    -- backslashes have to be doubled first or an escape would be introduced by the escaping.
    SELECT CASE
             WHEN t.raw IS NULL THEN NULL
             ELSE '%' || replace(replace(replace(t.raw, '\', '\\'), '%', '\%'), '_', '\_') || '%'
           END AS pattern,
           -- THE SAME TERM AS A ROW ID, when it is nothing but digits. 18 at most: bigint tops out
           -- at 19, and a cast that overflows raises rather than missing.
           CASE
             WHEN t.raw ~ '^[0-9]{1,18}$' THEN t.raw::bigint
             ELSE NULL
           END AS id_term
      FROM term t
),
-- MATERIALIZED, AND MEASURED. Without it Postgres inlines this CTE and the helper lands in the
-- per-row Filter of every partition scan -- a STABLE function is allowed to be called once and is
-- not promised to be. On 4,065 rows that took a search from 53ms to 583ms, which is the shape of
-- cost that looks like "the trail got big" rather than like a query doing the wrong thing.
q AS MATERIALIZED (
    SELECT p.pattern,
           p.id_term,
           public.audit_trail_user_ids_matching(p.pattern)        AS user_ids,
           public.audit_trail_backup_job_ids_matching(p.pattern)  AS job_ids
      FROM pattern p
),
matching AS (
    SELECT t.*,
           -- SIX TYPES, FIVE PROBES, and the mismatch is `device_nameplate`: it is keyed by its
           -- device's id, so `devices` answers for it. A type is listed here only if one of the
           -- probes below can be asked about its rows -- `user_roles` and `service_principals`
           -- are auth.users rows with no public table to read, and would otherwise answer "absent
           -- from all five" about a person who is perfectly present. An entity type whose table
           -- has been RETIRED is a third case this still does not answer: "the table is gone" is
           -- not "the row is gone", so `area_floors` remains drawn and cannot be hidden.
           t.entity_type IN ('areas', 'cells', 'gateways', 'devices', 'schemas', 'device_nameplate')
       AND NOT EXISTS (SELECT 1 FROM public.areas    a WHERE a.id = t.entity_id)
       AND NOT EXISTS (SELECT 1 FROM public.cells    c WHERE c.id = t.entity_id)
       AND NOT EXISTS (SELECT 1 FROM public.gateways g WHERE g.id = t.entity_id)
       AND NOT EXISTS (SELECT 1 FROM public.devices  d WHERE d.id = t.entity_id)
       AND NOT EXISTS (SELECT 1 FROM public.schemas  s WHERE s.id = t.entity_id)
               AS is_purged
      FROM public.audit_trail t
     CROSS JOIN q
     WHERE (p_entity_type IS NULL OR t.entity_type = p_entity_type)
       AND (p_action      IS NULL OR t.action      = p_action)
       AND (p_entity_ids  IS NULL OR t.entity_id   = ANY (p_entity_ids))
       AND (p_since       IS NULL OR t.recorded_at >= p_since)
       AND (p_until       IS NULL OR t.recorded_at <= p_until)
       -- THE ID AND THE NAME THE TIMELINE DRAWS. Both snapshots are read because an INSERT has
       -- only `new_data` and a DELETE only `old_data`, and an UPDATE that renames something is
       -- findable under either name, which is what somebody searching for the old one wants.
       AND (q.pattern IS NULL
            OR t.entity_id::text ILIKE q.pattern
            -- THE OTHER TWO IDS THE DRAWER SHOWS: this audit row, and the transaction that wrote
            -- it. Only when the term is nothing but digits, so this adds rows to a numeric search
            -- and changes no other one.
            OR (q.id_term IS NOT NULL
                AND (t.id = q.id_term OR t.causation_id = q.id_term))
            -- The person a role assignment is about, who is not in the payload. Empty for a caller
            -- who may not ask, which matches no row.
            OR t.entity_id = ANY (q.user_ids)
            -- The note and the produced backup's stamp, which are on two tables and in no payload.
            -- Empty on the same terms, and for the same reason.
            OR t.entity_id = ANY (q.job_ids)
            OR EXISTS (
                 SELECT 1
                   FROM unnest(ARRAY['name', 'sparkplug_id', 'schema_name',
                                     'label', 'key', 'role', 'stamp', 'origin']) AS f(field)
                  WHERE (t.new_data ->> f.field) ILIKE q.pattern
                     OR (t.old_data ->> f.field) ILIKE q.pattern
               ))
),
visible AS (
    SELECT * FROM matching
     WHERE (p_include_purged OR NOT is_purged)
       -- The cursor is applied here and not in `matching`: `purged_assets` and `total_matching` are
       -- counted over `matching` and are facts about everything the filters select, not about what
       -- is left after paging.
       AND (p_before_id IS NULL
            OR p_before_recorded_at IS NULL
            OR (recorded_at, id) < (p_before_recorded_at, p_before_id))
     ORDER BY recorded_at DESC, id DESC
     LIMIT greatest(1, least(coalesce(p_limit, 200), 1000))
)
SELECT jsonb_build_object(
    'events', coalesce(
        (SELECT jsonb_agg(
                  (to_jsonb(v) - 'is_purged')
                  -- HOW MANY ROWS THE TRANSACTION WROTE (0139), over the whole table and not the
                  -- page, so the drawer can tell a single-row act from a group whose other rows
                  -- the filters hide or a later page holds. One probe of
                  -- idx_audit_trail_causation per row on the page. Under the caller's own
                  -- policies, like the rows themselves: it is the number a reader could load.
                  -- Null where there is no causation: NULL is not a group, and counting it would
                  -- make every legacy row one act.
                  || jsonb_build_object('transaction_rows',
                       CASE WHEN v.causation_id IS NULL THEN NULL
                            ELSE (SELECT count(*) FROM public.audit_trail d
                                   WHERE d.causation_id = v.causation_id)
                       END)
                  ORDER BY v.recorded_at DESC, v.id DESC)
           FROM visible v),
        '[]'::jsonb),
    'purged_assets', (SELECT count(DISTINCT entity_id) FROM matching WHERE is_purged),
    -- HOW LONG THE TRAIL IS UNDER THESE FILTERS, so a reader holding one page knows what fraction
    -- of it that is. Counted under the SAME predicate `visible` opens with, minus the cursor and
    -- the limit -- so it does not move as the reader pages, and a page can never report more rows
    -- than the total it is a fraction of.
    'total_matching', (SELECT count(*) FROM matching WHERE p_include_purged OR NOT is_purged),
    -- KEPT, AND IT MEANS "THERE IS A NEXT PAGE". It used to mean "your view is cut off", which was
    -- the same thing when there was no way to ask for more. Callers that only ever showed a banner
    -- keep working unchanged.
    'truncated', (SELECT count(*) FROM visible) >= greatest(1, least(coalesce(p_limit, 200), 1000)),
    -- WHERE THE READER GOT TO, or null at the end of the trail. Null is the ONLY end-of-data
    -- signal a caller should trust: an empty `events` array with a non-null cursor cannot happen,
    -- but a full page that happens to be the last one is ordinary, so "fewer rows than I asked
    -- for" is not a reliable test and callers must not invent one.
    'next_cursor', CASE
        WHEN (SELECT count(*) FROM visible) >= greatest(1, least(coalesce(p_limit, 200), 1000))
        THEN (SELECT jsonb_build_object('recorded_at', v.recorded_at, 'id', v.id)
                FROM visible v ORDER BY v.recorded_at ASC, v.id ASC LIMIT 1)
        ELSE NULL
    END
);
$_$;


ALTER FUNCTION public.audit_trail_page(p_limit integer, p_include_purged boolean, p_entity_type text, p_action text, p_entity_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone, p_before_recorded_at timestamp with time zone, p_before_id bigint, p_search text) OWNER TO postgres;

--

-- FUNCTION audit_trail_page(p_limit integer, p_include_purged boolean, p_entity_type text, p_action text, p_entity_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone, p_before_recorded_at timestamp with time zone, p_before_id bigint, p_search text) :: COMMENT
COMMENT ON FUNCTION public.audit_trail_page(p_limit integer, p_include_purged boolean, p_entity_type text, p_action text, p_entity_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone, p_before_recorded_at timestamp with time zone, p_before_id bigint, p_search text) IS 'One page of the Audit Trail, with deleted entities filtered server-side and counted over the whole match rather than the page. `total_matching` is how many rows the filters select in total, under the same purged rule as the page, so a reader knows what fraction of the trail they hold. Keyset paged on (recorded_at DESC, id DESC): pass the previous response''s `next_cursor` back as p_before_recorded_at/p_before_id. A null next_cursor is the only end-of-data signal. `p_search` matches the entity id and the audit-snapshot fields the timeline labels a lane from, so an entity is findable by the name the page shows for it; LIKE metacharacters in it are literal. A term of 1 to 18 digits ALSO matches the audit row''s own id and its causation_id (0121), which is how the other two ids the event drawer shows are searchable; it is an additional disjunct, so a numeric name still matches by name. `transaction_rows` on each event is how many rows share its causation_id, counted over the whole table under the caller''s own policies rather than over the page, and null where there is no causation (0139). Two labels are not in any payload and are matched through a SECURITY DEFINER helper each: the person a role assignment is about (0115), and a backup job''s note and the stamp of the backup it produced (0118). `is_purged` applies to areas, cells, gateways, devices, schemas and device nameplates -- every entity type this function can probe a table for. A type with no readable table behind it (user_roles and service_principals, which are auth.users rows; area_floors, whose table was retired) is never called deleted. `purged_assets` keeps its wire name and counts all of them.';

--

-- audit_trail_user_ids_matching(text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.audit_trail_user_ids_matching(p_pattern text) RETURNS uuid[]
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT coalesce(array_agg(u.id), '{}'::uuid[])
    FROM auth.users u
   WHERE p_pattern IS NOT NULL
     AND public.has_role(ARRAY['Administrator', 'Auditor'])
     AND u.email ILIKE p_pattern
$$;


ALTER FUNCTION public.audit_trail_user_ids_matching(p_pattern text) OWNER TO postgres;

--

-- FUNCTION audit_trail_user_ids_matching(p_pattern text) :: COMMENT
COMMENT ON FUNCTION public.audit_trail_user_ids_matching(p_pattern text) IS 'The ids of people whose email matches a LIKE pattern, for the one disjunct of audit_trail_page()''s search that cannot read its answer out of an audit payload: a role-assignment row names the role, and the dashboard labels that lane with the person (0116). Administrator and Auditor only, and an empty array rather than an error for anybody else, because this is part of a query rather than a request of its own.';

--

-- auth_pre_request() :: FUNCTION
CREATE OR REPLACE FUNCTION public.auth_pre_request() RETURNS void
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_claims text;
  v_jti    text;
  v_sub    text;
BEGIN
  -- NO CLAIMS IS THE COMMON CASE, NOT AN ANOMALY. Every unauthenticated request arrives here with
  -- this GUC unset -- the `true` argument is what makes that return NULL instead of raising.
  v_claims := current_setting('request.jwt.claims', true);
  IF v_claims IS NULL OR v_claims = '' THEN
    RETURN;
  END IF;

  BEGIN
    v_jti := (v_claims::jsonb) ->> 'jti';
    v_sub := (v_claims::jsonb) ->> 'sub';
  EXCEPTION WHEN others THEN
    -- CLAIMS THAT WILL NOT PARSE ARE NOT THIS FUNCTION'S BUSINESS. PostgREST has already validated
    -- the signature to get here, so malformed JSON in this GUC is a PostgREST-side surprise rather
    -- than an attack this can meaningfully answer -- and raising would take the whole API down
    -- over a condition that has nothing to do with revocation.
    RETURN;
  END;

  -- ------------------------------------------------------------------------------------------
  -- The principal denylist, checked first
  -- ------------------------------------------------------------------------------------------
  -- The order is about the message: after a principal revocation both arms match, and "this
  -- identity has been revoked" is the fact that explains both. The cast is guarded because `sub`
  -- is a claim, and a bare cast on a malformed one would abort every request through this hook.
  IF v_sub IS NOT NULL AND v_sub <> '' THEN
    BEGIN
      IF EXISTS (
        SELECT 1 FROM public.revoked_service_principals WHERE principal_id = v_sub::uuid
      ) THEN
        RAISE EXCEPTION 'this identity has been revoked'
          USING ERRCODE = 'insufficient_privilege',
                DETAIL = 'principal ' || v_sub,
                HINT   = 'The service principal this token names was withdrawn by an '
                         'Administrator. Every token naming it is refused, including ones issued '
                         'afterwards, until the principal is reinstated.';
      END IF;
    EXCEPTION
      -- RE-RAISED, NOT SWALLOWED. Only the CAST is being guarded here; the refusal above must
      -- travel. Catching everything would make the control silently fail open, which is the one
      -- failure mode a denylist must not have.
      WHEN insufficient_privilege THEN RAISE;
      WHEN invalid_text_representation THEN NULL;
    END;
  END IF;

  -- ------------------------------------------------------------------------------------------
  -- The token denylist (0074)
  -- ------------------------------------------------------------------------------------------
  -- A token with no `jti` (every human session, the anon and service_role keys) is unrevokable by
  -- this arm and must still be served. The subject arm above does not share that exemption.
  IF v_jti IS NOT NULL AND v_jti <> '' AND EXISTS (
    SELECT 1 FROM public.revoked_service_tokens
     WHERE jti = v_jti AND expires_at > now()
  ) THEN
    RAISE EXCEPTION 'this token has been revoked'
      USING ERRCODE = 'insufficient_privilege',
            DETAIL = 'jti ' || v_jti,
            HINT   = 'This credential was withdrawn by an Administrator. Minting a new token is '
                     'the only way back; the revoked one cannot be reinstated.';
  END IF;
END;
$$;


ALTER FUNCTION public.auth_pre_request() OWNER TO postgres;

--

-- FUNCTION auth_pre_request() :: COMMENT
COMMENT ON FUNCTION public.auth_pre_request() IS 'PostgREST db-pre-request hook: aborts the request when the caller''s JWT carries a revoked jti (0074) or names a revoked service principal (0076). Returns quietly for every other condition -- no claims, unparseable claims, a token with no jti, a sub that is not a uuid -- because those are the ordinary majority and refusing them would take the whole API down.';

--

-- authorize_host_gateway_credential(uuid) :: FUNCTION
CREATE OR REPLACE FUNCTION public.authorize_host_gateway_credential(p_gateway_id uuid) RETURNS TABLE(sparkplug_id text, gateway_name text)
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


ALTER FUNCTION public.authorize_host_gateway_credential(p_gateway_id uuid) OWNER TO postgres;

--

-- FUNCTION authorize_host_gateway_credential(p_gateway_id uuid) :: COMMENT
COMMENT ON FUNCTION public.authorize_host_gateway_credential(p_gateway_id uuid) IS 'Gate for minting a HOST gateway''s broker credential: checks has_role(), refuses a Remote or archived gateway, and returns the generated sparkplug_id the account must be named after. The mirror of issue_gateway_enrollment_token(), which refuses exactly the gateways this accepts.';

--

-- backup_claim_job() :: FUNCTION
CREATE OR REPLACE FUNCTION public.backup_claim_job() RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_job public.backup_jobs;
BEGIN
    PERFORM public.require_backup_service_caller('backup_claim_job');

    SELECT * INTO v_job
      FROM public.backup_jobs
     WHERE status = 'PENDING'
     ORDER BY created_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    UPDATE public.backup_jobs
       SET status = 'RUNNING', started_at = now()
     WHERE id = v_job.id;

    RETURN to_jsonb(v_job) || jsonb_build_object('status', 'RUNNING', 'started_at', now());
END;
$$;


ALTER FUNCTION public.backup_claim_job() OWNER TO postgres;

--

-- FUNCTION backup_claim_job() :: COMMENT
COMMENT ON FUNCTION public.backup_claim_job() IS 'Take the oldest PENDING job, mark it RUNNING and return it, or NULL. The backup service''s poll.';

--

-- backup_fail(uuid, text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.backup_fail(p_job_id uuid, p_error text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_job public.backup_jobs;
BEGIN
    PERFORM public.require_backup_service_caller('backup_fail');

    UPDATE public.backup_jobs
       SET status = 'FAILED', finished_at = now(),
           error = left(coalesce(nullif(btrim(p_error), ''), 'unspecified failure'), 2000)
     WHERE id = p_job_id AND status IN ('PENDING', 'RUNNING')
    RETURNING * INTO v_job;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'backup_jobs', v_job.id, 'BACKUP_FAILED',
        jsonb_build_object('origin', v_job.origin, 'note', v_job.note, 'started_at', v_job.started_at),
        jsonb_build_object('status', 'FAILED', 'error', v_job.error),
        NULL, 'service', txid_current(), now()
    );
END;
$$;


ALTER FUNCTION public.backup_fail(p_job_id uuid, p_error text) OWNER TO postgres;

--

-- FUNCTION backup_fail(p_job_id uuid, p_error text) :: COMMENT
COMMENT ON FUNCTION public.backup_fail(p_job_id uuid, p_error text) IS 'Mark a job FAILED with what went wrong, and record BACKUP_FAILED. The service has already removed the partial files.';

--

-- backup_finalise(uuid, text, text, jsonb, bigint) :: FUNCTION
CREATE OR REPLACE FUNCTION public.backup_finalise(p_job_id uuid, p_stamp text, p_location text, p_components jsonb, p_size_bytes bigint) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_job       public.backup_jobs;
    v_backup_id uuid;
BEGIN
    PERFORM public.require_backup_service_caller('backup_finalise');

    SELECT * INTO v_job FROM public.backup_jobs WHERE id = p_job_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'backup_finalise: no backup job %', p_job_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF v_job.status <> 'RUNNING' THEN
        RAISE EXCEPTION 'backup_finalise: job % is %, not RUNNING', p_job_id, v_job.status
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    INSERT INTO public.backups (
        stamp, origin, note, requested_by, job_id, location, components, size_bytes, pinned, taken_at
    ) VALUES (
        p_stamp, v_job.origin, v_job.note, v_job.requested_by, v_job.id, p_location,
        coalesce(p_components, '[]'::jsonb), greatest(coalesce(p_size_bytes, 0), 0),
        v_job.origin = 'requested', coalesce(v_job.started_at, now())
    )
    RETURNING id INTO v_backup_id;

    UPDATE public.backup_jobs
       SET status = 'COMPLETED', finished_at = now(), backup_id = v_backup_id
     WHERE id = p_job_id;

    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'backups', v_backup_id, 'BACKUP_TAKEN', NULL,
        jsonb_build_object(
            'stamp',      p_stamp,
            'origin',     v_job.origin,
            'note',       v_job.note,
            'job_id',     v_job.id,
            'size_bytes', greatest(coalesce(p_size_bytes, 0), 0),
            'components', coalesce(p_components, '[]'::jsonb),
            'pinned',     v_job.origin = 'requested'
        ),
        NULL, 'service', txid_current(), now()
    );

    RETURN v_backup_id;
END;
$$;


ALTER FUNCTION public.backup_finalise(p_job_id uuid, p_stamp text, p_location text, p_components jsonb, p_size_bytes bigint) OWNER TO postgres;

--

-- FUNCTION backup_finalise(p_job_id uuid, p_stamp text, p_location text, p_components jsonb, p_size_bytes bigint) :: COMMENT
COMMENT ON FUNCTION public.backup_finalise(p_job_id uuid, p_stamp text, p_location text, p_components jsonb, p_size_bytes bigint) IS 'Record a finished backup: the backups row, the job COMPLETED, and BACKUP_TAKEN in the trail, in one transaction. A requested backup is born pinned.';

--

-- backup_forget(uuid, text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.backup_forget(p_backup_id uuid, p_reason text) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_backup public.backups;
BEGIN
    PERFORM public.require_backup_service_caller('backup_forget');

    DELETE FROM public.backups WHERE id = p_backup_id AND NOT pinned
    RETURNING * INTO v_backup;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'backups', v_backup.id, 'BACKUP_PRUNED',
        jsonb_build_object(
            'stamp', v_backup.stamp, 'origin', v_backup.origin, 'note', v_backup.note,
            'taken_at', v_backup.taken_at, 'size_bytes', v_backup.size_bytes
        ),
        jsonb_build_object('reason', p_reason),
        NULL, 'service', txid_current(), now()
    );

    RETURN true;
END;
$$;


ALTER FUNCTION public.backup_forget(p_backup_id uuid, p_reason text) OWNER TO postgres;

--

-- FUNCTION backup_forget(p_backup_id uuid, p_reason text) :: COMMENT
COMMENT ON FUNCTION public.backup_forget(p_backup_id uuid, p_reason text) IS 'Delete the row for a backup whose files are gone, and record BACKUP_PRUNED. Refuses a pinned backup: the files of one should not have been removed.';

--

-- backup_offsite_base() :: FUNCTION
CREATE OR REPLACE FUNCTION public.backup_offsite_base() RETURNS text
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
    v jsonb := (SELECT jsonb_object_agg(key, value) FROM public.system_settings
                 WHERE starts_with(key, 'backup_offsite.'));
BEGIN
    IF coalesce(v ->> 'backup_offsite.endpoint', '') = ''
       OR coalesce(v ->> 'backup_offsite.region', '') = ''
       OR coalesce(v ->> 'backup_offsite.bucket', '') = ''
       OR coalesce(v ->> 'backup_offsite.prefix', '') = ''
       OR coalesce(v ->> 'backup_offsite.access_key_id', '') = ''
       OR coalesce(v ->> 'backup_offsite.recipient', '') = ''
       OR NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'backup_offsite_secret_access_key') THEN
        RETURN NULL;
    END IF;
    RETURN rtrim(v ->> 'backup_offsite.endpoint', '/') || '/' || (v ->> 'backup_offsite.bucket') || '/'
        || (v ->> 'backup_offsite.prefix') || '/';
END;
$$;


ALTER FUNCTION public.backup_offsite_base() OWNER TO postgres;

--

-- FUNCTION backup_offsite_base() :: COMMENT
COMMENT ON FUNCTION public.backup_offsite_base() IS 'Where off-site copies go, <endpoint>/<bucket>/<prefix>/, or NULL while any of the six settings or the secret key is missing. Not callable through PostgREST.';

--

-- backup_offsite_credential_is_set() :: FUNCTION
CREATE OR REPLACE FUNCTION public.backup_offsite_credential_is_set() RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
    RETURN public.has_role(ARRAY['Administrator'])
       AND EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'backup_offsite_secret_access_key');
END;
$$;


ALTER FUNCTION public.backup_offsite_credential_is_set() OWNER TO postgres;

--

-- FUNCTION backup_offsite_credential_is_set() :: COMMENT
COMMENT ON FUNCTION public.backup_offsite_credential_is_set() IS 'True when the off-site backup credential is in the vault and the caller is an Administrator; false for everyone else.';

--

-- backup_offsite_destination() :: FUNCTION
CREATE OR REPLACE FUNCTION public.backup_offsite_destination() RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
    v_base text;
    v      jsonb;
BEGIN
    PERFORM public.require_backup_service_caller('backup_offsite_destination');
    v_base := public.backup_offsite_base();
    IF v_base IS NULL THEN
        RETURN NULL;
    END IF;
    v := (SELECT jsonb_object_agg(key, value) FROM public.system_settings WHERE starts_with(key, 'backup_offsite.'));
    RETURN jsonb_build_object(
        'base',          v_base,
        'endpoint',      rtrim(v ->> 'backup_offsite.endpoint', '/'),
        'region',        v ->> 'backup_offsite.region',
        'bucket',        v ->> 'backup_offsite.bucket',
        'prefix',        v ->> 'backup_offsite.prefix',
        'access_key_id', v ->> 'backup_offsite.access_key_id',
        'secret_key',    (SELECT decrypted_secret FROM vault.decrypted_secrets
                           WHERE name = 'backup_offsite_secret_access_key'),
        'recipients',    to_jsonb(regexp_split_to_array(btrim(v ->> 'backup_offsite.recipient'), '[\s,]+')),
        'path_style',    coalesce((v ->> 'backup_offsite.path_style')::boolean, false)
    );
END;
$$;


ALTER FUNCTION public.backup_offsite_destination() OWNER TO postgres;

--

-- FUNCTION backup_offsite_destination() :: COMMENT
COMMENT ON FUNCTION public.backup_offsite_destination() IS 'The off-site destination with its secret key, for the backup service alone, or NULL while it is incomplete.';

--

-- backup_offsite_health_rows() :: FUNCTION
CREATE OR REPLACE FUNCTION public.backup_offsite_health_rows() RETURNS TABLE(newest_stamp text, offsite_state text, age_seconds numeric)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
    v_base    text := public.backup_offsite_base();
    v_changed timestamptz;
BEGIN
    IF v_base IS NULL THEN
        RETURN;
    END IF;
    SELECT max(s.updated_at) INTO v_changed FROM public.system_settings s WHERE starts_with(s.key, 'backup_offsite.');
    RETURN QUERY
        SELECT b.stamp, b.offsite_state,
               CASE WHEN b.offsite_state = 'COPIED' AND starts_with(coalesce(b.offsite_location, ''), v_base)
                    THEN 0::numeric
                    ELSE EXTRACT(EPOCH FROM (now() - greatest(b.taken_at, v_changed)))::numeric
               END
          FROM public.backups b
         ORDER BY b.taken_at DESC, b.stamp DESC
         LIMIT 1;
END;
$$;


ALTER FUNCTION public.backup_offsite_health_rows() OWNER TO postgres;

--

-- FUNCTION backup_offsite_health_rows() :: COMMENT
COMMENT ON FUNCTION public.backup_offsite_health_rows() IS 'The row backup_offsite_health shows. SECURITY DEFINER so grafana_reader needs no privilege on backups, system_settings or the vault.';

--

-- backup_offsite_next() :: FUNCTION
CREATE OR REPLACE FUNCTION public.backup_offsite_next() RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
    v_base text;
BEGIN
    PERFORM public.require_backup_service_caller('backup_offsite_next');
    v_base := public.backup_offsite_base();
    IF v_base IS NULL THEN
        RETURN NULL;
    END IF;
    RETURN (
        SELECT jsonb_build_object('id', b.id, 'stamp', b.stamp, 'location', b.location)
          FROM public.backups b
         WHERE NOT (b.offsite_state = 'COPIED' AND starts_with(coalesce(b.offsite_location, ''), v_base))
           AND (b.offsite_state <> 'FAILED'
                OR b.offsite_attempted_at IS NULL
                OR b.offsite_attempted_at <= now()
                   - least(interval '1 minute' * power(2, least(greatest(b.offsite_attempts - 1, 0), 4)),
                           interval '15 minutes'))
         ORDER BY b.taken_at DESC, b.stamp DESC
         LIMIT 1
    );
END;
$$;


ALTER FUNCTION public.backup_offsite_next() OWNER TO postgres;

--

-- FUNCTION backup_offsite_next() :: COMMENT
COMMENT ON FUNCTION public.backup_offsite_next() IS 'The newest backup with no copy at the current off-site destination and no failure in its backoff, or NULL. The backup service''s poll, when it has no job to take.';

--

-- backup_offsite_record(uuid, text, jsonb, text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.backup_offsite_record(p_backup_id uuid, p_location text, p_objects jsonb, p_error text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
    PERFORM public.require_backup_service_caller('backup_offsite_record');
    IF p_error IS NULL THEN
        UPDATE public.backups
           SET offsite_state = 'COPIED', offsite_location = p_location,
               offsite_objects = coalesce(p_objects, '[]'::jsonb),
               offsite_copied_at = now(), offsite_attempted_at = now(),
               offsite_attempts = 0, offsite_error = NULL
         WHERE id = p_backup_id;
    ELSE
        UPDATE public.backups
           SET offsite_state = 'FAILED', offsite_attempted_at = now(),
               offsite_attempts = offsite_attempts + 1,
               offsite_error = left(coalesce(nullif(btrim(p_error), ''), 'unspecified failure'), 2000)
         WHERE id = p_backup_id;
    END IF;
END;
$$;


ALTER FUNCTION public.backup_offsite_record(p_backup_id uuid, p_location text, p_objects jsonb, p_error text) OWNER TO postgres;

--

-- FUNCTION backup_offsite_record(p_backup_id uuid, p_location text, p_objects jsonb, p_error text) :: COMMENT
COMMENT ON FUNCTION public.backup_offsite_record(p_backup_id uuid, p_location text, p_objects jsonb, p_error text) IS 'Record an off-site copy: COPIED with where and what, or FAILED with why. The backup service''s gate.';

--

-- backup_offsite_setting_guard() :: FUNCTION
CREATE OR REPLACE FUNCTION public.backup_offsite_setting_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $_$
DECLARE
    v_value text := CASE WHEN jsonb_typeof(NEW.value) = 'string' THEN NEW.value #>> '{}' END;
    v_rule  text;
BEGIN
    IF NOT starts_with(NEW.key, 'backup_offsite.') OR NEW.value IS NOT DISTINCT FROM OLD.value
       OR coalesce(v_value, '') = '' THEN
        RETURN NEW;
    END IF;

    v_rule := CASE NEW.key
        WHEN 'backup_offsite.endpoint' THEN
            CASE WHEN v_value !~ '^https?://[^\s/?#]+(/[^\s?#]*)?$'
                 THEN 'must be a URL with its scheme, such as https://s3.eu-west-2.amazonaws.com' END
        WHEN 'backup_offsite.region' THEN
            CASE WHEN v_value !~ '^[A-Za-z0-9_-]{1,64}$'
                 THEN 'must be a region name, such as eu-west-2' END
        WHEN 'backup_offsite.bucket' THEN
            CASE WHEN v_value !~ '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'
                 THEN 'must be an S3 bucket name: 3 to 63 lower-case letters, digits, dots and hyphens' END
        WHEN 'backup_offsite.prefix' THEN
            CASE WHEN length(v_value) > 200
                   OR v_value !~ '^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*$'
                 THEN 'must be segments of letters, digits, dots, hyphens and underscores separated by /, with no leading or trailing /' END
        WHEN 'backup_offsite.access_key_id' THEN
            CASE WHEN v_value !~ '^[A-Za-z0-9+/=._-]{1,128}$'
                 THEN 'must be an access key ID, with no spaces' END
        WHEN 'backup_offsite.recipient' THEN
            CASE WHEN btrim(v_value) !~ '^age1[ac-hj-np-z02-9]{58}([\s,]+age1[ac-hj-np-z02-9]{58})*$'
                 THEN 'must be one or more age public keys (age1 followed by 58 characters), separated by spaces' END
    END;

    IF v_rule IS NOT NULL THEN
        RAISE EXCEPTION '% %', NEW.key, v_rule USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$_$;


ALTER FUNCTION public.backup_offsite_setting_guard() OWNER TO postgres;

--

-- backup_prunable(integer) :: FUNCTION
CREATE OR REPLACE FUNCTION public.backup_prunable(p_retention_days integer) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
BEGIN
    PERFORM public.require_backup_service_caller('backup_prunable');

    -- Zero or less disables pruning, as BACKUP_RETENTION_DAYS=0 does in backup-databases.sh.
    IF coalesce(p_retention_days, 0) <= 0 THEN
        RETURN '[]'::jsonb;
    END IF;

    -- The floor: the newest three rows are never returned. Every row is a successful backup, so
    -- while backups are failing these are the last three good ones. The Backups page holds the
    -- same number (BACKUP_RETENTION_FLOOR), and check-docs-drift.mjs couples the two. The service
    -- deletes each returned row's off-site copy with its files, so the copies follow the floor too.
    RETURN coalesce((
        SELECT jsonb_agg(jsonb_build_object('id', b.id, 'stamp', b.stamp, 'location', b.location,
                                            'offsite_location', b.offsite_location) ORDER BY b.taken_at)
          FROM public.backups b
         WHERE NOT b.pinned
           AND b.taken_at < now() - make_interval(days => p_retention_days)
           AND b.id NOT IN (
               SELECT n.id FROM public.backups n ORDER BY n.taken_at DESC, n.stamp DESC LIMIT 3
           )
    ), '[]'::jsonb);
END;
$$;


ALTER FUNCTION public.backup_prunable(p_retention_days integer) OWNER TO postgres;

--

-- FUNCTION backup_prunable(p_retention_days integer) :: COMMENT
COMMENT ON FUNCTION public.backup_prunable(p_retention_days integer) IS 'The backups the retention window has expired and nobody has pinned, oldest first, never any of the newest three, each with where its off-site copy is. The service deletes each one''s files and copy, then calls backup_forget().';

--

-- backup_reconcile_jobs(text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.backup_reconcile_jobs(p_reason text) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_job  record;
    v_rows integer := 0;
BEGIN
    PERFORM public.require_backup_service_caller('backup_reconcile_jobs');

    -- A RUNNING row at service start is a backup the previous process did not finish; its files
    -- are partial and the service removes them. PENDING rows are left: the loop claims them.
    FOR v_job IN
        UPDATE public.backup_jobs
           SET status = 'FAILED', finished_at = now(),
               error  = left(coalesce(nullif(btrim(p_reason), ''), 'the backup service restarted'), 2000)
         WHERE status = 'RUNNING'
        RETURNING id, origin, started_at
    LOOP
        INSERT INTO public.audit_trail (
            entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
            causation_id, recorded_at
        ) VALUES (
            'backup_jobs', v_job.id, 'BACKUP_FAILED',
            jsonb_build_object('status', 'RUNNING', 'origin', v_job.origin, 'started_at', v_job.started_at),
            jsonb_build_object('status', 'FAILED', 'error', p_reason),
            NULL, 'service', txid_current(), now()
        );
        v_rows := v_rows + 1;
    END LOOP;

    RETURN v_rows;
END;
$$;


ALTER FUNCTION public.backup_reconcile_jobs(p_reason text) OWNER TO postgres;

--

-- FUNCTION backup_reconcile_jobs(p_reason text) :: COMMENT
COMMENT ON FUNCTION public.backup_reconcile_jobs(p_reason text) IS 'Fail every RUNNING job with the given reason. Called by the backup service at start and before each claim: a RUNNING job no service is running was interrupted, or came back in a restore from a backup taken while it ran; its files are partial or gone.';

--

-- backup_schedule(text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.backup_schedule(p_cron text) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO 'public', 'cron'
    AS $_$
BEGIN
    PERFORM public.require_backup_service_caller('backup_schedule');

    IF coalesce(btrim(p_cron), '') = '' THEN
        IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'enqueue_scheduled_backup') THEN
            PERFORM cron.unschedule('enqueue_scheduled_backup');
        END IF;
        RETURN false;
    END IF;

    PERFORM public.ensure_cron_job(
        'enqueue_scheduled_backup',
        p_cron,
        $job$SELECT public.enqueue_scheduled_backup()$job$
    );
    RETURN true;
END;
$_$;


ALTER FUNCTION public.backup_schedule(p_cron text) OWNER TO postgres;

--

-- FUNCTION backup_schedule(p_cron text) :: COMMENT
COMMENT ON FUNCTION public.backup_schedule(p_cron text) IS 'Register (or, given an empty schedule, remove) the pg_cron job that queues scheduled backups. Called by the backup service at start with BACKUP_SCHEDULE, so the schedule exists exactly where a service will take what it queues.';

--

-- cancel_backup_job(uuid) :: FUNCTION
CREATE OR REPLACE FUNCTION public.cancel_backup_job(p_job_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_job public.backup_jobs;
BEGIN
    IF NOT public.has_role(ARRAY['Administrator'::text]) THEN
        RAISE EXCEPTION 'cancel_backup_job: only an Administrator may cancel a backup'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- PENDING only. A RUNNING job is the service's: pg_dump is under way, and a row flipped under
    -- it would leave the job finishing into a state that says it did not.
    UPDATE public.backup_jobs
       SET status = 'CANCELLED', finished_at = now()
     WHERE id = p_job_id AND status = 'PENDING'
    RETURNING * INTO v_job;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'backup_jobs', v_job.id, 'BACKUP_CANCELLED',
        jsonb_build_object('status', 'PENDING', 'origin', v_job.origin, 'note', v_job.note),
        jsonb_build_object('status', 'CANCELLED'),
        auth.uid(), 'user', txid_current(), now()
    );

    RETURN true;
END;
$$;


ALTER FUNCTION public.cancel_backup_job(p_job_id uuid) OWNER TO postgres;

--

-- FUNCTION cancel_backup_job(p_job_id uuid) :: COMMENT
COMMENT ON FUNCTION public.cancel_backup_job(p_job_id uuid) IS 'Withdraw a queued backup before the service claims it. Administrator only. Returns false when the job was already claimed or finished, which is not an error.';

--

-- capped_capture_manifest(jsonb) :: FUNCTION
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


ALTER FUNCTION public.capped_capture_manifest(p_manifest jsonb) OWNER TO postgres;

--

-- claim_forge_sweep(integer) :: FUNCTION
CREATE OR REPLACE FUNCTION public.claim_forge_sweep(p_seconds integer) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_holder uuid;
BEGIN
    IF p_seconds IS NULL OR p_seconds NOT BETWEEN 1 AND 3600 THEN
        RAISE EXCEPTION 'claim_forge_sweep: a lease lasts 1 to 3600 seconds, not %', p_seconds
            USING ERRCODE = '22023';
    END IF;

    -- Two claims at once serialise on the row lock, and the second re-reads held_until after the
    -- first commits, so exactly one wins. A new pass sees every change made before it, so it
    -- clears `requested`.
    UPDATE public.forge_sweep_lease
       SET holder = gen_random_uuid(),
           held_until = clock_timestamp() + make_interval(secs => p_seconds),
           requested = false
     WHERE id AND held_until <= clock_timestamp()
    RETURNING holder INTO v_holder;

    IF v_holder IS NULL THEN
        UPDATE public.forge_sweep_lease SET requested = true WHERE id;
    END IF;
    RETURN v_holder;
END;
$$;


ALTER FUNCTION public.claim_forge_sweep(p_seconds integer) OWNER TO postgres;

--

-- FUNCTION claim_forge_sweep(p_seconds integer) :: COMMENT
COMMENT ON FUNCTION public.claim_forge_sweep(p_seconds integer) IS 'Claim the forge-sweep lease for p_seconds (1 to 3600). Returns the holder id, or null when another pass holds it, in which case `requested` is set so that pass''s release queues one more. A lease past its held_until is taken over.';

--

-- clear_backup_offsite_destination() :: FUNCTION
CREATE OR REPLACE FUNCTION public.clear_backup_offsite_destination() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
    IF NOT public.has_role(ARRAY['Administrator']) THEN
        RAISE EXCEPTION 'only an Administrator may remove the off-site backup destination'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM public.set_backup_offsite_destination('', '', '', '', '', '', false);
    DELETE FROM vault.secrets WHERE name = 'backup_offsite_secret_access_key';
END;
$$;


ALTER FUNCTION public.clear_backup_offsite_destination() OWNER TO postgres;

--

-- FUNCTION clear_backup_offsite_destination() :: COMMENT
COMMENT ON FUNCTION public.clear_backup_offsite_destination() IS 'Empty the off-site destination and delete its secret key from the vault. Administrator only. Copies already made are left in the bucket.';

--

-- clear_credential_revoked_on_enrolment() :: FUNCTION
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


ALTER FUNCTION public.clear_credential_revoked_on_enrolment() OWNER TO postgres;

--

-- cold_archive_backlog() :: FUNCTION
CREATE OR REPLACE FUNCTION public.cold_archive_backlog() RETURNS TABLE(enabled boolean, threshold_days integer, oldest_unexported timestamp with time zone, age_seconds numeric, overdue_seconds numeric)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
    SELECT b.enabled, b.threshold_days, b.oldest_unexported, b.age_seconds, b.overdue_seconds
      FROM public.cold_archive_backlog_state() b
     WHERE public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Auditor']);
$$;


ALTER FUNCTION public.cold_archive_backlog() OWNER TO postgres;

--

-- FUNCTION cold_archive_backlog() :: COMMENT
COMMENT ON FUNCTION public.cold_archive_backlog() IS 'The Cold Storage page''s header figure: when the unexported span begins, how old that is, and how far past archive.tier_after_days it has run. Up to one chunk interval overdue is normal.';

--

-- cold_archive_backlog_state() :: FUNCTION
CREATE OR REPLACE FUNCTION public.cold_archive_backlog_state() RETURNS TABLE(enabled boolean, threshold_days integer, oldest_unexported timestamp with time zone, age_seconds numeric, overdue_seconds numeric)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
    RETURN QUERY
    WITH policy AS (
        SELECT
            coalesce(
                (SELECT (value #>> '{}')::boolean
                   FROM public.system_settings WHERE key = 'archive.enabled'), false) AS enabled,
            coalesce(
                (SELECT (value #>> '{}')::integer
                   FROM public.system_settings WHERE key = 'archive.tier_after_days'), 90) AS threshold_days
    ),
    frontier AS (
        SELECT coalesce(
            -- The newest span known to be on the remote endpoint. `verified_at`, not `exported_at`:
            -- an exported row is an object nothing has read back, which is the state this alert
            -- exists to distinguish from success.
            (SELECT max(m.range_end)
               FROM timescale.telemetry_archive_manifest m
              WHERE m.verified_at IS NOT NULL),
            -- Nothing verified yet, so the unexported span begins at the oldest raw data.
            (SELECT f.oldest_data
               FROM timescale.storage_footprint f
              WHERE f.relation = 'telemetry' AND f.tier = 'raw')
        ) AS frontier_at
    )
    SELECT p.enabled,
           p.threshold_days,
           f.frontier_at,
           EXTRACT(EPOCH FROM (now() - f.frontier_at))::numeric,
           -- GREATEST returns the largest NON-NULL argument, so an empty historian -- no manifest
           -- and no raw data -- reports 0 overdue rather than NULL, and the alert stays quiet on a
           -- stack that has never ingested anything.
           greatest(
               0::numeric,
               EXTRACT(EPOCH FROM (now() - f.frontier_at))::numeric
                 - (p.threshold_days::numeric * 86400)
           )
      FROM policy p, frontier f;
EXCEPTION
    -- The historian is unreachable, or its manifest has not been created yet. Both mean "this
    -- cannot be computed", which is not the same as zero and must not be reported as it.
    WHEN OTHERS THEN
        RETURN;
END;
$$;


ALTER FUNCTION public.cold_archive_backlog_state() OWNER TO postgres;

--

-- FUNCTION cold_archive_backlog_state() :: COMMENT
COMMENT ON FUNCTION public.cold_archive_backlog_state() IS 'How far the cold archive has fallen behind, measured from the newest verified range_end over the FDW. Internal: EXECUTE is revoked, and the two wrappers gate it for their own audience.';

--

-- cold_archive_destination() :: FUNCTION
CREATE OR REPLACE FUNCTION public.cold_archive_destination() RETURNS TABLE(endpoint text, region text, bucket text, access_key_id text, secret_key text, path_style boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
    SELECT
        coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'archive.endpoint'), ''),
        coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'archive.region'), ''),
        coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'archive.bucket'), ''),
        coalesce((SELECT value #>> '{}' FROM public.system_settings WHERE key = 'archive.access_key_id'), ''),
        coalesce((SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'archive_secret_access_key'), ''),
        coalesce((SELECT (value #>> '{}')::boolean FROM public.system_settings WHERE key = 'archive.path_style'), false)
    -- `archive.site_key` is deliberately NOT here. It is not sensitive, the exporter already reads
    -- it with the other archive.* settings, and a fact returned from two places is a fact that
    -- will eventually differ between them.
    WHERE public.is_ingestion_caller();
$$;


ALTER FUNCTION public.cold_archive_destination() OWNER TO postgres;

--

-- FUNCTION cold_archive_destination() :: COMMENT
COMMENT ON FUNCTION public.cold_archive_destination() IS 'The cold archive''s destination including its secret, for the ingestion principal alone (0046). Returns no row to anybody else, so a caller without that identity learns nothing rather than being refused with a message that confirms the shape of what it holds.';

--

-- cold_storage_rows() :: FUNCTION
CREATE OR REPLACE FUNCTION public.cold_storage_rows() RETURNS TABLE(chunk_name text, range_start timestamp with time zone, range_end timestamp with time zone, row_count bigint, object_key text, object_bytes bigint, state text, on_cold_storage boolean, claimed_at timestamp with time zone, dropped_at timestamp with time zone, last_error text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
    -- Gated on Administrator, Shopfloor_Manager and Auditor, checked here because a hidden tab is
    -- not a gate and this function is SECURITY DEFINER.
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


ALTER FUNCTION public.cold_storage_rows() OWNER TO postgres;

--

-- FUNCTION cold_storage_rows() :: COMMENT
COMMENT ON FUNCTION public.cold_storage_rows() IS 'The cold telemetry catalogue, read over the FDW from the historian''s manifest. `state` is derived here so no consumer re-implements the claimed->exported->verified->dropped ordering that timescaledb/cold_archive.sql enforces with CHECK constraints.';

--

-- consume_gateway_enrollment_token(text) :: FUNCTION
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


ALTER FUNCTION public.consume_gateway_enrollment_token(p_token text) OWNER TO postgres;

--

-- FUNCTION consume_gateway_enrollment_token(p_token text) :: COMMENT
COMMENT ON FUNCTION public.consume_gateway_enrollment_token(p_token text) IS 'Atomically claim a live enrolment token and return the gateway''s wire identity. Returns NO ROWS for an unknown, expired, already-consumed token or an ARCHIVED gateway (0037) -- the four are deliberately indistinguishable. Called by the enroll-gateway edge function with the service-role key; the token itself is the authorisation, so no role is checked.';

--

-- create_machine_principal(text, text[], text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.create_machine_principal(p_name text, p_permissions text[], p_purpose text DEFAULT NULL::text) RETURNS TABLE(principal_id uuid, permissions text[])
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    -- Machines propose, people decide. An allow-list, so a permission added later is refused
    -- until somebody decides a machine may hold it. check-docs-drift.mjs asserts the Access
    -- Control page offers exactly this list (11e) and that each entry reaches a machine (11f).
    c_allowed CONSTANT text[] := ARRAY['telemetry:read', 'quarantine:view', 'audit_trail:read',
                                       'archive:manage', 'proposal:create', 'schema:manage'];
    v_id      uuid;
    v_name    text := btrim(p_name);
    v_purpose text := nullif(btrim(coalesce(p_purpose, '')), '');
    v_refused text;
    v_ids     uuid[];
BEGIN
    -- ADMINISTRATOR ONLY. Creating an identity that can reach the stack is an access-control act,
    -- and `authz:manage` is granted to Administrator alone.
    IF NOT public.has_role(ARRAY['Administrator']) THEN
        RAISE EXCEPTION 'insufficient privileges to create a machine principal'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF v_name IS NULL OR length(v_name) = 0 THEN
        RAISE EXCEPTION
            'create_machine_principal: a name is required. An identity nobody can name on the '
            'Access Control page is one nobody can decide to keep or remove.'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF length(v_name) > 80 THEN
        RAISE EXCEPTION 'create_machine_principal: p_name must be 80 characters or fewer'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF v_purpose IS NOT NULL AND length(v_purpose) > 500 THEN
        RAISE EXCEPTION 'create_machine_principal: p_purpose must be 500 characters or fewer'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Checked before the identity exists, so the refusal names the name and not a constraint.
    IF EXISTS (SELECT 1 FROM public.machine_principals mp WHERE lower(btrim(mp.name)) = lower(v_name)) THEN
        RAISE EXCEPTION
            'create_machine_principal: an identity named "%" already exists. Names are unique '
            'ignoring case, so the page never lists two rows a reader cannot tell apart.', v_name
            USING ERRCODE = 'unique_violation';
    END IF;

    IF p_permissions IS NULL OR cardinality(p_permissions) = 0 THEN
        RAISE EXCEPTION
            'create_machine_principal: at least one permission is required. A principal with no '
            'authority can still be named by a token, which makes it a credential that looks '
            'harmless and is not accounted for anywhere.'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Each refused permission once, in the order asked, with the rule that refuses it.
    SELECT string_agg(format('%s (%s)', r.perm, CASE
               WHEN NOT EXISTS (SELECT 1 FROM public.permissions p WHERE p.name = r.perm)
                 THEN 'no such permission'
               WHEN r.perm = 'device:manage'
                 THEN 'device writes are made by people'
               WHEN r.perm IN ('quarantine:approve', 'quarantine:reject')
                 THEN 'quarantine decisions are made by people'
               WHEN r.perm IN ('cell:manage', 'gateway:manage')
                 THEN 'for a machine it would only decide change proposals, and deciding is a '
                      'person''s act: machines propose, people decide'
               WHEN r.perm = 'authz:manage'
                 THEN 'access control stays with people'
               WHEN r.perm IN ('link:manage', 'gitops:manage')
                 THEN 'no check a machine passes consults it, so the grant would do nothing'
               ELSE 'nobody has decided that a machine may hold it'
             END), '; ' ORDER BY r.first_at)
      INTO v_refused
      FROM (SELECT u.x AS perm, min(u.o) AS first_at
              FROM unnest(p_permissions) WITH ORDINALITY AS u(x, o)
             WHERE u.x <> ALL (c_allowed)
             GROUP BY u.x) AS r;

    IF v_refused IS NOT NULL THEN
        RAISE EXCEPTION
            'create_machine_principal: not grantable to a machine identity: %. Allowed: %.',
            v_refused, array_to_string(c_allowed, ', ')
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- BY NAME, not by a hardcoded id.
    SELECT array_agg(p.id) INTO v_ids
      FROM public.permissions p
     WHERE p.name = ANY (p_permissions);

    IF v_ids IS NULL OR cardinality(v_ids) <> cardinality(ARRAY(SELECT DISTINCT unnest(p_permissions))) THEN
        RAISE EXCEPTION 'create_machine_principal: one of % does not exist in public.permissions',
            array_to_string(p_permissions, ', ')
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    v_id := gen_random_uuid();

    -- ONLY `id`. This is what makes the account unable to sign in, and it is a property of the
    -- INSERT rather than of anybody's intent -- which is also what makes is_machine_principal()
    -- true for it, and therefore what routes it through principal_permissions from here on.
    INSERT INTO auth.users (id) VALUES (v_id);

    -- BY CONSTRAINT NAME, not by column list: `principal_id` is also this function's first output
    -- column, and PL/pgSQL refuses the column list as ambiguous.
    INSERT INTO public.principal_permissions (principal_id, permission_id)
    SELECT v_id, unnest(v_ids)
    ON CONFLICT ON CONSTRAINT principal_permissions_pkey DO NOTHING;

    -- The name, in the same transaction: an identity and its name either both exist or neither
    -- does.
    INSERT INTO public.machine_principals (principal_id, name, purpose, created_by)
    VALUES (v_id, v_name, v_purpose, auth.uid());

    -- ATTRIBUTED TO A PERSON: this is called by an Administrator with a session, so `auth.uid()` is
    -- the attribution rather than a claim.
    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'service_principals',
        v_id,
        'INSERT',
        NULL,
        jsonb_build_object(
            'name',        v_name,
            'purpose',     v_purpose,
            'permissions', to_jsonb(p_permissions),
            'can_sign_in', false
        ),
        auth.uid(),
        'user',
        txid_current(),
        now()
    );

    RETURN QUERY SELECT v_id, p_permissions;
END;
$$;


ALTER FUNCTION public.create_machine_principal(p_name text, p_permissions text[], p_purpose text) OWNER TO postgres;

--

-- FUNCTION create_machine_principal(p_name text, p_permissions text[], p_purpose text) :: COMMENT
COMMENT ON FUNCTION public.create_machine_principal(p_name text, p_permissions text[], p_purpose text) IS 'Create a machine identity that cannot sign in, holding permissions of its own and a name the Access Control page lists it by. Administrator only. Machines propose, people decide: allows telemetry:read, quarantine:view, audit_trail:read, archive:manage, proposal:create and schema:manage, and refuses every other permission with its reason -- device writes, quarantine decisions, deciding proposals and access control are made by people, and no check a machine passes consults link:manage or gitops:manage. revoke_service_token() and revoke_service_principal() withdraw what it creates at PostgREST, where every check those grants open is reached. The name is unique ignoring case. One form only: an overload whose extra arguments default makes every RPC call ambiguous.';

--

-- custom_access_token_hook(jsonb) :: FUNCTION
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


ALTER FUNCTION public.custom_access_token_hook(event jsonb) OWNER TO postgres;

--

-- delete_device_asset_config() :: FUNCTION
CREATE OR REPLACE FUNCTION public.delete_device_asset_config() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  -- SECURITY DEFINER, so the rows go whoever deletes the device: asset_config has a DELETE policy
  -- of its own, and a DELETE the policy filters leaves the rows behind without an error.
  DELETE FROM public.asset_config WHERE asset_id = OLD.sparkplug_id;
  RETURN OLD;
END $$;


ALTER FUNCTION public.delete_device_asset_config() OWNER TO postgres;

--

-- FUNCTION delete_device_asset_config() :: COMMENT
COMMENT ON FUNCTION public.delete_device_asset_config() IS 'Trigger function: removes a deleted device''s birth parameters from asset_config, whose asset_id is the device''s sparkplug_id with no foreign key to cascade through.';

--

-- describe_machine_principal(uuid, text, text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.describe_machine_principal(p_principal_id uuid, p_name text, p_purpose text DEFAULT NULL::text) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_actor   uuid;
    v_name    text := btrim(p_name);
    v_purpose text := nullif(btrim(coalesce(p_purpose, '')), '');
    v_old     public.machine_principals%ROWTYPE;
    v_id      bigint;
BEGIN
    IF NOT public.has_role(ARRAY['Administrator']) THEN
        RAISE EXCEPTION 'insufficient privileges to describe a machine principal'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    v_actor := auth.uid();
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'describe_machine_principal: no session, so this could not be attributed'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF p_principal_id IS NULL THEN
        RAISE EXCEPTION 'describe_machine_principal: p_principal_id is required'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    IF v_name IS NULL OR length(v_name) = 0 THEN
        RAISE EXCEPTION 'describe_machine_principal: a name is required'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF length(v_name) > 80 THEN
        RAISE EXCEPTION 'describe_machine_principal: p_name must be 80 characters or fewer'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF v_purpose IS NOT NULL AND length(v_purpose) > 500 THEN
        RAISE EXCEPTION 'describe_machine_principal: p_purpose must be 500 characters or fewer'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- A ROW THAT EXISTS. A pinned identity has none, and the message says where its name lives
    -- rather than "not found", which would send a reader looking for a row that was never meant
    -- to be there. FOR UPDATE, so two edits of one row serialise.
    SELECT * INTO v_old
      FROM public.machine_principals mp
     WHERE mp.principal_id = p_principal_id
       FOR UPDATE;

    IF NOT FOUND THEN
        IF public.is_machine_principal(p_principal_id) THEN
            RAISE EXCEPTION
                'describe_machine_principal: % has no name row. It was pinned by a migration or '
                'seeded by a suite, and the dashboard names it from its own registry '
                '(frontend/src/utils/serviceIdentities.js).', p_principal_id
                USING ERRCODE = 'invalid_parameter_value';
        END IF;
        RAISE EXCEPTION
            'describe_machine_principal: % is not a machine principal. It either does not exist or '
            'it can sign in.', p_principal_id
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- Unique ignoring case, excluding the row being renamed: keeping one's own name is not a
    -- collision.
    IF EXISTS (
        SELECT 1 FROM public.machine_principals mp
         WHERE lower(btrim(mp.name)) = lower(v_name)
           AND mp.principal_id <> p_principal_id
    ) THEN
        RAISE EXCEPTION
            'describe_machine_principal: an identity named "%" already exists. Names are unique '
            'ignoring case, so the page never lists two rows a reader cannot tell apart.', v_name
            USING ERRCODE = 'unique_violation';
    END IF;

    -- NOTHING TO SAY IS NOT AN EVENT. An unchanged save writes no row and returns NULL, so the
    -- trail records decisions rather than clicks.
    IF v_old.name = v_name AND v_old.purpose IS NOT DISTINCT FROM v_purpose THEN
        RETURN NULL;
    END IF;

    UPDATE public.machine_principals
       SET name = v_name, purpose = v_purpose
     WHERE principal_id = p_principal_id;

    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'service_principals',
        p_principal_id,
        'PRINCIPAL_DESCRIBED',
        jsonb_build_object('name', v_old.name, 'purpose', v_old.purpose),
        jsonb_build_object('name', v_name,     'purpose', v_purpose),
        v_actor,
        'user',
        txid_current(),
        now()
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;


ALTER FUNCTION public.describe_machine_principal(p_principal_id uuid, p_name text, p_purpose text) OWNER TO postgres;

--

-- FUNCTION describe_machine_principal(p_principal_id uuid, p_name text, p_purpose text) :: COMMENT
COMMENT ON FUNCTION public.describe_machine_principal(p_principal_id uuid, p_name text, p_purpose text) IS 'Rename a machine principal created from the Access Control page, or change its purpose. Administrator only; the only write path to machine_principals after creation. Refuses an identity with no name row (the pinned ones, named by the dashboard''s registry) and a name another row holds. Records PRINCIPAL_DESCRIBED with the old and new values, and returns that row''s id, or NULL when nothing changed. Permissions are not editable: a wider grant is a new principal.';

--

-- directory_liveness_job_map() :: FUNCTION
CREATE OR REPLACE FUNCTION public.directory_liveness_job_map() RETURNS TABLE(prometheus_job text, service_name text)
    LANGUAGE sql IMMUTABLE
    AS $$
    SELECT * FROM (VALUES
        ('prometheus',     'Prometheus Metrics Store'),
        ('grafana',        'Grafana Dashboards'),
        ('ingestion',      'Ingestion Metrics Endpoint'),
        ('node',           'Host Metrics Exporter (node_exporter)'),
        ('supabase-envoy', 'Supabase API Gateway (Envoy)'),
        ('supabase-rest',  'Supabase PostgREST API'),
        ('supabase-db',    'Supabase PostgreSQL'),
        ('timescaledb',    'TimescaleDB Telemetry Store')
    ) AS t(prometheus_job, service_name);
$$;


ALTER FUNCTION public.directory_liveness_job_map() OWNER TO postgres;

--

-- FUNCTION directory_liveness_job_map() :: COMMENT
COMMENT ON FUNCTION public.directory_liveness_job_map() IS 'Prometheus scrape job -> directory_services.service_name, for the eight services whose liveness is genuinely observed. The job is the pod''s component name, as the chart''s Alloy labels it. Everything not named here is written UNKNOWN.';

--

-- discard_schema_draft(uuid) :: FUNCTION
CREATE OR REPLACE FUNCTION public.discard_schema_draft(p_schema_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_draft      public.schemas%ROWTYPE;
    v_detached   integer := 0;
    v_actor      uuid := auth.uid();
BEGIN
    -- THE SAME GATE `fork_schema()` AND `publish_schema_version()` CARRY SINCE 0087, and for the
    -- same reason: a SECURITY DEFINER function bypasses RLS entirely, so its own check is the only
    -- one there is. `schema:manage` rather than a role pair, so it cannot drift from the policy.
    IF NOT public.has_authority(ARRAY['schema:manage']) THEN
        RAISE EXCEPTION 'insufficient privileges to discard a schema draft'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO v_draft FROM public.schemas WHERE id = p_schema_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'schema % not found', p_schema_id USING ERRCODE = 'no_data_found';
    END IF;

    -- THE WHOLE REASON THIS FUNCTION EXISTS. An active or archived schema is part of the record of
    -- what devices were judged against, and deleting one would detach every device bound to it
    -- through two different foreign keys, silently.
    IF v_draft.status <> 'draft' THEN
        RAISE EXCEPTION
            'schema "%" is %, not a draft; only a draft can be discarded',
            v_draft.schema_name, v_draft.status
            USING ERRCODE = 'check_violation';
    END IF;

    -- Counted BEFORE the delete, because the CASCADE and the SET NULL are what detach them and
    -- neither reports anything. A draft can be attached to a machine to try it out, through either
    -- arm, so this is a real number rather than always zero. A device on both arms counts once.
    SELECT count(*) INTO v_detached
      FROM (SELECT d.id FROM public.devices d WHERE d.schema_id = p_schema_id
            UNION
            SELECT ds.device_id FROM public.device_submodels ds WHERE ds.schema_id = p_schema_id) attached;

    -- Attributes the audit row this DELETE fires to the person who asked for it. SET LOCAL, so it
    -- is discarded at COMMIT and cannot bleed into the connection's next user.
    PERFORM set_config('aber.actor_id', v_actor::text, true);

    DELETE FROM public.schemas WHERE id = p_schema_id;

    RETURN jsonb_build_object(
        'discarded_schema_id',   p_schema_id,
        'discarded_schema_name', v_draft.schema_name,
        'version',               v_draft.version,
        'parent_schema_id',      v_draft.parent_schema_id,
        'devices_detached',      v_detached
    );
END;
$$;


ALTER FUNCTION public.discard_schema_draft(p_schema_id uuid) OWNER TO postgres;

--

-- FUNCTION discard_schema_draft(p_schema_id uuid) :: COMMENT
COMMENT ON FUNCTION public.discard_schema_draft(p_schema_id uuid) IS 'Delete a draft schema version, returning it to the state before the fork. Refuses anything that is not a draft: devices.schema_id is ON DELETE SET NULL and device_submodels.schema_id is ON DELETE CASCADE, so deleting an active schema would silently detach every device bound to it. Returns the number of devices attached to the draft through either arm, each detached by the delete.';

--

-- dispatch_device_quarantine_webhook() :: FUNCTION
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
              'iss',   'aber-supabase',
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


ALTER FUNCTION public.dispatch_device_quarantine_webhook() OWNER TO postgres;

--

-- enforce_audit_trail_append_only() :: FUNCTION
CREATE OR REPLACE FUNCTION public.enforce_audit_trail_append_only() RETURNS trigger
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
    'public.audit_trail is append-only: % is not permitted (attempted by role %)',
    TG_OP, current_user
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'Audit rows are written only by log_audit_trail_event(). Correcting history '
                 'is not a supported operation; record a compensating change instead.';
END;
$$;


ALTER FUNCTION public.enforce_audit_trail_append_only() OWNER TO postgres;

--

-- FUNCTION enforce_audit_trail_append_only() :: COMMENT
COMMENT ON FUNCTION public.enforce_audit_trail_append_only() IS 'Rejects UPDATE and DELETE on public.audit_trail for every application role, including service_role. Owner roles are exempt because they can drop the trigger anyway.';

--

-- enforce_metric_catalog_immutability() :: FUNCTION
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


ALTER FUNCTION public.enforce_metric_catalog_immutability() OWNER TO postgres;

--

-- enforce_metric_group_spelling() :: FUNCTION
CREATE OR REPLACE FUNCTION public.enforce_metric_group_spelling() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  incoming_group TEXT;
  canonical TEXT;
BEGIN
  -- Derived from NEW.name rather than read from NEW.metric_group: generated columns are computed
  -- *after* BEFORE triggers run, so NEW.metric_group is still NULL at this point. Keep this
  -- expression identical to the generated column in archived migration 0016.
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


ALTER FUNCTION public.enforce_metric_group_spelling() OWNER TO postgres;

--

-- enforce_open_proposal_cap() :: FUNCTION
CREATE OR REPLACE FUNCTION public.enforce_open_proposal_cap() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_cap  integer;
    v_open integer;
BEGIN
    SELECT (value #>> '{}')::integer INTO v_cap
      FROM public.system_settings
     WHERE key = 'proposals.max_open_per_person';

    -- The setting is seeded by this migration and bounded at 1, so a NULL here means somebody
    -- deleted the row. Ten is the seeded default and the honest fallback: refusing every proposal
    -- because a setting is missing would take the feature away without saying so.
    v_cap := COALESCE(v_cap, 10);

    SELECT count(*) INTO v_open
      FROM public.change_proposals
     WHERE proposed_by = NEW.proposed_by
       AND status = 'open';

    IF v_open >= v_cap THEN
        RAISE EXCEPTION
            'you already have % open proposal(s), which is the limit; decide or withdraw one first',
            v_open
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;


ALTER FUNCTION public.enforce_open_proposal_cap() OWNER TO postgres;

--

-- FUNCTION enforce_open_proposal_cap() :: COMMENT
COMMENT ON FUNCTION public.enforce_open_proposal_cap() IS 'The per-person ceiling on OPEN proposals, read from system_settings. A trigger rather than a line in an RPC because the INSERT policy admits a direct PostgREST write, and a cap with a documented way around it is not a cap.';

--

-- enforce_schema_version_provenance() :: FUNCTION
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


ALTER FUNCTION public.enforce_schema_version_provenance() OWNER TO postgres;

--

-- enqueue_scheduled_backup() :: FUNCTION
CREATE OR REPLACE FUNCTION public.enqueue_scheduled_backup() RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.backup_jobs WHERE status IN ('PENDING', 'RUNNING')) THEN
        RETURN false;
    END IF;

    INSERT INTO public.backup_jobs (origin, status) VALUES ('scheduled', 'PENDING');
    RETURN true;
END;
$$;


ALTER FUNCTION public.enqueue_scheduled_backup() OWNER TO postgres;

--

-- FUNCTION enqueue_scheduled_backup() :: COMMENT
COMMENT ON FUNCTION public.enqueue_scheduled_backup() IS 'Queue a scheduled backup, unless one is already queued or running. Called by pg_cron on the schedule the backup service registers; not a user''s function.';

--

-- ensure_audit_trail_partition(timestamp with time zone) :: FUNCTION
CREATE OR REPLACE FUNCTION public.ensure_audit_trail_partition(p_month timestamp with time zone) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  -- BOUNDS ARE COMPUTED IN UTC, NOT IN THE SESSION'S ZONE. date_trunc('month', ...) on a timestamptz
  -- truncates in TimeZone, so a session in Europe/London would put the boundary an hour out for half
  -- the year -- and which partition a row lands in would depend on who happened to be connected when
  -- the partition was made. The round trip through AT TIME ZONE 'UTC' pins it.
  v_from timestamp with time zone := (date_trunc('month', p_month AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC';
  v_to   timestamp with time zone;
  v_name text;
BEGIN
  v_to   := v_from + interval '1 month';
  v_name := 'audit_trail_' || to_char(v_from AT TIME ZONE 'UTC', 'YYYY_MM');

  IF to_regclass('public.' || quote_ident(v_name)) IS NOT NULL THEN
    RETURN false;
  END IF;

  EXECUTE format(
    'CREATE TABLE public.%I PARTITION OF public.audit_trail FOR VALUES FROM (%L) TO (%L)',
    v_name, v_from, v_to
  );
  -- Before it can hold a row. The window is inside this transaction either way, but the ordering
  -- is what makes "a partition is never reachable directly" true by construction rather than by
  -- the maintenance job finishing.
  PERFORM public.secure_audit_trail_partition(format('public.%I', v_name)::regclass);
  RETURN true;
END $$;


ALTER FUNCTION public.ensure_audit_trail_partition(p_month timestamp with time zone) OWNER TO postgres;

--

-- FUNCTION ensure_audit_trail_partition(p_month timestamp with time zone) :: COMMENT
COMMENT ON FUNCTION public.ensure_audit_trail_partition(p_month timestamp with time zone) IS 'Create the monthly audit_trail partition containing the given instant, if absent. Returns true if one was created. Bounds are computed in UTC so which partition a row lands in does not depend on the session TimeZone.';

--

-- ensure_audit_trail_partitions(integer) :: FUNCTION
CREATE OR REPLACE FUNCTION public.ensure_audit_trail_partitions(p_months_ahead integer DEFAULT 3) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_created integer := 0;
  v_i integer;
BEGIN
  IF p_months_ahead IS NULL OR p_months_ahead < 0 THEN
    RAISE EXCEPTION 'ensure_audit_trail_partitions: months ahead must not be negative (got %)', p_months_ahead;
  END IF;

  -- THE CURRENT MONTH IS INCLUDED RATHER THAN ASSUMED. A stack restored from a dump taken months ago
  -- comes up with every partition ending in the past, and the first asset write would meet the
  -- default partition instead of a fresh one.
  FOR v_i IN 0..p_months_ahead LOOP
    IF public.ensure_audit_trail_partition(now() + (v_i || ' months')::interval) THEN
      v_created := v_created + 1;
    END IF;
  END LOOP;

  RETURN v_created;
END $$;


ALTER FUNCTION public.ensure_audit_trail_partitions(p_months_ahead integer) OWNER TO postgres;

--

-- FUNCTION ensure_audit_trail_partitions(p_months_ahead integer) :: COMMENT
COMMENT ON FUNCTION public.ensure_audit_trail_partitions(p_months_ahead integer) IS 'Create this month''s audit_trail partition and the next p_months_ahead of them. Idempotent; returns how many were actually created. Called by the audit_trail_partitions cron job and by 0079 itself.';

--

-- ensure_cron_job(text, text, text) :: FUNCTION
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


ALTER FUNCTION public.ensure_cron_job(p_name text, p_schedule text, p_command text) OWNER TO postgres;

--

-- FUNCTION ensure_cron_job(p_name text, p_schedule text, p_command text) :: COMMENT
COMMENT ON FUNCTION public.ensure_cron_job(p_name text, p_schedule text, p_command text) IS 'Unschedule-then-schedule, so replaying this migration does not accumulate duplicate jobs.';

--

-- ensure_gateway_status_view() :: FUNCTION
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
    'status would append to the immutable audit_trail table on every sweep and would be '
    'stale between ticks. Rebuilt by public.ensure_gateway_status_view() -- call it after adding a '
    'gateways column.';

  -- DROP VIEW discards the grants with the view, so they are re-applied here rather than
  -- left outside the function where they would silently stop being re-run.
  REVOKE ALL ON public.gateway_status FROM PUBLIC, anon, authenticated;
  GRANT SELECT ON public.gateway_status TO authenticated;
END $$;


ALTER FUNCTION public.ensure_gateway_status_view() OWNER TO postgres;

--

-- FUNCTION ensure_gateway_status_view() :: COMMENT
COMMENT ON FUNCTION public.ensure_gateway_status_view() IS 'Drop-and-recreate public.gateway_status. Called here and by any later migration that adds a column to public.gateways -- the view selects g.*, which CREATE OR REPLACE VIEW cannot widen in place once a new column lands ahead of the derived ones.';

--

-- ensure_shadow_devices(uuid) :: FUNCTION
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


ALTER FUNCTION public.ensure_shadow_devices(p_capture_id uuid) OWNER TO postgres;

--

-- FUNCTION ensure_shadow_devices(p_capture_id uuid) :: COMMENT
COMMENT ON FUNCTION public.ensure_shadow_devices(p_capture_id uuid) IS 'Find or create one shadow device per device named in a capture''s manifest, bound to the playback gateway, and return the device map start_playback_job() takes. Reuses an existing lane rather than minting per playback, so a comparison chart holds still between runs. Copies the metric contract (schema_id and device_submodels) and nothing else -- notably not the nameplate, whose serial number identifies one physical object. See 0060''s header.';

--

-- expire_open_proposals() :: FUNCTION
CREATE OR REPLACE FUNCTION public.expire_open_proposals() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_days    numeric;
    v_expired integer := 0;
    v_row     record;
BEGIN
    SELECT (value #>> '{}')::numeric INTO v_days
      FROM public.system_settings
     WHERE key = 'proposals.open_expiry_days';

    -- Seven days, the seeded default. A deleted setting would make the interval NULL and stop
    -- expiry silently, which is what the setting's floor exists to prevent.
    v_days := COALESCE(v_days, 7);

    PERFORM set_config('aber.proposal_transition', 'on', true);

    FOR v_row IN
        UPDATE public.change_proposals
           SET status = 'expired', decided_at = now()
         WHERE status = 'open'
           AND proposed_at < now() - make_interval(secs => v_days::double precision * 86400.0)
        RETURNING id, entity_type, entity_id, proposed_by
    LOOP
        INSERT INTO public.audit_trail
            (entity_type, entity_id, action, new_data, changed_by, actor_source, causation_id,
             audit_domain)
        VALUES (
            'change_proposals',
            v_row.id,
            'PROPOSAL_EXPIRED',
            jsonb_build_object(
                'proposed_by', v_row.proposed_by,
                'target_type', v_row.entity_type,
                'target_id',   v_row.entity_id,
                'after_days',  v_days
            ),
            -- NULL: `changed_by` names which user, and no user did this.
            NULL,
            'service',
            -- One run is one act: every proposal it closes shares this transaction.
            txid_current(),
            public.audit_domain_for('change_proposals', 'PROPOSAL_EXPIRED')
        );
        v_expired := v_expired + 1;
    END LOOP;

    RETURN v_expired;
END;
$$;


ALTER FUNCTION public.expire_open_proposals() OWNER TO postgres;

--

-- FUNCTION expire_open_proposals() :: COMMENT
COMMENT ON FUNCTION public.expire_open_proposals() IS 'Closes open proposals older than proposals.open_expiry_days, freeing the slots they hold under both caps. Records actor_source ''service'' with changed_by NULL: the timer has no session and is not a person, and an expiry is not a rejection. Every PROPOSAL_EXPIRED row one run writes carries that run''s transaction as its causation_id.';

--

-- fork_schema(uuid, text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.fork_schema(parent_schema_id uuid, change_description text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  -- Copied out of the parameters immediately: both are named after columns of `schemas`, and
  -- plpgsql would raise "column reference is ambiguous" on the first `WHERE id = parent_schema_id`.
  v_parent_id  UUID := parent_schema_id;
  v_change     TEXT := NULLIF(btrim(COALESCE(change_description, '')), '');
  parent       public.schemas%ROWTYPE;
  child        public.schemas%ROWTYPE;
  v_base       TEXT;
  v_next       INTEGER;
  v_name       TEXT;
  v_suffix     INTEGER := 1;
BEGIN
  -- Fail closed, before anything else observable happens. `has_authority` rather than a role name,
  -- so the gate is the permission 0069 withdrew.
  IF NOT public.has_authority(ARRAY['schema:manage']) THEN
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

  -- The metric links are the definition: a schema's membership of the catalog lives in
  -- `schema_definition.properties` / `.required`, which deviceTags.js and validate.py both read.
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


ALTER FUNCTION public.fork_schema(parent_schema_id uuid, change_description text) OWNER TO postgres;

--

-- FUNCTION fork_schema(parent_schema_id uuid, change_description text) :: COMMENT
COMMENT ON FUNCTION public.fork_schema(parent_schema_id uuid, change_description text) IS 'Derives the next draft version of an active schema, copying its definition. The version number is computed, never supplied.';

--

-- sparkplug_group_default() :: FUNCTION
CREATE OR REPLACE FUNCTION public.sparkplug_group_default() RETURNS text
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
    v_group text;
BEGIN
    SELECT nullif(value #>> '{}', '') INTO v_group
      FROM public.system_settings WHERE key = 'sparkplug.group_id';
    IF v_group IS NULL THEN
        RAISE EXCEPTION 'the sparkplug.group_id setting is not set, so a gateway has no group to take'
          USING HINT = 'db-init seeds it from the chart''s ingestion.sparkplugGroup on the first boot.';
    END IF;
    RETURN v_group;
END;
$$;


ALTER FUNCTION public.sparkplug_group_default() OWNER TO postgres;

--

-- FUNCTION sparkplug_group_default() :: COMMENT
COMMENT ON FUNCTION public.sparkplug_group_default() IS 'The site''s Sparkplug group, for gateways.sparkplug_group''s DEFAULT. Raises when the setting is absent rather than naming a group nobody chose; 0002 seeds it on every boot from the chart.';


SET default_tablespace = '';

SET default_table_access_method = heap;

--

-- gateways :: TABLE
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
    sparkplug_id text GENERATED ALWAYS AS (('gwy'::text || substr(encode(uuid_send(id), 'hex'::text), 1, 21))) STORED,
    location_scope text DEFAULT 'cell'::text NOT NULL,
    sparkplug_group text DEFAULT public.sparkplug_group_default() NOT NULL,
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
    deployment text DEFAULT 'remote'::text NOT NULL,
    forge_head_sha text,
    forge_head_message text,
    forge_head_by text,
    forge_head_at timestamp with time zone,
    forge_head_flow_sha256 text,
    area_id uuid,
    forge_appliance_sha text,
    forge_appliance_at timestamp with time zone,
    forge_appliance_flow_sha256 text,
    forge_appliance_platform_tag text,
    forge_appliance_platform_outcome text,
    forge_appliance_converged_at timestamp with time zone,
    forge_appliance_custom_outcome text,
    forge_appliance_custom_revision text,
    forge_repository_at timestamp with time zone,
    forge_archived_at timestamp with time zone,
    CONSTRAINT gateways_area_wide_has_no_cell CHECK (((location_scope <> 'area_wide'::text) OR (cell_id IS NULL))),
    CONSTRAINT gateways_area_wide_names_its_area CHECK (((location_scope = 'area_wide'::text) = (area_id IS NOT NULL))),
    CONSTRAINT gateways_deployment_valid CHECK ((deployment = ANY (ARRAY['host'::text, 'remote'::text]))),
    CONSTRAINT gateways_location_scope_valid CHECK ((location_scope = ANY (ARRAY['cell'::text, 'site_wide'::text, 'area_wide'::text]))),
    CONSTRAINT gateways_shadow_is_simulated CHECK (((NOT is_shadow) OR is_simulated)),
    CONSTRAINT gateways_simulated_is_host CHECK (((NOT is_simulated) OR (deployment = 'host'::text))),
    CONSTRAINT gateways_site_wide_has_no_cell CHECK (((location_scope <> 'site_wide'::text) OR (cell_id IS NULL))),
    CONSTRAINT gateways_sparkplug_group_format CHECK (((sparkplug_group <> ''::text) AND (sparkplug_group !~ '[/+#]'::text))),
    CONSTRAINT gateways_status_valid CHECK (((btrim(status) <> ''::text) AND (length(status) <= 32) AND ((upper(status) <> ALL (ARRAY['PENDING_ENROLLMENT'::text, 'AWAITING_BIRTH'::text, 'STALE'::text])) OR (status = ANY (ARRAY['PENDING_ENROLLMENT'::text, 'AWAITING_BIRTH'::text]))))),
    CONSTRAINT gateways_synthetic_has_no_cell CHECK ((((NOT is_simulated) AND (NOT is_shadow)) OR (cell_id IS NULL)))
);

ALTER TABLE ONLY public.gateways REPLICA IDENTITY FULL;


ALTER TABLE public.gateways OWNER TO postgres;

ALTER TABLE public.gateways
    ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid() NOT NULL,
    ADD COLUMN IF NOT EXISTS name text NOT NULL,
    ADD COLUMN IF NOT EXISTS cell_id uuid,
    ADD COLUMN IF NOT EXISTS access_url text,
    ADD COLUMN IF NOT EXISTS status text DEFAULT 'OFFLINE'::text,
    ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now(),
    ADD COLUMN IF NOT EXISTS is_archived boolean DEFAULT false,
    ADD COLUMN IF NOT EXISTS archived_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS auto_delete_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS last_heartbeat timestamp with time zone,
    ADD COLUMN IF NOT EXISTS sparkplug_id text GENERATED ALWAYS AS (('gwy'::text || substr(encode(uuid_send(id), 'hex'::text), 1, 21))) STORED,
    ADD COLUMN IF NOT EXISTS location_scope text DEFAULT 'cell'::text NOT NULL,
    ADD COLUMN IF NOT EXISTS sparkplug_group text DEFAULT public.sparkplug_group_default() NOT NULL,
    ADD COLUMN IF NOT EXISTS description text,
    ADD COLUMN IF NOT EXISTS enrolled_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS agent_version text,
    ADD COLUMN IF NOT EXISTS health_reported_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS uptime_seconds bigint,
    ADD COLUMN IF NOT EXISTS load_1m real,
    ADD COLUMN IF NOT EXISTS mem_available_bytes bigint,
    ADD COLUMN IF NOT EXISTS disk_free_bytes bigint,
    ADD COLUMN IF NOT EXISTS cert_expires_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS flow_hash text,
    ADD COLUMN IF NOT EXISTS credential_revoked_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS is_simulated boolean DEFAULT false NOT NULL,
    ADD COLUMN IF NOT EXISTS is_shadow boolean DEFAULT false NOT NULL,
    ADD COLUMN IF NOT EXISTS deployment text DEFAULT 'remote'::text NOT NULL,
    ADD COLUMN IF NOT EXISTS forge_head_sha text,
    ADD COLUMN IF NOT EXISTS forge_head_message text,
    ADD COLUMN IF NOT EXISTS forge_head_by text,
    ADD COLUMN IF NOT EXISTS forge_head_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS forge_head_flow_sha256 text,
    ADD COLUMN IF NOT EXISTS area_id uuid,
    ADD COLUMN IF NOT EXISTS forge_appliance_sha text,
    ADD COLUMN IF NOT EXISTS forge_appliance_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS forge_appliance_flow_sha256 text,
    ADD COLUMN IF NOT EXISTS forge_appliance_platform_tag text,
    ADD COLUMN IF NOT EXISTS forge_appliance_platform_outcome text,
    ADD COLUMN IF NOT EXISTS forge_appliance_converged_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS forge_appliance_custom_outcome text,
    ADD COLUMN IF NOT EXISTS forge_appliance_custom_revision text,
    ADD COLUMN IF NOT EXISTS forge_repository_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS forge_archived_at timestamp with time zone;

ALTER TABLE public.gateways
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN name DROP DEFAULT,
    ALTER COLUMN cell_id DROP DEFAULT,
    ALTER COLUMN access_url DROP DEFAULT,
    ALTER COLUMN status SET DEFAULT 'OFFLINE'::text,
    ALTER COLUMN created_at SET DEFAULT now(),
    ALTER COLUMN is_archived SET DEFAULT false,
    ALTER COLUMN archived_at DROP DEFAULT,
    ALTER COLUMN auto_delete_at DROP DEFAULT,
    ALTER COLUMN last_heartbeat DROP DEFAULT,
    ALTER COLUMN location_scope SET DEFAULT 'cell'::text,
    ALTER COLUMN sparkplug_group SET DEFAULT public.sparkplug_group_default(),
    ALTER COLUMN description DROP DEFAULT,
    ALTER COLUMN enrolled_at DROP DEFAULT,
    ALTER COLUMN agent_version DROP DEFAULT,
    ALTER COLUMN health_reported_at DROP DEFAULT,
    ALTER COLUMN uptime_seconds DROP DEFAULT,
    ALTER COLUMN load_1m DROP DEFAULT,
    ALTER COLUMN mem_available_bytes DROP DEFAULT,
    ALTER COLUMN disk_free_bytes DROP DEFAULT,
    ALTER COLUMN cert_expires_at DROP DEFAULT,
    ALTER COLUMN flow_hash DROP DEFAULT,
    ALTER COLUMN credential_revoked_at DROP DEFAULT,
    ALTER COLUMN is_simulated SET DEFAULT false,
    ALTER COLUMN is_shadow SET DEFAULT false,
    ALTER COLUMN deployment SET DEFAULT 'remote'::text,
    ALTER COLUMN forge_head_sha DROP DEFAULT,
    ALTER COLUMN forge_head_message DROP DEFAULT,
    ALTER COLUMN forge_head_by DROP DEFAULT,
    ALTER COLUMN forge_head_at DROP DEFAULT,
    ALTER COLUMN forge_head_flow_sha256 DROP DEFAULT,
    ALTER COLUMN area_id DROP DEFAULT,
    ALTER COLUMN forge_appliance_sha DROP DEFAULT,
    ALTER COLUMN forge_appliance_at DROP DEFAULT,
    ALTER COLUMN forge_appliance_flow_sha256 DROP DEFAULT,
    ALTER COLUMN forge_appliance_platform_tag DROP DEFAULT,
    ALTER COLUMN forge_appliance_platform_outcome DROP DEFAULT,
    ALTER COLUMN forge_appliance_converged_at DROP DEFAULT,
    ALTER COLUMN forge_appliance_custom_outcome DROP DEFAULT,
    ALTER COLUMN forge_appliance_custom_revision DROP DEFAULT,
    ALTER COLUMN forge_repository_at DROP DEFAULT,
    ALTER COLUMN forge_archived_at DROP DEFAULT;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'gateways_area_wide_has_no_cell'
                AND conrelid = 'public.gateways'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((location_scope <> ''area_wide''::text) OR (cell_id IS NULL)))') THEN
    ALTER TABLE public.gateways DROP CONSTRAINT gateways_area_wide_has_no_cell;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gateways_area_wide_has_no_cell'
                    AND conrelid = 'public.gateways'::regclass) THEN
    ALTER TABLE public.gateways
        ADD CONSTRAINT gateways_area_wide_has_no_cell CHECK (((location_scope <> 'area_wide'::text) OR (cell_id IS NULL)));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'gateways_area_wide_names_its_area'
                AND conrelid = 'public.gateways'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((location_scope = ''area_wide''::text) = (area_id IS NOT NULL)))') THEN
    ALTER TABLE public.gateways DROP CONSTRAINT gateways_area_wide_names_its_area;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gateways_area_wide_names_its_area'
                    AND conrelid = 'public.gateways'::regclass) THEN
    ALTER TABLE public.gateways
        ADD CONSTRAINT gateways_area_wide_names_its_area CHECK (((location_scope = 'area_wide'::text) = (area_id IS NOT NULL)));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'gateways_deployment_valid'
                AND conrelid = 'public.gateways'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((deployment = ANY (ARRAY[''host''::text, ''remote''::text])))') THEN
    ALTER TABLE public.gateways DROP CONSTRAINT gateways_deployment_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gateways_deployment_valid'
                    AND conrelid = 'public.gateways'::regclass) THEN
    ALTER TABLE public.gateways
        ADD CONSTRAINT gateways_deployment_valid CHECK ((deployment = ANY (ARRAY['host'::text, 'remote'::text])));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'gateways_location_scope_valid'
                AND conrelid = 'public.gateways'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((location_scope = ANY (ARRAY[''cell''::text, ''site_wide''::text, ''area_wide''::text])))') THEN
    ALTER TABLE public.gateways DROP CONSTRAINT gateways_location_scope_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gateways_location_scope_valid'
                    AND conrelid = 'public.gateways'::regclass) THEN
    ALTER TABLE public.gateways
        ADD CONSTRAINT gateways_location_scope_valid CHECK ((location_scope = ANY (ARRAY['cell'::text, 'site_wide'::text, 'area_wide'::text])));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'gateways_shadow_is_simulated'
                AND conrelid = 'public.gateways'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((NOT is_shadow) OR is_simulated))') THEN
    ALTER TABLE public.gateways DROP CONSTRAINT gateways_shadow_is_simulated;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gateways_shadow_is_simulated'
                    AND conrelid = 'public.gateways'::regclass) THEN
    ALTER TABLE public.gateways
        ADD CONSTRAINT gateways_shadow_is_simulated CHECK (((NOT is_shadow) OR is_simulated));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'gateways_simulated_is_host'
                AND conrelid = 'public.gateways'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((NOT is_simulated) OR (deployment = ''host''::text)))') THEN
    ALTER TABLE public.gateways DROP CONSTRAINT gateways_simulated_is_host;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gateways_simulated_is_host'
                    AND conrelid = 'public.gateways'::regclass) THEN
    ALTER TABLE public.gateways
        ADD CONSTRAINT gateways_simulated_is_host CHECK (((NOT is_simulated) OR (deployment = 'host'::text)));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'gateways_site_wide_has_no_cell'
                AND conrelid = 'public.gateways'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((location_scope <> ''site_wide''::text) OR (cell_id IS NULL)))') THEN
    ALTER TABLE public.gateways DROP CONSTRAINT gateways_site_wide_has_no_cell;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gateways_site_wide_has_no_cell'
                    AND conrelid = 'public.gateways'::regclass) THEN
    ALTER TABLE public.gateways
        ADD CONSTRAINT gateways_site_wide_has_no_cell CHECK (((location_scope <> 'site_wide'::text) OR (cell_id IS NULL)));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'gateways_sparkplug_group_format'
                AND conrelid = 'public.gateways'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((sparkplug_group <> ''''::text) AND (sparkplug_group !~ ''[/+#]''::text)))') THEN
    ALTER TABLE public.gateways DROP CONSTRAINT gateways_sparkplug_group_format;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gateways_sparkplug_group_format'
                    AND conrelid = 'public.gateways'::regclass) THEN
    ALTER TABLE public.gateways
        ADD CONSTRAINT gateways_sparkplug_group_format CHECK (((sparkplug_group <> ''::text) AND (sparkplug_group !~ '[/+#]'::text)));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'gateways_status_valid'
                AND conrelid = 'public.gateways'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((btrim(status) <> ''''::text) AND (length(status) <= 32) AND ((upper(status) <> ALL (ARRAY[''PENDING_ENROLLMENT''::text, ''AWAITING_BIRTH''::text, ''STALE''::text])) OR (status = ANY (ARRAY[''PENDING_ENROLLMENT''::text, ''AWAITING_BIRTH''::text])))))') THEN
    ALTER TABLE public.gateways DROP CONSTRAINT gateways_status_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gateways_status_valid'
                    AND conrelid = 'public.gateways'::regclass) THEN
    ALTER TABLE public.gateways
        ADD CONSTRAINT gateways_status_valid CHECK (((btrim(status) <> ''::text) AND (length(status) <= 32) AND ((upper(status) <> ALL (ARRAY['PENDING_ENROLLMENT'::text, 'AWAITING_BIRTH'::text, 'STALE'::text])) OR (status = ANY (ARRAY['PENDING_ENROLLMENT'::text, 'AWAITING_BIRTH'::text])))));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'gateways_synthetic_has_no_cell'
                AND conrelid = 'public.gateways'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((((NOT is_simulated) AND (NOT is_shadow)) OR (cell_id IS NULL)))') THEN
    ALTER TABLE public.gateways DROP CONSTRAINT gateways_synthetic_has_no_cell;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gateways_synthetic_has_no_cell'
                    AND conrelid = 'public.gateways'::regclass) THEN
    ALTER TABLE public.gateways
        ADD CONSTRAINT gateways_synthetic_has_no_cell CHECK ((((NOT is_simulated) AND (NOT is_shadow)) OR (cell_id IS NULL)));
  END IF;
END $c$;

--

-- COLUMN gateways.cell_id :: COMMENT
COMMENT ON COLUMN public.gateways.cell_id IS 'The cell this gateway is filed into, or NULL for the Unassigned lane -- which is also where it lands when that cell is deleted (0112: SET NULL, not CASCADE). NULL by assertion for a site-wide, area-wide, simulated or shadow gateway; see the CHECK constraints on this table.';

--

-- COLUMN gateways.status :: COMMENT
COMMENT ON COLUMN public.gateways.status IS 'Free text in the fleet''s own words: a Gateway_Status metric in a node-level payload overrides whatever the message type implies, so the domain is not closed. The values this platform writes are: PENDING_ENROLLMENT (a Remote gateway awaiting its bundle redemption), AWAITING_BIRTH (enrolled, holds a credential, has not yet published), ONLINE and OFFLINE (written by the ingestion daemon from node-level Sparkplug messages). STALE is DERIVED at read time by public.gateway_status and is never stored. gateways_status_valid (0147) refuses a blank status, one over 32 characters, STALE in any case, and the two lifecycle states spelt any way but the platform''s.';

--

-- COLUMN gateways.last_heartbeat :: COMMENT
COMMENT ON COLUMN public.gateways.last_heartbeat IS 'When the ingestion daemon last received a Sparkplug B node-level message (NBIRTH/NDATA/NDEATH) from this edge node -- receipt time, not the payload timestamp, so it stays comparable with server time regardless of edge clock drift. NULL means no heartbeat has ever arrived.';

--

-- COLUMN gateways.sparkplug_id :: COMMENT
COMMENT ON COLUMN public.gateways.sparkplug_id IS 'Immutable Sparkplug B edge node id, derived from the primary key. This is what appears in the MQTT topic (spBv1.0/<group>/<TYPE>/<sparkplug_id>). Never editable; rename the gateway freely without affecting ingestion.';

--

-- COLUMN gateways.location_scope :: COMMENT
COMMENT ON COLUMN public.gateways.location_scope IS '''cell'', ''area_wide'' or ''site_wide''. An area- or site-wide gateway -- typically one with no appliance of its own -- is a host-level proxy with no physical cell. Scope is not inherited by its devices; they resolve to Unassigned until an operator files them.';

--

-- COLUMN gateways.sparkplug_group :: COMMENT
COMMENT ON COLUMN public.gateways.sparkplug_group IS 'Sparkplug B Group ID -- the second topic segment. With sparkplug_id it forms the edge node address Factory+ resolves as (group, node). Defaults to the site''s group (0131) and is editable per row: a gateway can be moved to another group, unlike sparkplug_id which is issued identity.';

--

-- COLUMN gateways.description :: COMMENT
COMMENT ON COLUMN public.gateways.description IS 'Optional operator note. Free text, carries no semantics, and is read by nothing.';

--

-- COLUMN gateways.enrolled_at :: COMMENT
COMMENT ON COLUMN public.gateways.enrolled_at IS 'When this gateway last redeemed an enrolment token and received a broker credential. NULL for a host-run gateway and for a Remote one that has never enrolled. Re-enrolment overwrites it.';

--

-- COLUMN gateways.agent_version :: COMMENT
COMMENT ON COLUMN public.gateways.agent_version IS 'Version stamp of the bundle the appliance is running. Written at enrolment and REFRESHED from the Agent_Version metric on every node-level message that carries one, so an appliance upgraded in place is visible without re-enrolment. Lets the fleet''s vintage be seen without reaching into every appliance. NULL for a host-run gateway and for one that has never enrolled.';

--

-- COLUMN gateways.health_reported_at :: COMMENT
COMMENT ON COLUMN public.gateways.health_reported_at IS 'When a node-level message last carried at least one recognised health metric. Distinct from last_heartbeat, which moves on every node-level message including those carrying none: NULL here alongside a recent last_heartbeat means the appliance is alive on a bundle that does not report health, which is a different situation from one that has stopped reporting it.';

--

-- COLUMN gateways.uptime_seconds :: COMMENT
COMMENT ON COLUMN public.gateways.uptime_seconds IS 'Seconds since the appliance''s Node-RED runtime started, from the Uptime_s metric. Process uptime, not host uptime -- a restarted container resets it while the machine stays up.';

--

-- COLUMN gateways.load_1m :: COMMENT
COMMENT ON COLUMN public.gateways.load_1m IS 'Host 1-minute load average, from node_exporter''s node_load1 via the Load_1m metric. Not normalised by core count, so compare a gateway against itself over time rather than against another gateway.';

--

-- COLUMN gateways.mem_available_bytes :: COMMENT
COMMENT ON COLUMN public.gateways.mem_available_bytes IS 'Host MemAvailable in bytes, from node_exporter''s node_memory_MemAvailable_bytes. Available, not free: it counts reclaimable cache, which is the number that predicts whether an allocation will succeed.';

--

-- COLUMN gateways.disk_free_bytes :: COMMENT
COMMENT ON COLUMN public.gateways.disk_free_bytes IS 'Free bytes on the appliance''s root filesystem, from node_exporter''s node_filesystem_avail_bytes. The metric that earns the collector: an appliance that fills its disk stops publishing and reports nothing about why.';

--

-- COLUMN gateways.cert_expires_at :: COMMENT
COMMENT ON COLUMN public.gateways.cert_expires_at IS 'notAfter of the CA this appliance trusts for the broker, reported by the appliance itself. The CA is hand-distributed into every appliance''s trust store, so re-minting it takes the whole fleet offline at once with no other signal -- this is what makes that a dated warning instead of an outage. Reported, not observed: it is what the appliance HAS, which is the question.';

--

-- COLUMN gateways.flow_hash :: COMMENT
COMMENT ON COLUMN public.gateways.flow_hash IS 'SHA-256 of the flow this appliance was provisioned with, computed by its bootstrap at enrolment. Answers "which bundle''s flow is on that gateway" without a shell on it. It does NOT detect local edits: an operator who changes the flow in the Node-RED editor keeps reporting the hash of what was installed, because the appliance has no way to hash its own running flow without the admin API and a credential to call it with.';

--

-- COLUMN gateways.credential_revoked_at :: COMMENT
COMMENT ON COLUMN public.gateways.credential_revoked_at IS 'When this gateway''s broker account was last disabled at the broker, which is how this platform revokes. NULL on a gateway that is not archived, and on an archived one whose revocation has not yet succeeded -- the sweep in 0038 retries those. Set back to NULL by re-enrolment, because that issues a fresh working credential; a later issue from the dashboard outranks it in gateway_status.';

--

-- COLUMN gateways.is_simulated :: COMMENT
COMMENT ON COLUMN public.gateways.is_simulated IS 'True when this gateway''s telemetry is generated rather than observed -- a broker playback target, or a simulator. Devices INHERIT this through their gateway_id and carry no flag of their own (see 0052''s header): the containment rules a stored device-level copy would need two triggers to maintain are given for nothing by the join. Distinct from `deployment`, which is about where the connector runs rather than whether the readings are real, but not independent of it: gateways_simulated_is_host holds a simulated gateway to deployment=''host'', so a capture is never replayed onto a remote one.';

--

-- COLUMN gateways.is_shadow :: COMMENT
COMMENT ON COLUMN public.gateways.is_shadow IS 'True when this gateway exists only to publish recorded captures -- its devices are replay lanes for real machines rather than machines. Implies is_simulated (a CHECK enforces it), and takes precedence over it in device_locations: the readings are genuine, so "replayed" is more informative than "synthetic". Devices INHERIT this through gateway_id and carry no flag of their own (see 0052).';

--

-- COLUMN gateways.deployment :: COMMENT
COMMENT ON COLUMN public.gateways.deployment IS 'Where this gateway''s connector runs: ''host'' (inside this stack) or ''remote'' (an edge appliance on the plant network). This is the axis every behaviour that used to branch on the retired `is_virtual` flag was actually about -- bundles, enrolment -- and since that column went it is the only one stating it.';

--

-- COLUMN gateways.forge_head_sha :: COMMENT
COMMENT ON COLUMN public.gateways.forge_head_sha IS 'The commit at the head of main in this gateway''s repository, as the forge last reported it (forge-events, on every push). Null until the first push after the webhook existed.';

--

-- COLUMN gateways.forge_head_message :: COMMENT
COMMENT ON COLUMN public.gateways.forge_head_message IS 'First line of that commit''s message.';

--

-- COLUMN gateways.forge_head_by :: COMMENT
COMMENT ON COLUMN public.gateways.forge_head_by IS 'Who pushed it, as the forge names them: the email of the login that merged, or the committer of a push.';

--

-- COLUMN gateways.forge_head_at :: COMMENT
COMMENT ON COLUMN public.gateways.forge_head_at IS 'When that commit was made. The appliance deploys it on its next tick after this.';

--

-- COLUMN gateways.forge_head_flow_sha256 :: COMMENT
COMMENT ON COLUMN public.gateways.forge_head_flow_sha256 IS 'SHA-256 of flows.json at that head, or null if main carries none. flow_hash is the same digest for the flow the appliance last deployed, reported on its heartbeat; equal means the appliance has deployed what main holds.';

--

-- COLUMN gateways.area_id :: COMMENT
COMMENT ON COLUMN public.gateways.area_id IS 'Populated exactly when location_scope = ''area_wide''. Not inherited by its devices, as location_scope is not: they resolve to Unassigned until an operator files them.';

--

-- COLUMN gateways.forge_appliance_sha :: COMMENT
COMMENT ON COLUMN public.gateways.forge_appliance_sha IS 'The commit at the head of the appliance branch in this gateway''s repository, as the forge last reported it (forge-events, on every push). Written only by the appliance. Null until it has pushed once.';

--

-- COLUMN gateways.forge_appliance_at :: COMMENT
COMMENT ON COLUMN public.gateways.forge_appliance_at IS 'When that commit was made: the last time the appliance reported what it is running.';

--

-- COLUMN gateways.forge_appliance_flow_sha256 :: COMMENT
COMMENT ON COLUMN public.gateways.forge_appliance_flow_sha256 IS 'SHA-256 of flows.json at that head: the flow Node-RED is running on the appliance. Differs from flow_hash when the flow was edited in the appliance''s editor after the last deploy.';

--

-- COLUMN gateways.forge_appliance_platform_tag :: COMMENT
COMMENT ON COLUMN public.gateways.forge_appliance_platform_tag IS 'The platform playbook tag this appliance last converged to, from converged.json on the appliance branch. Compare with the platform''s own version to see a fleet mid-rollout. Null until the appliance has converged once.';

--

-- COLUMN gateways.forge_appliance_platform_outcome :: COMMENT
COMMENT ON COLUMN public.gateways.forge_appliance_platform_outcome IS 'How that convergence ended: converged, failed, or refused (the appliance is not enrolled, or no file names a tag).';

--

-- COLUMN gateways.forge_appliance_converged_at :: COMMENT
COMMENT ON COLUMN public.gateways.forge_appliance_converged_at IS 'When the appliance recorded that convergence, by its own clock. The clock offset gauge says how far that is from the platform''s.';

--

-- COLUMN gateways.forge_appliance_custom_outcome :: COMMENT
COMMENT ON COLUMN public.gateways.forge_appliance_custom_outcome IS 'How this gateway''s own custom.yml ended: converged or failed. Null when its repository carries no playbook of its own, and when the platform run failed before one could be attempted.';

--

-- COLUMN gateways.forge_appliance_custom_revision :: COMMENT
COMMENT ON COLUMN public.gateways.forge_appliance_custom_revision IS 'The commit of the gateway''s own repository that custom.yml was run from. Null for the same reasons as the outcome beside it.';

--

-- COLUMN gateways.forge_repository_at :: COMMENT
COMMENT ON COLUMN public.gateways.forge_repository_at IS 'When this gateway''s repository was created in the forge (enroll-gateway step 4), or when forge-sweep first saw it. Null means there is no repository to link to: no forge on this deployment, no SSH key sent at enrolment, or provisioning failed -- all of which leave enrolled_at set.';

--

-- COLUMN gateways.forge_archived_at :: COMMENT
COMMENT ON COLUMN public.gateways.forge_archived_at IS 'When forge-sweep last saw this gateway''s repository in the forge''s archive -- read-only, every branch and wiki page kept. Written and cleared by the sweep, never by the trigger that asks for it: null means the repository is live, or that nothing has spoken to a forge about it. Set from is_archived, so restoring the gateway clears it on the next pass.';

--

-- gateway_has_broker_credential(public.gateways) :: FUNCTION
CREATE OR REPLACE FUNCTION public.gateway_has_broker_credential(g public.gateways) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT
        (g.deployment = 'remote' AND g.enrolled_at IS NOT NULL)
     OR (g.deployment = 'host' AND EXISTS (
            SELECT 1 FROM public.audit_trail dt
             WHERE dt.entity_type = 'gateways'
               AND dt.entity_id   = g.id
               AND dt.action      = 'CREDENTIAL_ISSUED'
               AND (g.credential_revoked_at IS NULL OR dt.recorded_at > g.credential_revoked_at)
        ));
$$;


ALTER FUNCTION public.gateway_has_broker_credential(g public.gateways) OWNER TO postgres;

--

-- FUNCTION gateway_has_broker_credential(g public.gateways) :: COMMENT
COMMENT ON FUNCTION public.gateway_has_broker_credential(g public.gateways) IS 'Does an account exist at the broker for this gateway, by either route it can arrive -- a remote appliance completing enrolment, or the CREDENTIAL_ISSUED row a host-run mint leaves -- minus revocation. Cannot admit a gateway that never held one, which is what lets revocation use it without creating accounts through the add-only credential service (0063).';

--

-- gateway_health_rows() :: FUNCTION
CREATE OR REPLACE FUNCTION public.gateway_health_rows() RETURNS TABLE(sparkplug_id text, gateway_name text, live_status text, is_stale boolean, heartbeat_age_seconds bigint, health_reported_at timestamp with time zone, health_age_seconds bigint, uptime_seconds bigint, load_1m real, mem_available_bytes bigint, disk_free_bytes bigint, cert_expires_at timestamp with time zone, cert_expires_in_days numeric, agent_version text, flow_hash text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
    SELECT
        g.sparkplug_id,
        g.name,
        g.live_status,
        g.is_stale,
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


ALTER FUNCTION public.gateway_health_rows() OWNER TO postgres;

--

-- FUNCTION gateway_health_rows() :: COMMENT
COMMENT ON FUNCTION public.gateway_health_rows() IS 'One row per live gateway: its identity, its heartbeat freshness, and the appliance health it reports (0035). SECURITY DEFINER so the Grafana reader needs no privilege on `gateways`. Carries NOTHING about devices, cells or quarantine -- that inventory is the boundary 0029 drew and this does not cross it.';

--

-- gateway_holds_a_credential(public.gateways) :: FUNCTION
CREATE OR REPLACE FUNCTION public.gateway_holds_a_credential(g public.gateways) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $$ SELECT g.deployment = 'remote' AND g.enrolled_at IS NOT NULL $$;


ALTER FUNCTION public.gateway_holds_a_credential(g public.gateways) OWNER TO postgres;

--

-- FUNCTION gateway_holds_a_credential(g public.gateways) :: COMMENT
COMMENT ON FUNCTION public.gateway_holds_a_credential(g public.gateways) IS 'True for a REMOTE appliance that completed enrolment, and false for everything else -- which includes every host-run gateway, whose credential leaves no enrolment behind. Ask gateway_has_broker_credential() instead when the question is "does an account exist at the broker": this one is about enrolment, and mistaking the two is what 0056, 0062 and 0063 each had to correct.';

--

-- gateway_is_playback_delivery_target(uuid) :: FUNCTION
CREATE OR REPLACE FUNCTION public.gateway_is_playback_delivery_target(p_gateway_id uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_simulated boolean;
BEGIN
  -- The same allow-list as the authorisation gate, re-checked here: authorisation must not rest on
  -- a check made only by the component that also acts on the answer.
  IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'insufficient privileges to resolve a playback delivery target'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT is_simulated INTO v_simulated FROM public.gateways WHERE id = p_gateway_id;

  -- False for a gateway that does not exist, rather than an exception: "do not deliver" is the safe
  -- answer to a row deleted between the two calls. Coalesced though is_simulated is NOT NULL today,
  -- so relaxing the constraint later cannot silently change what is delivered.
  RETURN coalesce(v_simulated, false);
END;
$$;


ALTER FUNCTION public.gateway_is_playback_delivery_target(p_gateway_id uuid) OWNER TO postgres;

--

-- FUNCTION gateway_is_playback_delivery_target(p_gateway_id uuid) :: COMMENT
COMMENT ON FUNCTION public.gateway_is_playback_delivery_target(p_gateway_id uuid) IS 'Whether a freshly-issued broker credential for this gateway may be DELIVERED to the playback worker. is_simulated -- the same predicate start_playback_job() gates on, so the set of passwords the worker can hold is exactly the set of gateways it may publish as. Deliberately NOT a column on authorize_host_gateway_credential(): 0001 redeclares that function on every boot and CREATE OR REPLACE cannot change a return type, which aborts the whole chain at file one.';

--

-- guard_change_proposal_transition() :: FUNCTION
CREATE OR REPLACE FUNCTION public.guard_change_proposal_transition() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
    IF COALESCE(current_setting('aber.proposal_transition', true), '') = 'on' THEN
        RETURN NEW;
    END IF;

    IF OLD.status <> 'open' THEN
        RAISE EXCEPTION 'proposal % is %, and a decided proposal is a record rather than a draft',
            OLD.id, OLD.status
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.entity_type IS DISTINCT FROM OLD.entity_type
       OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
       OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by
       OR NEW.proposed_by_email IS DISTINCT FROM OLD.proposed_by_email
       OR NEW.proposed_at IS DISTINCT FROM OLD.proposed_at
       OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
       OR NEW.decided_at IS DISTINCT FROM OLD.decided_at
       OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason
       OR NEW.applied_trail_id IS DISTINCT FROM OLD.applied_trail_id
    THEN
        RAISE EXCEPTION
            'only the patch and the rationale may be edited; approve_proposal(), reject_proposal() '
            'and withdraw_proposal() are how a proposal changes status'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN NEW;
END;
$$;


ALTER FUNCTION public.guard_change_proposal_transition() OWNER TO postgres;

--

-- FUNCTION guard_change_proposal_transition() :: COMMENT
COMMENT ON FUNCTION public.guard_change_proposal_transition() IS 'Outside the transition functions, only patch and rationale may be edited and only while open. An RLS policy can say who may UPDATE a row; it cannot say which columns, and status is the column that must not move -- a proposer who could set ''applied'' would hold the asset write this design exists to withhold. The author stamp is equally immutable: rewriting it would re-attribute a proposal an approver is already reading.';

--

-- handle_new_user() :: FUNCTION
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


ALTER FUNCTION public.handle_new_user() OWNER TO postgres;

--

-- has_authority(text[]) :: FUNCTION
CREATE OR REPLACE FUNCTION public.has_authority(allowed_permissions text[]) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    -- One arm or the other, never both: the trigger on user_roles guarantees an identity cannot be
    -- in both sets. An anonymous caller takes the person arm, matches nothing, and returns false.
    SELECT CASE
        WHEN public.is_machine_principal(auth.uid()) THEN EXISTS (
            SELECT 1
              FROM public.principal_permissions pp
              JOIN public.permissions p ON p.id = pp.permission_id
             WHERE pp.principal_id = auth.uid()
               AND p.name = ANY (allowed_permissions)
        )
        ELSE EXISTS (
            SELECT 1
              FROM public.user_roles ur
              JOIN public.role_permissions rp ON rp.role_id = ur.role_id
              JOIN public.permissions p ON p.id = rp.permission_id
             WHERE ur.user_id = auth.uid()::text
               AND p.name = ANY (allowed_permissions)
        )
    END;
$$;


ALTER FUNCTION public.has_authority(allowed_permissions text[]) OWNER TO postgres;

--

-- FUNCTION has_authority(allowed_permissions text[]) :: COMMENT
COMMENT ON FUNCTION public.has_authority(allowed_permissions text[]) IS 'True when the caller holds any of these PERMISSIONS. A machine principal resolves through principal_permissions, a person through user_roles -> role_permissions, and nothing resolves through both. Use it where a policy would otherwise name a role that machine principals happen to share; has_role() remains the predicate for the 58 sites that name Administrator or Shopfloor_Manager, which no machine has ever satisfied.';

--

-- has_role(text[]) :: FUNCTION
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


ALTER FUNCTION public.has_role(allowed_roles text[]) OWNER TO postgres;

--

-- historian_backup_state() :: FUNCTION
CREATE OR REPLACE FUNCTION public.historian_backup_state() RETURNS TABLE(hour_utc integer, full_on integer, first_recorded_at timestamp with time zone, last_attempt_at timestamp with time zone, last_success_at timestamp with time zone, last_success_kind text, last_success_label text, last_full_at timestamp with time zone, repo_bytes bigint, last_failure_at timestamp with time zone, last_failure_kind text, last_failure_detail text, request_at timestamp with time zone, request_claimed_at timestamp with time zone, request_finished_at timestamp with time zone, request_succeeded boolean)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
#variable_conflict use_column
BEGIN
    -- Checked here: a hidden page is not a gate, and this runs as its owner.
    IF NOT public.has_role(ARRAY['Administrator']) THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH runs AS (
        SELECT r.kind, r.started_at, r.finished_at, r.succeeded, r.detail, r.label, r.repo_bytes
          FROM timescale.physical_backup_runs r
    ), ok AS (
        SELECT b.* FROM runs b WHERE b.succeeded AND b.kind <> 'check'
         ORDER BY b.finished_at DESC LIMIT 1
    ), failed AS (
        SELECT b.* FROM runs b WHERE NOT b.succeeded AND b.kind <> 'check'
         ORDER BY b.finished_at DESC LIMIT 1
    ), request AS (
        SELECT q.requested_at, q.claimed_at FROM timescale.physical_backup_requests q
         ORDER BY q.id DESC LIMIT 1
    ), answer AS (
        SELECT b.finished_at, b.succeeded FROM runs b, request q
         WHERE b.kind <> 'check' AND b.finished_at >= q.claimed_at
         ORDER BY b.finished_at LIMIT 1
    )
    SELECT s.hour_utc,
           s.full_on,
           (SELECT min(b.started_at) FROM runs b),
           (SELECT max(b.started_at) FROM runs b WHERE b.kind <> 'check'),
           ok.finished_at,
           ok.kind,
           ok.label,
           (SELECT max(b.finished_at) FROM runs b WHERE b.succeeded AND b.kind = 'full'),
           (SELECT b.repo_bytes FROM runs b WHERE b.repo_bytes IS NOT NULL
             ORDER BY b.finished_at DESC LIMIT 1),
           failed.finished_at,
           failed.kind,
           failed.detail,
           request.requested_at,
           request.claimed_at,
           answer.finished_at,
           answer.succeeded
      FROM (SELECT 1) one
      LEFT JOIN timescale.physical_backup_schedule s ON true
      LEFT JOIN ok ON true
      LEFT JOIN failed ON ok.finished_at IS NULL OR failed.finished_at > ok.finished_at
      LEFT JOIN request ON true
      LEFT JOIN answer ON true;
EXCEPTION
    -- postgres_fdw raises on connect: an unreachable historian, or one whose tables are not made
    -- yet. That is "cannot be read", which the page must not show as nothing to report.
    WHEN OTHERS THEN
        RETURN;
END;
$$;


ALTER FUNCTION public.historian_backup_state() OWNER TO postgres;

--

-- FUNCTION historian_backup_state() :: COMMENT
COMMENT ON FUNCTION public.historian_backup_state() IS 'The historian''s physical backup for the Backups page: schedule, last success, repository size, a failure newer than the last success, and the latest request with its answer. Administrator only. No row while the historian cannot be read, which the page reports as unreachable.';

--

-- i3x_auth_probe() :: FUNCTION
CREATE OR REPLACE FUNCTION public.i3x_auth_probe() RETURNS boolean
    LANGUAGE plpgsql STABLE
    SET search_path TO ''
    AS $$
BEGIN
  RETURN true;
END;
$$;


ALTER FUNCTION public.i3x_auth_probe() OWNER TO postgres;

--

-- FUNCTION i3x_auth_probe() :: COMMENT
COMMENT ON FUNCTION public.i3x_auth_probe() IS 'i3X calls this as the caller to authenticate a request: it succeeds only when PostgREST accepts the token and auth_pre_request() finds neither its jti nor its sub revoked. plpgsql and STABLE so no plan folds the call away: its EXECUTE check, which refuses anon, runs on every call.';

--

-- ingest_capture_progress(uuid, bigint, bigint, integer, boolean) :: FUNCTION
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


ALTER FUNCTION public.ingest_capture_progress(p_job_id uuid, p_messages bigint, p_bytes bigint, p_elapsed_seconds integer, p_birth_captured boolean) OWNER TO postgres;

--

-- ingest_claim_capture_job() :: FUNCTION
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


ALTER FUNCTION public.ingest_claim_capture_job() OWNER TO postgres;

--

-- ingest_claim_rebirth_requests() :: FUNCTION
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


ALTER FUNCTION public.ingest_claim_rebirth_requests() OWNER TO postgres;

--

-- ingest_fail_capture(uuid, text) :: FUNCTION
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


ALTER FUNCTION public.ingest_fail_capture(p_job_id uuid, p_error text) OWNER TO postgres;

--

-- ingest_finalise_capture(uuid, bigint, integer, jsonb) :: FUNCTION
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


ALTER FUNCTION public.ingest_finalise_capture(p_job_id uuid, p_size_bytes bigint, p_message_count integer, p_manifest jsonb) OWNER TO postgres;

--

-- ingest_mark_device_offline(uuid) :: FUNCTION
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


ALTER FUNCTION public.ingest_mark_device_offline(p_device_id uuid) OWNER TO postgres;

--

-- ingest_mark_gateway_devices_offline(uuid) :: FUNCTION
CREATE OR REPLACE FUNCTION public.ingest_mark_gateway_devices_offline(p_gateway_id uuid) RETURNS uuid[]
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_moved uuid[];
BEGIN
    PERFORM public.require_ingestion_caller('ingest_mark_gateway_devices_offline');

    IF p_gateway_id IS NULL THEN
        RAISE EXCEPTION 'ingest_mark_gateway_devices_offline: p_gateway_id is required'
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    WITH moved AS (
        UPDATE public.devices d
           SET status = 'OFFLINE'
         WHERE d.gateway_id = p_gateway_id
           AND d.is_archived IS NOT TRUE
           AND d.status IS DISTINCT FROM 'OFFLINE'
        RETURNING d.id
    )
    SELECT coalesce(array_agg(id), '{}') INTO v_moved FROM moved;

    RETURN v_moved;
END;
$$;


ALTER FUNCTION public.ingest_mark_gateway_devices_offline(p_gateway_id uuid) OWNER TO postgres;

--

-- FUNCTION ingest_mark_gateway_devices_offline(p_gateway_id uuid) :: COMMENT
COMMENT ON FUNCTION public.ingest_mark_gateway_devices_offline(p_gateway_id uuid) IS 'NDEATH: set every non-archived device of this gateway OFFLINE in one UPDATE and return the ids it moved. The filter skips a device already OFFLINE, so each device moved gets one Audit Trail row and no other gets any. Ingestion principal only.';

--

-- ingest_reconcile_capture_jobs() :: FUNCTION
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


ALTER FUNCTION public.ingest_reconcile_capture_jobs() OWNER TO postgres;

--

-- ingest_record_declared_metrics(uuid, text[], timestamp with time zone) :: FUNCTION
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


ALTER FUNCTION public.ingest_record_declared_metrics(p_device_id uuid, p_metrics text[], p_observed_at timestamp with time zone) OWNER TO postgres;

--

-- ingest_record_gateway_health(uuid, text, timestamp with time zone, jsonb) :: FUNCTION
CREATE OR REPLACE FUNCTION public.ingest_record_gateway_health(p_gateway_id uuid, p_status text, p_heartbeat_at timestamp with time zone, p_health jsonb DEFAULT NULL::jsonb) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_rows       integer;
    v_has_health boolean;
    v_before     record;
    v_flow_hash  text;
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

    -- What the row said before this heartbeat, for the one reading that is an event: the flow
    -- the appliance last deployed. Read before the UPDATE, with the forge's head beside it, so
    -- the row below can say what main held at the moment the appliance reported.
    SELECT g.flow_hash, g.name, g.sparkplug_id, g.forge_head_sha, g.forge_head_flow_sha256
      INTO v_before
      FROM public.gateways g
     WHERE g.id = p_gateway_id;

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

    -- A DEPLOYED FLOW IS AN EVENT. The audit trigger no longer sees this column (it is in
    -- audit_telemetry_columns(), with the readings), so the change is recorded here, once per
    -- change, as a FLOW_DEPLOYED row pinned to 'ingestion': the daemon is the witness to what the
    -- appliance reported, the way record_ingestion_rejection() is the witness to what it refused.
    -- No fourth actor kind: the puller on the appliance never touches this database, and the
    -- heartbeat is its only channel. `matches_main` is what the forge held at that moment.
    v_flow_hash := p_health->>'flow_hash';
    IF v_has_health AND v_flow_hash IS NOT NULL AND v_flow_hash IS DISTINCT FROM v_before.flow_hash THEN
        INSERT INTO public.audit_trail (
            entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
            causation_id, recorded_at
        ) VALUES (
            'gateways',
            p_gateway_id,
            'FLOW_DEPLOYED',
            jsonb_build_object('flow_hash', v_before.flow_hash),
            jsonb_build_object(
                'flow_hash',              v_flow_hash,
                -- The identity as it was AT THE TIME, as the rejection row keeps it.
                'name',                   v_before.name,
                'sparkplug_id',           v_before.sparkplug_id,
                'reported_at',            COALESCE(p_heartbeat_at, now()),
                'forge_head_sha',         v_before.forge_head_sha,
                'forge_head_flow_sha256', v_before.forge_head_flow_sha256,
                'matches_main',           v_flow_hash = v_before.forge_head_flow_sha256
            ),
            NULL,
            'ingestion',
            txid_current(),
            now()
        );
    END IF;

    RETURN true;
END;
$$;


ALTER FUNCTION public.ingest_record_gateway_health(p_gateway_id uuid, p_status text, p_heartbeat_at timestamp with time zone, p_health jsonb) OWNER TO postgres;

--

-- ingest_record_rebirth_outcome(uuid, boolean, text) :: FUNCTION
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


ALTER FUNCTION public.ingest_record_rebirth_outcome(p_id uuid, p_throttled boolean, p_error text) OWNER TO postgres;

--

-- ingest_register_quarantined_device(text, uuid, text, text, text, text[], timestamp with time zone) :: FUNCTION
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
       ('sparkplug_id', 'reported_identity', 'instance_uuid') THEN
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


ALTER FUNCTION public.ingest_register_quarantined_device(p_name text, p_gateway_id uuid, p_reported_identity text, p_quarantine_reason text, p_identity_source text, p_declared_metrics text[], p_observed_at timestamp with time zone) OWNER TO postgres;

--

-- ingest_requarantine_device(uuid, text, text) :: FUNCTION
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


ALTER FUNCTION public.ingest_requarantine_device(p_device_id uuid, p_quarantine_reason text, p_reported_identity text) OWNER TO postgres;

--

-- ingest_set_device_state(uuid, text, text, timestamp with time zone) :: FUNCTION
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
       ('sparkplug_id', 'reported_identity', 'instance_uuid') THEN
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


ALTER FUNCTION public.ingest_set_device_state(p_device_id uuid, p_status text, p_identity_source text, p_first_dbirth_at timestamp with time zone) OWNER TO postgres;

--

-- ingest_store_birth_parameters(text, jsonb, timestamp with time zone) :: FUNCTION
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


ALTER FUNCTION public.ingest_store_birth_parameters(p_asset_id text, p_rows jsonb, p_observed_at timestamp with time zone) OWNER TO postgres;

--

-- is_active_capture_object(text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.is_active_capture_object(p_name text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.capture_jobs j
         WHERE j.status = 'RECORDING' AND j.storage_path = p_name
    );
$$;


ALTER FUNCTION public.is_active_capture_object(p_name text) OWNER TO postgres;

--

-- FUNCTION is_active_capture_object(p_name text) :: COMMENT
COMMENT ON FUNCTION public.is_active_capture_object(p_name text) IS 'True when a storage object path is the destination of a capture job that is RECORDING right now. Confines the ingestion daemon''s authority over broker-captures to the single file it is producing: with no capture in flight the daemon can reach nothing in the bucket at all.';

--

-- is_active_playback_capture(text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.is_active_playback_capture(p_name text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.playback_jobs j
         WHERE j.status = 'RUNNING' AND j.capture_storage_path = p_name
    );
$$;


ALTER FUNCTION public.is_active_playback_capture(p_name text) OWNER TO postgres;

--

-- FUNCTION is_active_playback_capture(p_name text) :: COMMENT
COMMENT ON FUNCTION public.is_active_playback_capture(p_name text) IS 'True when a storage object is the capture of a playback job that is RUNNING right now. Confines the playback worker''s read of broker-captures to the single file it is publishing: with no playback in flight the worker can reach nothing in the bucket at all.';

--

-- is_area_plan_path(text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.is_area_plan_path(p_name text) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $_$
  SELECT split_part(p_name, '/', 3) = ''
     AND split_part(p_name, '/', 2) ~* '^[^/]+\.svg$'
     AND EXISTS (
       SELECT 1 FROM public.areas a
        WHERE a.id::text = split_part(p_name, '/', 1)
     )
$_$;


ALTER FUNCTION public.is_area_plan_path(p_name text) OWNER TO postgres;

--

-- is_capture_subject_prefix(text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.is_capture_subject_prefix(p_folder text) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
    SELECT EXISTS (SELECT 1 FROM public.gateways g WHERE g.sparkplug_id = p_folder)
        OR EXISTS (SELECT 1 FROM public.devices  d WHERE d.sparkplug_id = p_folder);
$$;


ALTER FUNCTION public.is_capture_subject_prefix(p_folder text) OWNER TO postgres;

--

-- FUNCTION is_capture_subject_prefix(p_folder text) :: COMMENT
COMMENT ON FUNCTION public.is_capture_subject_prefix(p_folder text) IS 'True when a storage folder names a real gateway or device. The prefix rule for broker-captures, which files by the SUBJECT RECORDED rather than by the gateway a capture plays back as.';

--

-- is_ingestion_caller() :: FUNCTION
CREATE OR REPLACE FUNCTION public.is_ingestion_caller() RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
    -- One arm: Service_Ingestor only. `service_role` bypasses RLS and can write these tables
    -- directly; what this stops is `service_role` using the narrow gates, so "who may call these"
    -- stays a statement about one identity.
    SELECT COALESCE(auth.uid()::text = 'b0000000-0000-4000-8000-000000000002', false);
$$;


ALTER FUNCTION public.is_ingestion_caller() OWNER TO postgres;

--

-- FUNCTION is_ingestion_caller() :: COMMENT
COMMENT ON FUNCTION public.is_ingestion_caller() IS 'True only for the Service_Ingestor principal (0046). Guards every ingest_* write gate. The transitional service_role arm was removed by 0048 -- see Machine Identities in supabase/README.md.';

--

-- is_machine_principal(uuid) :: FUNCTION
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


ALTER FUNCTION public.is_machine_principal(p_user_id uuid) OWNER TO postgres;

--

-- FUNCTION is_machine_principal(p_user_id uuid) :: COMMENT
COMMENT ON FUNCTION public.is_machine_principal(p_user_id uuid) IS 'True for a seeded or minted machine identity -- no email, no password, no identity provider, and therefore unable to sign in. The predicate is 0042''s, deliberately unchanged: a second definition of "is this a service account" would be worse than none. Used by log_audit_trail_event() to keep a machine''s writes from being recorded as a human''s.';

--

-- is_playback_caller() :: FUNCTION
CREATE OR REPLACE FUNCTION public.is_playback_caller() RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
    -- ONE ARM, like `is_ingestion_caller()` after 0048. No transitional `service_role` arm: nothing
    -- has ever handed this worker that key, so admitting it would widen the gates on day one for a
    -- migration path that does not exist.
    SELECT COALESCE(auth.uid()::text = 'b0000000-0000-4000-8000-000000000003', false);
$$;


ALTER FUNCTION public.is_playback_caller() OWNER TO postgres;

--

-- FUNCTION is_playback_caller() :: COMMENT
COMMENT ON FUNCTION public.is_playback_caller() IS 'True only for the Service_Playback principal (0056). Guards every playback_* worker gate. Deliberately distinct from is_ingestion_caller(): the two processes hold different broker rights -- the daemon may publish only NCMD rebirth requests, the worker may publish asset data as one gateway -- and a shared predicate would let either use the other''s gates.';

--

-- is_valid_quarantine_reason(text) :: FUNCTION
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


ALTER FUNCTION public.is_valid_quarantine_reason(p_reason text) OWNER TO postgres;

--

-- FUNCTION is_valid_quarantine_reason(p_reason text) :: COMMENT
COMMENT ON FUNCTION public.is_valid_quarantine_reason(p_reason text) IS 'True when the reason is one of the four quarantine codes, bare or followed by ": <detail>". Both shapes are produced by ingestion.py -- see 0047''s header for why this is a prefix check rather than an equality check.';

--

-- issue_gateway_enrollment_token(uuid, integer) :: FUNCTION
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
  -- same state as a new one. Guarded on an actual change: `gateways` carries the audit_trail
  -- trigger, and an unconditional write would append an audit row on every re-issue.
  IF v_gateway.status IS DISTINCT FROM 'PENDING_ENROLLMENT' THEN
    UPDATE public.gateways
       SET status = 'PENDING_ENROLLMENT'
     WHERE id = p_gateway_id;
  END IF;

  RETURN QUERY SELECT v_token, v_expires;
END $$;


ALTER FUNCTION public.issue_gateway_enrollment_token(p_gateway_id uuid, p_ttl_minutes integer) OWNER TO postgres;

--

-- FUNCTION issue_gateway_enrollment_token(p_gateway_id uuid, p_ttl_minutes integer) :: COMMENT
COMMENT ON FUNCTION public.issue_gateway_enrollment_token(p_gateway_id uuid, p_ttl_minutes integer) IS 'Mint a single-use enrolment token for a Remote gateway and move it to PENDING_ENROLLMENT. Returns the raw token ONCE -- only its SHA-256 is stored. Requires Administrator or Shopfloor_Manager. Re-issuing consumes any previous live token, so a regenerated bundle invalidates the one already downloaded.';

--

-- list_machine_principals() :: FUNCTION
CREATE OR REPLACE FUNCTION public.list_machine_principals() RETURNS TABLE(principal_id uuid, permissions text[], created_at timestamp with time zone, can_sign_in boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    -- ADMINISTRATOR ONLY, and narrower than the page's other reads on purpose. A gateway's
    -- credential state is operational -- a Shopfloor_Manager acts on it. The list of machine
    -- identities that can reach the stack is an access-control question.
    IF NOT public.has_role(ARRAY['Administrator']) THEN
        RAISE EXCEPTION 'insufficient privileges to list machine principals'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN QUERY
    SELECT u.id,
           coalesce(array_agg(p.name ORDER BY p.name) FILTER (WHERE p.name IS NOT NULL), '{}'::text[]),
           u.created_at,
           -- RETURNED RATHER THAN ASSUMED, even though the WHERE clause makes it false for every
           -- row. It is the property that makes listing these safe, and a page that states it is a
           -- page whose claim can be checked.
           false
      FROM auth.users u
      LEFT JOIN public.principal_permissions pp ON pp.principal_id = u.id
      LEFT JOIN public.permissions p ON p.id = pp.permission_id
     WHERE u.email IS NULL
       AND (u.encrypted_password IS NULL OR u.encrypted_password = '')
     GROUP BY u.id, u.created_at
     ORDER BY u.created_at;
END;
$$;


ALTER FUNCTION public.list_machine_principals() OWNER TO postgres;

--

-- FUNCTION list_machine_principals() :: COMMENT
COMMENT ON FUNCTION public.list_machine_principals() IS 'Machine identities that can reach this stack, with the permissions each holds in its own right. Administrator only. Replaces list_service_principals(), whose second column was the role a machine borrowed; the name changed because the return type did. Returns no email, no token and nothing derived from one.';

--

-- list_proposer_names() :: FUNCTION
CREATE OR REPLACE FUNCTION public.list_proposer_names() RETURNS TABLE(principal_id uuid, name text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    -- may_decide_proposal() is the lane gate approve_proposal() decides by, and the one statement
    -- of which permission decides a lane. Every status, not only open: the Decided list names the
    -- proposer too. A person, and a pinned identity with no name, have no machine_principals row.
    RETURN QUERY
    SELECT DISTINCT mp.principal_id, mp.name
      FROM public.change_proposals cp
      JOIN public.machine_principals mp ON mp.principal_id = cp.proposed_by
     WHERE public.may_decide_proposal(cp.entity_type);
END;
$$;


ALTER FUNCTION public.list_proposer_names() OWNER TO postgres;

--

-- FUNCTION list_proposer_names() :: COMMENT
COMMENT ON FUNCTION public.list_proposer_names() IS 'The name of each machine identity that filed a change proposal the caller may decide, for the Approvals page: a machine has no email for the proposal to carry. Gated by may_decide_proposal() on each proposal''s lane, the gate approve_proposal() decides by, so a caller who decides nothing gets no rows, and machine_principals stays readable by Administrator and Auditor alone. A person, and a pinned identity with no name, return no row.';

--

-- list_user_accounts() :: FUNCTION
CREATE OR REPLACE FUNCTION public.list_user_accounts() RETURNS TABLE(user_id uuid, email text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    -- Administrator and Auditor: the two roles `audit_trail_select_security` admits. See the
    -- header for why this is not narrower.
    IF NOT public.has_role(ARRAY['Administrator', 'Auditor']) THEN
        RAISE EXCEPTION 'insufficient privileges to list user accounts'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN QUERY
    SELECT u.id, u.email::text
      FROM auth.users u
     -- ONE DEFINITION OF "IS THIS A SERVICE ACCOUNT", which is 0048's rule. Spelling the test out
     -- again here would be a second one, and the two would agree until the day they did not.
     WHERE NOT public.is_machine_principal(u.id)
     ORDER BY u.email NULLS LAST, u.id;
END;
$$;


ALTER FUNCTION public.list_user_accounts() OWNER TO postgres;

--

-- FUNCTION list_user_accounts() :: COMMENT
COMMENT ON FUNCTION public.list_user_accounts() IS 'The people who can reach this stack, as id and email, for naming the person an audit_trail role-assignment row is about. Membership is NOT is_machine_principal() (0048), the same predicate the rest of the stack tells a person from a service identity with. Administrator and Auditor only -- the roles audit_trail_select_security admits, because an Auditor reading uuids beside an Administrator reading names would be the same record told two ways. The email may be NULL; the caller falls back to the id.';

--

-- log_asset_export() :: FUNCTION
CREATE OR REPLACE FUNCTION public.log_asset_export() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    INSERT INTO public.audit_trail
        (entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
         causation_id, recorded_at)
    VALUES
        (NEW.entity_type, NEW.entity_id, 'EXPORTED', NULL, to_jsonb(NEW), NEW.taken_by,
         CASE WHEN NEW.taken_by IS NULL THEN 'service' ELSE 'user' END,
         txid_current(), NEW.taken_at);
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.log_asset_export() OWNER TO postgres;

--

-- FUNCTION log_asset_export() :: COMMENT
COMMENT ON FUNCTION public.log_asset_export() IS 'Records an asset_exports row in audit_trail as EXPORTED, attributed to the person the function verified. The one trail row that survives the entity in a form the tombstone can link to.';

--

-- log_audit_trail_event() :: FUNCTION
CREATE OR REPLACE FUNCTION public.log_audit_trail_event() RETURNS trigger
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
    v_key       TEXT;
BEGIN
    -- -----------------------------------------------------------------------------------------
    -- Suppression. UPDATE only: an INSERT or DELETE is always an event.
    -- -----------------------------------------------------------------------------------------
    -- Identical rows are a no-op write, and rows differing only in the columns
    -- audit_telemetry_columns() names are a heartbeat's readings, not events. Subtracting an
    -- absent key is a no-op, so one comparison covers both; NULLs compare as equal.
    IF TG_OP = 'UPDATE'
       AND (to_jsonb(NEW) - public.audit_telemetry_columns())
           IS NOT DISTINCT FROM (to_jsonb(OLD) - public.audit_telemetry_columns())
    THEN
        RETURN NEW;
    END IF;

    -- -----------------------------------------------------------------------------------------
    -- Which column names the entity
    -- -----------------------------------------------------------------------------------------
    -- `id` unless the trigger argument names another: `device_nameplate` is keyed by `device_id`.
    -- One attribution ladder for every table; log_role_assignment() carries a reduced copy.
    v_key := COALESCE(TG_ARGV[0], 'id');

    IF (TG_OP = 'DELETE') THEN
        v_old_data := to_jsonb(OLD);
        v_entity_id := (v_old_data ->> v_key)::UUID;
    ELSIF (TG_OP = 'UPDATE') THEN
        v_old_data := to_jsonb(OLD);
        v_new_data := to_jsonb(NEW);
        v_entity_id := (v_new_data ->> v_key)::UUID;
    ELSIF (TG_OP = 'INSERT') THEN
        v_new_data := to_jsonb(NEW);
        v_entity_id := (v_new_data ->> v_key)::UUID;
    END IF;

    -- A mistyped trigger argument reads as NULL through `->>`; refused here so the error names
    -- the trigger rather than audit_trail's NOT NULL.
    IF v_entity_id IS NULL THEN
        RAISE EXCEPTION
            'log_audit_trail_event: % has no % to name the entity by -- check the column named '
            'in the trigger argument', TG_TABLE_NAME, v_key
            USING ERRCODE = 'null_value_not_allowed';
    END IF;

    -- -----------------------------------------------------------------------------------------
    -- Who
    -- -----------------------------------------------------------------------------------------
    v_actor := auth.uid();

    IF v_actor IS NULL THEN
        -- Set with SET LOCAL by a SECURITY DEFINER RPC acting on a person's behalf, such as
        -- approve_quarantined_device() and approve_proposal().
        BEGIN
            v_actor := NULLIF(current_setting('aber.actor_id', true), '')::UUID;
        EXCEPTION WHEN others THEN
            v_actor := NULL;
        END;
    END IF;

    -- -----------------------------------------------------------------------------------------
    -- What kind of actor
    -- -----------------------------------------------------------------------------------------
    -- A person, not merely a `sub`: machine principals carry one too. changed_by receives
    -- v_actor either way, so a machine's row still names it.
    IF v_actor IS NOT NULL AND NOT public.is_machine_principal(v_actor) THEN
        v_source := 'user';
    ELSE
        -- The `X-Aber-Actor` request header, which PostgREST exposes as request.headers. Each value
        -- is believed only from the caller it describes. 'user' never is: claiming a human author
        -- is exactly the assertion a client must not be able to make about itself.
        BEGIN
            v_declared := NULLIF(
                current_setting('request.headers', true)::json ->> 'x-aber-actor', ''
            );
        EXCEPTION WHEN others THEN
            v_declared := NULL;
        END;

        IF v_declared = 'ingestion' AND public.is_ingestion_caller() THEN
            v_source := 'ingestion';
        ELSIF v_declared = 'migration'
              AND NULLIF(current_setting('request.jwt.claims', true), '') IS NULL
              AND session_user IN ('postgres', 'supabase_admin') THEN
            -- The owner's own session with no token, which PostgREST never is.
            v_source := 'migration';
        ELSIF v_declared = 'service' OR v_actor IS NOT NULL THEN
            -- Any other caller that is not a person may call itself a service. A machine identity
            -- is one whatever it declares.
            v_source := 'service';
        ELSE
            -- The effective role, not `current_user`, which is this SECURITY DEFINER function's
            -- owner. PostgREST SET ROLEs, so `role` holds it; a direct psql session reports
            -- 'none', where `session_user` is the honest answer.
            v_role := NULLIF(current_setting('role', true), 'none');
            IF v_role IS NULL OR v_role = '' THEN
                v_role := session_user;
            END IF;

            IF v_role IN ('postgres', 'supabase_admin') THEN
                v_source := 'migration';
            ELSE
                -- service_role with nothing believable declared: automation we cannot name more
                -- precisely.
                v_source := 'service';
            END IF;
        END IF;
    END IF;

    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        TG_TABLE_NAME, v_entity_id, TG_OP, v_old_data, v_new_data, v_actor, v_source,
        txid_current(), NOW()
    );

    RETURN COALESCE(NEW, OLD);
END;
$$;


ALTER FUNCTION public.log_audit_trail_event() OWNER TO postgres;

--

-- FUNCTION log_audit_trail_event() :: COMMENT
COMMENT ON FUNCTION public.log_audit_trail_event() IS 'AFTER trigger that appends to audit_trail. Suppresses an UPDATE that changed nothing and one that moved only the columns audit_telemetry_columns() names. The entity id is read from the column named in the trigger argument, defaulting to `id`. Attribution is auth.uid(), then aber.actor_id; a person is ''user''. Otherwise the X-Aber-Actor header is believed only from the caller it describes -- ''ingestion'' when is_ingestion_caller(), ''migration'' from the owner''s session with no JWT, ''service'' from any other non-person -- a machine identity is ''service'' whatever it declares, and anything else falls to the effective role.';

--

-- log_role_assignment() :: FUNCTION
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

  -- Attribution, the short form. The full ladder in `log_audit_trail_event()` distinguishes an
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

  INSERT INTO public.audit_trail (
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


ALTER FUNCTION public.log_role_assignment() OWNER TO postgres;

--

-- FUNCTION log_role_assignment() :: COMMENT
COMMENT ON FUNCTION public.log_role_assignment() IS 'Audit trigger for public.user_roles. Separate from log_audit_trail_event() because that function reads NEW.id and user_roles has no id column -- its key is (user_id, role_id).';

--

-- may_decide_proposal(text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.may_decide_proposal(p_entity_type text) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT CASE p_entity_type
    -- The role pair the devices, device_nameplate and areas write policies name.
    WHEN 'devices'          THEN public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
    WHEN 'device_nameplate' THEN public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
    WHEN 'areas'            THEN public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])

    -- THE PERMISSION, where the cells and gateways write policies name the role pair. For a
    -- person the two agree: the pair are the only roles holding cell:manage and gateway:manage.
    -- No machine reaches these arms, because create_machine_principal() refuses both grants:
    -- machines propose, people decide. check-docs-drift.mjs (11f) holds all three facts.
    WHEN 'cells'            THEN public.has_authority(ARRAY['cell:manage'])
    WHEN 'gateways'         THEN public.has_authority(ARRAY['gateway:manage'])

    -- Withdrawn lanes decide nothing: schemas, and the three link lanes. proposable_columns() is
    -- empty for each, so nothing new can be filed in them either.
    ELSE false
  END
$$;


ALTER FUNCTION public.may_decide_proposal(p_entity_type text) OWNER TO postgres;

--

-- FUNCTION may_decide_proposal(p_entity_type text) :: COMMENT
COMMENT ON FUNCTION public.may_decide_proposal(p_entity_type text) IS 'Who may approve or reject a proposal in this lane. The device lanes and areas resolve the role pair (Administrator, Shopfloor_Manager) their tables'' write policies name. Cells and gateways resolve cell:manage and gateway:manage, where their tables'' policies name the same pair: the two agree for a person, because the pair are the only roles holding those grants, and no machine can hold either, because create_machine_principal() refuses them. An unknown or withdrawn lane -- schemas, and the three link lanes -- is decidable by nobody.';

--

-- may_manage_captures() :: FUNCTION
CREATE OR REPLACE FUNCTION public.may_manage_captures() RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
    SELECT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']);
$$;


ALTER FUNCTION public.may_manage_captures() OWNER TO postgres;

--

-- peek_gateway_enrollment_token(text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.peek_gateway_enrollment_token(p_token text) RETURNS TABLE(gateway_id uuid, sparkplug_id text, sparkplug_group text, gateway_name text, expires_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_hash text;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;

  v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  RETURN QUERY
  SELECT g.id, g.sparkplug_id, g.sparkplug_group, g.name, t.expires_at
    FROM public.gateway_enrollment_tokens t
    JOIN public.gateways g ON g.id = t.gateway_id
   WHERE t.token_hash = v_hash
     AND t.consumed_at IS NULL
     AND t.expires_at > now()
     AND NOT g.is_archived;
END $_$;


ALTER FUNCTION public.peek_gateway_enrollment_token(p_token text) OWNER TO postgres;

--

-- FUNCTION peek_gateway_enrollment_token(p_token text) :: COMMENT
COMMENT ON FUNCTION public.peek_gateway_enrollment_token(p_token text) IS 'Whether an enrolment token is live now, and for which gateway, WITHOUT consuming it: the read-only twin of consume_gateway_enrollment_token(), answering the same four refusals with no rows. Called by the gateway-install edge function with the service-role key to authorise the installer, playbook and .env downloads; only enrolment spends the token.';

--

-- place_cell_in_its_area() :: FUNCTION
CREATE OR REPLACE FUNCTION public.place_cell_in_its_area() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_aspect numeric;
    v_min    numeric;
    v_near   text;
BEGIN
    IF TG_OP = 'UPDATE'
       AND NEW.area_id IS DISTINCT FROM OLD.area_id
       AND NEW.plan_x IS NOT DISTINCT FROM OLD.plan_x
       AND NEW.plan_y IS NOT DISTINCT FROM OLD.plan_y THEN
        NEW.plan_x := NULL;
        NEW.plan_y := NULL;
    END IF;

    -- A place written with no area at all is left for cells_place_needs_an_area to refuse.
    IF NEW.area_id IS NULL OR NEW.plan_x IS NULL OR COALESCE(NEW.is_archived, false) THEN
        RETURN NEW;
    END IF;

    SELECT plan_aspect INTO v_aspect FROM public.areas WHERE id = NEW.area_id;

    SELECT (value #>> '{}')::numeric INTO v_min
      FROM public.system_settings WHERE key = 'site_map.min_pin_spacing';
    v_min := COALESCE(v_min, 0.08);

    SELECT c.name INTO v_near
      FROM public.cells c
     WHERE c.area_id = NEW.area_id
       AND c.id <> NEW.id
       AND c.plan_x IS NOT NULL
       AND NOT COALESCE(c.is_archived, false)
       AND public.plan_distance(NEW.plan_x, NEW.plan_y, c.plan_x, c.plan_y, v_aspect) < v_min
     ORDER BY public.plan_distance(NEW.plan_x, NEW.plan_y, c.plan_x, c.plan_y, v_aspect)
     LIMIT 1;
    IF v_near IS NOT NULL THEN
        RAISE EXCEPTION 'that place is too close to "%" on the same area plan; the minimum spacing is % of the plan''s shorter side', v_near, v_min
            USING ERRCODE = 'check_violation',
                  HINT = 'Move the pin further away, or change site_map.min_pin_spacing on the Settings page.';
    END IF;

    RETURN NEW;
END;
$$;


ALTER FUNCTION public.place_cell_in_its_area() OWNER TO postgres;

--

-- plan_distance(numeric, numeric, numeric, numeric, numeric) :: FUNCTION
CREATE OR REPLACE FUNCTION public.plan_distance(p_x1 numeric, p_y1 numeric, p_x2 numeric, p_y2 numeric, p_aspect numeric) RETURNS numeric
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
    WHEN COALESCE(p_aspect, 4.0/3.0) >= 1
      THEN sqrt(power((p_x1 - p_x2) * COALESCE(p_aspect, 4.0/3.0), 2) + power(p_y1 - p_y2, 2))
    ELSE   sqrt(power(p_x1 - p_x2, 2) + power((p_y1 - p_y2) / COALESCE(p_aspect, 4.0/3.0), 2))
  END
$$;


ALTER FUNCTION public.plan_distance(p_x1 numeric, p_y1 numeric, p_x2 numeric, p_y2 numeric, p_aspect numeric) OWNER TO postgres;

--

-- platform_health_rows() :: FUNCTION
CREATE OR REPLACE FUNCTION public.platform_health_rows() RETURNS TABLE(condition text, sparkplug_id text, subject text, value numeric, detail text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
    -- ---------------------------------------------------------------------------------------
    -- A gateway that has stopped heartbeating. Reads `gateway_status.is_stale` rather than
    -- re-deriving it: that view owns the 90s threshold. Archived gateways are excluded.
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
    -- An enrolment that never completed: redeemed its token, landed in AWAITING_BIRTH, and never
    -- published. Age is measured from `enrolled_at`.
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
    -- Emitted even at zero, so "nothing is quarantined" and "the datasource is down" are
    -- distinguishable.
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
    -- Devices that SHOULD be publishing. See `0092`'s header for why each exclusion is here and
    -- why zero is the answer that disables the alert rather than a gap in it.
    -- ---------------------------------------------------------------------------------------
    SELECT 'expected_publishers'::text,
           NULL::text,
           'fleet'::text,
           count(*)::numeric,
           format('%s device(s) registered, unarchived, unquarantined, and behind a gateway that '
                  'has reported at least once', count(*))
      FROM public.devices d
     WHERE NOT d.is_archived
       AND NOT d.is_quarantined
       AND d.gateway_id IS NOT NULL
       -- 0092. BEING BOUND TO A GATEWAY IS NOT EVIDENCE THAT A PATH HAS EVER EXISTED. See that
       -- migration's header: a device behind an edge node nobody has deployed yet is not late.
       AND (
             -- The device has published. The strongest evidence available, and about the device
             -- itself rather than about something it points at.
             d.first_dbirth_at IS NOT NULL
             -- Or its gateway has been heard from at least once, ever. 0001's own comment on the
             -- column is the contract: "NULL means no heartbeat has ever arrived." Nothing clears
             -- it, so a gateway that has since DIED still counts -- which is correct, because that
             -- is precisely the case this alert exists for.
             OR EXISTS (
                  SELECT 1 FROM public.gateways g
                   WHERE g.id = d.gateway_id
                     AND g.last_heartbeat IS NOT NULL
                )
           )

    UNION ALL

    -- ---------------------------------------------------------------------------------------
    -- 0133. How far the cold archive has fallen behind, in DAYS past the tiering threshold.
    --
    -- ONLY WHILE ARCHIVING IS ON, and that is the whole gate. On a stack that does not archive,
    -- every chunk is unexported for ever and the frontier is the oldest data there is -- a row
    -- that would be permanently and uselessly alarming. The rule's noDataState is OK, so an
    -- absent row reads as "nothing to report" exactly as it does for a healthy fleet.
    --
    -- Days rather than seconds because the annotation is read by a person deciding whether to go
    -- and look at a link, and because the tolerance is measured in chunk intervals.
    -- ---------------------------------------------------------------------------------------
    SELECT 'archive_backlog'::text,
           NULL::text,
           'fleet'::text,
           round(b.overdue_seconds / 86400.0, 1),
           format('cold telemetry from %s onwards is not yet verified on the remote endpoint: '
                  '%s day(s) past the %s-day threshold',
                  b.oldest_unexported, round(b.overdue_seconds / 86400.0, 1), b.threshold_days)
      FROM public.cold_archive_backlog_state() b
     WHERE b.enabled
$$;


ALTER FUNCTION public.platform_health_rows() OWNER TO postgres;

--

-- FUNCTION platform_health_rows() :: COMMENT
COMMENT ON FUNCTION public.platform_health_rows() IS 'One row per platform condition worth alerting on: stale gateways, stuck enrolments, the quarantine queue depth, and how many devices are expected to be publishing. SECURITY DEFINER so the Grafana reader needs no privilege on gateways or devices -- it emits a count and, where the condition names an asset, that asset''s wire id, and nothing else about it.';

--

-- platform_storage_rows() :: FUNCTION
CREATE OR REPLACE FUNCTION public.platform_storage_rows() RETURNS TABLE(tier text, relation text, table_bytes bigint, index_bytes bigint, toast_bytes bigint, total_bytes bigint)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
    SELECT
        CASE
          WHEN c.relname = 'audit_trail' THEN 'audit'
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


ALTER FUNCTION public.platform_storage_rows() OWNER TO postgres;

--

-- FUNCTION platform_storage_rows() :: COMMENT
COMMENT ON FUNCTION public.platform_storage_rows() IS 'Byte counts for every ordinary table in the Supabase public schema, tiered so an audit trail that is never pruned is distinguishable from reference data that never grows. SECURITY DEFINER so the dashboard reader needs no privilege on the tables it reports the size of.';

--

-- playback_claim_job() :: FUNCTION
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


ALTER FUNCTION public.playback_claim_job() OWNER TO postgres;

--

-- playback_finish(uuid, integer, text, integer) :: FUNCTION
CREATE OR REPLACE FUNCTION public.playback_finish(p_job_id uuid, p_messages_sent integer, p_error text DEFAULT NULL::text, p_messages_out_of_window integer DEFAULT 0) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    PERFORM public.require_playback_caller('playback_finish');

    UPDATE public.playback_jobs
       SET status = CASE
                      WHEN p_error IS NOT NULL THEN 'FAILED'
                      WHEN stop_requested THEN 'CANCELLED'
                      ELSE 'COMPLETED'
                    END,
           finished_at = now(),
           messages_sent = greatest(coalesce(p_messages_sent, messages_sent), 0),
           messages_out_of_window = greatest(coalesce(p_messages_out_of_window, 0), 0),
           error = left(nullif(btrim(coalesce(p_error, '')), ''), 2000)
     WHERE id = p_job_id AND status IN ('PENDING', 'RUNNING');
END;
$$;


ALTER FUNCTION public.playback_finish(p_job_id uuid, p_messages_sent integer, p_error text, p_messages_out_of_window integer) OWNER TO postgres;

--

-- FUNCTION playback_finish(p_job_id uuid, p_messages_sent integer, p_error text, p_messages_out_of_window integer) :: COMMENT
COMMENT ON FUNCTION public.playback_finish(p_job_id uuid, p_messages_sent integer, p_error text, p_messages_out_of_window integer) IS 'The playback worker recording the end of a job. Three outcomes, in this order: an error is FAILED; a job whose stop_requested flag was raised while it ran is CANCELLED; anything else is COMPLETED. The error outranks the flag because it is the half an operator can act on. Only a PENDING or RUNNING row is touched, so a job already cancelled before it was claimed keeps the status request_playback_stop() gave it. p_messages_out_of_window is recorded and not judged: the worker holds the plan and decides there, and a job whose every message would be discarded is reported here as an error.';

--

-- playback_progress(uuid, integer, integer, integer) :: FUNCTION
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


ALTER FUNCTION public.playback_progress(p_job_id uuid, p_messages_sent integer, p_messages_total integer, p_elapsed_seconds integer) OWNER TO postgres;

--

-- playback_reconcile_jobs() :: FUNCTION
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


ALTER FUNCTION public.playback_reconcile_jobs() OWNER TO postgres;

--

-- playback_report_credentials(text[], text[]) :: FUNCTION
CREATE OR REPLACE FUNCTION public.playback_report_credentials(p_edge_nodes text[], p_rotated text[] DEFAULT '{}'::text[]) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_held     text[];
    v_rotated  text[];
    v_observed jsonb;
BEGIN
    PERFORM public.require_playback_caller('playback_report_credentials');

    -- COERCED TO A SORTED, DE-DUPLICATED SET rather than stored as sent. The worker builds this
    -- from a JSON object whose key order is not defined, so storing it verbatim would rewrite the
    -- row -- and therefore wake every Realtime subscriber -- on a heartbeat that changed nothing.
    v_held := COALESCE(
      (SELECT array_agg(DISTINCT node ORDER BY node)
         FROM unnest(coalesce(p_edge_nodes, '{}')) AS node
        WHERE node IS NOT NULL AND btrim(node) <> ''),
      '{}'
    );

    -- Only ids actually held: a rotation reported for something no longer in the map would stamp an
    -- observation with nothing to describe.
    v_rotated := COALESCE(
      (SELECT array_agg(DISTINCT node)
         FROM unnest(coalesce(p_rotated, '{}')) AS node
        WHERE node = ANY(v_held)),
      '{}'
    );

    SELECT credential_observed_at INTO v_observed FROM public.playback_worker_status WHERE id;

    -- Keep what is still held and was not just rotated; stamp the rotations at `now()`. Narrowing
    -- to what is held is what stops an observation outliving the credential it describes.
    v_observed := COALESCE(
      (SELECT jsonb_object_agg(key, value)
         FROM jsonb_each(coalesce(v_observed, '{}'::jsonb))
        WHERE key = ANY(v_held) AND NOT (key = ANY(v_rotated))),
      '{}'::jsonb
    ) || COALESCE(
      (SELECT jsonb_object_agg(node, to_jsonb(now())) FROM unnest(v_rotated) AS node),
      '{}'::jsonb
    );

    UPDATE public.playback_worker_status
       SET held_edge_nodes        = v_held,
           credential_observed_at = v_observed,
           reported_at            = now()
     WHERE id;
END;
$$;


ALTER FUNCTION public.playback_report_credentials(p_edge_nodes text[], p_rotated text[]) OWNER TO postgres;

--

-- FUNCTION playback_report_credentials(p_edge_nodes text[], p_rotated text[]) :: COMMENT
COMMENT ON FUNCTION public.playback_report_credentials(p_edge_nodes text[], p_rotated text[]) IS 'The playback worker reporting which gateways it can authenticate as, and which of those it has picked up a NEW password for since it last reported. The only writer of playback_worker_status. Called on startup and on a heartbeat, so a stale reported_at means the worker is down rather than credential-less. The worker sends no timestamp of its own: this function stamps the rotations with now(), the same clock the CREDENTIAL_ISSUED row it is compared against uses. p_rotated defaults so a worker from the previous release still reports during a rollout.';

--

-- playback_stale_credentials() :: FUNCTION
CREATE OR REPLACE FUNCTION public.playback_stale_credentials() RETURNS TABLE(sparkplug_id text, observed_at timestamp with time zone, issued_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
    SELECT g.sparkplug_id,
           (w.credential_observed_at->>g.sparkplug_id)::timestamptz,
           i.issued_at
      FROM public.playback_worker_status w
      CROSS JOIN LATERAL unnest(w.held_edge_nodes) AS held(node)
      JOIN public.gateways g ON g.sparkplug_id = held.node
      -- THE SAME THREE PREDICATES gateway_has_broker_credential() uses, entity_type included: the
      -- trail is partitioned (0079) and carries no index on (entity_id, action), so the shape of
      -- this lookup is the one already established for that question rather than a new one. It runs
      -- over the held nodes alone -- a handful -- once per dialog open.
      JOIN LATERAL (
            SELECT max(dt.recorded_at) AS issued_at
              FROM public.audit_trail dt
             WHERE dt.entity_type = 'gateways'
               AND dt.entity_id   = g.id
               AND dt.action      = 'CREDENTIAL_ISSUED'
           ) i ON true
     WHERE i.issued_at IS NOT NULL
       -- NOT `IS DISTINCT FROM`: a missing observation must read as unknown, and the comparison
       -- below is false for NULL, which is the wanted answer.
       AND (w.credential_observed_at->>g.sparkplug_id)::timestamptz < i.issued_at
$$;


ALTER FUNCTION public.playback_stale_credentials() OWNER TO postgres;

--

-- FUNCTION playback_stale_credentials() :: COMMENT
COMMENT ON FUNCTION public.playback_stale_credentials() IS 'The gateways the playback worker reports holding a credential for whose credential has been re-issued since the worker last observed it (#217) -- so it is holding the previous password and a playback onto it would fail at CONNACK. SECURITY DEFINER so the dialog needs no privilege on audit_trail. A gateway with no observation is absent from this result, not stale: that is what a worker from the previous release reports.';

--

-- playback_target_must_be_shadow() :: FUNCTION
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


ALTER FUNCTION public.playback_target_must_be_shadow() OWNER TO postgres;

--

-- prevent_active_schema_mutation() :: FUNCTION
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


ALTER FUNCTION public.prevent_active_schema_mutation() OWNER TO postgres;

--

-- FUNCTION prevent_active_schema_mutation() :: COMMENT
COMMENT ON FUNCTION public.prevent_active_schema_mutation() IS 'Freezes every column except `status` on an active or archived schema, and rejects illegal status transitions for all callers.';

--

-- proposable_columns(text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.proposable_columns(p_entity_type text) RETURNS text[]
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE p_entity_type
    -- `area_id` joins `cell_id` and `location_scope`: the three together say where an asset sits,
    -- and the table's CHECKs decide whether the triple is sayable, so one proposal can relocate.
    WHEN 'devices' THEN ARRAY[
      'name', 'description', 'asset_type', 'connection_method',
      'cell_id', 'area_id', 'location_scope', 'model_3d_path'
    ]
    WHEN 'device_nameplate' THEN ARRAY[
      'manufacturer_name', 'manufacturer_product_designation', 'manufacturer_product_type',
      'serial_number', 'year_of_construction', 'date_of_manufacture', 'hardware_version',
      'firmware_version', 'software_version', 'country_of_origin', 'uri_of_the_product'
    ]

    -- Every column of an area a person chooses; the other two are the platform's. `name` reaches
    -- MQTT as the <area> segment of every uns/ topic beneath it, which is why the table carries
    -- `areas_name_topic_safe` and a UNIQUE -- both run on the approval's UPDATE. `icon` is one of
    -- the eight names `areas_icon_valid` admits.
    WHEN 'areas' THEN ARRAY['name', 'description', 'icon']

    -- `grafana_url` is a dashboard address and `icon` is one of eight names the CHECK on the table
    -- admits. `area_id` and the place are where the cell is; the cells trigger decides whether the
    -- three agree.
    WHEN 'cells' THEN ARRAY['name', 'grafana_url', 'icon', 'area_id', 'plan_x', 'plan_y', 'description']

    WHEN 'gateways' THEN ARRAY['name', 'description', 'cell_id', 'area_id', 'location_scope', 'access_url']

    -- 'schemas' is absent on purpose, and so are the three link lanes 0108 withdrew: the empty
    -- array is how this function closes a lane.
    ELSE ARRAY[]::text[]
  END
$$;


ALTER FUNCTION public.proposable_columns(p_entity_type text) OWNER TO postgres;

--

-- FUNCTION proposable_columns(p_entity_type text) :: COMMENT
COMMENT ON FUNCTION public.proposable_columns(p_entity_type text) IS 'Which columns a change proposal may name, per entity type. An unknown or withdrawn entity type yields the empty array, so a lane nobody has written an allowlist for can propose nothing at all rather than everything. Withdrawn: schemas (0090) and the three link lanes (0108). Areas joined in 0123.';

--

-- proposal_is_already_true(uuid) :: FUNCTION
CREATE OR REPLACE FUNCTION public.proposal_is_already_true(p_proposal_id uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_proposal public.change_proposals%ROWTYPE;
    v_current  jsonb;
BEGIN
    SELECT * INTO v_proposal FROM public.change_proposals WHERE id = p_proposal_id;
    IF NOT FOUND THEN
        RETURN false;
    END IF;

    SELECT CASE v_proposal.entity_type
        WHEN 'devices' THEN
            (SELECT to_jsonb(d) FROM public.devices d WHERE d.id = v_proposal.entity_id)
        WHEN 'device_nameplate' THEN
            (SELECT to_jsonb(n) FROM public.device_nameplate n
              WHERE n.device_id = v_proposal.entity_id)
        WHEN 'areas' THEN
            (SELECT to_jsonb(a) FROM public.areas a WHERE a.id = v_proposal.entity_id)
        WHEN 'cells' THEN
            (SELECT to_jsonb(c) FROM public.cells c WHERE c.id = v_proposal.entity_id)
        WHEN 'gateways' THEN
            (SELECT to_jsonb(g) FROM public.gateways g WHERE g.id = v_proposal.entity_id)
        ELSE NULL
    END INTO v_current;

    -- NO ROW IS NOT A NO-OP. A device_nameplate that does not exist yet is the normal case for that
    -- lane -- the approval CREATES it -- so a missing row means the proposal has everything still
    -- to do.
    IF v_current IS NULL THEN
        RETURN false;
    END IF;

    -- CONTAINMENT, NOT EQUALITY: does the row already hold every value the patch proposes? Columns
    -- the patch says nothing about are ignored, which is what a patch means.
    RETURN v_current @> v_proposal.patch;
END;
$$;


ALTER FUNCTION public.proposal_is_already_true(p_proposal_id uuid) OWNER TO postgres;

--

-- FUNCTION proposal_is_already_true(p_proposal_id uuid) :: COMMENT
COMMENT ON FUNCTION public.proposal_is_already_true(p_proposal_id uuid) IS 'Whether every value this proposal asks for is already in place -- because somebody made the change by hand while it sat in the queue. approve_proposal() refuses such a proposal rather than writing an audit row for a change that did not happen; the queue reads it to warn an approver first.';

--

-- prune_closed_proposals() :: FUNCTION
CREATE OR REPLACE FUNCTION public.prune_closed_proposals() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_days    numeric;
    v_deleted integer;
BEGIN
    SELECT (value #>> '{}')::numeric INTO v_days
      FROM public.system_settings
     WHERE key = 'proposals.retention_days';
    v_days := COALESCE(v_days, 90);

    DELETE FROM public.change_proposals
     WHERE status <> 'open'
       AND decided_at < now() - make_interval(secs => v_days::double precision * 86400.0);

    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;


ALTER FUNCTION public.prune_closed_proposals() OWNER TO postgres;

--

-- FUNCTION prune_closed_proposals() :: COMMENT
COMMENT ON FUNCTION public.prune_closed_proposals() IS 'Removes decided proposals older than proposals.retention_days. Only the queue entry: what an approval changed is in audit_trail under its own retention.';

--

-- prune_platform_alerts(interval) :: FUNCTION
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


ALTER FUNCTION public.prune_platform_alerts(p_retain interval) OWNER TO postgres;

--

-- FUNCTION prune_platform_alerts(p_retain interval) :: COMMENT
COMMENT ON FUNCTION public.prune_platform_alerts(p_retain interval) IS 'Delete alert occurrences older than the retention window, EXCEPT the newest occurrence of any fingerprint -- so an alert that has been firing longer than the window is never removed while it is still the current state. Returns the number of rows deleted. Scheduled as prune_platform_alerts; see the migration header for why the obvious one-line predicate is wrong.';

--

-- publish_schema_version(uuid) :: FUNCTION
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
  v_schema_ids     INTEGER := 0;
  v_merged         INTEGER := 0;
BEGIN
  -- NARROWED BY 0087. This admitted the pair while the RLS write policies it is the transactional
  -- form of admitted Administrator alone, and being SECURITY DEFINER it did not consult them --
  -- so it was the way around 0069 rather than an application of it.
  IF NOT public.has_authority(ARRAY['schema:manage']) THEN
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

    -- Rebind before archiving, so no window exists in which a device points at an archived schema. A
    -- device already carrying both versions as submodels would collide on `uq_device_submodels` when
    -- repointed, so the redundant old-version rows are dropped first.
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

    -- The dashboard's attachment moves too: `devices.schema_id` is the other arm of the
    -- `device_schemas` view. This UPDATE fires `log_audit_trail_event()`, so the rebinding lands in
    -- the audit trail per device.
    UPDATE public.devices SET schema_id = draft.id WHERE schema_id = parent.id;
    GET DIAGNOSTICS v_schema_ids = ROW_COUNT;

    IF parent.status = 'active' THEN
      UPDATE public.schemas SET status = 'archived' WHERE id = parent.id;
    END IF;
  END IF;

  UPDATE public.schemas SET status = 'active' WHERE id = draft.id RETURNING * INTO published;

  RETURN jsonb_build_object(
    'schema', to_jsonb(published),
    'archived_schema_id', parent.id,
    'archived_schema_name', parent.schema_name,
    'devices_rebound', v_submodels + v_schema_ids,
    'submodels_rebound', v_submodels,
    'schema_ids_rebound', v_schema_ids,
    'duplicate_submodels_removed', v_merged
  );
END;
$$;


ALTER FUNCTION public.publish_schema_version(draft_schema_id uuid) OWNER TO postgres;

--

-- FUNCTION publish_schema_version(draft_schema_id uuid) :: COMMENT
COMMENT ON FUNCTION public.publish_schema_version(draft_schema_id uuid) IS 'Activates a draft version, archives its parent, and atomically repoints every device_submodels row and devices.schema_id from the parent to it.';

--

-- raw_telemetry_window() :: FUNCTION
CREATE OR REPLACE FUNCTION public.raw_telemetry_window() RETURNS TABLE(raw_window_seconds numeric, archive_armed boolean, archive_reported_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
    IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Auditor']) THEN
        RETURN;
    END IF;
    RETURN QUERY
    SELECT EXTRACT(EPOCH FROM w.raw_window)::numeric, w.archive_armed, w.archive_reported_at
      FROM timescale.telemetry_raw_window w;
EXCEPTION
    -- postgres_fdw raises on CONNECT, so an unreachable historian arrives here.
    WHEN OTHERS THEN
        RETURN;
END;
$$;


ALTER FUNCTION public.raw_telemetry_window() OWNER TO postgres;

--

-- FUNCTION raw_telemetry_window() :: COMMENT
COMMENT ON FUNCTION public.raw_telemetry_window() IS 'How long raw telemetry is kept (NULL seconds = indefinitely) and whether the cold archiver last reported archiving on. No row when the historian cannot be read.';

--

-- record_directory_images(jsonb) :: FUNCTION
CREATE OR REPLACE FUNCTION public.record_directory_images(p_images jsonb) RETURNS integer
    LANGUAGE sql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
    WITH served_by(id, component) AS (VALUES
        ('f1111111-0000-0000-0000-000000000001'::uuid, 'supabase-studio'),
        ('f1111111-0000-0000-0000-000000000003'::uuid, 'node-red'),
        ('f1111111-0000-0000-0000-000000000004'::uuid, 'mosquitto'),
        ('f1111111-0000-0000-0000-000000000005'::uuid, 'timescaledb'),
        ('f1111111-0000-0000-0000-000000000006'::uuid, 'grafana'),
        ('f1111111-0000-0000-0000-000000000007'::uuid, 'supabase-envoy'),
        ('f1111111-0000-0000-0000-000000000008'::uuid, 'supabase-auth'),
        ('f1111111-0000-0000-0000-000000000009'::uuid, 'supabase-rest'),
        ('f1111111-0000-0000-0000-00000000000a'::uuid, 'supabase-functions'),
        ('f1111111-0000-0000-0000-00000000000b'::uuid, 'supabase-db'),
        ('f1111111-0000-0000-0000-00000000000c'::uuid, 'ingestion'),
        ('f1111111-0000-0000-0000-00000000000d'::uuid, 'swagger-ui'),
        ('f1111111-0000-0000-0000-00000000000e'::uuid, 'prometheus'),
        ('f1111111-0000-0000-0000-00000000000f'::uuid, 'alloy'),
        ('f1111111-0000-0000-0000-000000000010'::uuid, 'ingestion'),
        ('f1111111-0000-0000-0000-000000000011'::uuid, 'gitea')
    ), changed AS (
        -- A component missing from the map clears its row: the chart no longer deploys it, and
        -- the previous release's version would otherwise stay on the page.
        UPDATE public.directory_services d
           SET image = NULLIF(p_images ->> s.component, '')
          FROM served_by s
         WHERE d.id = s.id
           AND d.image IS DISTINCT FROM NULLIF(p_images ->> s.component, '')
        RETURNING 1
    )
    SELECT count(*)::integer FROM changed;
$$;


ALTER FUNCTION public.record_directory_images(p_images jsonb) OWNER TO postgres;

--

-- FUNCTION record_directory_images(p_images jsonb) :: COMMENT
COMMENT ON FUNCTION public.record_directory_images(p_images jsonb) IS 'Writes directory_services.image for the chart-managed rows from a component -> image map, clearing rows whose component is absent. Leaves every other row alone. Returns how many rows changed. Called by this migration with the chart''s map; db-init runs it as postgres.';

--

-- record_gateway_credential_issued(uuid) :: FUNCTION
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

  INSERT INTO public.audit_trail (
    entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
    causation_id, recorded_at
  ) VALUES (
    'gateways',
    v_gateway.id,
    'CREDENTIAL_ISSUED',
    NULL,
    -- The identity as it was at the time: `name` is mutable and the gateway may later be renamed or
    -- purged. No password and no hash of one: this table is readable by any holder of
    -- `audit_trail:read` and its rows cannot be deleted.
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


ALTER FUNCTION public.record_gateway_credential_issued(p_gateway_id uuid) OWNER TO postgres;

--

-- FUNCTION record_gateway_credential_issued(p_gateway_id uuid) :: COMMENT
COMMENT ON FUNCTION public.record_gateway_credential_issued(p_gateway_id uuid) IS 'Record that a broker credential was minted for a host-run gateway, as a CREDENTIAL_ISSUED row in audit_trail attributed to the calling operator. Carries the wire identity and never the password: the audit trail is append-only and the secret is reveal-once.';

--

-- record_gateway_credential_issued_by_service(uuid, jsonb) :: FUNCTION
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

  INSERT INTO public.audit_trail (
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


ALTER FUNCTION public.record_gateway_credential_issued_by_service(p_gateway_id uuid, p_context jsonb) OWNER TO postgres;

--

-- FUNCTION record_gateway_credential_issued_by_service(p_gateway_id uuid, p_context jsonb) :: COMMENT
COMMENT ON FUNCTION public.record_gateway_credential_issued_by_service(p_gateway_id uuid, p_context jsonb) IS 'Record that a host script issued a broker credential to a gateway, as a CREDENTIAL_ISSUED row in audit_trail. Reachable by service_role ALONE -- 0041''s pair is the operator path and gates on has_role(), which no host script can satisfy. actor_source is pinned to ''service'' and changed_by to NULL; the host and OS user are stored under `claimed` because the database cannot verify either. Carries the wire identity and never the password.';

--

-- record_ingestion_rejection(uuid, jsonb, timestamp with time zone) :: FUNCTION
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
    -- trail forever describing nothing.
    SELECT id, name, sparkplug_id, schema_id INTO v_device
      FROM public.devices WHERE id = p_device_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'record_ingestion_rejection: no device with id %', p_device_id
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    INSERT INTO public.audit_trail (
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


ALTER FUNCTION public.record_ingestion_rejection(p_device_id uuid, p_violations jsonb, p_observed_at timestamp with time zone) OWNER TO postgres;

--

-- FUNCTION record_ingestion_rejection(p_device_id uuid, p_violations jsonb, p_observed_at timestamp with time zone) :: COMMENT
COMMENT ON FUNCTION public.record_ingestion_rejection(p_device_id uuid, p_violations jsonb, p_observed_at timestamp with time zone) IS 'Record a Sparkplug payload the ingestion daemon refused, as a SCHEMA_REJECTION row in audit_trail. The violation list is capped at 50 entries with the true count kept alongside. actor_source is pinned to ''ingestion'' and changed_by to NULL: this is the narrow gate that replaces service_role''s direct INSERT on the audit table. Callable only by the Service_Ingestor principal (0051), which is what makes the grant to `authenticated` safe.';

--

-- record_retired_entity() :: FUNCTION
CREATE OR REPLACE FUNCTION public.record_retired_entity() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_row    jsonb := to_jsonb(OLD);
    v_actor  uuid;
    v_email  text;
    v_trail bigint;
BEGIN
    -- ONLY A ROW THAT WENT THROUGH THE LIFECYCLE. A device rejected from quarantine, a fixture a
    -- suite removes, a row a cleanup migration deletes: none was in service, and a tombstone for
    -- it would be noise beside the ones that matter.
    IF NOT COALESCE((v_row ->> 'is_archived')::boolean, false) THEN
        RETURN OLD;
    END IF;

    -- Who, the way log_audit_trail_event() answers it: the session's user, else the actor a
    -- SECURITY DEFINER RPC declared with SET LOCAL.
    v_actor := auth.uid();
    IF v_actor IS NULL THEN
        BEGIN
            v_actor := NULLIF(current_setting('aber.actor_id', true), '')::uuid;
        EXCEPTION WHEN others THEN
            v_actor := NULL;
        END;
    END IF;
    v_email := NULLIF(auth.jwt() ->> 'email', '');

    -- The DELETE audit row this same event wrote. AFTER triggers on one event fire in name order
    -- and trg_<table>_retired sorts after trg_<table>_audit_trail, so it is there to find;
    -- looked up by the transaction rather than assumed, so a renamed trigger leaves this NULL
    -- rather than pointing at the wrong row.
    SELECT t.id INTO v_trail
      FROM public.audit_trail t
     WHERE t.entity_type = TG_TABLE_NAME
       AND t.entity_id = OLD.id
       AND t.action = 'DELETE'
       AND t.causation_id = txid_current()
     ORDER BY t.id DESC
     LIMIT 1;

    -- An upsert: a pinned-id fixture can be archived and deleted more than once, and the latest
    -- retirement is the one that describes the row.
    INSERT INTO public.retired_entities
        (entity_type, entity_id, name, sparkplug_id, archived_at, retired_at,
         retired_by, retired_by_email, trail_id, old_data)
    VALUES
        (TG_TABLE_NAME, OLD.id, v_row ->> 'name', v_row ->> 'sparkplug_id',
         (v_row ->> 'archived_at')::timestamp with time zone, now(),
         v_actor, v_email, v_trail, v_row)
    ON CONFLICT (entity_type, entity_id) DO UPDATE
       SET name             = EXCLUDED.name,
           sparkplug_id     = EXCLUDED.sparkplug_id,
           archived_at      = EXCLUDED.archived_at,
           retired_at       = EXCLUDED.retired_at,
           retired_by       = EXCLUDED.retired_by,
           retired_by_email = EXCLUDED.retired_by_email,
           trail_id        = EXCLUDED.trail_id,
           old_data         = EXCLUDED.old_data;

    RETURN OLD;
END;
$$;


ALTER FUNCTION public.record_retired_entity() OWNER TO postgres;

--

-- FUNCTION record_retired_entity() :: COMMENT
COMMENT ON FUNCTION public.record_retired_entity() IS 'Writes the retired_entities tombstone for an archived row on its DELETE. SECURITY DEFINER because the operator deleting the row holds no grant on the tombstone table, and it must not: a tombstone is evidence of a delete, not something a client writes.';

--

-- record_service_token_issued(uuid, text, timestamp with time zone, jsonb, uuid) :: FUNCTION
CREATE OR REPLACE FUNCTION public.record_service_token_issued(p_principal_id uuid, p_jti text, p_expires_at timestamp with time zone, p_context jsonb DEFAULT '{}'::jsonb, p_actor_id uuid DEFAULT NULL::uuid) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_roles      text[];
  v_is_service boolean;
  v_ttl_days   numeric;
  v_actor      uuid := p_actor_id;
  v_source     text;
  v_id         bigint;
BEGIN
  IF p_principal_id IS NULL THEN
    RAISE EXCEPTION 'record_service_token_issued: p_principal_id is required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- A `jti` is the key of the denylist `auth_pre_request()` reads, so it is what a revocation is
  -- performed against. Bounded because it lands in an append-only table.
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

  -- THE CEILING. The callers refuse this too, and because they record before they print, a
  -- refusal here means the token never reaches anybody.
  v_ttl_days := extract(epoch FROM (p_expires_at - now())) / 86400.0;
  IF v_ttl_days > public.service_token_max_days() THEN
    RAISE EXCEPTION
      'record_service_token_issued: a token may not outlive % days (asked for %). A token can be '
      'revoked against the API (0074), but storage, realtime and the edge functions verify the '
      'signature only -- so the expiry is still the only bound that reaches every service.',
      public.service_token_max_days(), round(v_ttl_days, 1)
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The subject must be a service principal: no email and no password means nothing can present
  -- this identity except a JWT signed outside GoTrue. A long-lived token minted against an
  -- Administrator's login would be a permanent escalation of that person's session.
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
      'principal. A long-lived token for it would escalate that person''s session.', p_principal_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- A revoked principal cannot be issued a new token; without this the page would sign a
  -- credential that is refused on its first request. A forward reference to 0076, safe because
  -- PL/pgSQL resolves a call at execution time and the whole chain replays before anything calls
  -- this.
  PERFORM public.assert_principal_not_revoked(p_principal_id);

  -- ---------------------------------------------------------------------------------------------
  -- The actor is re-checked here, not trusted: `mint-service-token` verifies the session before
  -- it signs, and this is the second of two checks, so authorisation does not rest solely on a
  -- function that also holds the signing key. Refused rather than downgraded to NULL.
  -- ---------------------------------------------------------------------------------------------
  IF v_actor IS NULL THEN
    -- 0043's original attribution, unchanged: the caller holds a machine credential and there is
    -- no person to name.
    v_source := 'service';
  ELSE
    IF NOT EXISTS (
      SELECT 1
        FROM public.user_roles ur
        JOIN public.roles r ON r.id = ur.role_id
       WHERE ur.user_id = v_actor::text
         AND r.name = 'Administrator'
    ) THEN
      RAISE EXCEPTION
        'record_service_token_issued: % is not an Administrator, so it cannot be recorded as '
        'having issued a service token.', v_actor
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- 'user', which log_audit_trail_event() refuses from a REQUEST HEADER for good reason --
    -- claiming a human author is the assertion a client must not make about itself. It is written
    -- here only after the claim has been checked against user_roles above.
    v_source := 'user';
  END IF;

  -- WHAT THE TOKEN COULD DO AT THE MOMENT IT WAS SIGNED, captured rather than left to a join. An
  -- audit row readable only by joining to a live row loses its meaning in exactly the cases it
  -- matters most -- and a role removed later does not shorten a token signed while it was held.
  SELECT coalesce(array_agg(r.name ORDER BY r.name), '{}'::text[])
    INTO v_roles
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
   WHERE ur.user_id = p_principal_id::text;

  INSERT INTO public.audit_trail (
    entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
    causation_id, recorded_at
  ) VALUES (
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
      -- Asserted by the caller and labelled as such; the database cannot verify either value. Only
      -- these two are lifted out of p_context, so a caller cannot add fields that look authoritative.
      -- Empty for a mint from the page; the attribution is in `changed_by`.
      'claimed',      jsonb_build_object(
                        'os_user', p_context ->> 'os_user',
                        'host',    p_context ->> 'host'
                      )
    ),
    v_actor,
    v_source,
    txid_current(),
    now()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;


ALTER FUNCTION public.record_service_token_issued(p_principal_id uuid, p_jti text, p_expires_at timestamp with time zone, p_context jsonb, p_actor_id uuid) OWNER TO postgres;

--

-- FUNCTION record_service_token_issued(p_principal_id uuid, p_jti text, p_expires_at timestamp with time zone, p_context jsonb, p_actor_id uuid) :: COMMENT
COMMENT ON FUNCTION public.record_service_token_issued(p_principal_id uuid, p_jti text, p_expires_at timestamp with time zone, p_context jsonb, p_actor_id uuid) IS 'Record that a long-lived JWT was signed for a service principal, as a TOKEN_MINTED row in audit_trail. Refuses a human account and any expiry beyond service_token_max_days(). With p_actor_id NULL the row is attributed to ''service'' with no changed_by, which is how the host scripts record. With an actor it is re-checked against user_roles for Administrator and the row names that person -- the shape mint-service-token uses.';

--

-- refresh_directory_liveness() :: FUNCTION
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


ALTER FUNCTION public.refresh_directory_liveness() OWNER TO postgres;

--

-- FUNCTION refresh_directory_liveness() :: COMMENT
COMMENT ON FUNCTION public.refresh_directory_liveness() IS 'Collects the previous Prometheus `up` probe, writes ACTIVE/DOWN for the six observed services and UNKNOWN for the rest, then queues the next probe. Returns how many rows were written from a real observation. Run every minute by cron; safe to call by hand.';

--

-- refuse_archiving_the_last_shadow_gateway() :: FUNCTION
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


ALTER FUNCTION public.refuse_archiving_the_last_shadow_gateway() OWNER TO postgres;

--

-- FUNCTION refuse_archiving_the_last_shadow_gateway() :: COMMENT
COMMENT ON FUNCTION public.refuse_archiving_the_last_shadow_gateway() IS 'Refuses the archive that would leave a stack with no un-archived shadow gateway. Not a ban on archiving one: swapping in a replacement first is legitimate and is what 0060''s own error text tells an operator to do.';

--

-- refuse_hand_assigning_a_replay_lane() :: FUNCTION
CREATE OR REPLACE FUNCTION public.refuse_hand_assigning_a_replay_lane() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_gateway public.gateways;
BEGIN
    -- NOT AN ARRIVAL. `BEFORE UPDATE OF gateway_id` fires when the column is MENTIONED, not when
    -- it changes -- and PostgREST sends the whole row on a PATCH, so an operator renaming a lane
    -- mentions gateway_id every time. Without this the rename would be refused.
    IF TG_OP = 'UPDATE' AND NEW.gateway_id IS NOT DISTINCT FROM OLD.gateway_id THEN
        RETURN NEW;
    END IF;

    -- Unassigned is not a lane, and a device that HAS provenance is exactly what a lane is.
    IF NEW.gateway_id IS NULL OR NEW.shadow_of IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT * INTO v_gateway FROM public.gateways WHERE id = NEW.gateway_id;

    -- NOT FOUND IS LET THROUGH ON PURPOSE. `devices_gateway_id_fkey` is about to refuse this row
    -- and will name the missing gateway; raising here first would replace a precise foreign-key
    -- error with a confusing one about playback.
    IF NOT FOUND OR NOT v_gateway.is_shadow THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
      'devices: % is a playback gateway, and a device cannot be assigned to one. Its devices are '
      'REPLAY LANES -- each stands in for a real machine, and which machine is recorded in '
      'shadow_of. A device placed here by hand would stand in for nothing: an asset with no '
      'provenance, exporting an Asset Administration Shell for a machine that does not exist. '
      'Lanes are minted by ensure_shadow_devices() when a capture is played, one per recorded '
      'device and reused across runs. To replay onto this gateway, start a playback from the '
      'capture instead.',
      v_gateway.name
        USING ERRCODE = 'check_violation';
END;
$$;


ALTER FUNCTION public.refuse_hand_assigning_a_replay_lane() OWNER TO postgres;

--

-- FUNCTION refuse_hand_assigning_a_replay_lane() :: COMMENT
COMMENT ON FUNCTION public.refuse_hand_assigning_a_replay_lane() IS 'Refuses a device ARRIVING on a shadow gateway without shadow_of -- an INSERT, or an UPDATE that changes gateway_id. Deliberately silent about a device already there whose shadow_of has become NULL: devices_shadow_of_fkey is ON DELETE SET NULL, so that is the legal state of a lane whose original was deleted, and checking it would make that deletion fail. See 0083''s header.';

--

-- refuse_role_for_machine_principal() :: FUNCTION
CREATE OR REPLACE FUNCTION public.refuse_role_for_machine_principal() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
BEGIN
    -- `user_roles.user_id` is TEXT and carries no FK, so it is not guaranteed to be a uuid. A cast
    -- that raises here would refuse a row for the wrong reason and name the wrong problem, so the
    -- shape is checked before the predicate is asked.
    IF NEW.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND public.is_machine_principal(NEW.user_id::uuid) THEN
        RAISE EXCEPTION
            'user_roles: % is a machine principal and may not hold a role. Grant it permissions '
            'with create_machine_principal() or principal_permissions instead -- 0080 separated the '
            'two so that widening a person''s role stops widening the stack''s own processes.',
            NEW.user_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN NEW;
END;
$_$;


ALTER FUNCTION public.refuse_role_for_machine_principal() OWNER TO postgres;

--

-- FUNCTION refuse_role_for_machine_principal() :: COMMENT
COMMENT ON FUNCTION public.refuse_role_for_machine_principal() IS 'BEFORE INSERT/UPDATE guard on user_roles. Refuses a role assignment to an identity that cannot sign in, which is what makes "a machine resolves through its own grants" a property of the database rather than a convention every future author has to remember.';

--

-- register_uploaded_capture(text, uuid, text, bigint, integer, jsonb, text, boolean) :: FUNCTION
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


ALTER FUNCTION public.register_uploaded_capture(p_subject_kind text, p_subject_id uuid, p_storage_path text, p_size_bytes bigint, p_message_count integer, p_manifest jsonb, p_note text, p_replace boolean) OWNER TO postgres;

--

-- reinstate_service_principal(uuid) :: FUNCTION
CREATE OR REPLACE FUNCTION public.reinstate_service_principal(p_principal_id uuid) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_actor uuid;
  v_id    bigint;
BEGIN
  IF NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'insufficient privileges to reinstate a service principal'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'reinstate_service_principal: no session, so this could not be attributed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  DELETE FROM public.revoked_service_principals WHERE principal_id = p_principal_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reinstate_service_principal: % is not revoked', p_principal_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.audit_trail (
    entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
    causation_id, recorded_at
  ) VALUES (
    'service_principals',
    p_principal_id,
    'PRINCIPAL_REINSTATED',
    NULL,
    -- SAID ON THE ROW, because it is the thing most likely to be assumed wrong. Reinstating
    -- restores the IDENTITY, not its credentials: every token withdrawn when it was revoked stays
    -- withdrawn, because revoke_service_token() has no inverse. A new token must be minted.
    jsonb_build_object(
      'reinstated_at',  now(),
      'tokens_restored', 0,
      'note', 'Tokens revoked with this principal remain revoked; mint a new one.'
    ),
    v_actor,
    'user',
    txid_current(),
    now()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;


ALTER FUNCTION public.reinstate_service_principal(p_principal_id uuid) OWNER TO postgres;

--

-- FUNCTION reinstate_service_principal(p_principal_id uuid) :: COMMENT
COMMENT ON FUNCTION public.reinstate_service_principal(p_principal_id uuid) IS 'Administrator-only. Lifts the flag revoke_service_principal() set, so the identity can hold tokens again. Does NOT restore the tokens revoked alongside it -- those stay withdrawn and a new one must be minted.';

--

-- reject_archived_schema_assignment() :: FUNCTION
CREATE OR REPLACE FUNCTION public.reject_archived_schema_assignment() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
    v_device_id  uuid;
    v_is_shadow  boolean := false;
    v_status     text;
    v_name       text;
    v_version    integer;
    v_successor  text;
BEGIN
    -- One function, two tables: `devices.schema_id` and `device_submodels.schema_id` are the two
    -- arms of the `device_schemas` view, and a guard on one of them is not a guard.
    IF TG_TABLE_NAME = 'devices' THEN
        v_device_id := NEW.id;
        -- READ OFF `NEW`, NOT OUT OF THE TABLE. On INSERT the row is not visible to a query yet,
        -- so a lookup would report "not a shadow" for every shadow device at the moment it is
        -- created -- which is the only moment ensure_shadow_devices() writes this column.
        v_is_shadow := NEW.shadow_of IS NOT NULL;
    ELSE
        v_device_id := NEW.device_id;
        -- The submodel rows are written AFTER the shadow device exists, so here the lookup is both
        -- possible and necessary -- the join row carries no shadow marker of its own.
        SELECT d.shadow_of IS NOT NULL INTO v_is_shadow
          FROM public.devices d WHERE d.id = v_device_id;
    END IF;

    -- Detaching is always allowed. So is leaving the pointer exactly where it was: see the header
    -- for why the unchanged-value case is the one that keeps an unfinished migration editable.
    IF NEW.schema_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.schema_id IS NOT DISTINCT FROM OLD.schema_id THEN
        RETURN NEW;
    END IF;

    IF coalesce(v_is_shadow, false) THEN
        RETURN NEW;
    END IF;

    SELECT s.status::text, s.schema_name, s.version
      INTO v_status, v_name, v_version
      FROM public.schemas s
     WHERE s.id = NEW.schema_id;

    -- A schema_id naming nothing is left to the foreign key, which states that better than this
    -- trigger could. `IS DISTINCT FROM` rather than `<>` so a NULL status falls through here too.
    IF v_status IS DISTINCT FROM 'archived' THEN
        RETURN NEW;
    END IF;

    -- THE ERROR NAMES THE WAY OUT, because the operator reaching this is not doing something
    -- absurd -- they are looking at a version history and picked the wrong row. The successor is
    -- resolved here rather than left for them to find: it is one query, and "use v2 instead" is
    -- the entire remedy in most cases.
    SELECT s.schema_name INTO v_successor
      FROM public.schemas s
     WHERE s.parent_schema_id = NEW.schema_id
       AND s.status::text = 'active'
     ORDER BY s.version DESC
     LIMIT 1;

    RAISE EXCEPTION
        'schema "%" (v%) is archived and cannot be assigned to a device',
        v_name, v_version
        USING ERRCODE = 'check_violation',
              HINT = coalesce(
                  'Assign ' || v_successor || ', which replaced it.',
                  'This lineage has no active version. Publish one from the Schemas page, or leave '
                  'the device without a schema.'
              );
END;
$$;


ALTER FUNCTION public.reject_archived_schema_assignment() OWNER TO postgres;

--

-- FUNCTION reject_archived_schema_assignment() :: COMMENT
COMMENT ON FUNCTION public.reject_archived_schema_assignment() IS 'Refuses a NEW binding of a device to an archived schema, on either arm of the device_schemas view. Leaving an existing binding in place is allowed -- an archived schema with devices still attached is an unfinished migration, not a fault -- and shadow devices are exempt because they copy the contract of the device they replay. Issue #167.';

--

-- reject_proposal(uuid, text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.reject_proposal(p_proposal_id uuid, p_reason text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_proposal public.change_proposals%ROWTYPE;
    v_actor    uuid := auth.uid();
BEGIN
    IF NOT (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
            OR public.has_authority(ARRAY['cell:manage', 'gateway:manage'])) THEN
        RAISE EXCEPTION 'not permitted to decide change proposals'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF COALESCE(TRIM(p_reason), '') = '' THEN
        -- A REASON IS THE WHOLE POINT OF A REJECTION. Without one the proposer learns only that
        -- somebody said no, which leaves them to propose the same thing again.
        RAISE EXCEPTION 'a rejection needs a reason' USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT * INTO v_proposal FROM public.change_proposals
     WHERE id = p_proposal_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'proposal % not found', p_proposal_id USING ERRCODE = 'no_data_found';
    END IF;

    IF NOT public.may_decide_proposal(v_proposal.entity_type) THEN
        RAISE EXCEPTION 'not permitted to decide proposals on %', v_proposal.entity_type
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF v_proposal.status <> 'open' THEN
        RAISE EXCEPTION 'proposal % is already %', p_proposal_id, v_proposal.status
            USING ERRCODE = 'check_violation';
    END IF;

    PERFORM set_config('aber.proposal_transition', 'on', true);

    UPDATE public.change_proposals
       SET status = 'rejected', decided_by = v_actor, decided_at = now(),
           decision_reason = p_reason
     WHERE id = p_proposal_id;

    RETURN jsonb_build_object('id', p_proposal_id, 'status', 'rejected');
END;
$$;


ALTER FUNCTION public.reject_proposal(p_proposal_id uuid, p_reason text) OWNER TO postgres;

--

-- FUNCTION reject_proposal(p_proposal_id uuid, p_reason text) :: COMMENT
COMMENT ON FUNCTION public.reject_proposal(p_proposal_id uuid, p_reason text) IS 'An approver refuses a proposal in a lane may_decide_proposal() admits them to, with a reason the constraint also requires. The slot is freed immediately and the same change may be proposed again at once -- the reason, not a cooldown, is what makes the second attempt different from the first.';

--

-- release_backup(uuid) :: FUNCTION
CREATE OR REPLACE FUNCTION public.release_backup(p_backup_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_backup public.backups;
BEGIN
    IF NOT public.has_role(ARRAY['Administrator'::text]) THEN
        RAISE EXCEPTION 'release_backup: only an Administrator may release a backup'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    UPDATE public.backups
       SET pinned = false, released_at = now(), released_by = auth.uid()
     WHERE id = p_backup_id AND pinned
    RETURNING * INTO v_backup;

    IF NOT FOUND THEN
        RETURN false;
    END IF;

    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'backups', v_backup.id, 'BACKUP_RELEASED',
        jsonb_build_object('pinned', true),
        jsonb_build_object('pinned', false, 'stamp', v_backup.stamp, 'taken_at', v_backup.taken_at),
        auth.uid(), 'user', txid_current(), now()
    );

    RETURN true;
END;
$$;


ALTER FUNCTION public.release_backup(p_backup_id uuid) OWNER TO postgres;

--

-- FUNCTION release_backup(p_backup_id uuid) :: COMMENT
COMMENT ON FUNCTION public.release_backup(p_backup_id uuid) IS 'Let the retention window apply to a requested backup. Administrator only. Nothing is deleted here: the service prunes on its next pass, and only if the backup is older than the window. Returns false when the backup was not pinned.';

--

-- release_forge_sweep(uuid) :: FUNCTION
CREATE OR REPLACE FUNCTION public.release_forge_sweep(p_holder uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_requested boolean;
BEGIN
    SELECT requested INTO v_requested
      FROM public.forge_sweep_lease
     WHERE id AND holder = p_holder
       FOR UPDATE;
    IF NOT FOUND THEN
        RETURN false;
    END IF;

    UPDATE public.forge_sweep_lease
       SET holder = NULL, held_until = '-infinity', requested = false
     WHERE id;

    -- A call refused during the pass may have come after the pass read what it asked about.
    -- Queued on commit; any number of refusals come to this one pass.
    IF v_requested THEN
        PERFORM public.sweep_forge();
    END IF;
    RETURN true;
END;
$$;


ALTER FUNCTION public.release_forge_sweep(p_holder uuid) OWNER TO postgres;

--

-- FUNCTION release_forge_sweep(p_holder uuid) :: COMMENT
COMMENT ON FUNCTION public.release_forge_sweep(p_holder uuid) IS 'Release the forge-sweep lease if p_holder holds it, and queue one more pass through sweep_forge() when a claim was refused while it was held. False, and nothing released, for any other id.';

--

-- release_gateway_enrollment_token(text) :: FUNCTION
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


ALTER FUNCTION public.release_gateway_enrollment_token(p_token text) OWNER TO postgres;

--

-- FUNCTION release_gateway_enrollment_token(p_token text) :: COMMENT
COMMENT ON FUNCTION public.release_gateway_enrollment_token(p_token text) IS 'Undo a claim made by consume_gateway_enrollment_token() when the credential could not be issued, so the appliance can retry with the same bundle. Refuses to release an expired token or one that has since been superseded by a re-issue -- both would restore a row the partial unique index counts, blocking the operator from issuing a replacement. Returns whether it released.';

--

-- relocate_devices(jsonb) :: FUNCTION
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
  v_area      uuid;
  v_raw_area  text;
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

  -- An empty batch is a caller bug: the page disables Apply at zero staged moves.
  IF v_len = 0 THEN
    RAISE EXCEPTION 'p_moves is empty; nothing to relocate'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Every row below takes a FOR UPDATE lock held until commit, so the batch is bounded.
  IF v_len > 200 THEN
    RAISE EXCEPTION 'a relocation batch is limited to 200 moves; got %', v_len
      USING ERRCODE = 'program_limit_exceeded',
            HINT = 'Apply the rearrangement in smaller batches.';
  END IF;

  -- One device may appear once: "last one wins" would silently discard an instruction.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_moves) m
     GROUP BY m ->> 'device_id'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'p_moves names the same device more than once; a batch must state one destination per device'
      USING ERRCODE = 'cardinality_violation';
  END IF;

  -- Ordered by device_id so two overlapping batches cannot deadlock on their row locks.
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

    -- Required, not defaulted to 'cell': a caller that forgot the key would silently clear a
    -- wide scope an operator asserted.
    v_scope := v_move ->> 'location_scope';
    IF v_scope IS NULL THEN
      RAISE EXCEPTION 'move for device % must state location_scope (cell, area_wide or site_wide)', v_device_id
        USING ERRCODE = 'null_value_not_allowed';
    END IF;
    IF v_scope NOT IN ('cell', 'area_wide', 'site_wide') THEN
      RAISE EXCEPTION 'location_scope % is not valid for device %; expected cell, area_wide or site_wide',
                      v_scope, v_device_id
        USING ERRCODE = 'check_violation';
    END IF;

    -- Empty string reads as absent, as emptyToNull() does in frontend/src/api.js.
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

    v_raw_area := NULLIF(btrim(COALESCE(v_move ->> 'area_id', '')), '');
    IF v_raw_area IS NULL THEN
      v_area := NULL;
    ELSE
      BEGIN
        v_area := v_raw_area::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'area_id % is not a uuid', v_raw_area
          USING ERRCODE = 'invalid_parameter_value';
      END;
    END IF;

    -- Mirrors the CHECKs and locationFieldsFrom() in frontend/src/api.js. Forced rather than
    -- rejected: "site-wide, in cell 3" is an incompletely cleared form, not a refusal case. The
    -- one thing that cannot be forced is an area-wide move with no area, which is refused.
    IF v_scope = 'site_wide' THEN
      v_cell := NULL;
      v_area := NULL;
    ELSIF v_scope = 'area_wide' THEN
      v_cell := NULL;
      IF v_area IS NULL THEN
        RAISE EXCEPTION 'an area_wide move for device % must name area_id', v_device_id
          USING ERRCODE = 'null_value_not_allowed';
      END IF;
    ELSE
      v_area := NULL;
    END IF;

    SELECT * INTO v_before FROM public.devices WHERE id = v_device_id FOR UPDATE;
    IF NOT FOUND THEN
      -- The whole batch fails: a half-applied rearrangement is what the batch exists to remove.
      RAISE EXCEPTION 'device % not found; no part of this batch was applied', v_device_id
        USING ERRCODE = 'no_data_found';
    END IF;

    IF v_cell IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.cells c WHERE c.id = v_cell) THEN
      RAISE EXCEPTION 'cell % not found; no part of this batch was applied', v_cell
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF v_area IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.areas a WHERE a.id = v_area) THEN
      RAISE EXCEPTION 'area % not found; no part of this batch was applied', v_area
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- The gateway is left alone: a drop says where the machine is, not which connector reaches it.
    UPDATE public.devices
       SET cell_id        = v_cell,
           area_id        = v_area,
           location_scope = v_scope
     WHERE id = v_device_id
    RETURNING * INTO v_after;

    v_changed := v_before.cell_id IS DISTINCT FROM v_after.cell_id
              OR v_before.area_id IS DISTINCT FROM v_after.area_id
              OR v_before.location_scope IS DISTINCT FROM v_after.location_scope;

    -- A no-op move is counted but not called applied: the audit trigger writes no row for it.
    IF v_changed THEN
      v_applied := v_applied + 1;
    ELSE
      v_unchanged := v_unchanged + 1;
    END IF;

    v_results := v_results || jsonb_build_object(
      'device_id',      v_after.id,
      'cell_id',        v_after.cell_id,
      'area_id',        v_after.area_id,
      'location_scope', v_after.location_scope,
      'changed',        v_changed
    );
  END LOOP;

  RETURN jsonb_build_object(
    -- The transaction the UPDATEs ran in, which log_audit_trail_event() stamped on every row it
    -- wrote; NULL when nothing changed, since the trigger then wrote no row.
    'causation_id', CASE WHEN v_applied > 0 THEN txid_current() ELSE NULL END,
    'requested',    v_len,
    'applied',      v_applied,
    'unchanged',    v_unchanged,
    'devices',      v_results
  );
END;
$$;


ALTER FUNCTION public.relocate_devices(p_moves jsonb) OWNER TO postgres;

--

-- FUNCTION relocate_devices(p_moves jsonb) :: COMMENT
COMMENT ON FUNCTION public.relocate_devices(p_moves jsonb) IS 'Apply a batch of device relocations in ONE transaction, so the whole rearrangement shares a single audit_trail causation_id. A move states location_scope (cell, area_wide or site_wide) and, for area_wide, area_id. Refuses the batch outright on an unknown device, cell or area, a duplicate device, a missing location_scope or an area_wide move with no area -- a half-applied batch is the failure mode this exists to remove. Authority: Administrator or Shopfloor_Manager.';

--

-- renew_forge_sweep(uuid, integer) :: FUNCTION
CREATE OR REPLACE FUNCTION public.renew_forge_sweep(p_holder uuid, p_seconds integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    IF p_seconds IS NULL OR p_seconds NOT BETWEEN 1 AND 3600 THEN
        RAISE EXCEPTION 'renew_forge_sweep: a lease lasts 1 to 3600 seconds, not %', p_seconds
            USING ERRCODE = '22023';
    END IF;

    -- By holder alone: a lapsed lease nobody took over is still this holder's. Called as a pass
    -- starts under a lease its caller holds, so it clears `requested` as a claim does.
    UPDATE public.forge_sweep_lease
       SET held_until = clock_timestamp() + make_interval(secs => p_seconds),
           requested = false
     WHERE id AND holder = p_holder;
    RETURN FOUND;
END;
$$;


ALTER FUNCTION public.renew_forge_sweep(p_holder uuid, p_seconds integer) OWNER TO postgres;

--

-- FUNCTION renew_forge_sweep(p_holder uuid, p_seconds integer) :: COMMENT
COMMENT ON FUNCTION public.renew_forge_sweep(p_holder uuid, p_seconds integer) IS 'Extend the forge-sweep lease p_holder holds by p_seconds from now, as a pass starts under it. False when p_holder is not the holder: never claimed, released, or taken over after it lapsed.';

--

-- request_backup(text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.request_backup(p_note text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_running record;
    v_job_id  uuid;
BEGIN
    IF NOT public.has_role(ARRAY['Administrator'::text]) THEN
        RAISE EXCEPTION 'request_backup: only an Administrator may take a backup'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Reported rather than left to the index, so the refusal says what is in the way. A PENDING
    -- row nobody has claimed is the sign the service is not running, and the message says so.
    SELECT j.id, j.status, j.origin, j.created_at INTO v_running
      FROM public.backup_jobs j
     WHERE j.status IN ('PENDING', 'RUNNING')
     LIMIT 1;
    IF FOUND THEN
        IF v_running.status = 'PENDING' THEN
            RAISE EXCEPTION
              'request_backup: a % backup queued at % has not been claimed. One backup runs at a '
              'time; if the backup service is not running, nothing will take it -- cancel it or '
              'start the service.',
              v_running.origin, to_char(v_running.created_at, 'DD Mon YYYY HH24:MI')
                USING ERRCODE = 'unique_violation';
        END IF;
        RAISE EXCEPTION
          'request_backup: a % backup is running. One backup runs at a time; wait for it to finish.',
          v_running.origin
            USING ERRCODE = 'unique_violation';
    END IF;

    INSERT INTO public.backup_jobs (origin, status, note, requested_by)
    VALUES ('requested', 'PENDING', nullif(btrim(coalesce(p_note, '')), ''), auth.uid())
    RETURNING id INTO v_job_id;

    INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        'backup_jobs', v_job_id, 'BACKUP_REQUESTED', NULL,
        jsonb_build_object('note', nullif(btrim(coalesce(p_note, '')), ''), 'origin', 'requested'),
        auth.uid(), 'user', txid_current(), now()
    );

    RETURN v_job_id;
END;
$$;


ALTER FUNCTION public.request_backup(p_note text) OWNER TO postgres;

--

-- FUNCTION request_backup(p_note text) :: COMMENT
COMMENT ON FUNCTION public.request_backup(p_note text) IS 'Queue a backup of the whole stack: both databases, the storage objects and the forge, taken by the backup service and pinned until release_backup(). Administrator only. Refuses while another backup is queued or running, naming it.';

--

-- request_capture_stop(uuid) :: FUNCTION
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


ALTER FUNCTION public.request_capture_stop(p_job_id uuid) OWNER TO postgres;

--

-- request_gateway_rebirth(uuid) :: FUNCTION
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


ALTER FUNCTION public.request_gateway_rebirth(p_gateway_id uuid) OWNER TO postgres;

--

-- FUNCTION request_gateway_rebirth(p_gateway_id uuid) :: COMMENT
COMMENT ON FUNCTION public.request_gateway_rebirth(p_gateway_id uuid) IS 'Ask an edge node to republish its birth certificate. The only way a rebirth_requests row is created. The daemon sends it; this only records that somebody asked.';

--

-- request_playback_stop(uuid) :: FUNCTION
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


ALTER FUNCTION public.request_playback_stop(p_job_id uuid) OWNER TO postgres;

--

-- require_backup_service_caller(text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.require_backup_service_caller(p_fn text) RETURNS void
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
BEGIN
    IF coalesce(nullif(current_setting('role', true), 'none'), '') <> ''
       OR session_user NOT IN ('supabase_admin', 'postgres') THEN
        RAISE EXCEPTION '%: only the backup service may call this', p_fn
            USING ERRCODE = 'insufficient_privilege';
    END IF;
END;
$$;


ALTER FUNCTION public.require_backup_service_caller(p_fn text) OWNER TO postgres;

--

-- require_ingestion_caller(text) :: FUNCTION
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


ALTER FUNCTION public.require_ingestion_caller(p_fn text) OWNER TO postgres;

--

-- require_playback_caller(text) :: FUNCTION
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


ALTER FUNCTION public.require_playback_caller(p_fn text) OWNER TO postgres;

--

-- revoke_anon_function_privileges() :: FUNCTION
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


ALTER FUNCTION public.revoke_anon_function_privileges() OWNER TO postgres;

--

-- FUNCTION revoke_anon_function_privileges() :: COMMENT
COMMENT ON FUNCTION public.revoke_anon_function_privileges() IS 'Revoke EXECUTE from PUBLIC and anon on every function in public, restoring what authenticated and service_role held. MUST BE CALLED BY THE LAST MIGRATION THAT CREATES A FUNCTION -- see 0071. PostgreSQL grants EXECUTE to PUBLIC on creation, so a function added after the sweep is anon-executable until the next call.';

--

-- revoke_credential_on_decommission() :: FUNCTION
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


ALTER FUNCTION public.revoke_credential_on_decommission() OWNER TO postgres;

--

-- FUNCTION revoke_credential_on_decommission() :: COMMENT
COMMENT ON FUNCTION public.revoke_credential_on_decommission() IS 'Trigger function: when a gateway is archived or deleted, asks the gateway credential service to disable its Dynamic Security client, which drops the live broker session. Only a gateway that holds a broker account is asked (gateway_has_broker_credential), so revocation never creates one. On archive it stamps credential_revoked_at; the sweep clears the stamp if the call failed.';

--

-- revoke_gateway_credential(text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.revoke_gateway_credential(p_sparkplug_id text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
DECLARE
  v_url     text;
  v_key     text;
  v_secret  text;
  v_request bigint;
BEGIN
  IF p_sparkplug_id IS NULL OR p_sparkplug_id !~ '^gwy[0-9a-f]{21}$' THEN
    RETURN false;
  END IF;

  SELECT decrypted_secret INTO v_url    FROM vault.decrypted_secrets WHERE name = 'supabase_functions_url';
  SELECT decrypted_secret INTO v_key    FROM vault.decrypted_secrets WHERE name = 'supabase_publishable_key';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'gateway_revoke_secret';

  -- A STACK WITH NOTHING CONFIGURED DOES NOTHING rather than sending a bare "Bearer ". The call
  -- would answer 401 or 503 either way; not making it keeps the failure legible as "not
  -- configured" rather than as "rejected".
  IF coalesce(v_url,'') = '' OR coalesce(v_key,'') = '' OR coalesce(v_secret,'') = '' THEN
    RETURN false;
  END IF;

  -- Through the gateway to the edge function, not straight at the credential service: the chart
  -- admits only `supabase-functions` to that service. `apikey` gets past the gateway;
  -- `x-revoke-secret` is what authorises the act.
  v_request := net.http_post(
    url     := rtrim(v_url, '/') || '/revoke-gateway-credential',
    headers := jsonb_build_object(
                 'Content-Type',    'application/json',
                 'apikey',          v_key,
                 'Authorization',   'Bearer ' || v_key,
                 'x-revoke-secret', v_secret),
    body    := jsonb_build_object('sparkplug_id', p_sparkplug_id)
  );

  -- The sweep judges the caller's stamp by this request's reply. An INSERT, never an UPDATE of
  -- gateways: the BEFORE DELETE trigger calls this, and updating the row being deleted aborts the
  -- DELETE. A deleted gateway's row goes with it by ON DELETE CASCADE; no gateway row, no record.
  INSERT INTO public.gateway_revocation_requests (gateway_id, request_id, requested_at)
  SELECT g.id, v_request, now() FROM public.gateways g WHERE g.sparkplug_id = p_sparkplug_id
  ON CONFLICT (gateway_id) DO UPDATE
     SET request_id = EXCLUDED.request_id, requested_at = EXCLUDED.requested_at;

  RETURN true;
END $_$;


ALTER FUNCTION public.revoke_gateway_credential(p_sparkplug_id text) OWNER TO postgres;

--

-- FUNCTION revoke_gateway_credential(p_sparkplug_id text) :: COMMENT
COMMENT ON FUNCTION public.revoke_gateway_credential(p_sparkplug_id text) IS 'Ask the credential service to disable this gateway''s broker account, which is how this platform revokes: the broker drops any live session at once and refuses the next CONNECT. The account is not deleted; a later issue re-enables it. Returns false when the service is not configured. ASYNCHRONOUS: true means "asked", not "revoked". Records the pg_net request id in gateway_revocation_requests, against the gateway row if there is one, for the sweep to judge.';

--

-- revoke_service_principal(uuid, text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.revoke_service_principal(p_principal_id uuid, p_reason text DEFAULT NULL::text) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_actor  uuid;
  v_tokens int := 0;
  v_id     bigint;
  v_row    record;
BEGIN
  IF NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'insufficient privileges to revoke a service principal'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'revoke_service_principal: no session, so this could not be attributed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_principal_id IS NULL THEN
    RAISE EXCEPTION 'revoke_service_principal: p_principal_id is required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- A PERSON'S ACCOUNT IS REFUSED. `sub` is on every JWT, so a row here naming a human would lock
  -- them out of PostgREST through a control built for machines -- and out of the request that
  -- would undo it. Revoking a person's access is a different act with different tools: remove
  -- their role, or disable the account in GoTrue.
  IF NOT public.is_machine_principal(p_principal_id) THEN
    RAISE EXCEPTION
      'revoke_service_principal: % is not a service principal. It either does not exist or it can '
      'sign in, and locking a person out through the machine denylist would also refuse the '
      'request that reinstated them.', p_principal_id
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- SELF-REVOCATION IS IMPOSSIBLE BY CONSTRUCTION rather than by a check: has_role() above needs
  -- an Administrator, and is_machine_principal() refuses anything that can sign in, so the actor
  -- and the target can never be the same row. Said here because its absence looks like an omission.

  IF EXISTS (SELECT 1 FROM public.revoked_service_principals WHERE principal_id = p_principal_id) THEN
    RAISE EXCEPTION 'revoke_service_principal: % is already revoked', p_principal_id
      USING ERRCODE = 'unique_violation',
            HINT = 'Reinstate it first if the intent is to change the recorded reason.';
  END IF;

  INSERT INTO public.revoked_service_principals (principal_id, revoked_by, reason)
  VALUES (p_principal_id, v_actor, nullif(btrim(coalesce(p_reason, '')), ''));

  -- ------------------------------------------------------------------------------------------
  -- Every outstanding token as well, which is what makes reinstatement safe
  -- ------------------------------------------------------------------------------------------
  -- Redundant for PostgREST and not for the audit trail or for reinstatement; see the header.
  FOR v_row IN
    SELECT DISTINCT ON (dt.new_data ->> 'jti')
           dt.new_data ->> 'jti'                     AS jti,
           (dt.new_data ->> 'expires_at')::timestamptz AS expires_at
      FROM public.audit_trail dt
     WHERE dt.entity_type = 'service_principals'
       AND dt.action = 'TOKEN_MINTED'
       AND dt.entity_id = p_principal_id
       AND dt.new_data ->> 'jti' IS NOT NULL
       AND (dt.new_data ->> 'expires_at')::timestamptz > now()
     ORDER BY dt.new_data ->> 'jti', dt.id DESC
  LOOP
    INSERT INTO public.revoked_service_tokens (jti, principal_id, expires_at, revoked_by)
    VALUES (v_row.jti, p_principal_id, v_row.expires_at, v_actor)
    ON CONFLICT (jti) DO NOTHING;

    IF FOUND THEN
      v_tokens := v_tokens + 1;
      INSERT INTO public.audit_trail (
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
      ) VALUES (
        'service_principals', p_principal_id, 'TOKEN_REVOKED', NULL,
        jsonb_build_object('jti', v_row.jti, 'revoked_at', now(),
                           'expires_at', v_row.expires_at, 'scope', 'postgrest',
                           -- WHY THIS ONE WAS WITHDRAWN, so a reader of a lone TOKEN_REVOKED row
                           -- is not left to correlate timestamps to discover it was collateral.
                           'cascaded_from', 'PRINCIPAL_REVOKED'),
        v_actor, 'user', txid_current(), now()
      );
    END IF;
  END LOOP;

  INSERT INTO public.audit_trail (
    entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
    causation_id, recorded_at
  ) VALUES (
    'service_principals',
    p_principal_id,
    'PRINCIPAL_REVOKED',
    NULL,
    jsonb_build_object(
      'revoked_at',      now(),
      'reason',          nullif(btrim(coalesce(p_reason, '')), ''),
      'tokens_revoked',  v_tokens,
      -- THE SUBJECT ARM REACHES FURTHER THAN THE TOKEN COUNT SUGGESTS, and the row should not
      -- imply otherwise: tokens this stack never recorded are refused too, and so is anything
      -- minted afterwards.
      'scope',           'postgrest'
    ),
    v_actor,
    'user',
    txid_current(),
    now()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;


ALTER FUNCTION public.revoke_service_principal(p_principal_id uuid, p_reason text) OWNER TO postgres;

--

-- FUNCTION revoke_service_principal(p_principal_id uuid, p_reason text) :: COMMENT
COMMENT ON FUNCTION public.revoke_service_principal(p_principal_id uuid, p_reason text) IS 'Administrator-only. Flags a service principal so auth_pre_request() refuses every token naming it, and denylists its outstanding tokens individually so reinstating the principal does not restore them. Refuses a human account. Reaches PostgREST only.';

--

-- revoke_service_token(text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.revoke_service_token(p_jti text) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_actor     uuid;
  v_mint      jsonb;
  v_principal uuid;
  v_expires   timestamptz;
  v_id        bigint;
BEGIN
  -- Administrator alone: withdrawing a credential is an access-control act, not an operational one.
  IF NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'insufficient privileges to revoke a service token'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_actor := auth.uid();
  IF v_actor IS NULL THEN
    -- THE AUDIT ROW MUST NAME SOMEBODY. has_role() above cannot pass without a session, so this
    -- is unreachable in practice and is here so that it stays unreachable: a future caller that
    -- found a way past the role check would still not be able to revoke anonymously.
    RAISE EXCEPTION 'revoke_service_token: no session, so this revocation could not be attributed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_jti IS NULL OR length(p_jti) = 0 OR length(p_jti) > 64 THEN
    RAISE EXCEPTION 'revoke_service_token: p_jti must be 1-64 characters (got %)',
      coalesce(length(p_jti)::text, 'null')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- The mint row is the source of the principal and the expiry; requiring it stops this table
  -- filling with jtis nobody issued. Newest first, so the choice is defined.
  SELECT dt.new_data INTO v_mint
    FROM public.audit_trail dt
   WHERE dt.entity_type = 'service_principals'
     AND dt.action = 'TOKEN_MINTED'
     AND dt.new_data ->> 'jti' = p_jti
   ORDER BY dt.id DESC
   LIMIT 1;

  IF v_mint IS NULL THEN
    RAISE EXCEPTION
      'revoke_service_token: no TOKEN_MINTED record for jti %. Only a token this stack recorded '
      'issuing can be revoked here.', p_jti
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  SELECT dt.entity_id INTO v_principal
    FROM public.audit_trail dt
   WHERE dt.entity_type = 'service_principals'
     AND dt.action = 'TOKEN_MINTED'
     AND dt.new_data ->> 'jti' = p_jti
   ORDER BY dt.id DESC
   LIMIT 1;

  v_expires := (v_mint ->> 'expires_at')::timestamptz;

  IF v_expires <= now() THEN
    -- REFUSED AS A NO-OP RATHER THAN ACCEPTED QUIETLY. The signature check already refuses this
    -- token, so a row would be pruned on its way in and the operator would be told a credential
    -- was withdrawn when nothing changed. Saying so is the honest answer and costs them nothing.
    RAISE EXCEPTION
      'revoke_service_token: the token % expired on % and is already refused by the signature '
      'check. There is nothing to revoke.', p_jti, v_expires
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- SELF-PRUNING, DONE HERE BECAUSE THIS IS THE ONLY WRITE PATH. A background job would be a
  -- second moving part for a table that is only touched when somebody revokes something, and the
  -- work is bounded by how many tokens were revoked in the last 90 days.
  DELETE FROM public.revoked_service_tokens WHERE expires_at <= now();

  -- IDEMPOTENT. Revoking twice is something an operator will do -- the button is in a page that
  -- refreshes -- and the second press should confirm rather than fail. The audit row below is
  -- still written, because "somebody pressed revoke" is true both times.
  INSERT INTO public.revoked_service_tokens (jti, principal_id, expires_at, revoked_by)
  VALUES (p_jti, v_principal, v_expires, v_actor)
  ON CONFLICT (jti) DO NOTHING;

  INSERT INTO public.audit_trail (
    entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
    causation_id, recorded_at
  ) VALUES (
    'service_principals',
    v_principal,
    'TOKEN_REVOKED',
    -- THE MINT ROW GOES IN `old_data`, which is what makes this row readable on its own. 0026's
    -- argument: an audit row that needs a join to a live row loses its meaning in exactly the
    -- cases it matters most, and the denylist entry this describes is pruned the moment the token
    -- expires.
    v_mint,
    jsonb_build_object(
      'jti',        p_jti,
      'revoked_at', now(),
      'expires_at', v_expires,
      -- WHAT THE REVOCATION ACTUALLY REACHES, recorded on the row rather than left to the reader.
      -- Four services verify the secret for themselves and never consult this denylist, so a row
      -- claiming a token was revoked without saying where would overstate what happened.
      'scope',      'postgrest'
    ),
    v_actor,
    'user',
    txid_current(),
    now()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;


ALTER FUNCTION public.revoke_service_token(p_jti text) OWNER TO postgres;

--

-- FUNCTION revoke_service_token(p_jti text) :: COMMENT
COMMENT ON FUNCTION public.revoke_service_token(p_jti text) IS 'Administrator-only. Adds a minted token''s jti to the denylist auth_pre_request() consults, and records a TOKEN_REVOKED row. Refuses a jti with no TOKEN_MINTED record and one that has already expired. Reaches PostgREST only -- storage, realtime, the edge runtime and Studio verify the JWT secret independently.';

--

-- schema_version_base_name(text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.schema_version_base_name(schema_name text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $_$
  SELECT regexp_replace(COALESCE(schema_name, ''), '_v[0-9]+$', '');
$_$;


ALTER FUNCTION public.schema_version_base_name(schema_name text) OWNER TO postgres;

--

-- FUNCTION schema_version_base_name(schema_name text) :: COMMENT
COMMENT ON FUNCTION public.schema_version_base_name(schema_name text) IS 'The lineage stem of a versioned schema name. Mirrored by baseSchemaName() in frontend/src/utils/schemaVersion.js -- keep the two in step.';

--

-- secure_audit_trail_partition(regclass) :: FUNCTION
CREATE OR REPLACE FUNCTION public.secure_audit_trail_partition(p_partition regclass) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC', p_partition::text);
  EXECUTE format('REVOKE ALL ON TABLE %s FROM anon, authenticated, service_role', p_partition::text);
END $$;


ALTER FUNCTION public.secure_audit_trail_partition(p_partition regclass) OWNER TO postgres;

--

-- FUNCTION secure_audit_trail_partition(p_partition regclass) :: COMMENT
COMMENT ON FUNCTION public.secure_audit_trail_partition(p_partition regclass) IS 'Strip every application-role privilege from one audit_trail partition. Partitions do not inherit the parent ACL and the image default grants service_role ALL -- including TRUNCATE, which no row trigger can refuse. Readers use the parent; a partition needs no grants.';

--

-- seed_setting(text, jsonb, text, text, text, text, text) :: FUNCTION
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
        fallback_source = EXCLUDED.fallback_source
    WHERE (public.system_settings.value_type, public.system_settings.category,
           public.system_settings.label, public.system_settings.description,
           public.system_settings.fallback_source)
        IS DISTINCT FROM
          (EXCLUDED.value_type, EXCLUDED.category,
           EXCLUDED.label, EXCLUDED.description, EXCLUDED.fallback_source);
END;
$$;


ALTER FUNCTION public.seed_setting(p_key text, p_value jsonb, p_value_type text, p_category text, p_label text, p_description text, p_fallback_source text) OWNER TO postgres;

--

-- FUNCTION seed_setting(p_key text, p_value jsonb, p_value_type text, p_category text, p_label text, p_description text, p_fallback_source text) :: COMMENT
COMMENT ON FUNCTION public.seed_setting(p_key text, p_value jsonb, p_value_type text, p_category text, p_label text, p_description text, p_fallback_source text) IS 'Declare a setting from a migration. Inserts on first boot and afterwards refreshes only the metadata, and only where it differs, so an operator''s value survives every replay and an unchanged declaration writes no row. Not reachable through PostgREST.';

--

-- service_token_max_days() :: FUNCTION
CREATE OR REPLACE FUNCTION public.service_token_max_days() RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$ SELECT 90 $$;


ALTER FUNCTION public.service_token_max_days() OWNER TO postgres;

--

-- FUNCTION service_token_max_days() :: COMMENT
COMMENT ON FUNCTION public.service_token_max_days() IS 'The longest life a service-principal token may be recorded with (90 days). Mirrored by the --days ceiling in scripts/mint-mcp-token.mjs. revoke_service_token() and revoke_service_principal() withdraw a token at PostgREST; storage, realtime, the edge runtime and Studio verify the signature alone, so the expiry is the only bound that reaches every service.';

--

-- set_archive_credential(text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.set_archive_credential(p_secret text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
    v_id uuid;
BEGIN
    -- ADMINISTRATOR ONLY, with the errcode `create_machine_principal()` uses: PostgREST maps it to
    -- 403, so the page can tell "you may not" from "that did not work".
    IF NOT public.has_role(ARRAY['Administrator']) THEN
        RAISE EXCEPTION 'insufficient privileges to set the cold archive credential'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF p_secret IS NULL OR length(trim(p_secret)) = 0 THEN
        RAISE EXCEPTION 'the cold archive credential cannot be empty; clear the destination instead';
    END IF;

    SELECT id INTO v_id FROM vault.secrets WHERE name = 'archive_secret_access_key';

    IF v_id IS NULL THEN
        PERFORM vault.create_secret(trim(p_secret), 'archive_secret_access_key',
                                    'The secret half of the cold archive''s S3 credential.');
    ELSE
        PERFORM vault.update_secret(v_id, trim(p_secret));
    END IF;
END;
$$;


ALTER FUNCTION public.set_archive_credential(p_secret text) OWNER TO postgres;

--

-- FUNCTION set_archive_credential(p_secret text) :: COMMENT
COMMENT ON FUNCTION public.set_archive_credential(p_secret text) IS 'Write the cold archive''s S3 secret key into the vault. Administrator only. WRITE-ONLY BY CONSTRUCTION: nothing reads it back to a browser, so the page can report that a credential is set and never what it is.';

--

-- set_backup_offsite_credential(text) :: FUNCTION
CREATE OR REPLACE FUNCTION public.set_backup_offsite_credential(p_secret text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
    v_id uuid;
BEGIN
    IF NOT public.has_role(ARRAY['Administrator']) THEN
        RAISE EXCEPTION 'only an Administrator may set the off-site backup credential'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_secret IS NULL OR length(btrim(p_secret)) = 0 THEN
        RAISE EXCEPTION 'the off-site backup credential cannot be empty; remove the destination instead'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT id INTO v_id FROM vault.secrets WHERE name = 'backup_offsite_secret_access_key';
    IF v_id IS NULL THEN
        PERFORM vault.create_secret(btrim(p_secret), 'backup_offsite_secret_access_key',
                                    'The secret half of the off-site backup copy''s S3 credential.');
    ELSE
        PERFORM vault.update_secret(v_id, btrim(p_secret));
    END IF;
END;
$$;


ALTER FUNCTION public.set_backup_offsite_credential(p_secret text) OWNER TO postgres;

--

-- FUNCTION set_backup_offsite_credential(p_secret text) :: COMMENT
COMMENT ON FUNCTION public.set_backup_offsite_credential(p_secret text) IS 'Write the off-site backup copy''s S3 secret key into the vault. Administrator only, and write-only: nothing reads it back to a browser.';

--

-- set_backup_offsite_destination(text, text, text, text, text, text, boolean) :: FUNCTION
CREATE OR REPLACE FUNCTION public.set_backup_offsite_destination(p_endpoint text, p_region text, p_bucket text, p_prefix text, p_access_key_id text, p_recipient text, p_path_style boolean) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
    IF NOT public.has_role(ARRAY['Administrator']) THEN
        RAISE EXCEPTION 'only an Administrator may set the off-site backup destination'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    UPDATE public.system_settings s
       SET value = v.value
      FROM (VALUES
          ('backup_offsite.endpoint',      to_jsonb(btrim(coalesce(p_endpoint, '')))),
          ('backup_offsite.region',        to_jsonb(btrim(coalesce(p_region, '')))),
          ('backup_offsite.bucket',        to_jsonb(btrim(coalesce(p_bucket, '')))),
          ('backup_offsite.prefix',        to_jsonb(btrim(coalesce(p_prefix, '')))),
          ('backup_offsite.access_key_id', to_jsonb(btrim(coalesce(p_access_key_id, '')))),
          ('backup_offsite.recipient',     to_jsonb(btrim(coalesce(p_recipient, '')))),
          ('backup_offsite.path_style',    to_jsonb(coalesce(p_path_style, false)))
      ) AS v(key, value)
     WHERE s.key = v.key
       AND s.value IS DISTINCT FROM v.value;
END;
$$;


ALTER FUNCTION public.set_backup_offsite_destination(p_endpoint text, p_region text, p_bucket text, p_prefix text, p_access_key_id text, p_recipient text, p_path_style boolean) OWNER TO postgres;

--

-- FUNCTION set_backup_offsite_destination(p_endpoint text, p_region text, p_bucket text, p_prefix text, p_access_key_id text, p_recipient text, p_path_style boolean) :: COMMENT
COMMENT ON FUNCTION public.set_backup_offsite_destination(p_endpoint text, p_region text, p_bucket text, p_prefix text, p_access_key_id text, p_recipient text, p_path_style boolean) IS 'Set the six off-site destination settings and the path-style switch in one statement, each checked by backup_offsite_setting_guard(). Administrator only. The secret key is set_backup_offsite_credential()''s.';

--

-- shadow_follows_its_original() :: FUNCTION
CREATE OR REPLACE FUNCTION public.shadow_follows_its_original() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
    -- BEFORE the row goes, so the lanes are deleted as themselves -- each with its own audit row
    -- and tombstone in this transaction -- rather than being SET NULL into a lane for nothing.
    IF TG_OP = 'DELETE' THEN
        DELETE FROM public.devices WHERE shadow_of = OLD.id;
        RETURN OLD;
    END IF;

    -- ON THE TRANSITION, IN EITHER DIRECTION. `UPDATE OF is_archived` fires whenever the column
    -- appears in a SET list, and PostgREST sends the whole row on a PATCH.
    IF NEW.is_archived IS DISTINCT FROM COALESCE(OLD.is_archived, false) THEN
        UPDATE public.devices
           SET is_archived    = NEW.is_archived,
               archived_at    = NEW.archived_at,
               auto_delete_at = NEW.auto_delete_at
         WHERE shadow_of = NEW.id
           AND COALESCE(is_archived, false) IS DISTINCT FROM NEW.is_archived;
    END IF;
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.shadow_follows_its_original() OWNER TO postgres;

--

-- FUNCTION shadow_follows_its_original() :: COMMENT
COMMENT ON FUNCTION public.shadow_follows_its_original() IS 'Archiving, restoring or deleting a device does the same to every replay lane whose shadow_of names it: the lane carries the original''s archived_at and auto_delete_at, and goes before it on a delete. A lane is a recording of an asset, not a second asset, so it has no lifecycle of its own.';

--

-- stamp_audit_domain() :: FUNCTION
CREATE OR REPLACE FUNCTION public.stamp_audit_domain() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.audit_domain := public.audit_domain_for(NEW.entity_type, NEW.action);
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.stamp_audit_domain() OWNER TO postgres;

--

-- stamp_proposal_author() :: FUNCTION
CREATE OR REPLACE FUNCTION public.stamp_proposal_author() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    -- The primitive, not `auth.email()`: the base image the database suites run against ships a
    -- legacy definition reading the singular `request.jwt.claim.email` GUC and returns NULL for a
    -- modern session (the same trap test-harness/auth-bootstrap.sql records for `auth.uid()`).
    -- NULL under service_role and during a migration, which is correct.
    NEW.proposed_by_email := NULLIF(auth.jwt() ->> 'email', '');
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.stamp_proposal_author() OWNER TO postgres;

--

-- FUNCTION stamp_proposal_author() :: COMMENT
COMMENT ON FUNCTION public.stamp_proposal_author() IS 'Stamps change_proposals.proposed_by_email from the access token on INSERT, discarding anything the client supplied. A DEFAULT would only apply when the column was omitted, and this table takes a direct PostgREST INSERT from any Operator.';

--

-- start_capture_job(text, uuid, text, integer, boolean) :: FUNCTION
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


ALTER FUNCTION public.start_capture_job(p_subject_kind text, p_subject_id uuid, p_note text, p_max_seconds integer, p_replace boolean) OWNER TO postgres;

--

-- FUNCTION start_capture_job(p_subject_kind text, p_subject_id uuid, p_note text, p_max_seconds integer, p_replace boolean) :: COMMENT
COMMENT ON FUNCTION public.start_capture_job(p_subject_kind text, p_subject_id uuid, p_note text, p_max_seconds integer, p_replace boolean) IS 'Queue a broker capture of one gateway or one device. The only way a capture_jobs row is created. Refuses without Administrator or Shopfloor_Manager, refuses a second concurrent capture, and refuses to overwrite a stored capture unless p_replace is true -- which is what makes the replace confirmation a property of the schema rather than of the frontend.';

--

-- start_playback_job(uuid, uuid, jsonb, numeric) :: FUNCTION
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
    -- "remote and enrolled" and excludes every host-run gateway.
    IF NOT public.gateway_has_broker_credential(v_gateway) THEN
        RAISE EXCEPTION
          'start_playback_job: gateway % holds no broker credential, so nothing can authenticate '
          'as it. Issue one from the Access Control page first -- that is also how you obtain the '
          'password the playback worker needs.', v_gateway.name
            USING ERRCODE = 'check_violation';
    END IF;

    -- ------------------------------------------------------------------------------------
    -- TIER TWO AND A HALF: the worker must hold the CURRENT credential (#217)
    -- ------------------------------------------------------------------------------------
    -- The check above proves an account EXISTS. It cannot prove the worker holds the password
    -- that account now has, and the broker keeps one password per gateway -- so every mint after
    -- the first REPLACES one, and for the length of the delivery window the worker is still
    -- holding the previous password. Accepting here and failing at CONNACK a second later is
    -- exactly what this refuses.
    --
    -- ABSENT IS NOT STALE. playback_stale_credentials() returns a gateway only when the worker
    -- reported an observation OLDER than the last issue; a worker that has reported no
    -- observation at all -- one from the release before 0129 -- is not listed and is not refused.
    IF EXISTS (
        SELECT 1 FROM public.playback_stale_credentials() s
         WHERE s.sparkplug_id = v_gateway.sparkplug_id
    ) THEN
        RAISE EXCEPTION
          'start_playback_job: gateway % had its broker credential re-issued after the playback '
          'worker last picked one up, so the worker still holds the previous password and the '
          'broker would refuse it. Delivery takes about a minute; try again shortly.', v_gateway.name
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


ALTER FUNCTION public.start_playback_job(p_capture_id uuid, p_target_gateway_id uuid, p_device_map jsonb, p_speed numeric) OWNER TO postgres;

--

-- FUNCTION start_playback_job(p_capture_id uuid, p_target_gateway_id uuid, p_device_map jsonb, p_speed numeric) :: COMMENT
COMMENT ON FUNCTION public.start_playback_job(p_capture_id uuid, p_target_gateway_id uuid, p_device_map jsonb, p_speed numeric) IS 'Queue a capture for publication onto a simulated gateway. The only way a playback_jobs row is created. Refuses a target that is not is_simulated, one holding no broker credential, a device map naming devices of another gateway, and a second concurrent playback onto the same edge node. See 0056''s header for the three tiers this is the first of.';

--

-- sweep_forge() :: FUNCTION
CREATE OR REPLACE FUNCTION public.sweep_forge() RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_url    text;
  v_key    text;
  v_secret text;
BEGIN
  SELECT decrypted_secret INTO v_url    FROM vault.decrypted_secrets WHERE name = 'supabase_functions_url';
  SELECT decrypted_secret INTO v_key    FROM vault.decrypted_secrets WHERE name = 'supabase_publishable_key';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'forge_sweep_secret';

  -- Nothing configured does nothing, rather than sending a bare "Bearer ": the call would answer
  -- 401 or 503 either way, and not making it keeps "not configured" legible as such.
  IF coalesce(v_url, '') = '' OR coalesce(v_key, '') = '' OR coalesce(v_secret, '') = '' THEN
    RETURN false;
  END IF;

  -- A minute rather than pg_net's default: one pass is a request per team member and two per
  -- repository, and a worker whose caller hung up still finishes the pass.
  PERFORM net.http_post(
    url     := rtrim(v_url, '/') || '/forge-sweep',
    headers := jsonb_build_object(
                 'Content-Type',   'application/json',
                 'apikey',         v_key,
                 'Authorization',  'Bearer ' || v_key,
                 'x-sweep-secret', v_secret),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );

  RETURN true;
END $$;


ALTER FUNCTION public.sweep_forge() OWNER TO postgres;

--

-- FUNCTION sweep_forge() :: COMMENT
COMMENT ON FUNCTION public.sweep_forge() IS 'Ask the forge-sweep edge function for one reconciliation of the forge against user_roles: team members whose role has gone are removed, admitted logins are placed, gateway repositories get their push webhook and branch protection back, an archived gateway''s repository is put into the forge''s archive and a restored one taken out (0114), and hand-made repositories get main protected. Returns false when the stack holds no sweep secret. ASYNCHRONOUS: net.http_post queues the request, so true means "asked", not "swept". Scheduled every fifteen minutes by pg_cron, and asked for by trg_gateways_forge_follows_archive as an archive lands.';

--

-- sweep_forge_on_archive_change() :: FUNCTION
CREATE OR REPLACE FUNCTION public.sweep_forge_on_archive_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  -- SECURITY DEFINER because sweep_forge() is service_role's and an operator archiving a gateway
  -- is `authenticated`. It reaches no further than the sweep the schedule already runs.

  -- ON THE TRANSITION, IN EITHER DIRECTION. `UPDATE OF is_archived` fires whenever the column
  -- appears in a SET list, including when it is set to the value it already held, and an archived
  -- gateway is written to by ordinary edits -- so without this guard every such write would walk
  -- the whole forge. Both directions matter: restoring is what takes the repository back out.
  IF NEW.is_archived IS DISTINCT FROM COALESCE(OLD.is_archived, false)
     -- A gateway with no repository has nothing in the forge to follow. A host-run, simulated or
     -- shadow gateway never gets one, and neither does one enrolled on a deployment with no forge.
     -- A fleet enrolled before 0110 has repositories this column does not name yet; those converge
     -- on the timer, which is what the timer is for.
     AND NEW.forge_repository_at IS NOT NULL THEN
    PERFORM public.sweep_forge();
  END IF;
  RETURN NEW;
END $$;


ALTER FUNCTION public.sweep_forge_on_archive_change() OWNER TO postgres;

--

-- FUNCTION sweep_forge_on_archive_change() :: COMMENT
COMMENT ON FUNCTION public.sweep_forge_on_archive_change() IS 'Ask forge-sweep for one pass when a gateway is archived or restored, so its repository follows within seconds rather than at the next quarter hour. Gated on the transition and on the gateway having a repository. ASYNCHRONOUS, like everything sweep_forge() does: the pass is queued, and the fifteen-minute schedule is what makes it eventually correct.';

--

-- sweep_gateway_credential_revocations() :: FUNCTION
CREATE OR REPLACE FUNCTION public.sweep_gateway_credential_revocations() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_row     record;
  v_asked   int := 0;
BEGIN
  -- A 2xx to its own request confirms a stamp, and dropping the row makes that final: pg_net
  -- prunes replies after six hours. Rows whose gateway was restored or lost its stamp go too.
  DELETE FROM public.gateway_revocation_requests q
   USING public.gateways g
   WHERE g.id = q.gateway_id
     AND (NOT g.is_archived
          OR g.credential_revoked_at IS NULL
          OR EXISTS (SELECT 1 FROM net._http_response r
                      WHERE r.id = q.request_id AND r.status_code BETWEEN 200 AND 299));

  -- Any other reply, or none five minutes on, means the revocation did not happen. Clearing the
  -- stamp puts the gateway back into the retry set below.
  WITH failed AS (
    DELETE FROM public.gateway_revocation_requests q
     WHERE NOT EXISTS (SELECT 1 FROM net._http_response r
                        WHERE r.id = q.request_id AND r.status_code BETWEEN 200 AND 299)
       AND (q.requested_at < now() - interval '5 minutes'
            OR EXISTS (SELECT 1 FROM net._http_response r WHERE r.id = q.request_id))
    RETURNING q.gateway_id
  )
  UPDATE public.gateways g
     SET credential_revoked_at = NULL
    FROM failed
   WHERE g.id = failed.gateway_id;

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


ALTER FUNCTION public.sweep_gateway_credential_revocations() OWNER TO postgres;

--

-- FUNCTION sweep_gateway_credential_revocations() :: COMMENT
COMMENT ON FUNCTION public.sweep_gateway_credential_revocations() IS 'Judges each revocation stamp by the reply to its own pg_net request (gateway_revocation_requests): a 2xx confirms it, any other reply or none after five minutes clears it. Then asks again for every archived gateway that holds a broker credential and has no stamp, 200 per run. Run by pg_cron every 15 minutes. Does nothing for DELETED gateways -- their row is gone; scripts/revoke-orphaned-broker-accounts.mjs is the sweep for those.';

--

-- system_settings_read_only_guard() :: FUNCTION
CREATE OR REPLACE FUNCTION public.system_settings_read_only_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
    -- The VALUE alone. Metadata (label, description, bounds) is refreshed by seed_setting() on
    -- every boot, and refusing that would make the row impossible to correct.
    IF OLD.read_only AND NEW.value IS DISTINCT FROM OLD.value THEN
        RAISE EXCEPTION
            'system_settings.% is fixed at install and cannot be changed here. It is named by the '
            'deployment, and changing it in the database alone would leave the stack disagreeing '
            'with the chart. See supabase/README.md.', OLD.key;
    END IF;
    RETURN NEW;
END;
$$;


ALTER FUNCTION public.system_settings_read_only_guard() OWNER TO postgres;

--

-- FUNCTION system_settings_read_only_guard() :: COMMENT
COMMENT ON FUNCTION public.system_settings_read_only_guard() IS 'Refuses a value change to a read-only setting. A trigger rather than a policy because RLS cannot see OLD and NEW at once in a USING clause that must also permit ordinary edits -- the same reason system_settings_stamp() holds the key and value_type immutability.';

--

-- system_settings_stamp() :: FUNCTION
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


ALTER FUNCTION public.system_settings_stamp() OWNER TO postgres;

--

-- validate_change_proposal() :: FUNCTION
CREATE OR REPLACE FUNCTION public.validate_change_proposal() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
    v_allowed text[] := public.proposable_columns(NEW.entity_type);
    v_key     text;
    v_exists  boolean;
BEGIN
    -- Fail closed, naming the real problem: the CHECK constraint admits the known lanes and this
    -- trigger runs before it. This is also how the schema lane's withdrawal is enforced: the string
    -- is admitted by the constraint and has no allowlist.
    IF array_length(v_allowed, 1) IS NULL THEN
        RAISE EXCEPTION
            'nothing is proposable on %; proposable_columns() has no allowlist for it',
            NEW.entity_type
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    FOREACH v_key IN ARRAY ARRAY(SELECT jsonb_object_keys(NEW.patch)) LOOP
        IF NOT (v_key = ANY (v_allowed)) THEN
            -- NAMED, not merely refused. The proposer chose this field in a form; "invalid patch"
            -- would send them to an administrator to find out which one.
            RAISE EXCEPTION
                'column % is not proposable on %; proposable columns are: %',
                v_key, NEW.entity_type, array_to_string(v_allowed, ', ')
                USING ERRCODE = 'invalid_parameter_value';
        END IF;
    END LOOP;

    -- ---------------------------------------------------------------------------------------------
    -- The target has to exist and be in service, and no foreign key can say so: `entity_id`
    -- addresses a different table depending on `entity_type`.
    -- ---------------------------------------------------------------------------------------------
    v_exists := CASE
        WHEN NEW.entity_type IN ('devices', 'device_nameplate') THEN
            EXISTS (SELECT 1 FROM public.devices d
                     WHERE d.id = NEW.entity_id AND d.is_archived = false)
        WHEN NEW.entity_type = 'areas' THEN
            EXISTS (SELECT 1 FROM public.areas a
                     WHERE a.id = NEW.entity_id AND a.is_archived = false)
        WHEN NEW.entity_type = 'cells' THEN
            EXISTS (SELECT 1 FROM public.cells c
                     WHERE c.id = NEW.entity_id AND COALESCE(c.is_archived, false) = false)
        WHEN NEW.entity_type = 'gateways' THEN
            EXISTS (SELECT 1 FROM public.gateways g
                     WHERE g.id = NEW.entity_id AND COALESCE(g.is_archived, false) = false)
        ELSE false
    END;

    IF NOT v_exists THEN
        RAISE EXCEPTION 'no live target % to propose a % change against',
            NEW.entity_id, NEW.entity_type
            USING ERRCODE = 'foreign_key_violation';
    END IF;

    RETURN NEW;
END;
$$;


ALTER FUNCTION public.validate_change_proposal() OWNER TO postgres;

--

-- FUNCTION validate_change_proposal() :: COMMENT
COMMENT ON FUNCTION public.validate_change_proposal() IS 'Refuses a proposal in a lane proposable_columns() has no allowlist for (the withdrawn schemas lane among them), a patch naming a key the lane does not admit, and a proposal aimed at a target that is absent or archived. Runs on INSERT and on any UPDATE that touches the patch, because editing an open proposal is a path INSERT-only validation would miss.';

--

-- withdraw_gateway_enrollment_tokens() :: FUNCTION
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


ALTER FUNCTION public.withdraw_gateway_enrollment_tokens() OWNER TO postgres;

--

-- FUNCTION withdraw_gateway_enrollment_tokens() :: COMMENT
COMMENT ON FUNCTION public.withdraw_gateway_enrollment_tokens() IS 'Burns any unredeemed enrolment token when a gateway is archived. SECURITY DEFINER because the operator archiving the gateway has no grant on gateway_enrollment_tokens -- RLS is on with no policy, deliberately, so the table is reachable only by service_role and by definers like this.';

--

-- withdraw_proposal(uuid) :: FUNCTION
CREATE OR REPLACE FUNCTION public.withdraw_proposal(p_proposal_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_proposal public.change_proposals%ROWTYPE;
BEGIN
    SELECT * INTO v_proposal FROM public.change_proposals
     WHERE id = p_proposal_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'proposal % not found', p_proposal_id USING ERRCODE = 'no_data_found';
    END IF;

    -- The proposer's own, and nobody else's. An approver who wants an open proposal gone rejects
    -- it with a reason -- withdrawal on somebody's behalf would erase the refusal.
    IF v_proposal.proposed_by IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'only the proposer may withdraw proposal %', p_proposal_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF v_proposal.status <> 'open' THEN
        RAISE EXCEPTION 'proposal % is already %', p_proposal_id, v_proposal.status
            USING ERRCODE = 'check_violation';
    END IF;

    PERFORM set_config('aber.proposal_transition', 'on', true);

    UPDATE public.change_proposals
       SET status = 'withdrawn', decided_by = auth.uid(), decided_at = now()
     WHERE id = p_proposal_id;

    RETURN jsonb_build_object('id', p_proposal_id, 'status', 'withdrawn');
END;
$$;


ALTER FUNCTION public.withdraw_proposal(p_proposal_id uuid) OWNER TO postgres;

--

-- FUNCTION withdraw_proposal(p_proposal_id uuid) :: COMMENT
COMMENT ON FUNCTION public.withdraw_proposal(p_proposal_id uuid) IS 'The proposer closes their own open proposal, freeing the slot it holds under both caps. Not available to an approver: making somebody else''s proposal disappear without a reason is what rejection exists to prevent.';

--

-- areas :: TABLE
CREATE TABLE IF NOT EXISTS public.areas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    icon text DEFAULT 'Building2'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    plan_path text,
    plan_aspect numeric(8,4),
    is_archived boolean DEFAULT false NOT NULL,
    archived_at timestamp with time zone,
    auto_delete_at timestamp with time zone,
    CONSTRAINT areas_icon_valid CHECK ((icon = ANY (ARRAY['Building2'::text, 'Factory'::text, 'Warehouse'::text, 'FlaskConical'::text, 'Truck'::text, 'Parking'::text, 'Trees'::text, 'Zap'::text]))),
    CONSTRAINT areas_name_topic_safe CHECK (((name <> ''::text) AND (name !~ '[/+#]'::text))),
    CONSTRAINT areas_plan_aspect_positive CHECK (((plan_aspect IS NULL) OR (plan_aspect > (0)::numeric))),
    CONSTRAINT areas_plan_has_aspect CHECK (((plan_path IS NULL) = (plan_aspect IS NULL)))
);

ALTER TABLE ONLY public.areas REPLICA IDENTITY FULL;


ALTER TABLE public.areas OWNER TO postgres;

ALTER TABLE public.areas
    ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid() NOT NULL,
    ADD COLUMN IF NOT EXISTS name text NOT NULL,
    ADD COLUMN IF NOT EXISTS description text,
    ADD COLUMN IF NOT EXISTS icon text DEFAULT 'Building2'::text NOT NULL,
    ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now() NOT NULL,
    ADD COLUMN IF NOT EXISTS plan_path text,
    ADD COLUMN IF NOT EXISTS plan_aspect numeric(8,4),
    ADD COLUMN IF NOT EXISTS is_archived boolean DEFAULT false NOT NULL,
    ADD COLUMN IF NOT EXISTS archived_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS auto_delete_at timestamp with time zone;

ALTER TABLE public.areas
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN name DROP DEFAULT,
    ALTER COLUMN description DROP DEFAULT,
    ALTER COLUMN icon SET DEFAULT 'Building2'::text,
    ALTER COLUMN created_at SET DEFAULT now(),
    ALTER COLUMN plan_path DROP DEFAULT,
    ALTER COLUMN plan_aspect DROP DEFAULT,
    ALTER COLUMN is_archived SET DEFAULT false,
    ALTER COLUMN archived_at DROP DEFAULT,
    ALTER COLUMN auto_delete_at DROP DEFAULT;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'areas_icon_valid'
                AND conrelid = 'public.areas'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((icon = ANY (ARRAY[''Building2''::text, ''Factory''::text, ''Warehouse''::text, ''FlaskConical''::text, ''Truck''::text, ''Parking''::text, ''Trees''::text, ''Zap''::text])))') THEN
    ALTER TABLE public.areas DROP CONSTRAINT areas_icon_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'areas_icon_valid'
                    AND conrelid = 'public.areas'::regclass) THEN
    ALTER TABLE public.areas
        ADD CONSTRAINT areas_icon_valid CHECK ((icon = ANY (ARRAY['Building2'::text, 'Factory'::text, 'Warehouse'::text, 'FlaskConical'::text, 'Truck'::text, 'Parking'::text, 'Trees'::text, 'Zap'::text])));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'areas_name_topic_safe'
                AND conrelid = 'public.areas'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((name <> ''''::text) AND (name !~ ''[/+#]''::text)))') THEN
    ALTER TABLE public.areas DROP CONSTRAINT areas_name_topic_safe;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'areas_name_topic_safe'
                    AND conrelid = 'public.areas'::regclass) THEN
    ALTER TABLE public.areas
        ADD CONSTRAINT areas_name_topic_safe CHECK (((name <> ''::text) AND (name !~ '[/+#]'::text)));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'areas_plan_aspect_positive'
                AND conrelid = 'public.areas'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((plan_aspect IS NULL) OR (plan_aspect > (0)::numeric)))') THEN
    ALTER TABLE public.areas DROP CONSTRAINT areas_plan_aspect_positive;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'areas_plan_aspect_positive'
                    AND conrelid = 'public.areas'::regclass) THEN
    ALTER TABLE public.areas
        ADD CONSTRAINT areas_plan_aspect_positive CHECK (((plan_aspect IS NULL) OR (plan_aspect > (0)::numeric)));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'areas_plan_has_aspect'
                AND conrelid = 'public.areas'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((plan_path IS NULL) = (plan_aspect IS NULL)))') THEN
    ALTER TABLE public.areas DROP CONSTRAINT areas_plan_has_aspect;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'areas_plan_has_aspect'
                    AND conrelid = 'public.areas'::regclass) THEN
    ALTER TABLE public.areas
        ADD CONSTRAINT areas_plan_has_aspect CHECK (((plan_path IS NULL) = (plan_aspect IS NULL)));
  END IF;
END $c$;

--

-- TABLE areas :: COMMENT
COMMENT ON TABLE public.areas IS 'ISA-95 areas -- the parts of the one site. A cell files into at most one area (cells.area_id); an area-wide asset names one directly. The name is a segment of every uns/ topic beneath it, so it cannot contain the MQTT separator or wildcards.';

--

-- COLUMN areas.name :: COMMENT
COMMENT ON COLUMN public.areas.name IS 'Display name and the <area> segment of uns/<enterprise>/<site>/<area>/... Unique, non-empty, no / + #.';

--

-- COLUMN areas.icon :: COMMENT
COMMENT ON COLUMN public.areas.icon IS 'Icon key for this area, rendered by the dashboard from a bundled SVG set (frontend/src/utils/areaIcon.jsx). A closed set (see areas_icon_valid), as cells.icon is: a lookup key, never markup or a URL.';

--

-- COLUMN areas.plan_path :: COMMENT
COMMENT ON COLUMN public.areas.plan_path IS 'Object path of the area''s plan in the area-plans bucket, <area_id>/<file>.svg, or NULL for the default outline. A path, never markup.';

--

-- COLUMN areas.plan_aspect :: COMMENT
COMMENT ON COLUMN public.areas.plan_aspect IS 'Width over height of the plan''s viewBox, read at upload. Cell places are fractions of the plan, so the aspect is what turns them back into a distance; NULL with no plan, when the default 4:3 outline applies.';

--

-- COLUMN areas.is_archived :: COMMENT
COMMENT ON COLUMN public.areas.is_archived IS 'Out of commission but not gone: listed on the Archived Entities page, restorable, and still the <area> segment of every uns/ topic beneath it. Its cells stay filed in it. Never proposable.';

--

-- COLUMN areas.archived_at :: COMMENT
COMMENT ON COLUMN public.areas.archived_at IS 'When the area was archived; NULL while it is in service.';

--

-- COLUMN areas.auto_delete_at :: COMMENT
COMMENT ON COLUMN public.areas.auto_delete_at IS 'When purge_expired_archives (0002) may delete the row; NULL is permanent retention. The delete is skipped, not attempted, while an Area-Wide asset still names the area.';

--

-- ashrae223_vocabulary :: TABLE
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


ALTER TABLE public.ashrae223_vocabulary OWNER TO postgres;

ALTER TABLE public.ashrae223_vocabulary
    ADD COLUMN IF NOT EXISTS name text NOT NULL,
    ADD COLUMN IF NOT EXISTS concept_kind text NOT NULL,
    ADD COLUMN IF NOT EXISTS label text NOT NULL,
    ADD COLUMN IF NOT EXISTS description text,
    ADD COLUMN IF NOT EXISTS subclass_of text,
    ADD COLUMN IF NOT EXISTS semantic_id text NOT NULL;

ALTER TABLE public.ashrae223_vocabulary
    ALTER COLUMN name DROP DEFAULT,
    ALTER COLUMN concept_kind DROP DEFAULT,
    ALTER COLUMN label DROP DEFAULT,
    ALTER COLUMN description DROP DEFAULT,
    ALTER COLUMN subclass_of DROP DEFAULT,
    ALTER COLUMN semantic_id DROP DEFAULT;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'ashrae223_vocabulary_kind_valid'
                AND conrelid = 'public.ashrae223_vocabulary'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((concept_kind = ANY (ARRAY[''Class''::text, ''AbstractClass''::text, ''Concept''::text, ''Relation''::text, ''EnumerationKind''::text])))') THEN
    ALTER TABLE public.ashrae223_vocabulary DROP CONSTRAINT ashrae223_vocabulary_kind_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'ashrae223_vocabulary_kind_valid'
                    AND conrelid = 'public.ashrae223_vocabulary'::regclass) THEN
    ALTER TABLE public.ashrae223_vocabulary
        ADD CONSTRAINT ashrae223_vocabulary_kind_valid CHECK ((concept_kind = ANY (ARRAY['Class'::text, 'AbstractClass'::text, 'Concept'::text, 'Relation'::text, 'EnumerationKind'::text])));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'ashrae223_vocabulary_semantic_id_namespace'
                AND conrelid = 'public.ashrae223_vocabulary'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((semantic_id ~~ ''http://data.ashrae.org/standard223#%''::text))') THEN
    ALTER TABLE public.ashrae223_vocabulary DROP CONSTRAINT ashrae223_vocabulary_semantic_id_namespace;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'ashrae223_vocabulary_semantic_id_namespace'
                    AND conrelid = 'public.ashrae223_vocabulary'::regclass) THEN
    ALTER TABLE public.ashrae223_vocabulary
        ADD CONSTRAINT ashrae223_vocabulary_semantic_id_namespace CHECK ((semantic_id ~~ 'http://data.ashrae.org/standard223#%'::text));
  END IF;
END $c$;

--

-- TABLE ashrae223_vocabulary :: COMMENT
COMMENT ON TABLE public.ashrae223_vocabulary IS 'ASHRAE 223P semantic concepts, generated from the open223 ontology (Apache-2.0). Reference data, not deployment state -- a row is a concept the standard defines. ⚠ The standard is still in public review; concepts may move before publication.';

--

-- COLUMN ashrae223_vocabulary.subclass_of :: COMMENT
COMMENT ON COLUMN public.ashrae223_vocabulary.subclass_of IS 'Immediate s223 superclass, or NULL at the top of the hierarchy. Used to give the vocabulary panel browsable sections.';

--

-- asset_config :: TABLE
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


ALTER TABLE public.asset_config OWNER TO postgres;

ALTER TABLE public.asset_config
    ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid() NOT NULL,
    ADD COLUMN IF NOT EXISTS asset_id text NOT NULL,
    ADD COLUMN IF NOT EXISTS metric_name text NOT NULL,
    ADD COLUMN IF NOT EXISTS val_double double precision,
    ADD COLUMN IF NOT EXISTS val_string text,
    ADD COLUMN IF NOT EXISTS val_bool boolean,
    ADD COLUMN IF NOT EXISTS datatype integer,
    ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();

ALTER TABLE public.asset_config
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN asset_id DROP DEFAULT,
    ALTER COLUMN metric_name DROP DEFAULT,
    ALTER COLUMN val_double DROP DEFAULT,
    ALTER COLUMN val_string DROP DEFAULT,
    ALTER COLUMN val_bool DROP DEFAULT,
    ALTER COLUMN datatype DROP DEFAULT,
    ALTER COLUMN updated_at SET DEFAULT now();

--

-- asset_exports :: TABLE
CREATE TABLE IF NOT EXISTS public.asset_exports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_type text DEFAULT 'devices'::text NOT NULL,
    entity_id uuid NOT NULL,
    name text,
    sparkplug_id text,
    format text DEFAULT 'aasx'::text NOT NULL,
    object_bucket text NOT NULL,
    object_key text NOT NULL,
    object_bytes bigint,
    sha256 text,
    stats jsonb DEFAULT '{}'::jsonb NOT NULL,
    taken_at timestamp with time zone DEFAULT now() NOT NULL,
    taken_by uuid,
    taken_by_email text,
    CONSTRAINT asset_exports_format_valid CHECK ((format = 'aasx'::text)),
    CONSTRAINT asset_exports_type_known CHECK ((entity_type = 'devices'::text))
);


ALTER TABLE public.asset_exports OWNER TO postgres;

ALTER TABLE public.asset_exports
    ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid() NOT NULL,
    ADD COLUMN IF NOT EXISTS entity_type text DEFAULT 'devices'::text NOT NULL,
    ADD COLUMN IF NOT EXISTS entity_id uuid NOT NULL,
    ADD COLUMN IF NOT EXISTS name text,
    ADD COLUMN IF NOT EXISTS sparkplug_id text,
    ADD COLUMN IF NOT EXISTS format text DEFAULT 'aasx'::text NOT NULL,
    ADD COLUMN IF NOT EXISTS object_bucket text NOT NULL,
    ADD COLUMN IF NOT EXISTS object_key text NOT NULL,
    ADD COLUMN IF NOT EXISTS object_bytes bigint,
    ADD COLUMN IF NOT EXISTS sha256 text,
    ADD COLUMN IF NOT EXISTS stats jsonb DEFAULT '{}'::jsonb NOT NULL,
    ADD COLUMN IF NOT EXISTS taken_at timestamp with time zone DEFAULT now() NOT NULL,
    ADD COLUMN IF NOT EXISTS taken_by uuid,
    ADD COLUMN IF NOT EXISTS taken_by_email text;

ALTER TABLE public.asset_exports
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN entity_type SET DEFAULT 'devices'::text,
    ALTER COLUMN entity_id DROP DEFAULT,
    ALTER COLUMN name DROP DEFAULT,
    ALTER COLUMN sparkplug_id DROP DEFAULT,
    ALTER COLUMN format SET DEFAULT 'aasx'::text,
    ALTER COLUMN object_bucket DROP DEFAULT,
    ALTER COLUMN object_key DROP DEFAULT,
    ALTER COLUMN object_bytes DROP DEFAULT,
    ALTER COLUMN sha256 DROP DEFAULT,
    ALTER COLUMN stats SET DEFAULT '{}'::jsonb,
    ALTER COLUMN taken_at SET DEFAULT now(),
    ALTER COLUMN taken_by DROP DEFAULT,
    ALTER COLUMN taken_by_email DROP DEFAULT;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'asset_exports_format_valid'
                AND conrelid = 'public.asset_exports'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((format = ''aasx''::text))') THEN
    ALTER TABLE public.asset_exports DROP CONSTRAINT asset_exports_format_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'asset_exports_format_valid'
                    AND conrelid = 'public.asset_exports'::regclass) THEN
    ALTER TABLE public.asset_exports
        ADD CONSTRAINT asset_exports_format_valid CHECK ((format = 'aasx'::text));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'asset_exports_type_known'
                AND conrelid = 'public.asset_exports'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((entity_type = ''devices''::text))') THEN
    ALTER TABLE public.asset_exports DROP CONSTRAINT asset_exports_type_known;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'asset_exports_type_known'
                    AND conrelid = 'public.asset_exports'::regclass) THEN
    ALTER TABLE public.asset_exports
        ADD CONSTRAINT asset_exports_type_known CHECK ((entity_type = 'devices'::text));
  END IF;
END $c$;

--

-- TABLE asset_exports :: COMMENT
COMMENT ON TABLE public.asset_exports IS 'Each per-asset bundle aas-export stored: an AASX carrying the shell, the audit trail, the telemetry still in the live historian and a manifest naming the cold objects that hold the rest. A sibling of the cold tier that shares its bucket, and not a row in the historian''s manifest, which is keyed by chunk and exists to make dropping one safe. Readable by the three roles the bucket admits; written by the function alone.';

--

-- audit_trail :: TABLE
CREATE TABLE IF NOT EXISTS public.audit_trail (
    id bigint NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    action text NOT NULL,
    old_data jsonb,
    new_data jsonb,
    changed_by uuid,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    actor_source text,
    causation_id bigint,
    audit_domain text NOT NULL,
    CONSTRAINT audit_trail_actor_source_check CHECK (((actor_source IS NULL) OR (actor_source = ANY (ARRAY['user'::text, 'ingestion'::text, 'migration'::text, 'service'::text])))),
    CONSTRAINT audit_trail_audit_domain_check CHECK ((audit_domain = ANY (ARRAY['asset'::text, 'security'::text])))
)
PARTITION BY RANGE (recorded_at);


ALTER TABLE public.audit_trail OWNER TO postgres;

ALTER TABLE public.audit_trail
    ADD COLUMN IF NOT EXISTS id bigint NOT NULL,
    ADD COLUMN IF NOT EXISTS entity_type text NOT NULL,
    ADD COLUMN IF NOT EXISTS entity_id uuid NOT NULL,
    ADD COLUMN IF NOT EXISTS action text NOT NULL,
    ADD COLUMN IF NOT EXISTS old_data jsonb,
    ADD COLUMN IF NOT EXISTS new_data jsonb,
    ADD COLUMN IF NOT EXISTS changed_by uuid,
    ADD COLUMN IF NOT EXISTS recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    ADD COLUMN IF NOT EXISTS actor_source text,
    ADD COLUMN IF NOT EXISTS causation_id bigint,
    ADD COLUMN IF NOT EXISTS audit_domain text NOT NULL;

ALTER TABLE public.audit_trail
    ALTER COLUMN id DROP DEFAULT,
    ALTER COLUMN entity_type DROP DEFAULT,
    ALTER COLUMN entity_id DROP DEFAULT,
    ALTER COLUMN action DROP DEFAULT,
    ALTER COLUMN old_data DROP DEFAULT,
    ALTER COLUMN new_data DROP DEFAULT,
    ALTER COLUMN changed_by DROP DEFAULT,
    ALTER COLUMN recorded_at SET DEFAULT now(),
    ALTER COLUMN actor_source DROP DEFAULT,
    ALTER COLUMN causation_id DROP DEFAULT,
    ALTER COLUMN audit_domain DROP DEFAULT;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'audit_trail_actor_source_check'
                AND conrelid = 'public.audit_trail'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((actor_source IS NULL) OR (actor_source = ANY (ARRAY[''user''::text, ''ingestion''::text, ''migration''::text, ''service''::text]))))') THEN
    ALTER TABLE public.audit_trail DROP CONSTRAINT audit_trail_actor_source_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'audit_trail_actor_source_check'
                    AND conrelid = 'public.audit_trail'::regclass) THEN
    ALTER TABLE public.audit_trail
        ADD CONSTRAINT audit_trail_actor_source_check CHECK (((actor_source IS NULL) OR (actor_source = ANY (ARRAY['user'::text, 'ingestion'::text, 'migration'::text, 'service'::text]))));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'audit_trail_audit_domain_check'
                AND conrelid = 'public.audit_trail'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((audit_domain = ANY (ARRAY[''asset''::text, ''security''::text])))') THEN
    ALTER TABLE public.audit_trail DROP CONSTRAINT audit_trail_audit_domain_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'audit_trail_audit_domain_check'
                    AND conrelid = 'public.audit_trail'::regclass) THEN
    ALTER TABLE public.audit_trail
        ADD CONSTRAINT audit_trail_audit_domain_check CHECK ((audit_domain = ANY (ARRAY['asset'::text, 'security'::text])));
  END IF;
END $c$;

--

-- TABLE audit_trail :: COMMENT
COMMENT ON TABLE public.audit_trail IS 'Append-only audit of every attributed change to cells, gateways and devices, plus the security lane 0070 added. Range-partitioned by month on recorded_at (0079) so retention is DETACH rather than DELETE. Rows are written only by log_audit_trail_event() and its named siblings; UPDATE and DELETE are refused for every role that is not an owner.';

--

-- COLUMN audit_trail.actor_source :: COMMENT
COMMENT ON COLUMN public.audit_trail.actor_source IS 'What kind of actor made the change: user | ingestion | migration | service. Complements changed_by, which names WHICH user and is NULL for every machine-originated write.';

--

-- COLUMN audit_trail.causation_id :: COMMENT
COMMENT ON COLUMN public.audit_trail.causation_id IS 'The transaction that wrote this row (txid_current()). Rows sharing it were written by ONE act -- an approval and the change it applied, a batch relocation, a delete that cascaded. NOT a global identifier: it is unique only within this database, and only until the epoch counter is reset by a restore from a dump. Group by it; never store it as a foreign reference.';

--

-- COLUMN audit_trail.audit_domain :: COMMENT
COMMENT ON COLUMN public.audit_trail.audit_domain IS 'asset | security. Stamped by trg_audit_trail_stamp_domain from audit_domain_for(); callers do not supply it and cannot override it. Decides which SELECT policy admits the row.';

--

-- audit_trail_id_seq :: SEQUENCE
CREATE SEQUENCE IF NOT EXISTS public.audit_trail_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.audit_trail_id_seq OWNER TO postgres;

--

-- audit_trail_id_seq :: SEQUENCE OWNED BY
ALTER SEQUENCE public.audit_trail_id_seq OWNED BY public.audit_trail.id;

--

-- audit_trail_default :: TABLE
SELECT public.ensure_audit_trail_partitions(3);
CREATE TABLE IF NOT EXISTS public.audit_trail_default PARTITION OF public.audit_trail DEFAULT;
SELECT public.secure_audit_trail_partition('public.audit_trail_default'::regclass);

--

-- audit_trail_partition_health :: VIEW
CREATE OR REPLACE VIEW public.audit_trail_partition_health AS
 SELECT ( SELECT count(*) AS count
           FROM (pg_class c
             JOIN pg_inherits i ON ((i.inhrelid = c.oid)))
          WHERE (i.inhparent = ('public.audit_trail'::regclass)::oid)) AS partition_count,
    ( SELECT count(*) AS count
           FROM public.audit_trail_default) AS default_rows,
    ( SELECT max((regexp_replace(pg_get_expr(c.relpartbound, c.oid), '^FOR VALUES FROM \(''([^'']+)''\) TO \(''([^'']+)''\).*$'::text, '\2'::text))::timestamp with time zone) AS max
           FROM (pg_class c
             JOIN pg_inherits i ON ((i.inhrelid = c.oid)))
          WHERE ((i.inhparent = ('public.audit_trail'::regclass)::oid) AND (pg_get_expr(c.relpartbound, c.oid) !~~ 'DEFAULT%'::text))) AS covered_until;


ALTER VIEW public.audit_trail_partition_health OWNER TO postgres;

--

-- VIEW audit_trail_partition_health :: COMMENT
COMMENT ON VIEW public.audit_trail_partition_health IS 'Whether audit_trail partitioning is keeping up. default_rows > 0 means the maintenance job has stopped and retention by DETACH is no longer complete; covered_until is the instant beyond which new rows fall to the default partition. Read by the Grafana rule "Audit Trail Partitions Falling Behind".';

--

-- backup_jobs :: TABLE
CREATE TABLE IF NOT EXISTS public.backup_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    origin text NOT NULL,
    status text DEFAULT 'PENDING'::text NOT NULL,
    note text,
    requested_by uuid,
    backup_id uuid,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    CONSTRAINT backup_jobs_origin_valid CHECK ((origin = ANY (ARRAY['requested'::text, 'scheduled'::text]))),
    CONSTRAINT backup_jobs_status_valid CHECK ((status = ANY (ARRAY['PENDING'::text, 'RUNNING'::text, 'COMPLETED'::text, 'FAILED'::text, 'CANCELLED'::text])))
);


ALTER TABLE public.backup_jobs OWNER TO postgres;

ALTER TABLE public.backup_jobs
    ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid() NOT NULL,
    ADD COLUMN IF NOT EXISTS origin text NOT NULL,
    ADD COLUMN IF NOT EXISTS status text DEFAULT 'PENDING'::text NOT NULL,
    ADD COLUMN IF NOT EXISTS note text,
    ADD COLUMN IF NOT EXISTS requested_by uuid,
    ADD COLUMN IF NOT EXISTS backup_id uuid,
    ADD COLUMN IF NOT EXISTS error text,
    ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now() NOT NULL,
    ADD COLUMN IF NOT EXISTS started_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS finished_at timestamp with time zone;

ALTER TABLE public.backup_jobs
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN origin DROP DEFAULT,
    ALTER COLUMN status SET DEFAULT 'PENDING'::text,
    ALTER COLUMN note DROP DEFAULT,
    ALTER COLUMN requested_by DROP DEFAULT,
    ALTER COLUMN backup_id DROP DEFAULT,
    ALTER COLUMN error DROP DEFAULT,
    ALTER COLUMN created_at SET DEFAULT now(),
    ALTER COLUMN started_at DROP DEFAULT,
    ALTER COLUMN finished_at DROP DEFAULT;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'backup_jobs_origin_valid'
                AND conrelid = 'public.backup_jobs'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((origin = ANY (ARRAY[''requested''::text, ''scheduled''::text])))') THEN
    ALTER TABLE public.backup_jobs DROP CONSTRAINT backup_jobs_origin_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'backup_jobs_origin_valid'
                    AND conrelid = 'public.backup_jobs'::regclass) THEN
    ALTER TABLE public.backup_jobs
        ADD CONSTRAINT backup_jobs_origin_valid CHECK ((origin = ANY (ARRAY['requested'::text, 'scheduled'::text])));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'backup_jobs_status_valid'
                AND conrelid = 'public.backup_jobs'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((status = ANY (ARRAY[''PENDING''::text, ''RUNNING''::text, ''COMPLETED''::text, ''FAILED''::text, ''CANCELLED''::text])))') THEN
    ALTER TABLE public.backup_jobs DROP CONSTRAINT backup_jobs_status_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'backup_jobs_status_valid'
                    AND conrelid = 'public.backup_jobs'::regclass) THEN
    ALTER TABLE public.backup_jobs
        ADD CONSTRAINT backup_jobs_status_valid CHECK ((status = ANY (ARRAY['PENDING'::text, 'RUNNING'::text, 'COMPLETED'::text, 'FAILED'::text, 'CANCELLED'::text])));
  END IF;
END $c$;

--

-- TABLE backup_jobs :: COMMENT
COMMENT ON TABLE public.backup_jobs IS 'One row per backup ATTEMPTED, including the ones that failed. At most one row is PENDING or RUNNING at a time (backup_jobs_single_flight). Written only through request_backup(), enqueue_scheduled_backup() and the backup service''s gates -- there is no direct-write RLS policy. Readable by Administrator only.';

--

-- COLUMN backup_jobs.origin :: COMMENT
COMMENT ON COLUMN public.backup_jobs.origin IS 'requested: an Administrator asked, and requested_by names them. scheduled: the service''s timer asked, and requested_by is NULL.';

--

-- COLUMN backup_jobs.backup_id :: COMMENT
COMMENT ON COLUMN public.backup_jobs.backup_id IS 'The backups row this job produced, set by backup_finalise(). Not a foreign key: a pruned backup keeps its job row, which is the history of the act.';

--

-- COLUMN backup_jobs.error :: COMMENT
COMMENT ON COLUMN public.backup_jobs.error IS 'What the service said when it failed, capped at 2000 characters. The page shows this string.';

--

-- backup_health :: VIEW
CREATE OR REPLACE VIEW public.backup_health AS
 SELECT now() AS collected_at,
    last_success_at,
    EXTRACT(epoch FROM (now() - COALESCE(last_success_at, first_recorded_at))) AS age_seconds
   FROM ( SELECT max(j.started_at) FILTER (WHERE (j.status = 'COMPLETED'::text)) AS last_success_at,
            min(j.created_at) AS first_recorded_at
           FROM public.backup_jobs j) s
  WHERE (first_recorded_at IS NOT NULL);


ALTER VIEW public.backup_health OWNER TO postgres;

--

-- VIEW backup_health :: COMMENT
COMMENT ON VIEW public.backup_health IS 'How long since the platform backup last succeeded. last_success_at is when the newest COMPLETED backup_jobs row started (NULL before the first); age_seconds counts from it, or from the first job recorded while none has succeeded. No row while no job exists. Read by the Grafana rule "Backup Stale" as grafana_reader.';

--

-- backup_offsite_health :: VIEW
CREATE OR REPLACE VIEW public.backup_offsite_health AS
 SELECT now() AS collected_at,
    newest_stamp,
    offsite_state,
    age_seconds
   FROM public.backup_offsite_health_rows() r(newest_stamp, offsite_state, age_seconds);


ALTER VIEW public.backup_offsite_health OWNER TO postgres;

--

-- VIEW backup_offsite_health :: COMMENT
COMMENT ON VIEW public.backup_offsite_health IS 'How long the newest backup has gone without an off-site copy at the current destination: age_seconds from when it was taken or the destination last changed, zero once copied. No row while the destination is incomplete or no backup exists. Read by the Grafana rule "Off-site Backup Stale" as grafana_reader.';

--

-- backups :: TABLE
CREATE TABLE IF NOT EXISTS public.backups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    stamp text NOT NULL,
    origin text NOT NULL,
    note text,
    requested_by uuid,
    job_id uuid,
    location text NOT NULL,
    components jsonb DEFAULT '[]'::jsonb NOT NULL,
    size_bytes bigint DEFAULT 0 NOT NULL,
    pinned boolean DEFAULT false NOT NULL,
    released_at timestamp with time zone,
    released_by uuid,
    taken_at timestamp with time zone DEFAULT now() NOT NULL,
    offsite_state text DEFAULT 'PENDING'::text NOT NULL,
    offsite_location text,
    offsite_objects jsonb,
    offsite_copied_at timestamp with time zone,
    offsite_attempted_at timestamp with time zone,
    offsite_attempts integer DEFAULT 0 NOT NULL,
    offsite_error text,
    CONSTRAINT backups_components_is_an_array CHECK ((jsonb_typeof(components) = 'array'::text)),
    CONSTRAINT backups_offsite_state_valid CHECK ((offsite_state = ANY (ARRAY['PENDING'::text, 'COPIED'::text, 'FAILED'::text]))),
    CONSTRAINT backups_origin_valid CHECK ((origin = ANY (ARRAY['requested'::text, 'scheduled'::text]))),
    CONSTRAINT backups_size_is_not_negative CHECK ((size_bytes >= 0)),
    CONSTRAINT backups_stamp_is_a_directory_name CHECK ((stamp ~ '^[0-9]{8}T[0-9]{6}Z$'::text))
);


ALTER TABLE public.backups OWNER TO postgres;

ALTER TABLE public.backups
    ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid() NOT NULL,
    ADD COLUMN IF NOT EXISTS stamp text NOT NULL,
    ADD COLUMN IF NOT EXISTS origin text NOT NULL,
    ADD COLUMN IF NOT EXISTS note text,
    ADD COLUMN IF NOT EXISTS requested_by uuid,
    ADD COLUMN IF NOT EXISTS job_id uuid,
    ADD COLUMN IF NOT EXISTS location text NOT NULL,
    ADD COLUMN IF NOT EXISTS components jsonb DEFAULT '[]'::jsonb NOT NULL,
    ADD COLUMN IF NOT EXISTS size_bytes bigint DEFAULT 0 NOT NULL,
    ADD COLUMN IF NOT EXISTS pinned boolean DEFAULT false NOT NULL,
    ADD COLUMN IF NOT EXISTS released_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS released_by uuid,
    ADD COLUMN IF NOT EXISTS taken_at timestamp with time zone DEFAULT now() NOT NULL,
    ADD COLUMN IF NOT EXISTS offsite_state text DEFAULT 'PENDING'::text NOT NULL,
    ADD COLUMN IF NOT EXISTS offsite_location text,
    ADD COLUMN IF NOT EXISTS offsite_objects jsonb,
    ADD COLUMN IF NOT EXISTS offsite_copied_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS offsite_attempted_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS offsite_attempts integer DEFAULT 0 NOT NULL,
    ADD COLUMN IF NOT EXISTS offsite_error text;

ALTER TABLE public.backups
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN stamp DROP DEFAULT,
    ALTER COLUMN origin DROP DEFAULT,
    ALTER COLUMN note DROP DEFAULT,
    ALTER COLUMN requested_by DROP DEFAULT,
    ALTER COLUMN job_id DROP DEFAULT,
    ALTER COLUMN location DROP DEFAULT,
    ALTER COLUMN components SET DEFAULT '[]'::jsonb,
    ALTER COLUMN size_bytes SET DEFAULT 0,
    ALTER COLUMN pinned SET DEFAULT false,
    ALTER COLUMN released_at DROP DEFAULT,
    ALTER COLUMN released_by DROP DEFAULT,
    ALTER COLUMN taken_at SET DEFAULT now(),
    ALTER COLUMN offsite_state SET DEFAULT 'PENDING'::text,
    ALTER COLUMN offsite_location DROP DEFAULT,
    ALTER COLUMN offsite_objects DROP DEFAULT,
    ALTER COLUMN offsite_copied_at DROP DEFAULT,
    ALTER COLUMN offsite_attempted_at DROP DEFAULT,
    ALTER COLUMN offsite_attempts SET DEFAULT 0,
    ALTER COLUMN offsite_error DROP DEFAULT;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'backups_components_is_an_array'
                AND conrelid = 'public.backups'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((jsonb_typeof(components) = ''array''::text))') THEN
    ALTER TABLE public.backups DROP CONSTRAINT backups_components_is_an_array;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'backups_components_is_an_array'
                    AND conrelid = 'public.backups'::regclass) THEN
    ALTER TABLE public.backups
        ADD CONSTRAINT backups_components_is_an_array CHECK ((jsonb_typeof(components) = 'array'::text));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'backups_offsite_state_valid'
                AND conrelid = 'public.backups'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((offsite_state = ANY (ARRAY[''PENDING''::text, ''COPIED''::text, ''FAILED''::text])))') THEN
    ALTER TABLE public.backups DROP CONSTRAINT backups_offsite_state_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'backups_offsite_state_valid'
                    AND conrelid = 'public.backups'::regclass) THEN
    ALTER TABLE public.backups
        ADD CONSTRAINT backups_offsite_state_valid CHECK ((offsite_state = ANY (ARRAY['PENDING'::text, 'COPIED'::text, 'FAILED'::text])));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'backups_origin_valid'
                AND conrelid = 'public.backups'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((origin = ANY (ARRAY[''requested''::text, ''scheduled''::text])))') THEN
    ALTER TABLE public.backups DROP CONSTRAINT backups_origin_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'backups_origin_valid'
                    AND conrelid = 'public.backups'::regclass) THEN
    ALTER TABLE public.backups
        ADD CONSTRAINT backups_origin_valid CHECK ((origin = ANY (ARRAY['requested'::text, 'scheduled'::text])));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'backups_size_is_not_negative'
                AND conrelid = 'public.backups'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((size_bytes >= 0))') THEN
    ALTER TABLE public.backups DROP CONSTRAINT backups_size_is_not_negative;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'backups_size_is_not_negative'
                    AND conrelid = 'public.backups'::regclass) THEN
    ALTER TABLE public.backups
        ADD CONSTRAINT backups_size_is_not_negative CHECK ((size_bytes >= 0));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'backups_stamp_is_a_directory_name'
                AND conrelid = 'public.backups'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((stamp ~ ''^[0-9]{8}T[0-9]{6}Z$''::text))') THEN
    ALTER TABLE public.backups DROP CONSTRAINT backups_stamp_is_a_directory_name;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'backups_stamp_is_a_directory_name'
                    AND conrelid = 'public.backups'::regclass) THEN
    ALTER TABLE public.backups
        ADD CONSTRAINT backups_stamp_is_a_directory_name CHECK ((stamp ~ '^[0-9]{8}T[0-9]{6}Z$'::text));
  END IF;
END $c$;

--

-- TABLE backups :: COMMENT
COMMENT ON TABLE public.backups IS 'One row per backup that EXISTS on the backup volume; the row is deleted when the service prunes the files, and BACKUP_PRUNED in audit_trail is the record that it did. Written only by backup_finalise() and backup_offsite_record(), and released only by release_backup(). Readable by Administrator only. No byte reaches a browser; the off-site copy is encrypted before it leaves the service.';

--

-- COLUMN backups.stamp :: COMMENT
COMMENT ON COLUMN public.backups.stamp IS 'The UTC stamp the files carry, YYYYMMDDTHHMMSSZ, and the name of the directory under the backup volume holding them. What BACKUP_STAMP takes in restore-databases.sh.';

--

-- COLUMN backups.location :: COMMENT
COMMENT ON COLUMN public.backups.location IS 'The directory holding this backup''s files, as a path inside the backup service''s container. Informational: a restore is run from a shell against the volume, not from this row.';

--

-- COLUMN backups.components :: COMMENT
COMMENT ON COLUMN public.backups.components IS 'What the backup holds: an array of {name, file, size_bytes, sha256}. Names are supabase-db, timescaledb, vault-key, storage-objects, forge, broker and ca; a component the service was not given a volume, a file or a Secret for is absent, not empty.';

--

-- COLUMN backups.pinned :: COMMENT
COMMENT ON COLUMN public.backups.pinned IS 'True keeps the backup out of the retention prune. Set at creation for a requested backup, cleared by release_backup(). A scheduled backup is never pinned.';

--

-- COLUMN backups.offsite_state :: COMMENT
COMMENT ON COLUMN public.backups.offsite_state IS 'The off-site copy. PENDING: none yet. COPIED: every file uploaded, encrypted, and checked by a HEAD against its SHA-256. FAILED: the last attempt failed, offsite_error says why, and the service tries again after a backoff. Written only by backup_offsite_record().';

--

-- COLUMN backups.offsite_location :: COMMENT
COMMENT ON COLUMN public.backups.offsite_location IS 'Where the copy is: <endpoint>/<bucket>/<prefix>/<stamp>/, one <file>.age object per file.';

--

-- COLUMN backups.offsite_objects :: COMMENT
COMMENT ON COLUMN public.backups.offsite_objects IS 'The uploaded objects: an array of {file, key, size_bytes, sha256}, the digest of the ciphertext.';

--

-- COLUMN backups.offsite_attempts :: COMMENT
COMMENT ON COLUMN public.backups.offsite_attempts IS 'Failed attempts since the last success; the backoff before the next one grows with it.';

--

-- capture_jobs :: TABLE
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
    CONSTRAINT capture_jobs_caps_are_bounded CHECK (((max_seconds BETWEEN 5 AND 7200) AND (max_messages BETWEEN 1 AND 100000) AND (max_bytes BETWEEN 1024 AND 52428800))),
    CONSTRAINT capture_jobs_status_valid CHECK ((status = ANY (ARRAY['PENDING'::text, 'RECORDING'::text, 'COMPLETED'::text, 'FAILED'::text, 'CANCELLED'::text]))),
    CONSTRAINT capture_jobs_subject_is_coherent CHECK ((((subject_kind = 'gateway'::text) AND (gateway_id IS NOT NULL) AND (device_sparkplug_id IS NULL)) OR ((subject_kind = 'device'::text) AND (device_id IS NOT NULL) AND (device_sparkplug_id IS NOT NULL)))),
    CONSTRAINT capture_jobs_subject_kind_valid CHECK ((subject_kind = ANY (ARRAY['gateway'::text, 'device'::text])))
);

ALTER TABLE ONLY public.capture_jobs REPLICA IDENTITY FULL;


ALTER TABLE public.capture_jobs OWNER TO postgres;

ALTER TABLE public.capture_jobs
    ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid() NOT NULL,
    ADD COLUMN IF NOT EXISTS subject_kind text NOT NULL,
    ADD COLUMN IF NOT EXISTS gateway_id uuid,
    ADD COLUMN IF NOT EXISTS device_id uuid,
    ADD COLUMN IF NOT EXISTS sparkplug_group text NOT NULL,
    ADD COLUMN IF NOT EXISTS edge_node_id text NOT NULL,
    ADD COLUMN IF NOT EXISTS device_sparkplug_id text,
    ADD COLUMN IF NOT EXISTS subject_sparkplug_id text NOT NULL,
    ADD COLUMN IF NOT EXISTS storage_path text NOT NULL,
    ADD COLUMN IF NOT EXISTS status text DEFAULT 'PENDING'::text NOT NULL,
    ADD COLUMN IF NOT EXISTS note text,
    ADD COLUMN IF NOT EXISTS max_seconds integer DEFAULT 7200 NOT NULL,
    ADD COLUMN IF NOT EXISTS max_messages integer DEFAULT 100000 NOT NULL,
    ADD COLUMN IF NOT EXISTS max_bytes bigint DEFAULT 52428800 NOT NULL,
    ADD COLUMN IF NOT EXISTS messages bigint DEFAULT 0 NOT NULL,
    ADD COLUMN IF NOT EXISTS bytes bigint DEFAULT 0 NOT NULL,
    ADD COLUMN IF NOT EXISTS elapsed_seconds integer DEFAULT 0 NOT NULL,
    ADD COLUMN IF NOT EXISTS birth_captured boolean DEFAULT false NOT NULL,
    ADD COLUMN IF NOT EXISTS stop_requested boolean DEFAULT false NOT NULL,
    ADD COLUMN IF NOT EXISTS capture_id uuid,
    ADD COLUMN IF NOT EXISTS error text,
    ADD COLUMN IF NOT EXISTS requested_by uuid,
    ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now() NOT NULL,
    ADD COLUMN IF NOT EXISTS started_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS finished_at timestamp with time zone;

ALTER TABLE public.capture_jobs
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN subject_kind DROP DEFAULT,
    ALTER COLUMN gateway_id DROP DEFAULT,
    ALTER COLUMN device_id DROP DEFAULT,
    ALTER COLUMN sparkplug_group DROP DEFAULT,
    ALTER COLUMN edge_node_id DROP DEFAULT,
    ALTER COLUMN device_sparkplug_id DROP DEFAULT,
    ALTER COLUMN subject_sparkplug_id DROP DEFAULT,
    ALTER COLUMN storage_path DROP DEFAULT,
    ALTER COLUMN status SET DEFAULT 'PENDING'::text,
    ALTER COLUMN note DROP DEFAULT,
    ALTER COLUMN max_seconds SET DEFAULT 7200,
    ALTER COLUMN max_messages SET DEFAULT 100000,
    ALTER COLUMN max_bytes SET DEFAULT 52428800,
    ALTER COLUMN messages SET DEFAULT 0,
    ALTER COLUMN bytes SET DEFAULT 0,
    ALTER COLUMN elapsed_seconds SET DEFAULT 0,
    ALTER COLUMN birth_captured SET DEFAULT false,
    ALTER COLUMN stop_requested SET DEFAULT false,
    ALTER COLUMN capture_id DROP DEFAULT,
    ALTER COLUMN error DROP DEFAULT,
    ALTER COLUMN requested_by DROP DEFAULT,
    ALTER COLUMN created_at SET DEFAULT now(),
    ALTER COLUMN started_at DROP DEFAULT,
    ALTER COLUMN finished_at DROP DEFAULT;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'capture_jobs_caps_are_bounded'
                AND conrelid = 'public.capture_jobs'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((max_seconds BETWEEN 5 AND 7200) AND (max_messages BETWEEN 1 AND 100000) AND (max_bytes BETWEEN 1024 AND 52428800)))') THEN
    ALTER TABLE public.capture_jobs DROP CONSTRAINT capture_jobs_caps_are_bounded;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'capture_jobs_caps_are_bounded'
                    AND conrelid = 'public.capture_jobs'::regclass) THEN
    ALTER TABLE public.capture_jobs
        ADD CONSTRAINT capture_jobs_caps_are_bounded CHECK (((max_seconds BETWEEN 5 AND 7200) AND (max_messages BETWEEN 1 AND 100000) AND (max_bytes BETWEEN 1024 AND 52428800)));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'capture_jobs_status_valid'
                AND conrelid = 'public.capture_jobs'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((status = ANY (ARRAY[''PENDING''::text, ''RECORDING''::text, ''COMPLETED''::text, ''FAILED''::text, ''CANCELLED''::text])))') THEN
    ALTER TABLE public.capture_jobs DROP CONSTRAINT capture_jobs_status_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'capture_jobs_status_valid'
                    AND conrelid = 'public.capture_jobs'::regclass) THEN
    ALTER TABLE public.capture_jobs
        ADD CONSTRAINT capture_jobs_status_valid CHECK ((status = ANY (ARRAY['PENDING'::text, 'RECORDING'::text, 'COMPLETED'::text, 'FAILED'::text, 'CANCELLED'::text])));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'capture_jobs_subject_is_coherent'
                AND conrelid = 'public.capture_jobs'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((((subject_kind = ''gateway''::text) AND (gateway_id IS NOT NULL) AND (device_sparkplug_id IS NULL)) OR ((subject_kind = ''device''::text) AND (device_id IS NOT NULL) AND (device_sparkplug_id IS NOT NULL))))') THEN
    ALTER TABLE public.capture_jobs DROP CONSTRAINT capture_jobs_subject_is_coherent;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'capture_jobs_subject_is_coherent'
                    AND conrelid = 'public.capture_jobs'::regclass) THEN
    ALTER TABLE public.capture_jobs
        ADD CONSTRAINT capture_jobs_subject_is_coherent CHECK ((((subject_kind = 'gateway'::text) AND (gateway_id IS NOT NULL) AND (device_sparkplug_id IS NULL)) OR ((subject_kind = 'device'::text) AND (device_id IS NOT NULL) AND (device_sparkplug_id IS NOT NULL))));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'capture_jobs_subject_kind_valid'
                AND conrelid = 'public.capture_jobs'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((subject_kind = ANY (ARRAY[''gateway''::text, ''device''::text])))') THEN
    ALTER TABLE public.capture_jobs DROP CONSTRAINT capture_jobs_subject_kind_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'capture_jobs_subject_kind_valid'
                    AND conrelid = 'public.capture_jobs'::regclass) THEN
    ALTER TABLE public.capture_jobs
        ADD CONSTRAINT capture_jobs_subject_kind_valid CHECK ((subject_kind = ANY (ARRAY['gateway'::text, 'device'::text])));
  END IF;
END $c$;

--

-- TABLE capture_jobs :: COMMENT
COMMENT ON TABLE public.capture_jobs IS 'One row per recording ATTEMPTED, including the ones that failed. At most one row is PENDING or RECORDING at a time across the whole stack (capture_jobs_single_flight). Written only through the gates in 0055 -- there is no direct-write RLS policy -- and pushed to the Capture page by Realtime as the daemon updates its progress columns.';

--

-- COLUMN capture_jobs.stop_requested :: COMMENT
COMMENT ON COLUMN public.capture_jobs.stop_requested IS 'Set by request_capture_stop(); observed by the daemon on its next message, which then flushes and completes. A column rather than an endpoint because the daemon hosts no REST tier, and because a flag survives a page reload.';

--

-- captures :: TABLE
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


ALTER TABLE public.captures OWNER TO postgres;

ALTER TABLE public.captures
    ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid() NOT NULL,
    ADD COLUMN IF NOT EXISTS subject_kind text NOT NULL,
    ADD COLUMN IF NOT EXISTS gateway_id uuid,
    ADD COLUMN IF NOT EXISTS device_id uuid,
    ADD COLUMN IF NOT EXISTS subject_sparkplug_id text NOT NULL,
    ADD COLUMN IF NOT EXISTS storage_path text NOT NULL,
    ADD COLUMN IF NOT EXISTS size_bytes bigint NOT NULL,
    ADD COLUMN IF NOT EXISTS message_count integer NOT NULL,
    ADD COLUMN IF NOT EXISTS note text,
    ADD COLUMN IF NOT EXISTS manifest jsonb DEFAULT '{}'::jsonb NOT NULL,
    ADD COLUMN IF NOT EXISTS source text DEFAULT 'recorded'::text NOT NULL,
    ADD COLUMN IF NOT EXISTS recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now() NOT NULL,
    ADD COLUMN IF NOT EXISTS created_by uuid;

ALTER TABLE public.captures
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN subject_kind DROP DEFAULT,
    ALTER COLUMN gateway_id DROP DEFAULT,
    ALTER COLUMN device_id DROP DEFAULT,
    ALTER COLUMN subject_sparkplug_id DROP DEFAULT,
    ALTER COLUMN storage_path DROP DEFAULT,
    ALTER COLUMN size_bytes DROP DEFAULT,
    ALTER COLUMN message_count DROP DEFAULT,
    ALTER COLUMN note DROP DEFAULT,
    ALTER COLUMN manifest SET DEFAULT '{}'::jsonb,
    ALTER COLUMN source SET DEFAULT 'recorded'::text,
    ALTER COLUMN recorded_at SET DEFAULT now(),
    ALTER COLUMN created_at SET DEFAULT now(),
    ALTER COLUMN created_by DROP DEFAULT;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'captures_message_count_check'
                AND conrelid = 'public.captures'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((message_count >= 0))') THEN
    ALTER TABLE public.captures DROP CONSTRAINT captures_message_count_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'captures_message_count_check'
                    AND conrelid = 'public.captures'::regclass) THEN
    ALTER TABLE public.captures
        ADD CONSTRAINT captures_message_count_check CHECK ((message_count >= 0));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'captures_size_bytes_check'
                AND conrelid = 'public.captures'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((size_bytes >= 0))') THEN
    ALTER TABLE public.captures DROP CONSTRAINT captures_size_bytes_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'captures_size_bytes_check'
                    AND conrelid = 'public.captures'::regclass) THEN
    ALTER TABLE public.captures
        ADD CONSTRAINT captures_size_bytes_check CHECK ((size_bytes >= 0));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'captures_source_valid'
                AND conrelid = 'public.captures'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((source = ANY (ARRAY[''recorded''::text, ''uploaded''::text])))') THEN
    ALTER TABLE public.captures DROP CONSTRAINT captures_source_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'captures_source_valid'
                    AND conrelid = 'public.captures'::regclass) THEN
    ALTER TABLE public.captures
        ADD CONSTRAINT captures_source_valid CHECK ((source = ANY (ARRAY['recorded'::text, 'uploaded'::text])));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'captures_subject_is_coherent'
                AND conrelid = 'public.captures'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((((subject_kind = ''gateway''::text) AND (gateway_id IS NOT NULL) AND (device_id IS NULL)) OR ((subject_kind = ''device''::text) AND (device_id IS NOT NULL))))') THEN
    ALTER TABLE public.captures DROP CONSTRAINT captures_subject_is_coherent;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'captures_subject_is_coherent'
                    AND conrelid = 'public.captures'::regclass) THEN
    ALTER TABLE public.captures
        ADD CONSTRAINT captures_subject_is_coherent CHECK ((((subject_kind = 'gateway'::text) AND (gateway_id IS NOT NULL) AND (device_id IS NULL)) OR ((subject_kind = 'device'::text) AND (device_id IS NOT NULL))));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'captures_subject_kind_valid'
                AND conrelid = 'public.captures'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((subject_kind = ANY (ARRAY[''gateway''::text, ''device''::text])))') THEN
    ALTER TABLE public.captures DROP CONSTRAINT captures_subject_kind_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'captures_subject_kind_valid'
                    AND conrelid = 'public.captures'::regclass) THEN
    ALTER TABLE public.captures
        ADD CONSTRAINT captures_subject_kind_valid CHECK ((subject_kind = ANY (ARRAY['gateway'::text, 'device'::text])));
  END IF;
END $c$;

--

-- TABLE captures :: COMMENT
COMMENT ON TABLE public.captures IS 'The capture that EXISTS for a subject -- at most one per gateway and one per device, enforced by two partial unique indexes. Written by ingest_finalise_capture() for a recorded capture and by register_uploaded_capture() for one uploaded through the browser; both paths land here so that playback has a single way to name a capture. Distinct from capture_jobs, which records the ACT of recording and has no row at all for an uploaded file. See 0055''s header.';

--

-- COLUMN captures.manifest :: COMMENT
COMMENT ON COLUMN public.captures.manifest IS 'What is in the file, so the list can describe a capture nobody has downloaded: metric_names (capped at 50, with metric_name_count beside it), topic_count, observed_rate_hz, birth_captured, and the edge_node_ids / device_ids the recording publishes under. birth_captured=false means the recording contains no NBIRTH/DBIRTH, so an alias-optimised gateway will replay as unresolved_alias and drop every metric -- from a file that otherwise looks complete. Note it means the NODE''s birth: announcing a DEVICE takes a DBIRTH, and only that sets a device ONLINE. device_ids is what the playback dialog builds its device map from, which is why it is here rather than read out of a file that may be 100 MiB.';

--

-- cells :: TABLE
CREATE TABLE IF NOT EXISTS public.cells (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    grafana_url text,
    created_at timestamp with time zone DEFAULT now(),
    is_archived boolean DEFAULT false,
    archived_at timestamp with time zone,
    auto_delete_at timestamp with time zone,
    icon text DEFAULT 'Factory'::text NOT NULL,
    area_id uuid,
    description text,
    plan_x numeric(7,6),
    plan_y numeric(7,6),
    CONSTRAINT cells_icon_valid CHECK ((icon = ANY (ARRAY['Factory'::text, 'Bot'::text, 'Cog'::text, 'CircuitBoard'::text, 'Gauge'::text, 'Building2'::text, 'Truck'::text, 'Zap'::text]))),
    CONSTRAINT cells_place_is_a_pair CHECK (((plan_x IS NULL) = (plan_y IS NULL))),
    CONSTRAINT cells_place_needs_an_area CHECK (((plan_x IS NULL) OR (area_id IS NOT NULL))),
    CONSTRAINT cells_place_within_plan CHECK ((((plan_x IS NULL) OR ((plan_x >= (0)::numeric) AND (plan_x <= (1)::numeric))) AND ((plan_y IS NULL) OR ((plan_y >= (0)::numeric) AND (plan_y <= (1)::numeric)))))
);

ALTER TABLE ONLY public.cells REPLICA IDENTITY FULL;


ALTER TABLE public.cells OWNER TO postgres;

ALTER TABLE public.cells
    ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid() NOT NULL,
    ADD COLUMN IF NOT EXISTS name text NOT NULL,
    ADD COLUMN IF NOT EXISTS grafana_url text,
    ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now(),
    ADD COLUMN IF NOT EXISTS is_archived boolean DEFAULT false,
    ADD COLUMN IF NOT EXISTS archived_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS auto_delete_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS icon text DEFAULT 'Factory'::text NOT NULL,
    ADD COLUMN IF NOT EXISTS area_id uuid,
    ADD COLUMN IF NOT EXISTS description text,
    ADD COLUMN IF NOT EXISTS plan_x numeric(7,6),
    ADD COLUMN IF NOT EXISTS plan_y numeric(7,6);

ALTER TABLE public.cells
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN name DROP DEFAULT,
    ALTER COLUMN grafana_url DROP DEFAULT,
    ALTER COLUMN created_at SET DEFAULT now(),
    ALTER COLUMN is_archived SET DEFAULT false,
    ALTER COLUMN archived_at DROP DEFAULT,
    ALTER COLUMN auto_delete_at DROP DEFAULT,
    ALTER COLUMN icon SET DEFAULT 'Factory'::text,
    ALTER COLUMN area_id DROP DEFAULT,
    ALTER COLUMN description DROP DEFAULT,
    ALTER COLUMN plan_x DROP DEFAULT,
    ALTER COLUMN plan_y DROP DEFAULT;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'cells_icon_valid'
                AND conrelid = 'public.cells'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((icon = ANY (ARRAY[''Factory''::text, ''Bot''::text, ''Cog''::text, ''CircuitBoard''::text, ''Gauge''::text, ''Building2''::text, ''Truck''::text, ''Zap''::text])))') THEN
    ALTER TABLE public.cells DROP CONSTRAINT cells_icon_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'cells_icon_valid'
                    AND conrelid = 'public.cells'::regclass) THEN
    ALTER TABLE public.cells
        ADD CONSTRAINT cells_icon_valid CHECK ((icon = ANY (ARRAY['Factory'::text, 'Bot'::text, 'Cog'::text, 'CircuitBoard'::text, 'Gauge'::text, 'Building2'::text, 'Truck'::text, 'Zap'::text])));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'cells_place_is_a_pair'
                AND conrelid = 'public.cells'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((plan_x IS NULL) = (plan_y IS NULL)))') THEN
    ALTER TABLE public.cells DROP CONSTRAINT cells_place_is_a_pair;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'cells_place_is_a_pair'
                    AND conrelid = 'public.cells'::regclass) THEN
    ALTER TABLE public.cells
        ADD CONSTRAINT cells_place_is_a_pair CHECK (((plan_x IS NULL) = (plan_y IS NULL)));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'cells_place_needs_an_area'
                AND conrelid = 'public.cells'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((plan_x IS NULL) OR (area_id IS NOT NULL)))') THEN
    ALTER TABLE public.cells DROP CONSTRAINT cells_place_needs_an_area;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'cells_place_needs_an_area'
                    AND conrelid = 'public.cells'::regclass) THEN
    ALTER TABLE public.cells
        ADD CONSTRAINT cells_place_needs_an_area CHECK (((plan_x IS NULL) OR (area_id IS NOT NULL)));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'cells_place_within_plan'
                AND conrelid = 'public.cells'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((((plan_x IS NULL) OR ((plan_x >= (0)::numeric) AND (plan_x <= (1)::numeric))) AND ((plan_y IS NULL) OR ((plan_y >= (0)::numeric) AND (plan_y <= (1)::numeric)))))') THEN
    ALTER TABLE public.cells DROP CONSTRAINT cells_place_within_plan;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'cells_place_within_plan'
                    AND conrelid = 'public.cells'::regclass) THEN
    ALTER TABLE public.cells
        ADD CONSTRAINT cells_place_within_plan CHECK ((((plan_x IS NULL) OR ((plan_x >= (0)::numeric) AND (plan_x <= (1)::numeric))) AND ((plan_y IS NULL) OR ((plan_y >= (0)::numeric) AND (plan_y <= (1)::numeric)))));
  END IF;
END $c$;

--

-- COLUMN cells.icon :: COMMENT
COMMENT ON COLUMN public.cells.icon IS 'Icon key for this cell, rendered by the dashboard from a bundled SVG set. A closed set (see cells_icon_valid) rather than free text: the column is a lookup key, never markup or a URL.';

--

-- COLUMN cells.area_id :: COMMENT
COMMENT ON COLUMN public.cells.area_id IS 'The ISA-95 area this cell is in; NULL is unfiled, which the Areas page lists as a queue. Devices and gateways in the cell derive their area from it and store none.';

--

-- COLUMN cells.description :: COMMENT
COMMENT ON COLUMN public.cells.description IS 'Free text about the cell, shown as a help tip beside its name on the Site Map when present. Not a topic segment.';

--

-- COLUMN cells.plan_x :: COMMENT
COMMENT ON COLUMN public.cells.plan_x IS 'Where the cell sits on its area''s plan, as a fraction of the plan''s width, 0 at the left. NULL with plan_y is unplaced: the Site Map lists the cell beside the plan.';

--

-- COLUMN cells.plan_y :: COMMENT
COMMENT ON COLUMN public.cells.plan_y IS 'Fraction of the plan''s height, 0 at the top. Always set together with plan_x.';

--

-- change_proposals :: TABLE
CREATE TABLE IF NOT EXISTS public.change_proposals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    patch jsonb NOT NULL,
    rationale text,
    status text DEFAULT 'open'::text NOT NULL,
    proposed_by uuid DEFAULT auth.uid() NOT NULL,
    proposed_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_by uuid,
    decided_at timestamp with time zone,
    decision_reason text,
    applied_trail_id bigint,
    proposed_by_email text,
    CONSTRAINT change_proposals_closed_rows_are_decided CHECK (((status = 'open'::text) OR (decided_at IS NOT NULL))),
    CONSTRAINT change_proposals_entity_type_known CHECK ((entity_type = ANY (ARRAY['devices'::text, 'device_nameplate'::text, 'areas'::text, 'cells'::text, 'gateways'::text, 'schemas'::text]))),
    CONSTRAINT change_proposals_open_rows_are_undecided CHECK (((status <> 'open'::text) OR ((decided_by IS NULL) AND (decided_at IS NULL) AND (decision_reason IS NULL) AND (applied_trail_id IS NULL)))),
    CONSTRAINT change_proposals_patch_is_an_object CHECK (((jsonb_typeof(patch) = 'object'::text) AND (patch <> '{}'::jsonb))),
    CONSTRAINT change_proposals_rejection_carries_a_reason CHECK (((status <> 'rejected'::text) OR ((decision_reason IS NOT NULL) AND (btrim(decision_reason) <> ''::text)))),
    CONSTRAINT change_proposals_status_known CHECK ((status = ANY (ARRAY['open'::text, 'applied'::text, 'rejected'::text, 'withdrawn'::text, 'expired'::text])))
);


ALTER TABLE public.change_proposals OWNER TO postgres;

ALTER TABLE public.change_proposals
    ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid() NOT NULL,
    ADD COLUMN IF NOT EXISTS entity_type text NOT NULL,
    ADD COLUMN IF NOT EXISTS entity_id uuid NOT NULL,
    ADD COLUMN IF NOT EXISTS patch jsonb NOT NULL,
    ADD COLUMN IF NOT EXISTS rationale text,
    ADD COLUMN IF NOT EXISTS status text DEFAULT 'open'::text NOT NULL,
    ADD COLUMN IF NOT EXISTS proposed_by uuid DEFAULT auth.uid() NOT NULL,
    ADD COLUMN IF NOT EXISTS proposed_at timestamp with time zone DEFAULT now() NOT NULL,
    ADD COLUMN IF NOT EXISTS decided_by uuid,
    ADD COLUMN IF NOT EXISTS decided_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS decision_reason text,
    ADD COLUMN IF NOT EXISTS applied_trail_id bigint,
    ADD COLUMN IF NOT EXISTS proposed_by_email text;

ALTER TABLE public.change_proposals
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN entity_type DROP DEFAULT,
    ALTER COLUMN entity_id DROP DEFAULT,
    ALTER COLUMN patch DROP DEFAULT,
    ALTER COLUMN rationale DROP DEFAULT,
    ALTER COLUMN status SET DEFAULT 'open'::text,
    ALTER COLUMN proposed_by SET DEFAULT auth.uid(),
    ALTER COLUMN proposed_at SET DEFAULT now(),
    ALTER COLUMN decided_by DROP DEFAULT,
    ALTER COLUMN decided_at DROP DEFAULT,
    ALTER COLUMN decision_reason DROP DEFAULT,
    ALTER COLUMN applied_trail_id DROP DEFAULT,
    ALTER COLUMN proposed_by_email DROP DEFAULT;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'change_proposals_closed_rows_are_decided'
                AND conrelid = 'public.change_proposals'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((status = ''open''::text) OR (decided_at IS NOT NULL)))') THEN
    ALTER TABLE public.change_proposals DROP CONSTRAINT change_proposals_closed_rows_are_decided;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'change_proposals_closed_rows_are_decided'
                    AND conrelid = 'public.change_proposals'::regclass) THEN
    ALTER TABLE public.change_proposals
        ADD CONSTRAINT change_proposals_closed_rows_are_decided CHECK (((status = 'open'::text) OR (decided_at IS NOT NULL)));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'change_proposals_entity_type_known'
                AND conrelid = 'public.change_proposals'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((entity_type = ANY (ARRAY[''devices''::text, ''device_nameplate''::text, ''areas''::text, ''cells''::text, ''gateways''::text, ''schemas''::text])))') THEN
    ALTER TABLE public.change_proposals DROP CONSTRAINT change_proposals_entity_type_known;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'change_proposals_entity_type_known'
                    AND conrelid = 'public.change_proposals'::regclass) THEN
    ALTER TABLE public.change_proposals
        ADD CONSTRAINT change_proposals_entity_type_known CHECK ((entity_type = ANY (ARRAY['devices'::text, 'device_nameplate'::text, 'areas'::text, 'cells'::text, 'gateways'::text, 'schemas'::text])));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'change_proposals_open_rows_are_undecided'
                AND conrelid = 'public.change_proposals'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((status <> ''open''::text) OR ((decided_by IS NULL) AND (decided_at IS NULL) AND (decision_reason IS NULL) AND (applied_trail_id IS NULL))))') THEN
    ALTER TABLE public.change_proposals DROP CONSTRAINT change_proposals_open_rows_are_undecided;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'change_proposals_open_rows_are_undecided'
                    AND conrelid = 'public.change_proposals'::regclass) THEN
    ALTER TABLE public.change_proposals
        ADD CONSTRAINT change_proposals_open_rows_are_undecided CHECK (((status <> 'open'::text) OR ((decided_by IS NULL) AND (decided_at IS NULL) AND (decision_reason IS NULL) AND (applied_trail_id IS NULL))));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'change_proposals_patch_is_an_object'
                AND conrelid = 'public.change_proposals'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((jsonb_typeof(patch) = ''object''::text) AND (patch <> ''{}''::jsonb)))') THEN
    ALTER TABLE public.change_proposals DROP CONSTRAINT change_proposals_patch_is_an_object;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'change_proposals_patch_is_an_object'
                    AND conrelid = 'public.change_proposals'::regclass) THEN
    ALTER TABLE public.change_proposals
        ADD CONSTRAINT change_proposals_patch_is_an_object CHECK (((jsonb_typeof(patch) = 'object'::text) AND (patch <> '{}'::jsonb)));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'change_proposals_rejection_carries_a_reason'
                AND conrelid = 'public.change_proposals'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((status <> ''rejected''::text) OR ((decision_reason IS NOT NULL) AND (btrim(decision_reason) <> ''''::text))))') THEN
    ALTER TABLE public.change_proposals DROP CONSTRAINT change_proposals_rejection_carries_a_reason;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'change_proposals_rejection_carries_a_reason'
                    AND conrelid = 'public.change_proposals'::regclass) THEN
    ALTER TABLE public.change_proposals
        ADD CONSTRAINT change_proposals_rejection_carries_a_reason CHECK (((status <> 'rejected'::text) OR ((decision_reason IS NOT NULL) AND (btrim(decision_reason) <> ''::text))));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'change_proposals_status_known'
                AND conrelid = 'public.change_proposals'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((status = ANY (ARRAY[''open''::text, ''applied''::text, ''rejected''::text, ''withdrawn''::text, ''expired''::text])))') THEN
    ALTER TABLE public.change_proposals DROP CONSTRAINT change_proposals_status_known;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'change_proposals_status_known'
                    AND conrelid = 'public.change_proposals'::regclass) THEN
    ALTER TABLE public.change_proposals
        ADD CONSTRAINT change_proposals_status_known CHECK ((status = ANY (ARRAY['open'::text, 'applied'::text, 'rejected'::text, 'withdrawn'::text, 'expired'::text])));
  END IF;
END $c$;

--

-- TABLE change_proposals :: COMMENT
COMMENT ON TABLE public.change_proposals IS 'A change somebody proposed but may not apply. An Operator inserts; an Administrator or Shopfloor_Manager approves, and the approval is the write. The asset write policies are unchanged by this table existing.';

--

-- COLUMN change_proposals.entity_type :: COMMENT
COMMENT ON COLUMN public.change_proposals.entity_type IS 'The TARGET TABLE, so this speaks the same vocabulary as audit_trail.entity_type and audit_domain_for().';

--

-- COLUMN change_proposals.patch :: COMMENT
COMMENT ON COLUMN public.change_proposals.patch IS 'Column -> new value, for the columns proposable_columns() admits. A PATCH rather than a whole row: two proposals touching different fields of one asset both apply, where a row snapshot would silently revert whatever changed underneath it between proposal and approval.';

--

-- COLUMN change_proposals.rationale :: COMMENT
COMMENT ON COLUMN public.change_proposals.rationale IS 'Why the proposer is asking. Operator-authored free text, pruned with the row under proposals.retention_days.';

--

-- COLUMN change_proposals.decided_by :: COMMENT
COMMENT ON COLUMN public.change_proposals.decided_by IS 'Who approved or rejected. NULL on an expired row: the timer is not a person, and naming one would be a false attribution.';

--

-- COLUMN change_proposals.decision_reason :: COMMENT
COMMENT ON COLUMN public.change_proposals.decision_reason IS 'Required to reject. The only thing an operator receives other than a refusal, and what stops the next attempt being identical.';

--

-- COLUMN change_proposals.applied_trail_id :: COMMENT
COMMENT ON COLUMN public.change_proposals.applied_trail_id IS 'The audit_trail row the approval wrote, so the queue entry and the audit trail can be read from either end.';

--

-- COLUMN change_proposals.proposed_by_email :: COMMENT
COMMENT ON COLUMN public.change_proposals.proposed_by_email IS 'The proposer''s email, taken from the signed access token at INSERT and never from the request body. A readable label beside proposed_by, which stays the key everything resolves through. NULL when the token carried no email.';

--

-- devices :: TABLE
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
    area_id uuid,
    CONSTRAINT devices_area_wide_has_no_cell CHECK (((location_scope <> 'area_wide'::text) OR (cell_id IS NULL))),
    CONSTRAINT devices_area_wide_names_its_area CHECK (((location_scope = 'area_wide'::text) = (area_id IS NOT NULL))),
    CONSTRAINT devices_conformance_policy_valid CHECK ((conformance_policy = ANY (ARRAY['audit'::text, 'enforce'::text]))),
    CONSTRAINT devices_location_scope_valid CHECK ((location_scope = ANY (ARRAY['cell'::text, 'site_wide'::text, 'area_wide'::text]))),
    CONSTRAINT devices_model_3d_path_shape CHECK (((model_3d_path IS NULL) OR (model_3d_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]+\.(gltf|glb|obj|stl)$'::text))),
    CONSTRAINT devices_online_implies_born CHECK (((status IS DISTINCT FROM 'ONLINE'::text) OR (first_dbirth_at IS NOT NULL))),
    CONSTRAINT devices_shadow_of_is_not_self CHECK (((shadow_of IS NULL) OR (shadow_of <> id))),
    CONSTRAINT devices_site_wide_has_no_cell CHECK (((location_scope <> 'site_wide'::text) OR (cell_id IS NULL)))
);

ALTER TABLE ONLY public.devices REPLICA IDENTITY FULL;


ALTER TABLE public.devices OWNER TO postgres;

ALTER TABLE public.devices
    ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid() NOT NULL,
    ADD COLUMN IF NOT EXISTS name text NOT NULL,
    ADD COLUMN IF NOT EXISTS gateway_id uuid,
    ADD COLUMN IF NOT EXISTS status text DEFAULT 'OFFLINE'::text,
    ADD COLUMN IF NOT EXISTS is_quarantined boolean DEFAULT false,
    ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now(),
    ADD COLUMN IF NOT EXISTS is_archived boolean DEFAULT false,
    ADD COLUMN IF NOT EXISTS archived_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS auto_delete_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS asset_type text,
    ADD COLUMN IF NOT EXISTS connection_method text,
    ADD COLUMN IF NOT EXISTS first_dbirth_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS schema_id uuid,
    ADD COLUMN IF NOT EXISTS sparkplug_id text GENERATED ALWAYS AS (('dev'::text || substr(encode(uuid_send(id), 'hex'::text), 1, 21))) STORED,
    ADD COLUMN IF NOT EXISTS reported_identity text,
    ADD COLUMN IF NOT EXISTS quarantine_reason text,
    ADD COLUMN IF NOT EXISTS identity_source text,
    ADD COLUMN IF NOT EXISTS last_birth_metrics text[],
    ADD COLUMN IF NOT EXISTS last_birth_metrics_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS model_3d_path text,
    ADD COLUMN IF NOT EXISTS cell_id uuid,
    ADD COLUMN IF NOT EXISTS location_scope text DEFAULT 'cell'::text NOT NULL,
    ADD COLUMN IF NOT EXISTS description text,
    ADD COLUMN IF NOT EXISTS conformance_policy text DEFAULT 'audit'::text NOT NULL,
    ADD COLUMN IF NOT EXISTS shadow_of uuid,
    ADD COLUMN IF NOT EXISTS area_id uuid;

ALTER TABLE public.devices
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN name DROP DEFAULT,
    ALTER COLUMN gateway_id DROP DEFAULT,
    ALTER COLUMN status SET DEFAULT 'OFFLINE'::text,
    ALTER COLUMN is_quarantined SET DEFAULT false,
    ALTER COLUMN created_at SET DEFAULT now(),
    ALTER COLUMN is_archived SET DEFAULT false,
    ALTER COLUMN archived_at DROP DEFAULT,
    ALTER COLUMN auto_delete_at DROP DEFAULT,
    ALTER COLUMN asset_type DROP DEFAULT,
    ALTER COLUMN connection_method DROP DEFAULT,
    ALTER COLUMN first_dbirth_at DROP DEFAULT,
    ALTER COLUMN schema_id DROP DEFAULT,
    ALTER COLUMN reported_identity DROP DEFAULT,
    ALTER COLUMN quarantine_reason DROP DEFAULT,
    ALTER COLUMN identity_source DROP DEFAULT,
    ALTER COLUMN last_birth_metrics DROP DEFAULT,
    ALTER COLUMN last_birth_metrics_at DROP DEFAULT,
    ALTER COLUMN model_3d_path DROP DEFAULT,
    ALTER COLUMN cell_id DROP DEFAULT,
    ALTER COLUMN location_scope SET DEFAULT 'cell'::text,
    ALTER COLUMN description DROP DEFAULT,
    ALTER COLUMN conformance_policy SET DEFAULT 'audit'::text,
    ALTER COLUMN shadow_of DROP DEFAULT,
    ALTER COLUMN area_id DROP DEFAULT;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'devices_area_wide_has_no_cell'
                AND conrelid = 'public.devices'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((location_scope <> ''area_wide''::text) OR (cell_id IS NULL)))') THEN
    ALTER TABLE public.devices DROP CONSTRAINT devices_area_wide_has_no_cell;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'devices_area_wide_has_no_cell'
                    AND conrelid = 'public.devices'::regclass) THEN
    ALTER TABLE public.devices
        ADD CONSTRAINT devices_area_wide_has_no_cell CHECK (((location_scope <> 'area_wide'::text) OR (cell_id IS NULL)));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'devices_area_wide_names_its_area'
                AND conrelid = 'public.devices'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((location_scope = ''area_wide''::text) = (area_id IS NOT NULL)))') THEN
    ALTER TABLE public.devices DROP CONSTRAINT devices_area_wide_names_its_area;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'devices_area_wide_names_its_area'
                    AND conrelid = 'public.devices'::regclass) THEN
    ALTER TABLE public.devices
        ADD CONSTRAINT devices_area_wide_names_its_area CHECK (((location_scope = 'area_wide'::text) = (area_id IS NOT NULL)));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'devices_conformance_policy_valid'
                AND conrelid = 'public.devices'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((conformance_policy = ANY (ARRAY[''audit''::text, ''enforce''::text])))') THEN
    ALTER TABLE public.devices DROP CONSTRAINT devices_conformance_policy_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'devices_conformance_policy_valid'
                    AND conrelid = 'public.devices'::regclass) THEN
    ALTER TABLE public.devices
        ADD CONSTRAINT devices_conformance_policy_valid CHECK ((conformance_policy = ANY (ARRAY['audit'::text, 'enforce'::text])));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'devices_location_scope_valid'
                AND conrelid = 'public.devices'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((location_scope = ANY (ARRAY[''cell''::text, ''site_wide''::text, ''area_wide''::text])))') THEN
    ALTER TABLE public.devices DROP CONSTRAINT devices_location_scope_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'devices_location_scope_valid'
                    AND conrelid = 'public.devices'::regclass) THEN
    ALTER TABLE public.devices
        ADD CONSTRAINT devices_location_scope_valid CHECK ((location_scope = ANY (ARRAY['cell'::text, 'site_wide'::text, 'area_wide'::text])));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'devices_model_3d_path_shape'
                AND conrelid = 'public.devices'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((model_3d_path IS NULL) OR (model_3d_path ~* ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]+\.(gltf|glb|obj|stl)$''::text)))') THEN
    ALTER TABLE public.devices DROP CONSTRAINT devices_model_3d_path_shape;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'devices_model_3d_path_shape'
                    AND conrelid = 'public.devices'::regclass) THEN
    ALTER TABLE public.devices
        ADD CONSTRAINT devices_model_3d_path_shape CHECK (((model_3d_path IS NULL) OR (model_3d_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]+\.(gltf|glb|obj|stl)$'::text)));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'devices_online_implies_born'
                AND conrelid = 'public.devices'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((status IS DISTINCT FROM ''ONLINE''::text) OR (first_dbirth_at IS NOT NULL)))') THEN
    ALTER TABLE public.devices DROP CONSTRAINT devices_online_implies_born;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'devices_online_implies_born'
                    AND conrelid = 'public.devices'::regclass) THEN
    ALTER TABLE public.devices
        ADD CONSTRAINT devices_online_implies_born CHECK (((status IS DISTINCT FROM 'ONLINE'::text) OR (first_dbirth_at IS NOT NULL)));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'devices_shadow_of_is_not_self'
                AND conrelid = 'public.devices'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((shadow_of IS NULL) OR (shadow_of <> id)))') THEN
    ALTER TABLE public.devices DROP CONSTRAINT devices_shadow_of_is_not_self;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'devices_shadow_of_is_not_self'
                    AND conrelid = 'public.devices'::regclass) THEN
    ALTER TABLE public.devices
        ADD CONSTRAINT devices_shadow_of_is_not_self CHECK (((shadow_of IS NULL) OR (shadow_of <> id)));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'devices_site_wide_has_no_cell'
                AND conrelid = 'public.devices'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((location_scope <> ''site_wide''::text) OR (cell_id IS NULL)))') THEN
    ALTER TABLE public.devices DROP CONSTRAINT devices_site_wide_has_no_cell;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'devices_site_wide_has_no_cell'
                    AND conrelid = 'public.devices'::regclass) THEN
    ALTER TABLE public.devices
        ADD CONSTRAINT devices_site_wide_has_no_cell CHECK (((location_scope <> 'site_wide'::text) OR (cell_id IS NULL)));
  END IF;
END $c$;

--

-- COLUMN devices.status :: COMMENT
COMMENT ON COLUMN public.devices.status IS 'What the platform has OBSERVED of this device, never what an operator intends: ONLINE or OFFLINE. Written only by ingestion -- DBIRTH sets ONLINE, as does DDATA from a device the liveness watchdog timed out; DDEATH, its node''s NDEATH and the watchdog set OFFLINE -- and left at its OFFLINE default for a device registered but not yet connected. devices_online_implies_born refuses ONLINE without a first_dbirth_at. A device provisioned and never heard from is OFFLINE with a null first_dbirth_at, which the dashboard draws as awaiting its first birth rather than as a machine that went away.';

--

-- COLUMN devices.sparkplug_id :: COMMENT
COMMENT ON COLUMN public.devices.sparkplug_id IS 'Immutable Sparkplug B device id, derived from the primary key. This is what appears in the MQTT topic and keys telemetry in TimescaleDB and birth parameters in asset_config.';

--

-- COLUMN devices.reported_identity :: COMMENT
COMMENT ON COLUMN public.devices.reported_identity IS 'The Sparkplug B device id this device actually published under, when it differs from the platform-issued sparkplug_id. NULL means the device uses its issued id.';

--

-- COLUMN devices.quarantine_reason :: COMMENT
COMMENT ON COLUMN public.devices.quarantine_reason IS 'Why this device is in the quarantine queue, as "<CODE>" or "<CODE>: <detail>": UNKNOWN_DEVICE (well-formed id, never seen), MALFORMED_IDENTITY (id failed the 24-char gwy/dev format check), IDENTITY_MISMATCH (topic device id and Asset_ID payload metric disagreed), or GATEWAY_MISMATCH (announced by an edge node it is not bound to, or one that is unregistered or archived). Enforced by is_valid_quarantine_reason() (0047), not by a CHECK -- the detail suffix is free text and only the code is pinned.';

--

-- COLUMN devices.identity_source :: COMMENT
COMMENT ON COLUMN public.devices.identity_source IS 'How ingestion last resolved this device: ''sparkplug_id'' (its issued id), ''reported_identity'' (its own id, recorded at discovery) or ''instance_uuid'' (its Factory+ Instance_UUID, which is devices.id).';

--

-- COLUMN devices.model_3d_path :: COMMENT
COMMENT ON COLUMN public.devices.model_3d_path IS 'Object key of this device''s 3D model within the asset-3d-models bucket (<device_uuid>/<filename>). Never a URL -- the public URL is composed at export time from a configurable base.';

--

-- COLUMN devices.cell_id :: COMMENT
COMMENT ON COLUMN public.devices.cell_id IS 'Explicit location override. NULL means inherit from gateways.cell_id -- deliberately no default, since an explicit value wins over inheritance and a default would make inheritance unreachable. Resolve through public.device_locations, never by reading this column alone.';

--

-- COLUMN devices.location_scope :: COMMENT
COMMENT ON COLUMN public.devices.location_scope IS '''cell'' (located in, or awaiting, a cell), ''area_wide'' (asserted to have no single cell within one area -- a building''s BMS) or ''site_wide'' (asserted to have no single area -- a campus-wide asset). Distinct from cell_id IS NULL, which means undecided.';

--

-- COLUMN devices.description :: COMMENT
COMMENT ON COLUMN public.devices.description IS 'Optional operator note. Free text, carries no semantics, and is read by nothing -- typed identification belongs in device_nameplate.';

--

-- COLUMN devices.conformance_policy :: COMMENT
COMMENT ON COLUMN public.devices.conformance_policy IS '''audit'' (default) evaluates every DDATA metric against the device''s attached schemas and records what fails, writing the sample regardless -- the behaviour since 0026. ''enforce'' additionally DROPS a metric whose value contradicts a constraint its bound schema states. Per device and not per daemon: enforcement is a judgement about one asset''s schema being trustworthy enough to reject against, and a fleet is not uniform. An unmodelled metric is dropped only when a schema closes the set with additionalProperties: false.';

--

-- COLUMN devices.shadow_of :: COMMENT
COMMENT ON COLUMN public.devices.shadow_of IS 'For a shadow device: the real machine whose recordings this lane replays. NULL for every ordinary device. This is PROVENANCE, not a copy of a gateway flag -- whether a device is synthetic still derives from gateways.is_shadow / is_simulated (see 0052 and 0059), and this stores the one thing the gateway cannot know. Set only by ensure_shadow_devices().';

--

-- COLUMN devices.area_id :: COMMENT
COMMENT ON COLUMN public.devices.area_id IS 'Populated exactly when location_scope = ''area_wide''. A cell-scoped device derives its area through its effective cell (public.device_locations) and stores none; a site-wide device has none.';

--

-- CONSTRAINT devices_online_implies_born ON devices :: COMMENT
COMMENT ON CONSTRAINT devices_online_implies_born ON public.devices IS 'ONLINE is earned, never asserted: a device cannot currently be born without ever having been born. first_dbirth_at is write-once and set by ingestion at the first DBIRTH, so this refuses a row claiming to be running before the platform has heard from it -- the defect 0119 corrects, where the dashboard drew a green chip for a machine that had never connected.';

--

-- device_locations :: VIEW
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
            WHEN (d.location_scope = 'area_wide'::text) THEN NULL::uuid
            ELSE COALESCE(d.cell_id, g.cell_id)
        END AS effective_cell_id,
        CASE
            WHEN COALESCE(g.is_shadow, false) THEN 'shadow'::text
            WHEN COALESCE(g.is_simulated, false) THEN 'simulated'::text
            WHEN (d.location_scope = 'site_wide'::text) THEN 'site_wide'::text
            WHEN (d.location_scope = 'area_wide'::text) THEN 'area_wide'::text
            WHEN (d.cell_id IS NOT NULL) THEN 'explicit'::text
            WHEN (g.cell_id IS NOT NULL) THEN 'inherited'::text
            ELSE 'unassigned'::text
        END AS location_source,
    ((d.location_scope = 'cell'::text) AND (d.cell_id IS NOT NULL) AND (g.cell_id IS NOT NULL) AND (d.cell_id <> g.cell_id)) AS cell_mismatch,
    d.area_id AS explicit_area_id,
        CASE
            WHEN COALESCE(g.is_shadow, false) THEN NULL::uuid
            WHEN COALESCE(g.is_simulated, false) THEN NULL::uuid
            WHEN (d.location_scope = 'site_wide'::text) THEN NULL::uuid
            WHEN (d.location_scope = 'area_wide'::text) THEN d.area_id
            ELSE c.area_id
        END AS effective_area_id
   FROM ((public.devices d
     LEFT JOIN public.gateways g ON ((g.id = d.gateway_id)))
     LEFT JOIN public.cells c ON ((c.id = COALESCE(d.cell_id, g.cell_id))));


ALTER VIEW public.device_locations OWNER TO postgres;

--

-- VIEW device_locations :: COMMENT
COMMENT ON VIEW public.device_locations IS 'Effective cell and area per device, and which arm answered. Precedence: shadow (a replay lane behind a playback gateway) and simulated (synthetic telemetry) resolve to NO cell and NO area and take priority over everything else; then site-wide assets, which have neither by assertion; then area-wide assets, which have their own area and no cell; then explicit devices.cell_id, then inherited gateways.cell_id, else unassigned. A cell-scoped device''s area is its effective cell''s. The first two are the gateway''s flags and are inherited -- devices store no copy. Mirrors frontend/src/utils/cellResolution.js -- keep the two in step. Derived at read time and never stored, so flipping a gateway''s flag or cell reclassifies its devices immediately.';

--

-- device_nameplate :: TABLE
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


ALTER TABLE public.device_nameplate OWNER TO postgres;

ALTER TABLE public.device_nameplate
    ADD COLUMN IF NOT EXISTS device_id uuid NOT NULL,
    ADD COLUMN IF NOT EXISTS manufacturer_name text,
    ADD COLUMN IF NOT EXISTS manufacturer_product_designation text,
    ADD COLUMN IF NOT EXISTS manufacturer_product_type text,
    ADD COLUMN IF NOT EXISTS serial_number text,
    ADD COLUMN IF NOT EXISTS year_of_construction text,
    ADD COLUMN IF NOT EXISTS date_of_manufacture date,
    ADD COLUMN IF NOT EXISTS hardware_version text,
    ADD COLUMN IF NOT EXISTS firmware_version text,
    ADD COLUMN IF NOT EXISTS software_version text,
    ADD COLUMN IF NOT EXISTS country_of_origin text,
    ADD COLUMN IF NOT EXISTS uri_of_the_product text,
    ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now() NOT NULL,
    ADD COLUMN IF NOT EXISTS updated_by uuid;

ALTER TABLE public.device_nameplate
    ALTER COLUMN device_id DROP DEFAULT,
    ALTER COLUMN manufacturer_name DROP DEFAULT,
    ALTER COLUMN manufacturer_product_designation DROP DEFAULT,
    ALTER COLUMN manufacturer_product_type DROP DEFAULT,
    ALTER COLUMN serial_number DROP DEFAULT,
    ALTER COLUMN year_of_construction DROP DEFAULT,
    ALTER COLUMN date_of_manufacture DROP DEFAULT,
    ALTER COLUMN hardware_version DROP DEFAULT,
    ALTER COLUMN firmware_version DROP DEFAULT,
    ALTER COLUMN software_version DROP DEFAULT,
    ALTER COLUMN country_of_origin DROP DEFAULT,
    ALTER COLUMN uri_of_the_product DROP DEFAULT,
    ALTER COLUMN updated_at SET DEFAULT now(),
    ALTER COLUMN updated_by DROP DEFAULT;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'device_nameplate_uri_shape'
                AND conrelid = 'public.device_nameplate'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((uri_of_the_product IS NULL) OR (uri_of_the_product ~* ''^[a-z][a-z0-9+.-]*:''::text)))') THEN
    ALTER TABLE public.device_nameplate DROP CONSTRAINT device_nameplate_uri_shape;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'device_nameplate_uri_shape'
                    AND conrelid = 'public.device_nameplate'::regclass) THEN
    ALTER TABLE public.device_nameplate
        ADD CONSTRAINT device_nameplate_uri_shape CHECK (((uri_of_the_product IS NULL) OR (uri_of_the_product ~* '^[a-z][a-z0-9+.-]*:'::text)));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'device_nameplate_year_shape'
                AND conrelid = 'public.device_nameplate'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((year_of_construction IS NULL) OR (year_of_construction ~ ''^[0-9]{4}$''::text)))') THEN
    ALTER TABLE public.device_nameplate DROP CONSTRAINT device_nameplate_year_shape;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'device_nameplate_year_shape'
                    AND conrelid = 'public.device_nameplate'::regclass) THEN
    ALTER TABLE public.device_nameplate
        ADD CONSTRAINT device_nameplate_year_shape CHECK (((year_of_construction IS NULL) OR (year_of_construction ~ '^[0-9]{4}$'::text)));
  END IF;
END $c$;

--

-- TABLE device_nameplate :: COMMENT
COMMENT ON TABLE public.device_nameplate IS 'Operator-supplied IDTA 02006 Digital Nameplate data, one row per device. The FALLBACK source: where a device publishes its own identification as birth metrics (OPC 40001 Machinery Manufacturer, SerialNumber, YearOfConstruction), the exporter prefers what the device said. Deliberately not in asset_config, which ingestion overwrites from every DBIRTH.';

--

-- COLUMN device_nameplate.updated_by :: COMMENT
COMMENT ON COLUMN public.device_nameplate.updated_by IS 'Who last edited this nameplate. A nameplate is an assertion about an asset, so who made it is part of the record -- the same reason audit_trail exists.';

--

-- device_submodels :: TABLE
CREATE TABLE IF NOT EXISTS public.device_submodels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    device_id uuid NOT NULL,
    schema_id uuid NOT NULL,
    submodel_key text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT device_submodels_key_is_id_short CHECK (((submodel_key IS NULL) OR (submodel_key ~ '^[A-Za-z_][A-Za-z0-9_]*$'::text)))
);


ALTER TABLE public.device_submodels OWNER TO postgres;

ALTER TABLE public.device_submodels
    ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid() NOT NULL,
    ADD COLUMN IF NOT EXISTS device_id uuid NOT NULL,
    ADD COLUMN IF NOT EXISTS schema_id uuid NOT NULL,
    ADD COLUMN IF NOT EXISTS submodel_key text,
    ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now();

ALTER TABLE public.device_submodels
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN device_id DROP DEFAULT,
    ALTER COLUMN schema_id DROP DEFAULT,
    ALTER COLUMN submodel_key DROP DEFAULT,
    ALTER COLUMN created_at SET DEFAULT now();

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'device_submodels_key_is_id_short'
                AND conrelid = 'public.device_submodels'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((submodel_key IS NULL) OR (submodel_key ~ ''^[A-Za-z_][A-Za-z0-9_]*$''::text)))') THEN
    ALTER TABLE public.device_submodels DROP CONSTRAINT device_submodels_key_is_id_short;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'device_submodels_key_is_id_short'
                    AND conrelid = 'public.device_submodels'::regclass) THEN
    ALTER TABLE public.device_submodels
        ADD CONSTRAINT device_submodels_key_is_id_short CHECK (((submodel_key IS NULL) OR (submodel_key ~ '^[A-Za-z_][A-Za-z0-9_]*$'::text)));
  END IF;
END $c$;

--

-- TABLE device_submodels :: COMMENT
COMMENT ON TABLE public.device_submodels IS 'Submodel attachments written through the API, one AAS Submodel each. The dashboard attaches its one schema through devices.schema_id; device_schemas reads both.';

--

-- device_schemas :: VIEW
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


ALTER VIEW public.device_schemas OWNER TO postgres;

--

-- VIEW device_schemas :: COMMENT
COMMENT ON VIEW public.device_schemas IS 'Every schema attached to a device: its device_submodels rows, or devices.schema_id (the dashboard''s attachment) for a device that has none.';

--

-- directory_liveness_probe :: TABLE
CREATE TABLE IF NOT EXISTS public.directory_liveness_probe (
    id boolean DEFAULT true NOT NULL,
    request_id bigint,
    requested_at timestamp with time zone,
    CONSTRAINT directory_liveness_probe_id_check CHECK (id)
);


ALTER TABLE public.directory_liveness_probe OWNER TO postgres;

ALTER TABLE public.directory_liveness_probe
    ADD COLUMN IF NOT EXISTS id boolean DEFAULT true NOT NULL,
    ADD COLUMN IF NOT EXISTS request_id bigint,
    ADD COLUMN IF NOT EXISTS requested_at timestamp with time zone;

ALTER TABLE public.directory_liveness_probe
    ALTER COLUMN id SET DEFAULT true,
    ALTER COLUMN request_id DROP DEFAULT,
    ALTER COLUMN requested_at DROP DEFAULT;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'directory_liveness_probe_id_check'
                AND conrelid = 'public.directory_liveness_probe'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (id)') THEN
    ALTER TABLE public.directory_liveness_probe DROP CONSTRAINT directory_liveness_probe_id_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'directory_liveness_probe_id_check'
                    AND conrelid = 'public.directory_liveness_probe'::regclass) THEN
    ALTER TABLE public.directory_liveness_probe
        ADD CONSTRAINT directory_liveness_probe_id_check CHECK (id);
  END IF;
END $c$;

--

-- TABLE directory_liveness_probe :: COMMENT
COMMENT ON TABLE public.directory_liveness_probe IS 'The single in-flight pg_net request id for the Prometheus liveness probe. One row by CHECK (id), because two concurrent probes would race to write the same directory rows from different observations.';

--

-- directory_services :: TABLE
CREATE TABLE IF NOT EXISTS public.directory_services (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    service_name text NOT NULL,
    service_type text NOT NULL,
    endpoint_url text NOT NULL,
    status text DEFAULT 'UNKNOWN'::text NOT NULL,
    last_heartbeat timestamp with time zone DEFAULT now(),
    registered_schema_id uuid,
    exposure text DEFAULT 'UNKNOWN'::text NOT NULL,
    image text,
    CONSTRAINT directory_services_exposure_valid CHECK ((exposure = ANY (ARRAY['NETWORK'::text, 'HOST'::text, 'INTERNAL'::text, 'UNKNOWN'::text]))),
    CONSTRAINT directory_services_status_valid CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'DOWN'::text, 'UNKNOWN'::text])))
);


ALTER TABLE public.directory_services OWNER TO postgres;

ALTER TABLE public.directory_services
    ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid() NOT NULL,
    ADD COLUMN IF NOT EXISTS service_name text NOT NULL,
    ADD COLUMN IF NOT EXISTS service_type text NOT NULL,
    ADD COLUMN IF NOT EXISTS endpoint_url text NOT NULL,
    ADD COLUMN IF NOT EXISTS status text DEFAULT 'UNKNOWN'::text NOT NULL,
    ADD COLUMN IF NOT EXISTS last_heartbeat timestamp with time zone DEFAULT now(),
    ADD COLUMN IF NOT EXISTS registered_schema_id uuid,
    ADD COLUMN IF NOT EXISTS exposure text DEFAULT 'UNKNOWN'::text NOT NULL,
    ADD COLUMN IF NOT EXISTS image text;

ALTER TABLE public.directory_services
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN service_name DROP DEFAULT,
    ALTER COLUMN service_type DROP DEFAULT,
    ALTER COLUMN endpoint_url DROP DEFAULT,
    ALTER COLUMN status SET DEFAULT 'UNKNOWN'::text,
    ALTER COLUMN last_heartbeat SET DEFAULT now(),
    ALTER COLUMN registered_schema_id DROP DEFAULT,
    ALTER COLUMN exposure SET DEFAULT 'UNKNOWN'::text,
    ALTER COLUMN image DROP DEFAULT;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'directory_services_exposure_valid'
                AND conrelid = 'public.directory_services'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((exposure = ANY (ARRAY[''NETWORK''::text, ''HOST''::text, ''INTERNAL''::text, ''UNKNOWN''::text])))') THEN
    ALTER TABLE public.directory_services DROP CONSTRAINT directory_services_exposure_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'directory_services_exposure_valid'
                    AND conrelid = 'public.directory_services'::regclass) THEN
    ALTER TABLE public.directory_services
        ADD CONSTRAINT directory_services_exposure_valid CHECK ((exposure = ANY (ARRAY['NETWORK'::text, 'HOST'::text, 'INTERNAL'::text, 'UNKNOWN'::text])));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'directory_services_status_valid'
                AND conrelid = 'public.directory_services'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((status = ANY (ARRAY[''ACTIVE''::text, ''DOWN''::text, ''UNKNOWN''::text])))') THEN
    ALTER TABLE public.directory_services DROP CONSTRAINT directory_services_status_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'directory_services_status_valid'
                    AND conrelid = 'public.directory_services'::regclass) THEN
    ALTER TABLE public.directory_services
        ADD CONSTRAINT directory_services_status_valid CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'DOWN'::text, 'UNKNOWN'::text])));
  END IF;
END $c$;

--

-- COLUMN directory_services.status :: COMMENT
COMMENT ON COLUMN public.directory_services.status IS 'Observed liveness: ACTIVE (Prometheus reports up=1), DOWN (up=0), or UNKNOWN (nothing observes this service). Written only by refresh_directory_liveness(). UNKNOWN is not a failure -- nine of the fifteen registered services have no exporter, and saying so is the point.';

--

-- COLUMN directory_services.last_heartbeat :: COMMENT
COMMENT ON COLUMN public.directory_services.last_heartbeat IS 'When this service was last OBSERVED up. NULL whenever status is not ACTIVE, including UNKNOWN: a timestamp on a row nothing probes would imply a freshness it does not have, which is the defect this column had before 0054 -- it held the moment the row was seeded.';

--

-- COLUMN directory_services.exposure :: COMMENT
COMMENT ON COLUMN public.directory_services.exposure IS 'Where this service can be reached FROM, as a property of its port binding rather than of its URL: NETWORK (published on every interface), HOST (bound to 127.0.0.1 -- the deployment host or an SSH tunnel), INTERNAL (no host port; container network only), UNKNOWN (not recorded). Describes the Compose deployment the seed describes; a deployment that publishes differently updates it. Consumed by the Directory page, which combines it with the URL''s own host -- a loopback ADDRESS cannot work from a remote browser however broadly the PORT is published.';

--

-- COLUMN directory_services.image :: COMMENT
COMMENT ON COLUMN public.directory_services.image IS 'The image reference (repository:tag) this release deploys for the service, as the chart renders it. Written by record_directory_images() on every db-init run; NULL when the chart does not deploy the service or nothing has recorded it.';

--

-- forge_sweep_lease :: TABLE
CREATE TABLE IF NOT EXISTS public.forge_sweep_lease (
    id boolean DEFAULT true NOT NULL,
    holder uuid,
    held_until timestamp with time zone DEFAULT '-infinity'::timestamp with time zone NOT NULL,
    requested boolean DEFAULT false NOT NULL,
    CONSTRAINT forge_sweep_lease_one_row CHECK (id)
);


ALTER TABLE public.forge_sweep_lease OWNER TO postgres;

ALTER TABLE public.forge_sweep_lease
    ADD COLUMN IF NOT EXISTS id boolean DEFAULT true NOT NULL,
    ADD COLUMN IF NOT EXISTS holder uuid,
    ADD COLUMN IF NOT EXISTS held_until timestamp with time zone DEFAULT '-infinity'::timestamp with time zone NOT NULL,
    ADD COLUMN IF NOT EXISTS requested boolean DEFAULT false NOT NULL;

ALTER TABLE public.forge_sweep_lease
    ALTER COLUMN id SET DEFAULT true,
    ALTER COLUMN holder DROP DEFAULT,
    ALTER COLUMN held_until SET DEFAULT '-infinity'::timestamp with time zone,
    ALTER COLUMN requested SET DEFAULT false;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'forge_sweep_lease_one_row'
                AND conrelid = 'public.forge_sweep_lease'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (id)') THEN
    ALTER TABLE public.forge_sweep_lease DROP CONSTRAINT forge_sweep_lease_one_row;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'forge_sweep_lease_one_row'
                    AND conrelid = 'public.forge_sweep_lease'::regclass) THEN
    ALTER TABLE public.forge_sweep_lease
        ADD CONSTRAINT forge_sweep_lease_one_row CHECK (id);
  END IF;
END $c$;

--

-- TABLE forge_sweep_lease :: COMMENT
COMMENT ON TABLE public.forge_sweep_lease IS 'The one forge-sweep pass allowed to run. One row by CHECK (id). Moved only by claim_forge_sweep(), renew_forge_sweep() and release_forge_sweep(); readable by service_role.';

--

-- COLUMN forge_sweep_lease.holder :: COMMENT
COMMENT ON COLUMN public.forge_sweep_lease.holder IS 'The id the current claim returned, or null when free. Only this id renews or releases.';

--

-- COLUMN forge_sweep_lease.held_until :: COMMENT
COMMENT ON COLUMN public.forge_sweep_lease.held_until IS 'When the lease lapses and the next claim takes it over. -infinity when free.';

--

-- COLUMN forge_sweep_lease.requested :: COMMENT
COMMENT ON COLUMN public.forge_sweep_lease.requested IS 'A claim was refused since the current pass started. The release then queues one more pass.';

--

-- gateway_enrollment_tokens :: TABLE
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


ALTER TABLE public.gateway_enrollment_tokens OWNER TO postgres;

ALTER TABLE public.gateway_enrollment_tokens
    ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid() NOT NULL,
    ADD COLUMN IF NOT EXISTS gateway_id uuid NOT NULL,
    ADD COLUMN IF NOT EXISTS token_hash text NOT NULL,
    ADD COLUMN IF NOT EXISTS expires_at timestamp with time zone NOT NULL,
    ADD COLUMN IF NOT EXISTS consumed_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now() NOT NULL,
    ADD COLUMN IF NOT EXISTS created_by uuid;

ALTER TABLE public.gateway_enrollment_tokens
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN gateway_id DROP DEFAULT,
    ALTER COLUMN token_hash DROP DEFAULT,
    ALTER COLUMN expires_at DROP DEFAULT,
    ALTER COLUMN consumed_at DROP DEFAULT,
    ALTER COLUMN created_at SET DEFAULT now(),
    ALTER COLUMN created_by DROP DEFAULT;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'gateway_enrollment_tokens_expiry_after_creation'
                AND conrelid = 'public.gateway_enrollment_tokens'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((expires_at > created_at))') THEN
    ALTER TABLE public.gateway_enrollment_tokens DROP CONSTRAINT gateway_enrollment_tokens_expiry_after_creation;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gateway_enrollment_tokens_expiry_after_creation'
                    AND conrelid = 'public.gateway_enrollment_tokens'::regclass) THEN
    ALTER TABLE public.gateway_enrollment_tokens
        ADD CONSTRAINT gateway_enrollment_tokens_expiry_after_creation CHECK ((expires_at > created_at));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'gateway_enrollment_tokens_hash_is_sha256'
                AND conrelid = 'public.gateway_enrollment_tokens'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((token_hash ~ ''^[0-9a-f]{64}$''::text))') THEN
    ALTER TABLE public.gateway_enrollment_tokens DROP CONSTRAINT gateway_enrollment_tokens_hash_is_sha256;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gateway_enrollment_tokens_hash_is_sha256'
                    AND conrelid = 'public.gateway_enrollment_tokens'::regclass) THEN
    ALTER TABLE public.gateway_enrollment_tokens
        ADD CONSTRAINT gateway_enrollment_tokens_hash_is_sha256 CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text));
  END IF;
END $c$;

--

-- TABLE gateway_enrollment_tokens :: COMMENT
COMMENT ON TABLE public.gateway_enrollment_tokens IS 'Single-use, short-lived claims that let a Remote gateway appliance exchange its downloaded bundle for a broker credential exactly once. NOT READABLE BY ANY BROWSER-FACING ROLE -- RLS is enabled with no policy for anon or authenticated, so only service_role (which bypasses RLS) can see it, and only the enroll-gateway edge function holds that key. Deliberately a separate table rather than columns on public.gateways: that table is world-readable to authenticated users, its full row is copied into audit_trail on every write, and public.gateway_status selects g.*.';

--

-- gateway_health :: VIEW
CREATE OR REPLACE VIEW public.gateway_health AS
 SELECT now() AS collected_at,
    sparkplug_id,
    gateway_name,
    live_status,
    is_stale,
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
   FROM public.gateway_health_rows() r(sparkplug_id, gateway_name, live_status, is_stale, heartbeat_age_seconds, health_reported_at, health_age_seconds, uptime_seconds, load_1m, mem_available_bytes, disk_free_bytes, cert_expires_at, cert_expires_in_days, agent_version, flow_hash);


ALTER VIEW public.gateway_health OWNER TO postgres;

--

-- VIEW gateway_health :: COMMENT
COMMENT ON VIEW public.gateway_health IS 'The fleet''s current condition, one row per non-archived gateway. Read by the `supabase` datasource: backs the gateway variable and the panels in the "Gateway Fleet Health" dashboard, and the certificate-expiry alert rule. Current values only -- the trends are Prometheus gauges exported by the ingestion daemon.';

--

-- gateway_revocation_requests :: TABLE
CREATE TABLE IF NOT EXISTS public.gateway_revocation_requests (
    gateway_id uuid NOT NULL,
    request_id bigint NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.gateway_revocation_requests OWNER TO postgres;

ALTER TABLE public.gateway_revocation_requests
    ADD COLUMN IF NOT EXISTS gateway_id uuid NOT NULL,
    ADD COLUMN IF NOT EXISTS request_id bigint NOT NULL,
    ADD COLUMN IF NOT EXISTS requested_at timestamp with time zone DEFAULT now() NOT NULL;

ALTER TABLE public.gateway_revocation_requests
    ALTER COLUMN gateway_id DROP DEFAULT,
    ALTER COLUMN request_id DROP DEFAULT,
    ALTER COLUMN requested_at SET DEFAULT now();

--

-- TABLE gateway_revocation_requests :: COMMENT
COMMENT ON TABLE public.gateway_revocation_requests IS 'The pg_net request behind each archived gateway''s credential_revoked_at stamp, until the revocation sweep has judged its reply. Written by revoke_gateway_credential(), removed by the sweep; readable by service_role.';

--

-- COLUMN gateway_revocation_requests.request_id :: COMMENT
COMMENT ON COLUMN public.gateway_revocation_requests.request_id IS 'The id net.http_post returned; its reply lands in net._http_response under the same id.';

--

-- COLUMN gateway_revocation_requests.requested_at :: COMMENT
COMMENT ON COLUMN public.gateway_revocation_requests.requested_at IS 'When the request was queued. No reply five minutes on counts as a failed revocation.';

--

-- gateway_status :: VIEW
SELECT public.ensure_gateway_status_view();

--

-- VIEW gateway_status :: COMMENT
COMMENT ON VIEW public.gateway_status IS 'public.gateways with heartbeat staleness derived at read time. Mirrors frontend/src/utils/gatewayStatus.js -- keep the 90s threshold AND the pending-state short-circuit in step. Deliberately a view, not a stored column or a pg_cron writer: writing status would append to the immutable audit_trail table on every sweep and would be stale between ticks. Rebuilt by public.ensure_gateway_status_view() -- call it after adding a gateways column.';

--

-- idta_submodel_templates :: TABLE
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


ALTER TABLE public.idta_submodel_templates OWNER TO postgres;

ALTER TABLE public.idta_submodel_templates
    ADD COLUMN IF NOT EXISTS template_id text NOT NULL,
    ADD COLUMN IF NOT EXISTS template_name text NOT NULL,
    ADD COLUMN IF NOT EXISTS template_version text NOT NULL,
    ADD COLUMN IF NOT EXISTS id_short text NOT NULL,
    ADD COLUMN IF NOT EXISTS semantic_id text NOT NULL,
    ADD COLUMN IF NOT EXISTS semantic_id_type text NOT NULL,
    ADD COLUMN IF NOT EXISTS description text,
    ADD COLUMN IF NOT EXISTS is_mandatory boolean DEFAULT false NOT NULL,
    ADD COLUMN IF NOT EXISTS ordinal integer NOT NULL;

ALTER TABLE public.idta_submodel_templates
    ALTER COLUMN template_id DROP DEFAULT,
    ALTER COLUMN template_name DROP DEFAULT,
    ALTER COLUMN template_version DROP DEFAULT,
    ALTER COLUMN id_short DROP DEFAULT,
    ALTER COLUMN semantic_id DROP DEFAULT,
    ALTER COLUMN semantic_id_type DROP DEFAULT,
    ALTER COLUMN description DROP DEFAULT,
    ALTER COLUMN is_mandatory SET DEFAULT false,
    ALTER COLUMN ordinal DROP DEFAULT;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'idta_submodel_templates_id_short_shape'
                AND conrelid = 'public.idta_submodel_templates'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((id_short ~ ''^[A-Za-z][A-Za-z0-9_]*$''::text))') THEN
    ALTER TABLE public.idta_submodel_templates DROP CONSTRAINT idta_submodel_templates_id_short_shape;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'idta_submodel_templates_id_short_shape'
                    AND conrelid = 'public.idta_submodel_templates'::regclass) THEN
    ALTER TABLE public.idta_submodel_templates
        ADD CONSTRAINT idta_submodel_templates_id_short_shape CHECK ((id_short ~ '^[A-Za-z][A-Za-z0-9_]*$'::text));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'idta_submodel_templates_semantic_id_type_valid'
                AND conrelid = 'public.idta_submodel_templates'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((semantic_id_type = ANY (ARRAY[''IRI''::text, ''IRDI''::text])))') THEN
    ALTER TABLE public.idta_submodel_templates DROP CONSTRAINT idta_submodel_templates_semantic_id_type_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'idta_submodel_templates_semantic_id_type_valid'
                    AND conrelid = 'public.idta_submodel_templates'::regclass) THEN
    ALTER TABLE public.idta_submodel_templates
        ADD CONSTRAINT idta_submodel_templates_semantic_id_type_valid CHECK ((semantic_id_type = ANY (ARRAY['IRI'::text, 'IRDI'::text])));
  END IF;
END $c$;

--

-- TABLE idta_submodel_templates :: COMMENT
COMMENT ON TABLE public.idta_submodel_templates IS 'IDTA Asset Administration Shell submodel-template elements. Reference data, not deployment state -- a row here is an element the template defines, not a value a device holds. semantic_id is issued by IDTA/IEC CDD/ECLASS and must never be minted locally.';

--

-- COLUMN idta_submodel_templates.is_mandatory :: COMMENT
COMMENT ON COLUMN public.idta_submodel_templates.is_mandatory IS 'Whether the template marks this element as mandatory. Recorded so the exporter can report what a shell would need to claim conformance -- it does NOT claim it; see the exporter.';

--

-- COLUMN idta_submodel_templates.ordinal :: COMMENT
COMMENT ON COLUMN public.idta_submodel_templates.ordinal IS 'Order the element appears in the published template, so the exported submodel reads like the specification rather than like a hash map.';

--

-- iso22400_vocabulary :: TABLE
CREATE TABLE IF NOT EXISTS public.iso22400_vocabulary (
    name text NOT NULL,
    kpi_id text NOT NULL,
    description text,
    category text,
    unit text,
    formula text,
    semantic_id text
);


ALTER TABLE public.iso22400_vocabulary OWNER TO postgres;

ALTER TABLE public.iso22400_vocabulary
    ADD COLUMN IF NOT EXISTS name text NOT NULL,
    ADD COLUMN IF NOT EXISTS kpi_id text NOT NULL,
    ADD COLUMN IF NOT EXISTS description text,
    ADD COLUMN IF NOT EXISTS category text,
    ADD COLUMN IF NOT EXISTS unit text,
    ADD COLUMN IF NOT EXISTS formula text,
    ADD COLUMN IF NOT EXISTS semantic_id text;

ALTER TABLE public.iso22400_vocabulary
    ALTER COLUMN name DROP DEFAULT,
    ALTER COLUMN kpi_id DROP DEFAULT,
    ALTER COLUMN description DROP DEFAULT,
    ALTER COLUMN category DROP DEFAULT,
    ALTER COLUMN unit DROP DEFAULT,
    ALTER COLUMN formula DROP DEFAULT,
    ALTER COLUMN semantic_id DROP DEFAULT;

--

-- TABLE iso22400_vocabulary :: COMMENT
COMMENT ON TABLE public.iso22400_vocabulary IS 'ISO 22400-2 key performance indicator definitions. Reference data, not deployment state -- a row here is a KPI the standard defines, not a metric a device publishes.';

--

-- links :: TABLE
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


ALTER TABLE public.links OWNER TO postgres;

ALTER TABLE public.links
    ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid() NOT NULL,
    ADD COLUMN IF NOT EXISTS entity_type text NOT NULL,
    ADD COLUMN IF NOT EXISTS entity_id text NOT NULL,
    ADD COLUMN IF NOT EXISTS display_name text NOT NULL,
    ADD COLUMN IF NOT EXISTS url text NOT NULL,
    ADD COLUMN IF NOT EXISTS link_tag text DEFAULT 'other'::text NOT NULL,
    ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now(),
    ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();

ALTER TABLE public.links
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN entity_type DROP DEFAULT,
    ALTER COLUMN entity_id DROP DEFAULT,
    ALTER COLUMN display_name DROP DEFAULT,
    ALTER COLUMN url DROP DEFAULT,
    ALTER COLUMN link_tag SET DEFAULT 'other'::text,
    ALTER COLUMN created_at SET DEFAULT now(),
    ALTER COLUMN updated_at SET DEFAULT now();

--

-- machine_principals :: TABLE
CREATE TABLE IF NOT EXISTS public.machine_principals (
    principal_id uuid NOT NULL,
    name text NOT NULL,
    purpose text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT machine_principals_name_bounded CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 80))),
    CONSTRAINT machine_principals_purpose_bounded CHECK (((purpose IS NULL) OR (length(purpose) <= 500)))
);


ALTER TABLE public.machine_principals OWNER TO postgres;

ALTER TABLE public.machine_principals
    ADD COLUMN IF NOT EXISTS principal_id uuid NOT NULL,
    ADD COLUMN IF NOT EXISTS name text NOT NULL,
    ADD COLUMN IF NOT EXISTS purpose text,
    ADD COLUMN IF NOT EXISTS created_by uuid,
    ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now() NOT NULL;

ALTER TABLE public.machine_principals
    ALTER COLUMN principal_id DROP DEFAULT,
    ALTER COLUMN name DROP DEFAULT,
    ALTER COLUMN purpose DROP DEFAULT,
    ALTER COLUMN created_by DROP DEFAULT,
    ALTER COLUMN created_at SET DEFAULT now();

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'machine_principals_name_bounded'
                AND conrelid = 'public.machine_principals'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 80)))') THEN
    ALTER TABLE public.machine_principals DROP CONSTRAINT machine_principals_name_bounded;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'machine_principals_name_bounded'
                    AND conrelid = 'public.machine_principals'::regclass) THEN
    ALTER TABLE public.machine_principals
        ADD CONSTRAINT machine_principals_name_bounded CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 80)));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'machine_principals_purpose_bounded'
                AND conrelid = 'public.machine_principals'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((purpose IS NULL) OR (length(purpose) <= 500)))') THEN
    ALTER TABLE public.machine_principals DROP CONSTRAINT machine_principals_purpose_bounded;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'machine_principals_purpose_bounded'
                    AND conrelid = 'public.machine_principals'::regclass) THEN
    ALTER TABLE public.machine_principals
        ADD CONSTRAINT machine_principals_purpose_bounded CHECK (((purpose IS NULL) OR (length(purpose) <= 500)));
  END IF;
END $c$;

--

-- TABLE machine_principals :: COMMENT
COMMENT ON TABLE public.machine_principals IS 'The name and purpose an Administrator gave a machine identity when creating it from the Access Control page. One row per runtime-created principal; the three identities a migration pinned have no row and are named by the dashboard''s own registry. Written only by create_machine_principal(), in the same transaction as the auth.users row it describes.';

--

-- COLUMN machine_principals.name :: COMMENT
COMMENT ON COLUMN public.machine_principals.name IS 'What the page lists the identity as. Unique ignoring case and surrounding whitespace, 1 to 80 characters.';

--

-- COLUMN machine_principals.purpose :: COMMENT
COMMENT ON COLUMN public.machine_principals.purpose IS 'Why the identity exists, in the Administrator''s words, up to 500 characters. Shown beside the name so an unfamiliar principal is safe to leave alone or safe to remove.';

--

-- COLUMN machine_principals.created_by :: COMMENT
COMMENT ON COLUMN public.machine_principals.created_by IS 'The Administrator whose session created the identity. NULL once that account is deleted; the audit trail row keeps the attribution.';

--

-- metric_catalog :: TABLE
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
    CONSTRAINT metric_catalog_semantic_id_type_valid CHECK (((semantic_id_type IS NULL) OR (semantic_id_type = ANY (ARRAY['IRI'::text, 'IRDI'::text]))))
);


ALTER TABLE public.metric_catalog OWNER TO postgres;

ALTER TABLE public.metric_catalog
    ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid() NOT NULL,
    ADD COLUMN IF NOT EXISTS name text NOT NULL,
    ADD COLUMN IF NOT EXISTS datatype integer NOT NULL,
    ADD COLUMN IF NOT EXISTS description text,
    ADD COLUMN IF NOT EXISTS deprecated boolean DEFAULT false NOT NULL,
    ADD COLUMN IF NOT EXISTS superseded_by uuid,
    ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now(),
    ADD COLUMN IF NOT EXISTS metric_group text GENERATED ALWAYS AS (
CASE
    WHEN (strpos(name, '/'::text) > 0) THEN NULLIF(split_part(name, '/'::text, 1), ''::text)
    ELSE NULL::text
END) STORED,
    ADD COLUMN IF NOT EXISTS category text,
    ADD COLUMN IF NOT EXISTS units text,
    ADD COLUMN IF NOT EXISTS sub_type text,
    ADD COLUMN IF NOT EXISTS standard text,
    ADD COLUMN IF NOT EXISTS semantic_id text,
    ADD COLUMN IF NOT EXISTS semantic_id_type text,
    ADD COLUMN IF NOT EXISTS permitted_values text[];

ALTER TABLE public.metric_catalog
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN name DROP DEFAULT,
    ALTER COLUMN datatype DROP DEFAULT,
    ALTER COLUMN description DROP DEFAULT,
    ALTER COLUMN deprecated SET DEFAULT false,
    ALTER COLUMN superseded_by DROP DEFAULT,
    ALTER COLUMN created_at SET DEFAULT now(),
    ALTER COLUMN category DROP DEFAULT,
    ALTER COLUMN units DROP DEFAULT,
    ALTER COLUMN sub_type DROP DEFAULT,
    ALTER COLUMN standard DROP DEFAULT,
    ALTER COLUMN semantic_id DROP DEFAULT,
    ALTER COLUMN semantic_id_type DROP DEFAULT,
    ALTER COLUMN permitted_values DROP DEFAULT;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'metric_catalog_category_valid'
                AND conrelid = 'public.metric_catalog'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((category IS NULL) OR (category = ANY (ARRAY[''SAMPLE''::text, ''EVENT''::text, ''CONDITION''::text]))))') THEN
    ALTER TABLE public.metric_catalog DROP CONSTRAINT metric_catalog_category_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'metric_catalog_category_valid'
                    AND conrelid = 'public.metric_catalog'::regclass) THEN
    ALTER TABLE public.metric_catalog
        ADD CONSTRAINT metric_catalog_category_valid CHECK (((category IS NULL) OR (category = ANY (ARRAY['SAMPLE'::text, 'EVENT'::text, 'CONDITION'::text]))));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'metric_catalog_name_format'
                AND conrelid = 'public.metric_catalog'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((name ~ ''^[A-Za-z0-9_]+(/[A-Za-z0-9_]+)*$''::text))') THEN
    ALTER TABLE public.metric_catalog DROP CONSTRAINT metric_catalog_name_format;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'metric_catalog_name_format'
                    AND conrelid = 'public.metric_catalog'::regclass) THEN
    ALTER TABLE public.metric_catalog
        ADD CONSTRAINT metric_catalog_name_format CHECK ((name ~ '^[A-Za-z0-9_]+(/[A-Za-z0-9_]+)*$'::text));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'metric_catalog_permitted_values_shape'
                AND conrelid = 'public.metric_catalog'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((permitted_values IS NULL) OR ((cardinality(permitted_values) > 0) AND (array_position(permitted_values, NULL::text) IS NULL) AND (''''::text <> ALL (permitted_values)))))') THEN
    ALTER TABLE public.metric_catalog DROP CONSTRAINT metric_catalog_permitted_values_shape;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'metric_catalog_permitted_values_shape'
                    AND conrelid = 'public.metric_catalog'::regclass) THEN
    ALTER TABLE public.metric_catalog
        ADD CONSTRAINT metric_catalog_permitted_values_shape CHECK (((permitted_values IS NULL) OR ((cardinality(permitted_values) > 0) AND (array_position(permitted_values, NULL::text) IS NULL) AND (''::text <> ALL (permitted_values)))));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'metric_catalog_semantic_id_type_valid'
                AND conrelid = 'public.metric_catalog'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((semantic_id_type IS NULL) OR (semantic_id_type = ANY (ARRAY[''IRI''::text, ''IRDI''::text]))))') THEN
    ALTER TABLE public.metric_catalog DROP CONSTRAINT metric_catalog_semantic_id_type_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'metric_catalog_semantic_id_type_valid'
                    AND conrelid = 'public.metric_catalog'::regclass) THEN
    ALTER TABLE public.metric_catalog
        ADD CONSTRAINT metric_catalog_semantic_id_type_valid CHECK (((semantic_id_type IS NULL) OR (semantic_id_type = ANY (ARRAY['IRI'::text, 'IRDI'::text]))));
  END IF;
END $c$;

--

-- COLUMN metric_catalog.semantic_id :: COMMENT
COMMENT ON COLUMN public.metric_catalog.semantic_id IS 'AAS (IEC 63278) semanticId for this metric -- the globally-resolvable identity of the concept it measures. NULL means unmapped, which is a legitimate state for a local extension.';

--

-- COLUMN metric_catalog.semantic_id_type :: COMMENT
COMMENT ON COLUMN public.metric_catalog.semantic_id_type IS 'Which kind of AAS Reference semantic_id is: IRI or IRDI. Both export as an ExternalReference.';

--

-- COLUMN metric_catalog.permitted_values :: COMMENT
COMMENT ON COLUMN public.metric_catalog.permitted_values IS 'The values a discrete metric is allowed to report, from its standard vocabulary. NULL means unconstrained -- most metrics are, and a continuous SAMPLE always is. Deliberately NOT frozen by enforce_metric_catalog_immutability: it is a transcribed assertion about a standard, not a wire contract a device is configured against. See this migration''s header.';

--

-- metric_groups :: TABLE
CREATE TABLE IF NOT EXISTS public.metric_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now(),
    standard text,
    CONSTRAINT metric_groups_name_is_one_segment CHECK (((name <> ''::text) AND (strpos(name, '/'::text) = 0)))
);


ALTER TABLE public.metric_groups OWNER TO postgres;

ALTER TABLE public.metric_groups
    ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid() NOT NULL,
    ADD COLUMN IF NOT EXISTS name text NOT NULL,
    ADD COLUMN IF NOT EXISTS description text,
    ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now(),
    ADD COLUMN IF NOT EXISTS standard text;

ALTER TABLE public.metric_groups
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN name DROP DEFAULT,
    ALTER COLUMN description DROP DEFAULT,
    ALTER COLUMN created_at SET DEFAULT now(),
    ALTER COLUMN standard DROP DEFAULT;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'metric_groups_name_is_one_segment'
                AND conrelid = 'public.metric_groups'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((name <> ''''::text) AND (strpos(name, ''/''::text) = 0)))') THEN
    ALTER TABLE public.metric_groups DROP CONSTRAINT metric_groups_name_is_one_segment;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'metric_groups_name_is_one_segment'
                    AND conrelid = 'public.metric_groups'::regclass) THEN
    ALTER TABLE public.metric_groups
        ADD CONSTRAINT metric_groups_name_is_one_segment CHECK (((name <> ''::text) AND (strpos(name, '/'::text) = 0)));
  END IF;
END $c$;

--

-- mtconnect_vocabulary :: TABLE
CREATE TABLE IF NOT EXISTS public.mtconnect_vocabulary (
    kind text NOT NULL,
    name text NOT NULL,
    category text,
    semantic_id text
);


ALTER TABLE public.mtconnect_vocabulary OWNER TO postgres;

ALTER TABLE public.mtconnect_vocabulary
    ADD COLUMN IF NOT EXISTS kind text NOT NULL,
    ADD COLUMN IF NOT EXISTS name text NOT NULL,
    ADD COLUMN IF NOT EXISTS category text,
    ADD COLUMN IF NOT EXISTS semantic_id text;

ALTER TABLE public.mtconnect_vocabulary
    ALTER COLUMN kind DROP DEFAULT,
    ALTER COLUMN name DROP DEFAULT,
    ALTER COLUMN category DROP DEFAULT,
    ALTER COLUMN semantic_id DROP DEFAULT;

--

-- TABLE mtconnect_vocabulary :: COMMENT
COMMENT ON TABLE public.mtconnect_vocabulary IS 'MTConnect controlled vocabularies, generated from the Apache-2.0 mtconnect/schema repository. Reference data, not deployment state.';

--

-- COLUMN mtconnect_vocabulary.semantic_id :: COMMENT
COMMENT ON COLUMN public.mtconnect_vocabulary.semantic_id IS 'Local-namespace IRI for this vocabulary concept. Minted by this deployment, not issued by MTConnect -- see archived migration 0032.';

--

-- one_shot_migrations :: TABLE
CREATE TABLE IF NOT EXISTS public.one_shot_migrations (
    key text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    note text
);


ALTER TABLE public.one_shot_migrations OWNER TO postgres;

ALTER TABLE public.one_shot_migrations
    ADD COLUMN IF NOT EXISTS key text NOT NULL,
    ADD COLUMN IF NOT EXISTS applied_at timestamp with time zone DEFAULT now() NOT NULL,
    ADD COLUMN IF NOT EXISTS note text;

ALTER TABLE public.one_shot_migrations
    ALTER COLUMN key DROP DEFAULT,
    ALTER COLUMN applied_at SET DEFAULT now(),
    ALTER COLUMN note DROP DEFAULT;

--

-- TABLE one_shot_migrations :: COMMENT
COMMENT ON TABLE public.one_shot_migrations IS 'Ledger for migrations that must run exactly once, rather than on every boot like the rest of the chain. Claimed by INSERT ... ON CONFLICT DO NOTHING inside the same transaction as the work it guards. Written only by the migration owner (postgres): service_role holds SELECT and no write since 0053, because deleting a claim re-arms a destructive one-shot and the next boot reports success exactly as the first did.';

--

-- opcua_vocabulary :: TABLE
CREATE TABLE IF NOT EXISTS public.opcua_vocabulary (
    name text NOT NULL,
    companion_spec text NOT NULL,
    node_id text,
    description text,
    datatype text,
    unit text,
    semantic_id text
);


ALTER TABLE public.opcua_vocabulary OWNER TO postgres;

ALTER TABLE public.opcua_vocabulary
    ADD COLUMN IF NOT EXISTS name text NOT NULL,
    ADD COLUMN IF NOT EXISTS companion_spec text NOT NULL,
    ADD COLUMN IF NOT EXISTS node_id text,
    ADD COLUMN IF NOT EXISTS description text,
    ADD COLUMN IF NOT EXISTS datatype text,
    ADD COLUMN IF NOT EXISTS unit text,
    ADD COLUMN IF NOT EXISTS semantic_id text;

ALTER TABLE public.opcua_vocabulary
    ALTER COLUMN name DROP DEFAULT,
    ALTER COLUMN companion_spec DROP DEFAULT,
    ALTER COLUMN node_id DROP DEFAULT,
    ALTER COLUMN description DROP DEFAULT,
    ALTER COLUMN datatype DROP DEFAULT,
    ALTER COLUMN unit DROP DEFAULT,
    ALTER COLUMN semantic_id DROP DEFAULT;

--

-- TABLE opcua_vocabulary :: COMMENT
COMMENT ON TABLE public.opcua_vocabulary IS 'OPC UA companion specification data points: OPC 30050 PackML, OPC 40001 Machinery, OPC 40001-4 Machinery Energy, OPC 40010 Robotics, OPC 40501 Machine Tools, OPC 40540 Additive Manufacturing. Reference data, not deployment state. The OPC 30050 PackML, OPC 40001-4 Machinery Energy, OPC 40501 Machine Tools, OPC 40540 Additive Manufacturing rows are verified against the OPC Foundation NodeSet2 XML by scripts/generate-opcua-vocabulary.mjs; the OPC 40001 Machinery, OPC 40010 Robotics rows are hand-written. node_id holds a browse path, not a resolvable numeric NodeId. semantic_id is derived from the published namespace URI plus the browse name, not issued by the OPC Foundation; MTConnect ids are minted under aber.local instead.';

--

-- permissions :: TABLE
CREATE TABLE IF NOT EXISTS public.permissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text
);


ALTER TABLE public.permissions OWNER TO postgres;

ALTER TABLE public.permissions
    ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid() NOT NULL,
    ADD COLUMN IF NOT EXISTS name text NOT NULL,
    ADD COLUMN IF NOT EXISTS description text;

ALTER TABLE public.permissions
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN name DROP DEFAULT,
    ALTER COLUMN description DROP DEFAULT;

--

-- platform_alerts :: TABLE
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


ALTER TABLE public.platform_alerts OWNER TO postgres;

ALTER TABLE public.platform_alerts
    ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid() NOT NULL,
    ADD COLUMN IF NOT EXISTS fingerprint text NOT NULL,
    ADD COLUMN IF NOT EXISTS entity_type text DEFAULT 'device'::text NOT NULL,
    ADD COLUMN IF NOT EXISTS entity_id uuid,
    ADD COLUMN IF NOT EXISTS sparkplug_id text,
    ADD COLUMN IF NOT EXISTS alert_name text NOT NULL,
    ADD COLUMN IF NOT EXISTS severity text DEFAULT 'warning'::text NOT NULL,
    ADD COLUMN IF NOT EXISTS status text NOT NULL,
    ADD COLUMN IF NOT EXISTS summary text,
    ADD COLUMN IF NOT EXISTS starts_at timestamp with time zone NOT NULL,
    ADD COLUMN IF NOT EXISTS ends_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS recorded_at timestamp with time zone DEFAULT now() NOT NULL;

ALTER TABLE public.platform_alerts
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN fingerprint DROP DEFAULT,
    ALTER COLUMN entity_type SET DEFAULT 'device'::text,
    ALTER COLUMN entity_id DROP DEFAULT,
    ALTER COLUMN sparkplug_id DROP DEFAULT,
    ALTER COLUMN alert_name DROP DEFAULT,
    ALTER COLUMN severity SET DEFAULT 'warning'::text,
    ALTER COLUMN status DROP DEFAULT,
    ALTER COLUMN summary DROP DEFAULT,
    ALTER COLUMN starts_at DROP DEFAULT,
    ALTER COLUMN ends_at DROP DEFAULT,
    ALTER COLUMN recorded_at SET DEFAULT now();

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'platform_alerts_asset_has_wire_id'
                AND conrelid = 'public.platform_alerts'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((entity_type = ''platform''::text) OR (sparkplug_id IS NOT NULL)))') THEN
    ALTER TABLE public.platform_alerts DROP CONSTRAINT platform_alerts_asset_has_wire_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'platform_alerts_asset_has_wire_id'
                    AND conrelid = 'public.platform_alerts'::regclass) THEN
    ALTER TABLE public.platform_alerts
        ADD CONSTRAINT platform_alerts_asset_has_wire_id CHECK (((entity_type = 'platform'::text) OR (sparkplug_id IS NOT NULL)));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'platform_alerts_entity_type_valid'
                AND conrelid = 'public.platform_alerts'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((entity_type = ANY (ARRAY[''device''::text, ''gateway''::text, ''platform''::text])))') THEN
    ALTER TABLE public.platform_alerts DROP CONSTRAINT platform_alerts_entity_type_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'platform_alerts_entity_type_valid'
                    AND conrelid = 'public.platform_alerts'::regclass) THEN
    ALTER TABLE public.platform_alerts
        ADD CONSTRAINT platform_alerts_entity_type_valid CHECK ((entity_type = ANY (ARRAY['device'::text, 'gateway'::text, 'platform'::text])));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'platform_alerts_resolved_has_end'
                AND conrelid = 'public.platform_alerts'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((status <> ''resolved''::text) OR (ends_at IS NOT NULL)))') THEN
    ALTER TABLE public.platform_alerts DROP CONSTRAINT platform_alerts_resolved_has_end;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'platform_alerts_resolved_has_end'
                    AND conrelid = 'public.platform_alerts'::regclass) THEN
    ALTER TABLE public.platform_alerts
        ADD CONSTRAINT platform_alerts_resolved_has_end CHECK (((status <> 'resolved'::text) OR (ends_at IS NOT NULL)));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'platform_alerts_severity_valid'
                AND conrelid = 'public.platform_alerts'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((severity = ANY (ARRAY[''critical''::text, ''warning''::text, ''info''::text])))') THEN
    ALTER TABLE public.platform_alerts DROP CONSTRAINT platform_alerts_severity_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'platform_alerts_severity_valid'
                    AND conrelid = 'public.platform_alerts'::regclass) THEN
    ALTER TABLE public.platform_alerts
        ADD CONSTRAINT platform_alerts_severity_valid CHECK ((severity = ANY (ARRAY['critical'::text, 'warning'::text, 'info'::text])));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'platform_alerts_status_valid'
                AND conrelid = 'public.platform_alerts'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((status = ANY (ARRAY[''firing''::text, ''resolved''::text])))') THEN
    ALTER TABLE public.platform_alerts DROP CONSTRAINT platform_alerts_status_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'platform_alerts_status_valid'
                    AND conrelid = 'public.platform_alerts'::regclass) THEN
    ALTER TABLE public.platform_alerts
        ADD CONSTRAINT platform_alerts_status_valid CHECK ((status = ANY (ARRAY['firing'::text, 'resolved'::text])));
  END IF;
END $c$;

--

-- TABLE platform_alerts :: COMMENT
COMMENT ON TABLE public.platform_alerts IS 'One row per Grafana alert OCCURRENCE -- machine conditions and platform conditions alike -- delivered by the grafana-alert-webhook edge function. Append-only on (fingerprint, starts_at); an occurrence transitions firing -> resolved in place.';

--

-- COLUMN platform_alerts.entity_type :: COMMENT
COMMENT ON COLUMN public.platform_alerts.entity_type IS 'What the alert is about: device | gateway | platform. The dashboard reddens an asset only for its own kind, so this is read before entity_id anywhere a colour or a link is derived.';

--

-- COLUMN platform_alerts.entity_id :: COMMENT
COMMENT ON COLUMN public.platform_alerts.entity_id IS 'The subject row id, or NULL for a platform-scoped alert or an id that matched nothing. Carries no foreign key on purpose -- see the column definition.';

--

-- COLUMN platform_alerts.sparkplug_id :: COMMENT
COMMENT ON COLUMN public.platform_alerts.sparkplug_id IS 'The immutable Sparkplug id of the asset the alert was raised for, taken from the Grafana label. Never a display name. NULL only for entity_type = platform, which has no single subject.';

--

-- platform_alerts_active :: VIEW
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


ALTER VIEW public.platform_alerts_active OWNER TO postgres;

--

-- VIEW platform_alerts_active :: COMMENT
COMMENT ON VIEW public.platform_alerts_active IS 'Currently firing alerts, one row per Grafana fingerprint (the newest occurrence). A later resolved occurrence supersedes an earlier firing one, so a missed resolve cannot pin a stale alert.';

--

-- platform_health :: VIEW
CREATE OR REPLACE VIEW public.platform_health AS
 SELECT now() AS collected_at,
    condition,
    sparkplug_id,
    subject,
    value,
    detail
   FROM public.platform_health_rows() r(condition, sparkplug_id, subject, value, detail);


ALTER VIEW public.platform_health OWNER TO postgres;

--

-- VIEW platform_health :: COMMENT
COMMENT ON VIEW public.platform_health IS 'The platform''s own condition, long-form so a Grafana rule over one `condition` value produces one alert instance per subject. Read by the `supabase` datasource; see grafana/provisioning/alerting/alert-rules.yaml.';

--

-- playback_jobs :: TABLE
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
    messages_out_of_window integer DEFAULT 0 NOT NULL,
    CONSTRAINT playback_jobs_device_map_is_object CHECK ((jsonb_typeof(device_map) = 'object'::text)),
    CONSTRAINT playback_jobs_out_of_window_is_sane CHECK ((messages_out_of_window >= 0)),
    CONSTRAINT playback_jobs_speed_is_sane CHECK (((speed > (0)::numeric) AND (speed <= (60)::numeric))),
    CONSTRAINT playback_jobs_status_valid CHECK ((status = ANY (ARRAY['PENDING'::text, 'RUNNING'::text, 'COMPLETED'::text, 'FAILED'::text, 'CANCELLED'::text])))
);

ALTER TABLE ONLY public.playback_jobs REPLICA IDENTITY FULL;


ALTER TABLE public.playback_jobs OWNER TO postgres;

ALTER TABLE public.playback_jobs
    ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid() NOT NULL,
    ADD COLUMN IF NOT EXISTS capture_id uuid,
    ADD COLUMN IF NOT EXISTS capture_storage_path text NOT NULL,
    ADD COLUMN IF NOT EXISTS target_gateway_id uuid NOT NULL,
    ADD COLUMN IF NOT EXISTS target_edge_node_id text NOT NULL,
    ADD COLUMN IF NOT EXISTS sparkplug_group text NOT NULL,
    ADD COLUMN IF NOT EXISTS device_map jsonb DEFAULT '{}'::jsonb NOT NULL,
    ADD COLUMN IF NOT EXISTS speed numeric DEFAULT 1.0 NOT NULL,
    ADD COLUMN IF NOT EXISTS status text DEFAULT 'PENDING'::text NOT NULL,
    ADD COLUMN IF NOT EXISTS messages_total integer DEFAULT 0 NOT NULL,
    ADD COLUMN IF NOT EXISTS messages_sent integer DEFAULT 0 NOT NULL,
    ADD COLUMN IF NOT EXISTS elapsed_seconds integer DEFAULT 0 NOT NULL,
    ADD COLUMN IF NOT EXISTS stop_requested boolean DEFAULT false NOT NULL,
    ADD COLUMN IF NOT EXISTS error text,
    ADD COLUMN IF NOT EXISTS requested_by uuid,
    ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now() NOT NULL,
    ADD COLUMN IF NOT EXISTS started_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS finished_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS messages_out_of_window integer DEFAULT 0 NOT NULL;

ALTER TABLE public.playback_jobs
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN capture_id DROP DEFAULT,
    ALTER COLUMN capture_storage_path DROP DEFAULT,
    ALTER COLUMN target_gateway_id DROP DEFAULT,
    ALTER COLUMN target_edge_node_id DROP DEFAULT,
    ALTER COLUMN sparkplug_group DROP DEFAULT,
    ALTER COLUMN device_map SET DEFAULT '{}'::jsonb,
    ALTER COLUMN speed SET DEFAULT 1.0,
    ALTER COLUMN status SET DEFAULT 'PENDING'::text,
    ALTER COLUMN messages_total SET DEFAULT 0,
    ALTER COLUMN messages_sent SET DEFAULT 0,
    ALTER COLUMN elapsed_seconds SET DEFAULT 0,
    ALTER COLUMN stop_requested SET DEFAULT false,
    ALTER COLUMN error DROP DEFAULT,
    ALTER COLUMN requested_by DROP DEFAULT,
    ALTER COLUMN created_at SET DEFAULT now(),
    ALTER COLUMN started_at DROP DEFAULT,
    ALTER COLUMN finished_at DROP DEFAULT,
    ALTER COLUMN messages_out_of_window SET DEFAULT 0;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'playback_jobs_device_map_is_object'
                AND conrelid = 'public.playback_jobs'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((jsonb_typeof(device_map) = ''object''::text))') THEN
    ALTER TABLE public.playback_jobs DROP CONSTRAINT playback_jobs_device_map_is_object;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'playback_jobs_device_map_is_object'
                    AND conrelid = 'public.playback_jobs'::regclass) THEN
    ALTER TABLE public.playback_jobs
        ADD CONSTRAINT playback_jobs_device_map_is_object CHECK ((jsonb_typeof(device_map) = 'object'::text));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'playback_jobs_out_of_window_is_sane'
                AND conrelid = 'public.playback_jobs'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((messages_out_of_window >= 0))') THEN
    ALTER TABLE public.playback_jobs DROP CONSTRAINT playback_jobs_out_of_window_is_sane;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'playback_jobs_out_of_window_is_sane'
                    AND conrelid = 'public.playback_jobs'::regclass) THEN
    ALTER TABLE public.playback_jobs
        ADD CONSTRAINT playback_jobs_out_of_window_is_sane CHECK ((messages_out_of_window >= 0));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'playback_jobs_speed_is_sane'
                AND conrelid = 'public.playback_jobs'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((speed > (0)::numeric) AND (speed <= (60)::numeric)))') THEN
    ALTER TABLE public.playback_jobs DROP CONSTRAINT playback_jobs_speed_is_sane;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'playback_jobs_speed_is_sane'
                    AND conrelid = 'public.playback_jobs'::regclass) THEN
    ALTER TABLE public.playback_jobs
        ADD CONSTRAINT playback_jobs_speed_is_sane CHECK (((speed > (0)::numeric) AND (speed <= (60)::numeric)));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'playback_jobs_status_valid'
                AND conrelid = 'public.playback_jobs'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((status = ANY (ARRAY[''PENDING''::text, ''RUNNING''::text, ''COMPLETED''::text, ''FAILED''::text, ''CANCELLED''::text])))') THEN
    ALTER TABLE public.playback_jobs DROP CONSTRAINT playback_jobs_status_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'playback_jobs_status_valid'
                    AND conrelid = 'public.playback_jobs'::regclass) THEN
    ALTER TABLE public.playback_jobs
        ADD CONSTRAINT playback_jobs_status_valid CHECK ((status = ANY (ARRAY['PENDING'::text, 'RUNNING'::text, 'COMPLETED'::text, 'FAILED'::text, 'CANCELLED'::text])));
  END IF;
END $c$;

--

-- TABLE playback_jobs :: COMMENT
COMMENT ON TABLE public.playback_jobs IS 'One row per playback attempted. At most one is PENDING or RUNNING per TARGET GATEWAY -- two publishers on one edge node interleave sequence numbers. Written only through the gates in 0056; there is no direct-write policy. Progress is pushed to the page by Realtime.';

--

-- COLUMN playback_jobs.messages_out_of_window :: COMMENT
COMMENT ON COLUMN public.playback_jobs.messages_out_of_window IS 'How many of this job''s planned messages carried timestamps the ingestion daemon will discard as outside its sanity window -- computed by the worker from the plan before publishing, never reported back by the daemon, whose answer to an out-of-window metric is a counter and not an error. COUNTED PER MESSAGE WHILE THE REFUSAL IS DECIDED PER METRIC: process_ddata() judges each metric on its own timestamp and falls back to the payload''s only when it has none, so a job carrying a count on every one of its messages may still have written a reading from each. The worker refuses, as FAILED, only a playback the window would discard entirely. Zero on every job written before 0109.';

--

-- playback_worker_status :: TABLE
CREATE TABLE IF NOT EXISTS public.playback_worker_status (
    id boolean DEFAULT true NOT NULL,
    held_edge_nodes text[] DEFAULT '{}'::text[] NOT NULL,
    reported_at timestamp with time zone DEFAULT now() NOT NULL,
    credential_observed_at jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT playback_worker_status_id_check CHECK (id)
);


ALTER TABLE public.playback_worker_status OWNER TO postgres;

ALTER TABLE public.playback_worker_status
    ADD COLUMN IF NOT EXISTS id boolean DEFAULT true NOT NULL,
    ADD COLUMN IF NOT EXISTS held_edge_nodes text[] DEFAULT '{}'::text[] NOT NULL,
    ADD COLUMN IF NOT EXISTS reported_at timestamp with time zone DEFAULT now() NOT NULL,
    ADD COLUMN IF NOT EXISTS credential_observed_at jsonb DEFAULT '{}'::jsonb NOT NULL;

ALTER TABLE public.playback_worker_status
    ALTER COLUMN id SET DEFAULT true,
    ALTER COLUMN held_edge_nodes SET DEFAULT '{}'::text[],
    ALTER COLUMN reported_at SET DEFAULT now(),
    ALTER COLUMN credential_observed_at SET DEFAULT '{}'::jsonb;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'playback_worker_status_id_check'
                AND conrelid = 'public.playback_worker_status'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (id)') THEN
    ALTER TABLE public.playback_worker_status DROP CONSTRAINT playback_worker_status_id_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'playback_worker_status_id_check'
                    AND conrelid = 'public.playback_worker_status'::regclass) THEN
    ALTER TABLE public.playback_worker_status
        ADD CONSTRAINT playback_worker_status_id_check CHECK (id);
  END IF;
END $c$;

--

-- TABLE playback_worker_status :: COMMENT
COMMENT ON TABLE public.playback_worker_status IS 'What the playback worker can actually publish as: the gateway sparkplug_ids it holds broker passwords for, and when it last said so. One row by CHECK (id). Written only by playback_report_credentials(), read by the playback dialog so a target the worker cannot authenticate as is refused before a job is queued rather than after. Holds no secret -- a sparkplug_id is a public identifier and the passwords are deliberately not here.';

--

-- COLUMN playback_worker_status.reported_at :: COMMENT
COMMENT ON COLUMN public.playback_worker_status.reported_at IS 'Heartbeat. An empty held_edge_nodes with a RECENT timestamp means the worker is running and holds no credentials; a stale timestamp means the worker is not running. Those are different problems and the page says which.';

--

-- COLUMN playback_worker_status.credential_observed_at :: COMMENT
COMMENT ON COLUMN public.playback_worker_status.credential_observed_at IS 'sparkplug_id -> when this database last stamped an observation of a NEW password the worker reported picking up for it. Compared with that gateway''s last CREDENTIAL_ISSUED row to tell "holds a credential for X" from "holds the CURRENT credential for X" (#217). A jsonb map rather than a side table because the whole of it is one process''s memory, written as a unit by the same single writer as the rest of the row. Holds no secret: a timestamp is derived from nothing, which a truncated hash of the password would not be.';

--

-- principal_permissions :: TABLE
CREATE TABLE IF NOT EXISTS public.principal_permissions (
    principal_id uuid NOT NULL,
    permission_id uuid NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.principal_permissions OWNER TO postgres;

ALTER TABLE public.principal_permissions
    ADD COLUMN IF NOT EXISTS principal_id uuid NOT NULL,
    ADD COLUMN IF NOT EXISTS permission_id uuid NOT NULL,
    ADD COLUMN IF NOT EXISTS granted_at timestamp with time zone DEFAULT now() NOT NULL;

ALTER TABLE public.principal_permissions
    ALTER COLUMN principal_id DROP DEFAULT,
    ALTER COLUMN permission_id DROP DEFAULT,
    ALTER COLUMN granted_at SET DEFAULT now();

--

-- TABLE principal_permissions :: COMMENT
COMMENT ON TABLE public.principal_permissions IS 'Permissions granted to ONE machine identity, resolved by has_authority(). The machine-side twin of role_permissions: a principal holds grants of its own instead of borrowing a person''s role, so widening Operator no longer widens the ingestion daemon. A machine principal may hold no role at all -- refuse_role_for_machine_principal() enforces that on user_roles.';

--

-- COLUMN principal_permissions.granted_at :: COMMENT
COMMENT ON COLUMN public.principal_permissions.granted_at IS 'When the grant was made. role_permissions carries no equivalent because its rows are seeded by migration and never by a person; these are minted at runtime by create_machine_principal().';

--

-- rebirth_requests :: TABLE
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


ALTER TABLE public.rebirth_requests OWNER TO postgres;

ALTER TABLE public.rebirth_requests
    ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid() NOT NULL,
    ADD COLUMN IF NOT EXISTS gateway_id uuid NOT NULL,
    ADD COLUMN IF NOT EXISTS edge_node_id text NOT NULL,
    ADD COLUMN IF NOT EXISTS sparkplug_group text NOT NULL,
    ADD COLUMN IF NOT EXISTS status text DEFAULT 'PENDING'::text NOT NULL,
    ADD COLUMN IF NOT EXISTS throttled boolean DEFAULT false NOT NULL,
    ADD COLUMN IF NOT EXISTS error text,
    ADD COLUMN IF NOT EXISTS requested_by uuid,
    ADD COLUMN IF NOT EXISTS requested_at timestamp with time zone DEFAULT now() NOT NULL,
    ADD COLUMN IF NOT EXISTS sent_at timestamp with time zone;

ALTER TABLE public.rebirth_requests
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN gateway_id DROP DEFAULT,
    ALTER COLUMN edge_node_id DROP DEFAULT,
    ALTER COLUMN sparkplug_group DROP DEFAULT,
    ALTER COLUMN status SET DEFAULT 'PENDING'::text,
    ALTER COLUMN throttled SET DEFAULT false,
    ALTER COLUMN error DROP DEFAULT,
    ALTER COLUMN requested_by DROP DEFAULT,
    ALTER COLUMN requested_at SET DEFAULT now(),
    ALTER COLUMN sent_at DROP DEFAULT;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'rebirth_requests_status_valid'
                AND conrelid = 'public.rebirth_requests'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((status = ANY (ARRAY[''PENDING''::text, ''SENT''::text, ''FAILED''::text])))') THEN
    ALTER TABLE public.rebirth_requests DROP CONSTRAINT rebirth_requests_status_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'rebirth_requests_status_valid'
                    AND conrelid = 'public.rebirth_requests'::regclass) THEN
    ALTER TABLE public.rebirth_requests
        ADD CONSTRAINT rebirth_requests_status_valid CHECK ((status = ANY (ARRAY['PENDING'::text, 'SENT'::text, 'FAILED'::text])));
  END IF;
END $c$;

--

-- TABLE rebirth_requests :: COMMENT
COMMENT ON TABLE public.rebirth_requests IS 'A person asking an edge node to republish its birth certificate. The daemon claims PENDING rows and publishes Node Control/Rebirth, which is the only NCMD this stack sends and the only one the ingestion role at the broker permits it (mosquitto/dynsec-roles.json). Not a general command channel: writing a metric VALUE is actuation and is deliberately not reachable from here. See 0058''s header.';

--

-- retired_entities :: TABLE
CREATE TABLE IF NOT EXISTS public.retired_entities (
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    name text,
    sparkplug_id text,
    archived_at timestamp with time zone,
    retired_at timestamp with time zone DEFAULT now() NOT NULL,
    retired_by uuid,
    retired_by_email text,
    trail_id bigint,
    old_data jsonb NOT NULL,
    CONSTRAINT retired_entities_type_known CHECK ((entity_type = ANY (ARRAY['areas'::text, 'cells'::text, 'gateways'::text, 'devices'::text])))
);


ALTER TABLE public.retired_entities OWNER TO postgres;

ALTER TABLE public.retired_entities
    ADD COLUMN IF NOT EXISTS entity_type text NOT NULL,
    ADD COLUMN IF NOT EXISTS entity_id uuid NOT NULL,
    ADD COLUMN IF NOT EXISTS name text,
    ADD COLUMN IF NOT EXISTS sparkplug_id text,
    ADD COLUMN IF NOT EXISTS archived_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS retired_at timestamp with time zone DEFAULT now() NOT NULL,
    ADD COLUMN IF NOT EXISTS retired_by uuid,
    ADD COLUMN IF NOT EXISTS retired_by_email text,
    ADD COLUMN IF NOT EXISTS trail_id bigint,
    ADD COLUMN IF NOT EXISTS old_data jsonb NOT NULL;

ALTER TABLE public.retired_entities
    ALTER COLUMN entity_type DROP DEFAULT,
    ALTER COLUMN entity_id DROP DEFAULT,
    ALTER COLUMN name DROP DEFAULT,
    ALTER COLUMN sparkplug_id DROP DEFAULT,
    ALTER COLUMN archived_at DROP DEFAULT,
    ALTER COLUMN retired_at SET DEFAULT now(),
    ALTER COLUMN retired_by DROP DEFAULT,
    ALTER COLUMN retired_by_email DROP DEFAULT,
    ALTER COLUMN trail_id DROP DEFAULT,
    ALTER COLUMN old_data DROP DEFAULT;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'retired_entities_type_known'
                AND conrelid = 'public.retired_entities'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((entity_type = ANY (ARRAY[''areas''::text, ''cells''::text, ''gateways''::text, ''devices''::text])))') THEN
    ALTER TABLE public.retired_entities DROP CONSTRAINT retired_entities_type_known;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'retired_entities_type_known'
                    AND conrelid = 'public.retired_entities'::regclass) THEN
    ALTER TABLE public.retired_entities
        ADD CONSTRAINT retired_entities_type_known CHECK ((entity_type = ANY (ARRAY['areas'::text, 'cells'::text, 'gateways'::text, 'devices'::text])));
  END IF;
END $c$;

--

-- TABLE retired_entities :: COMMENT
COMMENT ON TABLE public.retired_entities IS 'One row per asset that was archived and then deleted, written by record_retired_entity() on the DELETE. Not derived from audit_trail, which is partitioned for an eventual DETACH: a tombstone outlives the month that recorded the delete. Readable by whoever may read the Archived Entities page or the trail''s asset lane; written by nothing but the trigger.';

--

-- COLUMN retired_entities.old_data :: COMMENT
COMMENT ON COLUMN public.retired_entities.old_data IS 'The deleted row, as the DELETE audit row carries it. A gateway''s forge repository is derived from it (gateway-<sparkplug_id>) as it is everywhere else.';

--

-- revoked_service_principals :: TABLE
CREATE TABLE IF NOT EXISTS public.revoked_service_principals (
    principal_id uuid NOT NULL,
    revoked_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_by uuid,
    reason text
);


ALTER TABLE public.revoked_service_principals OWNER TO postgres;

ALTER TABLE public.revoked_service_principals
    ADD COLUMN IF NOT EXISTS principal_id uuid NOT NULL,
    ADD COLUMN IF NOT EXISTS revoked_at timestamp with time zone DEFAULT now() NOT NULL,
    ADD COLUMN IF NOT EXISTS revoked_by uuid,
    ADD COLUMN IF NOT EXISTS reason text;

ALTER TABLE public.revoked_service_principals
    ALTER COLUMN principal_id DROP DEFAULT,
    ALTER COLUMN revoked_at SET DEFAULT now(),
    ALTER COLUMN revoked_by DROP DEFAULT,
    ALTER COLUMN reason DROP DEFAULT;

--

-- TABLE revoked_service_principals :: COMMENT
COMMENT ON TABLE public.revoked_service_principals IS 'Service principals that public.auth_pre_request() refuses by subject. Not self-pruning: a principal has no expiry, so a row stays until reinstate_service_principal() removes it. The permanent record is the PRINCIPAL_REVOKED / PRINCIPAL_REINSTATED rows in audit_trail.';

--

-- revoked_service_tokens :: TABLE
CREATE TABLE IF NOT EXISTS public.revoked_service_tokens (
    jti text NOT NULL,
    principal_id uuid NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_by uuid
);


ALTER TABLE public.revoked_service_tokens OWNER TO postgres;

ALTER TABLE public.revoked_service_tokens
    ADD COLUMN IF NOT EXISTS jti text NOT NULL,
    ADD COLUMN IF NOT EXISTS principal_id uuid NOT NULL,
    ADD COLUMN IF NOT EXISTS expires_at timestamp with time zone NOT NULL,
    ADD COLUMN IF NOT EXISTS revoked_at timestamp with time zone DEFAULT now() NOT NULL,
    ADD COLUMN IF NOT EXISTS revoked_by uuid;

ALTER TABLE public.revoked_service_tokens
    ALTER COLUMN jti DROP DEFAULT,
    ALTER COLUMN principal_id DROP DEFAULT,
    ALTER COLUMN expires_at DROP DEFAULT,
    ALTER COLUMN revoked_at SET DEFAULT now(),
    ALTER COLUMN revoked_by DROP DEFAULT;

--

-- TABLE revoked_service_tokens :: COMMENT
COMMENT ON TABLE public.revoked_service_tokens IS 'Unexpired service-token jtis that public.auth_pre_request() refuses. Operational, not audit: rows are pruned once the token they name has expired, because the signature check refuses it from then on. The permanent record is the TOKEN_REVOKED row in audit_trail.';

--

-- role_permissions :: TABLE
CREATE TABLE IF NOT EXISTS public.role_permissions (
    role_id integer NOT NULL,
    permission_id uuid NOT NULL
);


ALTER TABLE public.role_permissions OWNER TO postgres;

ALTER TABLE public.role_permissions
    ADD COLUMN IF NOT EXISTS role_id integer NOT NULL,
    ADD COLUMN IF NOT EXISTS permission_id uuid NOT NULL;

ALTER TABLE public.role_permissions
    ALTER COLUMN role_id DROP DEFAULT,
    ALTER COLUMN permission_id DROP DEFAULT;

--

-- roles :: TABLE
CREATE TABLE IF NOT EXISTS public.roles (
    id integer NOT NULL,
    name text NOT NULL,
    description text
);


ALTER TABLE public.roles OWNER TO postgres;

ALTER TABLE public.roles
    ADD COLUMN IF NOT EXISTS id integer NOT NULL,
    ADD COLUMN IF NOT EXISTS name text NOT NULL,
    ADD COLUMN IF NOT EXISTS description text;

ALTER TABLE public.roles
    ALTER COLUMN id DROP DEFAULT,
    ALTER COLUMN name DROP DEFAULT,
    ALTER COLUMN description DROP DEFAULT;

--

-- roles_id_seq :: SEQUENCE
CREATE SEQUENCE IF NOT EXISTS public.roles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.roles_id_seq OWNER TO postgres;

--

-- roles_id_seq :: SEQUENCE OWNED BY
ALTER SEQUENCE public.roles_id_seq OWNED BY public.roles.id;

--

-- schema_bootstrap :: TABLE
CREATE TABLE IF NOT EXISTS public.schema_bootstrap (
    id boolean DEFAULT true NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT schema_bootstrap_id_check CHECK (id)
);


ALTER TABLE public.schema_bootstrap OWNER TO postgres;

ALTER TABLE public.schema_bootstrap
    ADD COLUMN IF NOT EXISTS id boolean DEFAULT true NOT NULL,
    ADD COLUMN IF NOT EXISTS started_at timestamp with time zone DEFAULT now() NOT NULL,
    ADD COLUMN IF NOT EXISTS completed_at timestamp with time zone;

ALTER TABLE public.schema_bootstrap
    ALTER COLUMN id SET DEFAULT true,
    ALTER COLUMN started_at SET DEFAULT now(),
    ALTER COLUMN completed_at DROP DEFAULT;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'schema_bootstrap_id_check'
                AND conrelid = 'public.schema_bootstrap'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (id)') THEN
    ALTER TABLE public.schema_bootstrap DROP CONSTRAINT schema_bootstrap_id_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'schema_bootstrap_id_check'
                    AND conrelid = 'public.schema_bootstrap'::regclass) THEN
    ALTER TABLE public.schema_bootstrap
        ADD CONSTRAINT schema_bootstrap_id_check CHECK (id);
  END IF;
END $c$;

--

-- TABLE schema_bootstrap :: COMMENT
COMMENT ON TABLE public.schema_bootstrap IS 'One row. completed_at IS NULL means db-init is part-way through the migration chain; a non-null completed_at means it reached the end of seed.sql on this boot. Written by db-init, not by a migration -- a migration cannot know whether the files after it succeeded.';

--

-- COLUMN schema_bootstrap.completed_at :: COMMENT
COMMENT ON COLUMN public.schema_bootstrap.completed_at IS 'Cleared at the start of every boot and stamped after seed.sql. The e2e-validate Job gates on it.';

--

-- schemas :: TABLE
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
    CONSTRAINT schemas_semantic_id_type_valid CHECK (((semantic_id_type IS NULL) OR (semantic_id_type = ANY (ARRAY['IRI'::text, 'IRDI'::text])))),
    CONSTRAINT schemas_status_valid CHECK (((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('active'::character varying)::text, ('archived'::character varying)::text]))),
    CONSTRAINT schemas_version_lineage_coherent CHECK ((((version = 1) AND (parent_schema_id IS NULL)) OR ((version > 1) AND (parent_schema_id IS NOT NULL)))),
    CONSTRAINT schemas_version_positive CHECK ((version >= 1))
);


ALTER TABLE public.schemas OWNER TO postgres;

ALTER TABLE public.schemas
    ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid() NOT NULL,
    ADD COLUMN IF NOT EXISTS schema_name text NOT NULL,
    ADD COLUMN IF NOT EXISTS description text,
    ADD COLUMN IF NOT EXISTS schema_definition jsonb NOT NULL,
    ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now(),
    ADD COLUMN IF NOT EXISTS semantic_id text,
    ADD COLUMN IF NOT EXISTS semantic_id_type text,
    ADD COLUMN IF NOT EXISTS version integer DEFAULT 1 NOT NULL,
    ADD COLUMN IF NOT EXISTS parent_schema_id uuid,
    ADD COLUMN IF NOT EXISTS status character varying(20) DEFAULT 'active'::character varying NOT NULL,
    ADD COLUMN IF NOT EXISTS change_description text;

ALTER TABLE public.schemas
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN schema_name DROP DEFAULT,
    ALTER COLUMN description DROP DEFAULT,
    ALTER COLUMN schema_definition DROP DEFAULT,
    ALTER COLUMN created_at SET DEFAULT now(),
    ALTER COLUMN semantic_id DROP DEFAULT,
    ALTER COLUMN semantic_id_type DROP DEFAULT,
    ALTER COLUMN version SET DEFAULT 1,
    ALTER COLUMN parent_schema_id DROP DEFAULT,
    ALTER COLUMN status SET DEFAULT 'active'::character varying,
    ALTER COLUMN change_description DROP DEFAULT;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'schemas_parent_not_self'
                AND conrelid = 'public.schemas'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((parent_schema_id IS NULL) OR (parent_schema_id <> id)))') THEN
    ALTER TABLE public.schemas DROP CONSTRAINT schemas_parent_not_self;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'schemas_parent_not_self'
                    AND conrelid = 'public.schemas'::regclass) THEN
    ALTER TABLE public.schemas
        ADD CONSTRAINT schemas_parent_not_self CHECK (((parent_schema_id IS NULL) OR (parent_schema_id <> id)));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'schemas_semantic_id_type_valid'
                AND conrelid = 'public.schemas'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((semantic_id_type IS NULL) OR (semantic_id_type = ANY (ARRAY[''IRI''::text, ''IRDI''::text]))))') THEN
    ALTER TABLE public.schemas DROP CONSTRAINT schemas_semantic_id_type_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'schemas_semantic_id_type_valid'
                    AND conrelid = 'public.schemas'::regclass) THEN
    ALTER TABLE public.schemas
        ADD CONSTRAINT schemas_semantic_id_type_valid CHECK (((semantic_id_type IS NULL) OR (semantic_id_type = ANY (ARRAY['IRI'::text, 'IRDI'::text]))));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'schemas_status_valid'
                AND conrelid = 'public.schemas'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((status)::text = ANY (ARRAY[(''draft''::character varying)::text, (''active''::character varying)::text, (''archived''::character varying)::text])))') THEN
    ALTER TABLE public.schemas DROP CONSTRAINT schemas_status_valid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'schemas_status_valid'
                    AND conrelid = 'public.schemas'::regclass) THEN
    ALTER TABLE public.schemas
        ADD CONSTRAINT schemas_status_valid CHECK (((status)::text = ANY (ARRAY[('draft'::character varying)::text, ('active'::character varying)::text, ('archived'::character varying)::text])));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'schemas_version_lineage_coherent'
                AND conrelid = 'public.schemas'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((((version = 1) AND (parent_schema_id IS NULL)) OR ((version > 1) AND (parent_schema_id IS NOT NULL))))') THEN
    ALTER TABLE public.schemas DROP CONSTRAINT schemas_version_lineage_coherent;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'schemas_version_lineage_coherent'
                    AND conrelid = 'public.schemas'::regclass) THEN
    ALTER TABLE public.schemas
        ADD CONSTRAINT schemas_version_lineage_coherent CHECK ((((version = 1) AND (parent_schema_id IS NULL)) OR ((version > 1) AND (parent_schema_id IS NOT NULL))));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'schemas_version_positive'
                AND conrelid = 'public.schemas'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((version >= 1))') THEN
    ALTER TABLE public.schemas DROP CONSTRAINT schemas_version_positive;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'schemas_version_positive'
                    AND conrelid = 'public.schemas'::regclass) THEN
    ALTER TABLE public.schemas
        ADD CONSTRAINT schemas_version_positive CHECK ((version >= 1));
  END IF;
END $c$;

--

-- COLUMN schemas.semantic_id :: COMMENT
COMMENT ON COLUMN public.schemas.semantic_id IS 'AAS semanticId for the Submodel this schema corresponds to, e.g. an IDTA submodel template id.';

--

-- COLUMN schemas.semantic_id_type :: COMMENT
COMMENT ON COLUMN public.schemas.semantic_id_type IS 'Which kind of AAS Reference semantic_id is: IRI or IRDI. Both export as an ExternalReference.';

--

-- COLUMN schemas.version :: COMMENT
COMMENT ON COLUMN public.schemas.version IS 'Auto-incremented lineage position. Never supplied by a caller -- fork_schema() derives it from the parent.';

--

-- COLUMN schemas.parent_schema_id :: COMMENT
COMMENT ON COLUMN public.schemas.parent_schema_id IS 'The version this one was forked from. NULL only for a v1 root.';

--

-- COLUMN schemas.status :: COMMENT
COMMENT ON COLUMN public.schemas.status IS 'draft (editable) | active (in force, immutable) | archived (superseded, immutable).';

--

-- COLUMN schemas.change_description :: COMMENT
COMMENT ON COLUMN public.schemas.change_description IS 'Why this version exists. Captured at fork time; immutable once the version is published.';

--

-- storage_footprint :: FOREIGN TABLE
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


ALTER FOREIGN TABLE timescale.storage_footprint OWNER TO postgres;

ALTER TABLE timescale.storage_footprint
    ADD COLUMN IF NOT EXISTS collected_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS source text,
    ADD COLUMN IF NOT EXISTS tier text,
    ADD COLUMN IF NOT EXISTS relation text,
    ADD COLUMN IF NOT EXISTS chunks bigint,
    ADD COLUMN IF NOT EXISTS table_bytes bigint,
    ADD COLUMN IF NOT EXISTS index_bytes bigint,
    ADD COLUMN IF NOT EXISTS toast_bytes bigint,
    ADD COLUMN IF NOT EXISTS total_bytes bigint,
    ADD COLUMN IF NOT EXISTS uncompressed_bytes bigint,
    ADD COLUMN IF NOT EXISTS compressed_bytes bigint,
    ADD COLUMN IF NOT EXISTS oldest_data timestamp with time zone,
    ADD COLUMN IF NOT EXISTS newest_data timestamp with time zone;

ALTER TABLE timescale.storage_footprint
    ALTER COLUMN collected_at DROP DEFAULT,
    ALTER COLUMN source DROP DEFAULT,
    ALTER COLUMN tier DROP DEFAULT,
    ALTER COLUMN relation DROP DEFAULT,
    ALTER COLUMN chunks DROP DEFAULT,
    ALTER COLUMN table_bytes DROP DEFAULT,
    ALTER COLUMN index_bytes DROP DEFAULT,
    ALTER COLUMN toast_bytes DROP DEFAULT,
    ALTER COLUMN total_bytes DROP DEFAULT,
    ALTER COLUMN uncompressed_bytes DROP DEFAULT,
    ALTER COLUMN compressed_bytes DROP DEFAULT,
    ALTER COLUMN oldest_data DROP DEFAULT,
    ALTER COLUMN newest_data DROP DEFAULT;

--

-- storage_footprint :: VIEW
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


ALTER VIEW public.storage_footprint OWNER TO postgres;

--

-- VIEW storage_footprint :: COMMENT
COMMENT ON VIEW public.storage_footprint IS 'Every relation this platform stores, from both databases: the historian over postgres_fdw and the Supabase public schema locally. Bytes by kind, chunk count and compression for hypertables, and the time span the chunks cover. Read by Grafana as the `supabase` datasource.';

--

-- system_settings :: TABLE
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
    read_only boolean DEFAULT false NOT NULL,
    sensitive boolean DEFAULT false NOT NULL,
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


ALTER TABLE public.system_settings OWNER TO postgres;

ALTER TABLE public.system_settings
    ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid() NOT NULL,
    ADD COLUMN IF NOT EXISTS key text NOT NULL,
    ADD COLUMN IF NOT EXISTS value jsonb NOT NULL,
    ADD COLUMN IF NOT EXISTS value_type text NOT NULL,
    ADD COLUMN IF NOT EXISTS category text NOT NULL,
    ADD COLUMN IF NOT EXISTS label text NOT NULL,
    ADD COLUMN IF NOT EXISTS description text,
    ADD COLUMN IF NOT EXISTS fallback_source text,
    ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now() NOT NULL,
    ADD COLUMN IF NOT EXISTS updated_by uuid,
    ADD COLUMN IF NOT EXISTS min_value numeric,
    ADD COLUMN IF NOT EXISTS max_value numeric,
    ADD COLUMN IF NOT EXISTS read_only boolean DEFAULT false NOT NULL,
    ADD COLUMN IF NOT EXISTS sensitive boolean DEFAULT false NOT NULL;

ALTER TABLE public.system_settings
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN key DROP DEFAULT,
    ALTER COLUMN value DROP DEFAULT,
    ALTER COLUMN value_type DROP DEFAULT,
    ALTER COLUMN category DROP DEFAULT,
    ALTER COLUMN label DROP DEFAULT,
    ALTER COLUMN description DROP DEFAULT,
    ALTER COLUMN fallback_source DROP DEFAULT,
    ALTER COLUMN updated_at SET DEFAULT now(),
    ALTER COLUMN updated_by DROP DEFAULT,
    ALTER COLUMN min_value DROP DEFAULT,
    ALTER COLUMN max_value DROP DEFAULT,
    ALTER COLUMN read_only SET DEFAULT false,
    ALTER COLUMN sensitive SET DEFAULT false;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'system_settings_key_format'
                AND conrelid = 'public.system_settings'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((key ~ ''^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$''::text))') THEN
    ALTER TABLE public.system_settings DROP CONSTRAINT system_settings_key_format;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'system_settings_key_format'
                    AND conrelid = 'public.system_settings'::regclass) THEN
    ALTER TABLE public.system_settings
        ADD CONSTRAINT system_settings_key_format CHECK ((key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'::text));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'system_settings_value_matches_type'
                AND conrelid = 'public.system_settings'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ( CASE value_type WHEN ''string''::text THEN (jsonb_typeof(value) = ''string''::text) WHEN ''number''::text THEN (jsonb_typeof(value) = ''number''::text) WHEN ''boolean''::text THEN (jsonb_typeof(value) = ''boolean''::text) WHEN ''json''::text THEN (jsonb_typeof(value) = ANY (ARRAY[''object''::text, ''array''::text])) ELSE NULL::boolean END)') THEN
    ALTER TABLE public.system_settings DROP CONSTRAINT system_settings_value_matches_type;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'system_settings_value_matches_type'
                    AND conrelid = 'public.system_settings'::regclass) THEN
    ALTER TABLE public.system_settings
        ADD CONSTRAINT system_settings_value_matches_type CHECK (
    CASE value_type
        WHEN 'string'::text THEN (jsonb_typeof(value) = 'string'::text)
        WHEN 'number'::text THEN (jsonb_typeof(value) = 'number'::text)
        WHEN 'boolean'::text THEN (jsonb_typeof(value) = 'boolean'::text)
        WHEN 'json'::text THEN (jsonb_typeof(value) = ANY (ARRAY['object'::text, 'array'::text]))
        ELSE NULL::boolean
    END);
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'system_settings_value_type_known'
                AND conrelid = 'public.system_settings'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK ((value_type = ANY (ARRAY[''string''::text, ''number''::text, ''boolean''::text, ''json''::text])))') THEN
    ALTER TABLE public.system_settings DROP CONSTRAINT system_settings_value_type_known;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'system_settings_value_type_known'
                    AND conrelid = 'public.system_settings'::regclass) THEN
    ALTER TABLE public.system_settings
        ADD CONSTRAINT system_settings_value_type_known CHECK ((value_type = ANY (ARRAY['string'::text, 'number'::text, 'boolean'::text, 'json'::text])));
  END IF;
END $c$;

DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'system_settings_value_within_bounds'
                AND conrelid = 'public.system_settings'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((value_type <> ''number''::text) OR (((min_value IS NULL) OR (((value #>> ''{}''::text[]))::numeric >= min_value)) AND ((max_value IS NULL) OR (((value #>> ''{}''::text[]))::numeric <= max_value)))))') THEN
    ALTER TABLE public.system_settings DROP CONSTRAINT system_settings_value_within_bounds;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'system_settings_value_within_bounds'
                    AND conrelid = 'public.system_settings'::regclass) THEN
    ALTER TABLE public.system_settings
        ADD CONSTRAINT system_settings_value_within_bounds CHECK (((value_type <> 'number'::text) OR (((min_value IS NULL) OR (((value #>> '{}'::text[]))::numeric >= min_value)) AND ((max_value IS NULL) OR (((value #>> '{}'::text[]))::numeric <= max_value)))));
  END IF;
END $c$;

--

-- TABLE system_settings :: COMMENT
COMMENT ON TABLE public.system_settings IS 'Runtime configuration an Administrator may change without a container restart. The key set is closed: RLS grants UPDATE only, and new keys arrive by migration beside the code that reads them. Nothing secret belongs here -- every authenticated user can read this table.';

--

-- COLUMN system_settings.min_value :: COMMENT
COMMENT ON COLUMN public.system_settings.min_value IS 'Inclusive lower bound for a number setting. NULL means unbounded. Enforced by CHECK, not by the reader: a value the table accepts and the consumer then ignores is a setting that lies.';

--

-- COLUMN system_settings.max_value :: COMMENT
COMMENT ON COLUMN public.system_settings.max_value IS 'Inclusive upper bound for a number setting. NULL means unbounded.';

--

-- COLUMN system_settings.read_only :: COMMENT
COMMENT ON COLUMN public.system_settings.read_only IS 'The value is fixed at install and shown for reference, not edited. The Settings page renders it without a control and system_settings_read_only_guard() refuses a write, so neither half depends on the other being present.';

--

-- COLUMN system_settings.sensitive :: COMMENT
COMMENT ON COLUMN public.system_settings.sensitive IS 'The row is readable by Administrators alone. For configuration that is not a secret but is not everyone''s business either -- where a site''s history is written, and under which identity. The secret itself is never here: it is in the vault.';

--

-- telemetry :: FOREIGN TABLE
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


ALTER FOREIGN TABLE timescale.telemetry OWNER TO postgres;

ALTER TABLE timescale.telemetry
    ADD COLUMN IF NOT EXISTS "time" timestamp with time zone NOT NULL,
    ADD COLUMN IF NOT EXISTS asset_id text NOT NULL,
    ADD COLUMN IF NOT EXISTS metric_name text NOT NULL,
    ADD COLUMN IF NOT EXISTS val_double double precision,
    ADD COLUMN IF NOT EXISTS val_string text,
    ADD COLUMN IF NOT EXISTS val_bool boolean;

ALTER TABLE timescale.telemetry
    ALTER COLUMN "time" DROP DEFAULT,
    ALTER COLUMN asset_id DROP DEFAULT,
    ALTER COLUMN metric_name DROP DEFAULT,
    ALTER COLUMN val_double DROP DEFAULT,
    ALTER COLUMN val_string DROP DEFAULT,
    ALTER COLUMN val_bool DROP DEFAULT;

--

-- telemetry :: VIEW
CREATE OR REPLACE VIEW public.telemetry WITH (security_invoker='true') AS
 SELECT "time",
    asset_id,
    metric_name,
    val_double,
    val_string,
    val_bool
   FROM timescale.telemetry;


ALTER VIEW public.telemetry OWNER TO postgres;

--

-- VIEW telemetry :: COMMENT
COMMENT ON VIEW public.telemetry IS 'Read-only PostgREST projection of the standalone TimescaleDB telemetry hypertable, reached over postgres_fdw. Filter with asset_id / metric_name / time and always pass a limit -- postgres_fdw pushes WHERE clauses to the remote but not LIMIT, so an unbounded query materialises the whole matching range locally.';

--

-- telemetry_1h :: FOREIGN TABLE
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


ALTER FOREIGN TABLE timescale.telemetry_1h OWNER TO postgres;

ALTER TABLE timescale.telemetry_1h
    ADD COLUMN IF NOT EXISTS bucket timestamp with time zone NOT NULL,
    ADD COLUMN IF NOT EXISTS asset_id text NOT NULL,
    ADD COLUMN IF NOT EXISTS metric_name text NOT NULL,
    ADD COLUMN IF NOT EXISTS sum_double double precision,
    ADD COLUMN IF NOT EXISTS n_double bigint,
    ADD COLUMN IF NOT EXISTS min_double double precision,
    ADD COLUMN IF NOT EXISTS max_double double precision,
    ADD COLUMN IF NOT EXISTS last_double double precision,
    ADD COLUMN IF NOT EXISTS last_string text,
    ADD COLUMN IF NOT EXISTS last_bool boolean,
    ADD COLUMN IF NOT EXISTS n_rows bigint;

ALTER TABLE timescale.telemetry_1h
    ALTER COLUMN bucket DROP DEFAULT,
    ALTER COLUMN asset_id DROP DEFAULT,
    ALTER COLUMN metric_name DROP DEFAULT,
    ALTER COLUMN sum_double DROP DEFAULT,
    ALTER COLUMN n_double DROP DEFAULT,
    ALTER COLUMN min_double DROP DEFAULT,
    ALTER COLUMN max_double DROP DEFAULT,
    ALTER COLUMN last_double DROP DEFAULT,
    ALTER COLUMN last_string DROP DEFAULT,
    ALTER COLUMN last_bool DROP DEFAULT,
    ALTER COLUMN n_rows DROP DEFAULT;

--

-- telemetry_1h :: VIEW
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


ALTER VIEW public.telemetry_1h OWNER TO postgres;

--

-- VIEW telemetry_1h :: COMMENT
COMMENT ON VIEW public.telemetry_1h IS 'Hourly rollup, aggregated from telemetry_5m. Retained far longer than the raw hypertable, so it answers questions about periods the raw retention window has already dropped.';

--

-- telemetry_1m :: FOREIGN TABLE
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


ALTER FOREIGN TABLE timescale.telemetry_1m OWNER TO postgres;

ALTER TABLE timescale.telemetry_1m
    ADD COLUMN IF NOT EXISTS bucket timestamp with time zone NOT NULL,
    ADD COLUMN IF NOT EXISTS asset_id text NOT NULL,
    ADD COLUMN IF NOT EXISTS metric_name text NOT NULL,
    ADD COLUMN IF NOT EXISTS sum_double double precision,
    ADD COLUMN IF NOT EXISTS n_double bigint,
    ADD COLUMN IF NOT EXISTS min_double double precision,
    ADD COLUMN IF NOT EXISTS max_double double precision,
    ADD COLUMN IF NOT EXISTS last_double double precision,
    ADD COLUMN IF NOT EXISTS last_string text,
    ADD COLUMN IF NOT EXISTS last_bool boolean,
    ADD COLUMN IF NOT EXISTS n_rows bigint;

ALTER TABLE timescale.telemetry_1m
    ALTER COLUMN bucket DROP DEFAULT,
    ALTER COLUMN asset_id DROP DEFAULT,
    ALTER COLUMN metric_name DROP DEFAULT,
    ALTER COLUMN sum_double DROP DEFAULT,
    ALTER COLUMN n_double DROP DEFAULT,
    ALTER COLUMN min_double DROP DEFAULT,
    ALTER COLUMN max_double DROP DEFAULT,
    ALTER COLUMN last_double DROP DEFAULT,
    ALTER COLUMN last_string DROP DEFAULT,
    ALTER COLUMN last_bool DROP DEFAULT,
    ALTER COLUMN n_rows DROP DEFAULT;

--

-- telemetry_1m :: VIEW
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


ALTER VIEW public.telemetry_1m OWNER TO postgres;

--

-- VIEW telemetry_1m :: COMMENT
COMMENT ON VIEW public.telemetry_1m IS 'One-minute rollup of the telemetry hypertable. avg_double is derived from the stored sum and count; min/max are preserved because an average hides the excursion. last_string/last_bool carry state metrics, which cannot be averaged. Filter with bucket / asset_id / metric_name.';

--

-- telemetry_5m :: FOREIGN TABLE
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


ALTER FOREIGN TABLE timescale.telemetry_5m OWNER TO postgres;

ALTER TABLE timescale.telemetry_5m
    ADD COLUMN IF NOT EXISTS bucket timestamp with time zone NOT NULL,
    ADD COLUMN IF NOT EXISTS asset_id text NOT NULL,
    ADD COLUMN IF NOT EXISTS metric_name text NOT NULL,
    ADD COLUMN IF NOT EXISTS sum_double double precision,
    ADD COLUMN IF NOT EXISTS n_double bigint,
    ADD COLUMN IF NOT EXISTS min_double double precision,
    ADD COLUMN IF NOT EXISTS max_double double precision,
    ADD COLUMN IF NOT EXISTS last_double double precision,
    ADD COLUMN IF NOT EXISTS last_string text,
    ADD COLUMN IF NOT EXISTS last_bool boolean,
    ADD COLUMN IF NOT EXISTS n_rows bigint;

ALTER TABLE timescale.telemetry_5m
    ALTER COLUMN bucket DROP DEFAULT,
    ALTER COLUMN asset_id DROP DEFAULT,
    ALTER COLUMN metric_name DROP DEFAULT,
    ALTER COLUMN sum_double DROP DEFAULT,
    ALTER COLUMN n_double DROP DEFAULT,
    ALTER COLUMN min_double DROP DEFAULT,
    ALTER COLUMN max_double DROP DEFAULT,
    ALTER COLUMN last_double DROP DEFAULT,
    ALTER COLUMN last_string DROP DEFAULT,
    ALTER COLUMN last_bool DROP DEFAULT,
    ALTER COLUMN n_rows DROP DEFAULT;

--

-- telemetry_5m :: VIEW
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


ALTER VIEW public.telemetry_5m OWNER TO postgres;

--

-- VIEW telemetry_5m :: COMMENT
COMMENT ON VIEW public.telemetry_5m IS 'Five-minute rollup, aggregated from telemetry_1m. See telemetry_1m.';

--

-- telemetry_horizons :: FOREIGN TABLE
CREATE FOREIGN TABLE IF NOT EXISTS timescale.telemetry_horizons (
    relation text NOT NULL,
    oldest timestamp with time zone
)
SERVER timescaledb_server
OPTIONS (
    schema_name 'public',
    table_name 'telemetry_horizons'
);


ALTER FOREIGN TABLE timescale.telemetry_horizons OWNER TO postgres;

ALTER TABLE timescale.telemetry_horizons
    ADD COLUMN IF NOT EXISTS relation text NOT NULL,
    ADD COLUMN IF NOT EXISTS oldest timestamp with time zone;

ALTER TABLE timescale.telemetry_horizons
    ALTER COLUMN relation DROP DEFAULT,
    ALTER COLUMN oldest DROP DEFAULT;

--

-- telemetry_horizons :: VIEW
CREATE OR REPLACE VIEW public.telemetry_horizons WITH (security_invoker='true') AS
 SELECT relation,
    oldest
   FROM timescale.telemetry_horizons t;


ALTER VIEW public.telemetry_horizons OWNER TO postgres;

--

-- VIEW telemetry_horizons :: COMMENT
COMMENT ON VIEW public.telemetry_horizons IS 'Oldest timestamp held by each telemetry resolution: `telemetry` (raw) and the `telemetry_1m`, `telemetry_5m` and `telemetry_1h` rollups. Four rows, evaluated on the TimescaleDB side. What is HELD, not what the retention policy promises -- a young stack holds less than its policy allows, and a widened policy does not restore dropped chunks. A null `oldest` means that relation is empty. Read by the telemetry export dialog to say which resolutions still cover a chosen range.';

--

-- telemetry_latest :: FOREIGN TABLE
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


ALTER FOREIGN TABLE timescale.telemetry_latest OWNER TO postgres;

ALTER TABLE timescale.telemetry_latest
    ADD COLUMN IF NOT EXISTS "time" timestamp with time zone NOT NULL,
    ADD COLUMN IF NOT EXISTS asset_id text NOT NULL,
    ADD COLUMN IF NOT EXISTS metric_name text NOT NULL,
    ADD COLUMN IF NOT EXISTS val_double double precision,
    ADD COLUMN IF NOT EXISTS val_string text,
    ADD COLUMN IF NOT EXISTS val_bool boolean;

ALTER TABLE timescale.telemetry_latest
    ALTER COLUMN "time" DROP DEFAULT,
    ALTER COLUMN asset_id DROP DEFAULT,
    ALTER COLUMN metric_name DROP DEFAULT,
    ALTER COLUMN val_double DROP DEFAULT,
    ALTER COLUMN val_string DROP DEFAULT,
    ALTER COLUMN val_bool DROP DEFAULT;

--

-- telemetry_latest :: VIEW
CREATE OR REPLACE VIEW public.telemetry_latest WITH (security_invoker='true') AS
 SELECT "time",
    asset_id,
    metric_name,
    val_double,
    val_string,
    val_bool
   FROM timescale.telemetry_latest t;


ALTER VIEW public.telemetry_latest OWNER TO postgres;

--

-- VIEW telemetry_latest :: COMMENT
COMMENT ON VIEW public.telemetry_latest IS 'Newest sample per (asset_id, metric_name), evaluated on the TimescaleDB side so postgres_fdw ships one row per series instead of a time window. Filter with asset_id. This is what the dashboard''s latest-value routes read; public.telemetry remains the raw record for exports.';

--

-- user_roles :: TABLE
CREATE TABLE IF NOT EXISTS public.user_roles (
    user_id text NOT NULL,
    role_id integer NOT NULL
);


ALTER TABLE public.user_roles OWNER TO postgres;

ALTER TABLE public.user_roles
    ADD COLUMN IF NOT EXISTS user_id text NOT NULL,
    ADD COLUMN IF NOT EXISTS role_id integer NOT NULL;

ALTER TABLE public.user_roles
    ALTER COLUMN user_id DROP DEFAULT,
    ALTER COLUMN role_id DROP DEFAULT;

--

-- TABLE user_roles :: COMMENT
COMMENT ON TABLE public.user_roles IS 'Role assignment per person. A machine principal, an auth.users row that cannot sign in, holds no role: refuse_role_for_machine_principal() refuses one, and has_authority() resolves its grants through principal_permissions. Three are seeded, each granted telemetry:read: b0000000-0000-4000-8000-000000000001, the read-only principal the MCP client authenticates as; b0000000-0000-4000-8000-000000000002, Service_Ingestor, the identity the ingestion daemon authenticates as; and b0000000-0000-4000-8000-000000000003, Service_Playback, the identity the playback worker authenticates as. The two services write through SECURITY DEFINER gates that check which of them is calling.';

--

-- webhook_endpoints :: TABLE
CREATE TABLE IF NOT EXISTS public.webhook_endpoints (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_key text NOT NULL,
    url text NOT NULL,
    secret_name text,
    is_enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.webhook_endpoints OWNER TO postgres;

ALTER TABLE public.webhook_endpoints
    ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid() NOT NULL,
    ADD COLUMN IF NOT EXISTS event_key text NOT NULL,
    ADD COLUMN IF NOT EXISTS url text NOT NULL,
    ADD COLUMN IF NOT EXISTS secret_name text,
    ADD COLUMN IF NOT EXISTS is_enabled boolean DEFAULT true NOT NULL,
    ADD COLUMN IF NOT EXISTS created_at timestamp with time zone DEFAULT now() NOT NULL;

ALTER TABLE public.webhook_endpoints
    ALTER COLUMN id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN event_key DROP DEFAULT,
    ALTER COLUMN url DROP DEFAULT,
    ALTER COLUMN secret_name DROP DEFAULT,
    ALTER COLUMN is_enabled SET DEFAULT true,
    ALTER COLUMN created_at SET DEFAULT now();

--

-- TABLE webhook_endpoints :: COMMENT
COMMENT ON TABLE public.webhook_endpoints IS 'Outbound webhook targets. Managed by migration only -- there is deliberately no INSERT/UPDATE/DELETE RLS policy, so no API caller can point the database at a host of their choosing.';

--

-- physical_backup_requests :: FOREIGN TABLE
CREATE FOREIGN TABLE IF NOT EXISTS timescale.physical_backup_requests (
    id bigint,
    requested_at timestamp with time zone,
    job_id text,
    claimed_at timestamp with time zone
)
SERVER timescaledb_server
OPTIONS (
    schema_name 'public',
    table_name 'physical_backup_requests'
);


ALTER FOREIGN TABLE timescale.physical_backup_requests OWNER TO postgres;

ALTER TABLE timescale.physical_backup_requests
    ADD COLUMN IF NOT EXISTS id bigint,
    ADD COLUMN IF NOT EXISTS requested_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS job_id text,
    ADD COLUMN IF NOT EXISTS claimed_at timestamp with time zone;

ALTER TABLE timescale.physical_backup_requests
    ALTER COLUMN id DROP DEFAULT,
    ALTER COLUMN requested_at DROP DEFAULT,
    ALTER COLUMN job_id DROP DEFAULT,
    ALTER COLUMN claimed_at DROP DEFAULT;

--

-- physical_backup_runs :: FOREIGN TABLE
CREATE FOREIGN TABLE IF NOT EXISTS timescale.physical_backup_runs (
    id bigint,
    kind text,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    succeeded boolean,
    detail text,
    label text,
    database_bytes bigint,
    backup_bytes bigint,
    repo_bytes bigint
)
SERVER timescaledb_server
OPTIONS (
    schema_name 'public',
    table_name 'physical_backup_runs'
);


ALTER FOREIGN TABLE timescale.physical_backup_runs OWNER TO postgres;

ALTER TABLE timescale.physical_backup_runs
    ADD COLUMN IF NOT EXISTS id bigint,
    ADD COLUMN IF NOT EXISTS kind text,
    ADD COLUMN IF NOT EXISTS started_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS finished_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS succeeded boolean,
    ADD COLUMN IF NOT EXISTS detail text,
    ADD COLUMN IF NOT EXISTS label text,
    ADD COLUMN IF NOT EXISTS database_bytes bigint,
    ADD COLUMN IF NOT EXISTS backup_bytes bigint,
    ADD COLUMN IF NOT EXISTS repo_bytes bigint;

ALTER TABLE timescale.physical_backup_runs
    ALTER COLUMN id DROP DEFAULT,
    ALTER COLUMN kind DROP DEFAULT,
    ALTER COLUMN started_at DROP DEFAULT,
    ALTER COLUMN finished_at DROP DEFAULT,
    ALTER COLUMN succeeded DROP DEFAULT,
    ALTER COLUMN detail DROP DEFAULT,
    ALTER COLUMN label DROP DEFAULT,
    ALTER COLUMN database_bytes DROP DEFAULT,
    ALTER COLUMN backup_bytes DROP DEFAULT,
    ALTER COLUMN repo_bytes DROP DEFAULT;

--

-- physical_backup_schedule :: FOREIGN TABLE
CREATE FOREIGN TABLE IF NOT EXISTS timescale.physical_backup_schedule (
    hour_utc integer,
    full_on integer,
    recorded_at timestamp with time zone
)
SERVER timescaledb_server
OPTIONS (
    schema_name 'public',
    table_name 'physical_backup_schedule'
);


ALTER FOREIGN TABLE timescale.physical_backup_schedule OWNER TO postgres;

ALTER TABLE timescale.physical_backup_schedule
    ADD COLUMN IF NOT EXISTS hour_utc integer,
    ADD COLUMN IF NOT EXISTS full_on integer,
    ADD COLUMN IF NOT EXISTS recorded_at timestamp with time zone;

ALTER TABLE timescale.physical_backup_schedule
    ALTER COLUMN hour_utc DROP DEFAULT,
    ALTER COLUMN full_on DROP DEFAULT,
    ALTER COLUMN recorded_at DROP DEFAULT;

--

-- telemetry_archive_manifest :: FOREIGN TABLE
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


ALTER FOREIGN TABLE timescale.telemetry_archive_manifest OWNER TO postgres;

ALTER TABLE timescale.telemetry_archive_manifest
    ADD COLUMN IF NOT EXISTS chunk_schema text,
    ADD COLUMN IF NOT EXISTS chunk_name text,
    ADD COLUMN IF NOT EXISTS range_start timestamp with time zone,
    ADD COLUMN IF NOT EXISTS range_end timestamp with time zone,
    ADD COLUMN IF NOT EXISTS row_count bigint,
    ADD COLUMN IF NOT EXISTS object_key text,
    ADD COLUMN IF NOT EXISTS object_bytes bigint,
    ADD COLUMN IF NOT EXISTS object_etag text,
    ADD COLUMN IF NOT EXISTS format text,
    ADD COLUMN IF NOT EXISTS claimed_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS exported_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS verified_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS dropped_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS last_error text;

ALTER TABLE timescale.telemetry_archive_manifest
    ALTER COLUMN chunk_schema DROP DEFAULT,
    ALTER COLUMN chunk_name DROP DEFAULT,
    ALTER COLUMN range_start DROP DEFAULT,
    ALTER COLUMN range_end DROP DEFAULT,
    ALTER COLUMN row_count DROP DEFAULT,
    ALTER COLUMN object_key DROP DEFAULT,
    ALTER COLUMN object_bytes DROP DEFAULT,
    ALTER COLUMN object_etag DROP DEFAULT,
    ALTER COLUMN format DROP DEFAULT,
    ALTER COLUMN claimed_at DROP DEFAULT,
    ALTER COLUMN exported_at DROP DEFAULT,
    ALTER COLUMN verified_at DROP DEFAULT,
    ALTER COLUMN dropped_at DROP DEFAULT,
    ALTER COLUMN last_error DROP DEFAULT;

--

-- telemetry_raw_window :: FOREIGN TABLE
CREATE FOREIGN TABLE IF NOT EXISTS timescale.telemetry_raw_window (
    raw_window interval,
    archive_armed boolean,
    archive_reported_at timestamp with time zone
)
SERVER timescaledb_server
OPTIONS (
    schema_name 'public',
    table_name 'telemetry_raw_window'
);


ALTER FOREIGN TABLE timescale.telemetry_raw_window OWNER TO postgres;

ALTER TABLE timescale.telemetry_raw_window
    ADD COLUMN IF NOT EXISTS raw_window interval,
    ADD COLUMN IF NOT EXISTS archive_armed boolean,
    ADD COLUMN IF NOT EXISTS archive_reported_at timestamp with time zone;

ALTER TABLE timescale.telemetry_raw_window
    ALTER COLUMN raw_window DROP DEFAULT,
    ALTER COLUMN archive_armed DROP DEFAULT,
    ALTER COLUMN archive_reported_at DROP DEFAULT;

--

-- audit_trail id :: DEFAULT
ALTER TABLE public.audit_trail ALTER COLUMN id SET DEFAULT nextval('public.audit_trail_id_seq'::regclass);

--

-- roles id :: DEFAULT
ALTER TABLE ONLY public.roles ALTER COLUMN id SET DEFAULT nextval('public.roles_id_seq'::regclass);

--

-- areas areas_name_key :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'areas_name_key'
                AND conrelid = 'public.areas'::regclass
                AND pg_get_constraintdef(oid) <> 'UNIQUE (name)') THEN
    ALTER TABLE public.areas DROP CONSTRAINT areas_name_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'areas_name_key'
                    AND conrelid = 'public.areas'::regclass) THEN
    ALTER TABLE ONLY public.areas
        ADD CONSTRAINT areas_name_key UNIQUE (name);
  END IF;
END $c$;

--

-- areas areas_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'areas_pkey'
                AND conrelid = 'public.areas'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.areas DROP CONSTRAINT areas_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'areas_pkey'
                    AND conrelid = 'public.areas'::regclass) THEN
    ALTER TABLE ONLY public.areas
        ADD CONSTRAINT areas_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- ashrae223_vocabulary ashrae223_vocabulary_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'ashrae223_vocabulary_pkey'
                AND conrelid = 'public.ashrae223_vocabulary'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (name)') THEN
    ALTER TABLE public.ashrae223_vocabulary DROP CONSTRAINT ashrae223_vocabulary_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'ashrae223_vocabulary_pkey'
                    AND conrelid = 'public.ashrae223_vocabulary'::regclass) THEN
    ALTER TABLE ONLY public.ashrae223_vocabulary
        ADD CONSTRAINT ashrae223_vocabulary_pkey PRIMARY KEY (name);
  END IF;
END $c$;

--

-- asset_config asset_config_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'asset_config_pkey'
                AND conrelid = 'public.asset_config'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.asset_config DROP CONSTRAINT asset_config_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'asset_config_pkey'
                    AND conrelid = 'public.asset_config'::regclass) THEN
    ALTER TABLE ONLY public.asset_config
        ADD CONSTRAINT asset_config_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- asset_exports asset_exports_object_unique :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'asset_exports_object_unique'
                AND conrelid = 'public.asset_exports'::regclass
                AND pg_get_constraintdef(oid) <> 'UNIQUE (object_bucket, object_key)') THEN
    ALTER TABLE public.asset_exports DROP CONSTRAINT asset_exports_object_unique;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'asset_exports_object_unique'
                    AND conrelid = 'public.asset_exports'::regclass) THEN
    ALTER TABLE ONLY public.asset_exports
        ADD CONSTRAINT asset_exports_object_unique UNIQUE (object_bucket, object_key);
  END IF;
END $c$;

--

-- asset_exports asset_exports_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'asset_exports_pkey'
                AND conrelid = 'public.asset_exports'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.asset_exports DROP CONSTRAINT asset_exports_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'asset_exports_pkey'
                    AND conrelid = 'public.asset_exports'::regclass) THEN
    ALTER TABLE ONLY public.asset_exports
        ADD CONSTRAINT asset_exports_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- audit_trail audit_trail_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'audit_trail_pkey'
                AND conrelid = 'public.audit_trail'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id, recorded_at)') THEN
    ALTER TABLE public.audit_trail DROP CONSTRAINT audit_trail_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'audit_trail_pkey'
                    AND conrelid = 'public.audit_trail'::regclass) THEN
    ALTER TABLE public.audit_trail
        ADD CONSTRAINT audit_trail_pkey PRIMARY KEY (id, recorded_at);
  END IF;
END $c$;

--

-- backup_jobs backup_jobs_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'backup_jobs_pkey'
                AND conrelid = 'public.backup_jobs'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.backup_jobs DROP CONSTRAINT backup_jobs_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'backup_jobs_pkey'
                    AND conrelid = 'public.backup_jobs'::regclass) THEN
    ALTER TABLE ONLY public.backup_jobs
        ADD CONSTRAINT backup_jobs_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- backups backups_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'backups_pkey'
                AND conrelid = 'public.backups'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.backups DROP CONSTRAINT backups_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'backups_pkey'
                    AND conrelid = 'public.backups'::regclass) THEN
    ALTER TABLE ONLY public.backups
        ADD CONSTRAINT backups_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- backups backups_stamp_key :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'backups_stamp_key'
                AND conrelid = 'public.backups'::regclass
                AND pg_get_constraintdef(oid) <> 'UNIQUE (stamp)') THEN
    ALTER TABLE public.backups DROP CONSTRAINT backups_stamp_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'backups_stamp_key'
                    AND conrelid = 'public.backups'::regclass) THEN
    ALTER TABLE ONLY public.backups
        ADD CONSTRAINT backups_stamp_key UNIQUE (stamp);
  END IF;
END $c$;

--

-- capture_jobs capture_jobs_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'capture_jobs_pkey'
                AND conrelid = 'public.capture_jobs'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.capture_jobs DROP CONSTRAINT capture_jobs_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'capture_jobs_pkey'
                    AND conrelid = 'public.capture_jobs'::regclass) THEN
    ALTER TABLE ONLY public.capture_jobs
        ADD CONSTRAINT capture_jobs_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- captures captures_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'captures_pkey'
                AND conrelid = 'public.captures'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.captures DROP CONSTRAINT captures_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'captures_pkey'
                    AND conrelid = 'public.captures'::regclass) THEN
    ALTER TABLE ONLY public.captures
        ADD CONSTRAINT captures_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- captures captures_storage_path_key :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'captures_storage_path_key'
                AND conrelid = 'public.captures'::regclass
                AND pg_get_constraintdef(oid) <> 'UNIQUE (storage_path)') THEN
    ALTER TABLE public.captures DROP CONSTRAINT captures_storage_path_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'captures_storage_path_key'
                    AND conrelid = 'public.captures'::regclass) THEN
    ALTER TABLE ONLY public.captures
        ADD CONSTRAINT captures_storage_path_key UNIQUE (storage_path);
  END IF;
END $c$;

--

-- cells cells_name_key :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'cells_name_key'
                AND conrelid = 'public.cells'::regclass
                AND pg_get_constraintdef(oid) <> 'UNIQUE (name)') THEN
    ALTER TABLE public.cells DROP CONSTRAINT cells_name_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'cells_name_key'
                    AND conrelid = 'public.cells'::regclass) THEN
    ALTER TABLE ONLY public.cells
        ADD CONSTRAINT cells_name_key UNIQUE (name);
  END IF;
END $c$;

--

-- cells cells_name_topic_safe :: CHECK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'cells_name_topic_safe'
                AND conrelid = 'public.cells'::regclass
                AND pg_get_constraintdef(oid) <> 'CHECK (((name <> ''''::text) AND (name !~ ''[/+#]''::text))) NOT VALID') THEN
    ALTER TABLE public.cells DROP CONSTRAINT cells_name_topic_safe;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'cells_name_topic_safe'
                    AND conrelid = 'public.cells'::regclass) THEN
    ALTER TABLE public.cells
        ADD CONSTRAINT cells_name_topic_safe CHECK (((name <> ''::text) AND (name !~ '[/+#]'::text))) NOT VALID;
  END IF;
END $c$;

--

-- cells cells_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'cells_pkey'
                AND conrelid = 'public.cells'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.cells DROP CONSTRAINT cells_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'cells_pkey'
                    AND conrelid = 'public.cells'::regclass) THEN
    ALTER TABLE ONLY public.cells
        ADD CONSTRAINT cells_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- change_proposals change_proposals_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'change_proposals_pkey'
                AND conrelid = 'public.change_proposals'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.change_proposals DROP CONSTRAINT change_proposals_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'change_proposals_pkey'
                    AND conrelid = 'public.change_proposals'::regclass) THEN
    ALTER TABLE ONLY public.change_proposals
        ADD CONSTRAINT change_proposals_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- device_nameplate device_nameplate_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'device_nameplate_pkey'
                AND conrelid = 'public.device_nameplate'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (device_id)') THEN
    ALTER TABLE public.device_nameplate DROP CONSTRAINT device_nameplate_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'device_nameplate_pkey'
                    AND conrelid = 'public.device_nameplate'::regclass) THEN
    ALTER TABLE ONLY public.device_nameplate
        ADD CONSTRAINT device_nameplate_pkey PRIMARY KEY (device_id);
  END IF;
END $c$;

--

-- device_submodels device_submodels_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'device_submodels_pkey'
                AND conrelid = 'public.device_submodels'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.device_submodels DROP CONSTRAINT device_submodels_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'device_submodels_pkey'
                    AND conrelid = 'public.device_submodels'::regclass) THEN
    ALTER TABLE ONLY public.device_submodels
        ADD CONSTRAINT device_submodels_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- devices devices_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'devices_pkey'
                AND conrelid = 'public.devices'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.devices DROP CONSTRAINT devices_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'devices_pkey'
                    AND conrelid = 'public.devices'::regclass) THEN
    ALTER TABLE ONLY public.devices
        ADD CONSTRAINT devices_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- directory_liveness_probe directory_liveness_probe_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'directory_liveness_probe_pkey'
                AND conrelid = 'public.directory_liveness_probe'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.directory_liveness_probe DROP CONSTRAINT directory_liveness_probe_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'directory_liveness_probe_pkey'
                    AND conrelid = 'public.directory_liveness_probe'::regclass) THEN
    ALTER TABLE ONLY public.directory_liveness_probe
        ADD CONSTRAINT directory_liveness_probe_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- directory_services directory_services_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'directory_services_pkey'
                AND conrelid = 'public.directory_services'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.directory_services DROP CONSTRAINT directory_services_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'directory_services_pkey'
                    AND conrelid = 'public.directory_services'::regclass) THEN
    ALTER TABLE ONLY public.directory_services
        ADD CONSTRAINT directory_services_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- directory_services directory_services_service_name_key :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'directory_services_service_name_key'
                AND conrelid = 'public.directory_services'::regclass
                AND pg_get_constraintdef(oid) <> 'UNIQUE (service_name)') THEN
    ALTER TABLE public.directory_services DROP CONSTRAINT directory_services_service_name_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'directory_services_service_name_key'
                    AND conrelid = 'public.directory_services'::regclass) THEN
    ALTER TABLE ONLY public.directory_services
        ADD CONSTRAINT directory_services_service_name_key UNIQUE (service_name);
  END IF;
END $c$;

--

-- forge_sweep_lease forge_sweep_lease_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'forge_sweep_lease_pkey'
                AND conrelid = 'public.forge_sweep_lease'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.forge_sweep_lease DROP CONSTRAINT forge_sweep_lease_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'forge_sweep_lease_pkey'
                    AND conrelid = 'public.forge_sweep_lease'::regclass) THEN
    ALTER TABLE ONLY public.forge_sweep_lease
        ADD CONSTRAINT forge_sweep_lease_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- gateway_enrollment_tokens gateway_enrollment_tokens_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'gateway_enrollment_tokens_pkey'
                AND conrelid = 'public.gateway_enrollment_tokens'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.gateway_enrollment_tokens DROP CONSTRAINT gateway_enrollment_tokens_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gateway_enrollment_tokens_pkey'
                    AND conrelid = 'public.gateway_enrollment_tokens'::regclass) THEN
    ALTER TABLE ONLY public.gateway_enrollment_tokens
        ADD CONSTRAINT gateway_enrollment_tokens_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- gateway_revocation_requests gateway_revocation_requests_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'gateway_revocation_requests_pkey'
                AND conrelid = 'public.gateway_revocation_requests'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (gateway_id)') THEN
    ALTER TABLE public.gateway_revocation_requests DROP CONSTRAINT gateway_revocation_requests_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gateway_revocation_requests_pkey'
                    AND conrelid = 'public.gateway_revocation_requests'::regclass) THEN
    ALTER TABLE ONLY public.gateway_revocation_requests
        ADD CONSTRAINT gateway_revocation_requests_pkey PRIMARY KEY (gateway_id);
  END IF;
END $c$;

--

-- gateways gateways_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'gateways_pkey'
                AND conrelid = 'public.gateways'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.gateways DROP CONSTRAINT gateways_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gateways_pkey'
                    AND conrelid = 'public.gateways'::regclass) THEN
    ALTER TABLE ONLY public.gateways
        ADD CONSTRAINT gateways_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- idta_submodel_templates idta_submodel_templates_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'idta_submodel_templates_pkey'
                AND conrelid = 'public.idta_submodel_templates'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (template_id, id_short)') THEN
    ALTER TABLE public.idta_submodel_templates DROP CONSTRAINT idta_submodel_templates_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'idta_submodel_templates_pkey'
                    AND conrelid = 'public.idta_submodel_templates'::regclass) THEN
    ALTER TABLE ONLY public.idta_submodel_templates
        ADD CONSTRAINT idta_submodel_templates_pkey PRIMARY KEY (template_id, id_short);
  END IF;
END $c$;

--

-- iso22400_vocabulary iso22400_vocabulary_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'iso22400_vocabulary_pkey'
                AND conrelid = 'public.iso22400_vocabulary'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (name)') THEN
    ALTER TABLE public.iso22400_vocabulary DROP CONSTRAINT iso22400_vocabulary_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'iso22400_vocabulary_pkey'
                    AND conrelid = 'public.iso22400_vocabulary'::regclass) THEN
    ALTER TABLE ONLY public.iso22400_vocabulary
        ADD CONSTRAINT iso22400_vocabulary_pkey PRIMARY KEY (name);
  END IF;
END $c$;

--

-- links links_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'links_pkey'
                AND conrelid = 'public.links'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.links DROP CONSTRAINT links_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'links_pkey'
                    AND conrelid = 'public.links'::regclass) THEN
    ALTER TABLE ONLY public.links
        ADD CONSTRAINT links_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- machine_principals machine_principals_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'machine_principals_pkey'
                AND conrelid = 'public.machine_principals'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (principal_id)') THEN
    ALTER TABLE public.machine_principals DROP CONSTRAINT machine_principals_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'machine_principals_pkey'
                    AND conrelid = 'public.machine_principals'::regclass) THEN
    ALTER TABLE ONLY public.machine_principals
        ADD CONSTRAINT machine_principals_pkey PRIMARY KEY (principal_id);
  END IF;
END $c$;

--

-- metric_catalog metric_catalog_name_key :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'metric_catalog_name_key'
                AND conrelid = 'public.metric_catalog'::regclass
                AND pg_get_constraintdef(oid) <> 'UNIQUE (name)') THEN
    ALTER TABLE public.metric_catalog DROP CONSTRAINT metric_catalog_name_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'metric_catalog_name_key'
                    AND conrelid = 'public.metric_catalog'::regclass) THEN
    ALTER TABLE ONLY public.metric_catalog
        ADD CONSTRAINT metric_catalog_name_key UNIQUE (name);
  END IF;
END $c$;

--

-- metric_catalog metric_catalog_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'metric_catalog_pkey'
                AND conrelid = 'public.metric_catalog'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.metric_catalog DROP CONSTRAINT metric_catalog_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'metric_catalog_pkey'
                    AND conrelid = 'public.metric_catalog'::regclass) THEN
    ALTER TABLE ONLY public.metric_catalog
        ADD CONSTRAINT metric_catalog_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- metric_groups metric_groups_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'metric_groups_pkey'
                AND conrelid = 'public.metric_groups'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.metric_groups DROP CONSTRAINT metric_groups_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'metric_groups_pkey'
                    AND conrelid = 'public.metric_groups'::regclass) THEN
    ALTER TABLE ONLY public.metric_groups
        ADD CONSTRAINT metric_groups_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- mtconnect_vocabulary mtconnect_vocabulary_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'mtconnect_vocabulary_pkey'
                AND conrelid = 'public.mtconnect_vocabulary'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (kind, name)') THEN
    ALTER TABLE public.mtconnect_vocabulary DROP CONSTRAINT mtconnect_vocabulary_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'mtconnect_vocabulary_pkey'
                    AND conrelid = 'public.mtconnect_vocabulary'::regclass) THEN
    ALTER TABLE ONLY public.mtconnect_vocabulary
        ADD CONSTRAINT mtconnect_vocabulary_pkey PRIMARY KEY (kind, name);
  END IF;
END $c$;

--

-- one_shot_migrations one_shot_migrations_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'one_shot_migrations_pkey'
                AND conrelid = 'public.one_shot_migrations'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (key)') THEN
    ALTER TABLE public.one_shot_migrations DROP CONSTRAINT one_shot_migrations_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'one_shot_migrations_pkey'
                    AND conrelid = 'public.one_shot_migrations'::regclass) THEN
    ALTER TABLE ONLY public.one_shot_migrations
        ADD CONSTRAINT one_shot_migrations_pkey PRIMARY KEY (key);
  END IF;
END $c$;

--

-- opcua_vocabulary opcua_vocabulary_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'opcua_vocabulary_pkey'
                AND conrelid = 'public.opcua_vocabulary'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (companion_spec, name)') THEN
    ALTER TABLE public.opcua_vocabulary DROP CONSTRAINT opcua_vocabulary_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'opcua_vocabulary_pkey'
                    AND conrelid = 'public.opcua_vocabulary'::regclass) THEN
    ALTER TABLE ONLY public.opcua_vocabulary
        ADD CONSTRAINT opcua_vocabulary_pkey PRIMARY KEY (companion_spec, name);
  END IF;
END $c$;

--

-- permissions permissions_name_key :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'permissions_name_key'
                AND conrelid = 'public.permissions'::regclass
                AND pg_get_constraintdef(oid) <> 'UNIQUE (name)') THEN
    ALTER TABLE public.permissions DROP CONSTRAINT permissions_name_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'permissions_name_key'
                    AND conrelid = 'public.permissions'::regclass) THEN
    ALTER TABLE ONLY public.permissions
        ADD CONSTRAINT permissions_name_key UNIQUE (name);
  END IF;
END $c$;

--

-- permissions permissions_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'permissions_pkey'
                AND conrelid = 'public.permissions'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.permissions DROP CONSTRAINT permissions_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'permissions_pkey'
                    AND conrelid = 'public.permissions'::regclass) THEN
    ALTER TABLE ONLY public.permissions
        ADD CONSTRAINT permissions_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- platform_alerts platform_alerts_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'platform_alerts_pkey'
                AND conrelid = 'public.platform_alerts'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.platform_alerts DROP CONSTRAINT platform_alerts_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'platform_alerts_pkey'
                    AND conrelid = 'public.platform_alerts'::regclass) THEN
    ALTER TABLE ONLY public.platform_alerts
        ADD CONSTRAINT platform_alerts_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- playback_jobs playback_jobs_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'playback_jobs_pkey'
                AND conrelid = 'public.playback_jobs'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.playback_jobs DROP CONSTRAINT playback_jobs_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'playback_jobs_pkey'
                    AND conrelid = 'public.playback_jobs'::regclass) THEN
    ALTER TABLE ONLY public.playback_jobs
        ADD CONSTRAINT playback_jobs_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- playback_worker_status playback_worker_status_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'playback_worker_status_pkey'
                AND conrelid = 'public.playback_worker_status'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.playback_worker_status DROP CONSTRAINT playback_worker_status_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'playback_worker_status_pkey'
                    AND conrelid = 'public.playback_worker_status'::regclass) THEN
    ALTER TABLE ONLY public.playback_worker_status
        ADD CONSTRAINT playback_worker_status_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- principal_permissions principal_permissions_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'principal_permissions_pkey'
                AND conrelid = 'public.principal_permissions'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (principal_id, permission_id)') THEN
    ALTER TABLE public.principal_permissions DROP CONSTRAINT principal_permissions_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'principal_permissions_pkey'
                    AND conrelid = 'public.principal_permissions'::regclass) THEN
    ALTER TABLE ONLY public.principal_permissions
        ADD CONSTRAINT principal_permissions_pkey PRIMARY KEY (principal_id, permission_id);
  END IF;
END $c$;

--

-- rebirth_requests rebirth_requests_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'rebirth_requests_pkey'
                AND conrelid = 'public.rebirth_requests'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.rebirth_requests DROP CONSTRAINT rebirth_requests_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'rebirth_requests_pkey'
                    AND conrelid = 'public.rebirth_requests'::regclass) THEN
    ALTER TABLE ONLY public.rebirth_requests
        ADD CONSTRAINT rebirth_requests_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- retired_entities retired_entities_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'retired_entities_pkey'
                AND conrelid = 'public.retired_entities'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (entity_type, entity_id)') THEN
    ALTER TABLE public.retired_entities DROP CONSTRAINT retired_entities_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'retired_entities_pkey'
                    AND conrelid = 'public.retired_entities'::regclass) THEN
    ALTER TABLE ONLY public.retired_entities
        ADD CONSTRAINT retired_entities_pkey PRIMARY KEY (entity_type, entity_id);
  END IF;
END $c$;

--

-- revoked_service_principals revoked_service_principals_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'revoked_service_principals_pkey'
                AND conrelid = 'public.revoked_service_principals'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (principal_id)') THEN
    ALTER TABLE public.revoked_service_principals DROP CONSTRAINT revoked_service_principals_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'revoked_service_principals_pkey'
                    AND conrelid = 'public.revoked_service_principals'::regclass) THEN
    ALTER TABLE ONLY public.revoked_service_principals
        ADD CONSTRAINT revoked_service_principals_pkey PRIMARY KEY (principal_id);
  END IF;
END $c$;

--

-- revoked_service_tokens revoked_service_tokens_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'revoked_service_tokens_pkey'
                AND conrelid = 'public.revoked_service_tokens'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (jti)') THEN
    ALTER TABLE public.revoked_service_tokens DROP CONSTRAINT revoked_service_tokens_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'revoked_service_tokens_pkey'
                    AND conrelid = 'public.revoked_service_tokens'::regclass) THEN
    ALTER TABLE ONLY public.revoked_service_tokens
        ADD CONSTRAINT revoked_service_tokens_pkey PRIMARY KEY (jti);
  END IF;
END $c$;

--

-- role_permissions role_permissions_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'role_permissions_pkey'
                AND conrelid = 'public.role_permissions'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (role_id, permission_id)') THEN
    ALTER TABLE public.role_permissions DROP CONSTRAINT role_permissions_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'role_permissions_pkey'
                    AND conrelid = 'public.role_permissions'::regclass) THEN
    ALTER TABLE ONLY public.role_permissions
        ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (role_id, permission_id);
  END IF;
END $c$;

--

-- roles roles_name_key :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'roles_name_key'
                AND conrelid = 'public.roles'::regclass
                AND pg_get_constraintdef(oid) <> 'UNIQUE (name)') THEN
    ALTER TABLE public.roles DROP CONSTRAINT roles_name_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'roles_name_key'
                    AND conrelid = 'public.roles'::regclass) THEN
    ALTER TABLE ONLY public.roles
        ADD CONSTRAINT roles_name_key UNIQUE (name);
  END IF;
END $c$;

--

-- roles roles_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'roles_pkey'
                AND conrelid = 'public.roles'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.roles DROP CONSTRAINT roles_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'roles_pkey'
                    AND conrelid = 'public.roles'::regclass) THEN
    ALTER TABLE ONLY public.roles
        ADD CONSTRAINT roles_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- schema_bootstrap schema_bootstrap_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'schema_bootstrap_pkey'
                AND conrelid = 'public.schema_bootstrap'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.schema_bootstrap DROP CONSTRAINT schema_bootstrap_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'schema_bootstrap_pkey'
                    AND conrelid = 'public.schema_bootstrap'::regclass) THEN
    ALTER TABLE ONLY public.schema_bootstrap
        ADD CONSTRAINT schema_bootstrap_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- schemas schemas_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'schemas_pkey'
                AND conrelid = 'public.schemas'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.schemas DROP CONSTRAINT schemas_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'schemas_pkey'
                    AND conrelid = 'public.schemas'::regclass) THEN
    ALTER TABLE ONLY public.schemas
        ADD CONSTRAINT schemas_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- schemas schemas_schema_name_key :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'schemas_schema_name_key'
                AND conrelid = 'public.schemas'::regclass
                AND pg_get_constraintdef(oid) <> 'UNIQUE (schema_name)') THEN
    ALTER TABLE public.schemas DROP CONSTRAINT schemas_schema_name_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'schemas_schema_name_key'
                    AND conrelid = 'public.schemas'::regclass) THEN
    ALTER TABLE ONLY public.schemas
        ADD CONSTRAINT schemas_schema_name_key UNIQUE (schema_name);
  END IF;
END $c$;

--

-- system_settings system_settings_key_key :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'system_settings_key_key'
                AND conrelid = 'public.system_settings'::regclass
                AND pg_get_constraintdef(oid) <> 'UNIQUE (key)') THEN
    ALTER TABLE public.system_settings DROP CONSTRAINT system_settings_key_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'system_settings_key_key'
                    AND conrelid = 'public.system_settings'::regclass) THEN
    ALTER TABLE ONLY public.system_settings
        ADD CONSTRAINT system_settings_key_key UNIQUE (key);
  END IF;
END $c$;

--

-- system_settings system_settings_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'system_settings_pkey'
                AND conrelid = 'public.system_settings'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.system_settings DROP CONSTRAINT system_settings_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'system_settings_pkey'
                    AND conrelid = 'public.system_settings'::regclass) THEN
    ALTER TABLE ONLY public.system_settings
        ADD CONSTRAINT system_settings_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- asset_config uq_asset_config_metric :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'uq_asset_config_metric'
                AND conrelid = 'public.asset_config'::regclass
                AND pg_get_constraintdef(oid) <> 'UNIQUE (asset_id, metric_name)') THEN
    ALTER TABLE public.asset_config DROP CONSTRAINT uq_asset_config_metric;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'uq_asset_config_metric'
                    AND conrelid = 'public.asset_config'::regclass) THEN
    ALTER TABLE ONLY public.asset_config
        ADD CONSTRAINT uq_asset_config_metric UNIQUE (asset_id, metric_name);
  END IF;
END $c$;

--

-- device_submodels uq_device_submodels :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'uq_device_submodels'
                AND conrelid = 'public.device_submodels'::regclass
                AND pg_get_constraintdef(oid) <> 'UNIQUE (device_id, schema_id)') THEN
    ALTER TABLE public.device_submodels DROP CONSTRAINT uq_device_submodels;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'uq_device_submodels'
                    AND conrelid = 'public.device_submodels'::regclass) THEN
    ALTER TABLE ONLY public.device_submodels
        ADD CONSTRAINT uq_device_submodels UNIQUE (device_id, schema_id);
  END IF;
END $c$;

--

-- platform_alerts uq_platform_alerts_event :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'uq_platform_alerts_event'
                AND conrelid = 'public.platform_alerts'::regclass
                AND pg_get_constraintdef(oid) <> 'UNIQUE (fingerprint, starts_at)') THEN
    ALTER TABLE public.platform_alerts DROP CONSTRAINT uq_platform_alerts_event;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'uq_platform_alerts_event'
                    AND conrelid = 'public.platform_alerts'::regclass) THEN
    ALTER TABLE ONLY public.platform_alerts
        ADD CONSTRAINT uq_platform_alerts_event UNIQUE (fingerprint, starts_at);
  END IF;
END $c$;

--

-- user_roles user_roles_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'user_roles_pkey'
                AND conrelid = 'public.user_roles'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (user_id, role_id)') THEN
    ALTER TABLE public.user_roles DROP CONSTRAINT user_roles_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'user_roles_pkey'
                    AND conrelid = 'public.user_roles'::regclass) THEN
    ALTER TABLE ONLY public.user_roles
        ADD CONSTRAINT user_roles_pkey PRIMARY KEY (user_id, role_id);
  END IF;
END $c$;

--

-- webhook_endpoints webhook_endpoints_event_key_url_key :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'webhook_endpoints_event_key_url_key'
                AND conrelid = 'public.webhook_endpoints'::regclass
                AND pg_get_constraintdef(oid) <> 'UNIQUE (event_key, url)') THEN
    ALTER TABLE public.webhook_endpoints DROP CONSTRAINT webhook_endpoints_event_key_url_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'webhook_endpoints_event_key_url_key'
                    AND conrelid = 'public.webhook_endpoints'::regclass) THEN
    ALTER TABLE ONLY public.webhook_endpoints
        ADD CONSTRAINT webhook_endpoints_event_key_url_key UNIQUE (event_key, url);
  END IF;
END $c$;

--

-- webhook_endpoints webhook_endpoints_pkey :: CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'webhook_endpoints_pkey'
                AND conrelid = 'public.webhook_endpoints'::regclass
                AND pg_get_constraintdef(oid) <> 'PRIMARY KEY (id)') THEN
    ALTER TABLE public.webhook_endpoints DROP CONSTRAINT webhook_endpoints_pkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'webhook_endpoints_pkey'
                    AND conrelid = 'public.webhook_endpoints'::regclass) THEN
    ALTER TABLE ONLY public.webhook_endpoints
        ADD CONSTRAINT webhook_endpoints_pkey PRIMARY KEY (id);
  END IF;
END $c$;

--

-- asset_exports_entity_idx :: INDEX
CREATE INDEX IF NOT EXISTS asset_exports_entity_idx ON public.asset_exports USING btree (entity_id, taken_at DESC);

--

-- idx_audit_trail_domain :: INDEX
CREATE INDEX IF NOT EXISTS idx_audit_trail_domain ON public.audit_trail USING btree (audit_domain, recorded_at DESC);

--

-- idx_audit_trail_causation :: INDEX
CREATE INDEX IF NOT EXISTS idx_audit_trail_causation ON public.audit_trail USING btree (causation_id) WHERE (causation_id IS NOT NULL);

--

-- idx_audit_trail_recorded_id :: INDEX
CREATE INDEX IF NOT EXISTS idx_audit_trail_recorded_id ON public.audit_trail USING btree (recorded_at DESC, id DESC);

--

-- INDEX idx_audit_trail_recorded_id :: COMMENT
COMMENT ON INDEX public.idx_audit_trail_recorded_id IS 'Serves audit_trail_page()''s keyset order. MUST match its ORDER BY (recorded_at DESC, id DESC) exactly -- a cursor walking one order against an index in another degrades to a full sort per page, which is invisible until the table is large.';

--

-- backup_jobs_finished_at_idx :: INDEX
CREATE INDEX IF NOT EXISTS backup_jobs_finished_at_idx ON public.backup_jobs USING btree (finished_at DESC);

--

-- backup_jobs_single_flight :: INDEX
CREATE UNIQUE INDEX IF NOT EXISTS backup_jobs_single_flight ON public.backup_jobs USING btree ((true)) WHERE (status = ANY (ARRAY['PENDING'::text, 'RUNNING'::text]));

--

-- backups_taken_at_idx :: INDEX
CREATE INDEX IF NOT EXISTS backups_taken_at_idx ON public.backups USING btree (taken_at DESC);

--

-- capture_jobs_single_flight :: INDEX
CREATE UNIQUE INDEX IF NOT EXISTS capture_jobs_single_flight ON public.capture_jobs USING btree ((true)) WHERE (status = ANY (ARRAY['PENDING'::text, 'RECORDING'::text]));

--

-- captures_one_per_device :: INDEX
CREATE UNIQUE INDEX IF NOT EXISTS captures_one_per_device ON public.captures USING btree (device_id) WHERE (subject_kind = 'device'::text);

--

-- captures_one_per_gateway :: INDEX
CREATE UNIQUE INDEX IF NOT EXISTS captures_one_per_gateway ON public.captures USING btree (gateway_id) WHERE (subject_kind = 'gateway'::text);

--

-- cells_area_id_idx :: INDEX
CREATE INDEX IF NOT EXISTS cells_area_id_idx ON public.cells USING btree (area_id);

--

-- change_proposals_by_entity :: INDEX
CREATE INDEX IF NOT EXISTS change_proposals_by_entity ON public.change_proposals USING btree (entity_type, entity_id);

--

-- change_proposals_one_open_per_asset_per_person :: INDEX
CREATE UNIQUE INDEX IF NOT EXISTS change_proposals_one_open_per_asset_per_person ON public.change_proposals USING btree (entity_type, entity_id, proposed_by) WHERE (status = 'open'::text);

--

-- change_proposals_open_by_age :: INDEX
CREATE INDEX IF NOT EXISTS change_proposals_open_by_age ON public.change_proposals USING btree (proposed_at) WHERE (status = 'open'::text);

--

-- gateway_enrollment_tokens_hash_key :: INDEX
CREATE UNIQUE INDEX IF NOT EXISTS gateway_enrollment_tokens_hash_key ON public.gateway_enrollment_tokens USING btree (token_hash);

--

-- gateway_enrollment_tokens_one_live_per_gateway :: INDEX
CREATE UNIQUE INDEX IF NOT EXISTS gateway_enrollment_tokens_one_live_per_gateway ON public.gateway_enrollment_tokens USING btree (gateway_id) WHERE (consumed_at IS NULL);

--

-- idx_capture_jobs_created_at :: INDEX
CREATE INDEX IF NOT EXISTS idx_capture_jobs_created_at ON public.capture_jobs USING btree (created_at DESC);

--

-- idx_device_submodels_device :: INDEX
CREATE INDEX IF NOT EXISTS idx_device_submodels_device ON public.device_submodels USING btree (device_id);

--

-- idx_device_submodels_schema :: INDEX
CREATE INDEX IF NOT EXISTS idx_device_submodels_schema ON public.device_submodels USING btree (schema_id);

--

-- idx_devices_cell_id :: INDEX
CREATE INDEX IF NOT EXISTS idx_devices_cell_id ON public.devices USING btree (cell_id) WHERE (cell_id IS NOT NULL);

--

-- idx_devices_name :: INDEX
CREATE INDEX IF NOT EXISTS idx_devices_name ON public.devices USING btree (name);

--

-- idx_devices_reported_identity :: INDEX
CREATE INDEX IF NOT EXISTS idx_devices_reported_identity ON public.devices USING btree (reported_identity) WHERE (reported_identity IS NOT NULL);

--

-- idx_devices_sparkplug_id :: INDEX
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_sparkplug_id ON public.devices USING btree (sparkplug_id);

--

-- idx_gateways_group_sparkplug_id :: INDEX
CREATE INDEX IF NOT EXISTS idx_gateways_group_sparkplug_id ON public.gateways USING btree (sparkplug_group, sparkplug_id);

--

-- idx_gateways_name :: INDEX
CREATE INDEX IF NOT EXISTS idx_gateways_name ON public.gateways USING btree (name);

--

-- idx_gateways_sparkplug_id :: INDEX
CREATE UNIQUE INDEX IF NOT EXISTS idx_gateways_sparkplug_id ON public.gateways USING btree (sparkplug_id);

--

-- idx_links_entity :: INDEX
CREATE INDEX IF NOT EXISTS idx_links_entity ON public.links USING btree (entity_type, entity_id);

--

-- idx_metric_catalog_group :: INDEX
CREATE INDEX IF NOT EXISTS idx_metric_catalog_group ON public.metric_catalog USING btree (metric_group);

--

-- idx_metric_catalog_semantic_id :: INDEX
CREATE INDEX IF NOT EXISTS idx_metric_catalog_semantic_id ON public.metric_catalog USING btree (semantic_id) WHERE (semantic_id IS NOT NULL);

--

-- idx_platform_alerts_entity :: INDEX
CREATE INDEX IF NOT EXISTS idx_platform_alerts_entity ON public.platform_alerts USING btree (entity_type, entity_id);

--

-- idx_platform_alerts_sparkplug_started :: INDEX
CREATE INDEX IF NOT EXISTS idx_platform_alerts_sparkplug_started ON public.platform_alerts USING btree (sparkplug_id, starts_at DESC);

--

-- idx_platform_alerts_status_started :: INDEX
CREATE INDEX IF NOT EXISTS idx_platform_alerts_status_started ON public.platform_alerts USING btree (status, starts_at DESC);

--

-- idx_playback_jobs_created_at :: INDEX
CREATE INDEX IF NOT EXISTS idx_playback_jobs_created_at ON public.playback_jobs USING btree (created_at DESC);

--

-- idx_rebirth_requests_requested_at :: INDEX
CREATE INDEX IF NOT EXISTS idx_rebirth_requests_requested_at ON public.rebirth_requests USING btree (requested_at DESC);

--

-- idx_schemas_parent :: INDEX
CREATE INDEX IF NOT EXISTS idx_schemas_parent ON public.schemas USING btree (parent_schema_id);

--

-- idx_schemas_status :: INDEX
CREATE INDEX IF NOT EXISTS idx_schemas_status ON public.schemas USING btree (status);

--

-- machine_principals_name_key :: INDEX
CREATE UNIQUE INDEX IF NOT EXISTS machine_principals_name_key ON public.machine_principals USING btree (lower(btrim(name)));

--

-- playback_jobs_one_per_target :: INDEX
CREATE UNIQUE INDEX IF NOT EXISTS playback_jobs_one_per_target ON public.playback_jobs USING btree (target_gateway_id) WHERE (status = ANY (ARRAY['PENDING'::text, 'RUNNING'::text]));

--

-- rebirth_requests_one_pending_per_gateway :: INDEX
CREATE UNIQUE INDEX IF NOT EXISTS rebirth_requests_one_pending_per_gateway ON public.rebirth_requests USING btree (gateway_id) WHERE (status = 'PENDING'::text);

--

-- uq_devices_shadow_per_gateway :: INDEX
CREATE UNIQUE INDEX IF NOT EXISTS uq_devices_shadow_per_gateway ON public.devices USING btree (gateway_id, shadow_of) WHERE (shadow_of IS NOT NULL);

--

-- uq_metric_groups_name_ci :: INDEX
CREATE UNIQUE INDEX IF NOT EXISTS uq_metric_groups_name_ci ON public.metric_groups USING btree (lower(name));

--

-- uq_schemas_one_draft_per_parent :: INDEX
CREATE UNIQUE INDEX IF NOT EXISTS uq_schemas_one_draft_per_parent ON public.schemas USING btree (parent_schema_id) WHERE (((status)::text = 'draft'::text) AND (parent_schema_id IS NOT NULL));

--

-- system_settings archive_destination_guard_trg :: TRIGGER
DROP TRIGGER IF EXISTS archive_destination_guard_trg ON public.system_settings;
CREATE TRIGGER archive_destination_guard_trg BEFORE UPDATE ON public.system_settings FOR EACH ROW EXECUTE FUNCTION public.archive_destination_guard();

--

-- system_settings backup_offsite_setting_guard_trg :: TRIGGER
DROP TRIGGER IF EXISTS backup_offsite_setting_guard_trg ON public.system_settings;
CREATE TRIGGER backup_offsite_setting_guard_trg BEFORE UPDATE ON public.system_settings FOR EACH ROW EXECUTE FUNCTION public.backup_offsite_setting_guard();

--

-- system_settings system_settings_read_only_trg :: TRIGGER
DROP TRIGGER IF EXISTS system_settings_read_only_trg ON public.system_settings;
CREATE TRIGGER system_settings_read_only_trg BEFORE UPDATE ON public.system_settings FOR EACH ROW EXECUTE FUNCTION public.system_settings_read_only_guard();

--

-- system_settings system_settings_stamp_trg :: TRIGGER
DROP TRIGGER IF EXISTS system_settings_stamp_trg ON public.system_settings;
CREATE TRIGGER system_settings_stamp_trg BEFORE UPDATE ON public.system_settings FOR EACH ROW EXECUTE FUNCTION public.system_settings_stamp();

--

-- areas trg_areas_audit_trail :: TRIGGER
DROP TRIGGER IF EXISTS trg_areas_audit_trail ON public.areas;
CREATE TRIGGER trg_areas_audit_trail AFTER INSERT OR DELETE OR UPDATE ON public.areas FOR EACH ROW EXECUTE FUNCTION public.log_audit_trail_event();

--

-- areas trg_areas_retired :: TRIGGER
DROP TRIGGER IF EXISTS trg_areas_retired ON public.areas;
CREATE TRIGGER trg_areas_retired AFTER DELETE ON public.areas FOR EACH ROW EXECUTE FUNCTION public.record_retired_entity();

--

-- asset_exports trg_asset_exports_audit_trail :: TRIGGER
DROP TRIGGER IF EXISTS trg_asset_exports_audit_trail ON public.asset_exports;
CREATE TRIGGER trg_asset_exports_audit_trail AFTER INSERT ON public.asset_exports FOR EACH ROW EXECUTE FUNCTION public.log_asset_export();

--

-- audit_trail trg_audit_trail_append_only :: TRIGGER
DROP TRIGGER IF EXISTS trg_audit_trail_append_only ON public.audit_trail;
CREATE TRIGGER trg_audit_trail_append_only BEFORE DELETE OR UPDATE ON public.audit_trail FOR EACH ROW EXECUTE FUNCTION public.enforce_audit_trail_append_only();

--

-- audit_trail trg_audit_trail_stamp_domain :: TRIGGER
DROP TRIGGER IF EXISTS trg_audit_trail_stamp_domain ON public.audit_trail;
CREATE TRIGGER trg_audit_trail_stamp_domain BEFORE INSERT ON public.audit_trail FOR EACH ROW EXECUTE FUNCTION public.stamp_audit_domain();

--

-- cells trg_cells_audit_trail :: TRIGGER
DROP TRIGGER IF EXISTS trg_cells_audit_trail ON public.cells;
CREATE TRIGGER trg_cells_audit_trail AFTER INSERT OR DELETE OR UPDATE ON public.cells FOR EACH ROW EXECUTE FUNCTION public.log_audit_trail_event();

--

-- cells trg_cells_place_in_area :: TRIGGER
DROP TRIGGER IF EXISTS trg_cells_place_in_area ON public.cells;
CREATE TRIGGER trg_cells_place_in_area BEFORE INSERT OR UPDATE OF area_id, plan_x, plan_y, is_archived ON public.cells FOR EACH ROW EXECUTE FUNCTION public.place_cell_in_its_area();

--

-- cells trg_cells_retired :: TRIGGER
DROP TRIGGER IF EXISTS trg_cells_retired ON public.cells;
CREATE TRIGGER trg_cells_retired AFTER DELETE ON public.cells FOR EACH ROW EXECUTE FUNCTION public.record_retired_entity();

--

-- change_proposals trg_change_proposals_author :: TRIGGER
DROP TRIGGER IF EXISTS trg_change_proposals_author ON public.change_proposals;
CREATE TRIGGER trg_change_proposals_author BEFORE INSERT ON public.change_proposals FOR EACH ROW EXECUTE FUNCTION public.stamp_proposal_author();

--

-- change_proposals trg_change_proposals_cap :: TRIGGER
DROP TRIGGER IF EXISTS trg_change_proposals_cap ON public.change_proposals;
CREATE TRIGGER trg_change_proposals_cap BEFORE INSERT ON public.change_proposals FOR EACH ROW WHEN ((new.status = 'open'::text)) EXECUTE FUNCTION public.enforce_open_proposal_cap();

--

-- change_proposals trg_change_proposals_transition :: TRIGGER
DROP TRIGGER IF EXISTS trg_change_proposals_transition ON public.change_proposals;
CREATE TRIGGER trg_change_proposals_transition BEFORE UPDATE ON public.change_proposals FOR EACH ROW EXECUTE FUNCTION public.guard_change_proposal_transition();

--

-- change_proposals trg_change_proposals_validate :: TRIGGER
DROP TRIGGER IF EXISTS trg_change_proposals_validate ON public.change_proposals;
CREATE TRIGGER trg_change_proposals_validate BEFORE INSERT OR UPDATE OF patch, entity_type, entity_id ON public.change_proposals FOR EACH ROW EXECUTE FUNCTION public.validate_change_proposal();

--

-- device_nameplate trg_device_nameplate_audit_trail :: TRIGGER
DROP TRIGGER IF EXISTS trg_device_nameplate_audit_trail ON public.device_nameplate;
CREATE TRIGGER trg_device_nameplate_audit_trail AFTER INSERT OR DELETE ON public.device_nameplate FOR EACH ROW EXECUTE FUNCTION public.log_audit_trail_event('device_id');

--

-- device_nameplate trg_device_nameplate_audit_trail_update :: TRIGGER
DROP TRIGGER IF EXISTS trg_device_nameplate_audit_trail_update ON public.device_nameplate;
CREATE TRIGGER trg_device_nameplate_audit_trail_update AFTER UPDATE ON public.device_nameplate FOR EACH ROW WHEN ((((to_jsonb(new.*) - 'updated_at'::text) - 'updated_by'::text) IS DISTINCT FROM ((to_jsonb(old.*) - 'updated_at'::text) - 'updated_by'::text))) EXECUTE FUNCTION public.log_audit_trail_event('device_id');

--

-- devices trg_device_quarantine_webhook_insert :: TRIGGER
DROP TRIGGER IF EXISTS trg_device_quarantine_webhook_insert ON public.devices;
CREATE TRIGGER trg_device_quarantine_webhook_insert AFTER INSERT ON public.devices FOR EACH ROW WHEN ((new.is_quarantined IS TRUE)) EXECUTE FUNCTION public.dispatch_device_quarantine_webhook();

--

-- devices trg_device_quarantine_webhook_update :: TRIGGER
DROP TRIGGER IF EXISTS trg_device_quarantine_webhook_update ON public.devices;
CREATE TRIGGER trg_device_quarantine_webhook_update AFTER UPDATE OF is_quarantined ON public.devices FOR EACH ROW WHEN (((new.is_quarantined IS TRUE) AND (old.is_quarantined IS DISTINCT FROM true))) EXECUTE FUNCTION public.dispatch_device_quarantine_webhook();

--

-- device_submodels trg_device_submodels_reject_archived_schema :: TRIGGER
DROP TRIGGER IF EXISTS trg_device_submodels_reject_archived_schema ON public.device_submodels;
CREATE TRIGGER trg_device_submodels_reject_archived_schema BEFORE INSERT OR UPDATE OF schema_id ON public.device_submodels FOR EACH ROW EXECUTE FUNCTION public.reject_archived_schema_assignment();

--

-- devices trg_devices_audit_trail :: TRIGGER
DROP TRIGGER IF EXISTS trg_devices_audit_trail ON public.devices;
CREATE TRIGGER trg_devices_audit_trail AFTER INSERT OR DELETE OR UPDATE ON public.devices FOR EACH ROW EXECUTE FUNCTION public.log_audit_trail_event();

--

-- devices trg_devices_delete_asset_config :: TRIGGER
DROP TRIGGER IF EXISTS trg_devices_delete_asset_config ON public.devices;
CREATE TRIGGER trg_devices_delete_asset_config AFTER DELETE ON public.devices FOR EACH ROW EXECUTE FUNCTION public.delete_device_asset_config();

--

-- devices trg_devices_reject_archived_schema :: TRIGGER
DROP TRIGGER IF EXISTS trg_devices_reject_archived_schema ON public.devices;
CREATE TRIGGER trg_devices_reject_archived_schema BEFORE INSERT OR UPDATE OF schema_id ON public.devices FOR EACH ROW EXECUTE FUNCTION public.reject_archived_schema_assignment();

--

-- devices trg_devices_replay_lane_is_minted :: TRIGGER
DROP TRIGGER IF EXISTS trg_devices_replay_lane_is_minted ON public.devices;
CREATE TRIGGER trg_devices_replay_lane_is_minted BEFORE INSERT OR UPDATE OF gateway_id ON public.devices FOR EACH ROW EXECUTE FUNCTION public.refuse_hand_assigning_a_replay_lane();

--

-- devices trg_devices_retired :: TRIGGER
DROP TRIGGER IF EXISTS trg_devices_retired ON public.devices;
CREATE TRIGGER trg_devices_retired AFTER DELETE ON public.devices FOR EACH ROW EXECUTE FUNCTION public.record_retired_entity();

--

-- devices trg_devices_shadow_follows_archive :: TRIGGER
DROP TRIGGER IF EXISTS trg_devices_shadow_follows_archive ON public.devices;
CREATE TRIGGER trg_devices_shadow_follows_archive AFTER UPDATE OF is_archived ON public.devices FOR EACH ROW EXECUTE FUNCTION public.shadow_follows_its_original();

--

-- devices trg_devices_shadow_follows_delete :: TRIGGER
DROP TRIGGER IF EXISTS trg_devices_shadow_follows_delete ON public.devices;
CREATE TRIGGER trg_devices_shadow_follows_delete BEFORE DELETE ON public.devices FOR EACH ROW EXECUTE FUNCTION public.shadow_follows_its_original();

--

-- schemas trg_enforce_schema_version_provenance :: TRIGGER
DROP TRIGGER IF EXISTS trg_enforce_schema_version_provenance ON public.schemas;
CREATE TRIGGER trg_enforce_schema_version_provenance BEFORE INSERT ON public.schemas FOR EACH ROW EXECUTE FUNCTION public.enforce_schema_version_provenance();

--

-- gateways trg_gateways_audit_trail :: TRIGGER
DROP TRIGGER IF EXISTS trg_gateways_audit_trail ON public.gateways;
CREATE TRIGGER trg_gateways_audit_trail AFTER INSERT OR DELETE OR UPDATE ON public.gateways FOR EACH ROW EXECUTE FUNCTION public.log_audit_trail_event();

--

-- gateways trg_gateways_clear_credential_revoked :: TRIGGER
DROP TRIGGER IF EXISTS trg_gateways_clear_credential_revoked ON public.gateways;
CREATE TRIGGER trg_gateways_clear_credential_revoked BEFORE UPDATE OF is_archived ON public.gateways FOR EACH ROW EXECUTE FUNCTION public.clear_credential_revoked_on_enrolment();

--

-- gateways trg_gateways_forge_follows_archive :: TRIGGER
DROP TRIGGER IF EXISTS trg_gateways_forge_follows_archive ON public.gateways;
CREATE TRIGGER trg_gateways_forge_follows_archive AFTER UPDATE OF is_archived ON public.gateways FOR EACH ROW EXECUTE FUNCTION public.sweep_forge_on_archive_change();

--

-- gateways trg_gateways_keep_a_playback_target :: TRIGGER
DROP TRIGGER IF EXISTS trg_gateways_keep_a_playback_target ON public.gateways;
CREATE TRIGGER trg_gateways_keep_a_playback_target BEFORE UPDATE OF is_archived ON public.gateways FOR EACH ROW EXECUTE FUNCTION public.refuse_archiving_the_last_shadow_gateway();

--

-- gateways trg_gateways_retired :: TRIGGER
DROP TRIGGER IF EXISTS trg_gateways_retired ON public.gateways;
CREATE TRIGGER trg_gateways_retired AFTER DELETE ON public.gateways FOR EACH ROW EXECUTE FUNCTION public.record_retired_entity();

--

-- gateways trg_gateways_revoke_credential_delete :: TRIGGER
DROP TRIGGER IF EXISTS trg_gateways_revoke_credential_delete ON public.gateways;
CREATE TRIGGER trg_gateways_revoke_credential_delete BEFORE DELETE ON public.gateways FOR EACH ROW EXECUTE FUNCTION public.revoke_credential_on_decommission();

--

-- gateways trg_gateways_revoke_credential_update :: TRIGGER
DROP TRIGGER IF EXISTS trg_gateways_revoke_credential_update ON public.gateways;
CREATE TRIGGER trg_gateways_revoke_credential_update AFTER UPDATE OF is_archived ON public.gateways FOR EACH ROW EXECUTE FUNCTION public.revoke_credential_on_decommission();

--

-- gateways trg_gateways_withdraw_enrolment :: TRIGGER
DROP TRIGGER IF EXISTS trg_gateways_withdraw_enrolment ON public.gateways;
CREATE TRIGGER trg_gateways_withdraw_enrolment AFTER UPDATE OF is_archived ON public.gateways FOR EACH ROW EXECUTE FUNCTION public.withdraw_gateway_enrollment_tokens();

--

-- metric_catalog trg_metric_catalog_audit_trail :: TRIGGER
DROP TRIGGER IF EXISTS trg_metric_catalog_audit_trail ON public.metric_catalog;
CREATE TRIGGER trg_metric_catalog_audit_trail AFTER INSERT OR DELETE OR UPDATE ON public.metric_catalog FOR EACH ROW EXECUTE FUNCTION public.log_audit_trail_event();

--

-- metric_catalog trg_metric_catalog_immutability :: TRIGGER
DROP TRIGGER IF EXISTS trg_metric_catalog_immutability ON public.metric_catalog;
CREATE TRIGGER trg_metric_catalog_immutability BEFORE UPDATE ON public.metric_catalog FOR EACH ROW EXECUTE FUNCTION public.enforce_metric_catalog_immutability();

--

-- metric_catalog trg_metric_group_spelling :: TRIGGER
DROP TRIGGER IF EXISTS trg_metric_group_spelling ON public.metric_catalog;
CREATE TRIGGER trg_metric_group_spelling BEFORE INSERT ON public.metric_catalog FOR EACH ROW EXECUTE FUNCTION public.enforce_metric_group_spelling();

--

-- playback_jobs trg_playback_target_must_be_shadow :: TRIGGER
DROP TRIGGER IF EXISTS trg_playback_target_must_be_shadow ON public.playback_jobs;
CREATE TRIGGER trg_playback_target_must_be_shadow BEFORE INSERT ON public.playback_jobs FOR EACH ROW EXECUTE FUNCTION public.playback_target_must_be_shadow();

--

-- schemas trg_prevent_active_schema_mutation :: TRIGGER
DROP TRIGGER IF EXISTS trg_prevent_active_schema_mutation ON public.schemas;
CREATE TRIGGER trg_prevent_active_schema_mutation BEFORE UPDATE ON public.schemas FOR EACH ROW EXECUTE FUNCTION public.prevent_active_schema_mutation();

--

-- schemas trg_schemas_audit_trail :: TRIGGER
DROP TRIGGER IF EXISTS trg_schemas_audit_trail ON public.schemas;
CREATE TRIGGER trg_schemas_audit_trail AFTER INSERT OR DELETE OR UPDATE ON public.schemas FOR EACH ROW EXECUTE FUNCTION public.log_audit_trail_event();

--

-- system_settings trg_system_settings_audit_trail :: TRIGGER
DROP TRIGGER IF EXISTS trg_system_settings_audit_trail ON public.system_settings;
CREATE TRIGGER trg_system_settings_audit_trail AFTER INSERT OR DELETE ON public.system_settings FOR EACH ROW EXECUTE FUNCTION public.log_audit_trail_event();

--

-- system_settings trg_system_settings_audit_trail_update :: TRIGGER
DROP TRIGGER IF EXISTS trg_system_settings_audit_trail_update ON public.system_settings;
CREATE TRIGGER trg_system_settings_audit_trail_update AFTER UPDATE ON public.system_settings FOR EACH ROW WHEN ((((to_jsonb(new.*) - 'updated_at'::text) - 'updated_by'::text) IS DISTINCT FROM ((to_jsonb(old.*) - 'updated_at'::text) - 'updated_by'::text))) EXECUTE FUNCTION public.log_audit_trail_event();

--

-- user_roles trg_user_roles_audit_trail :: TRIGGER
DROP TRIGGER IF EXISTS trg_user_roles_audit_trail ON public.user_roles;
CREATE TRIGGER trg_user_roles_audit_trail AFTER INSERT OR DELETE OR UPDATE ON public.user_roles FOR EACH ROW EXECUTE FUNCTION public.log_role_assignment();

--

-- user_roles trg_user_roles_refuse_machine_principal :: TRIGGER
DROP TRIGGER IF EXISTS trg_user_roles_refuse_machine_principal ON public.user_roles;
CREATE TRIGGER trg_user_roles_refuse_machine_principal BEFORE INSERT OR UPDATE ON public.user_roles FOR EACH ROW EXECUTE FUNCTION public.refuse_role_for_machine_principal();

--

-- audit_trail audit_trail_changed_by_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'audit_trail_changed_by_fkey'
                AND conrelid = 'public.audit_trail'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (changed_by) REFERENCES auth.users(id)') THEN
    ALTER TABLE public.audit_trail DROP CONSTRAINT audit_trail_changed_by_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'audit_trail_changed_by_fkey'
                    AND conrelid = 'public.audit_trail'::regclass) THEN
    ALTER TABLE public.audit_trail
        ADD CONSTRAINT audit_trail_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES auth.users(id);
  END IF;
END $c$;

--

-- backup_jobs backup_jobs_requested_by_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'backup_jobs_requested_by_fkey'
                AND conrelid = 'public.backup_jobs'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (requested_by) REFERENCES auth.users(id) ON DELETE SET NULL') THEN
    ALTER TABLE public.backup_jobs DROP CONSTRAINT backup_jobs_requested_by_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'backup_jobs_requested_by_fkey'
                    AND conrelid = 'public.backup_jobs'::regclass) THEN
    ALTER TABLE ONLY public.backup_jobs
        ADD CONSTRAINT backup_jobs_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $c$;

--

-- backups backups_job_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'backups_job_id_fkey'
                AND conrelid = 'public.backups'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (job_id) REFERENCES public.backup_jobs(id) ON DELETE SET NULL') THEN
    ALTER TABLE public.backups DROP CONSTRAINT backups_job_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'backups_job_id_fkey'
                    AND conrelid = 'public.backups'::regclass) THEN
    ALTER TABLE ONLY public.backups
        ADD CONSTRAINT backups_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.backup_jobs(id) ON DELETE SET NULL;
  END IF;
END $c$;

--

-- backups backups_released_by_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'backups_released_by_fkey'
                AND conrelid = 'public.backups'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (released_by) REFERENCES auth.users(id) ON DELETE SET NULL') THEN
    ALTER TABLE public.backups DROP CONSTRAINT backups_released_by_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'backups_released_by_fkey'
                    AND conrelid = 'public.backups'::regclass) THEN
    ALTER TABLE ONLY public.backups
        ADD CONSTRAINT backups_released_by_fkey FOREIGN KEY (released_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $c$;

--

-- backups backups_requested_by_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'backups_requested_by_fkey'
                AND conrelid = 'public.backups'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (requested_by) REFERENCES auth.users(id) ON DELETE SET NULL') THEN
    ALTER TABLE public.backups DROP CONSTRAINT backups_requested_by_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'backups_requested_by_fkey'
                    AND conrelid = 'public.backups'::regclass) THEN
    ALTER TABLE ONLY public.backups
        ADD CONSTRAINT backups_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $c$;

--

-- capture_jobs capture_jobs_capture_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'capture_jobs_capture_id_fkey'
                AND conrelid = 'public.capture_jobs'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (capture_id) REFERENCES public.captures(id) ON DELETE SET NULL') THEN
    ALTER TABLE public.capture_jobs DROP CONSTRAINT capture_jobs_capture_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'capture_jobs_capture_id_fkey'
                    AND conrelid = 'public.capture_jobs'::regclass) THEN
    ALTER TABLE ONLY public.capture_jobs
        ADD CONSTRAINT capture_jobs_capture_id_fkey FOREIGN KEY (capture_id) REFERENCES public.captures(id) ON DELETE SET NULL;
  END IF;
END $c$;

--

-- capture_jobs capture_jobs_device_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'capture_jobs_device_id_fkey'
                AND conrelid = 'public.capture_jobs'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE') THEN
    ALTER TABLE public.capture_jobs DROP CONSTRAINT capture_jobs_device_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'capture_jobs_device_id_fkey'
                    AND conrelid = 'public.capture_jobs'::regclass) THEN
    ALTER TABLE ONLY public.capture_jobs
        ADD CONSTRAINT capture_jobs_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;
  END IF;
END $c$;

--

-- capture_jobs capture_jobs_gateway_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'capture_jobs_gateway_id_fkey'
                AND conrelid = 'public.capture_jobs'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (gateway_id) REFERENCES public.gateways(id) ON DELETE CASCADE') THEN
    ALTER TABLE public.capture_jobs DROP CONSTRAINT capture_jobs_gateway_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'capture_jobs_gateway_id_fkey'
                    AND conrelid = 'public.capture_jobs'::regclass) THEN
    ALTER TABLE ONLY public.capture_jobs
        ADD CONSTRAINT capture_jobs_gateway_id_fkey FOREIGN KEY (gateway_id) REFERENCES public.gateways(id) ON DELETE CASCADE;
  END IF;
END $c$;

--

-- captures captures_device_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'captures_device_id_fkey'
                AND conrelid = 'public.captures'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE') THEN
    ALTER TABLE public.captures DROP CONSTRAINT captures_device_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'captures_device_id_fkey'
                    AND conrelid = 'public.captures'::regclass) THEN
    ALTER TABLE ONLY public.captures
        ADD CONSTRAINT captures_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;
  END IF;
END $c$;

--

-- captures captures_gateway_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'captures_gateway_id_fkey'
                AND conrelid = 'public.captures'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (gateway_id) REFERENCES public.gateways(id) ON DELETE CASCADE') THEN
    ALTER TABLE public.captures DROP CONSTRAINT captures_gateway_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'captures_gateway_id_fkey'
                    AND conrelid = 'public.captures'::regclass) THEN
    ALTER TABLE ONLY public.captures
        ADD CONSTRAINT captures_gateway_id_fkey FOREIGN KEY (gateway_id) REFERENCES public.gateways(id) ON DELETE CASCADE;
  END IF;
END $c$;

--

-- cells cells_area_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'cells_area_id_fkey'
                AND conrelid = 'public.cells'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (area_id) REFERENCES public.areas(id) ON DELETE SET NULL') THEN
    ALTER TABLE public.cells DROP CONSTRAINT cells_area_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'cells_area_id_fkey'
                    AND conrelid = 'public.cells'::regclass) THEN
    ALTER TABLE ONLY public.cells
        ADD CONSTRAINT cells_area_id_fkey FOREIGN KEY (area_id) REFERENCES public.areas(id) ON DELETE SET NULL;
  END IF;
END $c$;

--

-- device_nameplate device_nameplate_device_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'device_nameplate_device_id_fkey'
                AND conrelid = 'public.device_nameplate'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE') THEN
    ALTER TABLE public.device_nameplate DROP CONSTRAINT device_nameplate_device_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'device_nameplate_device_id_fkey'
                    AND conrelid = 'public.device_nameplate'::regclass) THEN
    ALTER TABLE ONLY public.device_nameplate
        ADD CONSTRAINT device_nameplate_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;
  END IF;
END $c$;

--

-- device_submodels device_submodels_device_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'device_submodels_device_id_fkey'
                AND conrelid = 'public.device_submodels'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE') THEN
    ALTER TABLE public.device_submodels DROP CONSTRAINT device_submodels_device_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'device_submodels_device_id_fkey'
                    AND conrelid = 'public.device_submodels'::regclass) THEN
    ALTER TABLE ONLY public.device_submodels
        ADD CONSTRAINT device_submodels_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;
  END IF;
END $c$;

--

-- device_submodels device_submodels_schema_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'device_submodels_schema_id_fkey'
                AND conrelid = 'public.device_submodels'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (schema_id) REFERENCES public.schemas(id) ON DELETE CASCADE') THEN
    ALTER TABLE public.device_submodels DROP CONSTRAINT device_submodels_schema_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'device_submodels_schema_id_fkey'
                    AND conrelid = 'public.device_submodels'::regclass) THEN
    ALTER TABLE ONLY public.device_submodels
        ADD CONSTRAINT device_submodels_schema_id_fkey FOREIGN KEY (schema_id) REFERENCES public.schemas(id) ON DELETE CASCADE;
  END IF;
END $c$;

--

-- devices devices_area_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'devices_area_id_fkey'
                AND conrelid = 'public.devices'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (area_id) REFERENCES public.areas(id)') THEN
    ALTER TABLE public.devices DROP CONSTRAINT devices_area_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'devices_area_id_fkey'
                    AND conrelid = 'public.devices'::regclass) THEN
    ALTER TABLE ONLY public.devices
        ADD CONSTRAINT devices_area_id_fkey FOREIGN KEY (area_id) REFERENCES public.areas(id);
  END IF;
END $c$;

--

-- devices devices_cell_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'devices_cell_id_fkey'
                AND conrelid = 'public.devices'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (cell_id) REFERENCES public.cells(id) ON DELETE SET NULL') THEN
    ALTER TABLE public.devices DROP CONSTRAINT devices_cell_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'devices_cell_id_fkey'
                    AND conrelid = 'public.devices'::regclass) THEN
    ALTER TABLE ONLY public.devices
        ADD CONSTRAINT devices_cell_id_fkey FOREIGN KEY (cell_id) REFERENCES public.cells(id) ON DELETE SET NULL;
  END IF;
END $c$;

--

-- devices devices_gateway_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'devices_gateway_id_fkey'
                AND conrelid = 'public.devices'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (gateway_id) REFERENCES public.gateways(id) ON DELETE SET NULL') THEN
    ALTER TABLE public.devices DROP CONSTRAINT devices_gateway_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'devices_gateway_id_fkey'
                    AND conrelid = 'public.devices'::regclass) THEN
    ALTER TABLE ONLY public.devices
        ADD CONSTRAINT devices_gateway_id_fkey FOREIGN KEY (gateway_id) REFERENCES public.gateways(id) ON DELETE SET NULL;
  END IF;
END $c$;

--

-- devices devices_schema_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'devices_schema_id_fkey'
                AND conrelid = 'public.devices'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (schema_id) REFERENCES public.schemas(id) ON DELETE SET NULL') THEN
    ALTER TABLE public.devices DROP CONSTRAINT devices_schema_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'devices_schema_id_fkey'
                    AND conrelid = 'public.devices'::regclass) THEN
    ALTER TABLE ONLY public.devices
        ADD CONSTRAINT devices_schema_id_fkey FOREIGN KEY (schema_id) REFERENCES public.schemas(id) ON DELETE SET NULL;
  END IF;
END $c$;

--

-- devices devices_shadow_of_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'devices_shadow_of_fkey'
                AND conrelid = 'public.devices'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (shadow_of) REFERENCES public.devices(id) ON DELETE SET NULL') THEN
    ALTER TABLE public.devices DROP CONSTRAINT devices_shadow_of_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'devices_shadow_of_fkey'
                    AND conrelid = 'public.devices'::regclass) THEN
    ALTER TABLE ONLY public.devices
        ADD CONSTRAINT devices_shadow_of_fkey FOREIGN KEY (shadow_of) REFERENCES public.devices(id) ON DELETE SET NULL;
  END IF;
END $c$;

--

-- directory_services directory_services_registered_schema_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'directory_services_registered_schema_id_fkey'
                AND conrelid = 'public.directory_services'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (registered_schema_id) REFERENCES public.schemas(id) ON DELETE SET NULL') THEN
    ALTER TABLE public.directory_services DROP CONSTRAINT directory_services_registered_schema_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'directory_services_registered_schema_id_fkey'
                    AND conrelid = 'public.directory_services'::regclass) THEN
    ALTER TABLE ONLY public.directory_services
        ADD CONSTRAINT directory_services_registered_schema_id_fkey FOREIGN KEY (registered_schema_id) REFERENCES public.schemas(id) ON DELETE SET NULL;
  END IF;
END $c$;

--

-- gateway_enrollment_tokens gateway_enrollment_tokens_gateway_fk :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'gateway_enrollment_tokens_gateway_fk'
                AND conrelid = 'public.gateway_enrollment_tokens'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (gateway_id) REFERENCES public.gateways(id) ON DELETE CASCADE') THEN
    ALTER TABLE public.gateway_enrollment_tokens DROP CONSTRAINT gateway_enrollment_tokens_gateway_fk;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gateway_enrollment_tokens_gateway_fk'
                    AND conrelid = 'public.gateway_enrollment_tokens'::regclass) THEN
    ALTER TABLE ONLY public.gateway_enrollment_tokens
        ADD CONSTRAINT gateway_enrollment_tokens_gateway_fk FOREIGN KEY (gateway_id) REFERENCES public.gateways(id) ON DELETE CASCADE;
  END IF;
END $c$;

--

-- gateway_revocation_requests gateway_revocation_requests_gateway_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'gateway_revocation_requests_gateway_id_fkey'
                AND conrelid = 'public.gateway_revocation_requests'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (gateway_id) REFERENCES public.gateways(id) ON DELETE CASCADE') THEN
    ALTER TABLE public.gateway_revocation_requests DROP CONSTRAINT gateway_revocation_requests_gateway_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gateway_revocation_requests_gateway_id_fkey'
                    AND conrelid = 'public.gateway_revocation_requests'::regclass) THEN
    ALTER TABLE ONLY public.gateway_revocation_requests
        ADD CONSTRAINT gateway_revocation_requests_gateway_id_fkey FOREIGN KEY (gateway_id) REFERENCES public.gateways(id) ON DELETE CASCADE;
  END IF;
END $c$;

--

-- gateways gateways_area_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'gateways_area_id_fkey'
                AND conrelid = 'public.gateways'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (area_id) REFERENCES public.areas(id)') THEN
    ALTER TABLE public.gateways DROP CONSTRAINT gateways_area_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gateways_area_id_fkey'
                    AND conrelid = 'public.gateways'::regclass) THEN
    ALTER TABLE ONLY public.gateways
        ADD CONSTRAINT gateways_area_id_fkey FOREIGN KEY (area_id) REFERENCES public.areas(id);
  END IF;
END $c$;

--

-- gateways gateways_cell_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'gateways_cell_id_fkey'
                AND conrelid = 'public.gateways'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (cell_id) REFERENCES public.cells(id) ON DELETE SET NULL') THEN
    ALTER TABLE public.gateways DROP CONSTRAINT gateways_cell_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gateways_cell_id_fkey'
                    AND conrelid = 'public.gateways'::regclass) THEN
    ALTER TABLE ONLY public.gateways
        ADD CONSTRAINT gateways_cell_id_fkey FOREIGN KEY (cell_id) REFERENCES public.cells(id) ON DELETE SET NULL;
  END IF;
END $c$;

--

-- machine_principals machine_principals_created_by_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'machine_principals_created_by_fkey'
                AND conrelid = 'public.machine_principals'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL') THEN
    ALTER TABLE public.machine_principals DROP CONSTRAINT machine_principals_created_by_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'machine_principals_created_by_fkey'
                    AND conrelid = 'public.machine_principals'::regclass) THEN
    ALTER TABLE ONLY public.machine_principals
        ADD CONSTRAINT machine_principals_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $c$;

--

-- machine_principals machine_principals_principal_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'machine_principals_principal_id_fkey'
                AND conrelid = 'public.machine_principals'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (principal_id) REFERENCES auth.users(id) ON DELETE CASCADE') THEN
    ALTER TABLE public.machine_principals DROP CONSTRAINT machine_principals_principal_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'machine_principals_principal_id_fkey'
                    AND conrelid = 'public.machine_principals'::regclass) THEN
    ALTER TABLE ONLY public.machine_principals
        ADD CONSTRAINT machine_principals_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $c$;

--

-- metric_catalog metric_catalog_superseded_by_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'metric_catalog_superseded_by_fkey'
                AND conrelid = 'public.metric_catalog'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (superseded_by) REFERENCES public.metric_catalog(id) ON DELETE SET NULL') THEN
    ALTER TABLE public.metric_catalog DROP CONSTRAINT metric_catalog_superseded_by_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'metric_catalog_superseded_by_fkey'
                    AND conrelid = 'public.metric_catalog'::regclass) THEN
    ALTER TABLE ONLY public.metric_catalog
        ADD CONSTRAINT metric_catalog_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES public.metric_catalog(id) ON DELETE SET NULL;
  END IF;
END $c$;

--

-- playback_jobs playback_jobs_capture_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'playback_jobs_capture_id_fkey'
                AND conrelid = 'public.playback_jobs'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (capture_id) REFERENCES public.captures(id) ON DELETE SET NULL') THEN
    ALTER TABLE public.playback_jobs DROP CONSTRAINT playback_jobs_capture_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'playback_jobs_capture_id_fkey'
                    AND conrelid = 'public.playback_jobs'::regclass) THEN
    ALTER TABLE ONLY public.playback_jobs
        ADD CONSTRAINT playback_jobs_capture_id_fkey FOREIGN KEY (capture_id) REFERENCES public.captures(id) ON DELETE SET NULL;
  END IF;
END $c$;

--

-- playback_jobs playback_jobs_target_gateway_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'playback_jobs_target_gateway_id_fkey'
                AND conrelid = 'public.playback_jobs'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (target_gateway_id) REFERENCES public.gateways(id) ON DELETE CASCADE') THEN
    ALTER TABLE public.playback_jobs DROP CONSTRAINT playback_jobs_target_gateway_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'playback_jobs_target_gateway_id_fkey'
                    AND conrelid = 'public.playback_jobs'::regclass) THEN
    ALTER TABLE ONLY public.playback_jobs
        ADD CONSTRAINT playback_jobs_target_gateway_id_fkey FOREIGN KEY (target_gateway_id) REFERENCES public.gateways(id) ON DELETE CASCADE;
  END IF;
END $c$;

--

-- principal_permissions principal_permissions_permission_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'principal_permissions_permission_id_fkey'
                AND conrelid = 'public.principal_permissions'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON DELETE RESTRICT') THEN
    ALTER TABLE public.principal_permissions DROP CONSTRAINT principal_permissions_permission_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'principal_permissions_permission_id_fkey'
                    AND conrelid = 'public.principal_permissions'::regclass) THEN
    ALTER TABLE ONLY public.principal_permissions
        ADD CONSTRAINT principal_permissions_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON DELETE RESTRICT;
  END IF;
END $c$;

--

-- principal_permissions principal_permissions_principal_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'principal_permissions_principal_id_fkey'
                AND conrelid = 'public.principal_permissions'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (principal_id) REFERENCES auth.users(id) ON DELETE CASCADE') THEN
    ALTER TABLE public.principal_permissions DROP CONSTRAINT principal_permissions_principal_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'principal_permissions_principal_id_fkey'
                    AND conrelid = 'public.principal_permissions'::regclass) THEN
    ALTER TABLE ONLY public.principal_permissions
        ADD CONSTRAINT principal_permissions_principal_id_fkey FOREIGN KEY (principal_id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END $c$;

--

-- rebirth_requests rebirth_requests_gateway_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'rebirth_requests_gateway_id_fkey'
                AND conrelid = 'public.rebirth_requests'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (gateway_id) REFERENCES public.gateways(id) ON DELETE CASCADE') THEN
    ALTER TABLE public.rebirth_requests DROP CONSTRAINT rebirth_requests_gateway_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'rebirth_requests_gateway_id_fkey'
                    AND conrelid = 'public.rebirth_requests'::regclass) THEN
    ALTER TABLE ONLY public.rebirth_requests
        ADD CONSTRAINT rebirth_requests_gateway_id_fkey FOREIGN KEY (gateway_id) REFERENCES public.gateways(id) ON DELETE CASCADE;
  END IF;
END $c$;

--

-- role_permissions role_permissions_permission_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'role_permissions_permission_id_fkey'
                AND conrelid = 'public.role_permissions'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON DELETE CASCADE') THEN
    ALTER TABLE public.role_permissions DROP CONSTRAINT role_permissions_permission_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'role_permissions_permission_id_fkey'
                    AND conrelid = 'public.role_permissions'::regclass) THEN
    ALTER TABLE ONLY public.role_permissions
        ADD CONSTRAINT role_permissions_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON DELETE CASCADE;
  END IF;
END $c$;

--

-- role_permissions role_permissions_role_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'role_permissions_role_id_fkey'
                AND conrelid = 'public.role_permissions'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE') THEN
    ALTER TABLE public.role_permissions DROP CONSTRAINT role_permissions_role_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'role_permissions_role_id_fkey'
                    AND conrelid = 'public.role_permissions'::regclass) THEN
    ALTER TABLE ONLY public.role_permissions
        ADD CONSTRAINT role_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;
  END IF;
END $c$;

--

-- schemas schemas_parent_schema_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'schemas_parent_schema_id_fkey'
                AND conrelid = 'public.schemas'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (parent_schema_id) REFERENCES public.schemas(id) ON DELETE SET NULL') THEN
    ALTER TABLE public.schemas DROP CONSTRAINT schemas_parent_schema_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'schemas_parent_schema_id_fkey'
                    AND conrelid = 'public.schemas'::regclass) THEN
    ALTER TABLE ONLY public.schemas
        ADD CONSTRAINT schemas_parent_schema_id_fkey FOREIGN KEY (parent_schema_id) REFERENCES public.schemas(id) ON DELETE SET NULL;
  END IF;
END $c$;

--

-- user_roles user_roles_role_id_fkey :: FK CONSTRAINT
DO $c$ BEGIN

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'user_roles_role_id_fkey'
                AND conrelid = 'public.user_roles'::regclass
                AND pg_get_constraintdef(oid) <> 'FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE') THEN
    ALTER TABLE public.user_roles DROP CONSTRAINT user_roles_role_id_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'user_roles_role_id_fkey'
                    AND conrelid = 'public.user_roles'::regclass) THEN
    ALTER TABLE ONLY public.user_roles
        ADD CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;
  END IF;
END $c$;

--

-- areas :: ROW SECURITY
ALTER TABLE public.areas ENABLE ROW LEVEL SECURITY;

--

-- areas areas_delete_privileged :: POLICY
DROP POLICY IF EXISTS areas_delete_privileged ON public.areas;
CREATE POLICY areas_delete_privileged ON public.areas FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- areas areas_insert_privileged :: POLICY
DROP POLICY IF EXISTS areas_insert_privileged ON public.areas;
CREATE POLICY areas_insert_privileged ON public.areas FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- areas areas_select_authenticated :: POLICY
DROP POLICY IF EXISTS areas_select_authenticated ON public.areas;
CREATE POLICY areas_select_authenticated ON public.areas FOR SELECT TO authenticated USING (true);

--

-- areas areas_update_privileged :: POLICY
DROP POLICY IF EXISTS areas_update_privileged ON public.areas;
CREATE POLICY areas_update_privileged ON public.areas FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- ashrae223_vocabulary :: ROW SECURITY
ALTER TABLE public.ashrae223_vocabulary ENABLE ROW LEVEL SECURITY;

--

-- ashrae223_vocabulary ashrae223_vocabulary_select_authenticated :: POLICY
DROP POLICY IF EXISTS ashrae223_vocabulary_select_authenticated ON public.ashrae223_vocabulary;
CREATE POLICY ashrae223_vocabulary_select_authenticated ON public.ashrae223_vocabulary FOR SELECT TO authenticated USING (true);

--

-- asset_config :: ROW SECURITY
ALTER TABLE public.asset_config ENABLE ROW LEVEL SECURITY;

--

-- asset_config asset_config_delete_privileged :: POLICY
DROP POLICY IF EXISTS asset_config_delete_privileged ON public.asset_config;
CREATE POLICY asset_config_delete_privileged ON public.asset_config FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- asset_config asset_config_insert_privileged :: POLICY
DROP POLICY IF EXISTS asset_config_insert_privileged ON public.asset_config;
CREATE POLICY asset_config_insert_privileged ON public.asset_config FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- asset_config asset_config_select_authenticated :: POLICY
DROP POLICY IF EXISTS asset_config_select_authenticated ON public.asset_config;
CREATE POLICY asset_config_select_authenticated ON public.asset_config FOR SELECT TO authenticated USING (true);

--

-- asset_config asset_config_update_privileged :: POLICY
DROP POLICY IF EXISTS asset_config_update_privileged ON public.asset_config;
CREATE POLICY asset_config_update_privileged ON public.asset_config FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- asset_exports :: ROW SECURITY
ALTER TABLE public.asset_exports ENABLE ROW LEVEL SECURITY;

--

-- asset_exports asset_exports_select_privileged :: POLICY
DROP POLICY IF EXISTS asset_exports_select_privileged ON public.asset_exports;
CREATE POLICY asset_exports_select_privileged ON public.asset_exports FOR SELECT TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text, 'Auditor'::text]));

--

-- audit_trail :: ROW SECURITY
ALTER TABLE public.audit_trail ENABLE ROW LEVEL SECURITY;

--

-- audit_trail audit_trail_select_asset :: POLICY
DROP POLICY IF EXISTS audit_trail_select_asset ON public.audit_trail;
CREATE POLICY audit_trail_select_asset ON public.audit_trail FOR SELECT TO authenticated USING (((audit_domain = 'asset'::text) AND (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text, 'Auditor'::text]) OR public.has_authority(ARRAY['audit_trail:read'::text]))));

--

-- audit_trail audit_trail_select_security :: POLICY
DROP POLICY IF EXISTS audit_trail_select_security ON public.audit_trail;
CREATE POLICY audit_trail_select_security ON public.audit_trail FOR SELECT TO authenticated USING (((audit_domain = 'security'::text) AND public.has_role(ARRAY['Administrator'::text, 'Auditor'::text])));

--

-- backup_jobs :: ROW SECURITY
ALTER TABLE public.backup_jobs ENABLE ROW LEVEL SECURITY;

--

-- backup_jobs backup_jobs_select_administrator :: POLICY
DROP POLICY IF EXISTS backup_jobs_select_administrator ON public.backup_jobs;
CREATE POLICY backup_jobs_select_administrator ON public.backup_jobs FOR SELECT TO authenticated USING (public.has_role(ARRAY['Administrator'::text]));

--

-- backups :: ROW SECURITY
ALTER TABLE public.backups ENABLE ROW LEVEL SECURITY;

--

-- backups backups_select_administrator :: POLICY
DROP POLICY IF EXISTS backups_select_administrator ON public.backups;
CREATE POLICY backups_select_administrator ON public.backups FOR SELECT TO authenticated USING (public.has_role(ARRAY['Administrator'::text]));

--

-- capture_jobs :: ROW SECURITY
ALTER TABLE public.capture_jobs ENABLE ROW LEVEL SECURITY;

--

-- capture_jobs capture_jobs_select_privileged :: POLICY
DROP POLICY IF EXISTS capture_jobs_select_privileged ON public.capture_jobs;
CREATE POLICY capture_jobs_select_privileged ON public.capture_jobs FOR SELECT TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text, 'Auditor'::text]));

--

-- captures :: ROW SECURITY
ALTER TABLE public.captures ENABLE ROW LEVEL SECURITY;

--

-- captures captures_delete_privileged :: POLICY
DROP POLICY IF EXISTS captures_delete_privileged ON public.captures;
CREATE POLICY captures_delete_privileged ON public.captures FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- captures captures_select_privileged :: POLICY
DROP POLICY IF EXISTS captures_select_privileged ON public.captures;
CREATE POLICY captures_select_privileged ON public.captures FOR SELECT TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text, 'Auditor'::text]));

--

-- cells :: ROW SECURITY
ALTER TABLE public.cells ENABLE ROW LEVEL SECURITY;

--

-- cells cells_delete_privileged :: POLICY
DROP POLICY IF EXISTS cells_delete_privileged ON public.cells;
CREATE POLICY cells_delete_privileged ON public.cells FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- cells cells_insert_privileged :: POLICY
DROP POLICY IF EXISTS cells_insert_privileged ON public.cells;
CREATE POLICY cells_insert_privileged ON public.cells FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- cells cells_select_authenticated :: POLICY
DROP POLICY IF EXISTS cells_select_authenticated ON public.cells;
CREATE POLICY cells_select_authenticated ON public.cells FOR SELECT TO authenticated USING (true);

--

-- cells cells_update_privileged :: POLICY
DROP POLICY IF EXISTS cells_update_privileged ON public.cells;
CREATE POLICY cells_update_privileged ON public.cells FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- change_proposals :: ROW SECURITY
ALTER TABLE public.change_proposals ENABLE ROW LEVEL SECURITY;

--

-- change_proposals change_proposals_insert_proposer :: POLICY
DROP POLICY IF EXISTS change_proposals_insert_proposer ON public.change_proposals;
CREATE POLICY change_proposals_insert_proposer ON public.change_proposals FOR INSERT TO authenticated WITH CHECK ((public.has_authority(ARRAY['proposal:create'::text]) AND (proposed_by = auth.uid()) AND (status = 'open'::text)));

--

-- change_proposals change_proposals_select_own_or_approver :: POLICY
DROP POLICY IF EXISTS change_proposals_select_own_or_approver ON public.change_proposals;
CREATE POLICY change_proposals_select_own_or_approver ON public.change_proposals FOR SELECT TO authenticated USING (((proposed_by = auth.uid()) OR public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])));

--

-- change_proposals change_proposals_update_own_open :: POLICY
DROP POLICY IF EXISTS change_proposals_update_own_open ON public.change_proposals;
CREATE POLICY change_proposals_update_own_open ON public.change_proposals FOR UPDATE TO authenticated USING (((proposed_by = auth.uid()) AND (status = 'open'::text))) WITH CHECK ((proposed_by = auth.uid()));

--

-- device_nameplate :: ROW SECURITY
ALTER TABLE public.device_nameplate ENABLE ROW LEVEL SECURITY;

--

-- device_nameplate device_nameplate_delete_privileged :: POLICY
DROP POLICY IF EXISTS device_nameplate_delete_privileged ON public.device_nameplate;
CREATE POLICY device_nameplate_delete_privileged ON public.device_nameplate FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- device_nameplate device_nameplate_insert_privileged :: POLICY
DROP POLICY IF EXISTS device_nameplate_insert_privileged ON public.device_nameplate;
CREATE POLICY device_nameplate_insert_privileged ON public.device_nameplate FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- device_nameplate device_nameplate_select_authenticated :: POLICY
DROP POLICY IF EXISTS device_nameplate_select_authenticated ON public.device_nameplate;
CREATE POLICY device_nameplate_select_authenticated ON public.device_nameplate FOR SELECT TO authenticated USING (true);

--

-- device_nameplate device_nameplate_update_privileged :: POLICY
DROP POLICY IF EXISTS device_nameplate_update_privileged ON public.device_nameplate;
CREATE POLICY device_nameplate_update_privileged ON public.device_nameplate FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- device_submodels :: ROW SECURITY
ALTER TABLE public.device_submodels ENABLE ROW LEVEL SECURITY;

--

-- device_submodels device_submodels_delete_privileged :: POLICY
DROP POLICY IF EXISTS device_submodels_delete_privileged ON public.device_submodels;
CREATE POLICY device_submodels_delete_privileged ON public.device_submodels FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- device_submodels device_submodels_insert_privileged :: POLICY
DROP POLICY IF EXISTS device_submodels_insert_privileged ON public.device_submodels;
CREATE POLICY device_submodels_insert_privileged ON public.device_submodels FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- device_submodels device_submodels_select_authenticated :: POLICY
DROP POLICY IF EXISTS device_submodels_select_authenticated ON public.device_submodels;
CREATE POLICY device_submodels_select_authenticated ON public.device_submodels FOR SELECT TO authenticated USING (true);

--

-- device_submodels device_submodels_update_privileged :: POLICY
DROP POLICY IF EXISTS device_submodels_update_privileged ON public.device_submodels;
CREATE POLICY device_submodels_update_privileged ON public.device_submodels FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- devices :: ROW SECURITY
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;

--

-- devices devices_delete_privileged :: POLICY
DROP POLICY IF EXISTS devices_delete_privileged ON public.devices;
CREATE POLICY devices_delete_privileged ON public.devices FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- devices devices_insert_privileged :: POLICY
DROP POLICY IF EXISTS devices_insert_privileged ON public.devices;
CREATE POLICY devices_insert_privileged ON public.devices FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- devices devices_select_authenticated :: POLICY
DROP POLICY IF EXISTS devices_select_authenticated ON public.devices;
CREATE POLICY devices_select_authenticated ON public.devices FOR SELECT TO authenticated USING (true);

--

-- devices devices_update_privileged :: POLICY
DROP POLICY IF EXISTS devices_update_privileged ON public.devices;
CREATE POLICY devices_update_privileged ON public.devices FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- directory_liveness_probe :: ROW SECURITY
ALTER TABLE public.directory_liveness_probe ENABLE ROW LEVEL SECURITY;

--

-- directory_services :: ROW SECURITY
ALTER TABLE public.directory_services ENABLE ROW LEVEL SECURITY;

--

-- directory_services directory_services_delete_privileged :: POLICY
DROP POLICY IF EXISTS directory_services_delete_privileged ON public.directory_services;
CREATE POLICY directory_services_delete_privileged ON public.directory_services FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- directory_services directory_services_insert_privileged :: POLICY
DROP POLICY IF EXISTS directory_services_insert_privileged ON public.directory_services;
CREATE POLICY directory_services_insert_privileged ON public.directory_services FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- directory_services directory_services_select_authenticated :: POLICY
DROP POLICY IF EXISTS directory_services_select_authenticated ON public.directory_services;
CREATE POLICY directory_services_select_authenticated ON public.directory_services FOR SELECT TO authenticated USING (true);

--

-- directory_services directory_services_update_privileged :: POLICY
DROP POLICY IF EXISTS directory_services_update_privileged ON public.directory_services;
CREATE POLICY directory_services_update_privileged ON public.directory_services FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- forge_sweep_lease :: ROW SECURITY
ALTER TABLE public.forge_sweep_lease ENABLE ROW LEVEL SECURITY;

--

-- gateway_enrollment_tokens :: ROW SECURITY
ALTER TABLE public.gateway_enrollment_tokens ENABLE ROW LEVEL SECURITY;

--

-- gateway_revocation_requests :: ROW SECURITY
ALTER TABLE public.gateway_revocation_requests ENABLE ROW LEVEL SECURITY;

--

-- gateways :: ROW SECURITY
ALTER TABLE public.gateways ENABLE ROW LEVEL SECURITY;

--

-- gateways gateways_delete_privileged :: POLICY
DROP POLICY IF EXISTS gateways_delete_privileged ON public.gateways;
CREATE POLICY gateways_delete_privileged ON public.gateways FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- gateways gateways_insert_privileged :: POLICY
DROP POLICY IF EXISTS gateways_insert_privileged ON public.gateways;
CREATE POLICY gateways_insert_privileged ON public.gateways FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- gateways gateways_select_authenticated :: POLICY
DROP POLICY IF EXISTS gateways_select_authenticated ON public.gateways;
CREATE POLICY gateways_select_authenticated ON public.gateways FOR SELECT TO authenticated USING (true);

--

-- gateways gateways_update_privileged :: POLICY
DROP POLICY IF EXISTS gateways_update_privileged ON public.gateways;
CREATE POLICY gateways_update_privileged ON public.gateways FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- idta_submodel_templates :: ROW SECURITY
ALTER TABLE public.idta_submodel_templates ENABLE ROW LEVEL SECURITY;

--

-- idta_submodel_templates idta_submodel_templates_select_authenticated :: POLICY
DROP POLICY IF EXISTS idta_submodel_templates_select_authenticated ON public.idta_submodel_templates;
CREATE POLICY idta_submodel_templates_select_authenticated ON public.idta_submodel_templates FOR SELECT TO authenticated USING (true);

--

-- iso22400_vocabulary :: ROW SECURITY
ALTER TABLE public.iso22400_vocabulary ENABLE ROW LEVEL SECURITY;

--

-- iso22400_vocabulary iso22400_vocabulary_select_authenticated :: POLICY
DROP POLICY IF EXISTS iso22400_vocabulary_select_authenticated ON public.iso22400_vocabulary;
CREATE POLICY iso22400_vocabulary_select_authenticated ON public.iso22400_vocabulary FOR SELECT TO authenticated USING (true);

--

-- links :: ROW SECURITY
ALTER TABLE public.links ENABLE ROW LEVEL SECURITY;

--

-- links links_delete_privileged :: POLICY
DROP POLICY IF EXISTS links_delete_privileged ON public.links;
CREATE POLICY links_delete_privileged ON public.links FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- links links_insert_privileged :: POLICY
DROP POLICY IF EXISTS links_insert_privileged ON public.links;
CREATE POLICY links_insert_privileged ON public.links FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- links links_select_authenticated :: POLICY
DROP POLICY IF EXISTS links_select_authenticated ON public.links;
CREATE POLICY links_select_authenticated ON public.links FOR SELECT TO authenticated USING (true);

--

-- links links_update_privileged :: POLICY
DROP POLICY IF EXISTS links_update_privileged ON public.links;
CREATE POLICY links_update_privileged ON public.links FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

--

-- machine_principals :: ROW SECURITY
ALTER TABLE public.machine_principals ENABLE ROW LEVEL SECURITY;

--

-- machine_principals machine_principals_select_admin_or_auditor :: POLICY
DROP POLICY IF EXISTS machine_principals_select_admin_or_auditor ON public.machine_principals;
CREATE POLICY machine_principals_select_admin_or_auditor ON public.machine_principals FOR SELECT TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Auditor'::text]));

--

-- metric_catalog :: ROW SECURITY
ALTER TABLE public.metric_catalog ENABLE ROW LEVEL SECURITY;

--

-- metric_catalog metric_catalog_insert_privileged :: POLICY
DROP POLICY IF EXISTS metric_catalog_insert_privileged ON public.metric_catalog;
CREATE POLICY metric_catalog_insert_privileged ON public.metric_catalog FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text]));

--

-- metric_catalog metric_catalog_select_authenticated :: POLICY
DROP POLICY IF EXISTS metric_catalog_select_authenticated ON public.metric_catalog;
CREATE POLICY metric_catalog_select_authenticated ON public.metric_catalog FOR SELECT TO authenticated USING (true);

--

-- metric_catalog metric_catalog_update_privileged :: POLICY
DROP POLICY IF EXISTS metric_catalog_update_privileged ON public.metric_catalog;
CREATE POLICY metric_catalog_update_privileged ON public.metric_catalog FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text]));

--

-- metric_groups :: ROW SECURITY
ALTER TABLE public.metric_groups ENABLE ROW LEVEL SECURITY;

--

-- metric_groups metric_groups_insert_privileged :: POLICY
DROP POLICY IF EXISTS metric_groups_insert_privileged ON public.metric_groups;
CREATE POLICY metric_groups_insert_privileged ON public.metric_groups FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text]));

--

-- metric_groups metric_groups_select_authenticated :: POLICY
DROP POLICY IF EXISTS metric_groups_select_authenticated ON public.metric_groups;
CREATE POLICY metric_groups_select_authenticated ON public.metric_groups FOR SELECT TO authenticated USING (true);

--

-- metric_groups metric_groups_update_privileged :: POLICY
DROP POLICY IF EXISTS metric_groups_update_privileged ON public.metric_groups;
CREATE POLICY metric_groups_update_privileged ON public.metric_groups FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text]));

--

-- mtconnect_vocabulary :: ROW SECURITY
ALTER TABLE public.mtconnect_vocabulary ENABLE ROW LEVEL SECURITY;

--

-- mtconnect_vocabulary mtconnect_vocabulary_select_authenticated :: POLICY
DROP POLICY IF EXISTS mtconnect_vocabulary_select_authenticated ON public.mtconnect_vocabulary;
CREATE POLICY mtconnect_vocabulary_select_authenticated ON public.mtconnect_vocabulary FOR SELECT TO authenticated USING (true);

--

-- one_shot_migrations :: ROW SECURITY
ALTER TABLE public.one_shot_migrations ENABLE ROW LEVEL SECURITY;

--

-- opcua_vocabulary :: ROW SECURITY
ALTER TABLE public.opcua_vocabulary ENABLE ROW LEVEL SECURITY;

--

-- opcua_vocabulary opcua_vocabulary_select_authenticated :: POLICY
DROP POLICY IF EXISTS opcua_vocabulary_select_authenticated ON public.opcua_vocabulary;
CREATE POLICY opcua_vocabulary_select_authenticated ON public.opcua_vocabulary FOR SELECT TO authenticated USING (true);

--

-- permissions :: ROW SECURITY
ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;

--

-- permissions permissions_select_authenticated :: POLICY
DROP POLICY IF EXISTS permissions_select_authenticated ON public.permissions;
CREATE POLICY permissions_select_authenticated ON public.permissions FOR SELECT TO authenticated USING (true);

--

-- platform_alerts :: ROW SECURITY
ALTER TABLE public.platform_alerts ENABLE ROW LEVEL SECURITY;

--

-- platform_alerts platform_alerts_all_service_role :: POLICY
DROP POLICY IF EXISTS platform_alerts_all_service_role ON public.platform_alerts;
CREATE POLICY platform_alerts_all_service_role ON public.platform_alerts TO service_role USING (true) WITH CHECK (true);

--

-- platform_alerts platform_alerts_select_authenticated :: POLICY
DROP POLICY IF EXISTS platform_alerts_select_authenticated ON public.platform_alerts;
CREATE POLICY platform_alerts_select_authenticated ON public.platform_alerts FOR SELECT TO authenticated USING (true);

--

-- playback_jobs :: ROW SECURITY
ALTER TABLE public.playback_jobs ENABLE ROW LEVEL SECURITY;

--

-- playback_jobs playback_jobs_select_privileged :: POLICY
DROP POLICY IF EXISTS playback_jobs_select_privileged ON public.playback_jobs;
CREATE POLICY playback_jobs_select_privileged ON public.playback_jobs FOR SELECT TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text, 'Auditor'::text]));

--

-- playback_worker_status :: ROW SECURITY
ALTER TABLE public.playback_worker_status ENABLE ROW LEVEL SECURITY;

--

-- playback_worker_status playback_worker_status_select_privileged :: POLICY
DROP POLICY IF EXISTS playback_worker_status_select_privileged ON public.playback_worker_status;
CREATE POLICY playback_worker_status_select_privileged ON public.playback_worker_status FOR SELECT TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text, 'Auditor'::text]));

--

-- principal_permissions :: ROW SECURITY
ALTER TABLE public.principal_permissions ENABLE ROW LEVEL SECURITY;

--

-- principal_permissions principal_permissions_select_own_or_admin :: POLICY
DROP POLICY IF EXISTS principal_permissions_select_own_or_admin ON public.principal_permissions;
CREATE POLICY principal_permissions_select_own_or_admin ON public.principal_permissions FOR SELECT TO authenticated USING (((principal_id = auth.uid()) OR public.has_role(ARRAY['Administrator'::text])));

--

-- rebirth_requests :: ROW SECURITY
ALTER TABLE public.rebirth_requests ENABLE ROW LEVEL SECURITY;

--

-- rebirth_requests rebirth_requests_select_privileged :: POLICY
DROP POLICY IF EXISTS rebirth_requests_select_privileged ON public.rebirth_requests;
CREATE POLICY rebirth_requests_select_privileged ON public.rebirth_requests FOR SELECT TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text, 'Auditor'::text]));

--

-- retired_entities :: ROW SECURITY
ALTER TABLE public.retired_entities ENABLE ROW LEVEL SECURITY;

--

-- retired_entities retired_entities_select_privileged :: POLICY
DROP POLICY IF EXISTS retired_entities_select_privileged ON public.retired_entities;
CREATE POLICY retired_entities_select_privileged ON public.retired_entities FOR SELECT TO authenticated USING (public.has_authority(ARRAY['archive:manage'::text, 'audit_trail:read'::text]));

--

-- revoked_service_principals :: ROW SECURITY
ALTER TABLE public.revoked_service_principals ENABLE ROW LEVEL SECURITY;

--

-- revoked_service_principals revoked_service_principals_select_privileged :: POLICY
DROP POLICY IF EXISTS revoked_service_principals_select_privileged ON public.revoked_service_principals;
CREATE POLICY revoked_service_principals_select_privileged ON public.revoked_service_principals FOR SELECT TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Auditor'::text]));

--

-- revoked_service_tokens :: ROW SECURITY
ALTER TABLE public.revoked_service_tokens ENABLE ROW LEVEL SECURITY;

--

-- revoked_service_tokens revoked_service_tokens_select_privileged :: POLICY
DROP POLICY IF EXISTS revoked_service_tokens_select_privileged ON public.revoked_service_tokens;
CREATE POLICY revoked_service_tokens_select_privileged ON public.revoked_service_tokens FOR SELECT TO authenticated USING (public.has_role(ARRAY['Administrator'::text, 'Auditor'::text]));

--

-- role_permissions :: ROW SECURITY
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

--

-- role_permissions role_permissions_select_authenticated :: POLICY
DROP POLICY IF EXISTS role_permissions_select_authenticated ON public.role_permissions;
CREATE POLICY role_permissions_select_authenticated ON public.role_permissions FOR SELECT TO authenticated USING (true);

--

-- roles :: ROW SECURITY
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;

--

-- roles roles_select_authenticated :: POLICY
DROP POLICY IF EXISTS roles_select_authenticated ON public.roles;
CREATE POLICY roles_select_authenticated ON public.roles FOR SELECT TO authenticated USING (true);

--

-- schema_bootstrap :: ROW SECURITY
ALTER TABLE public.schema_bootstrap ENABLE ROW LEVEL SECURITY;

--

-- schemas :: ROW SECURITY
ALTER TABLE public.schemas ENABLE ROW LEVEL SECURITY;

--

-- schemas schemas_delete_privileged :: POLICY
DROP POLICY IF EXISTS schemas_delete_privileged ON public.schemas;
CREATE POLICY schemas_delete_privileged ON public.schemas FOR DELETE TO authenticated USING (public.has_role(ARRAY['Administrator'::text]));

--

-- schemas schemas_insert_privileged :: POLICY
DROP POLICY IF EXISTS schemas_insert_privileged ON public.schemas;
CREATE POLICY schemas_insert_privileged ON public.schemas FOR INSERT TO authenticated WITH CHECK (public.has_role(ARRAY['Administrator'::text]));

--

-- schemas schemas_select_authenticated :: POLICY
DROP POLICY IF EXISTS schemas_select_authenticated ON public.schemas;
CREATE POLICY schemas_select_authenticated ON public.schemas FOR SELECT TO authenticated USING (true);

--

-- schemas schemas_update_privileged :: POLICY
DROP POLICY IF EXISTS schemas_update_privileged ON public.schemas;
CREATE POLICY schemas_update_privileged ON public.schemas FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text]));

--

-- system_settings :: ROW SECURITY
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

--

-- system_settings system_settings_all_service_role :: POLICY
DROP POLICY IF EXISTS system_settings_all_service_role ON public.system_settings;
CREATE POLICY system_settings_all_service_role ON public.system_settings TO service_role USING (true) WITH CHECK (true);

--

-- system_settings system_settings_select_authenticated :: POLICY
DROP POLICY IF EXISTS system_settings_select_authenticated ON public.system_settings;
CREATE POLICY system_settings_select_authenticated ON public.system_settings FOR SELECT TO authenticated USING (((NOT sensitive) OR public.has_role(ARRAY['Administrator'::text])));

--

-- system_settings system_settings_update_admin :: POLICY
DROP POLICY IF EXISTS system_settings_update_admin ON public.system_settings;
CREATE POLICY system_settings_update_admin ON public.system_settings FOR UPDATE TO authenticated USING (public.has_role(ARRAY['Administrator'::text])) WITH CHECK (public.has_role(ARRAY['Administrator'::text]));

--

-- user_roles :: ROW SECURITY
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

--

-- user_roles user_roles_select_own_or_privileged :: POLICY
DROP POLICY IF EXISTS user_roles_select_own_or_privileged ON public.user_roles;
CREATE POLICY user_roles_select_own_or_privileged ON public.user_roles FOR SELECT TO authenticated USING (((user_id = (auth.uid())::text) OR public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text])));

--

-- webhook_endpoints :: ROW SECURITY
ALTER TABLE public.webhook_endpoints ENABLE ROW LEVEL SECURITY;

--

-- webhook_endpoints webhook_endpoints_select_privileged :: POLICY
DROP POLICY IF EXISTS webhook_endpoints_select_privileged ON public.webhook_endpoints;
CREATE POLICY webhook_endpoints_select_privileged ON public.webhook_endpoints FOR SELECT TO authenticated USING (public.has_role(ARRAY['Administrator'::text]));

--

-- SCHEMA public :: ACL
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
GRANT USAGE ON SCHEMA timescale TO authenticated;
GRANT USAGE ON SCHEMA timescale TO service_role;

--

-- FUNCTION active_schema_version(schema_id uuid) :: ACL
REVOKE ALL ON FUNCTION public.active_schema_version(schema_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.active_schema_version(schema_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.active_schema_version(schema_id uuid) TO authenticated;

--

-- FUNCTION approve_proposal(p_proposal_id uuid) :: ACL
REVOKE ALL ON FUNCTION public.approve_proposal(p_proposal_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.approve_proposal(p_proposal_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.approve_proposal(p_proposal_id uuid) TO authenticated;

--

-- FUNCTION approve_quarantined_device(p_device_id uuid, p_actor_id uuid, p_gateway_id uuid, p_merge_into_device_id uuid, p_asset_name text, p_cell_id uuid, p_location_scope text, p_set_cell boolean, p_set_location_scope boolean, p_area_id uuid, p_set_area boolean) :: ACL
REVOKE ALL ON FUNCTION public.approve_quarantined_device(p_device_id uuid, p_actor_id uuid, p_gateway_id uuid, p_merge_into_device_id uuid, p_asset_name text, p_cell_id uuid, p_location_scope text, p_set_cell boolean, p_set_location_scope boolean, p_area_id uuid, p_set_area boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.approve_quarantined_device(p_device_id uuid, p_actor_id uuid, p_gateway_id uuid, p_merge_into_device_id uuid, p_asset_name text, p_cell_id uuid, p_location_scope text, p_set_cell boolean, p_set_location_scope boolean, p_area_id uuid, p_set_area boolean) TO service_role;

--

-- FUNCTION archive_credential_is_set() :: ACL
REVOKE ALL ON FUNCTION public.archive_credential_is_set() FROM PUBLIC;
GRANT ALL ON FUNCTION public.archive_credential_is_set() TO service_role;
GRANT ALL ON FUNCTION public.archive_credential_is_set() TO authenticated;

--

-- FUNCTION archive_destination_guard() :: ACL
REVOKE ALL ON FUNCTION public.archive_destination_guard() FROM PUBLIC;
GRANT ALL ON FUNCTION public.archive_destination_guard() TO service_role;

--

-- FUNCTION assert_principal_not_revoked(p_principal_id uuid) :: ACL
REVOKE ALL ON FUNCTION public.assert_principal_not_revoked(p_principal_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.assert_principal_not_revoked(p_principal_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.assert_principal_not_revoked(p_principal_id uuid) TO authenticated;

--

-- FUNCTION audit_domain_for(p_entity_type text, p_action text) :: ACL
REVOKE ALL ON FUNCTION public.audit_domain_for(p_entity_type text, p_action text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.audit_domain_for(p_entity_type text, p_action text) TO service_role;

--

-- FUNCTION audit_telemetry_columns() :: ACL
REVOKE ALL ON FUNCTION public.audit_telemetry_columns() FROM PUBLIC;
GRANT ALL ON FUNCTION public.audit_telemetry_columns() TO service_role;
GRANT ALL ON FUNCTION public.audit_telemetry_columns() TO authenticated;

--

-- FUNCTION audit_trail_backup_job_ids_matching(p_pattern text) :: ACL
REVOKE ALL ON FUNCTION public.audit_trail_backup_job_ids_matching(p_pattern text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.audit_trail_backup_job_ids_matching(p_pattern text) TO service_role;
GRANT ALL ON FUNCTION public.audit_trail_backup_job_ids_matching(p_pattern text) TO authenticated;

--

-- FUNCTION audit_trail_page(p_limit integer, p_include_purged boolean, p_entity_type text, p_action text, p_entity_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone, p_before_recorded_at timestamp with time zone, p_before_id bigint, p_search text) :: ACL
REVOKE ALL ON FUNCTION public.audit_trail_page(p_limit integer, p_include_purged boolean, p_entity_type text, p_action text, p_entity_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone, p_before_recorded_at timestamp with time zone, p_before_id bigint, p_search text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.audit_trail_page(p_limit integer, p_include_purged boolean, p_entity_type text, p_action text, p_entity_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone, p_before_recorded_at timestamp with time zone, p_before_id bigint, p_search text) TO service_role;
GRANT ALL ON FUNCTION public.audit_trail_page(p_limit integer, p_include_purged boolean, p_entity_type text, p_action text, p_entity_ids uuid[], p_since timestamp with time zone, p_until timestamp with time zone, p_before_recorded_at timestamp with time zone, p_before_id bigint, p_search text) TO authenticated;

--

-- FUNCTION audit_trail_user_ids_matching(p_pattern text) :: ACL
REVOKE ALL ON FUNCTION public.audit_trail_user_ids_matching(p_pattern text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.audit_trail_user_ids_matching(p_pattern text) TO service_role;
GRANT ALL ON FUNCTION public.audit_trail_user_ids_matching(p_pattern text) TO authenticated;

--

-- FUNCTION auth_pre_request() :: ACL
REVOKE ALL ON FUNCTION public.auth_pre_request() FROM PUBLIC;
GRANT ALL ON FUNCTION public.auth_pre_request() TO anon;
GRANT ALL ON FUNCTION public.auth_pre_request() TO authenticated;
GRANT ALL ON FUNCTION public.auth_pre_request() TO service_role;

--

-- FUNCTION authorize_host_gateway_credential(p_gateway_id uuid) :: ACL
REVOKE ALL ON FUNCTION public.authorize_host_gateway_credential(p_gateway_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.authorize_host_gateway_credential(p_gateway_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.authorize_host_gateway_credential(p_gateway_id uuid) TO authenticated;

--

-- FUNCTION backup_claim_job() :: ACL
REVOKE ALL ON FUNCTION public.backup_claim_job() FROM PUBLIC;

--

-- FUNCTION backup_fail(p_job_id uuid, p_error text) :: ACL
REVOKE ALL ON FUNCTION public.backup_fail(p_job_id uuid, p_error text) FROM PUBLIC;

--

-- FUNCTION backup_finalise(p_job_id uuid, p_stamp text, p_location text, p_components jsonb, p_size_bytes bigint) :: ACL
REVOKE ALL ON FUNCTION public.backup_finalise(p_job_id uuid, p_stamp text, p_location text, p_components jsonb, p_size_bytes bigint) FROM PUBLIC;

--

-- FUNCTION backup_forget(p_backup_id uuid, p_reason text) :: ACL
REVOKE ALL ON FUNCTION public.backup_forget(p_backup_id uuid, p_reason text) FROM PUBLIC;

--

-- FUNCTION backup_offsite_base() :: ACL
REVOKE ALL ON FUNCTION public.backup_offsite_base() FROM PUBLIC;

--

-- FUNCTION backup_offsite_credential_is_set() :: ACL
REVOKE ALL ON FUNCTION public.backup_offsite_credential_is_set() FROM PUBLIC;
GRANT ALL ON FUNCTION public.backup_offsite_credential_is_set() TO service_role;
GRANT ALL ON FUNCTION public.backup_offsite_credential_is_set() TO authenticated;

--

-- FUNCTION backup_offsite_destination() :: ACL
REVOKE ALL ON FUNCTION public.backup_offsite_destination() FROM PUBLIC;

--

-- FUNCTION backup_offsite_health_rows() :: ACL
REVOKE ALL ON FUNCTION public.backup_offsite_health_rows() FROM PUBLIC;
GRANT ALL ON FUNCTION public.backup_offsite_health_rows() TO service_role;
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
    EXECUTE 'GRANT ALL ON FUNCTION public.backup_offsite_health_rows() TO grafana_reader';
  END IF;
END $g$;

--

-- FUNCTION backup_offsite_next() :: ACL
REVOKE ALL ON FUNCTION public.backup_offsite_next() FROM PUBLIC;

--

-- FUNCTION backup_offsite_record(p_backup_id uuid, p_location text, p_objects jsonb, p_error text) :: ACL
REVOKE ALL ON FUNCTION public.backup_offsite_record(p_backup_id uuid, p_location text, p_objects jsonb, p_error text) FROM PUBLIC;

--

-- FUNCTION backup_offsite_setting_guard() :: ACL
REVOKE ALL ON FUNCTION public.backup_offsite_setting_guard() FROM PUBLIC;

--

-- FUNCTION backup_prunable(p_retention_days integer) :: ACL
REVOKE ALL ON FUNCTION public.backup_prunable(p_retention_days integer) FROM PUBLIC;

--

-- FUNCTION backup_reconcile_jobs(p_reason text) :: ACL
REVOKE ALL ON FUNCTION public.backup_reconcile_jobs(p_reason text) FROM PUBLIC;

--

-- FUNCTION backup_schedule(p_cron text) :: ACL
REVOKE ALL ON FUNCTION public.backup_schedule(p_cron text) FROM PUBLIC;

--

-- FUNCTION cancel_backup_job(p_job_id uuid) :: ACL
REVOKE ALL ON FUNCTION public.cancel_backup_job(p_job_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.cancel_backup_job(p_job_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.cancel_backup_job(p_job_id uuid) TO authenticated;

--

-- FUNCTION capped_capture_manifest(p_manifest jsonb) :: ACL
REVOKE ALL ON FUNCTION public.capped_capture_manifest(p_manifest jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.capped_capture_manifest(p_manifest jsonb) TO service_role;
GRANT ALL ON FUNCTION public.capped_capture_manifest(p_manifest jsonb) TO authenticated;

--

-- FUNCTION claim_forge_sweep(p_seconds integer) :: ACL
REVOKE ALL ON FUNCTION public.claim_forge_sweep(p_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_forge_sweep(p_seconds integer) TO service_role;

--

-- FUNCTION clear_backup_offsite_destination() :: ACL
REVOKE ALL ON FUNCTION public.clear_backup_offsite_destination() FROM PUBLIC;
GRANT ALL ON FUNCTION public.clear_backup_offsite_destination() TO service_role;
GRANT ALL ON FUNCTION public.clear_backup_offsite_destination() TO authenticated;

--

-- FUNCTION clear_credential_revoked_on_enrolment() :: ACL
REVOKE ALL ON FUNCTION public.clear_credential_revoked_on_enrolment() FROM PUBLIC;
GRANT ALL ON FUNCTION public.clear_credential_revoked_on_enrolment() TO service_role;

--

-- FUNCTION cold_archive_backlog() :: ACL
REVOKE ALL ON FUNCTION public.cold_archive_backlog() FROM PUBLIC;
GRANT ALL ON FUNCTION public.cold_archive_backlog() TO service_role;
GRANT ALL ON FUNCTION public.cold_archive_backlog() TO authenticated;

--

-- FUNCTION cold_archive_backlog_state() :: ACL
REVOKE ALL ON FUNCTION public.cold_archive_backlog_state() FROM PUBLIC;
GRANT ALL ON FUNCTION public.cold_archive_backlog_state() TO service_role;

--

-- FUNCTION cold_archive_destination() :: ACL
REVOKE ALL ON FUNCTION public.cold_archive_destination() FROM PUBLIC;
GRANT ALL ON FUNCTION public.cold_archive_destination() TO service_role;
GRANT ALL ON FUNCTION public.cold_archive_destination() TO authenticated;

--

-- FUNCTION cold_storage_rows() :: ACL
REVOKE ALL ON FUNCTION public.cold_storage_rows() FROM PUBLIC;
GRANT ALL ON FUNCTION public.cold_storage_rows() TO service_role;
GRANT ALL ON FUNCTION public.cold_storage_rows() TO authenticated;

--

-- FUNCTION consume_gateway_enrollment_token(p_token text) :: ACL
REVOKE ALL ON FUNCTION public.consume_gateway_enrollment_token(p_token text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.consume_gateway_enrollment_token(p_token text) TO service_role;

--

-- FUNCTION create_machine_principal(p_name text, p_permissions text[], p_purpose text) :: ACL
REVOKE ALL ON FUNCTION public.create_machine_principal(p_name text, p_permissions text[], p_purpose text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_machine_principal(p_name text, p_permissions text[], p_purpose text) TO service_role;
GRANT ALL ON FUNCTION public.create_machine_principal(p_name text, p_permissions text[], p_purpose text) TO authenticated;

--

-- FUNCTION custom_access_token_hook(event jsonb) :: ACL
REVOKE ALL ON FUNCTION public.custom_access_token_hook(event jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.custom_access_token_hook(event jsonb) TO service_role;
GRANT ALL ON FUNCTION public.custom_access_token_hook(event jsonb) TO supabase_auth_admin;

--

-- FUNCTION delete_device_asset_config() :: ACL
REVOKE ALL ON FUNCTION public.delete_device_asset_config() FROM PUBLIC;
GRANT ALL ON FUNCTION public.delete_device_asset_config() TO service_role;

--

-- FUNCTION describe_machine_principal(p_principal_id uuid, p_name text, p_purpose text) :: ACL
REVOKE ALL ON FUNCTION public.describe_machine_principal(p_principal_id uuid, p_name text, p_purpose text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.describe_machine_principal(p_principal_id uuid, p_name text, p_purpose text) TO service_role;
GRANT ALL ON FUNCTION public.describe_machine_principal(p_principal_id uuid, p_name text, p_purpose text) TO authenticated;

--

-- FUNCTION directory_liveness_job_map() :: ACL
REVOKE ALL ON FUNCTION public.directory_liveness_job_map() FROM PUBLIC;
GRANT ALL ON FUNCTION public.directory_liveness_job_map() TO service_role;

--

-- FUNCTION discard_schema_draft(p_schema_id uuid) :: ACL
REVOKE ALL ON FUNCTION public.discard_schema_draft(p_schema_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.discard_schema_draft(p_schema_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.discard_schema_draft(p_schema_id uuid) TO authenticated;

--

-- FUNCTION dispatch_device_quarantine_webhook() :: ACL
REVOKE ALL ON FUNCTION public.dispatch_device_quarantine_webhook() FROM PUBLIC;
GRANT ALL ON FUNCTION public.dispatch_device_quarantine_webhook() TO service_role;
GRANT ALL ON FUNCTION public.dispatch_device_quarantine_webhook() TO authenticated;

--

-- FUNCTION enforce_audit_trail_append_only() :: ACL
REVOKE ALL ON FUNCTION public.enforce_audit_trail_append_only() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enforce_audit_trail_append_only() TO service_role;

--

-- FUNCTION enforce_metric_catalog_immutability() :: ACL
REVOKE ALL ON FUNCTION public.enforce_metric_catalog_immutability() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enforce_metric_catalog_immutability() TO service_role;
GRANT ALL ON FUNCTION public.enforce_metric_catalog_immutability() TO authenticated;

--

-- FUNCTION enforce_metric_group_spelling() :: ACL
REVOKE ALL ON FUNCTION public.enforce_metric_group_spelling() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enforce_metric_group_spelling() TO service_role;
GRANT ALL ON FUNCTION public.enforce_metric_group_spelling() TO authenticated;

--

-- FUNCTION enforce_open_proposal_cap() :: ACL
REVOKE ALL ON FUNCTION public.enforce_open_proposal_cap() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enforce_open_proposal_cap() TO service_role;

--

-- FUNCTION enforce_schema_version_provenance() :: ACL
REVOKE ALL ON FUNCTION public.enforce_schema_version_provenance() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enforce_schema_version_provenance() TO service_role;
GRANT ALL ON FUNCTION public.enforce_schema_version_provenance() TO authenticated;

--

-- FUNCTION enqueue_scheduled_backup() :: ACL
REVOKE ALL ON FUNCTION public.enqueue_scheduled_backup() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enqueue_scheduled_backup() TO service_role;

--

-- FUNCTION ensure_audit_trail_partition(p_month timestamp with time zone) :: ACL
REVOKE ALL ON FUNCTION public.ensure_audit_trail_partition(p_month timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ensure_audit_trail_partition(p_month timestamp with time zone) TO service_role;

--

-- FUNCTION ensure_audit_trail_partitions(p_months_ahead integer) :: ACL
REVOKE ALL ON FUNCTION public.ensure_audit_trail_partitions(p_months_ahead integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ensure_audit_trail_partitions(p_months_ahead integer) TO service_role;

--

-- FUNCTION ensure_cron_job(p_name text, p_schedule text, p_command text) :: ACL
REVOKE ALL ON FUNCTION public.ensure_cron_job(p_name text, p_schedule text, p_command text) FROM PUBLIC;

--

-- FUNCTION ensure_gateway_status_view() :: ACL
REVOKE ALL ON FUNCTION public.ensure_gateway_status_view() FROM PUBLIC;
GRANT ALL ON FUNCTION public.ensure_gateway_status_view() TO service_role;

--

-- FUNCTION ensure_shadow_devices(p_capture_id uuid) :: ACL
REVOKE ALL ON FUNCTION public.ensure_shadow_devices(p_capture_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ensure_shadow_devices(p_capture_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.ensure_shadow_devices(p_capture_id uuid) TO authenticated;

--

-- FUNCTION expire_open_proposals() :: ACL
REVOKE ALL ON FUNCTION public.expire_open_proposals() FROM PUBLIC;
GRANT ALL ON FUNCTION public.expire_open_proposals() TO service_role;

--

-- FUNCTION fork_schema(parent_schema_id uuid, change_description text) :: ACL
REVOKE ALL ON FUNCTION public.fork_schema(parent_schema_id uuid, change_description text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.fork_schema(parent_schema_id uuid, change_description text) TO service_role;
GRANT ALL ON FUNCTION public.fork_schema(parent_schema_id uuid, change_description text) TO authenticated;

--

-- FUNCTION sparkplug_group_default() :: ACL
REVOKE ALL ON FUNCTION public.sparkplug_group_default() FROM PUBLIC;
GRANT ALL ON FUNCTION public.sparkplug_group_default() TO service_role;
GRANT ALL ON FUNCTION public.sparkplug_group_default() TO authenticated;

--

-- TABLE gateways :: ACL
GRANT ALL ON TABLE public.gateways TO service_role;
GRANT ALL ON TABLE public.gateways TO authenticated;

--

-- FUNCTION gateway_has_broker_credential(g public.gateways) :: ACL
REVOKE ALL ON FUNCTION public.gateway_has_broker_credential(g public.gateways) FROM PUBLIC;
GRANT ALL ON FUNCTION public.gateway_has_broker_credential(g public.gateways) TO service_role;
GRANT ALL ON FUNCTION public.gateway_has_broker_credential(g public.gateways) TO authenticated;

--

-- FUNCTION gateway_health_rows() :: ACL
REVOKE ALL ON FUNCTION public.gateway_health_rows() FROM PUBLIC;
GRANT ALL ON FUNCTION public.gateway_health_rows() TO service_role;
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
    EXECUTE 'GRANT ALL ON FUNCTION public.gateway_health_rows() TO grafana_reader';
  END IF;
END $g$;

--

-- FUNCTION gateway_holds_a_credential(g public.gateways) :: ACL
REVOKE ALL ON FUNCTION public.gateway_holds_a_credential(g public.gateways) FROM PUBLIC;
GRANT ALL ON FUNCTION public.gateway_holds_a_credential(g public.gateways) TO service_role;

--

-- FUNCTION gateway_is_playback_delivery_target(p_gateway_id uuid) :: ACL
REVOKE ALL ON FUNCTION public.gateway_is_playback_delivery_target(p_gateway_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.gateway_is_playback_delivery_target(p_gateway_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.gateway_is_playback_delivery_target(p_gateway_id uuid) TO authenticated;

--

-- FUNCTION guard_change_proposal_transition() :: ACL
REVOKE ALL ON FUNCTION public.guard_change_proposal_transition() FROM PUBLIC;
GRANT ALL ON FUNCTION public.guard_change_proposal_transition() TO service_role;

--

-- FUNCTION handle_new_user() :: ACL
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;
GRANT ALL ON FUNCTION public.handle_new_user() TO service_role;

--

-- FUNCTION has_authority(allowed_permissions text[]) :: ACL
REVOKE ALL ON FUNCTION public.has_authority(allowed_permissions text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.has_authority(allowed_permissions text[]) TO service_role;
GRANT ALL ON FUNCTION public.has_authority(allowed_permissions text[]) TO authenticated;

--

-- FUNCTION has_role(allowed_roles text[]) :: ACL
REVOKE ALL ON FUNCTION public.has_role(allowed_roles text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.has_role(allowed_roles text[]) TO service_role;
GRANT ALL ON FUNCTION public.has_role(allowed_roles text[]) TO authenticated;

--

-- FUNCTION historian_backup_state() :: ACL
REVOKE ALL ON FUNCTION public.historian_backup_state() FROM PUBLIC;
GRANT ALL ON FUNCTION public.historian_backup_state() TO service_role;
GRANT ALL ON FUNCTION public.historian_backup_state() TO authenticated;

--

-- FUNCTION i3x_auth_probe() :: ACL
REVOKE ALL ON FUNCTION public.i3x_auth_probe() FROM PUBLIC;
GRANT ALL ON FUNCTION public.i3x_auth_probe() TO service_role;
GRANT ALL ON FUNCTION public.i3x_auth_probe() TO authenticated;

--

-- FUNCTION ingest_capture_progress(p_job_id uuid, p_messages bigint, p_bytes bigint, p_elapsed_seconds integer, p_birth_captured boolean) :: ACL
REVOKE ALL ON FUNCTION public.ingest_capture_progress(p_job_id uuid, p_messages bigint, p_bytes bigint, p_elapsed_seconds integer, p_birth_captured boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_capture_progress(p_job_id uuid, p_messages bigint, p_bytes bigint, p_elapsed_seconds integer, p_birth_captured boolean) TO service_role;
GRANT ALL ON FUNCTION public.ingest_capture_progress(p_job_id uuid, p_messages bigint, p_bytes bigint, p_elapsed_seconds integer, p_birth_captured boolean) TO authenticated;

--

-- FUNCTION ingest_claim_capture_job() :: ACL
REVOKE ALL ON FUNCTION public.ingest_claim_capture_job() FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_claim_capture_job() TO service_role;
GRANT ALL ON FUNCTION public.ingest_claim_capture_job() TO authenticated;

--

-- FUNCTION ingest_claim_rebirth_requests() :: ACL
REVOKE ALL ON FUNCTION public.ingest_claim_rebirth_requests() FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_claim_rebirth_requests() TO service_role;
GRANT ALL ON FUNCTION public.ingest_claim_rebirth_requests() TO authenticated;

--

-- FUNCTION ingest_fail_capture(p_job_id uuid, p_error text) :: ACL
REVOKE ALL ON FUNCTION public.ingest_fail_capture(p_job_id uuid, p_error text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_fail_capture(p_job_id uuid, p_error text) TO service_role;
GRANT ALL ON FUNCTION public.ingest_fail_capture(p_job_id uuid, p_error text) TO authenticated;

--

-- FUNCTION ingest_finalise_capture(p_job_id uuid, p_size_bytes bigint, p_message_count integer, p_manifest jsonb) :: ACL
REVOKE ALL ON FUNCTION public.ingest_finalise_capture(p_job_id uuid, p_size_bytes bigint, p_message_count integer, p_manifest jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_finalise_capture(p_job_id uuid, p_size_bytes bigint, p_message_count integer, p_manifest jsonb) TO service_role;
GRANT ALL ON FUNCTION public.ingest_finalise_capture(p_job_id uuid, p_size_bytes bigint, p_message_count integer, p_manifest jsonb) TO authenticated;

--

-- FUNCTION ingest_mark_device_offline(p_device_id uuid) :: ACL
REVOKE ALL ON FUNCTION public.ingest_mark_device_offline(p_device_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_mark_device_offline(p_device_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.ingest_mark_device_offline(p_device_id uuid) TO authenticated;

--

-- FUNCTION ingest_mark_gateway_devices_offline(p_gateway_id uuid) :: ACL
REVOKE ALL ON FUNCTION public.ingest_mark_gateway_devices_offline(p_gateway_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_mark_gateway_devices_offline(p_gateway_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.ingest_mark_gateway_devices_offline(p_gateway_id uuid) TO authenticated;

--

-- FUNCTION ingest_reconcile_capture_jobs() :: ACL
REVOKE ALL ON FUNCTION public.ingest_reconcile_capture_jobs() FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_reconcile_capture_jobs() TO service_role;
GRANT ALL ON FUNCTION public.ingest_reconcile_capture_jobs() TO authenticated;

--

-- FUNCTION ingest_record_declared_metrics(p_device_id uuid, p_metrics text[], p_observed_at timestamp with time zone) :: ACL
REVOKE ALL ON FUNCTION public.ingest_record_declared_metrics(p_device_id uuid, p_metrics text[], p_observed_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_record_declared_metrics(p_device_id uuid, p_metrics text[], p_observed_at timestamp with time zone) TO service_role;
GRANT ALL ON FUNCTION public.ingest_record_declared_metrics(p_device_id uuid, p_metrics text[], p_observed_at timestamp with time zone) TO authenticated;

--

-- FUNCTION ingest_record_gateway_health(p_gateway_id uuid, p_status text, p_heartbeat_at timestamp with time zone, p_health jsonb) :: ACL
REVOKE ALL ON FUNCTION public.ingest_record_gateway_health(p_gateway_id uuid, p_status text, p_heartbeat_at timestamp with time zone, p_health jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_record_gateway_health(p_gateway_id uuid, p_status text, p_heartbeat_at timestamp with time zone, p_health jsonb) TO service_role;
GRANT ALL ON FUNCTION public.ingest_record_gateway_health(p_gateway_id uuid, p_status text, p_heartbeat_at timestamp with time zone, p_health jsonb) TO authenticated;

--

-- FUNCTION ingest_record_rebirth_outcome(p_id uuid, p_throttled boolean, p_error text) :: ACL
REVOKE ALL ON FUNCTION public.ingest_record_rebirth_outcome(p_id uuid, p_throttled boolean, p_error text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_record_rebirth_outcome(p_id uuid, p_throttled boolean, p_error text) TO service_role;
GRANT ALL ON FUNCTION public.ingest_record_rebirth_outcome(p_id uuid, p_throttled boolean, p_error text) TO authenticated;

--

-- FUNCTION ingest_register_quarantined_device(p_name text, p_gateway_id uuid, p_reported_identity text, p_quarantine_reason text, p_identity_source text, p_declared_metrics text[], p_observed_at timestamp with time zone) :: ACL
REVOKE ALL ON FUNCTION public.ingest_register_quarantined_device(p_name text, p_gateway_id uuid, p_reported_identity text, p_quarantine_reason text, p_identity_source text, p_declared_metrics text[], p_observed_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_register_quarantined_device(p_name text, p_gateway_id uuid, p_reported_identity text, p_quarantine_reason text, p_identity_source text, p_declared_metrics text[], p_observed_at timestamp with time zone) TO service_role;
GRANT ALL ON FUNCTION public.ingest_register_quarantined_device(p_name text, p_gateway_id uuid, p_reported_identity text, p_quarantine_reason text, p_identity_source text, p_declared_metrics text[], p_observed_at timestamp with time zone) TO authenticated;

--

-- FUNCTION ingest_requarantine_device(p_device_id uuid, p_quarantine_reason text, p_reported_identity text) :: ACL
REVOKE ALL ON FUNCTION public.ingest_requarantine_device(p_device_id uuid, p_quarantine_reason text, p_reported_identity text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_requarantine_device(p_device_id uuid, p_quarantine_reason text, p_reported_identity text) TO service_role;
GRANT ALL ON FUNCTION public.ingest_requarantine_device(p_device_id uuid, p_quarantine_reason text, p_reported_identity text) TO authenticated;

--

-- FUNCTION ingest_set_device_state(p_device_id uuid, p_status text, p_identity_source text, p_first_dbirth_at timestamp with time zone) :: ACL
REVOKE ALL ON FUNCTION public.ingest_set_device_state(p_device_id uuid, p_status text, p_identity_source text, p_first_dbirth_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_set_device_state(p_device_id uuid, p_status text, p_identity_source text, p_first_dbirth_at timestamp with time zone) TO service_role;
GRANT ALL ON FUNCTION public.ingest_set_device_state(p_device_id uuid, p_status text, p_identity_source text, p_first_dbirth_at timestamp with time zone) TO authenticated;

--

-- FUNCTION ingest_store_birth_parameters(p_asset_id text, p_rows jsonb, p_observed_at timestamp with time zone) :: ACL
REVOKE ALL ON FUNCTION public.ingest_store_birth_parameters(p_asset_id text, p_rows jsonb, p_observed_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ingest_store_birth_parameters(p_asset_id text, p_rows jsonb, p_observed_at timestamp with time zone) TO service_role;
GRANT ALL ON FUNCTION public.ingest_store_birth_parameters(p_asset_id text, p_rows jsonb, p_observed_at timestamp with time zone) TO authenticated;

--

-- FUNCTION is_active_capture_object(p_name text) :: ACL
REVOKE ALL ON FUNCTION public.is_active_capture_object(p_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_active_capture_object(p_name text) TO service_role;
GRANT ALL ON FUNCTION public.is_active_capture_object(p_name text) TO authenticated;

--

-- FUNCTION is_active_playback_capture(p_name text) :: ACL
REVOKE ALL ON FUNCTION public.is_active_playback_capture(p_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_active_playback_capture(p_name text) TO service_role;
GRANT ALL ON FUNCTION public.is_active_playback_capture(p_name text) TO authenticated;

--

-- FUNCTION is_area_plan_path(p_name text) :: ACL
REVOKE ALL ON FUNCTION public.is_area_plan_path(p_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_area_plan_path(p_name text) TO service_role;
GRANT ALL ON FUNCTION public.is_area_plan_path(p_name text) TO authenticated;

--

-- FUNCTION is_capture_subject_prefix(p_folder text) :: ACL
REVOKE ALL ON FUNCTION public.is_capture_subject_prefix(p_folder text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_capture_subject_prefix(p_folder text) TO service_role;
GRANT ALL ON FUNCTION public.is_capture_subject_prefix(p_folder text) TO authenticated;

--

-- FUNCTION is_ingestion_caller() :: ACL
REVOKE ALL ON FUNCTION public.is_ingestion_caller() FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_ingestion_caller() TO service_role;
GRANT ALL ON FUNCTION public.is_ingestion_caller() TO authenticated;

--

-- FUNCTION is_machine_principal(p_user_id uuid) :: ACL
REVOKE ALL ON FUNCTION public.is_machine_principal(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_machine_principal(p_user_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.is_machine_principal(p_user_id uuid) TO authenticated;

--

-- FUNCTION is_playback_caller() :: ACL
REVOKE ALL ON FUNCTION public.is_playback_caller() FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_playback_caller() TO service_role;
GRANT ALL ON FUNCTION public.is_playback_caller() TO authenticated;

--

-- FUNCTION is_valid_quarantine_reason(p_reason text) :: ACL
REVOKE ALL ON FUNCTION public.is_valid_quarantine_reason(p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_valid_quarantine_reason(p_reason text) TO service_role;
GRANT ALL ON FUNCTION public.is_valid_quarantine_reason(p_reason text) TO authenticated;

--

-- FUNCTION issue_gateway_enrollment_token(p_gateway_id uuid, p_ttl_minutes integer) :: ACL
REVOKE ALL ON FUNCTION public.issue_gateway_enrollment_token(p_gateway_id uuid, p_ttl_minutes integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.issue_gateway_enrollment_token(p_gateway_id uuid, p_ttl_minutes integer) TO service_role;
GRANT ALL ON FUNCTION public.issue_gateway_enrollment_token(p_gateway_id uuid, p_ttl_minutes integer) TO authenticated;

--

-- FUNCTION list_machine_principals() :: ACL
REVOKE ALL ON FUNCTION public.list_machine_principals() FROM PUBLIC;
GRANT ALL ON FUNCTION public.list_machine_principals() TO service_role;
GRANT ALL ON FUNCTION public.list_machine_principals() TO authenticated;

--

-- FUNCTION list_proposer_names() :: ACL
REVOKE ALL ON FUNCTION public.list_proposer_names() FROM PUBLIC;
GRANT ALL ON FUNCTION public.list_proposer_names() TO service_role;
GRANT ALL ON FUNCTION public.list_proposer_names() TO authenticated;

--

-- FUNCTION list_user_accounts() :: ACL
REVOKE ALL ON FUNCTION public.list_user_accounts() FROM PUBLIC;
GRANT ALL ON FUNCTION public.list_user_accounts() TO service_role;
GRANT ALL ON FUNCTION public.list_user_accounts() TO authenticated;

--

-- FUNCTION log_asset_export() :: ACL
REVOKE ALL ON FUNCTION public.log_asset_export() FROM PUBLIC;
GRANT ALL ON FUNCTION public.log_asset_export() TO service_role;

--

-- FUNCTION log_audit_trail_event() :: ACL
REVOKE ALL ON FUNCTION public.log_audit_trail_event() FROM PUBLIC;
GRANT ALL ON FUNCTION public.log_audit_trail_event() TO service_role;

--

-- FUNCTION log_role_assignment() :: ACL
REVOKE ALL ON FUNCTION public.log_role_assignment() FROM PUBLIC;
GRANT ALL ON FUNCTION public.log_role_assignment() TO service_role;

--

-- FUNCTION may_decide_proposal(p_entity_type text) :: ACL
REVOKE ALL ON FUNCTION public.may_decide_proposal(p_entity_type text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.may_decide_proposal(p_entity_type text) TO service_role;
GRANT ALL ON FUNCTION public.may_decide_proposal(p_entity_type text) TO authenticated;

--

-- FUNCTION may_manage_captures() :: ACL
REVOKE ALL ON FUNCTION public.may_manage_captures() FROM PUBLIC;
GRANT ALL ON FUNCTION public.may_manage_captures() TO service_role;
GRANT ALL ON FUNCTION public.may_manage_captures() TO authenticated;

--

-- FUNCTION peek_gateway_enrollment_token(p_token text) :: ACL
REVOKE ALL ON FUNCTION public.peek_gateway_enrollment_token(p_token text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.peek_gateway_enrollment_token(p_token text) TO service_role;

--

-- FUNCTION place_cell_in_its_area() :: ACL
REVOKE ALL ON FUNCTION public.place_cell_in_its_area() FROM PUBLIC;
GRANT ALL ON FUNCTION public.place_cell_in_its_area() TO service_role;

--

-- FUNCTION plan_distance(p_x1 numeric, p_y1 numeric, p_x2 numeric, p_y2 numeric, p_aspect numeric) :: ACL
REVOKE ALL ON FUNCTION public.plan_distance(p_x1 numeric, p_y1 numeric, p_x2 numeric, p_y2 numeric, p_aspect numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.plan_distance(p_x1 numeric, p_y1 numeric, p_x2 numeric, p_y2 numeric, p_aspect numeric) TO service_role;
GRANT ALL ON FUNCTION public.plan_distance(p_x1 numeric, p_y1 numeric, p_x2 numeric, p_y2 numeric, p_aspect numeric) TO authenticated;

--

-- FUNCTION platform_health_rows() :: ACL
REVOKE ALL ON FUNCTION public.platform_health_rows() FROM PUBLIC;
GRANT ALL ON FUNCTION public.platform_health_rows() TO service_role;
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
    EXECUTE 'GRANT ALL ON FUNCTION public.platform_health_rows() TO grafana_reader';
  END IF;
END $g$;

--

-- FUNCTION platform_storage_rows() :: ACL
REVOKE ALL ON FUNCTION public.platform_storage_rows() FROM PUBLIC;
GRANT ALL ON FUNCTION public.platform_storage_rows() TO service_role;
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
    EXECUTE 'GRANT ALL ON FUNCTION public.platform_storage_rows() TO grafana_reader';
  END IF;
END $g$;

--

-- FUNCTION playback_claim_job() :: ACL
REVOKE ALL ON FUNCTION public.playback_claim_job() FROM PUBLIC;
GRANT ALL ON FUNCTION public.playback_claim_job() TO service_role;
GRANT ALL ON FUNCTION public.playback_claim_job() TO authenticated;

--

-- FUNCTION playback_finish(p_job_id uuid, p_messages_sent integer, p_error text, p_messages_out_of_window integer) :: ACL
REVOKE ALL ON FUNCTION public.playback_finish(p_job_id uuid, p_messages_sent integer, p_error text, p_messages_out_of_window integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.playback_finish(p_job_id uuid, p_messages_sent integer, p_error text, p_messages_out_of_window integer) TO service_role;
GRANT ALL ON FUNCTION public.playback_finish(p_job_id uuid, p_messages_sent integer, p_error text, p_messages_out_of_window integer) TO authenticated;

--

-- FUNCTION playback_progress(p_job_id uuid, p_messages_sent integer, p_messages_total integer, p_elapsed_seconds integer) :: ACL
REVOKE ALL ON FUNCTION public.playback_progress(p_job_id uuid, p_messages_sent integer, p_messages_total integer, p_elapsed_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.playback_progress(p_job_id uuid, p_messages_sent integer, p_messages_total integer, p_elapsed_seconds integer) TO service_role;
GRANT ALL ON FUNCTION public.playback_progress(p_job_id uuid, p_messages_sent integer, p_messages_total integer, p_elapsed_seconds integer) TO authenticated;

--

-- FUNCTION playback_reconcile_jobs() :: ACL
REVOKE ALL ON FUNCTION public.playback_reconcile_jobs() FROM PUBLIC;
GRANT ALL ON FUNCTION public.playback_reconcile_jobs() TO service_role;
GRANT ALL ON FUNCTION public.playback_reconcile_jobs() TO authenticated;

--

-- FUNCTION playback_report_credentials(p_edge_nodes text[], p_rotated text[]) :: ACL
REVOKE ALL ON FUNCTION public.playback_report_credentials(p_edge_nodes text[], p_rotated text[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.playback_report_credentials(p_edge_nodes text[], p_rotated text[]) TO service_role;
GRANT ALL ON FUNCTION public.playback_report_credentials(p_edge_nodes text[], p_rotated text[]) TO authenticated;

--

-- FUNCTION playback_stale_credentials() :: ACL
REVOKE ALL ON FUNCTION public.playback_stale_credentials() FROM PUBLIC;
GRANT ALL ON FUNCTION public.playback_stale_credentials() TO service_role;
GRANT ALL ON FUNCTION public.playback_stale_credentials() TO authenticated;

--

-- FUNCTION playback_target_must_be_shadow() :: ACL
REVOKE ALL ON FUNCTION public.playback_target_must_be_shadow() FROM PUBLIC;
GRANT ALL ON FUNCTION public.playback_target_must_be_shadow() TO service_role;

--

-- FUNCTION prevent_active_schema_mutation() :: ACL
REVOKE ALL ON FUNCTION public.prevent_active_schema_mutation() FROM PUBLIC;
GRANT ALL ON FUNCTION public.prevent_active_schema_mutation() TO service_role;
GRANT ALL ON FUNCTION public.prevent_active_schema_mutation() TO authenticated;

--

-- FUNCTION proposable_columns(p_entity_type text) :: ACL
REVOKE ALL ON FUNCTION public.proposable_columns(p_entity_type text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.proposable_columns(p_entity_type text) TO service_role;
GRANT ALL ON FUNCTION public.proposable_columns(p_entity_type text) TO authenticated;

--

-- FUNCTION proposal_is_already_true(p_proposal_id uuid) :: ACL
REVOKE ALL ON FUNCTION public.proposal_is_already_true(p_proposal_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.proposal_is_already_true(p_proposal_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.proposal_is_already_true(p_proposal_id uuid) TO authenticated;

--

-- FUNCTION prune_closed_proposals() :: ACL
REVOKE ALL ON FUNCTION public.prune_closed_proposals() FROM PUBLIC;
GRANT ALL ON FUNCTION public.prune_closed_proposals() TO service_role;

--

-- FUNCTION prune_platform_alerts(p_retain interval) :: ACL
REVOKE ALL ON FUNCTION public.prune_platform_alerts(p_retain interval) FROM PUBLIC;

--

-- FUNCTION publish_schema_version(draft_schema_id uuid) :: ACL
REVOKE ALL ON FUNCTION public.publish_schema_version(draft_schema_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.publish_schema_version(draft_schema_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.publish_schema_version(draft_schema_id uuid) TO authenticated;

--

-- FUNCTION raw_telemetry_window() :: ACL
REVOKE ALL ON FUNCTION public.raw_telemetry_window() FROM PUBLIC;
GRANT ALL ON FUNCTION public.raw_telemetry_window() TO service_role;
GRANT ALL ON FUNCTION public.raw_telemetry_window() TO authenticated;

--

-- FUNCTION record_directory_images(p_images jsonb) :: ACL
REVOKE ALL ON FUNCTION public.record_directory_images(p_images jsonb) FROM PUBLIC;

--

-- FUNCTION record_gateway_credential_issued(p_gateway_id uuid) :: ACL
REVOKE ALL ON FUNCTION public.record_gateway_credential_issued(p_gateway_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_gateway_credential_issued(p_gateway_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.record_gateway_credential_issued(p_gateway_id uuid) TO authenticated;

--

-- FUNCTION record_gateway_credential_issued_by_service(p_gateway_id uuid, p_context jsonb) :: ACL
REVOKE ALL ON FUNCTION public.record_gateway_credential_issued_by_service(p_gateway_id uuid, p_context jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_gateway_credential_issued_by_service(p_gateway_id uuid, p_context jsonb) TO service_role;

--

-- FUNCTION record_ingestion_rejection(p_device_id uuid, p_violations jsonb, p_observed_at timestamp with time zone) :: ACL
REVOKE ALL ON FUNCTION public.record_ingestion_rejection(p_device_id uuid, p_violations jsonb, p_observed_at timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_ingestion_rejection(p_device_id uuid, p_violations jsonb, p_observed_at timestamp with time zone) TO service_role;
GRANT ALL ON FUNCTION public.record_ingestion_rejection(p_device_id uuid, p_violations jsonb, p_observed_at timestamp with time zone) TO authenticated;

--

-- FUNCTION record_retired_entity() :: ACL
REVOKE ALL ON FUNCTION public.record_retired_entity() FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_retired_entity() TO service_role;

--

-- FUNCTION record_service_token_issued(p_principal_id uuid, p_jti text, p_expires_at timestamp with time zone, p_context jsonb, p_actor_id uuid) :: ACL
REVOKE ALL ON FUNCTION public.record_service_token_issued(p_principal_id uuid, p_jti text, p_expires_at timestamp with time zone, p_context jsonb, p_actor_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_service_token_issued(p_principal_id uuid, p_jti text, p_expires_at timestamp with time zone, p_context jsonb, p_actor_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.record_service_token_issued(p_principal_id uuid, p_jti text, p_expires_at timestamp with time zone, p_context jsonb, p_actor_id uuid) TO authenticated;

--

-- FUNCTION refresh_directory_liveness() :: ACL
REVOKE ALL ON FUNCTION public.refresh_directory_liveness() FROM PUBLIC;
GRANT ALL ON FUNCTION public.refresh_directory_liveness() TO service_role;

--

-- FUNCTION refuse_archiving_the_last_shadow_gateway() :: ACL
REVOKE ALL ON FUNCTION public.refuse_archiving_the_last_shadow_gateway() FROM PUBLIC;
GRANT ALL ON FUNCTION public.refuse_archiving_the_last_shadow_gateway() TO service_role;

--

-- FUNCTION refuse_hand_assigning_a_replay_lane() :: ACL
REVOKE ALL ON FUNCTION public.refuse_hand_assigning_a_replay_lane() FROM PUBLIC;
GRANT ALL ON FUNCTION public.refuse_hand_assigning_a_replay_lane() TO service_role;

--

-- FUNCTION refuse_role_for_machine_principal() :: ACL
REVOKE ALL ON FUNCTION public.refuse_role_for_machine_principal() FROM PUBLIC;
GRANT ALL ON FUNCTION public.refuse_role_for_machine_principal() TO service_role;

--

-- FUNCTION register_uploaded_capture(p_subject_kind text, p_subject_id uuid, p_storage_path text, p_size_bytes bigint, p_message_count integer, p_manifest jsonb, p_note text, p_replace boolean) :: ACL
REVOKE ALL ON FUNCTION public.register_uploaded_capture(p_subject_kind text, p_subject_id uuid, p_storage_path text, p_size_bytes bigint, p_message_count integer, p_manifest jsonb, p_note text, p_replace boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.register_uploaded_capture(p_subject_kind text, p_subject_id uuid, p_storage_path text, p_size_bytes bigint, p_message_count integer, p_manifest jsonb, p_note text, p_replace boolean) TO service_role;
GRANT ALL ON FUNCTION public.register_uploaded_capture(p_subject_kind text, p_subject_id uuid, p_storage_path text, p_size_bytes bigint, p_message_count integer, p_manifest jsonb, p_note text, p_replace boolean) TO authenticated;

--

-- FUNCTION reinstate_service_principal(p_principal_id uuid) :: ACL
REVOKE ALL ON FUNCTION public.reinstate_service_principal(p_principal_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reinstate_service_principal(p_principal_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.reinstate_service_principal(p_principal_id uuid) TO authenticated;

--

-- FUNCTION reject_archived_schema_assignment() :: ACL
REVOKE ALL ON FUNCTION public.reject_archived_schema_assignment() FROM PUBLIC;
GRANT ALL ON FUNCTION public.reject_archived_schema_assignment() TO service_role;

--

-- FUNCTION reject_proposal(p_proposal_id uuid, p_reason text) :: ACL
REVOKE ALL ON FUNCTION public.reject_proposal(p_proposal_id uuid, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reject_proposal(p_proposal_id uuid, p_reason text) TO service_role;
GRANT ALL ON FUNCTION public.reject_proposal(p_proposal_id uuid, p_reason text) TO authenticated;

--

-- FUNCTION release_backup(p_backup_id uuid) :: ACL
REVOKE ALL ON FUNCTION public.release_backup(p_backup_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.release_backup(p_backup_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.release_backup(p_backup_id uuid) TO authenticated;

--

-- FUNCTION release_forge_sweep(p_holder uuid) :: ACL
REVOKE ALL ON FUNCTION public.release_forge_sweep(p_holder uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.release_forge_sweep(p_holder uuid) TO service_role;

--

-- FUNCTION release_gateway_enrollment_token(p_token text) :: ACL
REVOKE ALL ON FUNCTION public.release_gateway_enrollment_token(p_token text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.release_gateway_enrollment_token(p_token text) TO service_role;

--

-- FUNCTION relocate_devices(p_moves jsonb) :: ACL
REVOKE ALL ON FUNCTION public.relocate_devices(p_moves jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.relocate_devices(p_moves jsonb) TO service_role;
GRANT ALL ON FUNCTION public.relocate_devices(p_moves jsonb) TO authenticated;

--

-- FUNCTION renew_forge_sweep(p_holder uuid, p_seconds integer) :: ACL
REVOKE ALL ON FUNCTION public.renew_forge_sweep(p_holder uuid, p_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.renew_forge_sweep(p_holder uuid, p_seconds integer) TO service_role;

--

-- FUNCTION request_backup(p_note text) :: ACL
REVOKE ALL ON FUNCTION public.request_backup(p_note text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.request_backup(p_note text) TO service_role;
GRANT ALL ON FUNCTION public.request_backup(p_note text) TO authenticated;

--

-- FUNCTION request_capture_stop(p_job_id uuid) :: ACL
REVOKE ALL ON FUNCTION public.request_capture_stop(p_job_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.request_capture_stop(p_job_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.request_capture_stop(p_job_id uuid) TO authenticated;

--

-- FUNCTION request_gateway_rebirth(p_gateway_id uuid) :: ACL
REVOKE ALL ON FUNCTION public.request_gateway_rebirth(p_gateway_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.request_gateway_rebirth(p_gateway_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.request_gateway_rebirth(p_gateway_id uuid) TO authenticated;

--

-- FUNCTION request_playback_stop(p_job_id uuid) :: ACL
REVOKE ALL ON FUNCTION public.request_playback_stop(p_job_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.request_playback_stop(p_job_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.request_playback_stop(p_job_id uuid) TO authenticated;

--

-- FUNCTION require_backup_service_caller(p_fn text) :: ACL
REVOKE ALL ON FUNCTION public.require_backup_service_caller(p_fn text) FROM PUBLIC;

--

-- FUNCTION require_ingestion_caller(p_fn text) :: ACL
REVOKE ALL ON FUNCTION public.require_ingestion_caller(p_fn text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.require_ingestion_caller(p_fn text) TO service_role;
GRANT ALL ON FUNCTION public.require_ingestion_caller(p_fn text) TO authenticated;

--

-- FUNCTION require_playback_caller(p_fn text) :: ACL
REVOKE ALL ON FUNCTION public.require_playback_caller(p_fn text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.require_playback_caller(p_fn text) TO service_role;
GRANT ALL ON FUNCTION public.require_playback_caller(p_fn text) TO authenticated;

--

-- FUNCTION revoke_anon_function_privileges() :: ACL
REVOKE ALL ON FUNCTION public.revoke_anon_function_privileges() FROM PUBLIC;

--

-- FUNCTION revoke_credential_on_decommission() :: ACL
REVOKE ALL ON FUNCTION public.revoke_credential_on_decommission() FROM PUBLIC;
GRANT ALL ON FUNCTION public.revoke_credential_on_decommission() TO service_role;

--

-- FUNCTION revoke_gateway_credential(p_sparkplug_id text) :: ACL
REVOKE ALL ON FUNCTION public.revoke_gateway_credential(p_sparkplug_id text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.revoke_gateway_credential(p_sparkplug_id text) TO service_role;

--

-- FUNCTION revoke_service_principal(p_principal_id uuid, p_reason text) :: ACL
REVOKE ALL ON FUNCTION public.revoke_service_principal(p_principal_id uuid, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.revoke_service_principal(p_principal_id uuid, p_reason text) TO service_role;
GRANT ALL ON FUNCTION public.revoke_service_principal(p_principal_id uuid, p_reason text) TO authenticated;

--

-- FUNCTION revoke_service_token(p_jti text) :: ACL
REVOKE ALL ON FUNCTION public.revoke_service_token(p_jti text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.revoke_service_token(p_jti text) TO service_role;
GRANT ALL ON FUNCTION public.revoke_service_token(p_jti text) TO authenticated;

--

-- FUNCTION schema_version_base_name(schema_name text) :: ACL
REVOKE ALL ON FUNCTION public.schema_version_base_name(schema_name text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.schema_version_base_name(schema_name text) TO service_role;
GRANT ALL ON FUNCTION public.schema_version_base_name(schema_name text) TO authenticated;

--

-- FUNCTION secure_audit_trail_partition(p_partition regclass) :: ACL
REVOKE ALL ON FUNCTION public.secure_audit_trail_partition(p_partition regclass) FROM PUBLIC;
GRANT ALL ON FUNCTION public.secure_audit_trail_partition(p_partition regclass) TO service_role;

--

-- FUNCTION seed_setting(p_key text, p_value jsonb, p_value_type text, p_category text, p_label text, p_description text, p_fallback_source text) :: ACL
REVOKE ALL ON FUNCTION public.seed_setting(p_key text, p_value jsonb, p_value_type text, p_category text, p_label text, p_description text, p_fallback_source text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.seed_setting(p_key text, p_value jsonb, p_value_type text, p_category text, p_label text, p_description text, p_fallback_source text) TO service_role;

--

-- FUNCTION service_token_max_days() :: ACL
REVOKE ALL ON FUNCTION public.service_token_max_days() FROM PUBLIC;
GRANT ALL ON FUNCTION public.service_token_max_days() TO service_role;
GRANT ALL ON FUNCTION public.service_token_max_days() TO authenticated;

--

-- FUNCTION set_archive_credential(p_secret text) :: ACL
REVOKE ALL ON FUNCTION public.set_archive_credential(p_secret text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_archive_credential(p_secret text) TO service_role;
GRANT ALL ON FUNCTION public.set_archive_credential(p_secret text) TO authenticated;

--

-- FUNCTION set_backup_offsite_credential(p_secret text) :: ACL
REVOKE ALL ON FUNCTION public.set_backup_offsite_credential(p_secret text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_backup_offsite_credential(p_secret text) TO service_role;
GRANT ALL ON FUNCTION public.set_backup_offsite_credential(p_secret text) TO authenticated;

--

-- FUNCTION set_backup_offsite_destination(p_endpoint text, p_region text, p_bucket text, p_prefix text, p_access_key_id text, p_recipient text, p_path_style boolean) :: ACL
REVOKE ALL ON FUNCTION public.set_backup_offsite_destination(p_endpoint text, p_region text, p_bucket text, p_prefix text, p_access_key_id text, p_recipient text, p_path_style boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_backup_offsite_destination(p_endpoint text, p_region text, p_bucket text, p_prefix text, p_access_key_id text, p_recipient text, p_path_style boolean) TO service_role;
GRANT ALL ON FUNCTION public.set_backup_offsite_destination(p_endpoint text, p_region text, p_bucket text, p_prefix text, p_access_key_id text, p_recipient text, p_path_style boolean) TO authenticated;

--

-- FUNCTION shadow_follows_its_original() :: ACL
REVOKE ALL ON FUNCTION public.shadow_follows_its_original() FROM PUBLIC;
GRANT ALL ON FUNCTION public.shadow_follows_its_original() TO service_role;

--

-- FUNCTION stamp_audit_domain() :: ACL
REVOKE ALL ON FUNCTION public.stamp_audit_domain() FROM PUBLIC;
GRANT ALL ON FUNCTION public.stamp_audit_domain() TO service_role;

--

-- FUNCTION stamp_proposal_author() :: ACL
REVOKE ALL ON FUNCTION public.stamp_proposal_author() FROM PUBLIC;
GRANT ALL ON FUNCTION public.stamp_proposal_author() TO service_role;

--

-- FUNCTION start_capture_job(p_subject_kind text, p_subject_id uuid, p_note text, p_max_seconds integer, p_replace boolean) :: ACL
REVOKE ALL ON FUNCTION public.start_capture_job(p_subject_kind text, p_subject_id uuid, p_note text, p_max_seconds integer, p_replace boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.start_capture_job(p_subject_kind text, p_subject_id uuid, p_note text, p_max_seconds integer, p_replace boolean) TO service_role;
GRANT ALL ON FUNCTION public.start_capture_job(p_subject_kind text, p_subject_id uuid, p_note text, p_max_seconds integer, p_replace boolean) TO authenticated;

--

-- FUNCTION start_playback_job(p_capture_id uuid, p_target_gateway_id uuid, p_device_map jsonb, p_speed numeric) :: ACL
REVOKE ALL ON FUNCTION public.start_playback_job(p_capture_id uuid, p_target_gateway_id uuid, p_device_map jsonb, p_speed numeric) FROM PUBLIC;
GRANT ALL ON FUNCTION public.start_playback_job(p_capture_id uuid, p_target_gateway_id uuid, p_device_map jsonb, p_speed numeric) TO service_role;
GRANT ALL ON FUNCTION public.start_playback_job(p_capture_id uuid, p_target_gateway_id uuid, p_device_map jsonb, p_speed numeric) TO authenticated;

--

-- FUNCTION sweep_forge() :: ACL
REVOKE ALL ON FUNCTION public.sweep_forge() FROM PUBLIC;
GRANT ALL ON FUNCTION public.sweep_forge() TO service_role;

--

-- FUNCTION sweep_forge_on_archive_change() :: ACL
REVOKE ALL ON FUNCTION public.sweep_forge_on_archive_change() FROM PUBLIC;
GRANT ALL ON FUNCTION public.sweep_forge_on_archive_change() TO service_role;

--

-- FUNCTION sweep_gateway_credential_revocations() :: ACL
REVOKE ALL ON FUNCTION public.sweep_gateway_credential_revocations() FROM PUBLIC;
GRANT ALL ON FUNCTION public.sweep_gateway_credential_revocations() TO service_role;

--

-- FUNCTION system_settings_read_only_guard() :: ACL
REVOKE ALL ON FUNCTION public.system_settings_read_only_guard() FROM PUBLIC;
GRANT ALL ON FUNCTION public.system_settings_read_only_guard() TO service_role;

--

-- FUNCTION system_settings_stamp() :: ACL
REVOKE ALL ON FUNCTION public.system_settings_stamp() FROM PUBLIC;
GRANT ALL ON FUNCTION public.system_settings_stamp() TO service_role;

--

-- FUNCTION validate_change_proposal() :: ACL
REVOKE ALL ON FUNCTION public.validate_change_proposal() FROM PUBLIC;
GRANT ALL ON FUNCTION public.validate_change_proposal() TO service_role;

--

-- FUNCTION withdraw_gateway_enrollment_tokens() :: ACL
REVOKE ALL ON FUNCTION public.withdraw_gateway_enrollment_tokens() FROM PUBLIC;
GRANT ALL ON FUNCTION public.withdraw_gateway_enrollment_tokens() TO service_role;

--

-- FUNCTION withdraw_proposal(p_proposal_id uuid) :: ACL
REVOKE ALL ON FUNCTION public.withdraw_proposal(p_proposal_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.withdraw_proposal(p_proposal_id uuid) TO service_role;
GRANT ALL ON FUNCTION public.withdraw_proposal(p_proposal_id uuid) TO authenticated;

--

-- TABLE areas :: ACL
GRANT ALL ON TABLE public.areas TO service_role;
GRANT ALL ON TABLE public.areas TO authenticated;

--

-- TABLE ashrae223_vocabulary :: ACL
GRANT ALL ON TABLE public.ashrae223_vocabulary TO service_role;
GRANT SELECT ON TABLE public.ashrae223_vocabulary TO authenticated;

--

-- TABLE asset_config :: ACL
GRANT ALL ON TABLE public.asset_config TO service_role;
GRANT ALL ON TABLE public.asset_config TO authenticated;

--

-- TABLE asset_exports :: ACL
GRANT ALL ON TABLE public.asset_exports TO service_role;
GRANT SELECT ON TABLE public.asset_exports TO authenticated;

--

-- TABLE audit_trail :: ACL
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE public.audit_trail TO service_role;
GRANT SELECT ON TABLE public.audit_trail TO authenticated;

--

-- TABLE audit_trail_partition_health :: ACL
GRANT ALL ON TABLE public.audit_trail_partition_health TO service_role;
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
    EXECUTE 'GRANT SELECT ON TABLE public.audit_trail_partition_health TO grafana_reader';
  END IF;
END $g$;

--

-- TABLE backup_jobs :: ACL
GRANT ALL ON TABLE public.backup_jobs TO service_role;
GRANT SELECT ON TABLE public.backup_jobs TO authenticated;

--

-- TABLE backup_health :: ACL
GRANT ALL ON TABLE public.backup_health TO service_role;
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
    EXECUTE 'GRANT SELECT ON TABLE public.backup_health TO grafana_reader';
  END IF;
END $g$;

--

-- TABLE backup_offsite_health :: ACL
GRANT ALL ON TABLE public.backup_offsite_health TO service_role;
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
    EXECUTE 'GRANT SELECT ON TABLE public.backup_offsite_health TO grafana_reader';
  END IF;
END $g$;

--

-- TABLE backups :: ACL
GRANT ALL ON TABLE public.backups TO service_role;
GRANT SELECT ON TABLE public.backups TO authenticated;

--

-- TABLE capture_jobs :: ACL
GRANT ALL ON TABLE public.capture_jobs TO service_role;
GRANT SELECT ON TABLE public.capture_jobs TO authenticated;

--

-- TABLE captures :: ACL
GRANT ALL ON TABLE public.captures TO service_role;
GRANT SELECT,DELETE ON TABLE public.captures TO authenticated;

--

-- TABLE cells :: ACL
GRANT ALL ON TABLE public.cells TO service_role;
GRANT ALL ON TABLE public.cells TO authenticated;

--

-- TABLE change_proposals :: ACL
GRANT ALL ON TABLE public.change_proposals TO service_role;
GRANT SELECT,INSERT,UPDATE ON TABLE public.change_proposals TO authenticated;

--

-- TABLE devices :: ACL
GRANT ALL ON TABLE public.devices TO service_role;
GRANT ALL ON TABLE public.devices TO authenticated;

--

-- TABLE device_locations :: ACL
GRANT ALL ON TABLE public.device_locations TO service_role;
GRANT SELECT ON TABLE public.device_locations TO authenticated;

--

-- TABLE device_nameplate :: ACL
GRANT ALL ON TABLE public.device_nameplate TO service_role;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE public.device_nameplate TO authenticated;

--

-- TABLE device_submodels :: ACL
GRANT ALL ON TABLE public.device_submodels TO service_role;
GRANT ALL ON TABLE public.device_submodels TO authenticated;

--

-- TABLE device_schemas :: ACL
GRANT ALL ON TABLE public.device_schemas TO service_role;
GRANT ALL ON TABLE public.device_schemas TO authenticated;

--

-- TABLE directory_liveness_probe :: ACL
GRANT ALL ON TABLE public.directory_liveness_probe TO service_role;

--

-- TABLE directory_services :: ACL
GRANT ALL ON TABLE public.directory_services TO service_role;
GRANT ALL ON TABLE public.directory_services TO authenticated;

--

-- TABLE forge_sweep_lease :: ACL
GRANT SELECT ON TABLE public.forge_sweep_lease TO service_role;

--

-- TABLE gateway_enrollment_tokens :: ACL
GRANT ALL ON TABLE public.gateway_enrollment_tokens TO service_role;

--

-- TABLE gateway_health :: ACL
GRANT ALL ON TABLE public.gateway_health TO service_role;
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
    EXECUTE 'GRANT SELECT ON TABLE public.gateway_health TO grafana_reader';
  END IF;
END $g$;

--

-- TABLE gateway_revocation_requests :: ACL
GRANT SELECT ON TABLE public.gateway_revocation_requests TO service_role;

--

-- TABLE gateway_status :: ACL
GRANT ALL ON TABLE public.gateway_status TO service_role;
GRANT SELECT ON TABLE public.gateway_status TO authenticated;

--

-- TABLE idta_submodel_templates :: ACL
GRANT ALL ON TABLE public.idta_submodel_templates TO service_role;
GRANT SELECT ON TABLE public.idta_submodel_templates TO authenticated;

--

-- TABLE iso22400_vocabulary :: ACL
GRANT ALL ON TABLE public.iso22400_vocabulary TO service_role;
GRANT SELECT ON TABLE public.iso22400_vocabulary TO authenticated;

--

-- TABLE links :: ACL
GRANT ALL ON TABLE public.links TO service_role;
GRANT ALL ON TABLE public.links TO authenticated;

--

-- TABLE machine_principals :: ACL
GRANT ALL ON TABLE public.machine_principals TO service_role;
GRANT SELECT ON TABLE public.machine_principals TO authenticated;

--

-- TABLE metric_catalog :: ACL
GRANT ALL ON TABLE public.metric_catalog TO service_role;
GRANT ALL ON TABLE public.metric_catalog TO authenticated;

--

-- TABLE metric_groups :: ACL
GRANT ALL ON TABLE public.metric_groups TO service_role;
GRANT ALL ON TABLE public.metric_groups TO authenticated;

--

-- TABLE mtconnect_vocabulary :: ACL
GRANT ALL ON TABLE public.mtconnect_vocabulary TO service_role;
GRANT SELECT ON TABLE public.mtconnect_vocabulary TO authenticated;

--

-- TABLE one_shot_migrations :: ACL
GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE public.one_shot_migrations TO service_role;

--

-- TABLE opcua_vocabulary :: ACL
GRANT ALL ON TABLE public.opcua_vocabulary TO service_role;
GRANT SELECT ON TABLE public.opcua_vocabulary TO authenticated;

--

-- TABLE permissions :: ACL
GRANT ALL ON TABLE public.permissions TO service_role;
GRANT ALL ON TABLE public.permissions TO authenticated;

--

-- TABLE platform_alerts :: ACL
GRANT ALL ON TABLE public.platform_alerts TO service_role;
GRANT SELECT ON TABLE public.platform_alerts TO authenticated;

--

-- TABLE platform_alerts_active :: ACL
GRANT ALL ON TABLE public.platform_alerts_active TO service_role;
GRANT SELECT ON TABLE public.platform_alerts_active TO authenticated;

--

-- TABLE platform_health :: ACL
GRANT ALL ON TABLE public.platform_health TO service_role;
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
    EXECUTE 'GRANT SELECT ON TABLE public.platform_health TO grafana_reader';
  END IF;
END $g$;

--

-- TABLE playback_jobs :: ACL
GRANT ALL ON TABLE public.playback_jobs TO service_role;
GRANT SELECT ON TABLE public.playback_jobs TO authenticated;

--

-- TABLE playback_worker_status :: ACL
GRANT ALL ON TABLE public.playback_worker_status TO service_role;
GRANT SELECT ON TABLE public.playback_worker_status TO authenticated;

--

-- TABLE principal_permissions :: ACL
GRANT ALL ON TABLE public.principal_permissions TO service_role;
GRANT SELECT ON TABLE public.principal_permissions TO authenticated;

--

-- TABLE rebirth_requests :: ACL
GRANT ALL ON TABLE public.rebirth_requests TO service_role;
GRANT SELECT ON TABLE public.rebirth_requests TO authenticated;

--

-- TABLE retired_entities :: ACL
GRANT ALL ON TABLE public.retired_entities TO service_role;
GRANT SELECT ON TABLE public.retired_entities TO authenticated;

--

-- TABLE revoked_service_principals :: ACL
GRANT ALL ON TABLE public.revoked_service_principals TO service_role;
GRANT SELECT ON TABLE public.revoked_service_principals TO authenticated;

--

-- TABLE revoked_service_tokens :: ACL
GRANT ALL ON TABLE public.revoked_service_tokens TO service_role;
GRANT SELECT ON TABLE public.revoked_service_tokens TO authenticated;

--

-- TABLE role_permissions :: ACL
GRANT ALL ON TABLE public.role_permissions TO service_role;
GRANT ALL ON TABLE public.role_permissions TO authenticated;

--

-- TABLE roles :: ACL
GRANT ALL ON TABLE public.roles TO service_role;
GRANT ALL ON TABLE public.roles TO authenticated;

--

-- SEQUENCE roles_id_seq :: ACL
GRANT ALL ON SEQUENCE public.roles_id_seq TO service_role;
GRANT ALL ON SEQUENCE public.roles_id_seq TO anon;
GRANT ALL ON SEQUENCE public.roles_id_seq TO authenticated;

--

-- TABLE schema_bootstrap :: ACL
GRANT ALL ON TABLE public.schema_bootstrap TO service_role;

--

-- TABLE schemas :: ACL
GRANT ALL ON TABLE public.schemas TO service_role;
GRANT ALL ON TABLE public.schemas TO authenticated;

--

-- TABLE storage_footprint :: ACL
GRANT ALL ON TABLE public.storage_footprint TO service_role;
DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
    EXECUTE 'GRANT SELECT ON TABLE public.storage_footprint TO grafana_reader';
  END IF;
END $g$;

--

-- TABLE system_settings :: ACL
GRANT ALL ON TABLE public.system_settings TO service_role;
GRANT SELECT ON TABLE public.system_settings TO authenticated;

--

-- COLUMN system_settings.value :: ACL
GRANT UPDATE(value) ON TABLE public.system_settings TO authenticated;

--

-- TABLE telemetry :: ACL
GRANT SELECT ON TABLE timescale.telemetry TO authenticated;
GRANT SELECT ON TABLE timescale.telemetry TO service_role;

--

-- TABLE telemetry :: ACL
GRANT ALL ON TABLE public.telemetry TO service_role;
GRANT ALL ON TABLE public.telemetry TO authenticated;

--

-- TABLE telemetry_1h :: ACL
GRANT SELECT ON TABLE timescale.telemetry_1h TO authenticated;
GRANT SELECT ON TABLE timescale.telemetry_1h TO service_role;

--

-- TABLE telemetry_1h :: ACL
GRANT ALL ON TABLE public.telemetry_1h TO service_role;
GRANT SELECT ON TABLE public.telemetry_1h TO authenticated;

--

-- TABLE telemetry_1m :: ACL
GRANT SELECT ON TABLE timescale.telemetry_1m TO authenticated;
GRANT SELECT ON TABLE timescale.telemetry_1m TO service_role;

--

-- TABLE telemetry_1m :: ACL
GRANT ALL ON TABLE public.telemetry_1m TO service_role;
GRANT SELECT ON TABLE public.telemetry_1m TO authenticated;

--

-- TABLE telemetry_5m :: ACL
GRANT SELECT ON TABLE timescale.telemetry_5m TO authenticated;
GRANT SELECT ON TABLE timescale.telemetry_5m TO service_role;

--

-- TABLE telemetry_5m :: ACL
GRANT ALL ON TABLE public.telemetry_5m TO service_role;
GRANT SELECT ON TABLE public.telemetry_5m TO authenticated;

--

-- TABLE telemetry_horizons :: ACL
GRANT SELECT ON TABLE timescale.telemetry_horizons TO authenticated;
GRANT SELECT ON TABLE timescale.telemetry_horizons TO service_role;

--

-- TABLE telemetry_horizons :: ACL
GRANT ALL ON TABLE public.telemetry_horizons TO service_role;
GRANT SELECT ON TABLE public.telemetry_horizons TO authenticated;

--

-- TABLE telemetry_latest :: ACL
GRANT SELECT ON TABLE timescale.telemetry_latest TO authenticated;
GRANT SELECT ON TABLE timescale.telemetry_latest TO service_role;

--

-- TABLE telemetry_latest :: ACL
GRANT ALL ON TABLE public.telemetry_latest TO service_role;
GRANT SELECT ON TABLE public.telemetry_latest TO authenticated;

--

-- TABLE user_roles :: ACL
GRANT ALL ON TABLE public.user_roles TO service_role;
GRANT ALL ON TABLE public.user_roles TO authenticated;

--

-- TABLE webhook_endpoints :: ACL
GRANT ALL ON TABLE public.webhook_endpoints TO service_role;
GRANT ALL ON TABLE public.webhook_endpoints TO authenticated;

--

-- stale overloads :: SWEEP
DO $overloads$
DECLARE
    r record;
BEGIN
    -- SAME search_path pg_dump WROTE THE LIST UNDER, which is none. `format_type` qualifies
    -- a type only when it is not visible, so with `public` on the path a composite argument
    -- renders as `gateways` where the dump says `public.gateways` -- and every function
    -- taking one fails to match its own entry and is dropped. Reverts with the block.
    SET LOCAL search_path TO '';

    FOR r IN
        SELECT p.oid::regprocedure AS sig,
               p.proname || '(' || coalesce((SELECT string_agg(format_type(t, NULL), ', ' ORDER BY ord)
                                               FROM unnest(p.proargtypes) WITH ORDINALITY AS a(t, ord)), '')
                          || ')' AS ident
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = ANY (ARRAY[
               'active_schema_version',
               'approve_proposal',
               'approve_quarantined_device',
               'archive_credential_is_set',
               'archive_destination_guard',
               'assert_principal_not_revoked',
               'audit_domain_for',
               'audit_telemetry_columns',
               'audit_trail_backup_job_ids_matching',
               'audit_trail_page',
               'audit_trail_user_ids_matching',
               'auth_pre_request',
               'authorize_host_gateway_credential',
               'backup_claim_job',
               'backup_fail',
               'backup_finalise',
               'backup_forget',
               'backup_offsite_base',
               'backup_offsite_credential_is_set',
               'backup_offsite_destination',
               'backup_offsite_health_rows',
               'backup_offsite_next',
               'backup_offsite_record',
               'backup_offsite_setting_guard',
               'backup_prunable',
               'backup_reconcile_jobs',
               'backup_schedule',
               'cancel_backup_job',
               'capped_capture_manifest',
               'claim_forge_sweep',
               'clear_backup_offsite_destination',
               'clear_credential_revoked_on_enrolment',
               'cold_archive_backlog',
               'cold_archive_backlog_state',
               'cold_archive_destination',
               'cold_storage_rows',
               'consume_gateway_enrollment_token',
               'create_machine_principal',
               'custom_access_token_hook',
               'delete_device_asset_config',
               'describe_machine_principal',
               'directory_liveness_job_map',
               'discard_schema_draft',
               'dispatch_device_quarantine_webhook',
               'enforce_audit_trail_append_only',
               'enforce_metric_catalog_immutability',
               'enforce_metric_group_spelling',
               'enforce_open_proposal_cap',
               'enforce_schema_version_provenance',
               'enqueue_scheduled_backup',
               'ensure_audit_trail_partition',
               'ensure_audit_trail_partitions',
               'ensure_cron_job',
               'ensure_gateway_status_view',
               'ensure_shadow_devices',
               'expire_open_proposals',
               'fork_schema',
               'gateway_has_broker_credential',
               'gateway_health_rows',
               'gateway_holds_a_credential',
               'gateway_is_playback_delivery_target',
               'guard_change_proposal_transition',
               'handle_new_user',
               'has_authority',
               'has_role',
               'historian_backup_state',
               'i3x_auth_probe',
               'ingest_capture_progress',
               'ingest_claim_capture_job',
               'ingest_claim_rebirth_requests',
               'ingest_fail_capture',
               'ingest_finalise_capture',
               'ingest_mark_device_offline',
               'ingest_mark_gateway_devices_offline',
               'ingest_reconcile_capture_jobs',
               'ingest_record_declared_metrics',
               'ingest_record_gateway_health',
               'ingest_record_rebirth_outcome',
               'ingest_register_quarantined_device',
               'ingest_requarantine_device',
               'ingest_set_device_state',
               'ingest_store_birth_parameters',
               'is_active_capture_object',
               'is_active_playback_capture',
               'is_area_plan_path',
               'is_capture_subject_prefix',
               'is_ingestion_caller',
               'is_machine_principal',
               'is_playback_caller',
               'is_valid_quarantine_reason',
               'issue_gateway_enrollment_token',
               'list_machine_principals',
               'list_proposer_names',
               'list_user_accounts',
               'log_asset_export',
               'log_audit_trail_event',
               'log_role_assignment',
               'may_decide_proposal',
               'may_manage_captures',
               'peek_gateway_enrollment_token',
               'place_cell_in_its_area',
               'plan_distance',
               'platform_health_rows',
               'platform_storage_rows',
               'playback_claim_job',
               'playback_finish',
               'playback_progress',
               'playback_reconcile_jobs',
               'playback_report_credentials',
               'playback_stale_credentials',
               'playback_target_must_be_shadow',
               'prevent_active_schema_mutation',
               'proposable_columns',
               'proposal_is_already_true',
               'prune_closed_proposals',
               'prune_platform_alerts',
               'publish_schema_version',
               'raw_telemetry_window',
               'record_directory_images',
               'record_gateway_credential_issued',
               'record_gateway_credential_issued_by_service',
               'record_ingestion_rejection',
               'record_retired_entity',
               'record_service_token_issued',
               'refresh_directory_liveness',
               'refuse_archiving_the_last_shadow_gateway',
               'refuse_hand_assigning_a_replay_lane',
               'refuse_role_for_machine_principal',
               'register_uploaded_capture',
               'reinstate_service_principal',
               'reject_archived_schema_assignment',
               'reject_proposal',
               'release_backup',
               'release_forge_sweep',
               'release_gateway_enrollment_token',
               'relocate_devices',
               'renew_forge_sweep',
               'request_backup',
               'request_capture_stop',
               'request_gateway_rebirth',
               'request_playback_stop',
               'require_backup_service_caller',
               'require_ingestion_caller',
               'require_playback_caller',
               'revoke_anon_function_privileges',
               'revoke_credential_on_decommission',
               'revoke_gateway_credential',
               'revoke_service_principal',
               'revoke_service_token',
               'schema_version_base_name',
               'secure_audit_trail_partition',
               'seed_setting',
               'service_token_max_days',
               'set_archive_credential',
               'set_backup_offsite_credential',
               'set_backup_offsite_destination',
               'shadow_follows_its_original',
               'sparkplug_group_default',
               'stamp_audit_domain',
               'stamp_proposal_author',
               'start_capture_job',
               'start_playback_job',
               'sweep_forge',
               'sweep_forge_on_archive_change',
               'sweep_gateway_credential_revocations',
               'system_settings_read_only_guard',
               'system_settings_stamp',
               'validate_change_proposal',
               'withdraw_gateway_enrollment_tokens',
               'withdraw_proposal'
           ])
    LOOP
        IF r.ident <> ALL (ARRAY[
            'active_schema_version(uuid)',
            'approve_proposal(uuid)',
            'approve_quarantined_device(uuid, uuid, uuid, uuid, text, uuid, text, boolean, boolean, uuid, boolean)',
            'archive_credential_is_set()',
            'archive_destination_guard()',
            'assert_principal_not_revoked(uuid)',
            'audit_domain_for(text, text)',
            'audit_telemetry_columns()',
            'audit_trail_backup_job_ids_matching(text)',
            'audit_trail_page(integer, boolean, text, text, uuid[], timestamp with time zone, timestamp with time zone, timestamp with time zone, bigint, text)',
            'audit_trail_user_ids_matching(text)',
            'auth_pre_request()',
            'authorize_host_gateway_credential(uuid)',
            'backup_claim_job()',
            'backup_fail(uuid, text)',
            'backup_finalise(uuid, text, text, jsonb, bigint)',
            'backup_forget(uuid, text)',
            'backup_offsite_base()',
            'backup_offsite_credential_is_set()',
            'backup_offsite_destination()',
            'backup_offsite_health_rows()',
            'backup_offsite_next()',
            'backup_offsite_record(uuid, text, jsonb, text)',
            'backup_offsite_setting_guard()',
            'backup_prunable(integer)',
            'backup_reconcile_jobs(text)',
            'backup_schedule(text)',
            'cancel_backup_job(uuid)',
            'capped_capture_manifest(jsonb)',
            'claim_forge_sweep(integer)',
            'clear_backup_offsite_destination()',
            'clear_credential_revoked_on_enrolment()',
            'cold_archive_backlog()',
            'cold_archive_backlog_state()',
            'cold_archive_destination()',
            'cold_storage_rows()',
            'consume_gateway_enrollment_token(text)',
            'create_machine_principal(text, text[], text)',
            'custom_access_token_hook(jsonb)',
            'delete_device_asset_config()',
            'describe_machine_principal(uuid, text, text)',
            'directory_liveness_job_map()',
            'discard_schema_draft(uuid)',
            'dispatch_device_quarantine_webhook()',
            'enforce_audit_trail_append_only()',
            'enforce_metric_catalog_immutability()',
            'enforce_metric_group_spelling()',
            'enforce_open_proposal_cap()',
            'enforce_schema_version_provenance()',
            'enqueue_scheduled_backup()',
            'ensure_audit_trail_partition(timestamp with time zone)',
            'ensure_audit_trail_partitions(integer)',
            'ensure_cron_job(text, text, text)',
            'ensure_gateway_status_view()',
            'ensure_shadow_devices(uuid)',
            'expire_open_proposals()',
            'fork_schema(uuid, text)',
            'gateway_has_broker_credential(public.gateways)',
            'gateway_health_rows()',
            'gateway_holds_a_credential(public.gateways)',
            'gateway_is_playback_delivery_target(uuid)',
            'guard_change_proposal_transition()',
            'handle_new_user()',
            'has_authority(text[])',
            'has_role(text[])',
            'historian_backup_state()',
            'i3x_auth_probe()',
            'ingest_capture_progress(uuid, bigint, bigint, integer, boolean)',
            'ingest_claim_capture_job()',
            'ingest_claim_rebirth_requests()',
            'ingest_fail_capture(uuid, text)',
            'ingest_finalise_capture(uuid, bigint, integer, jsonb)',
            'ingest_mark_device_offline(uuid)',
            'ingest_mark_gateway_devices_offline(uuid)',
            'ingest_reconcile_capture_jobs()',
            'ingest_record_declared_metrics(uuid, text[], timestamp with time zone)',
            'ingest_record_gateway_health(uuid, text, timestamp with time zone, jsonb)',
            'ingest_record_rebirth_outcome(uuid, boolean, text)',
            'ingest_register_quarantined_device(text, uuid, text, text, text, text[], timestamp with time zone)',
            'ingest_requarantine_device(uuid, text, text)',
            'ingest_set_device_state(uuid, text, text, timestamp with time zone)',
            'ingest_store_birth_parameters(text, jsonb, timestamp with time zone)',
            'is_active_capture_object(text)',
            'is_active_playback_capture(text)',
            'is_area_plan_path(text)',
            'is_capture_subject_prefix(text)',
            'is_ingestion_caller()',
            'is_machine_principal(uuid)',
            'is_playback_caller()',
            'is_valid_quarantine_reason(text)',
            'issue_gateway_enrollment_token(uuid, integer)',
            'list_machine_principals()',
            'list_proposer_names()',
            'list_user_accounts()',
            'log_asset_export()',
            'log_audit_trail_event()',
            'log_role_assignment()',
            'may_decide_proposal(text)',
            'may_manage_captures()',
            'peek_gateway_enrollment_token(text)',
            'place_cell_in_its_area()',
            'plan_distance(numeric, numeric, numeric, numeric, numeric)',
            'platform_health_rows()',
            'platform_storage_rows()',
            'playback_claim_job()',
            'playback_finish(uuid, integer, text, integer)',
            'playback_progress(uuid, integer, integer, integer)',
            'playback_reconcile_jobs()',
            'playback_report_credentials(text[], text[])',
            'playback_stale_credentials()',
            'playback_target_must_be_shadow()',
            'prevent_active_schema_mutation()',
            'proposable_columns(text)',
            'proposal_is_already_true(uuid)',
            'prune_closed_proposals()',
            'prune_platform_alerts(interval)',
            'publish_schema_version(uuid)',
            'raw_telemetry_window()',
            'record_directory_images(jsonb)',
            'record_gateway_credential_issued(uuid)',
            'record_gateway_credential_issued_by_service(uuid, jsonb)',
            'record_ingestion_rejection(uuid, jsonb, timestamp with time zone)',
            'record_retired_entity()',
            'record_service_token_issued(uuid, text, timestamp with time zone, jsonb, uuid)',
            'refresh_directory_liveness()',
            'refuse_archiving_the_last_shadow_gateway()',
            'refuse_hand_assigning_a_replay_lane()',
            'refuse_role_for_machine_principal()',
            'register_uploaded_capture(text, uuid, text, bigint, integer, jsonb, text, boolean)',
            'reinstate_service_principal(uuid)',
            'reject_archived_schema_assignment()',
            'reject_proposal(uuid, text)',
            'release_backup(uuid)',
            'release_forge_sweep(uuid)',
            'release_gateway_enrollment_token(text)',
            'relocate_devices(jsonb)',
            'renew_forge_sweep(uuid, integer)',
            'request_backup(text)',
            'request_capture_stop(uuid)',
            'request_gateway_rebirth(uuid)',
            'request_playback_stop(uuid)',
            'require_backup_service_caller(text)',
            'require_ingestion_caller(text)',
            'require_playback_caller(text)',
            'revoke_anon_function_privileges()',
            'revoke_credential_on_decommission()',
            'revoke_gateway_credential(text)',
            'revoke_service_principal(uuid, text)',
            'revoke_service_token(text)',
            'schema_version_base_name(text)',
            'secure_audit_trail_partition(regclass)',
            'seed_setting(text, jsonb, text, text, text, text, text)',
            'service_token_max_days()',
            'set_archive_credential(text)',
            'set_backup_offsite_credential(text)',
            'set_backup_offsite_destination(text, text, text, text, text, text, boolean)',
            'shadow_follows_its_original()',
            'sparkplug_group_default()',
            'stamp_audit_domain()',
            'stamp_proposal_author()',
            'start_capture_job(text, uuid, text, integer, boolean)',
            'start_playback_job(uuid, uuid, jsonb, numeric)',
            'sweep_forge()',
            'sweep_forge_on_archive_change()',
            'sweep_gateway_credential_revocations()',
            'system_settings_read_only_guard()',
            'system_settings_stamp()',
            'validate_change_proposal()',
            'withdraw_gateway_enrollment_tokens()',
            'withdraw_proposal(uuid)'
        ]) THEN
            EXECUTE format('DROP FUNCTION %s', r.sig);
            RAISE NOTICE 'dropped %, which this baseline does not declare.', r.sig;
        END IF;
    END LOOP;
END
$overloads$;


-- ---------------------------------------------------------------------------------------------
-- 5. Realtime publication
-- ---------------------------------------------------------------------------------------------
-- `telemetry` is absent: it is a postgres_fdw foreign table whose rows enter TimescaleDB's WAL,
-- and adding it would silently emit nothing. REPLICA IDENTITY FULL is required: Realtime
-- evaluates RLS against the old row too.
--
-- `audit_trail` is absent because an unauthenticated subscriber still receives the change
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
  -- `areas` is the Site Map's shape; the two job tables are what the Capture page subscribes to.
  intended CONSTANT text[] := ARRAY[
    'cells', 'gateways', 'devices', 'platform_alerts', 'areas', 'capture_jobs', 'playback_jobs'
  ];
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
ALTER TABLE public.audit_trail REPLICA IDENTITY DEFAULT;

-- ---------------------------------------------------------------------------------------------
-- 6. Privileges withdrawn
-- ---------------------------------------------------------------------------------------------
-- These cannot be read off a dump, which describes what is granted rather than what must not
-- be. The image's default privileges hand anon, authenticated and service_role full rights on
-- every sequence created after them.
REVOKE ALL ON SEQUENCE public.audit_trail_id_seq FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.audit_trail_id_seq FROM service_role;

-- APPEND-ONLY IS ENFORCED BY THE ABSENCE OF A GRANT, which is precisely what a dump cannot state.
-- `service_role` is the credential ingestion and every edge function hold, so these two tables --
-- the audit trail and the ledger that stops a one-shot migration running twice -- are the two the
-- squash must not hand back write access to. A generated baseline grants ALL by default and the
-- only trace of the mistake would be four extra words in one ACL line.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.audit_trail FROM service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.one_shot_migrations FROM service_role;

-- Two tables only their own SECURITY DEFINER functions write: the forge-sweep lease and the
-- pg_net request behind each revocation stamp. `service_role` reads them and nothing more.
REVOKE ALL ON TABLE public.forge_sweep_lease FROM service_role;
GRANT SELECT ON TABLE public.forge_sweep_lease TO service_role;
REVOKE ALL ON TABLE public.gateway_revocation_requests FROM service_role;
GRANT SELECT ON TABLE public.gateway_revocation_requests TO service_role;

-- Four functions nothing outside a migration may call: two maintenance routines that pg_cron
-- invokes as the superuser it runs under, the sweep above, and the Directory's image writer that
-- db-init calls with the chart's map. Revoked from service_role as well, because holding the
-- service key is not a reason to be able to rewrite the cron schedule.
REVOKE ALL ON FUNCTION public.ensure_cron_job(p_name text, p_schedule text, p_command text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prune_platform_alerts(interval)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.revoke_anon_function_privileges()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_directory_images(jsonb)
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
-- THE BACKUP LANE IS CLOSED TO EVERY PostgREST ROLE, and section 4 cannot say so. These twelve
-- are SECURITY DEFINER gates the backup service reaches over its own connection; the only thing
-- standing between `service_role` and them is the absence of a grant, and the image's default
-- privileges hand `service_role` EXECUTE on every function created after them. 0101 withdrew it
-- and a dump records only what was granted, so a generated baseline hands it back.
REVOKE ALL ON FUNCTION public.require_backup_service_caller(text)               FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.backup_schedule(text)                             FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.backup_reconcile_jobs(text)                       FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.backup_claim_job()                                FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.backup_finalise(uuid, text, text, jsonb, bigint)  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.backup_fail(uuid, text)                           FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.backup_prunable(integer)                          FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.backup_forget(uuid, text)                         FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.backup_offsite_base()                             FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.backup_offsite_destination()                      FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.backup_offsite_next()                             FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.backup_offsite_record(uuid, text, jsonb, text)    FROM PUBLIC, anon, authenticated, service_role;

-- The off-site settings' trigger function, which fires whatever the writer holds. Nobody calls it.
REVOKE ALL ON FUNCTION public.backup_offsite_setting_guard() FROM PUBLIC, anon, authenticated, service_role;

-- ONE GRANT THE SWEEP ABOVE MUST NOT TAKE, and it has to be re-stated after it rather than with
-- the object. `auth_pre_request()` is PostgREST's db-pre-request hook: it runs for EVERY request
-- before the role is considered, so `anon` executing it is what makes an unauthenticated request
-- possible at all. In the chain this file replaces the grant landed in 0074 and 0076 -- after the
-- baseline, and therefore after the sweep. Folded, the grant arrives with the function and the
-- sweep then withdraws it, which takes the whole API down for anonymous callers on the next boot.
--
-- All three are withdrawn and re-granted together, in 0076's order, rather than adding `anon` back
-- on its own. A grantee keeps its place in the ACL, so re-granting one role leaves it last instead
-- of first -- the same three grants in a different order, which a dump records and a digest sees.
REVOKE ALL ON FUNCTION public.auth_pre_request() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.auth_pre_request() TO anon, authenticated, service_role;

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
