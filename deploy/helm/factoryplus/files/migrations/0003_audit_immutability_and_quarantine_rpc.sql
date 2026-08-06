-- =============================================================================================
-- Migration: 0003_audit_immutability_and_quarantine_rpc.sql
-- Pre-beta remediation: audit-trail immutability, and an atomic, attributable quarantine approval
-- =============================================================================================
--
-- WHY THIS IS A NEW FILE RATHER THAN AN EDIT TO 0001/0002. The baseline files describe the state
-- a FRESH database is built into; a live beta database has already run them, so a change that must
-- reach it has to arrive as a new numbered migration. Because db-init replays every
-- /migrations/*.sql on every boot, this file runs on fresh and existing databases alike and is
-- the single home for the behaviour below -- the trigger and the RPC are defined HERE ONLY, not
-- duplicated into 0001, which would create exactly the two-sources-of-truth drift this codebase
-- guards against elsewhere.
--
-- 0001 was corrected in one respect only: its `GRANT ... TRUNCATE ... TO authenticated` line, so a
-- fresh database never holds the privilege even momentarily. The REVOKE below is what repairs a
-- database built before that correction.
--
-- IT IS IDEMPOTENT. supabase-db-init replays every /migrations/*.sql on every boot and there is
-- no applied-migrations ledger, so every statement here survives re-execution.
--
-- THREE THINGS, all consequences of the same audit finding: the Digital Thread was neither
-- tamper-proof nor attributable.
--
--   1. `authenticated` held TRUNCATE on public.digital_thread. Append-only was enforced only by
--      the ABSENCE of INSERT/UPDATE/DELETE -- the original migration issued
--      `REVOKE INSERT, UPDATE, DELETE` against a prior `GRANT ALL`, which leaves TRUNCATE behind.
--      TRUNCATE bypasses RLS entirely, so the SELECT policy offered no protection from it.
--
--   2. Nothing stopped an UPDATE or DELETE by `service_role`. The service key ships in .env and is
--      held by ingestion and by every edge function, so "the audit trail cannot be rewritten" was
--      not true of the credential most widely deployed in the stack.
--
--   3. Every privileged write was recorded anonymously. log_digital_thread_event() stores
--      auth.uid(), and edge functions mutate through the service-role client, whose JWT carries no
--      `sub` -- so 58 of 65 rows on the audited database had changed_by IS NULL. "Who approved
--      this device onto the network" was unanswerable.
-- =============================================================================================

SET check_function_bodies = false;


-- ---------------------------------------------------------------------------------------------
-- 1. Close the TRUNCATE hole
-- ---------------------------------------------------------------------------------------------
-- REFERENCES and TRIGGER go with it: both are leftovers from the same GRANT ALL, neither is used,
-- and TRIGGER on an audit table is a way to attach code to it.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.digital_thread FROM authenticated;
REVOKE ALL ON public.digital_thread FROM anon;

-- The sequence was granted ALL to anon and authenticated. Nothing needs it: rows are written
-- exclusively by a SECURITY DEFINER trigger running as the owner.
REVOKE ALL ON SEQUENCE public.digital_thread_id_seq FROM anon, authenticated;


-- ---------------------------------------------------------------------------------------------
-- 2. Make the audit trail immutable to every application role
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_digital_thread_append_only() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  -- SCOPE, STATED HONESTLY. A trigger cannot constrain a role that can issue DDL: `postgres` and
  -- `supabase_admin` can DROP this trigger, DISABLE it, or drop the table outright, so a check
  -- that pretended to stop them would be theatre. What this DOES close is every path reachable
  -- over PostgREST -- as `authenticated`, and as `service_role`, which is the god key shipped in
  -- .env and held by ingestion and all four edge functions. PostgREST cannot execute DDL, so for
  -- those roles the trigger is a real boundary rather than a speed bump.
  --
  -- Maintenance therefore has to hold a genuine administrative connection, which is the point:
  -- clearing audit rows is an act that should require the same authority as dropping a table.
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

COMMENT ON FUNCTION public.enforce_digital_thread_append_only() IS
  'Rejects UPDATE and DELETE on public.digital_thread for every application role, including '
  'service_role. Owner roles are exempt because they can drop the trigger anyway.';

DROP TRIGGER IF EXISTS trg_digital_thread_append_only ON public.digital_thread;
CREATE TRIGGER trg_digital_thread_append_only
  BEFORE UPDATE OR DELETE ON public.digital_thread
  FOR EACH ROW EXECUTE FUNCTION public.enforce_digital_thread_append_only();

REVOKE ALL ON FUNCTION public.enforce_digital_thread_append_only() FROM PUBLIC;
GRANT ALL ON FUNCTION public.enforce_digital_thread_append_only() TO service_role;


-- ---------------------------------------------------------------------------------------------
-- 3. Restore attribution
-- ---------------------------------------------------------------------------------------------
-- log_digital_thread_event() falls back to a session-local GUC when auth.uid() is NULL, which is
-- the case for every write made with the service-role key. A SECURITY DEFINER RPC that knows who
-- asked sets `factoryplus.actor_id` with SET LOCAL, so the trigger records the operator rather
-- than the machine credential the operator's request happened to travel on.
--
-- A GUC rather than a widened trigger signature because a trigger takes no arguments; and
-- `SET LOCAL` rather than `set_config(..., false)` so it can never leak past the transaction into
-- a pooled connection's next occupant.
--
-- auth.uid() still WINS when present: a direct PostgREST write by a signed-in user is already
-- correctly attributed, and the GUC must not be able to override it.
CREATE OR REPLACE FUNCTION public.log_digital_thread_event() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_old_data JSONB := NULL;
    v_new_data JSONB := NULL;
    v_entity_id UUID;
    v_actor UUID;
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

    v_actor := auth.uid();

    IF v_actor IS NULL THEN
        -- NULLIF guards the empty string the GUC holds when it has never been set in this
        -- session; the cast would raise on it. `true` makes a missing setting return NULL
        -- rather than error.
        BEGIN
            v_actor := NULLIF(current_setting('factoryplus.actor_id', true), '')::UUID;
        EXCEPTION WHEN others THEN
            -- A malformed GUC must never break the write it is annotating. An unattributed
            -- audit row is bad; a lost one is worse.
            v_actor := NULL;
        END;
    END IF;

    INSERT INTO public.digital_thread (
        entity_type, entity_id, action, old_data, new_data, changed_by, recorded_at
    ) VALUES (
        TG_TABLE_NAME, v_entity_id, TG_OP, v_old_data, v_new_data, v_actor, NOW()
    );

    RETURN COALESCE(NEW, OLD);
END;
$$;


-- ---------------------------------------------------------------------------------------------
-- 4. Atomic, attributable quarantine approval
-- ---------------------------------------------------------------------------------------------
-- REPLACES a four-step PostgREST orchestration in supabase/functions/approve-quarantine/index.ts
-- that had no transaction and no compensating rollback. Its steps were: re-key asset_config onto
-- the surviving device, update that device, delete the quarantined duplicate. A failure at step 2
-- left asset_config pointing at a device that was never merged; a failure at step 3 left TWO
-- un-quarantined rows claiming one physical asset. Postgres already solves this, which is why the
-- orchestration is gone rather than wrapped in retries.
--
-- p_actor_id is the authenticated user resolved by the edge function. It is not decorative: it is
-- what makes the resulting digital_thread rows attributable, and it is re-checked here against
-- public.user_roles so the RPC enforces its own authorization rather than trusting its caller.
CREATE OR REPLACE FUNCTION public.approve_quarantined_device(
    p_device_id             uuid,
    p_actor_id              uuid,
    p_gateway_id            uuid    DEFAULT NULL,
    p_merge_into_device_id  uuid    DEFAULT NULL,
    p_asset_name            text    DEFAULT NULL,
    p_cell_id               uuid    DEFAULT NULL,
    p_location_scope        text    DEFAULT NULL,
    p_set_cell              boolean DEFAULT false,
    p_set_location_scope    boolean DEFAULT false
) RETURNS jsonb
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
  PERFORM set_config('factoryplus.actor_id', p_actor_id::text, true);

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
  -- Mirrors devices_site_wide_has_no_cell: a site-wide asset cannot also name a cell. Clearing
  -- it here means the caller gets an approval rather than a constraint violation it cannot
  -- interpret.
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

COMMENT ON FUNCTION public.approve_quarantined_device(uuid, uuid, uuid, uuid, text, uuid, text, boolean, boolean) IS
  'Atomically approves or merges a quarantined device. Re-checks the actor role against '
  'public.user_roles and attributes the resulting digital_thread rows to that actor.';

-- service_role only: this is called by the approve-quarantine edge function, which has already
-- authenticated the user. Not reachable by a browser session directly.
REVOKE ALL ON FUNCTION public.approve_quarantined_device(uuid, uuid, uuid, uuid, text, uuid, text, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_quarantined_device(uuid, uuid, uuid, uuid, text, uuid, text, boolean, boolean) TO service_role;


-- ---------------------------------------------------------------------------------------------
-- 5. Self-check
-- ---------------------------------------------------------------------------------------------
-- The migration proves its own central claim rather than asserting it. Runs as the migration's
-- role (postgres), which is exempt from the trigger, so the privilege is checked directly.
DO $$
BEGIN
  IF has_table_privilege('authenticated', 'public.digital_thread', 'TRUNCATE') THEN
    RAISE EXCEPTION '0003 self-check: authenticated still holds TRUNCATE on digital_thread';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.digital_thread'::regclass
       AND tgname  = 'trg_digital_thread_append_only'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '0003 self-check: the append-only trigger is not installed';
  END IF;

  RAISE NOTICE '0003 self-check passed: digital_thread is append-only to application roles.';
END;
$$;
