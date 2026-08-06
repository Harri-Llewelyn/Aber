-- =============================================================================================
-- Migration: 0005_digital_thread_signal_and_attribution.sql
-- Stop the Digital Thread recording machine non-events, and say what made every change it keeps
-- =============================================================================================
--
-- Two changes, one purpose: stop the audit trigger writing rows for machine non-events (an
-- unchanged UPDATE, a heartbeat-only UPDATE), and record WHAT made each remaining change.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- The measurements that motivated it, and why attribution alone would not have helped:
--   supabase/README.md -> "Audit signal and attribution (0005)"
-- =============================================================================================

SET check_function_bodies = false;


-- ---------------------------------------------------------------------------------------------
-- 1. Record WHAT made a change, alongside WHO
-- ---------------------------------------------------------------------------------------------
-- A separate column because `changed_by` is uuid REFERENCES auth.users and cannot hold
-- 'ingestion' -- and fabricating a login-capable GoTrue row for something that is not a person
-- would be worse. `changed_by` means WHICH user; `actor_source` means WHAT KIND of actor.
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

-- 'service', not 'ingestion': these rows predate the actor header, so the daemon cannot be named
-- with certainty and guessing would put false precision into the audit trail. On a fresh install
-- this also labels 0002's two seed rows 'service' where 'migration' would be exact -- accepted,
-- see supabase/README.md -> "Audit signal and attribution (0005)".
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
