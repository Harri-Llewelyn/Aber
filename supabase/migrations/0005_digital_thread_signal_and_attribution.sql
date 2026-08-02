-- =============================================================================================
-- Migration: 0005_digital_thread_signal_and_attribution.sql
-- Stop the Digital Thread recording machine non-events, and say what made every change it keeps
-- =============================================================================================
--
-- THE PROBLEM, MEASURED. On a stack running ONE simulated gateway and ONE device, the audit table
-- was taking 175 rows/hour, of which 123 in the first hour had `changed_by IS NULL`:
--
--     entity    action  what actually differed          rows
--     gateways  UPDATE  last_heartbeat only               84
--     gateways  UPDATE  last_heartbeat, status             1
--     devices   UPDATE  *nothing at all* (old = new)      33
--
-- So the reason `changed_by` was NULL is that these were not things a person did -- a gateway
-- sending a heartbeat has no author. Attributing them would have faithfully labelled 175 rows an
-- hour as "the ingestion daemon" and left the log exactly as unreadable: at 50 gateways this is
-- ~210k rows/day into an append-only table, burying the handful of rows that record an operator
-- changing something.
--
-- Two of those three sources are not events at all:
--
--   * The 33 device rows had `old_data = new_data`. Ingestion re-sends `status='ONLINE'` on every
--     rebirth (60s), and an AFTER UPDATE trigger fires whether or not the values changed. A write
--     that changed nothing is not a change.
--   * `last_heartbeat` is liveness telemetry, not metadata. Nothing reads it from the audit log:
--     `public.gateway_status` derives staleness from the live column at read time, which is
--     exactly why it is a view and not a stored status (see 0001's ensure_gateway_status_view).
--
-- CLAUDE.md already states this discipline for the quarantine webhook -- "a blanket hook would
-- emit ~2 HTTP calls/min/gateway of noise" -- and for record_declared_metrics, which writes only
-- on change. The audit trigger was the one place it had not been applied.
--
-- IDEMPOTENT: db-init replays every /migrations/*.sql on every boot.
-- =============================================================================================

SET check_function_bodies = false;


-- ---------------------------------------------------------------------------------------------
-- 1. Record WHAT made a change, alongside WHO
-- ---------------------------------------------------------------------------------------------
-- `changed_by` is uuid REFERENCES auth.users, so it cannot hold 'ingestion'. Rather than
-- fabricating a login-capable row in GoTrue's own table for something that is not a person, the
-- provenance goes in its own column. `changed_by` keeps meaning "which user"; `actor_source`
-- means "what kind of actor", and the two are read together.
--
-- The point of the pair: once machine writes say so explicitly, `actor_source IS NULL` stops
-- meaning "probably a heartbeat" and starts meaning "we lost track of this", which is a
-- reportable defect rather than the normal case.
ALTER TABLE public.digital_thread ADD COLUMN IF NOT EXISTS actor_source text;

COMMENT ON COLUMN public.digital_thread.actor_source IS
  'What kind of actor made the change: user | ingestion | migration | service. Complements '
  'changed_by, which names WHICH user and is NULL for every machine-originated write.';

DO $$
BEGIN
  -- A closed set, because one source is a request header a client supplies (see the trigger)
  -- and an audit column must not become free text an arbitrary caller can write into.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'digital_thread_actor_source_check'
  ) THEN
    ALTER TABLE public.digital_thread
      ADD CONSTRAINT digital_thread_actor_source_check
      CHECK (actor_source IS NULL OR actor_source IN ('user', 'ingestion', 'migration', 'service'));
  END IF;
END;
$$;


-- ---------------------------------------------------------------------------------------------
-- 2. The trigger: suppress non-events, and stamp provenance on what remains
-- ---------------------------------------------------------------------------------------------
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
    -- ONE comparison covers both cases, because subtracting a key that is absent is a no-op:
    --
    --   * rows identical            -> equal with or without last_heartbeat  -> a no-op write
    --   * only last_heartbeat moved -> equal once it is removed              -> liveness telemetry
    --
    -- `IS NOT DISTINCT FROM` rather than `=` so a NULL on either side compares as equal instead
    -- of yielding NULL and falling through to log the row.
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
            v_actor := NULLIF(current_setting('factoryplus.actor_id', true), '')::UUID;
        EXCEPTION WHEN others THEN
            v_actor := NULL;
        END;
    END IF;

    -- -----------------------------------------------------------------------------------------
    -- What kind of actor
    -- -----------------------------------------------------------------------------------------
    IF v_actor IS NOT NULL THEN
        v_source := 'user';
    ELSE
        -- A caller may declare itself with an `X-FactoryPlus-Actor` request header, which
        -- PostgREST exposes as request.headers. That is how the ingestion daemon is told apart
        -- from an edge function -- both arrive on the same service-role key, so the connection
        -- alone cannot distinguish them.
        BEGIN
            v_declared := NULLIF(
                current_setting('request.headers', true)::json ->> 'x-factoryplus-actor', ''
            );
        EXCEPTION WHEN others THEN
            v_declared := NULL;
        END;

        IF v_declared IN ('ingestion', 'service', 'migration') THEN
            -- 'user' is deliberately NOT accepted from a header: claiming a human author is
            -- exactly the assertion a client must not be able to make about itself.
            v_source := v_declared;
        ELSE
            -- WHICH ROLE IS CALLING, and NOT `current_user`. This function is SECURITY DEFINER,
            -- so inside it `current_user` is the function's OWNER -- always `postgres` -- which
            -- silently labelled every ingestion write as 'migration'. PostgREST connects as
            -- `authenticator` and then SET ROLEs, so the effective role is what `role` holds;
            -- a direct psql session never SET ROLE at all and reports 'none', where
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
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source, recorded_at
    ) VALUES (
        TG_TABLE_NAME, v_entity_id, TG_OP, v_old_data, v_new_data, v_actor, v_source, NOW()
    );

    RETURN COALESCE(NEW, OLD);
END;
$$;


-- ---------------------------------------------------------------------------------------------
-- 3. Clear the noise already recorded, and stamp what stays
-- ---------------------------------------------------------------------------------------------
-- Runs on the migration's owner connection, which the append-only trigger from 0003 exempts --
-- deliberately, because a role that can issue DDL can drop that trigger anyway. This is the one
-- sanctioned use of that exemption, and it removes only rows that record nothing: identical
-- writes and heartbeat stamps. No row describing an actual change is touched.
DELETE FROM public.digital_thread
 WHERE action = 'UPDATE'
   AND old_data IS NOT NULL
   AND new_data IS NOT NULL
   AND (new_data - 'last_heartbeat') IS NOT DISTINCT FROM (old_data - 'last_heartbeat');

-- Everything left with no user was a machine write. 'service' rather than 'ingestion': these
-- rows predate the header, so the daemon cannot be named with certainty, and guessing would put
-- a false precision into the audit trail.
--
-- ON A FRESH INSTALL THIS ALSO CATCHES 0002'S SEED ROWS, and labels them 'service' where
-- 'migration' would be exact. Migrations run in order, so 0002 inserts the demo gateway and
-- device while log_digital_thread_event() is still 0003's version -- the one with no
-- actor_source at all -- and they arrive here indistinguishable from any other machine write.
--
-- Accepted rather than fixed. The fix would be to define the trigger in 0001 so it is in place
-- before the seed runs, which puts the function in two files and reintroduces exactly the
-- two-sources-of-truth drift 0003's header argues against. The cost is two demo rows reading
-- "Service" instead of "Database migration"; both are machine sources, and nothing branches on
-- the difference. Every row written AFTER this migration is labelled precisely.
UPDATE public.digital_thread
   SET actor_source = 'service'
 WHERE actor_source IS NULL AND changed_by IS NULL;

UPDATE public.digital_thread
   SET actor_source = 'user'
 WHERE actor_source IS NULL AND changed_by IS NOT NULL;


-- ---------------------------------------------------------------------------------------------
-- 4. Self-check
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  v_unattributed INTEGER;
  v_noise        INTEGER;
BEGIN
  SELECT count(*) INTO v_unattributed FROM public.digital_thread WHERE actor_source IS NULL;
  IF v_unattributed > 0 THEN
    RAISE EXCEPTION '0005 self-check: % audit rows still carry no actor_source', v_unattributed;
  END IF;

  SELECT count(*) INTO v_noise
    FROM public.digital_thread
   WHERE action = 'UPDATE'
     AND old_data IS NOT NULL AND new_data IS NOT NULL
     AND (new_data - 'last_heartbeat') IS NOT DISTINCT FROM (old_data - 'last_heartbeat');
  IF v_noise > 0 THEN
    RAISE EXCEPTION '0005 self-check: % no-op/heartbeat audit rows survived the purge', v_noise;
  END IF;

  RAISE NOTICE '0005 self-check passed: every audit row is attributed and records a real change.';
END;
$$;
