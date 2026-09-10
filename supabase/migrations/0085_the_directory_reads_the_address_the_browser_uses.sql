-- 0085: three Directory rows stop being literals and start being derived.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- 0002 seeds `localhost` endpoints for Node-RED, Grafana and Studio, while the deployment states
-- its browser-facing addresses in NODERED_PUBLIC_URL, GRAFANA_PUBLIC_URL and STUDIO_PUBLIC_URL,
-- which build the OAuth `redirect_uris`, GF_SERVER_ROOT_URL and the passport callback. Both
-- db-init call sites (docker-compose.yml and templates/jobs/db-init.yaml) already pass
-- `grafana_public_url`, `studio_public_url` and `nodered_redirect_uri` to psql for 0002, so this
-- derives the three rows from the same values: the row and the redirect_uri cannot disagree.
-- Three rows, not fifteen, because those are the three db-init passes.
--
-- These rows are therefore no longer editable: a replay stamps over a hand edit on the next
-- boot, and the place to change an address is the variable. A row is left alone when its
-- variable is absent: `\if :{?var}` defaults an unpassed variable to empty, and empty means
-- "this deployment said nothing". On Compose every variable arrives with a `:-` default.
--
-- This does not give Compose port-free URLs; that needs the reverse proxy (docs/roadmap.md,
-- "The transport between services").

\if :{?grafana_public_url}
\else
\set grafana_public_url ''
\endif
\if :{?studio_public_url}
\else
\set studio_public_url ''
\endif
\if :{?nodered_redirect_uri}
\else
\set nodered_redirect_uri ''
\endif

-- psql does not substitute :variables inside dollar-quoted blocks (archived migration 0026), so
-- all three are staged through session GUCs where substitution does happen. Same staging 0002 uses
-- for these same values a few thousand lines earlier.
SELECT set_config('acs_cymru.dir_grafana_public_url', :'grafana_public_url', false);
SELECT set_config('acs_cymru.dir_studio_public_url',  :'studio_public_url',  false);
SELECT set_config('acs_cymru.dir_nodered_redirect',   :'nodered_redirect_uri', false);

DO $$
DECLARE
  v_grafana TEXT := NULLIF(current_setting('acs_cymru.dir_grafana_public_url', true), '');
  v_studio  TEXT := NULLIF(current_setting('acs_cymru.dir_studio_public_url',  true), '');
  v_nodered TEXT := NULLIF(current_setting('acs_cymru.dir_nodered_redirect',   true), '');
  v_moved   INT  := 0;

  -- The Node-RED value arrives as the callback (docker-compose builds
  -- `${NODERED_PUBLIC_URL}/auth/strategy/callback` for 0002's client registration), so exactly
  -- that fixed suffix is stripped. Not a general "strip the path": Grafana and Studio are passed
  -- origins, and a deployment may legitimately put either behind a subpath.
  v_nodered_origin TEXT := rtrim(
                             regexp_replace(COALESCE(v_nodered, ''), '/auth/strategy/callback/?$', ''),
                             '/');
BEGIN
  -- The trailing slash is trimmed for the same reason 0002 trims it on the OAuth rows: a value
  -- copied out of a browser address bar carries one, and `http://host/` in this column renders as a
  -- link with a stray character rather than failing in a way anyone would notice.

  IF v_grafana IS NOT NULL THEN
    UPDATE public.directory_services
       SET endpoint_url = rtrim(v_grafana, '/')
     WHERE id = 'f1111111-0000-0000-0000-000000000006'::uuid
       AND endpoint_url IS DISTINCT FROM rtrim(v_grafana, '/');
    GET DIAGNOSTICS v_moved = ROW_COUNT;
    IF v_moved > 0 THEN
      RAISE NOTICE 'directory: Grafana now advertised at %, from GRAFANA_PUBLIC_URL', rtrim(v_grafana, '/');
    END IF;
  END IF;

  IF v_studio IS NOT NULL THEN
    UPDATE public.directory_services
       SET endpoint_url = rtrim(v_studio, '/')
     WHERE id = 'f1111111-0000-0000-0000-000000000001'::uuid
       AND endpoint_url IS DISTINCT FROM rtrim(v_studio, '/');
    GET DIAGNOSTICS v_moved = ROW_COUNT;
    IF v_moved > 0 THEN
      RAISE NOTICE 'directory: Studio now advertised at %, from STUDIO_PUBLIC_URL', rtrim(v_studio, '/');
    END IF;
  END IF;

  -- Guarded on the DERIVED origin, not on the raw setting: a redirect_uri that is somehow only the
  -- suffix would strip to the empty string, and writing that into a NOT NULL display column would
  -- put a blank cell on the page where an address belongs.
  IF v_nodered_origin <> '' THEN
    UPDATE public.directory_services
       SET endpoint_url = v_nodered_origin
     WHERE id = 'f1111111-0000-0000-0000-000000000003'::uuid
       AND endpoint_url IS DISTINCT FROM v_nodered_origin;
    GET DIAGNOSTICS v_moved = ROW_COUNT;
    IF v_moved > 0 THEN
      RAISE NOTICE 'directory: Node-RED now advertised at %, from NODERED_PUBLIC_URL', v_nodered_origin;
    END IF;
  END IF;
END $$;

-- Cleared for the same reason 0002 clears its own staged values: a session GUC set with
-- is_local => false outlives the statement, and db-init's connection is reused across files.
SELECT set_config('acs_cymru.dir_grafana_public_url', '', false);
SELECT set_config('acs_cymru.dir_studio_public_url',  '', false);
SELECT set_config('acs_cymru.dir_nodered_redirect',   '', false);
