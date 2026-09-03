-- =============================================================================================
-- 0048 · A machine principal is not a user, and the daemon stops being service_role. Item 16.
-- =============================================================================================
-- The last of four. 0046 created the identity, 0047 built the gates, the daemon now calls them --
-- and this closes the item by taking the service-role key off it for real.
--
-- ---------------------------------------------------------------------------------------------
-- THE ATTRIBUTION BUG THIS FIXES WAS CREATED BY GIVING THE DAEMON AN IDENTITY
--
-- `log_digital_thread_event()` decides what kind of actor made a change like this:
--
--     v_actor := auth.uid();
--     IF v_actor IS NOT NULL THEN v_source := 'user';
--
-- That was correct for as long as the only things with a `sub` were people. The daemon arrived on
-- the service-role key, which carries no `sub`, so `auth.uid()` was NULL and the function fell
-- through to the `X-ACS-Cymru-Actor` header and recorded `'ingestion'`.
--
-- Point the daemon at a real principal and that inverts: `auth.uid()` starts returning
-- Service_Ingestor, and EVERY INGESTION WRITE GETS RECORDED AS A HUMAN ACTION. Nothing errors. The
-- Digital Thread simply starts attributing automated device registrations, status flips and
-- re-quarantines to a person, and the only sign is a `changed_by` uuid that does not belong to
-- anyone who works here.
--
-- The irony is worth stating because it is the whole lesson: that same function already refuses to
-- take `'user'` from the header -- "claiming a human author is exactly the assertion a client must
-- not be able to make about itself". Narrowing the daemon's credential would have let it make that
-- claim through the front door instead.
--
-- ---------------------------------------------------------------------------------------------
-- THE FIX IS TO ASK WHAT KIND OF ACCOUNT IT IS, NOT WHETHER THERE IS ONE
--
-- `is_machine_principal()` uses 0042's predicate unchanged -- no email, no password, no
-- `auth.identities` row -- because that is already this schema's definition of a machine identity
-- and it is the one the Access Control page lists from. A second, subtly different definition
-- would be worse than the bug.
--
-- THE ROW GETS BETTER, NOT JUST CORRECT. Before this change an ingestion write recorded
-- `actor_source = 'ingestion'` and `changed_by = NULL`, because there was nothing to name. Now it
-- records `'ingestion'` AND names Service_Ingestor. The audit trail gains a fact it never had.
--
-- ---------------------------------------------------------------------------------------------
-- AND THE TRANSITIONAL ARM COMES OFF `is_ingestion_caller()`
--
-- 0047 admitted `service_role` so that a daemon deployed before the swap kept working, and said
-- removing it would be one line "so that it is a decision rather than a refactor". This is that
-- decision. docker-compose.yml and the Helm chart no longer hand the daemon a service-role key at
-- all, so the arm now protects nothing and only widens the gates.
--
-- WHAT AN OPERATOR SEES MID-UPGRADE. `docker compose up -d` applies migrations and recreates the
-- ingestion container in the same command, so both halves land together. In the seconds between,
-- an old daemon still holding the service key has its writes refused with 42501 and logs them;
-- telemetry is unaffected throughout, because that goes to TimescaleDB over a different connection
-- and never touches these gates. It self-heals on the next message after the restart.
--
-- An .env predating this change has no SUPABASE_INGESTION_KEY, and the daemon REFUSES TO START
-- rather than falling back -- the same treatment SUPABASE_SERVICE_ROLE_KEY always got. The config
-- drift check names the missing key directly, which is what that check is for.
-- =============================================================================================

SET search_path TO public;


-- ---------------------------------------------------------------------------------------------
-- 1. What counts as a machine
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_machine_principal(p_user_id uuid)
    RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
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
$fn$;

COMMENT ON FUNCTION public.is_machine_principal(uuid) IS
  'True for a seeded or minted machine identity -- no email, no password, no identity provider, '
  'and therefore unable to sign in. The predicate is 0042''s, deliberately unchanged: a second '
  'definition of "is this a service account" would be worse than none. Used by '
  'log_digital_thread_event() to keep a machine''s writes from being recorded as a human''s.';

