-- =============================================================================================
-- 0003_nodered_oidc_auth.sql
--
-- Closes the unauthenticated Node-RED admin API and webhook receiver on port 1880.
--
-- BEFORE THIS, scripts/node-red-init.mjs wrote a settings.js declaring only `flowFile` and
-- `credentialSecret`. With no adminAuth, the editor and the /flows admin API were open to
-- anyone who could reach the port -- edge automation flows could be read or replaced, and
-- POST /hooks/quarantine accepted anything. Both the plumbing for the authenticated path
-- (deploy-nodered's bearer header, this file's outbound token) existed and both deliberately
-- fell back to unauthenticated because no credential was configured.
--
-- The application half lives in node-red/Dockerfile, scripts/node-red-init.mjs and
-- supabase/functions/nodered-userinfo. This file provides the two things only the database can:
--
--   1. The OAuth client Node-RED authenticates HUMANS with, in auth.oauth_clients. Mirrors the
--      Grafana client registered by 0002_seed_data.sql, and differs from it in one field --
--      see the token_endpoint_auth_method note below.
--   2. The signing key for the token the quarantine webhook carries, in Vault, plus the
--      dispatch function that now MINTS a short-lived token rather than replaying a static one.
--
-- SCOPE: this is an additive migration on top of the two-file baseline, per CLAUDE.md. It does
-- not edit 0001 or 0002; the one thing it must correct in 0002's seed is done as an explicit
-- UPDATE, because that row's ON CONFLICT is DO NOTHING and an edit there would never reach an
-- existing database.
--
-- IT IS IDEMPOTENT. supabase-db-init replays every /migrations/*.sql on every boot.
--
-- PSQL VARIABLES. `supabase-db-init` passes `-v nodered_oauth_client_secret`,
-- `-v nodered_webhook_jwt_secret` and `-v nodered_redirect_uri`. All are defaulted at the point
-- of use, so this file stays runnable standalone, and the two secrets are treated as
-- absent-is-normal rather than as an error -- though see the WARNINGs: absent means the
-- corresponding path stays shut, not open.
-- =============================================================================================

\if :{?nodered_oauth_client_secret} \else \set nodered_oauth_client_secret '' \endif
\if :{?nodered_webhook_jwt_secret}  \else \set nodered_webhook_jwt_secret  '' \endif
\if :{?nodered_redirect_uri}        \else \set nodered_redirect_uri        '' \endif

-- psql does NOT substitute :variables inside dollar-quoted strings, so neither secret can be
-- referenced directly from the DO blocks below -- it would be read as literal text. Stash them
-- in session GUCs out here, where substitution does happen, and read them back inside. Same
-- arrangement 0002_seed_data.sql uses for the Vault token and the Grafana secret.
SELECT set_config('factoryplus.nodered_oauth_client_secret', :'nodered_oauth_client_secret', false);
SELECT set_config('factoryplus.nodered_webhook_jwt_secret',  :'nodered_webhook_jwt_secret',  false);
SELECT set_config('factoryplus.nodered_redirect_uri',        :'nodered_redirect_uri',        false);


-- ---------------------------------------------------------------------------------------------
-- 1. Node-RED OAuth client registration
-- ---------------------------------------------------------------------------------------------
-- Node-RED is an OAuth client of GoTrue's OAuth 2.1 server, exactly as Grafana is.
-- `client_secret_hash` is base64url(sha256(secret)) unpadded -- NOT bcrypt.
--
-- token_endpoint_auth_method IS 'client_secret_post', NOT the Grafana client's
-- 'client_secret_basic', and the difference is deliberate. GoTrue enforces whichever is
-- registered, exactly:
--   400 invalid_credentials -- "invalid authentication method: client is registered for
--   'client_secret_basic' but 'client_secret_post' was used"
-- Grafana's Go oauth2 client auto-detects and must be pinned with auth_style = InHeader, so
-- Basic is the natural fit there. passport-oauth2 sends the credentials in the token request
-- body by default, and matching it avoids subclassing the strategy purely to move a header.
-- Both stay confidential clients over the compose-internal network; neither puts the secret in
-- a URL. Change this and settings.js has to change with it.
DO $$
DECLARE
  -- Pinned, not generated. settings.js carries this as NODERED_OAUTH_CLIENT_ID (defaulted in
  -- docker-compose.yml), and a fresh UUID on every stack rebuild would silently break the
  -- integration. Same reasoning as the Grafana client id and the pinned virtual gateway.
  -- Deliberately the next value after Grafana's ...0001.
  v_client_id CONSTANT UUID := 'c0ffee00-0000-4000-8000-000000000002';
  v_secret    TEXT := current_setting('factoryplus.nodered_oauth_client_secret', true);
  -- Derived from NODERED_PUBLIC_URL by docker-compose and passed in, so this row and the
  -- callbackURL settings.js hands passport-oauth2 are built from ONE value. They must agree
  -- exactly or /oauth/authorize answers "invalid redirect_uri" -- verified against a live
  -- GoTrue. /auth/strategy/callback is Node-RED's own fixed route (@node-red/editor-api
  -- lib/auth/index.js); only the origin is deployment-specific, and it is the address the
  -- BROWSER reaches Node-RED on, never the compose-internal one.
  v_redirect  TEXT := COALESCE(
                        NULLIF(current_setting('factoryplus.nodered_redirect_uri', true), ''),
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
    'Factory+ Node-RED',
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

SELECT set_config('factoryplus.nodered_oauth_client_secret', '', false);


-- ---------------------------------------------------------------------------------------------
-- 2. Vault: the quarantine webhook SIGNING KEY
-- ---------------------------------------------------------------------------------------------
-- A SIGNING KEY, NOT A BEARER CREDENTIAL, and that distinction is the whole point.
--
-- The obvious design -- one `nodered_admin_token` serving both the admin API and the webhook --
-- is unsafe here for a reason specific to Node-RED: POST /hooks/quarantine is served by an
-- `http in` node, and any flow author can read msg.req.headers. Sharing the admin credential
-- with the webhook therefore hands every flow in the instance full admin API access, which is
-- remote code execution on the edge host by way of a `function` node.
--
-- So the webhook gets its own key, Node-RED holds the same key to VERIFY, and what a flow can
-- read out of a request header is a token that expires in 60 seconds and authorises nothing but
-- posting another quarantine notice.
--
-- HS256 (symmetric) because pgjwt implements only the HS family. The consequence -- Node-RED
-- can mint tokens it would itself accept -- is bounded by that same scope, and is the trade for
-- not adding an asymmetric signing dependency to a fire-and-forget notification path.
--
-- `nodered_admin_token` (0002_seed_data.sql) is deliberately left in place and untouched. It is
-- now break-glass only: settings.js accepts it on the admin API when set, for when Supabase
-- Auth is down and the flows still have to be reachable.
DO $$
DECLARE
  v_secret TEXT := current_setting('factoryplus.nodered_webhook_jwt_secret', true);
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
      'event. NOT a bearer credential and NOT the Node-RED admin token -- see migration 0003.'
    );
  ELSE
    -- update_secret rather than create: supabase-db-init replays every migration on every stack
    -- start, and create_secret would fail the UNIQUE on name the second time.
    PERFORM vault.update_secret(v_id, v_secret);
  END IF;
END $$;

SELECT set_config('factoryplus.nodered_webhook_jwt_secret', '', false);


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
