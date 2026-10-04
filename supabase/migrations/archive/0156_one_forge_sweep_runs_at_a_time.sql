-- =============================================================================================
-- Migration: 0156_one_forge_sweep_runs_at_a_time.sql (applied as 0025 until the 1.0 squash)
-- One forge sweep runs at a time, and a call refused while one runs is followed up
-- =============================================================================================
--
-- forge-sweep reads the forge and then writes what is missing, so two passes that overlap both
-- write: two push webhooks on one repository, and forge-events receiving every push twice. The
-- database asks for a pass every fifteen minutes and on every archive transition, and people and
-- the stack suite call the function directly, so passes overlapped.
--
-- A pass now claims public.forge_sweep_lease before it reads anything and releases it when it
-- ends; a call that finds the lease held does nothing and says so. A lease past held_until is
-- taken over, which bounds a pass that died holding it. Only the holder id a claim returned
-- renews or releases, so a pass that outlived its lease cannot release its successor's. A refused
-- call sets `requested`, and the release queues one more pass through sweep_forge() when it is
-- set, so an archive whose call arrived while a pass was running is followed within seconds.
--
-- Reasoning: supabase/README.md, "One pass at a time (0025)". Idempotent.
-- =============================================================================================

SET search_path TO public;

-- ---------------------------------------------------------------------------------------------
-- 1. The lease
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.forge_sweep_lease (
    id boolean DEFAULT true NOT NULL,
    holder uuid,
    held_until timestamp with time zone DEFAULT '-infinity'::timestamp with time zone NOT NULL,
    requested boolean DEFAULT false NOT NULL,
    CONSTRAINT forge_sweep_lease_pkey PRIMARY KEY (id),
    CONSTRAINT forge_sweep_lease_one_row CHECK (id)
);

ALTER TABLE public.forge_sweep_lease OWNER TO postgres;

