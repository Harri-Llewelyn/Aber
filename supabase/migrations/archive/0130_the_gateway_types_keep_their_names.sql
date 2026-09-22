-- =============================================================================================
-- Migration: 0130_the_gateway_types_keep_their_names.sql
-- The credential gate is named after the type it accepts
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT THIS IS FINISHING
--
-- A gateway is Host, Remote or Simulated -- `deployment` plus `is_simulated`, rendered as one
-- control by frontend/src/utils/gatewayType.js. `virtual` was the word before archived `0064`
-- introduced `deployment`, and archived `0066` recorded that no SQL predicate read it any more.
--
-- It recorded three things that deliberately kept the old word, and one of them was this function:
-- "an RPC name is client-visible, and renaming it is its own change". This is that change.
-- `0001` now declares `authorize_host_gateway_credential(uuid)`; what is left is the old name,
-- which `0001` no longer creates but every database provisioned before this boot still holds.
--
-- ---------------------------------------------------------------------------------------------
-- WHY A SWEEP RATHER THAN ONE DROP
--
-- `DROP FUNCTION public.authorize_virtual_gateway_credential(uuid)` names one signature, and the
-- reason to distrust that is written into `supabase/README.md`: this function was briefly given a
-- third output column, which made the next boot fail at `0001` with `cannot change return type of
-- existing function`. A database that lived through an intermediate shape can hold a declaration
-- this file cannot predict the arguments of, so the sweep asks `pg_proc` instead -- the idiom
-- `0118` uses, and `0129` after it.
--
-- NOTHING DEPENDS ON THE OLD NAME BY THE TIME THIS RUNS. `0001` creates the new one earlier in the
-- same boot, and the only caller -- supabase/functions/gateway-credential -- ships in an image
-- built from this tree. A deployment mid-upgrade runs the previous function image against the new
-- schema for as long as its rollout takes, so the old name is dropped and the call fails closed
-- with `function does not exist` rather than minting against a gate that is no longer the one the
-- database documents. That window is the same one every other RPC rename would have, and a
-- credential mint is a deliberate operator act rather than a background path, so it is retried.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. The old name goes, whatever shape it was left in
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT p.oid::regprocedure AS sig
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = 'authorize_virtual_gateway_credential'
    LOOP
        EXECUTE format('DROP FUNCTION %s', r.sig);
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. Self-check: one name, one declaration
-- ---------------------------------------------------------------------------------------------
-- The shape, not a count of everything: `0069` asserted an absolute total and `0086` broke it on
-- the SECOND boot. Both halves are named, because a sweep that dropped the old name while `0001`
-- failed to create the new one leaves a stack whose only credential gate is gone.
DO $$
DECLARE
    v_old int;
    v_new int;
BEGIN
    SELECT count(*) INTO v_old
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'authorize_virtual_gateway_credential';

    SELECT count(*) INTO v_new
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'authorize_host_gateway_credential';

    IF v_old <> 0 THEN
        RAISE EXCEPTION
          '0130 self-check: authorize_virtual_gateway_credential still has % declaration(s)', v_old;
    END IF;

    IF v_new <> 1 THEN
        RAISE EXCEPTION
          '0130 self-check: expected exactly one authorize_host_gateway_credential, found %', v_new;
    END IF;
END;
$$;
