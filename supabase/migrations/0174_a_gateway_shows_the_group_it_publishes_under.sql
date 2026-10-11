-- 0174: A gateway shows the Sparkplug group it publishes under.
--
-- Ingestion accepts an edge node whose topic names a group other than its row's sparkplug_group,
-- matching it by sparkplug_id alone, and said so only in its log. gateways.observed_sparkplug_group
-- holds the group the gateway last published under. Ingestion writes it through
-- ingest_record_gateway_group() when that group changes, and the Gateways page warns while it
-- differs from sparkplug_group. NULL until a node-level message arrives after this migration.
--
-- Reasoning: supabase/README.md, "A gateway shows the group it publishes under (0174)". Idempotent.

ALTER TABLE public.gateways ADD COLUMN IF NOT EXISTS observed_sparkplug_group text;

COMMENT ON COLUMN public.gateways.observed_sparkplug_group IS
  'The Sparkplug group this gateway''s edge node last published under, from the topic of its last '
  'node-level message: written by ingestion when it changes (0174), so a steady state writes nothing. '
  'NULL until one arrives. Differing from sparkplug_group means the node publishes outside the '
  'group the site addresses it by, which ingestion tolerates and the Gateways page warns about.';

-- A separate gate from ingest_record_gateway_health(): written only on a change, and a new name
-- rather than a new parameter there, whose signature the heartbeat calls on every message.
CREATE OR REPLACE FUNCTION public.ingest_record_gateway_group(p_gateway_id uuid, p_group text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_rows integer;
BEGIN
  PERFORM public.require_ingestion_caller('ingest_record_gateway_group');

  IF p_gateway_id IS NULL THEN
    RAISE EXCEPTION 'ingest_record_gateway_group: p_gateway_id is required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- The topic segment a gateway chose, so it is checked rather than trusted: the shape
  -- gateways_sparkplug_group_format holds, and the cap ingestion.py applies first
  -- (MAX_OBSERVED_GROUP_LENGTH).
  IF p_group IS NULL OR p_group = '' OR p_group ~ '[/+#]' THEN
    RAISE EXCEPTION 'ingest_record_gateway_group: % is not a Sparkplug group id', quote_nullable(p_group)
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF length(p_group) > 255 THEN
    RAISE EXCEPTION 'ingest_record_gateway_group: group is % characters, limit is 255', length(p_group)
      USING ERRCODE = 'string_data_right_truncation';
  END IF;

  -- The filter makes a repeat write a no-op, so the audit trigger records each change once.
  UPDATE public.gateways g
     SET observed_sparkplug_group = p_group
   WHERE g.id = p_gateway_id
     AND g.observed_sparkplug_group IS DISTINCT FROM p_group;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows = 0 AND NOT EXISTS (SELECT 1 FROM public.gateways WHERE id = p_gateway_id) THEN
    PERFORM public.raise_not_found(format('gateway %s not found', p_gateway_id));
  END IF;

  RETURN v_rows > 0;
END
$$;

ALTER FUNCTION public.ingest_record_gateway_group(uuid, text) OWNER TO postgres;

COMMENT ON FUNCTION public.ingest_record_gateway_group(uuid, text) IS
  'Set gateways.observed_sparkplug_group to the group this gateway''s edge node now publishes under. '
  'True when the row changed; a repeat writes nothing. Ingestion principal only.';

-- authenticated because the ingestion principal is one; require_ingestion_caller() is the gate.
REVOKE ALL ON FUNCTION public.ingest_record_gateway_group(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ingest_record_gateway_group(uuid, text) TO authenticated, service_role;

-- gateway_status is SELECT g.*, frozen at creation: rebuilt so it carries the new column.
SELECT public.ensure_gateway_status_view();

-- ---------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- ---------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn text := 'public.ingest_record_gateway_group(uuid, text)';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'gateway_status'
                    AND column_name = 'observed_sparkplug_group') THEN
    RAISE EXCEPTION '0174: gateway_status does not carry observed_sparkplug_group';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
                  WHERE p.oid = v_fn::regprocedure AND l.lanname = 'plpgsql' AND p.prosecdef
                    AND p.prosrc LIKE '%require_ingestion_caller%') THEN
    RAISE EXCEPTION '0174: % is not a plpgsql SECURITY DEFINER gate on the ingestion caller', v_fn;
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0174: % is executable by anon', v_fn;
  END IF;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0174: authenticated may not execute %; the ingestion principal is authenticated', v_fn;
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
