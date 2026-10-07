-- 0165: A function that finds nothing answers 404 through the API.
--
-- PostgREST answers the whole P0 class 500, no_data_found (P0002) included, so a mistyped id read
-- as a server fault. raise_not_found() raises PostgREST's custom error instead: the response keeps
-- the code P0002 and the message, with status 404. Any other caller (psql, a test) sees SQLSTATE
-- PGRST, with that JSON body as the message.

CREATE OR REPLACE FUNCTION public.raise_not_found(p_message text)
RETURNS void
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  RAISE SQLSTATE 'PGRST'
    USING MESSAGE = json_build_object(
            'code', 'P0002', 'message', p_message, 'details', NULL, 'hint', NULL)::text,
          DETAIL = '{"status": 404}';
END
$$;

-- Called only from SECURITY DEFINER functions owned by postgres, so no API role needs it, and
-- PostgREST does not offer it as an RPC.
ALTER FUNCTION public.raise_not_found(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.raise_not_found(text) FROM PUBLIC, anon, authenticated, service_role;
