-- 0222: A decision keeps the address its decider signed in with, and the Audit Trail finds what one
-- person or machine identity changed.
--
--   * change_proposals.decided_by_email: the decider's email, from the signed access token when a
--     proposal is approved, rejected or withdrawn, as stamp_proposal_author() takes
--     proposed_by_email when it is filed. stamp_proposal_decider() sets it whenever decided_by is
--     set or changes, and only when decided_by is the caller; otherwise it keeps the stored value,
--     so no client writes it. An expired proposal names no decider and keeps no address. A decision
--     made before this file keeps NULL: the address its decider had then is recorded nowhere.
--   * audit_trail_page() takes p_changed_by uuid, its eleventh and last argument, and keeps the
--     rows whose changed_by is that id, under the caller's own policies. 0001 and 0168 declare the
--     eleven-argument form. A database from before this file also holds the ten-argument form,
--     which 0001's sweep of stale overloads drops on the same boot and this file drops if it is
--     still there. PostgREST calls by argument name, and with both forms a call is ambiguous.
--
-- Reasoning: supabase/README.md, "A decision keeps its decider's address, and the Audit Trail
-- filters by who made a change (0222)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. change_proposals.decided_by_email and its stamp
-- -------------------------------------------------------------------------------------------------
-- No default, so adding the column rewrites no row, and every past decision reads NULL.
ALTER TABLE public.change_proposals ADD COLUMN IF NOT EXISTS decided_by_email text;

COMMENT ON COLUMN public.change_proposals.decided_by_email IS
  'The decider''s email, taken from the signed access token when the proposal was approved, '
  'rejected or withdrawn, and never from the request body. A readable label beside decided_by, '
  'which stays the key everything resolves through. NULL on an expired row, when the token carried '
  'no email, and on a decision made before 0222 (0222).';

-- The token is the decider's only when the decider is the caller: every transition function sets
-- decided_by to auth.uid(). auth.jwt() rather than auth.email(), for the reason
-- stamp_proposal_author() gives.
CREATE OR REPLACE FUNCTION public.stamp_proposal_decider() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.decided_by IS DISTINCT FROM OLD.decided_by THEN
        NEW.decided_by_email := CASE
            WHEN NEW.decided_by IS NOT NULL AND NEW.decided_by = auth.uid()
            THEN NULLIF(auth.jwt() ->> 'email', '')
        END;
    ELSE
        NEW.decided_by_email := OLD.decided_by_email;
    END IF;
    RETURN NEW;
END;
$$;

ALTER FUNCTION public.stamp_proposal_decider() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.stamp_proposal_decider() FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION public.stamp_proposal_decider() TO service_role;

COMMENT ON FUNCTION public.stamp_proposal_decider() IS
  'Stamps change_proposals.decided_by_email from the access token when decided_by is set or '
  'changes and is the caller, NULL otherwise, and keeps the stored value on any other write, so '
  'whatever the client supplied is discarded (0222).';

SELECT public.replay_trigger('public.change_proposals', 'trg_change_proposals_decider', $ddl$
CREATE TRIGGER trg_change_proposals_decider BEFORE INSERT OR UPDATE ON public.change_proposals FOR EACH ROW EXECUTE FUNCTION public.stamp_proposal_decider();
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- 2. audit_trail_page(): the ten-argument form, from before p_changed_by
-- -------------------------------------------------------------------------------------------------
-- Guarded, so a boot with nothing to drop prints nothing.
DO $drop$
BEGIN
  IF to_regprocedure('public.audit_trail_page(integer, boolean, text, text, uuid[], timestamp with time zone, '
                     'timestamp with time zone, timestamp with time zone, bigint, text)') IS NOT NULL THEN
    DROP FUNCTION public.audit_trail_page(integer, boolean, text, text, uuid[], timestamp with time zone,
                                          timestamp with time zone, timestamp with time zone, bigint, text);
  END IF;
END
$drop$;

-- -------------------------------------------------------------------------------------------------
-- What this file and 0001 did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_forms text[];
  v_page regprocedure;
  v_stamp regprocedure := to_regprocedure('public.stamp_proposal_decider()');
  v_role text;
BEGIN
  SELECT array_agg(pg_get_function_identity_arguments(p.oid) ORDER BY p.oid) INTO v_forms
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'audit_trail_page';
  IF coalesce(array_length(v_forms, 1), 0) <> 1 THEN
    RAISE EXCEPTION '0222: audit_trail_page is declared % times, not once: %',
      coalesce(array_length(v_forms, 1), 0), coalesce(array_to_string(v_forms, ' | '), 'none');
  END IF;
  -- Whatever its type: 0227 makes it a list, and checks that.
  IF v_forms[1] NOT LIKE '%, p_search text, p_changed_by uuid%' THEN
    RAISE EXCEPTION '0222: audit_trail_page takes (%), not p_changed_by last', v_forms[1];
  END IF;
  SELECT p.oid::regprocedure INTO v_page
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'audit_trail_page';
  -- SECURITY INVOKER: the table's policies decide which rows a filter can reach.
  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_page) THEN
    RAISE EXCEPTION '0222: audit_trail_page is SECURITY DEFINER, so it would read past audit_trail''s RLS';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['authenticated', 'service_role'] LOOP
    IF NOT has_function_privilege(v_role, v_page, 'EXECUTE') THEN
      RAISE EXCEPTION '0222: % cannot execute audit_trail_page; the Audit Trail reads through it', v_role;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', v_page, 'EXECUTE') THEN
    RAISE EXCEPTION '0222: anon may execute audit_trail_page';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'change_proposals'
                    AND column_name = 'decided_by_email' AND data_type = 'text'
                    AND is_nullable = 'YES' AND column_default IS NULL) THEN
    RAISE EXCEPTION '0222: change_proposals.decided_by_email is missing, not text, NOT NULL or defaulted';
  END IF;
  IF v_stamp IS NULL
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_stamp)
     OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_stamp
                     AND 'search_path=public' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0222: stamp_proposal_decider() is missing, not SECURITY DEFINER, or has no pinned search_path';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF has_function_privilege(v_role, v_stamp, 'EXECUTE') THEN
      RAISE EXCEPTION '0222: % may execute stamp_proposal_decider(), a trigger function', v_role;
    END IF;
  END LOOP;
  -- Enabled, BEFORE, FOR EACH ROW, on INSERT and on UPDATE of any column: an UPDATE OF list would
  -- let a client write the address alone.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.change_proposals'::regclass
                    AND tgname = 'trg_change_proposals_decider' AND NOT tgisinternal
                    AND tgfoid = v_stamp AND tgenabled = 'O' AND cardinality(tgattr::int2[]) = 0
                    AND tgtype & (1 | 2 | 4 | 16) = (1 | 2 | 4 | 16)) THEN
    RAISE EXCEPTION '0222: trg_change_proposals_decider is missing, disabled, or does not stamp every insert and update';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
