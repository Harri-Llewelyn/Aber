-- =============================================================================================
-- 0057: the playback worker says which gateways it can actually publish as
-- =============================================================================================
--
-- Playback is confined by three tiers (0056): the job gate refuses a target that is not
-- `is_simulated`, the worker holds broker credentials only for gateways issued as playback targets,
-- and the ACL confines each credential to its own edge node by `%u`.
--
-- THE MIDDLE TIER WAS INVISIBLE, AND THAT IS WHAT THIS FIXES. `gateway_has_broker_credential()`
-- answers "has the PLATFORM issued this gateway a credential" -- an audit row, or an enrolment
-- stamp. It cannot answer "was the WORKER given the password", because nothing in the database
-- knows what secrets a process holds. So the dialog showed a target as ready, the operator queued
-- a job, and the job failed:
--
--     playback failed: this worker holds no broker credential for gwy150000000000400080000,
--     so it cannot authenticate as that gateway. Add it to MQTT_PLAYBACK_CREDENTIALS.
--
-- That message is correct and it arrives too late to be useful. Minting a credential shows the
-- password once and an operator has to paste it into the worker's environment; between those two
-- acts the UI had no way to know the second had not happened.
--
-- SO THE WORKER REPORTS IT. It is the only thing that knows, so it says so on a heartbeat, and the
-- page reads what it said. Nothing infers, nothing is derived from a second source that could
-- disagree with the first.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT IS STORED IS A LIST OF GATEWAY IDS, AND NOTHING ELSE
--
-- `sparkplug_id` is a generated public identifier -- it is on the Gateways page, in every topic,
-- and is the MQTT username. Knowing that playback can publish as one of them discloses nothing a
-- reader of this schema could not already see. THE PASSWORDS ARE NOT HERE AND MUST NEVER BE: 0041
-- records why a credential in a readable table is a credential with no revocation story, and that
-- reasoning applies with more force to a table whose whole purpose is to be read by a page.
--
-- ---------------------------------------------------------------------------------------------
-- THE HEARTBEAT IS THE POINT OF THE TIMESTAMP
--
-- "The worker holds no credential for this gateway" and "the worker is not running" are different
-- problems with different fixes, and an empty list cannot tell them apart. `reported_at` is what
-- separates them: a recent report with an empty list means credentials are missing, and no recent
-- report at all means the process is down. The page says which.
--
-- IDEMPOTENT. db-init replays every migration on every boot in filename order.
--
-- Related: 0056 (the three tiers and the worker's principal), 0054 (this singleton shape),
--          0041 (why a password is not written down), README.md item 17 section 5.
-- =============================================================================================

SET search_path TO public;


-- ---------------------------------------------------------------------------------------------
-- 1. The report
-- ---------------------------------------------------------------------------------------------
-- ONE ROW, by CHECK (id), matching `directory_liveness_probe`. The chart pins the worker to a
-- single replica and the compose service runs one, so a second row would describe a deployment
-- this stack does not support -- and two workers reporting different credential sets would leave
-- the page unable to say which answer the next job will get.
CREATE TABLE IF NOT EXISTS public.playback_worker_status (
    id                boolean PRIMARY KEY DEFAULT true CHECK (id),
    -- The gateway `sparkplug_id`s this worker holds a broker password for. Public identifiers.
    held_edge_nodes   text[]      NOT NULL DEFAULT '{}',
    reported_at       timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.playback_worker_status (id, held_edge_nodes, reported_at)
VALUES (true, '{}', 'epoch')
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.playback_worker_status IS
  'What the playback worker can actually publish as: the gateway sparkplug_ids it holds broker '
  'passwords for, and when it last said so. One row by CHECK (id). Written only by '
  'playback_report_credentials(), read by the playback dialog so a target the worker cannot '
  'authenticate as is refused before a job is queued rather than after. Holds no secret -- a '
  'sparkplug_id is a public identifier and the passwords are deliberately not here.';

COMMENT ON COLUMN public.playback_worker_status.reported_at IS
  'Heartbeat. An empty held_edge_nodes with a RECENT timestamp means the worker is running and '
  'holds no credentials; a stale timestamp means the worker is not running. Those are different '
  'problems and the page says which.';


-- ---------------------------------------------------------------------------------------------
-- 2. RLS
-- ---------------------------------------------------------------------------------------------
-- READ MATCHES `playback_jobs`: the three roles that can see a playback can see what playback is
-- able to do. No write policy for anyone -- the gate below is the only door, exactly as for every
-- other table in 0055 and 0056.
ALTER TABLE public.playback_worker_status ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "playback_worker_status_select_privileged" ON public.playback_worker_status;
CREATE POLICY "playback_worker_status_select_privileged" ON public.playback_worker_status
    FOR SELECT TO authenticated
    USING (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Auditor']));


-- ---------------------------------------------------------------------------------------------
-- 3. The worker's gate
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.playback_report_credentials(p_edge_nodes text[])
    RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
BEGIN
    PERFORM public.require_playback_caller('playback_report_credentials');

    -- COERCED TO A SORTED, DE-DUPLICATED SET rather than stored as sent. The worker builds this
    -- from a JSON object whose key order is not defined, so storing it verbatim would rewrite the
    -- row -- and therefore wake every Realtime subscriber -- on a heartbeat that changed nothing.
    UPDATE public.playback_worker_status
       SET held_edge_nodes = COALESCE(
             (SELECT array_agg(DISTINCT node ORDER BY node)
                FROM unnest(coalesce(p_edge_nodes, '{}')) AS node
               WHERE node IS NOT NULL AND btrim(node) <> ''),
             '{}'
           ),
           reported_at = now()
     WHERE id;
END;
$fn$;

COMMENT ON FUNCTION public.playback_report_credentials(text[]) IS
  'The playback worker reporting which gateways it can authenticate as. The only writer of '
  'playback_worker_status. Called on startup and on a heartbeat, so a stale reported_at means the '
  'worker is down rather than credential-less.';


-- ---------------------------------------------------------------------------------------------
-- 4. Grants
-- ---------------------------------------------------------------------------------------------
-- REVOKE FIRST: this schema's default privileges grant ALL on every new public table to anon,
-- authenticated and service_role, so the table was born with `anon` holding INSERT, UPDATE and
-- DELETE. Same finding as 0055, and the self-check below asserts the narrowing for the same reason
-- -- recreating the table would silently re-widen both roles.
REVOKE ALL ON public.playback_worker_status FROM anon, authenticated;
GRANT SELECT ON public.playback_worker_status TO authenticated;

REVOKE ALL ON FUNCTION public.playback_report_credentials(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.playback_report_credentials(text[]) TO authenticated, service_role;


-- ---------------------------------------------------------------------------------------------
-- 5. Self-check
-- ---------------------------------------------------------------------------------------------
DO $selfcheck$
DECLARE
    v_wide  text;
    v_write integer;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.playback_worker_status WHERE id) THEN
        RAISE EXCEPTION
          '0057 self-check: the singleton row is missing. The page reads this row to decide whether '
          'the worker is running at all, and no row is indistinguishable from a worker that has '
          'never reported.';
    END IF;

    SELECT count(*) INTO v_write FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'playback_worker_status'
       AND cmd IN ('INSERT', 'UPDATE', 'DELETE') AND 'authenticated' = ANY (roles);
    IF v_write <> 0 THEN
        RAISE EXCEPTION
          '0057 self-check: % write polic(ies) on playback_worker_status admit `authenticated`. '
          'This row says what the worker can do; a UI that could write it could make a target look '
          'reachable that is not, which is the exact confusion this table exists to end.', v_write;
    END IF;

    SELECT string_agg(format('%s to %s', privilege_type, grantee), '; ') INTO v_wide
      FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND table_name = 'playback_worker_status'
       AND (grantee = 'anon' OR (grantee = 'authenticated' AND privilege_type <> 'SELECT'));
    IF v_wide IS NOT NULL THEN
        RAISE EXCEPTION
          '0057 self-check: the grant layer is wider than the gate. Found: %. This schema''s '
          'default privileges GRANT ALL on every new public table.', v_wide;
    END IF;

    IF NOT has_function_privilege('authenticated', 'public.playback_report_credentials(text[])', 'EXECUTE') THEN
        RAISE EXCEPTION
          '0057 self-check: `authenticated` cannot EXECUTE playback_report_credentials. The worker '
          'holds an ordinary authenticated principal, so it would report nothing, the page would '
          'read a stale row forever, and every target would look unreachable.';
    END IF;

    RAISE NOTICE
      '0057 self-check: playback_worker_status has its singleton row, takes no direct write, and '
      'the worker''s reporting gate is executable.';
END;
$selfcheck$;
