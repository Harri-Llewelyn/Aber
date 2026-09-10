-- 0094: the forge gets the login Gitea cannot be given any other way.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- Gitea's `openidConnect` source is configured from a discovery URL, and GoTrue's discovery
-- document carries relative endpoint paths and requires `scope=openid`, which this HS256 stack
-- refuses (supabase/README.md records both). So the forge's login is the gateway's `forge`
-- listener in supabase/envoy.yaml, in the shape Studio's is: an OAuth 2.1 code flow against this
-- stack's GoTrue, the access token verified locally, Administrator and Shopfloor_Manager
-- admitted, and the identity handed to Gitea as reverse-proxy headers. This registers the
-- client: `...0004`, beside Grafana, Node-RED and Studio. No userinfo function: the gateway reads
-- the role from the access token.
--
-- An absent secret skips the registration with a WARNING, as 0081 does, and the forge answers
-- with a login that cannot complete. The redirect URI is built from GITEA_ROOT_URL, the value
-- Gitea prints in clone commands, with the trailing slash trimmed: GoTrue compares the string
-- exactly.

\if :{?gitea_oauth_client_secret} \else \set gitea_oauth_client_secret '' \endif
\if :{?gitea_public_url}          \else \set gitea_public_url ''          \endif

-- psql does not substitute :variables inside dollar-quoted blocks (see archived migration 0026),
-- so both values are staged through session GUCs where substitution does happen.
SELECT set_config('acs_cymru.gitea_oauth_client_secret', :'gitea_oauth_client_secret', false);
SELECT set_config('acs_cymru.gitea_public_url',          :'gitea_public_url',          false);

DO $$
DECLARE
  -- Pinned, not generated: supabase/envoy.yaml carries this as the forge listener's `client_id`,
  -- and a fresh UUID on every stack rebuild would silently break the login. Same reasoning as the
  -- three pinned client ids before it.
  v_client_id CONSTANT UUID := 'c0ffee00-0000-4000-8000-000000000004';
  v_secret    TEXT := current_setting('acs_cymru.gitea_oauth_client_secret', true);
  v_base      TEXT := rtrim(
                        COALESCE(
                          NULLIF(current_setting('acs_cymru.gitea_public_url', true), ''),
                          'http://localhost:3003'),
                        '/');
  v_hash      TEXT;
BEGIN
  IF v_secret IS NULL OR v_secret = '' THEN
    RAISE WARNING 'gitea oauth client secret not supplied; skipping client registration. '
                  'The forge will answer a login it cannot complete. '
                  'Set GITEA_OAUTH_CLIENT_SECRET in .env and re-run.';
    RETURN;
  END IF;

  v_hash := rtrim(translate(encode(extensions.digest(v_secret, 'sha256'), 'base64'), '+/', '-_'), '=');

  INSERT INTO auth.oauth_clients (
    id, client_secret_hash, registration_type, redirect_uris, grant_types,
    client_name, client_uri, client_type, token_endpoint_auth_method
  ) VALUES (
    v_client_id,
    v_hash,
    'manual',                                        -- seeded, not self-registered
    v_base || '/oauth2/callback',                    -- the oauth2 filter's fixed callback path
    'authorization_code,refresh_token',
    'ACS-Cymru Forge',
    v_base,
    'confidential',
    -- MUST MATCH `auth_type: BASIC_AUTH` in the listener. GoTrue enforces the registered method
    -- exactly and answers 400 invalid_credentials for the other one, which reaches the user as
    -- nothing more specific than a failed login.
    'client_secret_basic'
  )
  ON CONFLICT (id) DO UPDATE SET
    client_secret_hash         = EXCLUDED.client_secret_hash,
    redirect_uris              = EXCLUDED.redirect_uris,
    grant_types                = EXCLUDED.grant_types,
    client_name                = EXCLUDED.client_name,
    client_uri                 = EXCLUDED.client_uri,
    token_endpoint_auth_method = EXCLUDED.token_endpoint_auth_method,
    deleted_at                 = NULL,
    updated_at                 = NOW();
  -- DO UPDATE, not DO NOTHING: db-init replays every migration on every stack start, so a rotated
  -- GITEA_OAUTH_CLIENT_SECRET or a changed GITEA_ROOT_URL has to take effect on the next boot.
END $$;

-- =================================================================================================
-- A row in the Directory, pointing at the door (GITEA_ROOT_URL, the gateway's forge listener),
-- NETWORK because the gateway publishes that port on every interface behind a login.
-- `SOURCE_CONTROL` is a new type, filed beside GRAPHICAL_UI on the page. Kept current on every
-- boot, as 0085 keeps the other derived rows; `status` stays UNKNOWN because nothing observes the
-- forge.
-- =================================================================================================

SELECT set_config('acs_cymru.dir_gitea_public_url', :'gitea_public_url', false);

DO $$
DECLARE
  v_forge TEXT := rtrim(
                    COALESCE(
                      NULLIF(current_setting('acs_cymru.dir_gitea_public_url', true), ''),
                      'http://localhost:3003'),
                    '/');
  v_moved INT := 0;
BEGIN
  INSERT INTO public.directory_services (id, service_name, service_type, endpoint_url, status, exposure)
  VALUES ('f1111111-0000-0000-0000-000000000011', 'Forge (Gitea)', 'SOURCE_CONTROL', v_forge, 'UNKNOWN', 'NETWORK')
  ON CONFLICT (id) DO NOTHING;

  UPDATE public.directory_services
     SET endpoint_url = v_forge
   WHERE id = 'f1111111-0000-0000-0000-000000000011'::uuid
     AND endpoint_url IS DISTINCT FROM v_forge;
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  IF v_moved > 0 THEN
    RAISE NOTICE 'directory: the forge now advertised at %, from GITEA_ROOT_URL', v_forge;
  END IF;
END $$;

SELECT set_config('acs_cymru.dir_gitea_public_url', '', false);
SELECT set_config('acs_cymru.gitea_oauth_client_secret', '', false);
