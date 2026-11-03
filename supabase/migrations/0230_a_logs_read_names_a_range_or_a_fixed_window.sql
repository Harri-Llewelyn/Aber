-- 0230: A read of a service's logs names a rolling range or a fixed window's two ends.
--
-- System › Logs uses the shared time control: a day, a week, a step back or a custom range is a
-- fixed window, which service-logs takes as `from` and `to`. record_service_logs_read() takes
-- p_from and p_to after p_range, each DEFAULT NULL, and a read names a range or the two ends, never
-- both. The row records what was asked for: the range key for a rolling window, as before, so a poll
-- of the last hour still writes nothing; the two ends, in UTC to the millisecond, for a fixed one,
-- so stepping to yesterday writes one row and refreshing yesterday none. The ends are in order and
-- at most 169 hours apart: 7 days, and the hour a calendar week gains when the clocks go back.
--
-- Two more arguments are a new signature. 0225, the function's own file, declares the six-argument
-- form in place, as 0001 and 0168 declared 0227's, and this file holds no second copy of the body.
-- On the first boot of an upgrade 0225 creates the new form beside the four-argument one, and this
-- file drops that; on every later boot only the new form exists. It states the grants by name.
--
-- Reasoning: supabase/README.md, "A read of a service's logs names a range or a fixed window (0230)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The four-argument form, from before this file
-- -------------------------------------------------------------------------------------------------
-- Guarded, so a boot with nothing to drop prints nothing.
DO $drop$
BEGIN
  IF to_regprocedure('public.record_service_logs_read(text, text, text, text)') IS NOT NULL THEN
    DROP FUNCTION public.record_service_logs_read(text, text, text, text);
  END IF;
END
$drop$;

-- -------------------------------------------------------------------------------------------------
-- 2. Who may call the six-argument form
-- -------------------------------------------------------------------------------------------------
-- The service-logs function calls it in the caller's session; the body admits an Administrator.
REVOKE ALL ON FUNCTION public.record_service_logs_read(text, text, text, text, timestamp with time zone,
                                                       timestamp with time zone) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.record_service_logs_read(text, text, text, text, timestamp with time zone,
                                                          timestamp with time zone) TO authenticated;

-- -------------------------------------------------------------------------------------------------
-- What this file and 0225 did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_forms text[];
  v_read  regprocedure;
  v_arg   text;
  v_type  text;
  v_role  text;
BEGIN
  SELECT array_agg(pg_get_function_identity_arguments(p.oid) ORDER BY p.oid) INTO v_forms
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'record_service_logs_read';
  IF coalesce(array_length(v_forms, 1), 0) <> 1 THEN
    RAISE EXCEPTION '0230: record_service_logs_read is declared % times, not once: %',
      coalesce(array_length(v_forms, 1), 0), coalesce(array_to_string(v_forms, ' | '), 'none');
  END IF;
  SELECT p.oid::regprocedure INTO v_read
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'record_service_logs_read';

  -- Each window argument by its name, wherever it stands.
  FOREACH v_arg IN ARRAY ARRAY['p_range:text', 'p_from:timestamp with time zone',
                               'p_to:timestamp with time zone'] LOOP
    SELECT format_type(t.typ, NULL) INTO v_type
      FROM pg_proc p,
           unnest(p.proargnames, p.proargtypes::oid[]) AS t(name, typ)
     WHERE p.oid = v_read AND t.name = split_part(v_arg, ':', 1);
    IF v_type IS DISTINCT FROM split_part(v_arg, ':', 2) THEN
      RAISE EXCEPTION '0230: record_service_logs_read takes % as %, not as %',
        split_part(v_arg, ':', 1), coalesce(v_type, 'nothing'), split_part(v_arg, ':', 2);
    END IF;
  END LOOP;
  -- The two ends default to NULL, so a call naming the range alone, as a rolling read is sent, is
  -- still this form's.
  IF (SELECT pronargdefaults FROM pg_proc WHERE oid = v_read) < 2 THEN
    RAISE EXCEPTION '0230: record_service_logs_read''s p_from and p_to have no default';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_read
                  AND prosecdef AND 'search_path=public' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0230: % is not SECURITY DEFINER with its search_path pinned', v_read;
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
    IF has_function_privilege(v_role, v_read, 'EXECUTE') THEN
      RAISE EXCEPTION '0230: % may execute %', v_role, v_read;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('authenticated', v_read, 'EXECUTE') THEN
    RAISE EXCEPTION '0230: authenticated may not execute %; the service-logs function calls it', v_read;
  END IF;

  -- A request with no person behind it is refused before anything is written, a fixed window too.
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.record_service_logs_read('ingestion', 'any', '', NULL,
                                            now() - interval '1 day', now());
    RAISE EXCEPTION '0230: record_service_logs_read() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$check$;

NOTIFY pgrst, 'reload schema';
