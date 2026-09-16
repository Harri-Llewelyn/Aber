-- 0099: the forge is swept on a timer.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- =================================================================================================
-- WHAT THIS IS FOR
--
-- forge-membership places and removes people as they pass the forge's door (0094), so a login
-- whose role was revoked and who never returns keeps its team membership, usable over SSH if they
-- had added a key. A gateway repository from before the push webhook existed (0095) has no hook
-- until its gateway is re-enrolled. The forge-sweep edge function reconciles both: the same
-- placement over Gitea's own member lists, the same furnishing over the organisation's
-- repositories, and `main` protected on any repository somebody made there by hand. This file is
-- the timer: sweep_forge() asks for one pass through the gateway with pg_net, and pg_cron calls it
-- every fifteen minutes.
--
-- THE CALL IS HERE, NOT THE WORK. The database holds no forge credential and reaches Gitea through
-- nothing. It holds the sweep secret in Vault (0002 seeds `forge_sweep_secret` from
-- FORGE_SWEEP_SECRET) and presents it as `x-sweep-secret`, which is what authorises the function;
-- the anon key only passes the gateway's key check. An unset secret makes the sweep inert, and
-- 0002 says so at boot. Same shape as revoke_gateway_credential() (0038): asynchronous, so `true`
-- means "asked", never "swept".
-- =================================================================================================

CREATE OR REPLACE FUNCTION public.sweep_forge() RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_url    text;
  v_anon   text;
  v_secret text;
BEGIN
  SELECT decrypted_secret INTO v_url    FROM vault.decrypted_secrets WHERE name = 'supabase_functions_url';
  SELECT decrypted_secret INTO v_anon   FROM vault.decrypted_secrets WHERE name = 'supabase_anon_key';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'forge_sweep_secret';

  -- Nothing configured does nothing, rather than sending a bare "Bearer ": the call would answer
  -- 401 or 503 either way, and not making it keeps "not configured" legible as such.
  IF coalesce(v_url, '') = '' OR coalesce(v_anon, '') = '' OR coalesce(v_secret, '') = '' THEN
    RETURN false;
  END IF;

  -- A minute rather than pg_net's default: one pass is a request per team member and two per
  -- repository, and a worker whose caller hung up still finishes the pass.
  PERFORM net.http_post(
    url     := rtrim(v_url, '/') || '/forge-sweep',
    headers := jsonb_build_object(
                 'Content-Type',   'application/json',
                 'apikey',         v_anon,
                 'Authorization',  'Bearer ' || v_anon,
                 'x-sweep-secret', v_secret),
    body    := '{}'::jsonb,
    timeout_milliseconds := 60000
  );

  RETURN true;
END $$;

COMMENT ON FUNCTION public.sweep_forge() IS
    'Ask the forge-sweep edge function for one reconciliation of the forge against user_roles: team members whose role has gone are removed, admitted logins are placed, gateway repositories get their push webhook and branch protection back, an archived gateway''s repository is put into the forge''s archive and a restored one taken out (0114), and hand-made repositories get main protected. Returns false when the stack holds no sweep secret. ASYNCHRONOUS: net.http_post queues the request, so true means "asked", not "swept". Scheduled every fifteen minutes by pg_cron, and asked for by trg_gateways_forge_follows_archive as an archive lands.';

-- The schedule's and, for a test, service_role's. Not a user's: anyone who could call this could
-- make the platform walk the forge's API as often as they liked.
REVOKE EXECUTE ON FUNCTION public.sweep_forge() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_forge() TO service_role;

-- `ensure_cron_job` unschedules before scheduling (`cron.schedule` appends). Fifteen minutes, like
-- the credential-revocation sweep: membership at the door is immediate, and this is the backstop
-- for the person who does not come back.
SELECT public.ensure_cron_job(
  'sweep_forge',
  '*/15 * * * *',
  $job$SELECT public.sweep_forge()$job$
);

-- -------------------------------------------------------------------------------------------------
-- Self-check
-- -------------------------------------------------------------------------------------------------
-- Read-only, and about this file's own additions: exactly one schedule under this name, and the
-- Vault row 0002 seeds (its value may be empty, which 0002 has already said at boot).
DO $$
DECLARE
    v_problems text[] := ARRAY[]::text[];
BEGIN
    IF (SELECT count(*) FROM cron.job WHERE jobname = 'sweep_forge') <> 1 THEN
        v_problems := v_problems || 'sweep_forge is not scheduled exactly once';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'forge_sweep_secret') THEN
        v_problems := v_problems || 'forge_sweep_secret is not in Vault; 0002 seeds it';
    END IF;

    IF has_function_privilege('anon', 'public.sweep_forge()', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.sweep_forge()', 'EXECUTE') THEN
        v_problems := v_problems || 'sweep_forge() is callable by a user';
    END IF;

    IF array_length(v_problems, 1) > 0 THEN
        RAISE EXCEPTION '0099 self-check failed: %', array_to_string(v_problems, '; ');
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';
