-- 0197: Only the platform's own OAuth clients remain.
--
-- GoTrue no longer accepts dynamic client registration (the chart sets
-- GOTRUE_OAUTH_SERVER_ALLOW_DYNAMIC_REGISTRATION to "false"), and every client the stack uses is
-- seeded 'manual' by 0002. A client registered dynamically while it was on is deleted here. Its
-- authorizations, consents and sessions go with it (each foreign key to auth.oauth_clients cascades,
-- and a session's refresh tokens cascade from the session), so nothing it was issued can be
-- refreshed. An access token it already holds lasts until it expires (supabaseAuth.jwtExpiry).
--
-- Reasoning: supabase/README.md, "Only the platform's own OAuth clients remain (0197)". Idempotent:
-- with registration off, a later boot finds nothing to delete.

DO $$
DECLARE
  v_names text;
  v_count integer;
BEGIN
  -- GoTrue creates its OAuth tables; the test database's GoTrue-shaped fixture has none.
  IF to_regclass('auth.oauth_clients') IS NULL THEN
    RETURN;
  END IF;

  WITH gone AS (
    DELETE FROM auth.oauth_clients
     WHERE registration_type = 'dynamic'
     RETURNING id, client_name
  )
  SELECT count(*), string_agg(format('%s (%s)', coalesce(client_name, 'unnamed'), id), ', ')
    INTO v_count, v_names
    FROM gone;

  IF v_count > 0 THEN
    RAISE NOTICE '0197: deleted % dynamically registered OAuth client(s), with their authorizations, consents and sessions: %',
      v_count, v_names;
  END IF;
END
$$;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
BEGIN
  IF to_regclass('auth.oauth_clients') IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM auth.oauth_clients WHERE registration_type = 'dynamic') THEN
    RAISE EXCEPTION '0197: a dynamically registered OAuth client remains';
  END IF;
END
$check$;
