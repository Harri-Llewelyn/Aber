-- 0122: a nameplate edit reaches the thread.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- `device_nameplate` has been a Digital Thread lane on paper for a long time. audit_domain_for()
-- classifies it, constants.js lists it as a filter, and api.js unions its rows into the timeline of
-- the device they name. Nothing ever wrote one: the table carried no trigger of any kind. A live
-- stack holds 4,075 audit rows across eleven entity types and not one is a nameplate, so the
-- filter was offered to every reader and could only ever answer empty.
--
-- IT COULD NOT SIMPLY BE ATTACHED to log_digital_thread_event(). That function read `NEW.id`, and
-- `device_nameplate` is keyed by `device_id` with no `id` column at all -- the same shape that
-- made log_role_assignment() a separate function for `user_roles`, whose key is
-- (user_id, role_id). A third copy of the attribution ladder is the obvious move and the wrong
-- one: it is eighty lines of subtle reasoning about who a caller is, and the copy that already
-- exists has to be kept in step by hand. The function now takes the key column as a trigger
-- argument and defaults it to `id`, so the seven triggers already attached are untouched.
--
-- THE ENTITY ID RECORDED IS THE DEVICE'S, which is what the dashboard already expects -- a
-- nameplate is an assertion about a device, and its edits belong in that device's history.

SET search_path TO public;

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
    v_key       TEXT;
BEGIN
    -- -----------------------------------------------------------------------------------------
    -- Suppression. UPDATE only: an INSERT or DELETE is always an event.
    -- -----------------------------------------------------------------------------------------
    -- One comparison covers every case, because subtracting an absent key is a no-op: identical
    -- rows are a no-op write, and rows differing only in the columns audit_telemetry_columns()
    -- names are a heartbeat's readings, which arrive every thirty seconds and are not events.
    -- `IS NOT DISTINCT FROM` so a NULL on either side compares as equal.
    IF TG_OP = 'UPDATE'
       AND (to_jsonb(NEW) - public.audit_telemetry_columns())
           IS NOT DISTINCT FROM (to_jsonb(OLD) - public.audit_telemetry_columns())
    THEN
        RETURN NEW;
    END IF;

    -- -----------------------------------------------------------------------------------------
    -- Which column names the entity
    -- -----------------------------------------------------------------------------------------
    -- `id` unless the trigger says otherwise. `device_nameplate` is keyed by `device_id` and has
    -- no `id` column at all, so the `NEW.id` this read before could never have been attached to
    -- it. Taking the name as a trigger argument keeps ONE attribution ladder for every table that
    -- has one: the alternative is a THIRD copy of everything below, after log_role_assignment(),
    -- which carries a deliberately reduced ladder and has to be kept in step with this one by
    -- hand.
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

    -- A column that is not there reads as NULL through `->>`, so a mistyped trigger argument
    -- would otherwise file every row under no entity. entity_id is NOT NULL, so this would be
    -- caught either way -- but by a constraint that names digital_thread rather than the trigger
    -- that is wrong.
    IF v_entity_id IS NULL THEN
        RAISE EXCEPTION
            'log_digital_thread_event: % has no % to name the entity by -- check the column named '
            'in the trigger argument', TG_TABLE_NAME, v_key
            USING ERRCODE = 'null_value_not_allowed';
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

COMMENT ON FUNCTION public.log_digital_thread_event() IS
  'AFTER trigger that appends to digital_thread. Suppresses an UPDATE that changed nothing and one that moved only the columns audit_telemetry_columns() names (0100). The entity id is read from the column named in the trigger argument, defaulting to `id` -- 0122, for device_nameplate, which is keyed by device_id. Attribution is auth.uid(), then acs_cymru.actor_id, then the X-ACS-Cymru-Actor header, then the effective role.';

-- -------------------------------------------------------------------------------------------------
-- The triggers
-- -------------------------------------------------------------------------------------------------
-- Split the way system_settings' pair is split, and for the same reason. The nameplate editor
-- upserts the whole row and stamps `updated_at` on every save, so a save that changed no nameplate
-- field still writes a different row -- and would file an event whose two snapshots are identical
-- but for a timestamp. audit_telemetry_columns() cannot cover this: it names the columns a GATEWAY
-- HEARTBEAT rewrites, and widening it to `updated_at` would silence that column everywhere.
--
-- DROP first: CREATE TRIGGER has no OR REPLACE before PostgreSQL 14's syntax, and the chain replays.

