-- =============================================================================================
-- 0006_nodered_oidc_auth.sql
--
-- Closes the unauthenticated Node-RED admin API and webhook receiver on port 1880.
--
-- The application half lives in node-red/Dockerfile, scripts/node-red-init.mjs and
-- supabase/functions/nodered-userinfo. This file provides the two things only the database can:
--
--   1. The OAuth client Node-RED authenticates HUMANS with, in auth.oauth_clients.
--   2. The signing key for the quarantine webhook's token, in Vault, plus a dispatch function
--      that MINTS a short-lived token per event rather than replaying a static one.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot. It is additive -- it does
-- not edit 0001 or 0002; the one correction it must make to 0002's seed is an explicit UPDATE,
-- because that row's ON CONFLICT is DO NOTHING and an edit there would never reach an existing
-- database.
--
-- PSQL VARIABLES: `-v nodered_oauth_client_secret`, `-v nodered_webhook_jwt_secret`,
-- `-v nodered_redirect_uri`, all defaulted at the point of use so this file stays runnable
-- standalone. An absent secret leaves the corresponding path SHUT, not open -- see the WARNINGs.
--
-- What was open before this, and why the webhook token is a capability rather than a credential:
--   simulators/README.md -> "Node-RED authentication"
-- =============================================================================================

\if :{?nodered_oauth_client_secret} \else \set nodered_oauth_client_secret '' \endif
\if :{?nodered_webhook_jwt_secret}  \else \set nodered_webhook_jwt_secret  '' \endif
\if :{?nodered_redirect_uri}        \else \set nodered_redirect_uri        '' \endif

-- psql does NOT substitute :variables inside dollar-quoted strings, so neither secret can be
-- referenced directly from the DO blocks below -- it would be read as literal text. Stash them
-- in session GUCs out here, where substitution does happen, and read them back inside. Same
-- arrangement 0002_seed_data.sql uses for the Vault token and the Grafana secret.
SELECT set_config('acs_cymru.nodered_oauth_client_secret', :'nodered_oauth_client_secret', false);
SELECT set_config('acs_cymru.nodered_webhook_jwt_secret',  :'nodered_webhook_jwt_secret',  false);
SELECT set_config('acs_cymru.nodered_redirect_uri',        :'nodered_redirect_uri',        false);


-- ---------------------------------------------------------------------------------------------
-- 1. Node-RED OAuth client registration
-- ---------------------------------------------------------------------------------------------
-- `client_secret_hash` is base64url(sha256(secret)) unpadded -- NOT bcrypt.
--
-- token_endpoint_auth_method IS 'client_secret_post', NOT the Grafana client's
-- 'client_secret_basic'. passport-oauth2 sends credentials in the token request body by default;
-- GoTrue enforces whichever is registered, exactly, and a mismatch is:
--   400 invalid_credentials -- "invalid authentication method: client is registered for
--   'client_secret_basic' but 'client_secret_post' was used"
-- Change this and settings.js has to change with it.
DO $$
DECLARE
  -- Pinned, not generated. settings.js carries this as NODERED_OAUTH_CLIENT_ID (defaulted in
  -- docker-compose.yml), and a fresh UUID on every stack rebuild would silently break the
  -- integration. Same reasoning as the Grafana client id and the pinned virtual gateway.
  -- Deliberately the next value after Grafana's ...0001.
  v_client_id CONSTANT UUID := 'c0ffee00-0000-4000-8000-000000000002';
  v_secret    TEXT := current_setting('acs_cymru.nodered_oauth_client_secret', true);
  -- Derived from NODERED_PUBLIC_URL by docker-compose and passed in, so this row and the
  -- callbackURL settings.js hands passport-oauth2 are built from ONE value. They must agree
  -- exactly or /oauth/authorize answers "invalid redirect_uri" -- verified against a live
  -- GoTrue. /auth/strategy/callback is Node-RED's own fixed route (@node-red/editor-api
  -- lib/auth/index.js); only the origin is deployment-specific, and it is the address the
  -- BROWSER reaches Node-RED on, never the compose-internal one.
  v_redirect  TEXT := COALESCE(
                        NULLIF(current_setting('acs_cymru.nodered_redirect_uri', true), ''),
                        'http://localhost:1880/auth/strategy/callback');
  v_hash      TEXT;
