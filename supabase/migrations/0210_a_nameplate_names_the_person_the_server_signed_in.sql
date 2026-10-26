-- 0210: A nameplate names the person the server signed in, at the time the server wrote it.
--
-- device_nameplate.updated_by and updated_at held whatever the request carried. The dashboard sent
-- its own user id and the browser's clock, and the write policies check only the caller's role, so
-- an Administrator or Shopfloor Manager calling the API could save an edit "by" anyone, or nobody,
-- at any time they chose.
--
--   * device_nameplate_stamp(), a BEFORE INSERT OR UPDATE trigger, sets updated_by := auth.uid()
--     and updated_at := now() on every row written through the API (current_user anon,
--     authenticated or service_role), as system_settings_stamp() does. service_role records NULL.
--   * The database's own writes keep their values. approve_proposal() runs as its owner and
--     records the proposer, as archived migration 0086 decided; a migration or the owner's session
--     writes what it means to.
--   * A restore keeps the recorded values: pg_restore and a plain dump load the rows before they
--     create the table's triggers.
--
-- Reasoning: supabase/README.md, "A nameplate names the person the server signed in (0210)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The stamp
-- -------------------------------------------------------------------------------------------------
-- Stamps a write through the API, where current_user is the role PostgREST switched to. Any other
-- current_user is the database's own write and keeps its values: approve_proposal(), a SECURITY
-- DEFINER, records the proposer, whom change_proposals_insert_proposer pins to auth.uid(). INVOKER
-- so current_user is the writer's; a role later granted writes on this table must join the list.
CREATE OR REPLACE FUNCTION public.device_nameplate_stamp() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
    IF current_user IN ('anon', 'authenticated', 'service_role') THEN
        -- Whatever the request carried. `auth.uid()` reads `request.jwt.claims`, which PostgREST
        -- sets from the verified token. NULL under service_role, which is correct.
        NEW.updated_by := auth.uid();
        NEW.updated_at := now();
    END IF;
    RETURN NEW;
END;
$$;

ALTER FUNCTION public.device_nameplate_stamp() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.device_nameplate_stamp() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.device_nameplate_stamp() IS
  'BEFORE INSERT OR UPDATE trigger on device_nameplate. A write through the API (current_user '
  'anon, authenticated or service_role) gets updated_by auth.uid() and updated_at now(), '
  'whatever the request carried, as system_settings_stamp() does; service_role records NULL. '
  'Any other current_user is the database''s own write and keeps its values: approve_proposal(), '
  'running as its owner, records the proposer (0210).';

SELECT public.replay_trigger('public.device_nameplate', 'device_nameplate_stamp', $ddl$
CREATE TRIGGER device_nameplate_stamp BEFORE INSERT OR UPDATE ON public.device_nameplate FOR EACH ROW EXECUTE FUNCTION public.device_nameplate_stamp();
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- 2. What the columns say
-- -------------------------------------------------------------------------------------------------
COMMENT ON COLUMN public.device_nameplate.updated_by IS
  'Who last edited this nameplate. A write through the API records the caller''s auth.uid(), '
  'stamped by device_nameplate_stamp() whatever the request carried; service_role records NULL. '
  'An approved proposal records its proposer. A nameplate is an assertion about an asset, so who '
  'made it is part of the record (0210).';

COMMENT ON COLUMN public.device_nameplate.updated_at IS
  'When this nameplate was last written, by the database''s clock. A write through the API is '
  'stamped by device_nameplate_stamp() whatever the request carried; approve_proposal() writes '
  'the time it applied the proposal (0210).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn   regprocedure := 'public.device_nameplate_stamp()'::regprocedure;
  v_type smallint;
  r      text;
BEGIN
  SELECT t.tgtype INTO v_type
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.device_nameplate'::regclass
     AND t.tgname = 'device_nameplate_stamp'
     AND t.tgfoid = v_fn
     AND t.tgenabled = 'O';
  IF v_type IS NULL THEN
    RAISE EXCEPTION '0210: device_nameplate_stamp is missing or disabled, so a nameplate would record '
      'whoever the request names';
  END IF;
  -- ROW (1), BEFORE (2), INSERT (4) and UPDATE (16).
  IF v_type & 23 <> 23 THEN
    RAISE EXCEPTION '0210: device_nameplate_stamp is not BEFORE INSERT OR UPDATE FOR EACH ROW (tgtype %)', v_type;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn
                  AND NOT prosecdef AND 'search_path=public, pg_catalog' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0210: device_nameplate_stamp() lost its search_path pin or became SECURITY DEFINER, '
      'where current_user would always be its owner and nothing would be stamped';
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(r, v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0210: % may execute device_nameplate_stamp()', r;
    END IF;
  END LOOP;
END
$check$;

NOTIFY pgrst, 'reload schema';
