-- 0290: An alert's acknowledger and a suppression window's author are shown by name.
--
-- The alert counter, the drawer's banner and History's Alerts tab named who acknowledged an alert
-- by the email their token carried, and a suppression window's row in a drawer said "By <email>",
-- because no display name was readable by every role: display_names_for() answered for the caller
-- and for the people tied to them by a proposal, a retirement or a job. So an Operator read
-- "j.smith@site.local" where everywhere else the dashboard says "Jane Smith".
--
-- display_names_for() answers for two links more, each only for what the CALLER may read:
--
--   * the person who acknowledged an alert, for an alert platform_alerts' read policy shows the
--     caller: every alert but a machine identity's, which only an Administrator reads;
--   * the person who scheduled or ended a suppression window, for a window the table's read policy
--     shows the caller: every window, to every signed-in role.
--
-- The function is SECURITY DEFINER, so row security does not apply inside it, and a SECURITY
-- INVOKER helper called from it would run as its owner too. Each arm states its read policy's
-- predicate instead, as the proposer arm states the proposals' and the job arms the jobs'. The
-- db-lane suite holds each to the rows the policy shows a caller, for every role.
--
-- Everything 0213 declares is as it was: the caller's own name, the proposer, the retirer, the
-- person who started a capture or playback job, and a person with no name left out, so the answer
-- says nothing about a picture.
--
-- The acknowledger arm asks platform_alerts about each person it is given, and nothing indexed the
-- column: 39 people over 200,000 alerts took 700 ms, 19 of them a read of the whole table each. A
-- partial index on the acknowledged rows, which are few, makes it 4 ms. Idempotent.
--
-- Reasoning: supabase/README.md, "An acknowledger is shown by name (0290)".

CREATE INDEX IF NOT EXISTS idx_platform_alerts_acknowledged_by
    ON public.platform_alerts USING btree (acknowledged_by) WHERE (acknowledged_by IS NOT NULL);

CREATE OR REPLACE FUNCTION public.display_names_for(p_ids uuid[]) RETURNS TABLE(user_id uuid, display_name text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT p.user_id, p.display_name
    FROM public.person_profiles p
   WHERE p.user_id = ANY (p_ids)
     AND p.display_name IS NOT NULL
     AND (p.user_id = auth.uid()
          OR ((SELECT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']))
              AND EXISTS (SELECT 1 FROM public.change_proposals cp WHERE cp.proposed_by = p.user_id))
          OR ((SELECT public.has_authority(ARRAY['archive:manage', 'audit_trail:read']))
              AND EXISTS (SELECT 1 FROM public.retired_entities r WHERE r.retired_by = p.user_id))
          OR ((SELECT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Auditor']))
              AND (EXISTS (SELECT 1 FROM public.capture_jobs j WHERE j.requested_by = p.user_id)
                   OR EXISTS (SELECT 1 FROM public.playback_jobs j WHERE j.requested_by = p.user_id)))
          OR EXISTS (SELECT 1 FROM public.platform_alerts a
                      WHERE a.acknowledged_by = p.user_id
                        AND (a.entity_type <> 'service_identity'
                             OR (SELECT public.has_role(ARRAY['Administrator']))))
          OR EXISTS (SELECT 1 FROM public.alert_suppression_windows w
                      WHERE w.created_by = p.user_id OR w.ended_by = p.user_id));
$$;

ALTER FUNCTION public.display_names_for(p_ids uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.display_names_for(uuid[]) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.display_names_for(uuid[]) TO authenticated;

COMMENT ON FUNCTION public.display_names_for(p_ids uuid[]) IS
  'The display names of the given people that the caller can already see: their own, the '
  'proposer of a change proposal they may read (change_proposals_select_own_or_approver), the '
  'retirer of a retired entity they may read (retired_entities_select_privileged), the person '
  'who started a capture or playback job they may read (capture_jobs_select_privileged, '
  'playback_jobs_select_privileged), the person who acknowledged an alert they may read '
  '(platform_alerts_select_authenticated: a machine identity''s alert is an Administrator''s alone), '
  'and the person who scheduled or ended a suppression window, which every signed-in role reads '
  '(alert_suppression_windows_select_authenticated). Any other id is left out rather than refused, '
  'and a person with no name has no row, whether or not they have a picture (0203, 0213, 0290).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_src text;
BEGIN
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'public.display_names_for(uuid[])'::regprocedure;
  -- Every arm 0213 gave it, and the two this file adds, each tied to the table it reads.
  IF v_src !~ 'display_name IS NOT NULL' THEN
    RAISE EXCEPTION '0290: display_names_for() answers a row with no name, which tells the caller a picture exists';
  END IF;
  IF position('change_proposals' IN v_src) = 0 OR position('retired_entities' IN v_src) = 0
     OR position('capture_jobs' IN v_src) = 0 OR position('playback_jobs' IN v_src) = 0 THEN
    RAISE EXCEPTION '0290: display_names_for() has lost an arm 0213 gave it';
  END IF;
  IF position('a.acknowledged_by = p.user_id' IN v_src) = 0 OR position('service_identity' IN v_src) = 0
     OR position('w.created_by = p.user_id OR w.ended_by = p.user_id' IN v_src) = 0 THEN
    RAISE EXCEPTION '0290: display_names_for() does not name who acknowledged an alert, or scheduled or ended a window, by the read policies';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid = 'public.idx_platform_alerts_acknowledged_by'::regclass
                  AND i.indrelid = 'public.platform_alerts'::regclass AND i.indpred IS NOT NULL) THEN
    RAISE EXCEPTION '0290: platform_alerts has no partial index on acknowledged_by, which the acknowledger arm reads by';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.display_names_for(uuid[])'::regprocedure
                  AND prosecdef AND 'search_path=public' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0290: display_names_for() is not SECURITY DEFINER with its search_path pinned';
  END IF;
  IF has_function_privilege('anon', 'public.display_names_for(uuid[])', 'EXECUTE')
     OR has_function_privilege('service_role', 'public.display_names_for(uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.display_names_for(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION '0290: display_names_for() is not for the signed-in roles alone';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
