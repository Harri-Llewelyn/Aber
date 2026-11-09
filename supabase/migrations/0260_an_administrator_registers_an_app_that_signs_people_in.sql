-- 0260: An Administrator registers an app that signs people in with Aber.
--
-- GoTrue's OAuth server signs people in to Grafana, Node-RED and the Studio and forge doors, whose
-- clients 0002 seeds. An app an Administrator wants to sign people in, such as a viewer someone
-- built, had no way in short of GoTrue's admin API and the secret key. This is the way:
--
--   * register_app(name, redirect addresses, client type) adds one row of auth.oauth_clients, as
--     0002 adds each of the four: registration_type manual, the authorization_code and
--     refresh_token grants, and for a confidential app a secret that is returned once and kept as
--     the SHA-256 hash GoTrue compares. Administrator only, and through require_mfa().
--   * app_redirect_problem(address, domain) is the rule an address must meet, and site_domain() is
--     the domain it reads from the Directory's own address for the API.
--
-- It is SQL and not GoTrue's admin API for two reasons found in GoTrue v2.197.0. Its validation
-- (validateRedirectURI) allows plain http only for localhost, 127.0.0.1 and ::1, so a site's own
-- names and private addresses, which Aber has no ACME to give https, could never be registered. And
-- a row GoTrue inserts is written with no token, so the Audit Trail would record the registration
-- with no person. Here auth.uid() is the Administrator, and 0217's trigger on auth.oauth_clients
-- writes APP_REGISTERED naming them. remove_app() already removes an app in SQL for the same reason.
-- Dynamic registration stays off. 0197 and check-docs-drift check 115 hold it.
--
-- Reasoning: supabase/README.md, "An Administrator registers an app that signs people in (0260)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The site's own domain
-- -------------------------------------------------------------------------------------------------
-- The domain of the API's public address, which db-init writes into the Directory on every boot
-- from the chart (SUPABASE_PUBLIC_URL, `api.<domain>` unless the chart names the address): the host
-- with its first label dropped when it has three or more. NULL when the address is an IP address, or
-- a single name such as localhost, where there is no domain to name.
CREATE OR REPLACE FUNCTION public.site_domain() RETURNS text
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT CASE
           WHEN h.host IS NULL OR h.host ~ '^[0-9.]+$' OR h.host !~ '\.' THEN NULL
           WHEN cardinality(string_to_array(h.host, '.')) >= 3 THEN substr(h.host, strpos(h.host, '.') + 1)
           ELSE h.host
         END
    FROM (SELECT lower(substring(d.endpoint_url FROM '^https?://([A-Za-z0-9.-]+)(?::[0-9]+)?(?:[/?#]|$)')) AS host
            FROM public.directory_services d
           WHERE d.id = 'f1111111-0000-0000-0000-000000000007') h
$$;

ALTER FUNCTION public.site_domain() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.site_domain() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.site_domain() IS
  'The site''s own domain: the host of the API''s public address in the Directory with its first '
  'label dropped when it has three or more (api.plant.example is plant.example). NULL for an IP '
  'address or a name with no dot. register_app() allows plain http under it (0260).';

