-- Migration: 20260101000028_grafana_oauth_client.sql
-- Description: Register Grafana as an OAuth client of Supabase Auth's OIDC server, so Grafana
--              can use [auth.generic_oauth] instead of its own local accounts.
--
-- REQUIRES GOTRUE_OAUTH_SERVER_ENABLED=true on supabase-auth (docker-compose.yml). GoTrue
-- serves /.well-known/openid-configuration whether or not the server is enabled, so a 200
-- there is not evidence it works -- with the flag off every advertised endpoint 404s with
-- "OAuth server is disabled".
--
-- SECRET HASHING. auth.oauth_clients.client_secret_hash is base64url(sha256(secret)),
-- unpadded -- NOT bcrypt. Verified against a client minted by GoTrue's own
-- /oauth/clients/register endpoint: the hash it stored matched
--   rtrim(translate(encode(digest(secret,'sha256'),'base64'),'+/','-_'),'=')
-- exactly. If a future GoTrue changes the scheme this migration will seed a client whose
-- secret silently never validates, so the token-exchange test in the phase notes is the
-- guard: it fails with invalid_client rather than degrading quietly.

\if :{?grafana_oauth_client_secret}
\else
\set grafana_oauth_client_secret ''
\endif

-- psql does not substitute :variables inside dollar-quoted blocks (see migration 0026), so
-- the secret is staged through a session GUC where substitution does happen.
SELECT set_config('factoryplus.grafana_oauth_client_secret', :'grafana_oauth_client_secret', false);

DO $$
DECLARE
  -- Pinned, not generated: grafana.ini carries this as client_id, and a fresh UUID on every
  -- stack rebuild would silently break the integration. Same reasoning as the pinned gateway
  -- UUID in migration 0009.
  v_client_id CONSTANT UUID := 'c0ffee00-0000-4000-8000-000000000001';
  v_secret    TEXT := current_setting('factoryplus.grafana_oauth_client_secret', true);
  v_hash      TEXT;
BEGIN
  IF v_secret IS NULL OR v_secret = '' THEN
    RAISE WARNING 'grafana oauth client secret not supplied; skipping client registration. '
                  'Set GRAFANA_OAUTH_CLIENT_SECRET in .env and re-run.';
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
    'http://localhost:3002/login/generic_oauth',     -- Grafana's fixed generic_oauth callback
    'authorization_code,refresh_token',
    'Factory+ Grafana',
    'http://localhost:3002',
    'confidential',
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
  -- DO UPDATE, not DO NOTHING: supabase-db-init replays every migration on every stack start,
  -- so a rotated GRAFANA_OAUTH_CLIENT_SECRET in .env has to take effect on the next boot.
END $$;

SELECT set_config('factoryplus.grafana_oauth_client_secret', '', false);
