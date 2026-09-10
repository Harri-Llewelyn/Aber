-- 0081: Supabase Studio gets the login it has never had.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- Studio has no authentication of its own and connects as the database owner. The gateway holds
-- a listener in front of it: an OAuth 2.1 authorization-code flow against this stack's GoTrue, a
-- session cookie, and an `Administrator` check. This file registers the client that flow
-- authenticates as: `...0003`, beside Grafana (`...0001`) and Node-RED (`...0002`). No userinfo
-- function goes with it: `custom_access_token_hook` mirrors the role into the access token and
-- the gateway verifies that token itself.
--
-- An absent secret skips the registration with a WARNING, as 0002 does for Grafana; the gateway
-- then answers Studio with a login that cannot complete. The Directory entry stays at
-- `http://127.0.0.1:54323`, which is the port the proxy takes over.

\if :{?studio_oauth_client_secret} \else \set studio_oauth_client_secret '' \endif
\if :{?studio_public_url}          \else \set studio_public_url ''          \endif

-- psql does not substitute :variables inside dollar-quoted blocks (see archived migration 0026),
-- so both values are staged through session GUCs where substitution does happen.
SELECT set_config('acs_cymru.studio_oauth_client_secret', :'studio_oauth_client_secret', false);
SELECT set_config('acs_cymru.studio_public_url',          :'studio_public_url',          false);

DO $$
DECLARE
  -- Pinned, not generated: supabase/envoy.yaml carries this as `client_id`, and a fresh UUID on
  -- every stack rebuild would silently break the integration. Same reasoning as the pinned Grafana
  -- and Node-RED client ids.
  v_client_id CONSTANT UUID := 'c0ffee00-0000-4000-8000-000000000003';
  v_secret    TEXT := current_setting('acs_cymru.studio_oauth_client_secret', true);
  -- The trailing slash is trimmed, for the reason 0002 records: a value copied from a browser
  -- address bar carries one, and `http://host//oauth2/callback` is not the string GoTrue compares
  -- against. It fails as `invalid redirect_uri` at the end of a login that looked fine.
  v_base      TEXT := rtrim(
                        COALESCE(
                          NULLIF(current_setting('acs_cymru.studio_public_url', true), ''),
                          'http://127.0.0.1:54323'),
                        '/');
  v_hash      TEXT;
BEGIN
  IF v_secret IS NULL OR v_secret = '' THEN
    RAISE WARNING 'studio oauth client secret not supplied; skipping client registration. '
                  'Studio will answer a login it cannot complete. '
                  'Set STUDIO_OAUTH_CLIENT_SECRET in .env and re-run.';
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
    'ACS-Cymru Supabase Studio',
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
  -- STUDIO_OAUTH_CLIENT_SECRET or a changed STUDIO_PUBLIC_URL has to take effect on the next boot.
END $$;

SELECT set_config('acs_cymru.studio_oauth_client_secret', '', false);
