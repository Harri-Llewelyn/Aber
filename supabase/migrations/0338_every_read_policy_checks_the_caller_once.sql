-- 0338: Every read policy checks the caller once.
--
-- Nine read policies (0001) called has_role() bare, so the planner ran it for each row they read:
-- the capture, playback, rebirth, backup and export jobs, the playback worker's status, the revoked
-- principals and tokens, and the webhook endpoints. entity_directory reads the revoked principals on
-- every search.
--
-- Each is stated here with its call in a sub-select, which runs once for a statement, as 0177, 0204 and
-- 0330 stated theirs. Each answer is the same. 0001 still declares the per-row form and creates it only
-- where the policy is missing (STATED_LATER).
--
-- Reasoning: supabase/README.md, "Every read policy checks the caller once (0338)".
-- Idempotent.

-- In pg_dump's form, one statement per line and one table per transaction, as 0177.
BEGIN;
SELECT public.replay_policy('public.asset_exports', 'asset_exports_select_privileged', $ddl$
CREATE POLICY asset_exports_select_privileged ON public.asset_exports FOR SELECT TO authenticated USING (( SELECT public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text, 'Auditor'::text]) AS has_role));
$ddl$);
COMMIT;

BEGIN;
SELECT public.replay_policy('public.backup_jobs', 'backup_jobs_select_administrator', $ddl$
CREATE POLICY backup_jobs_select_administrator ON public.backup_jobs FOR SELECT TO authenticated USING (( SELECT public.has_role(ARRAY['Administrator'::text]) AS has_role));
$ddl$);
COMMIT;

BEGIN;
SELECT public.replay_policy('public.capture_jobs', 'capture_jobs_select_privileged', $ddl$
CREATE POLICY capture_jobs_select_privileged ON public.capture_jobs FOR SELECT TO authenticated USING (( SELECT public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text, 'Auditor'::text]) AS has_role));
$ddl$);
COMMIT;

BEGIN;
SELECT public.replay_policy('public.playback_jobs', 'playback_jobs_select_privileged', $ddl$
CREATE POLICY playback_jobs_select_privileged ON public.playback_jobs FOR SELECT TO authenticated USING (( SELECT public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text, 'Auditor'::text]) AS has_role));
$ddl$);
COMMIT;

BEGIN;
SELECT public.replay_policy('public.playback_worker_status', 'playback_worker_status_select_privileged', $ddl$
CREATE POLICY playback_worker_status_select_privileged ON public.playback_worker_status FOR SELECT TO authenticated USING (( SELECT public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text, 'Auditor'::text]) AS has_role));
$ddl$);
COMMIT;

BEGIN;
SELECT public.replay_policy('public.rebirth_requests', 'rebirth_requests_select_privileged', $ddl$
CREATE POLICY rebirth_requests_select_privileged ON public.rebirth_requests FOR SELECT TO authenticated USING (( SELECT public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text, 'Auditor'::text]) AS has_role));
$ddl$);
COMMIT;

BEGIN;
SELECT public.replay_policy('public.revoked_service_principals', 'revoked_service_principals_select_privileged', $ddl$
CREATE POLICY revoked_service_principals_select_privileged ON public.revoked_service_principals FOR SELECT TO authenticated USING (( SELECT public.has_role(ARRAY['Administrator'::text, 'Auditor'::text]) AS has_role));
$ddl$);
COMMIT;

BEGIN;
SELECT public.replay_policy('public.revoked_service_tokens', 'revoked_service_tokens_select_privileged', $ddl$
CREATE POLICY revoked_service_tokens_select_privileged ON public.revoked_service_tokens FOR SELECT TO authenticated USING (( SELECT public.has_role(ARRAY['Administrator'::text, 'Auditor'::text]) AS has_role));
$ddl$);
COMMIT;

BEGIN;
SELECT public.replay_policy('public.webhook_endpoints', 'webhook_endpoints_select_privileged', $ddl$
CREATE POLICY webhook_endpoints_select_privileged ON public.webhook_endpoints FOR SELECT TO authenticated USING (( SELECT public.has_role(ARRAY['Administrator'::text]) AS has_role));
$ddl$);
COMMIT;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_policy text;
  v_said   text;
BEGIN
  -- A call that is not in a sub-select runs for each row.
  FOREACH v_policy IN ARRAY ARRAY['asset_exports asset_exports_select_privileged',
                                  'backup_jobs backup_jobs_select_administrator',
                                  'capture_jobs capture_jobs_select_privileged',
                                  'playback_jobs playback_jobs_select_privileged',
                                  'playback_worker_status playback_worker_status_select_privileged',
                                  'rebirth_requests rebirth_requests_select_privileged',
                                  'revoked_service_principals revoked_service_principals_select_privileged',
                                  'revoked_service_tokens revoked_service_tokens_select_privileged',
                                  'webhook_endpoints webhook_endpoints_select_privileged'] LOOP
    v_said := coalesce(public.live_policy_statement(('public.' || split_part(v_policy, ' ', 1))::regclass,
                                                    split_part(v_policy, ' ', 2)::name), '');
    IF position('( SELECT public.has_' IN v_said) = 0 OR v_said ~ '(?<!SELECT )public\.has_' THEN
      RAISE EXCEPTION '0338: % does not ask once for the statement: %', v_policy, coalesce(nullif(v_said, ''), 'missing');
    END IF;
  END LOOP;
END
$check$;
