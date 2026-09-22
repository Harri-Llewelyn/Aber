-- 0096: the directory names the gateway that runs.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- The stack runs Envoy and the seeded directory row still said Kong. The seed now spells the
-- current name, and its INSERT for this row conflicts on id rather than service_name for the
-- reason the Node-RED row does: a database from before this rename holds the id under the old
-- name, and a name-targeted clause raises on the primary key every boot. This migration renames
-- the row those databases hold. `directory_liveness_job_map()` is declared in 0001 and replayed
-- every boot, so its side of the join needs nothing here.
--
-- Guarded on the new name being free, as 0016 is: an operator who registered a service under it
-- by hand keeps theirs, and the boot does not fail over a display string.

SET search_path TO public;

DO $$
DECLARE
  v_renamed INTEGER := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.directory_services
     WHERE service_name = 'Supabase API Gateway (Envoy)'
  ) THEN
    UPDATE public.directory_services
       SET service_name = 'Supabase API Gateway (Envoy)'
     WHERE service_name = 'Supabase API Gateway (Kong)';
    GET DIAGNOSTICS v_renamed = ROW_COUNT;
  END IF;

  RAISE NOTICE '0096: renamed % gateway directory entr(y/ies).', v_renamed;
END;
$$;

-- Self-check: the old name may only survive beside a hand-registered new one.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.directory_services
              WHERE service_name = 'Supabase API Gateway (Kong)')
     AND NOT EXISTS (SELECT 1 FROM public.directory_services
                      WHERE service_name = 'Supabase API Gateway (Envoy)') THEN
    RAISE EXCEPTION '0096 self-check: the gateway is still registered under its old name';
  END IF;
END;
$$;
