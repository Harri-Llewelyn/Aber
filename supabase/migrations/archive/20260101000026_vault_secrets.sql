-- Migration: 20260101000026_vault_secrets.sql
-- Description: Move the one secret that has to be readable from SQL into Supabase Vault.
--
-- SCOPE -- read this before adding anything here.
--
-- Vault is for secrets consumed FROM INSIDE THE DATABASE. The Node-RED admin token qualifies
-- because dispatch_device_quarantine_webhook() (migration 0027) has to attach it to an
-- outbound pg_net request, and the only alternatives are a literal in a migration (i.e. in
-- git) or a GUC.
--
-- MQTT_PASSWORD, DB_PASSWORD and POSTGRES_PASSWORD deliberately stay in .env. mosquitto-init
-- needs the first to build its password file and supabase-db needs the last to start -- both
-- before this database is accepting connections at all. Vault cannot bootstrap the
-- infrastructure it lives inside, and putting them here as well would mean two sources of
-- truth for the same credential, which is worse than one.
--
-- THREAT MODEL. Vault encrypts at rest with a key derived from the database. This defeats
-- casual .env leakage, accidental commits and secrets in migration files. It is NOT an HSM:
-- anyone with the Postgres data directory and the server can recover the plaintext.

CREATE EXTENSION IF NOT EXISTS supabase_vault WITH SCHEMA vault;

-- Supplied by supabase-db-init via `psql -v`, the same mechanism migration 0010 uses for the
-- TimescaleDB FDW credentials. Defaulted so this file stays runnable standalone.
\if :{?nodered_admin_token}
\else
\set nodered_admin_token ''
\endif

-- psql does NOT substitute :variables inside dollar-quoted strings, so the token cannot be
-- referenced directly from the DO block below -- it would be read as literal text and fail to
-- parse. Migration 0010 gets away with :'ts_host' because those appear in plain SQL.
-- Stash it in a session GUC out here, where substitution does happen, and read it back inside.
-- Session-local (is_local = false but never committed to a role), so it does not persist.
SELECT set_config('factoryplus.nodered_admin_token', :'nodered_admin_token', false);

DO $$
DECLARE
  v_token TEXT := current_setting('factoryplus.nodered_admin_token', true);
  v_id    UUID;
BEGIN
  -- An absent token is the default stack's normal state: Node-RED runs without adminAuth, so
  -- there is nothing to authenticate with. Seeding an empty secret would be indistinguishable
  -- from a real one at dispatch time, so record nothing and let the webhook go unauthenticated.
  IF v_token IS NULL OR v_token = '' THEN
    RAISE NOTICE 'vault: nodered_admin_token not supplied; leaving it unset';
    RETURN;
  END IF;

  SELECT id INTO v_id FROM vault.secrets WHERE name = 'nodered_admin_token';

  IF v_id IS NULL THEN
    PERFORM vault.create_secret(
      v_token,
      'nodered_admin_token',
      'Bearer token for the Node-RED admin API. Read by '
      'public.dispatch_device_quarantine_webhook() (migration 0027).'
    );
  ELSE
    -- update_secret rather than create: supabase-db-init replays every migration on every
    -- stack start, and create_secret would fail the UNIQUE on name the second time.
    PERFORM vault.update_secret(v_id, v_token);
  END IF;
END $$;

-- vault.decrypted_secrets is a view that decrypts on read. It must never become reachable
-- through PostgREST -- `vault` is not in PGRST_DB_SCHEMAS today, but these REVOKEs mean that
-- adding it later still would not expose plaintext to a logged-in user.
REVOKE ALL ON vault.decrypted_secrets FROM anon, authenticated;
REVOKE ALL ON vault.secrets           FROM anon, authenticated;

-- Do not leave the plaintext sitting in the session's settings after the migration.
SELECT set_config('factoryplus.nodered_admin_token', '', false);