INSERT INTO public.forge_sweep_lease (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.forge_sweep_lease IS
  'The one forge-sweep pass allowed to run. One row by CHECK (id). Moved only by '
  'claim_forge_sweep(), renew_forge_sweep() and release_forge_sweep(); readable by service_role.';
COMMENT ON COLUMN public.forge_sweep_lease.holder IS
  'The id the current claim returned, or null when free. Only this id renews or releases.';
COMMENT ON COLUMN public.forge_sweep_lease.held_until IS
  'When the lease lapses and the next claim takes it over. -infinity when free.';
COMMENT ON COLUMN public.forge_sweep_lease.requested IS
  'A claim was refused since the current pass started. The release then queues one more pass.';

ALTER TABLE public.forge_sweep_lease ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.forge_sweep_lease FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.forge_sweep_lease TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. Claim, renew, release
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_forge_sweep(p_seconds integer) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_holder uuid;
BEGIN
    IF p_seconds IS NULL OR p_seconds NOT BETWEEN 1 AND 3600 THEN
        RAISE EXCEPTION 'claim_forge_sweep: a lease lasts 1 to 3600 seconds, not %', p_seconds
            USING ERRCODE = '22023';
    END IF;

    -- Two claims at once serialise on the row lock, and the second re-reads held_until after the
    -- first commits, so exactly one wins. A new pass sees every change made before it, so it
    -- clears `requested`.
    UPDATE public.forge_sweep_lease
       SET holder = gen_random_uuid(),
           held_until = clock_timestamp() + make_interval(secs => p_seconds),
           requested = false
     WHERE id AND held_until <= clock_timestamp()
    RETURNING holder INTO v_holder;

    IF v_holder IS NULL THEN
        UPDATE public.forge_sweep_lease SET requested = true WHERE id;
    END IF;
    RETURN v_holder;
END;
$$;

ALTER FUNCTION public.claim_forge_sweep(integer) OWNER TO postgres;

COMMENT ON FUNCTION public.claim_forge_sweep(integer) IS
  'Claim the forge-sweep lease for p_seconds (1 to 3600). Returns the holder id, or null when '
  'another pass holds it, in which case `requested` is set so that pass''s release queues one more. '
  'A lease past its held_until is taken over.';

CREATE OR REPLACE FUNCTION public.renew_forge_sweep(p_holder uuid, p_seconds integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
    IF p_seconds IS NULL OR p_seconds NOT BETWEEN 1 AND 3600 THEN
        RAISE EXCEPTION 'renew_forge_sweep: a lease lasts 1 to 3600 seconds, not %', p_seconds
            USING ERRCODE = '22023';
    END IF;

    -- By holder alone: a lapsed lease nobody took over is still this holder's. Called as a pass
    -- starts under a lease its caller holds, so it clears `requested` as a claim does.
    UPDATE public.forge_sweep_lease
       SET held_until = clock_timestamp() + make_interval(secs => p_seconds),
           requested = false
     WHERE id AND holder = p_holder;
    RETURN FOUND;
END;
$$;

ALTER FUNCTION public.renew_forge_sweep(uuid, integer) OWNER TO postgres;

COMMENT ON FUNCTION public.renew_forge_sweep(uuid, integer) IS
  'Extend the forge-sweep lease p_holder holds by p_seconds from now, as a pass starts under it. '
  'False when p_holder is not the holder: never claimed, released, or taken over after it lapsed.';

CREATE OR REPLACE FUNCTION public.release_forge_sweep(p_holder uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_requested boolean;
BEGIN
    SELECT requested INTO v_requested
      FROM public.forge_sweep_lease
     WHERE id AND holder = p_holder
       FOR UPDATE;
    IF NOT FOUND THEN
        RETURN false;
    END IF;

    UPDATE public.forge_sweep_lease
       SET holder = NULL, held_until = '-infinity', requested = false
     WHERE id;

    -- A call refused during the pass may have come after the pass read what it asked about.
    -- Queued on commit; any number of refusals come to this one pass.
    IF v_requested THEN
        PERFORM public.sweep_forge();
    END IF;
    RETURN true;
END;
$$;

ALTER FUNCTION public.release_forge_sweep(uuid) OWNER TO postgres;

COMMENT ON FUNCTION public.release_forge_sweep(uuid) IS
  'Release the forge-sweep lease if p_holder holds it, and queue one more pass through '
  'sweep_forge() when a claim was refused while it was held. False, and nothing released, for any '
  'other id.';

REVOKE ALL ON FUNCTION public.claim_forge_sweep(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.renew_forge_sweep(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_forge_sweep(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_forge_sweep(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.renew_forge_sweep(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_forge_sweep(uuid) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- What this file did, and nothing wider. Reads the lease and never moves it: a pass may hold it
-- while db-init replays the chain.
-- ---------------------------------------------------------------------------------------------
DO $check$
DECLARE
    v_fn text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.forge_sweep_lease WHERE id) THEN
        RAISE EXCEPTION '0025: forge_sweep_lease has no row, so every claim would be refused';
    END IF;

    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.forge_sweep_lease'::regclass) THEN
        RAISE EXCEPTION '0025: forge_sweep_lease has row level security off';
    END IF;
    IF has_table_privilege('anon', 'public.forge_sweep_lease', 'SELECT')
       OR has_table_privilege('authenticated', 'public.forge_sweep_lease', 'SELECT')
       OR has_table_privilege('service_role', 'public.forge_sweep_lease', 'UPDATE')
       OR NOT has_table_privilege('service_role', 'public.forge_sweep_lease', 'SELECT') THEN
        RAISE EXCEPTION '0025: forge_sweep_lease is readable past service_role, or writable other than through its functions';
    END IF;

    FOREACH v_fn IN ARRAY ARRAY['public.claim_forge_sweep(integer)',
                                'public.renew_forge_sweep(uuid, integer)',
                                'public.release_forge_sweep(uuid)'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
                        WHERE p.oid = v_fn::regprocedure AND l.lanname = 'plpgsql' AND p.prosecdef) THEN
            RAISE EXCEPTION '0025: % is not plpgsql SECURITY DEFINER', v_fn;
        END IF;
        IF has_function_privilege('anon', v_fn, 'EXECUTE')
           OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
           OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
            RAISE EXCEPTION '0025: % is executable by anon or authenticated, or not by service_role', v_fn;
        END IF;
    END LOOP;
END
$check$;
