-- =============================================================================================
-- Migration: 0147_a_gateway_status_is_a_label_and_never_stale.sql (applied as 0014 until the 1.0 squash)
-- The table refuses a gateway status that no writer may store
-- =============================================================================================
--
-- `gateways.status` stays free text. A gateway's Gateway_Status metric names its own operating
-- state, such as MAINTENANCE, so the domain belongs to the fleet (archived migration 0025).
-- What no writer may store is now refused by the table as well as by the heartbeat gate:
--   - a blank status, or one longer than ingest_record_gateway_health()'s 32 characters;
--   - STALE in any case, which public.gateway_status derives at read time and never stores;
--   - PENDING_ENROLLMENT or AWAITING_BIRTH spelt any way but the platform's, which the view, the
--     dashboard and platform_health compare exactly.
-- The three words are ingestion.py's RESERVED_GATEWAY_STATUSES.
--
-- A row that already holds such a value is not rewritten. The constraint is not applied, a
-- WARNING names each gateway, and the first boot after they are corrected applies it.
--
-- Idempotent.
-- =============================================================================================

SET search_path TO public;

DO $$
DECLARE
  -- pg_get_constraintdef()'s form of the CHECK below. A differing definition is replaced, so an
  -- edit to this file reaches every database on its next boot.
  v_want constant text := 'CHECK (((btrim(status) <> ''''::text) AND (length(status) <= 32) AND ((upper(status) <> ALL (ARRAY[''PENDING_ENROLLMENT''::text, ''AWAITING_BIRTH''::text, ''STALE''::text])) OR (status = ANY (ARRAY[''PENDING_ENROLLMENT''::text, ''AWAITING_BIRTH''::text])))))';
  v_offenders text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'gateways_status_valid'
                    AND conrelid = 'public.gateways'::regclass
                    AND pg_get_constraintdef(oid) = v_want) THEN
    -- The same predicate as the CHECK, asked first so a refused row is named rather than raised,
    -- and so an older definition is replaced only once this one can hold.
    SELECT string_agg(format('%s (%s) holds %L', name, sparkplug_id, left(status, 40)), '; ' ORDER BY name)
      INTO v_offenders
      FROM public.gateways
     WHERE NOT (btrim(status) <> '' AND length(status) <= 32
                AND (upper(status) NOT IN ('PENDING_ENROLLMENT', 'AWAITING_BIRTH', 'STALE')
                     OR status IN ('PENDING_ENROLLMENT', 'AWAITING_BIRTH')));

    IF v_offenders IS NULL THEN
      ALTER TABLE public.gateways
        DROP CONSTRAINT IF EXISTS gateways_status_valid,
        ADD CONSTRAINT gateways_status_valid
        CHECK (btrim(status) <> '' AND length(status) <= 32
               AND (upper(status) NOT IN ('PENDING_ENROLLMENT', 'AWAITING_BIRTH', 'STALE')
                    OR status IN ('PENDING_ENROLLMENT', 'AWAITING_BIRTH')));
    ELSE
      RAISE WARNING '0014: gateways_status_valid is not applied, because these gateways hold a status it refuses: %',
                    v_offenders
        USING HINT = 'Nothing was changed. Correct each status as the database owner (OFFLINE is what a '
                     'gateway that is not reporting holds, and its next heartbeat writes its own); the '
                     'next boot applies the constraint.';
    END IF;
  END IF;

  -- What this block did: unless the WARNING above named the gateways holding it back, the CHECK is
  -- in place, validated, and defined as declared here.
  IF v_offenders IS NULL AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname = 'gateways_status_valid'
          AND conrelid = 'public.gateways'::regclass
          AND contype = 'c'
          AND convalidated
          AND pg_get_constraintdef(oid) = v_want) THEN
    RAISE EXCEPTION '0014 self-check: public.gateways has no validated gateways_status_valid CHECK '
                    'defined as this file declares it.';
  END IF;
END
$$;

-- 0001 restores its own comment on every boot, so this one is restated on every boot too.
COMMENT ON COLUMN public.gateways.status IS 'Free text in the fleet''s own words: a Gateway_Status metric in a node-level payload overrides whatever the message type implies, so the domain is not closed. The values this platform writes are: PENDING_ENROLLMENT (a Remote gateway awaiting its bundle redemption), AWAITING_BIRTH (enrolled, holds a credential, has not yet published), ONLINE and OFFLINE (written by the ingestion daemon from node-level Sparkplug messages). STALE is DERIVED at read time by public.gateway_status and is never stored. gateways_status_valid (0014) refuses a blank status, one over 32 characters, STALE in any case, and the two lifecycle states spelt any way but the platform''s.';
