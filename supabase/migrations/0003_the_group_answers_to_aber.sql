-- =============================================================================================
-- Migration: 0003_the_group_answers_to_aber.sql
-- The default Sparkplug group moves from ACS-Cymru to Aber (#335, tier 3)
-- =============================================================================================
--
-- The platform's former name was the group every site published under by default. 0002 seeds
-- `sparkplug.group_id` once and holds it, so a stack installed before 1.0 carries the old literal
-- in the setting and in every gateway row that took the default. This moves both, and only where
-- the old default still stands.
--
-- WHAT MOVES. The setting, when it holds 'ACS-Cymru' AND the chart supplies 'Aber': an operator
-- who pins `ingestion.sparkplugGroup: ACS-Cymru` has named the group and keeps it, and 0002's
-- mismatch check tolerates exactly this pair so that the move can happen here. Then the gateway
-- rows still on 'ACS-Cymru', only once the site is on 'Aber', and only those rows: a gateway an
-- operator put on some other group is left as it is. The playbook is archived 0015's, which moved
-- the same identifier from FactoryPlus.
--
-- A COORDINATED CHANGE, NOT A COSMETIC ONE. The group is chosen by whatever publishes, so a
-- physical gateway keeps sending 'ACS-Cymru' until it is reconfigured, and its messages quarantine
-- (the fail-closed state, never a discard) until it is. Re-point the gateway first, or run this and
-- approve afterwards; docs/upgrades.md carries both orders. The bundled simulator and validate.py
-- already publish on the new group.
--
-- The read-only guard on system_settings refuses a value change, and that is right for a page;
-- this lifts it for one statement and puts it back. The gateway rows are attributed as 'migration'
-- in digital_thread by the session role. Idempotent: the second run matches nothing.
-- =============================================================================================

\if :{?sparkplug_group} \else \set sparkplug_group 'Aber' \endif
SELECT set_config('aber.sparkplug_group', :'sparkplug_group', false);

SET search_path TO public;

DO $$
DECLARE
    v_supplied text := coalesce(nullif(current_setting('aber.sparkplug_group', true), ''), 'Aber');
    v_stored   text;
    v_rows     integer;
BEGIN
    SELECT value #>> '{}' INTO v_stored
      FROM public.system_settings
     WHERE key = 'sparkplug.group_id';

    IF v_stored = 'ACS-Cymru' AND v_supplied = 'Aber' THEN
        UPDATE public.system_settings SET read_only = false
         WHERE key = 'sparkplug.group_id';
        UPDATE public.system_settings SET value = to_jsonb('Aber'::text)
         WHERE key = 'sparkplug.group_id';
        UPDATE public.system_settings SET read_only = true
         WHERE key = 'sparkplug.group_id';
        v_stored := 'Aber';
        RAISE NOTICE '0003: the site''s Sparkplug group moved from ACS-Cymru to Aber.';
    END IF;

    IF v_stored = 'Aber' THEN
        UPDATE public.gateways
           SET sparkplug_group = 'Aber'
         WHERE sparkplug_group = 'ACS-Cymru';
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows > 0 THEN
            RAISE NOTICE '0003: % gateway(s) moved from the ACS-Cymru group to Aber. Any PHYSICAL '
                         'gateway among them must be reconfigured to publish on the new group, or '
                         'its devices will quarantine until it is.', v_rows;
        END IF;
    END IF;
END;
$$;

-- Self-check. The column default follows the setting, and while the site is on the new default no
-- gateway is left on the old one -- a migration that moved the setting and left the rows behind
-- would look correct until the next DBIRTH.
DO $$
DECLARE
    v_stored text;
    v_stale  integer;
BEGIN
    SELECT value #>> '{}' INTO v_stored
      FROM public.system_settings
     WHERE key = 'sparkplug.group_id';

    IF public.sparkplug_group_default() IS DISTINCT FROM v_stored THEN
        RAISE EXCEPTION '0003 self-check: sparkplug_group_default() is %, the setting is %',
            public.sparkplug_group_default(), v_stored;
    END IF;

    IF v_stored = 'Aber' THEN
        SELECT count(*) INTO v_stale
          FROM public.gateways
         WHERE sparkplug_group = 'ACS-Cymru';
        IF v_stale > 0 THEN
            RAISE EXCEPTION '0003 self-check: % gateway(s) still on the ACS-Cymru group', v_stale;
        END IF;
    END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
