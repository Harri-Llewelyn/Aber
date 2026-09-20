-- =============================================================================================
-- Migration: 0131_the_sparkplug_group_belongs_to_the_site.sql
-- The Sparkplug group is the site's, fixed at install, and the chart and the database agree on it
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT THIS CHANGES
--
-- `gateways.sparkplug_group` defaulted to the literal 'ACS-Cymru' -- the platform vendor's name --
-- so every site published its own machine data under it. The group is the first segment of the
-- namespace a plant's data lives in and it belongs to the plant.
--
-- It is now `ingestion.sparkplugGroup` in the chart, seeded here into `sparkplug.group_id` on the
-- first boot and read by the column default from then on. The default is unchanged, so an install
-- that never names a group publishes exactly what it published before.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THE SETTING IS READ-ONLY, AND WHY A MISMATCH RAISES
--
-- Editing the group at runtime splits the topic tree at that instant: everything published before
-- is under the old group and everything after under the new one, with in-flight gateways still on
-- the old one until each is reconfigured. That is a migration, not a preference -- it reaches every
-- appliance bundle, every broker grant derived from the group, and every row of history keyed on
-- the (group, node) pair that `resolve_gateway()` resolves.
--
-- So the row is displayed and not edited: `system_settings.read_only` and a trigger that refuses a
-- value change. And a later boot whose chart value differs from the stored one RAISES rather than
-- quietly re-pointing the column, because a migration that silently re-addresses a fleet is worse
-- than one that stops. `supabase/README.md` carries the procedure for changing it deliberately.
--
-- The unset case is not a mismatch: a runner that passes no `sparkplug_group` compares against the
-- same default the chart ships, so the throwaway database and the CI lanes are unaffected.
-- =============================================================================================

-- psql leaves an unset variable as the literal `:'name'`, so every caller that does not pass one
-- gets the chart's default. `0002` uses this idiom for its own secrets.
\if :{?sparkplug_group} \else \set sparkplug_group 'ACS-Cymru' \endif

-- Handed to SQL through a GUC because psql does NOT substitute :variables inside dollar-quoted
-- strings, and every block below is dollar-quoted.
SELECT set_config('acs_cymru.sparkplug_group', :'sparkplug_group', false);

-- ---------------------------------------------------------------------------------------------
-- 1. A setting can be displayed without being editable
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.system_settings
    ADD COLUMN IF NOT EXISTS read_only boolean DEFAULT false NOT NULL;

COMMENT ON COLUMN public.system_settings.read_only IS
    'The value is fixed at install and shown for reference, not edited. The Settings page renders '
    'it without a control and system_settings_read_only_guard() refuses a write, so neither half '
    'depends on the other being present.';

CREATE OR REPLACE FUNCTION public.system_settings_read_only_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
    -- The VALUE alone. Metadata (label, description, bounds) is refreshed by seed_setting() on
    -- every boot, and refusing that would make the row impossible to correct.
    IF OLD.read_only AND NEW.value IS DISTINCT FROM OLD.value THEN
        RAISE EXCEPTION
            'system_settings.% is fixed at install and cannot be changed here. It is named by the '
            'deployment, and changing it in the database alone would leave the stack disagreeing '
            'with the chart. See supabase/README.md.', OLD.key;
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.system_settings_read_only_guard() IS
    'Refuses a value change to a read-only setting. A trigger rather than a policy because RLS '
    'cannot see OLD and NEW at once in a USING clause that must also permit ordinary edits -- the '
    'same reason system_settings_stamp() holds the key and value_type immutability.';

-- Stated here rather than leaning on 0001's sweeper, which runs earlier in the same boot and would
-- correct the ACL one boot late.
REVOKE ALL ON FUNCTION public.system_settings_read_only_guard() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS system_settings_read_only_trg ON public.system_settings;
CREATE TRIGGER system_settings_read_only_trg
    BEFORE UPDATE ON public.system_settings
    FOR EACH ROW EXECUTE FUNCTION public.system_settings_read_only_guard();

-- ---------------------------------------------------------------------------------------------
-- 2. The group, seeded once and then held
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
    v_group text := coalesce(nullif(current_setting('acs_cymru.sparkplug_group', true), ''), 'ACS-Cymru');
    v_stored text;
