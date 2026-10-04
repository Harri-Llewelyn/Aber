-- =============================================================================================
-- Migration: 0154_whoever_decides_a_proposal_can_read_the_machine_that_filed_it.sql (applied as 0022 until the 1.0 squash)
-- The Approvals page names a machine proposer to the person deciding its proposal (#535)
-- =============================================================================================
--
-- Since 0013 a machine identity holding proposal:create files cell and gateway proposals, and a
-- person decides them. The page named a proposer by the email its token carried, and a machine
-- has none, so it showed eight hex characters. The name an Administrator gave the machine is in
-- machine_principals, which only Administrator and Auditor read; a Shopfloor_Manager, who decides
-- cell and gateway proposals, could not resolve it at all.
--
-- list_proposer_names() returns the name of each machine that filed a proposal the caller may
-- decide, by the lane gate approve_proposal() decides with: may_decide_proposal() on the
-- proposal's lane. It returns nothing to anybody else, and nothing about a machine that proposed
-- nothing the caller decides. machine_principals is not widened.
--
-- Idempotent.
-- =============================================================================================

SET search_path TO public;

CREATE OR REPLACE FUNCTION public.list_proposer_names() RETURNS TABLE(principal_id uuid, name text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    -- may_decide_proposal() is the lane gate approve_proposal() decides by, and the one statement
    -- of which permission decides a lane. Every status, not only open: the Decided list names the
    -- proposer too. A person, and a pinned identity with no name, have no machine_principals row.
    RETURN QUERY
    SELECT DISTINCT mp.principal_id, mp.name
      FROM public.change_proposals cp
      JOIN public.machine_principals mp ON mp.principal_id = cp.proposed_by
     WHERE public.may_decide_proposal(cp.entity_type);
END;
$$;

ALTER FUNCTION public.list_proposer_names() OWNER TO postgres;

COMMENT ON FUNCTION public.list_proposer_names() IS 'The name of each machine identity that filed a change proposal the caller may decide, for the Approvals page: a machine has no email for the proposal to carry. Gated by may_decide_proposal() on each proposal''s lane, the gate approve_proposal() decides by, so a caller who decides nothing gets no rows, and machine_principals stays readable by Administrator and Auditor alone. A person, and a pinned identity with no name, return no row.';

REVOKE ALL ON FUNCTION public.list_proposer_names() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_proposer_names() TO authenticated;

-- ---------------------------------------------------------------------------------------------
-- What this file did, and nothing wider
-- ---------------------------------------------------------------------------------------------
DO $check$
DECLARE
    v_lang text;
    v_secdef boolean;
    v_def text;
BEGIN
    SELECT l.lanname, p.prosecdef INTO v_lang, v_secdef
      FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
     WHERE p.oid = 'public.list_proposer_names()'::regprocedure;
    -- plpgsql so no plan folds the gate away; SECURITY DEFINER because machine_principals is
    -- closed to the callers this serves.
    IF v_lang <> 'plpgsql' OR NOT v_secdef THEN
        RAISE EXCEPTION '0022 self-check: list_proposer_names() is % and SECURITY DEFINER is %, not plpgsql and true.',
            v_lang, v_secdef;
    END IF;

    v_def := pg_get_functiondef('public.list_proposer_names()'::regprocedure);
    IF position('public.may_decide_proposal(cp.entity_type)' IN v_def) = 0 THEN
        RAISE EXCEPTION '0022 self-check: list_proposer_names() no longer gates each proposal on may_decide_proposal().';
    END IF;

    IF has_function_privilege('anon', 'public.list_proposer_names()', 'EXECUTE')
       OR NOT has_function_privilege('authenticated', 'public.list_proposer_names()', 'EXECUTE') THEN
        RAISE EXCEPTION '0022 self-check: list_proposer_names() is executable by anon, or not by authenticated.';
    END IF;
END
$check$;
