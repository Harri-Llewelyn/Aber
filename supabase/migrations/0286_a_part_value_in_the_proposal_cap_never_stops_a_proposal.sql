-- 0286: A part value stored in "Open proposals allowed per person" never stops a proposal.
--
-- enforce_open_proposal_cap() (0001) read the setting with (value #>> '{}')::integer. The setting is
-- bounded 1 to 200 and nothing refused a part number, so a saved 10.5 failed every proposal insert
-- with `invalid input syntax for type integer: "10.5"`: a person's Propose a Change and a machine
-- identity's proposal alike, and the person saw a database error, not the rule. 0285 now refuses a
-- part value when the setting is saved. This file is the other half: the trigger reads the setting
-- as its whole count, floor(10.5) = 10, so a part value that got past the guard (a row written
-- before 0285, or past the trigger by the service role) cannot stop proposals.
--
-- The function is 0001's, line for line, with that one read changed.
--
-- Reasoning: supabase/README.md, "A part value in the proposal cap never stops a proposal (0286)".
-- Idempotent.
--
-- Redefines public.enforce_open_proposal_cap: 0286 reads the cap as floor(...::numeric)::integer,
--   so a stored part value is its floor and never stops a proposal; the baseline cast it to an
--   integer, which a part value failed

CREATE OR REPLACE FUNCTION public.enforce_open_proposal_cap() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_cap  integer;
    v_open integer;
BEGIN
    SELECT floor((value #>> '{}')::numeric)::integer INTO v_cap
      FROM public.system_settings
     WHERE key = 'proposals.max_open_per_person';

    -- The setting is seeded by this migration and bounded at 1, so a NULL here means somebody
    -- deleted the row. Ten is the seeded default and the honest fallback: refusing every proposal
    -- because a setting is missing would take the feature away without saying so.
    v_cap := COALESCE(v_cap, 10);

    SELECT count(*) INTO v_open
      FROM public.change_proposals
     WHERE proposed_by = NEW.proposed_by
       AND status = 'open';

    IF v_open >= v_cap THEN
        RAISE EXCEPTION
            'you already have % open proposal(s), which is the limit; decide or withdraw one first',
            v_open
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_open_proposal_cap() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_open_proposal_cap() FROM PUBLIC, anon;

COMMENT ON FUNCTION public.enforce_open_proposal_cap() IS
  'The per-person ceiling on OPEN proposals, read from system_settings as its whole count, so a stored '
  'part value is its floor and never an error. A trigger rather than a line in an RPC because the '
  'INSERT policy admits a direct PostgREST write, and a cap with a documented way around it is not a '
  'cap (0001, 0286).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_def text := pg_get_functiondef('public.enforce_open_proposal_cap()'::regprocedure);
BEGIN
  IF v_def !~ 'floor\(\(value #>> ''\{\}''\)::numeric\)::integer' THEN
    RAISE EXCEPTION '0286: enforce_open_proposal_cap() does not read the cap as floor(...::numeric)::integer';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'public.enforce_open_proposal_cap()'::regprocedure AND p.prosecdef) THEN
    RAISE EXCEPTION '0286: enforce_open_proposal_cap() is not SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', 'public.enforce_open_proposal_cap()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.enforce_open_proposal_cap()', 'EXECUTE') THEN
    RAISE EXCEPTION '0286: a browser role may execute enforce_open_proposal_cap(), which only the trigger runs';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.change_proposals'::regclass
                    AND t.tgname = 'trg_change_proposals_cap' AND NOT t.tgisinternal AND t.tgenabled = 'O') THEN
    RAISE EXCEPTION '0286: trg_change_proposals_cap is not enabled on change_proposals';
  END IF;
END
$check$;