BEGIN
    IF v_group ~ '[/+#[:space:]]' THEN
        RAISE EXCEPTION
            '0131: sparkplug_group % is not one topic level. The group is one segment of '
            'spBv1.0/<group>/<TYPE>/<node>, so a separator in it addresses a subtree nothing '
            'grants.', quote_literal(v_group);
    END IF;

    -- Inserts on the first boot and refreshes only the metadata afterwards, so the seeded value is
    -- frozen the moment it lands.
    PERFORM public.seed_setting(
        'sparkplug.group_id',
        to_jsonb(v_group),
        'string',
        'Site',
        'Sparkplug group',
        'The Sparkplug Group ID every gateway on this site publishes under -- the second segment '
        'of spBv1.0/<group>/<TYPE>/<node> -- and the enterprise segment of the Unified Namespace. '
        'Fixed when the stack was installed: changing it re-addresses every gateway, so it is '
        'shown here and named in the chart.',
        'values.yaml ingestion.sparkplugGroup'
    );

    UPDATE public.system_settings
       SET read_only = true
     WHERE key = 'sparkplug.group_id'
       AND NOT read_only;

    SELECT value #>> '{}' INTO v_stored
      FROM public.system_settings
     WHERE key = 'sparkplug.group_id';

    -- THE DISAGREEMENT IS LOUD. A chart value that no longer matches the database means either the
    -- values file lost the key or somebody meant to re-address the site; both need a person, and
    -- neither is served by db-init carrying on.
    IF v_stored IS DISTINCT FROM v_group THEN
        RAISE EXCEPTION
            '0131: the database was installed with sparkplug group %, and the chart now says %. '
            'The group is fixed at install because it addresses every gateway, every appliance '
            'bundle and all existing history. Restore ingestion.sparkplugGroup to %, or follow '
            'the group change procedure in supabase/README.md.',
            quote_literal(v_stored), quote_literal(v_group), quote_literal(v_stored);
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. A new gateway lands in the site's group
-- ---------------------------------------------------------------------------------------------
-- Invoker rights: `authenticated` already selects system_settings under
-- system_settings_select_authenticated, and service_role holds all. A SECURITY DEFINER here would
-- widen nothing and hide the dependency.
CREATE OR REPLACE FUNCTION public.sparkplug_group_default() RETURNS text
    LANGUAGE sql
    STABLE
    SET search_path TO 'public', 'pg_catalog'
    AS $$
    SELECT coalesce(
        (SELECT value #>> '{}' FROM public.system_settings WHERE key = 'sparkplug.group_id'),
        'ACS-Cymru'
    );
$$;

COMMENT ON FUNCTION public.sparkplug_group_default() IS
    'The site''s Sparkplug group, for gateways.sparkplug_group''s DEFAULT. Falls back to the '
    'historical literal so a row can still be inserted if the setting is ever absent -- an INSERT '
    'that failed on a missing settings row would be a worse failure than a gateway in the old '
    'group.';

REVOKE ALL ON FUNCTION public.sparkplug_group_default() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sparkplug_group_default() TO authenticated, service_role;

-- Repeatable: ALTER COLUMN SET DEFAULT replaces whatever is there. 0001's CREATE TABLE IF NOT
-- EXISTS does not re-assert the literal on an existing table, and on a fresh database this runs
-- after it.
ALTER TABLE public.gateways
    ALTER COLUMN sparkplug_group SET DEFAULT public.sparkplug_group_default();

COMMENT ON COLUMN public.gateways.sparkplug_group IS
    'Sparkplug B Group ID -- the second topic segment. With sparkplug_id it forms the edge node '
    'address Factory+ resolves as (group, node). Defaults to the site''s group (0131) and is '
    'editable per row: a gateway can be moved to another group, unlike sparkplug_id which is '
    'issued identity.';

-- ---------------------------------------------------------------------------------------------
-- 4. The one gateway this repository seeds follows the site
-- ---------------------------------------------------------------------------------------------
-- `0002` inserts the Playback gateway WITHOUT naming a group, so it takes the column default --
-- and on a fresh install that is still `0001`'s literal, because this file has not run yet. A site
-- installing as `Plant-7` would otherwise find one row addressed in the vendor's namespace, with
-- nothing to say why.
--
-- NARROW ON PURPOSE. It corrects the row THIS REPOSITORY SEEDS, by its pinned id, and only while
-- that row still carries the historical literal -- an operator who deliberately moved it, or any
-- gateway they created themselves, is left alone. The column is per-row precisely so a gateway can
-- sit in another group.
DO $$
DECLARE
    v_group text := public.sparkplug_group_default();
BEGIN
    UPDATE public.gateways
       SET sparkplug_group = v_group
     WHERE id = '16000000-0000-4000-8000-000000000001'
       AND sparkplug_group = 'ACS-Cymru'
       AND v_group <> 'ACS-Cymru';
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- 5. Self-check
-- ---------------------------------------------------------------------------------------------
-- Asserts what THIS file changed and nothing absolute: no count of settings, no list of columns.
DO $$
DECLARE
    v_default text;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.system_settings
         WHERE key = 'sparkplug.group_id' AND read_only
    ) THEN
        RAISE EXCEPTION '0131 self-check: sparkplug.group_id is missing or not read-only';
    END IF;

    SELECT pg_get_expr(d.adbin, d.adrelid) INTO v_default
      FROM pg_attrdef d
      JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
     WHERE d.adrelid = 'public.gateways'::regclass AND a.attname = 'sparkplug_group';

    IF v_default IS NULL OR v_default NOT LIKE '%sparkplug_group_default%' THEN
        RAISE EXCEPTION
            '0131 self-check: gateways.sparkplug_group defaults to %, not the site setting',
            coalesce(v_default, '(none)');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'public.system_settings'::regclass
           AND tgname = 'system_settings_read_only_trg'
           AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION '0131 self-check: the read-only guard trigger is missing';
    END IF;
END;
$$;
