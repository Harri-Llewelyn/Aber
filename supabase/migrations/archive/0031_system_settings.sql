-- =============================================================================================
-- Migration: 0031_system_settings.sql
-- A runtime configuration plane, and the closed set of keys that keeps it honest
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT THIS IS FOR.
--
-- Deployed shopfloor instances have no one who can edit a host `.env` and restart a container.
-- The values an operator legitimately needs to tune -- retention windows, cold-storage endpoints,
-- thresholds -- are currently only reachable by someone with a shell on the machine running the
-- stack, which on a plant is a different person from the one who needs the change.
--
-- ---------------------------------------------------------------------------------------------
-- THE SET OF KEYS IS CLOSED, AND THAT IS THE LOAD-BEARING DECISION IN THIS FILE.
--
-- RLS below grants Administrators UPDATE and nothing else: no INSERT, no DELETE. A new setting
-- arrives by MIGRATION, never through the API.
--
-- The alternative -- an open key-value store an admin can add rows to -- fails in a way that is
-- quiet and permanent. A settings table exists so that CODE can read a value; a row no code reads
-- is not configuration, it is a note that looks like configuration. Someone sets
-- `telemetry_retenton_days` (sic), the UI accepts it, nothing changes, and there is nothing
-- anywhere to say why. Worse, a row that USED to be read stays behind when its consumer is
-- deleted, and now the settings page documents behaviour the system no longer has.
--
-- Closing the set makes the table a projection of what the code actually reads. `seed_setting()`
-- below is how a later migration adds one, and adding a consumer and its key in the same
-- migration is the point.
--
-- ---------------------------------------------------------------------------------------------
-- NOTHING SENSITIVE GOES IN HERE, AND THAT IS A RULE RATHER THAN A CONVENTION.
--
-- Every row is readable by any authenticated user (see RLS). That is deliberate: a setting shapes
-- what a page renders, so an Administrator-only SELECT would leave the page broken for everyone
-- else and the failure would look like a bug, not a permission.
--
-- The consequence is that S3 access keys, OIDC client secrets and anything else that must not be
-- read by an Operator DO NOT BELONG IN THIS TABLE. They belong in Supabase Vault, which is a
-- separate mechanism with a separate access story and is deliberately not started here. When the
-- cold-storage work lands it will put the ENDPOINT in this table and the CREDENTIAL in Vault, and
-- the split is exactly along this line.
--
-- `value_is_public` is not offered as an escape hatch for that reason: a column that says "this
-- one is secret" on a table every authenticated user can read is a claim the database cannot
-- enforce.
--
-- ---------------------------------------------------------------------------------------------
-- WHY NOT AUDITED TO digital_thread YET, since an admin changing a retention policy is exactly
-- the kind of act that audit trail exists for.
--
-- `digital_thread.entity_id` is `uuid NOT NULL`, which is why this table has a uuid primary key
-- and a separate unique text `key` -- the trigger could be attached without a schema change. It
-- is not attached because the Digital Thread page would render the result badly: lane names
-- resolve through a join on cells/gateways/devices and then through `name` or `sparkplug_id` in
-- the audit snapshot, and a settings row answers to none of those. Every change would appear as a
-- truncated uuid with no label. A half-legible audit entry is worse than an absent one, because
-- it looks like the feature works. `updated_by` and `updated_at` on the row carry who and when
-- until that page can name the row properly.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.system_settings (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key             text NOT NULL UNIQUE,
    -- JSONB, NOT TEXT. A number that arrives as the string "30" has to be parsed by every reader,
    -- and each one gets to pick its own answer for "30abc". Storing the type the value actually
    -- has moves that question here, where the CHECK below settles it once.
    value           jsonb NOT NULL,
    value_type      text NOT NULL,
    category        text NOT NULL,
    label           text NOT NULL,
    description     text,
    -- The environment variable or code constant this overrides, named so the fallback is
    -- greppable from either end. Nullable: not every setting has a pre-existing fallback.
    fallback_source text,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    updated_by      uuid,

    CONSTRAINT system_settings_key_format
        CHECK (key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
    CONSTRAINT system_settings_value_type_known
        CHECK (value_type IN ('string', 'number', 'boolean', 'json')),
    -- THE TYPE CLAIM IS ENFORCED, not just recorded. Without this, `value_type` is documentation
    -- that drifts from `value` the first time someone writes a string into a number setting, and
    -- the reader that trusted the column is the thing that breaks.
    CONSTRAINT system_settings_value_matches_type CHECK (
        CASE value_type
            WHEN 'string'  THEN jsonb_typeof(value) = 'string'
            WHEN 'number'  THEN jsonb_typeof(value) = 'number'
            WHEN 'boolean' THEN jsonb_typeof(value) = 'boolean'
            WHEN 'json'    THEN jsonb_typeof(value) IN ('object', 'array')
        END
    )
);

COMMENT ON TABLE public.system_settings IS
    'Runtime configuration an Administrator may change without a container restart. The key set is '
    'closed: RLS grants UPDATE only, and new keys arrive by migration beside the code that reads '
    'them. Nothing secret belongs here -- every authenticated user can read this table.';

-- ---------------------------------------------------------------------------------------------
-- 2. Stamping who changed it
-- ---------------------------------------------------------------------------------------------
-- Set here rather than trusted from the client. A PATCH that supplied its own `updated_by` would
-- otherwise be believed, which makes the column worse than absent: it would look like provenance.
CREATE OR REPLACE FUNCTION public.system_settings_stamp()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $fn$
BEGIN
    NEW.updated_at := now();
    -- `auth.uid()`, NOT `current_setting('request.jwt.claim.sub')`. That GUC is the PRE-v10
    -- PostgREST convention and the pinned 12.2.0 does not set it -- it sets `request.jwt.claims`,
    -- a JSON string. Reading the old name directly returned NULL for every real request while
    -- looking perfectly correct in a test that set the GUC by hand. auth.uid() coalesces both
    -- forms, which is why every other policy in this schema goes through it.
    --
    -- NULL under service_role and during migrations, which is correct: neither is a person.
    NEW.updated_by := auth.uid();
    -- The key is part of the closed set, so an UPDATE may not rename one out from under its
    -- reader. Blocked here rather than by a policy because a policy cannot see the OLD row's key
    -- and the NEW one at once in a USING clause that also has to permit ordinary edits.
    IF NEW.key IS DISTINCT FROM OLD.key THEN
        RAISE EXCEPTION
            'system_settings.key is immutable (attempted % -> %). A setting key names the value '
            'some code reads; renaming one here would silently disconnect it from that reader. '
            'Add the new key in a migration alongside its consumer.', OLD.key, NEW.key;
    END IF;
    IF NEW.value_type IS DISTINCT FROM OLD.value_type THEN
        RAISE EXCEPTION
            'system_settings.value_type is immutable for %. The reader was written against one '
            'type; changing it here breaks that reader without touching its code.', OLD.key;
    END IF;
    RETURN NEW;
END;
$fn$;

-- REVOKED FROM anon AND authenticated, and this is not belt-and-braces. The same
-- `supabase_admin` DEFAULT ACL that grants every table privilege also grants EXECUTE on every new
-- FUNCTION in `public` to anon -- so a trigger function arrives callable by an unauthenticated
-- caller unless it is taken away. `validate.py`'s anon privilege baseline asserts the empty set
-- and caught this one; the self-check below now catches it here first.
--
-- Revoking EXECUTE does not stop the TRIGGER firing: Postgres checks that privilege when the
-- trigger is created, not on each row.
REVOKE ALL ON FUNCTION public.system_settings_stamp() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS system_settings_stamp_trg ON public.system_settings;
CREATE TRIGGER system_settings_stamp_trg
    BEFORE UPDATE ON public.system_settings
    FOR EACH ROW EXECUTE FUNCTION public.system_settings_stamp();

-- ---------------------------------------------------------------------------------------------
-- 3. How a migration declares a setting
-- ---------------------------------------------------------------------------------------------
-- SEEDS WITHOUT OVERWRITING. db-init replays this file on every boot, so an unconditional INSERT
-- would reset an Administrator's change on every restart -- a settings plane that forgets is worse
-- than none, because the change appears to work and then silently reverts.
--
-- The metadata columns ARE refreshed, because those belong to the migration rather than to the
-- operator: relabelling a setting or correcting its description should reach an existing install.
-- `value` is the only column an operator owns.
CREATE OR REPLACE FUNCTION public.seed_setting(
    p_key             text,
    p_value           jsonb,
    p_value_type      text,
    p_category        text,
    p_label           text,
    p_description     text DEFAULT NULL,
    p_fallback_source text DEFAULT NULL
) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $fn$
BEGIN
    INSERT INTO public.system_settings
        (key, value, value_type, category, label, description, fallback_source)
    VALUES
        (p_key, p_value, p_value_type, p_category, p_label, p_description, p_fallback_source)
    ON CONFLICT (key) DO UPDATE SET
        value_type      = EXCLUDED.value_type,
        category        = EXCLUDED.category,
        label           = EXCLUDED.label,
        description     = EXCLUDED.description,
        fallback_source = EXCLUDED.fallback_source;
END;
$fn$;

REVOKE ALL ON FUNCTION public.seed_setting(text, jsonb, text, text, text, text, text)
    FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.seed_setting(text, jsonb, text, text, text, text, text) IS
    'Declare a setting from a migration. Inserts on first boot and refreshes only the metadata '
    'afterwards, so an operator''s value survives every replay. Not reachable through PostgREST.';

-- ---------------------------------------------------------------------------------------------
-- 4. The settings this migration declares
-- ---------------------------------------------------------------------------------------------
-- DELIBERATELY FEW, AND EVERY ONE HAS A READER. Seeding the settings a future feature might want
-- would fill this page with controls that do nothing, which is the exact failure the closed key
-- set exists to prevent -- and it would be self-inflicted rather than an operator's mistake.
--
-- Cold storage adds `archive.*` in its own migration, beside the code that reads it.
SELECT public.seed_setting(
    'ui.digital_thread_lane_limit',
    to_jsonb(30),
    'number',
    'Digital Thread',
    'Lanes drawn before folding',
    'How many asset lanes the Digital Thread draws before the remainder go behind "Show all '
    'lanes". Raise it on a large estate; lower it if the initial render feels slow.',
    'DEFAULT_LANE_LIMIT in DigitalThreadTab.jsx'
);

SELECT public.seed_setting(
    'ui.digital_thread_poll_seconds',
    to_jsonb(60),
    'number',
    'Digital Thread',
    'Refresh interval (seconds)',
    'How often the Digital Thread re-reads the audit log. The page is an audit trail rather than '
    'a live feed, so this is deliberately not a live-tail interval.',
    'the 60_000 ms interval in DigitalThreadTab.jsx'
);

-- ---------------------------------------------------------------------------------------------
-- 5. Row level security
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

-- READ BY EVERY AUTHENTICATED USER. See the header: a setting shapes what a page renders, so
-- restricting SELECT to Administrators would break that page for everyone else in a way that
-- reads as a bug rather than as a permission.
DROP POLICY IF EXISTS system_settings_select_authenticated ON public.system_settings;
CREATE POLICY system_settings_select_authenticated
    ON public.system_settings FOR SELECT TO authenticated USING (true);

-- UPDATE ONLY, AND ONLY FOR ADMINISTRATORS. There is deliberately no INSERT policy and no DELETE
-- policy: with RLS enabled, an operation with no permissive policy is denied, so the closed key
-- set is enforced by the ABSENCE of policies rather than by a rule someone has to remember.
DROP POLICY IF EXISTS system_settings_update_admin ON public.system_settings;
CREATE POLICY system_settings_update_admin
    ON public.system_settings FOR UPDATE TO authenticated
    USING (public.has_role(ARRAY['Administrator']))
    WITH CHECK (public.has_role(ARRAY['Administrator']));

DROP POLICY IF EXISTS system_settings_all_service_role ON public.system_settings;
CREATE POLICY system_settings_all_service_role
    ON public.system_settings FOR ALL TO service_role USING (true) WITH CHECK (true);

-- REVOKE BEFORE GRANT, AND THE `authenticated` REVOKE IS NOT DECORATION. This database carries a
-- `supabase_admin` DEFAULT ACL granting `arwdDxtm` -- every privilege -- on every new table in
-- `public` to anon, authenticated AND service_role. So a freshly created table arrives fully
-- granted to all three, and a bare `GRANT SELECT TO authenticated` is ADDITIVE ON TOP OF THAT: it
-- reads like a narrowing and narrows nothing.
--
-- The self-check below caught exactly that on the first run of this migration -- the column grant
-- underneath was inert because table-level UPDATE was already held.
REVOKE ALL ON public.system_settings FROM anon;
REVOKE ALL ON public.system_settings FROM authenticated;
GRANT SELECT ON public.system_settings TO authenticated;
-- The column grant is what actually confines an Administrator's PATCH to the value, and it only
-- means anything now that the table-level UPDATE above has been taken away. Without it, the
-- UPDATE policy would permit rewriting `label`, `fallback_source` or `updated_by` too -- the last
-- of which would let a person forge who made a change.
GRANT UPDATE (value) ON public.system_settings TO authenticated;
GRANT ALL ON public.system_settings TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 6. Self-check
-- ---------------------------------------------------------------------------------------------
DO $selfcheck$
DECLARE
    v_count   integer;
    v_ok      boolean;
BEGIN
    SELECT count(*) INTO v_count FROM public.system_settings;
    IF v_count < 2 THEN
        RAISE EXCEPTION '0031 self-check: expected the seeded settings, found %.', v_count;
    END IF;

    -- THE CLOSED SET, ASSERTED FROM THE DIRECTION THAT MATTERS. A permissive INSERT policy added
    -- later by accident would not fail anything else in this file -- the table would still work,
    -- and the key set would silently stop being closed.
    SELECT NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname = 'public' AND tablename = 'system_settings'
           AND cmd IN ('INSERT', 'DELETE')
           AND 'authenticated' = ANY (roles)
    ) INTO v_ok;
    IF NOT v_ok THEN
        RAISE EXCEPTION
          '0031 self-check: an INSERT or DELETE policy exists for `authenticated`. The key set is '
          'closed on purpose -- a new setting arrives by migration beside the code that reads it.';
    END IF;

    -- The column grant, checked rather than assumed: it is the only thing stopping an
    -- Administrator rewriting `updated_by` and forging provenance.
    IF has_column_privilege('authenticated', 'public.system_settings', 'updated_by', 'UPDATE') THEN
        RAISE EXCEPTION
          '0031 self-check: `authenticated` can UPDATE system_settings.updated_by. That column is '
          'stamped by trigger so it means something; a writable one would be a forgeable claim.';
    END IF;

    -- The type CHECK, exercised rather than trusted, in a subtransaction so the failure does not
    -- abort the migration.
    BEGIN
        UPDATE public.system_settings
           SET value = to_jsonb('not a number'::text)
         WHERE key = 'ui.digital_thread_lane_limit';
        RAISE EXCEPTION
          '0031 self-check: a string was accepted into a number setting. The value/value_type '
          'CHECK is not doing anything.';
    EXCEPTION
        WHEN check_violation THEN NULL;   -- expected
    END;

    -- ANON MUST HOLD EXECUTE ON NEITHER FUNCTION. Postgres grants it by default to every role
    -- here, so each new function is exposed until revoked -- and nothing about the feature would
    -- look wrong if one were missed.
    IF EXISTS (
        SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname IN ('system_settings_stamp', 'seed_setting')
           AND has_function_privilege('anon', p.oid, 'EXECUTE')
    ) THEN
        RAISE EXCEPTION
          '0031 self-check: anon holds EXECUTE on a function this migration created. Postgres '
          'grants that by default; it has to be revoked explicitly.';
    END IF;

    RAISE NOTICE '0031 self-check passed: % setting(s), key set closed, value types enforced, '
                 'anon holds no EXECUTE.', v_count;
END;
$selfcheck$;
