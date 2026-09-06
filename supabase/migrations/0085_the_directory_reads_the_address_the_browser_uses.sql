-- 0085: three Directory rows stop being literals and start being derived.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- =================================================================================================
-- WHAT WAS WRONG
--
-- `directory_services.endpoint_url` is a hardcoded string. 0002 seeds `http://localhost:1880` for
-- Node-RED, `http://localhost:3002` for Grafana and `http://127.0.0.1:54323` for Studio, and nothing
-- has ever moved them. Meanwhile the deployment states its own browser-facing addresses in
-- variables whose entire job is to hold them -- NODERED_PUBLIC_URL, GRAFANA_PUBLIC_URL,
-- STUDIO_PUBLIC_URL -- and those are NOT cosmetic: they build the `redirect_uris` this file's
-- neighbours register in `auth.oauth_clients`, Grafana's own GF_SERVER_ROOT_URL, and the
-- `callbackURL` settings.js hands passport-oauth2.
--
-- So a stack that set them correctly had every login working at a real hostname and one page still
-- advertising `localhost`. On Kubernetes it is worse and quieter: the chart derives
-- `grafana.<publicBaseDomain>` and serves it through an Ingress, `templates/jobs/db-init.yaml`
-- passes that value in like Compose does, and the Directory kept showing an address that resolves
-- to the reader's own machine.
--
-- THE FRONTEND ALREADY GOT THIS RIGHT and the contrast is the argument. `constants.js` reads
-- `VITE_GRAFANA_URL` for every Grafana link the dashboard renders, so on a configured stack those
-- follow the deployment and the Directory row beside them does not.
--
-- =================================================================================================
-- WHY THIS IS THE SAME MECHANISM RATHER THAN A NEW ONE
--
-- Nothing is added to db-init. Both call sites -- docker-compose.yml's migration loop and
-- templates/jobs/db-init.yaml -- ALREADY pass `grafana_public_url`, `studio_public_url` and
-- `nodered_redirect_uri` to psql, once per file, because 0002 needs them to register the OAuth
-- clients. This migration reads the same three values and derives from them, which is the whole
-- point: the row and the redirect_uri cannot disagree if they are computed from one input.
--
-- THREE ROWS, NOT FIFTEEN, and the limit is what db-init passes rather than a judgement about which
-- rows deserve it. Swagger, Mosquitto and the four Supabase gateway rows have no `-v` entry at
-- either call site; giving them one means editing both files, which is a larger and separately
-- reviewable change. Doing three now beats doing none while that is argued.
--
-- =================================================================================================
-- THESE THREE ROWS ARE NOW DERIVED, WHICH MEANS THEY ARE NO LONGER EDITABLE, AND THAT IS THE POINT
--
-- `directory_services` carries UPDATE RLS for Administrator and Shopfloor_Manager, so an operator
-- CAN edit an endpoint by hand -- and for these three, a replay now stamps over that edit on the
-- next boot. That is deliberate and it is the same treatment 0002 gives the OAuth rows, whose
-- comment states the reasoning: DO UPDATE rather than DO NOTHING, "so a rotated
-- NODERED_OAUTH_CLIENT_SECRET in .env has to take effect on the next boot".
--
-- An independently editable copy of a value the deployment already holds is exactly the drift this
-- migration exists to close. The place to change one of these addresses is the variable, where the
-- login flow will follow it.
--
-- A ROW IS LEFT ENTIRELY ALONE WHEN ITS VARIABLE IS ABSENT. `\if :{?var}` defaults an unpassed
-- variable to the empty string, and empty means "this deployment said nothing" rather than "this
-- deployment wants the fallback". Stamping a fallback over an operator's edit on the strength of a
-- variable nobody set would be the worst of both behaviours. On Compose the variables always arrive
-- with a value because docker-compose.yml gives each one a `:-` default, so in practice this branch
-- protects a hand-run psql and a chart with the URLs unset.
--
-- WHAT THIS DOES NOT DO. It does not give Compose port-free URLs -- that needs the reverse proxy in
-- roadmap 11, which is sequenced AFTER this for the reason recorded there: a proxy serving
-- `nodered.<domain>` while this table advertised `localhost:1880` would have moved the problem
-- rather than fixed it. On Kubernetes there is no such gap; the chart's hostnames are already
-- port-free and this migration is what surfaces them.
-- =================================================================================================

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

  -- The Node-RED value arrives as the CALLBACK rather than the origin, because docker-compose
  -- builds `${NODERED_PUBLIC_URL}/auth/strategy/callback` and passes that -- 0002's client
  -- registration wants the whole thing. Only the fixed suffix is removed, and only the fixed
  -- suffix: `/auth/strategy/callback` is Node-RED's own route (@node-red/editor-api
  -- lib/auth/index.js), so stripping exactly it recovers NODERED_PUBLIC_URL and nothing else.
  --
  -- NOT a general "strip the path". Grafana and Studio are passed origins already, and a
  -- deployment MAY legitimately put either behind a subpath -- GF_SERVER_ROOT_URL supports one --
  -- so guessing at path removal there would break the case it was meant to help.
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
