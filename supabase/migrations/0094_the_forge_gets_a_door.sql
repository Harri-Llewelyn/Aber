-- 0094: the forge gets the login Gitea cannot be given any other way.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- =================================================================================================
-- WHAT THIS IS FOR
--
-- Gitea's only general-purpose authentication source is `openidConnect`, configured entirely from a
-- discovery URL, and GoTrue's discovery document carries an empty issuer and RELATIVE endpoint
-- paths: an auth source added against it sends the browser to `/oauth/authorize` on the FORGE,
-- which is a 404. Its request also carries `scope=openid`, which GoTrue refuses on this HS256 stack
-- (`HS256 is not supported for ID token signing`). Both were measured; roadmap 7 records them.
--
-- So the forge's login is the gateway's, in the shape Studio's already is: the `forge` listener in
-- supabase/envoy.yaml runs an OAuth 2.1 authorization-code flow against this stack's own GoTrue,
-- verifies the access token locally, admits Administrator and Shopfloor_Manager, and hands the
-- verified identity to Gitea as reverse-proxy headers. This file provides the one thing only the
-- database can -- the client that flow authenticates as.
--
-- IT IS THE FOURTH CLIENT OF THE SAME SHAPE. Grafana is `...0001` (0002), Node-RED `...0002`
-- (archived 0006), Studio `...0003` (0081). As with Studio there is no userinfo function to go
-- with it: the gateway reads the role from the access token, which `custom_access_token_hook`
-- mirrors from `user_roles`, so authorisation stays where it always was. Gitea learns a username,
-- an email and a full name, and nothing about `gitops:manage`.
--
-- =================================================================================================
-- WHAT AN ABSENT SECRET DOES
--
-- Skips the registration with a WARNING, exactly as 0081 does. The gateway's own fail-closed branch
-- pairs with it: an upgraded stack that has not yet run `node scripts/setup.mjs` boots, serves every
-- other service, and answers the forge with a login that cannot complete -- which is the correct
-- posture, because the forge's HTTP port IS that listener now and there is no other way in.
--
-- THE REDIRECT URI IS BUILT FROM GITEA_ROOT_URL, the same value Gitea prints in clone commands and
-- the gateway redirects the browser to. One variable, three readers, so they cannot disagree. The
-- trailing slash Gitea wants on ROOT_URL is trimmed here for the reason 0002 and 0081 record: GoTrue
-- compares the string exactly, and `//oauth2/callback` fails as `invalid redirect_uri` at the END
-- of a login that looked fine until then.
-- =================================================================================================

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
-- AND A ROW IN THE DIRECTORY, because a door nobody can find is not much of a door.
--
-- The Directory page is where people look for services, and the forge was absent from it: while
-- its only login was a local administrator password there was nothing to send a person to. Now
-- there is. The row points at the DOOR -- GITEA_ROOT_URL, the gateway's forge listener -- and is
-- NETWORK because supabase-envoy publishes that port on every interface and authenticates what
-- arrives, the same reasoning 0084 gives for Studio's row.
--
-- `SOURCE_CONTROL` IS A NEW TYPE, and the page's first group claims it beside GRAPHICAL_UI. It is
-- not filed as GRAPHICAL_UI because the type is the category the service declared, and "a place
-- to review a change" is a different kind of thing from "a database console"; a later registry
-- entry for a second forge, or a reader filtering by type, should not have to know that.
--
-- KEPT CURRENT ON EVERY BOOT, as 0085 keeps Grafana's, Studio's and Node-RED's: the address is
-- what GITEA_ROOT_URL says now, not what it said when the row was first inserted. `status` stays
-- UNKNOWN -- nothing in this stack observes the forge (0054's argument), and seeding ACTIVE would
-- assert a health nobody checked.
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