BEGIN
  IF v_secret IS NULL OR v_secret = '' THEN
    RAISE WARNING 'nodered oauth client secret not supplied; skipping client registration. '
                  'Set NODERED_OAUTH_CLIENT_SECRET in .env and re-run. Node-RED will refuse to '
                  'start rather than come up unauthenticated.';
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
    v_redirect,
    'authorization_code,refresh_token',
    'ACS-Cymru Node-RED',
    'http://localhost:1880',
    'confidential',
    'client_secret_post'
  )
  -- DO UPDATE, not DO NOTHING: supabase-db-init replays every migration on every stack start,
  -- so a rotated NODERED_OAUTH_CLIENT_SECRET in .env has to take effect on the next boot.
  ON CONFLICT (id) DO UPDATE SET
    client_secret_hash         = EXCLUDED.client_secret_hash,
    redirect_uris              = EXCLUDED.redirect_uris,
    grant_types                = EXCLUDED.grant_types,
    client_name                = EXCLUDED.client_name,
    client_uri                 = EXCLUDED.client_uri,
    token_endpoint_auth_method = EXCLUDED.token_endpoint_auth_method,
    deleted_at                 = NULL,
    updated_at                 = NOW();
END $$;

SELECT set_config('acs_cymru.nodered_oauth_client_secret', '', false);


-- ---------------------------------------------------------------------------------------------
-- 2. Vault: the quarantine webhook SIGNING KEY
-- ---------------------------------------------------------------------------------------------
-- A SIGNING KEY, NOT A BEARER CREDENTIAL. A flow author can read msg.req.headers, so sharing the
-- admin token with the webhook would hand every flow the admin API -- remote code execution on
-- the edge host by way of a `function` node. HS256 because pgjwt implements only the HS family.
--
-- Why the two must not be merged back, and why nodered_admin_token survives as break-glass:
--   simulators/README.md -> "Node-RED authentication"
DO $$
DECLARE
  v_secret TEXT := current_setting('acs_cymru.nodered_webhook_jwt_secret', true);
  v_id     UUID;
BEGIN
  IF v_secret IS NULL OR v_secret = '' THEN
    -- Unlike the pre-authentication default, an absent key here is NOT normal and does not fail
    -- open: dispatch below sends no Authorization header, and Node-RED's httpNodeAuth answers
    -- 401. The webhook stops working, visibly, rather than the endpoint staying open.
    RAISE WARNING 'vault: nodered_webhook_jwt_secret not supplied; the quarantine webhook will '
                  'be rejected by Node-RED (401). Set NODERED_WEBHOOK_JWT_SECRET in .env.';
    RETURN;
  END IF;

  SELECT id INTO v_id FROM vault.secrets WHERE name = 'nodered_webhook_jwt_secret';

  IF v_id IS NULL THEN
    PERFORM vault.create_secret(
      v_secret,
      'nodered_webhook_jwt_secret',
      'HS256 signing key for the Node-RED quarantine webhook. Read by '
      'public.dispatch_device_quarantine_webhook(), which mints a fresh 60-second token per '
      'event. NOT a bearer credential and NOT the Node-RED admin token -- see migration 0006.'
    );
  ELSE
    -- update_secret rather than create: supabase-db-init replays every migration on every stack
    -- start, and create_secret would fail the UNIQUE on name the second time.
    --
    -- WRAPPED, because update_secret DECRYPTS the existing row before replacing it, and that read
    -- fails outright if the pgsodium root key no longer matches the stored ciphertext:
    --
    --   ERROR: pgsodium_crypto_aead_det_decrypt_by_id: invalid ciphertext
    --
    -- which aborts psql under ON_ERROR_STOP and takes supabase-db-init down with exit 3. The key
    -- lives at /etc/postgresql-custom/pgsodium_root.key -- OUTSIDE PGDATA -- so before that
    -- directory was given its own volume, any `docker compose down && up` regenerated it and
    -- orphaned every ciphertext in the retained data volume.
    --
    -- RECREATING IS SAFE HERE, and that is a property of this secret rather than a general rule:
    -- the plaintext is supplied by .env on every boot, so the vault row is a cache and never the
    -- source of truth. A secret that could only be read back from the vault would need the key
    -- restored instead, and losing it would be data loss.
    BEGIN
      PERFORM vault.update_secret(v_id, v_secret);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'vault: nodered_webhook_jwt_secret could not be updated in place (%). '
                    'Recreating it from the environment -- this is expected if the pgsodium root '
                    'key was regenerated.', SQLERRM;
      DELETE FROM vault.secrets WHERE id = v_id;
      PERFORM vault.create_secret(
        v_secret,
        'nodered_webhook_jwt_secret',
        'HS256 signing key for the Node-RED quarantine webhook. Read by '
        'public.dispatch_device_quarantine_webhook(), which mints a fresh 60-second token per '
        'event. NOT a bearer credential and NOT the Node-RED admin token -- see migration 0006.'
      );
    END;
  END IF;
END $$;

SELECT set_config('acs_cymru.nodered_webhook_jwt_secret', '', false);