DROP TRIGGER IF EXISTS trg_device_nameplate_digital_thread ON public.device_nameplate;
CREATE TRIGGER trg_device_nameplate_digital_thread
    AFTER INSERT OR DELETE ON public.device_nameplate
    FOR EACH ROW EXECUTE FUNCTION public.log_digital_thread_event('device_id');

DROP TRIGGER IF EXISTS trg_device_nameplate_digital_thread_update ON public.device_nameplate;
CREATE TRIGGER trg_device_nameplate_digital_thread_update
    AFTER UPDATE ON public.device_nameplate
    FOR EACH ROW
    WHEN (((to_jsonb(new.*) - 'updated_at'::text) - 'updated_by'::text)
          IS DISTINCT FROM ((to_jsonb(old.*) - 'updated_at'::text) - 'updated_by'::text))
    EXECUTE FUNCTION public.log_digital_thread_event('device_id');

-- -------------------------------------------------------------------------------------------------
-- Self-check
-- -------------------------------------------------------------------------------------------------
-- STRUCTURAL ONLY, AND DELIBERATELY. An assertion about the rows already in digital_thread is an
-- assertion an empty test database cannot exercise, which is how 0120 reached a deployment before
-- anybody found out it was wrong -- see supabase/README.md and `npm run test:db:history`. Nothing
-- here counts a row. That a nameplate edit actually lands is asserted by
-- test_digital_thread_guard.py, which can write one.
DO $check$
DECLARE
    v_missing text;
    v_bad     text;
    v_lane    text;
BEGIN
    SELECT string_agg(want, ', ')
      INTO v_missing
      FROM unnest(ARRAY['trg_device_nameplate_digital_thread',
                        'trg_device_nameplate_digital_thread_update']) AS want
     WHERE NOT EXISTS (SELECT 1
                         FROM pg_trigger t
                        WHERE t.tgrelid = 'public.device_nameplate'::regclass
                          AND t.tgname = want);

    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION
            '0122 self-check: % did not survive the replay -- the lane is open and still unwritten.',
            v_missing;
    END IF;

    -- EVERY trigger on this function, not just the new pair. The key column is now a string
    -- argument, and a string argument naming a column that is not there reads as NULL rather than
    -- failing -- so a typo in a LATER migration would file rows under no entity. Asserted here
    -- because this is the file that introduced the way to get it wrong.
    SELECT string_agg(format('%s.%s -> %s', n.nspname, c.relname, k.col), ', ')
      INTO v_bad
      FROM pg_trigger t
      JOIN pg_class c     ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p      ON p.oid = t.tgfoid
     CROSS JOIN LATERAL (
            SELECT COALESCE(
                     (regexp_match(pg_get_triggerdef(t.oid),
                                   'log_digital_thread_event\(''([^'']*)''\)'))[1],
                     'id') AS col) k
     WHERE p.proname = 'log_digital_thread_event'
       AND NOT t.tgisinternal
       AND NOT EXISTS (SELECT 1
                         FROM pg_attribute a
                        WHERE a.attrelid = c.oid
                          AND a.attnum > 0
                          AND NOT a.attisdropped
                          AND a.attname = k.col);

    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION
            '0122 self-check: % names a column that table does not have, so every row it writes '
            'would be filed under no entity.', v_bad;
    END IF;

    -- The lane those rows will land in. A nameplate is an assertion about an asset, so a
    -- Shopfloor_Manager must be able to read one; the classifier has said `asset` since 0070 and
    -- this is the first file whose rows depend on it.
    v_lane := public.audit_domain_for('device_nameplate', 'UPDATE');
    IF v_lane <> 'asset' THEN
        RAISE EXCEPTION
            '0122 self-check: device_nameplate is in the % lane, so the rows this file starts '
            'writing would be invisible to the role that edits them.', v_lane;
    END IF;

    RAISE NOTICE '0122: device_nameplate writes to the digital thread, keyed by device_id.';
END
$check$;