REVOKE ALL ON FUNCTION public.is_machine_principal(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_machine_principal(uuid) TO authenticated, service_role;


-- ---------------------------------------------------------------------------------------------
-- 2. The attribution branch
-- ---------------------------------------------------------------------------------------------
-- Only the "what kind of actor" test changes. `changed_by` still receives `v_actor`, so a machine
-- write is now both correctly classified AND named.
CREATE OR REPLACE FUNCTION public.log_digital_thread_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
            v_actor := NULLIF(current_setting('acs_cymru.actor_id', true), '')::UUID;
        EXCEPTION WHEN others THEN
            v_actor := NULL;
        END;
    END IF;

    -- -----------------------------------------------------------------------------------------
    -- What kind of actor
    -- -----------------------------------------------------------------------------------------
    -- A PERSON, not merely somebody. `auth.uid()` being non-NULL used to be sufficient because
    -- the only accounts carrying a `sub` were people's. Service_Ingestor (0046) is the
    -- counter-example, and there will be more, because the Access Control page mints them. A
    -- machine falls through to the declared-header path below and is recorded as what it actually
    -- is -- while `changed_by` still receives v_actor, so the row NAMES it as well (0048).
    IF v_actor IS NOT NULL AND NOT public.is_machine_principal(v_actor) THEN
        v_source := 'user';
    ELSE
        -- A caller may declare itself with an `X-ACS-Cymru-Actor` request header, which
        -- PostgREST exposes as request.headers. That is how the ingestion daemon is told apart
        -- from an edge function. They used to arrive on the same service-role key, so the
        -- connection alone could not distinguish them; the daemon now has its own identity, and
        -- this header is still what names it, because the branch above deliberately declines to
        -- read a machine's `sub` as evidence of a person.
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
        entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
        causation_id, recorded_at
    ) VALUES (
        TG_TABLE_NAME, v_entity_id, TG_OP, v_old_data, v_new_data, v_actor, v_source,
        txid_current(), NOW()
    );

    RETURN COALESCE(NEW, OLD);
END;
$function$;


-- ---------------------------------------------------------------------------------------------
-- 3. The transitional arm comes off
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_ingestion_caller()
    RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $fn$
    -- One arm now. `service_role` was admitted by 0047 only so that a daemon deployed before the
    -- credential swap kept working; nothing hands the daemon that key any more.
    --
    -- Note this does not stop `service_role` from writing these tables -- it bypasses RLS and
    -- always could. What it stops is `service_role` using the NARROW gates, which is what keeps
    -- "who may call these" a statement about one identity rather than about a key that half the
    -- stack holds.
    SELECT COALESCE(auth.uid()::text = 'b0000000-0000-4000-8000-000000000002', false);
$fn$;

COMMENT ON FUNCTION public.is_ingestion_caller() IS
  'True only for the Service_Ingestor principal (0046). Guards every ingest_* write gate. The '
  'transitional service_role arm was removed by 0048 -- see Machine Identities in '
  'supabase/README.md.';


-- ---------------------------------------------------------------------------------------------
-- 4. Self-check
-- ---------------------------------------------------------------------------------------------
DO $selfcheck$
DECLARE
    v_ingestor CONSTANT text := 'b0000000-0000-4000-8000-000000000002';
    v_device   uuid;
    v_human    uuid;
    v_source   text;
    v_by       uuid;
    v_denied   boolean;