-- ---------------------------------------------------------------------------------------------
-- 3. Repoint the webhook endpoint at the new secret
-- ---------------------------------------------------------------------------------------------
-- AN EXPLICIT UPDATE, NOT AN EDIT TO 0002. That row is seeded
-- `ON CONFLICT (event_key, url) DO NOTHING`, so changing secret_name there would only ever
-- reach a database created after the change -- every existing stack would keep pointing at
-- `nodered_admin_token` and keep sending the admin credential to a flow that can read it.
--
-- Guarded on the old value so an operator who has deliberately repointed this row is not
-- overwritten on the next boot.
UPDATE public.webhook_endpoints
   SET secret_name = 'nodered_webhook_jwt_secret'
 WHERE event_key = 'device.quarantined'
   AND secret_name = 'nodered_admin_token';


-- ---------------------------------------------------------------------------------------------
-- 4. dispatch_device_quarantine_webhook(): mint a scoped token instead of replaying a static one
-- ---------------------------------------------------------------------------------------------
-- Unchanged from 0001 except for how the Authorization header is built. Still a transition
-- trigger split across INSERT and UPDATE (0001 owns the triggers), still fire-and-forget: pg_net
-- has no retries, no ordering and no dead-letter queue. Advisory notification only -- if
-- delivery must be guaranteed, publish over MQTT from the ingestion daemon instead.
CREATE OR REPLACE FUNCTION public.dispatch_device_quarantine_webhook() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'vault'
    AS $$
DECLARE
  ep          RECORD;
  hdrs        JSONB;
  signing_key TEXT;
  issued_at   INT;
BEGIN
  FOR ep IN
    SELECT * FROM public.webhook_endpoints
    WHERE event_key = 'device.quarantined' AND is_enabled
  LOOP
    hdrs := jsonb_build_object('Content-Type', 'application/json');

    IF ep.secret_name IS NOT NULL THEN
      SELECT decrypted_secret INTO signing_key
      FROM vault.decrypted_secrets
      WHERE name = ep.secret_name;

      -- Only attach credentials when there are any. A stack mid-upgrade, or one whose
      -- NODERED_WEBHOOK_JWT_SECRET is unset, stores nothing -- and sending a literal "Bearer "
      -- would be worse than sending nothing. Node-RED refuses either way; this keeps the
      -- failure legible in its log rather than as a malformed header.
      IF signing_key IS NOT NULL AND signing_key <> '' THEN
        issued_at := extract(epoch FROM NOW())::INT;

        -- A CAPABILITY, NOT AN IDENTITY. `aud` and `scope` are what settings.js checks, and
        -- they authorise exactly one thing: posting to the quarantine hook. The 60-second life
        -- is what makes it safe for a flow to be able to read it out of msg.req.headers.
        hdrs := hdrs || jsonb_build_object(
          'Authorization',
          'Bearer ' || extensions.sign(
            json_build_object(
              'iss',   'factoryplus-supabase',
              'aud',   'node-red-hooks',
              'sub',   'webhook:device.quarantined',
              'scope', 'hooks:quarantine',
              'iat',   issued_at,
              'exp',   issued_at + 60
            ),
            signing_key,
            'HS256'
          )
        );
      END IF;
    END IF;

    PERFORM net.http_post(
      url     := ep.url,
      headers := hdrs,
      body    := jsonb_build_object(
        'event',             'device.quarantined',
        'device_id',         NEW.id,
        -- The identifier an operator can actually match against MQTT and TimescaleDB.
        'sparkplug_id',      NEW.sparkplug_id,
        'name',              NEW.name,
        'gateway_id',        NEW.gateway_id,
        'reported_identity', NEW.reported_identity,
        'quarantine_reason', NEW.quarantine_reason,
        'identity_source',   NEW.identity_source,
        'occurred_at',       NOW()
      ),
      timeout_milliseconds := 3000
    );
  END LOOP;

  RETURN NULL;  -- AFTER trigger; return value is ignored
END $$;

-- CREATE OR REPLACE resets neither ownership nor ACLs, so 0001's REVOKE/GRANT set still stands.
-- Restated so a future reader does not have to go and check.
REVOKE ALL ON FUNCTION public.dispatch_device_quarantine_webhook() FROM PUBLIC;
GRANT ALL  ON FUNCTION public.dispatch_device_quarantine_webhook() TO anon, authenticated, service_role;


-- ---------------------------------------------------------------------------------------------
-- 5. Self-check
-- ---------------------------------------------------------------------------------------------
-- The failure this guards against is silent: if extensions.sign() is unavailable the dispatch
-- function still CREATEs (check_function_bodies is off for the baseline), and the first thing
-- that would notice is a quarantined device whose webhook quietly 401s hours later.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'extensions' AND p.proname = 'sign'
  ) THEN
    RAISE EXCEPTION 'pgjwt (extensions.sign) is not installed; '
                    'dispatch_device_quarantine_webhook() cannot sign the webhook token.';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
