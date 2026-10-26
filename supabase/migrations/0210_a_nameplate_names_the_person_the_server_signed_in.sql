-- 0210: A nameplate names the person the server signed in, at the time the server wrote it.
--
-- device_nameplate.updated_by and updated_at held whatever the request carried. The dashboard sent
-- its own user id and the browser's clock, and the write policies check only the caller's role, so
-- an Administrator or Shopfloor Manager calling the API could save an edit "by" anyone, or nobody,
-- at any time they chose.
--
--   * device_nameplate_stamp(), a BEFORE INSERT OR UPDATE trigger, sets updated_by := auth.uid()
--     and updated_at := now() on every row written, as system_settings_stamp() does. A write with
--     no person behind it (a migration, service_role) records NULL.
--   * An approved nameplate proposal is written by the approver, so the approver is recorded. The
--     proposer stays in change_proposals.proposed_by and in the approval's audit row.
--   * A restore keeps the recorded values: pg_restore and a plain dump load the rows before they
--     create the table's triggers.
--
-- Reasoning: supabase/README.md, "A nameplate names the person the server signed in (0210)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The stamp
-- -------------------------------------------------------------------------------------------------
-- SECURITY INVOKER, as system_settings_stamp() is: auth.uid() reads the caller's own token, and the
-- function touches nothing but the row it is given. No API role executes it; a trigger needs none.
CREATE OR REPLACE FUNCTION public.device_nameplate_stamp() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
    -- Whatever the request carried. `auth.uid()` reads `request.jwt.claims`, which PostgREST sets
    -- from the verified token. NULL under service_role and during migrations, which is correct.
    NEW.updated_by := auth.uid();
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

ALTER FUNCTION public.device_nameplate_stamp() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.device_nameplate_stamp() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.device_nameplate_stamp() IS
  'BEFORE INSERT OR UPDATE trigger on device_nameplate: sets updated_by to auth.uid() and '
  'updated_at to now(), whatever the request carried, as system_settings_stamp() does. '
  'updated_by is NULL for a write with no person behind it: a migration or service_role (0210).';

SELECT public.replay_trigger('public.device_nameplate', 'device_nameplate_stamp', $ddl$
CREATE TRIGGER device_nameplate_stamp BEFORE INSERT OR UPDATE ON public.device_nameplate FOR EACH ROW EXECUTE FUNCTION public.device_nameplate_stamp();
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- 2. What the columns say
-- -------------------------------------------------------------------------------------------------
COMMENT ON COLUMN public.device_nameplate.updated_by IS
  'Who last wrote this nameplate: the caller''s auth.uid(), stamped by device_nameplate_stamp() '
  'whatever the request carried. NULL for a write with no person behind it (a migration, '
  'service_role). An approved proposal records the approver; the proposer is the proposal''s '
  'proposed_by. A nameplate is an assertion about an asset, so who made it is part of the record '
  '(0210).';

COMMENT ON COLUMN public.device_nameplate.updated_at IS
  'When this nameplate was last written, by the database''s clock: stamped by '
  'device_nameplate_stamp() whatever the request carried (0210).';

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
    RAISE EXCEPTION '0210: device_nameplate_stamp() lost its search_path pin or became SECURITY DEFINER';
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(r, v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0210: % may execute device_nameplate_stamp()', r;
    END IF;
  END LOOP;
END
$check$;

NOTIFY pgrst, 'reload schema';