BEGIN
    SELECT id INTO v_device FROM public.devices ORDER BY created_at LIMIT 1;

    -- A real person, for the contrast. Any account with an email will do.
    SELECT id INTO v_human FROM auth.users WHERE email IS NOT NULL ORDER BY created_at LIMIT 1;

    IF NOT public.is_machine_principal(v_ingestor::uuid) THEN
        RAISE EXCEPTION
          '0048 self-check: Service_Ingestor is not recognised as a machine principal, so its '
          'writes would be recorded in digital_thread as a human''s.';
    END IF;

    IF v_human IS NOT NULL AND public.is_machine_principal(v_human) THEN
        RAISE EXCEPTION
          '0048 self-check: a real account with an email was classified as a machine principal. '
          'Its changes would stop being attributed to a person.';
    END IF;

    IF v_device IS NULL THEN
        RAISE NOTICE '0048 self-check: no devices present, skipping the round-trip half.';
    ELSE
        BEGIN
            -- ---- The write, as the daemon makes it. ----
            PERFORM set_config('request.jwt.claims',
                               json_build_object('sub', v_ingestor, 'role', 'authenticated')::text,
                               true);
            PERFORM set_config('request.headers',
                               json_build_object('x-acs-cymru-actor', 'ingestion')::text, true);
            SET LOCAL ROLE authenticated;

            PERFORM public.ingest_record_declared_metrics(
                v_device, ARRAY['_0048_probe_' || floor(random() * 1e9)::text]);

            -- ---- Read the row back as superuser, NOT as the principal. ----
            -- Operator cannot SELECT digital_thread -- digital_thread_select_privileged_or_auditor
            -- (0001) is exactly what 0034 leans on when it picks Operator over Auditor. Querying
            -- it while still in role returns zero rows, and the check would read that as "nothing
            -- was written": a false pass waiting to happen rather than a real one.
            RESET ROLE;

            SELECT actor_source, changed_by INTO v_source, v_by
              FROM public.digital_thread
             WHERE entity_id = v_device
             ORDER BY recorded_at DESC, id DESC
             LIMIT 1;

            IF v_source IS NULL THEN
                RAISE EXCEPTION
                  '0048 self-check: the ingestion write left no digital_thread row at all, so '
                  'nothing about attribution can be concluded from this run.';
            END IF;

            IF v_source <> 'ingestion' THEN
                RAISE EXCEPTION
                  '0048 self-check: an ingestion write was recorded as actor_source=%, not '
                  'ingestion. Giving the daemon a real identity made auth.uid() non-NULL, and the '
                  'trigger concludes user from that alone unless it asks what kind of account it '
                  'is.', v_source;
            END IF;

            IF v_by IS DISTINCT FROM v_ingestor::uuid THEN
                RAISE EXCEPTION
                  '0048 self-check: an ingestion write recorded changed_by=%, expected the '
                  'Service_Ingestor principal. The row should now NAME the machine as well as '
                  'classify it.', coalesce(v_by::text, 'NULL');
            END IF;

            -- ---- And the gates are shut to service_role, which is what closes the item. ----
            PERFORM set_config('request.jwt.claims',
                               json_build_object('role', 'service_role')::text, true);
            SET LOCAL ROLE authenticated;
            v_denied := false;
            BEGIN
                PERFORM public.ingest_mark_device_offline(v_device);
            EXCEPTION WHEN insufficient_privilege THEN
                v_denied := true;
            END;
            IF NOT v_denied THEN
                RAISE EXCEPTION
                  '0048 self-check: service_role still reaches the ingestion write gates. The '
                  'transitional arm of is_ingestion_caller() is what item 16 exists to remove.';
            END IF;

            RESET ROLE;
            PERFORM set_config('request.jwt.claims', '', true);
            PERFORM set_config('request.headers', '', true);
            RAISE EXCEPTION 'rollback_selfcheck';
        EXCEPTION
            WHEN raise_exception THEN
                RESET ROLE;
                PERFORM set_config('request.jwt.claims', '', true);
                PERFORM set_config('request.headers', '', true);
                IF SQLERRM <> 'rollback_selfcheck' THEN RAISE; END IF;
        END;
    END IF;

    RAISE NOTICE '0048 self-check passed: an ingestion write is recorded as ''ingestion'' and '
                 'names Service_Ingestor, a real account is still a user, and service_role no '
                 'longer reaches the write gates.';
END;
$selfcheck$;