-- -------------------------------------------------------------------------------------------------
-- 2. What an address may be
-- -------------------------------------------------------------------------------------------------
-- NULL when the address is allowed, otherwise what is wrong with it, as words that follow the
-- address. https goes anywhere. Plain http goes only to the site's own network: localhost and every
-- name under .localhost, loopback and private IPv4 addresses (127/8, 10/8, 172.16/12, 192.168/16),
-- ::1, and the site's domain and everything under it. No fragment, wildcard, comma, user name,
-- space or backslash, and no scheme but those two. The rule is a mirror of frontend/src/utils/apps.js
-- (mirror check 74, one fixture); a client that is not here is not an app the sign-in service sends
-- a person to.
CREATE OR REPLACE FUNCTION public.app_redirect_problem(p_uri text, p_site_domain text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public'
    AS $$
DECLARE
  v_scheme    text;
  v_authority text;
  v_host      text;
  v_port      text;
  v_domain    text := nullif(lower(p_site_domain), '');
  v_octets    int[];
  v_local     boolean;
BEGIN
  IF p_uri IS NULL OR p_uri = '' THEN
    RETURN 'is empty';
  END IF;
  IF p_uri ~ '[[:space:][:cntrl:]]' THEN
    RETURN 'has a space or a control character';
  END IF;
  IF char_length(p_uri) > 2048 THEN
    RETURN 'is longer than 2048 characters';
  END IF;
  IF p_uri LIKE '%,%' THEN
    RETURN 'has a comma, which the sign-in service reads as the end of one address';
  END IF;
  IF p_uri LIKE '%*%' THEN
    RETURN 'has a wildcard: give each address in full';
  END IF;
  IF p_uri LIKE '%#%' THEN
    RETURN 'has a fragment (#), which a redirect address may not';
  END IF;
  IF strpos(p_uri, chr(92)) > 0 THEN
    RETURN 'has a backslash';
  END IF;

  v_scheme := substring(p_uri FROM '^(https?)://');
  IF v_scheme IS NULL THEN
    RETURN 'must start with https://, or with http:// for an app on this site''s own network';
  END IF;
  v_authority := substring(p_uri FROM '^https?://([^/?#]*)');
  IF v_authority = '' THEN
    RETURN 'has no host after the scheme';
  END IF;
  IF v_authority LIKE '%@%' THEN
    RETURN 'has a user name or password in it';
  END IF;

  IF v_authority LIKE '[%' THEN
    v_host := lower(substring(v_authority FROM '^\[([0-9A-Fa-f:.]+)\](?::[0-9]{1,5})?$'));
    v_port := substring(v_authority FROM '^\[[0-9A-Fa-f:.]+\]:([0-9]{1,5})$');
  ELSE
    v_host := lower(substring(v_authority FROM '^([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)(?::[0-9]{1,5})?$'));
    v_port := substring(v_authority FROM '^[^:]+:([0-9]{1,5})$');
  END IF;
  IF v_host IS NULL OR v_host LIKE '%..%' THEN
    RETURN 'has a host that is not a name or an address';
  END IF;
  IF v_port IS NOT NULL AND (v_port::integer < 1 OR v_port::integer > 65535) THEN
    RETURN 'has a port outside 1 to 65535';
  END IF;

  IF v_scheme = 'https' THEN
    RETURN NULL;
  END IF;

  -- Plain http: the site's own network alone.
  IF v_host ~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' THEN
    v_octets := string_to_array(v_host, '.')::int[];
    IF v_octets[1] > 255 OR v_octets[2] > 255 OR v_octets[3] > 255 OR v_octets[4] > 255 THEN
      RETURN 'has a host that is not a name or an address';
    END IF;
    v_local := v_octets[1] IN (10, 127)
            OR (v_octets[1] = 172 AND v_octets[2] BETWEEN 16 AND 31)
            OR (v_octets[1] = 192 AND v_octets[2] = 168);
  ELSE
    v_local := v_host IN ('localhost', '::1', '0:0:0:0:0:0:0:1')
            OR right(v_host, 10) = '.localhost'
            OR (v_domain IS NOT NULL AND (v_host = v_domain OR right(v_host, char_length(v_domain) + 1) = '.' || v_domain));
  END IF;
  IF NOT v_local THEN
    RETURN 'is plain http, which is allowed only on this site''s own network: localhost, a private '
           'address' || CASE WHEN v_domain IS NULL THEN '' ELSE ', or a name under ' || v_domain END
           || '. Use https for any other address';
  END IF;
  RETURN NULL;
END
$$;

ALTER FUNCTION public.app_redirect_problem(p_uri text, p_site_domain text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.app_redirect_problem(text, text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.app_redirect_problem(p_uri text, p_site_domain text) IS
  'NULL when an app''s redirect address is allowed, else what is wrong with it, in words that '
  'follow the address. https anywhere; plain http only for localhost, .localhost names, loopback and '
  'private IPv4 addresses, ::1 and the site''s domain with everything under it. No fragment, '
  'wildcard, comma, user name, space or backslash, and no other scheme. Mirrored in '
  'frontend/src/utils/apps.js (0260).';

-- -------------------------------------------------------------------------------------------------
-- 3. Registering an app
-- -------------------------------------------------------------------------------------------------
-- Returns {id, name, client_type, redirect_uris, client_secret}. The id is the client_id an app is
-- given. The secret is in this answer and nowhere else: only its hash is kept, so a lost one is
-- remove_app() and a new registration. A public app has none and uses PKCE alone; GoTrue refuses a
-- secret from one. A confidential app authenticates at the token endpoint with HTTP Basic, the
-- method it is registered for, which GoTrue enforces exactly.
CREATE OR REPLACE FUNCTION public.register_app(p_name text, p_redirect_uris text[], p_client_type text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  -- GoTrue refuses a client with more than ten redirect addresses; mirror check 75.
  c_max_uris  CONSTANT integer := 10;
  c_max_name  CONSTANT integer := 80;
  v_name      text := btrim(p_name);
  v_uris      text[] := ARRAY[]::text[];
  v_uri       text;
  v_problem   text;
  v_domain    text;
  v_id        uuid := gen_random_uuid();
  v_secret    text;
  v_hash      text;
BEGIN
  IF NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'insufficient privileges to register an app'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.require_mfa();

  IF v_name IS NULL OR char_length(v_name) NOT BETWEEN 1 AND c_max_name OR v_name ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'give the app a name of 1 to % characters, on one line', c_max_name
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_client_type IS NULL OR p_client_type NOT IN ('public', 'confidential') THEN
    RAISE EXCEPTION 'the app is public or confidential, not %', coalesce(p_client_type, 'neither')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF coalesce(cardinality(p_redirect_uris), 0) NOT BETWEEN 1 AND c_max_uris THEN
    RAISE EXCEPTION 'give between 1 and % redirect addresses', c_max_uris
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_domain := public.site_domain();
  FOREACH v_uri IN ARRAY p_redirect_uris LOOP
    v_problem := public.app_redirect_problem(v_uri, v_domain);
    IF v_problem IS NOT NULL THEN
      RAISE EXCEPTION 'the redirect address % %', coalesce(nullif(v_uri, ''), '(empty)'), v_problem
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_uri = ANY (v_uris) THEN
      RAISE EXCEPTION 'the redirect address % is given twice', v_uri
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_uris := v_uris || v_uri;
  END LOOP;

  -- One registration at a time, so two with one name cannot both pass the check below.
  PERFORM pg_advisory_xact_lock(hashtextextended('public.register_app', 0));
  -- The consent page and the Apps tab say "Grafana" for "Aber Grafana", so a name is taken when
  -- only that prefix differs, as it is when only the case does. A removed app's name is free.
  IF EXISTS (SELECT 1 FROM auth.oauth_clients c
              WHERE c.deleted_at IS NULL
                AND lower(regexp_replace(btrim(coalesce(c.client_name, '')), '^aber[[:space:]]+', '', 'i'))
                  = lower(regexp_replace(v_name, '^aber[[:space:]]+', '', 'i'))) THEN
    RAISE EXCEPTION 'an app named % is already registered: give this one another name', v_name
      USING ERRCODE = 'unique_violation';
  END IF;

  IF p_client_type = 'confidential' THEN
    v_secret := translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_');
    v_hash := rtrim(translate(encode(extensions.digest(v_secret, 'sha256'), 'base64'), '+/', '-_'), '=');
  END IF;

  INSERT INTO auth.oauth_clients (
    id, client_secret_hash, registration_type, redirect_uris, grant_types,
    client_name, client_type, token_endpoint_auth_method
  ) VALUES (
    v_id, v_hash, 'manual', array_to_string(v_uris, ','), 'authorization_code,refresh_token',
    v_name, p_client_type::auth.oauth_client_type,
    CASE WHEN p_client_type = 'confidential' THEN 'client_secret_basic' ELSE 'none' END
  );

  RETURN jsonb_build_object('id', v_id, 'name', v_name, 'client_type', p_client_type,
                            'redirect_uris', to_jsonb(v_uris), 'client_secret', to_jsonb(v_secret));
END
$$;

ALTER FUNCTION public.register_app(p_name text, p_redirect_uris text[], p_client_type text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.register_app(text, text[], text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.register_app(text, text[], text) TO authenticated;

COMMENT ON FUNCTION public.register_app(p_name text, p_redirect_uris text[], p_client_type text) IS
  'Administrator only, with a second factor while Settings requires one. Registers an app that '
  'signs people in with Aber: registration_type manual, the authorization_code and refresh_token '
  'grants, 1 to 10 redirect addresses that app_redirect_problem() allows, and a name nobody holds '
  'now. A confidential app gets a secret, returned here once and kept only as its hash; a public one '
  'uses PKCE alone. Returns {id, name, client_type, redirect_uris, client_secret}. 0217''s trigger '
  'writes APP_REGISTERED naming the Administrator. Dynamic registration stays off (0260).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  f  text;
  r  text;
  c  record;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.site_domain()', 'public.app_redirect_problem(text, text)',
                           'public.register_app(text, text[], text)'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = f::regprocedure AND 'search_path=public' = ANY (proconfig)) THEN
      RAISE EXCEPTION '0260: % has no pinned search_path', f;
    END IF;
    FOREACH r IN ARRAY ARRAY['anon', 'service_role'] LOOP
      IF has_function_privilege(r, f, 'EXECUTE') THEN
        RAISE EXCEPTION '0260: % may execute %', r, f;
      END IF;
    END LOOP;
    IF has_function_privilege('authenticated', f, 'EXECUTE') <> (f LIKE 'public.register_app%') THEN
      RAISE EXCEPTION '0260: authenticated % execute %', CASE WHEN f LIKE 'public.register_app%' THEN 'may not' ELSE 'may' END, f;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.register_app(text, text[], text)'::regprocedure AND prosecdef) THEN
    RAISE EXCEPTION '0260: register_app() is not SECURITY DEFINER';
  END IF;

  -- The address rule, one case in each arm.
  FOR c IN SELECT * FROM (VALUES
      ('https://viewer.example.org/callback', NULL, true),
      ('https://viewer.example.org:8443/cb?x=1', NULL, true),
      ('http://localhost:3000/cb', NULL, true),
      ('http://viewer.aber.localhost/cb', NULL, true),
      ('http://127.0.0.1:8080/cb', NULL, true),
      ('http://10.20.30.40/cb', NULL, true),
      ('http://172.16.0.9/cb', NULL, true),
      ('http://192.168.1.5:9000/cb', NULL, true),
      ('http://[::1]:3000/cb', NULL, true),
      ('http://viewer.plant.example/cb', 'plant.example', true),
      ('http://plant.example/cb', 'plant.example', true),
      ('http://viewer.example.org/cb', NULL, false),
      ('http://8.8.8.8/cb', NULL, false),
      ('http://172.32.0.1/cb', NULL, false),
      ('http://192.169.0.1/cb', NULL, false),
      ('http://notplant.example/cb', 'plant.example', false),
      ('http://viewer/cb', NULL, false),
      ('https://viewer.example.org/cb#frag', NULL, false),
      ('https://*.example.org/cb', NULL, false),
      ('https://viewer.example.org/a,b', NULL, false),
      ('https://user:pass@viewer.example.org/cb', NULL, false),
      ('myapp://callback', NULL, false),
      ('HTTPS://viewer.example.org/cb', NULL, false),
      ('https://viewer.example.org/cb x', NULL, false),
      ('https://viewer.example.org:99999/cb', NULL, false),
      ('', NULL, false)
  ) AS t(uri, domain, allowed) LOOP
    IF (public.app_redirect_problem(c.uri, c.domain) IS NULL) <> c.allowed THEN
      RAISE EXCEPTION '0260: app_redirect_problem(%, %) is % where % is meant', c.uri, c.domain,
        coalesce(public.app_redirect_problem(c.uri, c.domain), 'null'), CASE WHEN c.allowed THEN 'allowed' ELSE 'a problem' END;
    END IF;
  END LOOP;

  -- A request with no person behind it is refused before anything is read or written.
  PERFORM set_config('request.jwt.claims', '', true);
  BEGIN
    PERFORM public.register_app('Self-check', ARRAY['https://viewer.example.org/cb'], 'public');
    RAISE EXCEPTION '0260: register_app() answered a caller with no identity';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$check$;

NOTIFY pgrst, 'reload schema';
