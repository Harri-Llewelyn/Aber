-- =============================================================================================
-- Migration: 0135_a_database_from_before_the_fold.sql (applied as 0000 until the 1.0 squash)
-- Take away what the baseline no longer describes, before it describes it
-- =============================================================================================
--
-- `0001` is generated from a dump of the end state of the chain it replaces, so it states what
-- the schema IS. That is the whole of its job and the reason it can be generated: a description
-- adds, and a description cannot remove. Everything the old chain took away -- a column, a
-- function, a table, a settings row -- leaves no trace in a dump, so a database built by the old
-- chain would keep all of it while a fresh install never gets any of it, and the two would drift
-- apart for good.
--
-- This file is that difference, in one place. Every block is guarded on the thing it removes
-- still being there, so on a fresh database it is a no-op from top to bottom -- the objects it
-- names are the ones `0001` is about to NOT create.
--
-- WHY IT SORTS BEFORE THE BASELINE, WHICH IS THE ONE SURPRISING THING ABOUT IT. Section 8
-- converts the audit table from an ordinary table into a partitioned one, and `0001` describes it
-- already partitioned: `CREATE TABLE IF NOT EXISTS public.audit_trail_default PARTITION OF
-- public.audit_trail DEFAULT` fails with "public.audit_trail is not partitioned" against a
-- database that has not been converted. The conversion therefore has to happen before the
-- description, not after it -- and once one block runs early, every other block may as well,
-- because a subtraction of something the baseline never mentions reads the same either side of it.
-- Section 9 is the same fact again: `0001` names the table `audit_trail`, so a database that still
-- calls it `digital_thread` is renamed before the baseline describes it.
--
-- Running before the baseline is also what makes section 4 correct. `0132` decided whether to
-- remove the old `archive.bucket` row by asking whether `system_settings.sensitive` existed yet,
-- which is precisely "has the new schema arrived". Here that question still has the right answer.
--
-- WHY THE CONVERSION AND THE RENAME COME LAST WITHIN THIS FILE, which is the same fact seen from
-- the other side. Sections 1 to 5 delete and rename rows, and every one of those writes fires the
-- audit trigger, which writes to the audit table under the only name it knows: the old one. The
-- conversion rebuilds that table from `LIKE`, which carries columns, defaults and constraints but
-- NOT triggers -- so between the swap and `0001` the audit table has a NOT NULL `audit_domain`
-- and nothing left to stamp it. Deleting after converting therefore fails on the first row it
-- audits, and writing after the rename fails on a table that is no longer there. Doing both first
-- costs nothing: the rows are copied across by the conversion and carried by the rename.
--
-- WHAT THIS FILE DOES NOT DO. It does not add anything. Widening an existing table -- a column,
-- an inline constraint, a default that moved -- is `0001`'s, because a description can be made to
-- state those idempotently and this file is only for what a description cannot say at all. The
-- floor the two of them serve together is the chain as it stood at 31c1527^, which is every
-- database the previous squash's own tail served; a database given that chain and then this one
-- dumps identically to a fresh install, and scripts/verify-schema-equivalence.mjs is run the
-- other way to keep it so. Anything older than the floor is brought back by restoring a backup.
--
-- Idempotent, like every file here: db-init replays the whole chain on every boot, so each block
-- has to find nothing to do on the second pass and say so.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. A machine identity stops holding a person's role
-- ---------------------------------------------------------------------------------------------
-- An account that cannot sign in held `Operator` or `Auditor` through `user_roles`, which is a
-- table about people. Its authority is on `principal_permissions` now, and `0002` grants the
-- three seeded principals what they need there. The two RPCs that handed out a role went with
-- it: their replacement returns a different type, and CREATE OR REPLACE cannot change a return
-- type on a chain that replays, which is why the name changed rather than the body.
DO $principals$
DECLARE
    v_rows integer;
BEGIN
    IF to_regclass('public.user_roles') IS NULL THEN
        RETURN;
    END IF;

    -- is_machine_principal() is `0001`'s and does not exist yet, so its test is spelled out: no
    -- email, no password, no federated identity. `user_roles.user_id` is text and may hold
    -- something that is not a uuid at all, so the cast is guarded by the pattern.
    DELETE FROM public.user_roles ur
     WHERE ur.user_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND EXISTS (
           SELECT 1 FROM auth.users u
            WHERE u.id = ur.user_id::uuid
              AND u.email IS NULL
              AND (u.encrypted_password IS NULL OR u.encrypted_password = '')
              AND NOT EXISTS (SELECT 1 FROM auth.identities i WHERE i.user_id = u.id));
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows > 0 THEN
        RAISE NOTICE '0000: took a role away from % machine identit(ies).', v_rows;
    END IF;
END
$principals$;

DROP FUNCTION IF EXISTS public.create_service_principal(text, text);
DROP FUNCTION IF EXISTS public.list_service_principals();

-- ---------------------------------------------------------------------------------------------
-- 2. A floor stops being a thing
-- ---------------------------------------------------------------------------------------------
-- Where a cell is drawn is its place on its area's plan, which is a coordinate rather than a
-- storey. `cells.floor` was a smallint that grouped the Overview and `area_floors` was a table
-- of storeys under each area; between them they said the same thing three ways.
--
-- THE TRIGGER GOES BEFORE THE COLUMN. `trg_cells_place_on_floor` fires on the writes below, and
-- a trigger reading a column that is being dropped is an error rather than a no-op.
DO $floors$
BEGIN
    IF to_regclass('public.cells') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_cells_place_on_floor ON public.cells;
        ALTER TABLE public.cells DROP COLUMN IF EXISTS floor;
    END IF;

    IF to_regclass('public.areas') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_areas_ground_floor ON public.areas;
    END IF;

    IF to_regclass('public.area_floors') IS NOT NULL THEN
        -- The column first: dropping it takes its foreign key, its index and
        -- cells_place_needs_a_floor with it, which is every reference to the table from `cells`.
        ALTER TABLE public.cells DROP COLUMN IF EXISTS floor_id;
        DROP TABLE public.area_floors CASCADE;
        RAISE NOTICE '0000: area_floors is gone; a cell is placed on its area''s plan.';
    END IF;
END
$floors$;

DROP FUNCTION IF EXISTS public.place_cell_on_its_floor();
DROP FUNCTION IF EXISTS public.guard_floor_delete();
DROP FUNCTION IF EXISTS public.area_gets_a_ground_floor();
DROP FUNCTION IF EXISTS public.floor_level_name(integer);

-- ---------------------------------------------------------------------------------------------
-- 3. The three link lanes close
-- ---------------------------------------------------------------------------------------------
-- A link is attached, never proposed: `link:manage` gates the direct edit, which was always the
-- only way a link was actually attached. The proposals filed in those lanes are removed before
-- the constraint narrows, or the narrowing would be refused by the rows it is about.
DO $links$
DECLARE
    v_rows integer;
BEGIN
    IF to_regclass('public.change_proposals') IS NULL THEN
        RETURN;
    END IF;

    DELETE FROM public.change_proposals
     WHERE entity_type IN ('cell_links', 'gateway_links', 'device_links');
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows > 0 THEN
        RAISE NOTICE '0000: deleted % link proposal(s); the lane they were filed in no longer exists.',
            v_rows;
    END IF;
END
$links$;

DROP FUNCTION IF EXISTS public.proposable_link_tags();

-- ---------------------------------------------------------------------------------------------
-- 4. Two settings rows that are no longer controls
-- ---------------------------------------------------------------------------------------------
-- A setting nothing reads is a control that does nothing, and both of these read that way on the
-- Settings page: one moves a limit the Audit Trail stopped applying, the other names a
-- Supabase Storage bucket that no longer exists.
--
-- `archive.bucket` NEEDS ITS GUARD AND THE OTHER DOES NOT. The key was given a second, unrelated
-- meaning -- the S3 bucket, seeded by `0002` and set from the page -- so an unconditional DELETE
-- here would remove the operator's S3 bucket on every boot, `0002` would re-seed it from the
-- chart's empty default, and the stack would come back up with archiving on and nowhere to write.
-- That is measured, not theorised: it happened on the dev cluster during an unrelated rebuild.
-- The absence of `system_settings.sensitive` is exactly "the new meaning does not exist here
-- yet", and this file runs before `0001` creates the column, which is the only moment the
-- question can still be asked.
DO $settings$
BEGIN
    IF to_regclass('public.system_settings') IS NULL THEN
        RETURN;
    END IF;

    DELETE FROM public.system_settings WHERE key = 'ui.digital_thread_lane_limit';

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'system_settings'
           AND column_name = 'sensitive'
    ) THEN
        DELETE FROM public.system_settings WHERE key = 'archive.bucket';
    END IF;
END
$settings$;

-- ---------------------------------------------------------------------------------------------
-- 5. Rows the seed cannot correct
-- ---------------------------------------------------------------------------------------------
-- `0002` seeds the API gateway's row ON CONFLICT (id) DO NOTHING, which is deliberate -- the id
-- is what a hand-edited endpoint hangs off, and DO UPDATE would overwrite an operator's address
-- on every boot. The consequence is that it cannot correct the NAME either, so a database that
-- registered this row while the gateway was Kong keeps saying Kong for good.
--
-- Guarded on the new name being free: without it, an operator who had already registered a
-- service under the new name gets a unique violation on service_name and db-init fails the whole
-- boot over a display string.
DO $renames$
DECLARE
    v_renamed integer := 0;
BEGIN
    IF to_regclass('public.directory_services') IS NULL THEN
        RETURN;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.directory_services
                    WHERE service_name = 'Supabase API Gateway (Envoy)') THEN
        UPDATE public.directory_services
           SET service_name = 'Supabase API Gateway (Envoy)'
         WHERE service_name = 'Supabase API Gateway (Kong)';
        GET DIAGNOSTICS v_renamed = ROW_COUNT;
    END IF;

    IF v_renamed > 0 THEN
        RAISE NOTICE '0000: renamed % gateway directory entr(y/ies); the gateway is Envoy.', v_renamed;
    END IF;
END
$renames$;

-- The Digital Thread became the Audit Trail, and three seeded rows carry its name: the permission
-- and the Auditor role are seeded ON CONFLICT (id) DO NOTHING for the reason above, and a setting
-- is found by its key. The permission keeps its id, which `role_permissions`,
-- `principal_permissions` and PERMISSION_UUIDS in the dashboard hold; only its name moves, and
-- every policy and allow-list reads the name. Guarded on the new name being free, as above.
DO $trail_rows$
DECLARE
    v_rows integer;
BEGIN
    -- Nested rather than AND-ed: a query naming a missing table fails when it is planned.
    IF to_regclass('public.permissions') IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM public.permissions WHERE name = 'audit_trail:read') THEN
            UPDATE public.permissions
               SET name = 'audit_trail:read', description = 'View the audit trail'
             WHERE name = 'digital_thread:read';
            GET DIAGNOSTICS v_rows = ROW_COUNT;
            IF v_rows > 0 THEN
                RAISE NOTICE '0000: the permission digital_thread:read is audit_trail:read.';
            END IF;
        END IF;
    END IF;

    IF to_regclass('public.roles') IS NOT NULL THEN
        UPDATE public.roles
           SET description = 'Read-only access to the audit trail'
         WHERE name = 'Auditor'
           AND description = 'Read-only audit trace and digital thread access';
    END IF;

    -- A key cannot be renamed (system_settings_stamp() refuses it), so the value, which is the
    -- operator's, is copied to a row under the new key and the old row goes; `0002` then fills in
    -- the rest of the new row. Only the columns every settings table has had are named here.
    IF to_regclass('public.system_settings') IS NOT NULL THEN
        INSERT INTO public.system_settings (key, value, value_type, category, label)
        SELECT 'ui.audit_trail_poll_seconds', value, value_type, 'Audit Trail', label
          FROM public.system_settings
         WHERE key = 'ui.digital_thread_poll_seconds'
           AND NOT EXISTS (SELECT 1 FROM public.system_settings
                            WHERE key = 'ui.audit_trail_poll_seconds');
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        DELETE FROM public.system_settings WHERE key = 'ui.digital_thread_poll_seconds';
        IF v_rows > 0 THEN
            RAISE NOTICE '0000: the setting ui.digital_thread_poll_seconds is ui.audit_trail_poll_seconds.';
        END IF;
    END IF;
END
$trail_rows$;

-- ---------------------------------------------------------------------------------------------
-- 6. gateways.is_virtual, retired
-- ---------------------------------------------------------------------------------------------
-- It carried three incompatible meanings -- "no appliance exists", "runs on the host", "the
-- readings are generated" -- and `deployment` took the only one anything branched on. Nothing has
-- read it since; it was kept alive only because two archived migrations named it in a function
-- signature and replayed on every boot. They no longer replay, and the baseline's own note said
-- to remove it at the next squash, which is this one.
--
-- DROPPED, NOT REPLACED, and the distinction is the whole reason this is here rather than left to
-- `0001`. `CREATE OR REPLACE VIEW` cannot remove a column and `CREATE OR REPLACE FUNCTION` cannot
-- change a return type, so a baseline describing the narrower shape cannot reach a database that
-- holds the wider one -- it fails on the replace. The same will be true of any future fold that
-- narrows a view or a signature: the tail drops, the baseline rebuilds.
-- The transitional trigger, which wrote the two columns into agreement on every INSERT and
-- UPDATE. Nothing declares either any more, so both drops are unconditional -- but the trigger
-- goes first, because a function with a trigger on it cannot be dropped.
DO $sync$
BEGIN
    IF to_regclass('public.gateways') IS NOT NULL THEN
        DROP TRIGGER IF EXISTS trg_gateways_sync_deployment ON public.gateways;
    END IF;
END
$sync$;

DROP FUNCTION IF EXISTS public.sync_gateway_deployment();

-- GUARDED ON THE OLD SHAPE, NOT DROPPED OUTRIGHT. `gateway_health` selects from
-- `gateway_health_rows()`, so an unconditional DROP FUNCTION fails on the SECOND boot of a folded
-- database -- the view `0001` has just built is depending on it. The condition is the retired
-- column's name in the function's own return type, which is true of exactly the databases that
-- still hold the wide form.
DO $health$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = 'gateway_health_rows'
           AND pg_get_function_result(p.oid) LIKE '%is_virtual%'
    ) THEN
        DROP VIEW IF EXISTS public.gateway_health;
        DROP FUNCTION public.gateway_health_rows();
        RAISE NOTICE '0000: gateway_health_rows() dropped; 0001 declares it without is_virtual.';
    END IF;
END
$health$;

DO $is_virtual$
BEGIN
    IF to_regclass('public.gateways') IS NULL THEN
        RETURN;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'gateways' AND column_name = 'is_virtual'
    ) THEN
        RETURN;
    END IF;

    -- `gateway_status` is `SELECT g.*`, which the catalogue records as an explicit column list --
    -- so it depends on the column by name and refuses the drop while it stands. `0001` declares
    -- it again in its final shape.
    DROP VIEW IF EXISTS public.gateway_status;

    -- THE DEFAULT THE TRIGGER USED TO SUPPLY, and the one addition in this file. `deployment` is
    -- NOT NULL with no default of its own, because the trigger derived it from `is_virtual` --
    -- itself DEFAULT false -- on every INSERT. Take the trigger away without this and a writer
    -- that names neither column fails on a NOT NULL violation. 'remote' is exactly what the
    -- trigger produced from that default. `0001` declares it inline for a fresh database;
    -- CREATE TABLE IF NOT EXISTS cannot reach an existing one, so it is stated again here.
    ALTER TABLE public.gateways ALTER COLUMN deployment SET DEFAULT 'remote';

    ALTER TABLE public.gateways DROP COLUMN is_virtual;
    RAISE NOTICE '0000: gateways.is_virtual is gone; `deployment` carries what it was asked.';
END
$is_virtual$;

-- ---------------------------------------------------------------------------------------------
-- 7. Two function declarations nothing replaces
-- ---------------------------------------------------------------------------------------------
-- An overload is not a replacement. `CREATE OR REPLACE FUNCTION` matches on the argument list, so
-- `0001` declaring `approve_quarantined_device` with eleven arguments leaves a nine-argument
-- declaration standing beside it, and a caller passing nine still resolves to the old body. The
-- credential gate is the same fault wearing a rename: `authorize_virtual_gateway_credential` was
-- renamed to `authorize_host_gateway_credential`, and a rename leaves the old name behind.
--
-- A SWEEP OVER `pg_proc`, NOT A `DROP FUNCTION` NAMING A SIGNATURE, and the reason is recorded in
-- supabase/README.md: the credential gate was briefly given a third output column, so a database
-- that lived through that shape holds a declaration whose argument list this file cannot predict.
-- Asking the catalogue is the idiom the chain already used for exactly this.
--
-- The quarantine sweep is narrowed to the declarations that LACK `p_area_id`, because that is the
-- one the baseline is about to declare -- a sweep by name alone would drop the good one and the
-- boot would end with no way to approve a quarantined device at all.
DO $overloads$
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
        RAISE NOTICE '0000: dropped %, renamed to authorize_host_gateway_credential.', r.sig;
    END LOOP;

    FOR r IN
        SELECT p.oid::regprocedure AS sig
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = 'approve_quarantined_device'
           AND pg_get_function_identity_arguments(p.oid) NOT LIKE '%p_area_id%'
    LOOP
        EXECUTE format('DROP FUNCTION %s', r.sig);
        RAISE NOTICE '0000: dropped %, superseded by the form that takes an area.', r.sig;
    END LOOP;
END
$overloads$;

-- ---------------------------------------------------------------------------------------------
-- 8. digital_thread stops being one table
-- ---------------------------------------------------------------------------------------------
-- Monthly range partitions, so old audit history is detached rather than deleted row by row.
-- ONLY THE CONVERSION IS HERE. The primary key, the foreign key, the indexes, the policies, the
-- grants, the row-level security, the TRIGGERS and every comment are `0001`'s, and it restores
-- all of them immediately after this file runs -- which is why this is forty lines rather than
-- the two hundred the same conversion took when it ran AFTER the baseline and had to rebuild
-- them itself. `LIKE ... INCLUDING DEFAULTS INCLUDING CONSTRAINTS` carries the column defaults
-- and the CHECKs; nothing else is copied on purpose, so anything this misses is missing loudly.
--
-- AFTER EVERY WRITE ABOVE, because the triggers are among the things it does not carry: until
-- `0001` re-attaches `stamp_audit_domain()`, an INSERT into the rebuilt table has no way to fill a
-- NOT NULL column, and every write above audits itself. See the header. It works on the table's
-- old name, the only one a database from before partitioning has; section 9 renames the result.
DO $convert$
DECLARE
    v_min         timestamptz;
    v_max         timestamptz;
    v_month       timestamptz;
    v_part        text;
    v_rows_before bigint;
    v_rows_after  bigint;
BEGIN
    IF to_regclass('public.digital_thread') IS NULL THEN
        RETURN;                       -- a new database: 0001 creates it partitioned
    END IF;

    IF EXISTS (SELECT 1 FROM pg_partitioned_table
                WHERE partrelid = 'public.digital_thread'::regclass) THEN
        RETURN;                       -- already converted, on this boot or an earlier one
    END IF;

    SELECT count(*) INTO v_rows_before FROM public.digital_thread;
    RAISE NOTICE '0000: converting digital_thread to monthly partitions (% row(s))', v_rows_before;

    -- The partition key must be NOT NULL: a NULL key matches no range and would land in the
    -- default forever. Backfilled rather than dropped -- an audit row with an unknown timestamp
    -- is still evidence.
    UPDATE public.digital_thread SET recorded_at = now() WHERE recorded_at IS NULL;

    CREATE TABLE public.digital_thread_partitioned (
        LIKE public.digital_thread INCLUDING DEFAULTS INCLUDING CONSTRAINTS
    ) PARTITION BY RANGE (recorded_at);

    ALTER TABLE public.digital_thread_partitioned ALTER COLUMN recorded_at SET NOT NULL;

    -- The default partition FIRST and on purpose: between this statement and the loop below
    -- there is no window in which a row could be refused, and the order costs nothing.
    CREATE TABLE public.digital_thread_default
        PARTITION OF public.digital_thread_partitioned DEFAULT;

    -- The historical range comes from the rows themselves. `0001` adds this month and the next
    -- three afterwards; these are the months the existing rows need.
    SELECT min(recorded_at), max(recorded_at) INTO v_min, v_max FROM public.digital_thread;
    IF v_min IS NOT NULL THEN
        v_month := (date_trunc('month', v_min AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC';
        WHILE v_month <= v_max LOOP
            v_part := 'digital_thread_' || to_char(v_month AT TIME ZONE 'UTC', 'YYYY_MM');
            EXECUTE format(
                'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF '
                || 'public.digital_thread_partitioned FOR VALUES FROM (%L) TO (%L)',
                v_part, v_month, v_month + interval '1 month');

            -- SECURED AS IT IS CREATED, for the reason the parent is below: a partition's
            -- privileges are checked when it is addressed directly, so they do not follow the
            -- parent's -- and each of these is brand new, which means the image's default
            -- privileges have just handed `service_role` INSERT, UPDATE, DELETE and TRUNCATE on a
            -- month of the append-only audit trail. `secure_digital_thread_partition()` does this
            -- for every month created after `0001` runs; these are the months created before it.
            EXECUTE format(
                'REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role',
                v_part);

            v_month := v_month + interval '1 month';
        END LOOP;
    END IF;

    -- No trigger exists on the new table yet, so nothing can restate what an old row is allowed
    -- to say. The stored value is the record.
    INSERT INTO public.digital_thread_partitioned SELECT * FROM public.digital_thread;

    SELECT count(*) INTO v_rows_after FROM public.digital_thread_partitioned;
    IF v_rows_after <> v_rows_before THEN
        RAISE EXCEPTION '0000: copied % row(s) of % -- refusing to swap', v_rows_after, v_rows_before;
    END IF;

    -- The sequence is declared OWNED BY digital_thread.id, so DROP TABLE would take it down with
    -- the old table. Re-owned by the new column below; the sequence object is never recreated.
    ALTER SEQUENCE public.digital_thread_id_seq OWNED BY NONE;

    ALTER TABLE public.digital_thread RENAME TO digital_thread_preconversion;
    ALTER TABLE public.digital_thread_partitioned RENAME TO digital_thread;
    DROP TABLE public.digital_thread_preconversion;

    ALTER SEQUENCE public.digital_thread_id_seq OWNED BY public.digital_thread.id;

    -- CLOSED, NOT LEFT OPEN, for the few statements between here and `0001`'s grants. The new
    -- table is brand new, so the image's default privileges have just handed `service_role`
    -- everything on the audit trail and on its default partition -- including the DELETE the
    -- old table refused it. `0001` grants back exactly what each role should hold; until it
    -- does, nobody holds anything. A partition's privileges are checked when it is addressed
    -- directly, so the default one is named separately rather than following its parent.
    REVOKE ALL ON TABLE public.digital_thread         FROM PUBLIC, anon, authenticated, service_role;
    REVOKE ALL ON TABLE public.digital_thread_default FROM PUBLIC, anon, authenticated, service_role;
    ALTER TABLE public.digital_thread ENABLE ROW LEVEL SECURITY;

    RAISE NOTICE '0000: digital_thread converted; 0001 rebuilds its indexes, policies and grants.';
END
$convert$;

-- ---------------------------------------------------------------------------------------------
-- 9. digital_thread is audit_trail
-- ---------------------------------------------------------------------------------------------
-- The Digital Thread page became the Audit Trail, and every name in the database followed it. A
-- RENAME, so each row keeps its id and each partition its rows. What renames cleanly is renamed:
-- the table, its partitions, its sequence, its indexes and constraints, and the two columns
-- elsewhere that point into it. What holds the old name in its text is dropped, and `0001`
-- declares it again under the new one, as on a fresh database: the functions, the triggers
-- that call them, the policies, the partition-health view and the nightly job.
--
-- BOTH NAMES AT ONCE means a backup from before the rename was restored over a stack after it.
-- The restore drops every partition first, so the stack's own `audit_trail` is left empty and the
-- restored table is the record: whatever the stack's table still holds is appended to it under
-- new ids, the stack's table is dropped, and the rename goes ahead.
--
-- ONE BLOCK, so the triggers never outlive the table name their functions write to.
DO $trail$
DECLARE
    r        record;
    v_cols   text;
    v_rows   bigint;
    v_count  integer := 0;
BEGIN
    IF to_regclass('public.digital_thread') IS NOT NULL THEN
        IF to_regclass('public.audit_trail') IS NOT NULL THEN
            SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO v_cols
              FROM pg_attribute a
             WHERE a.attrelid = 'public.audit_trail'::regclass
               AND a.attnum > 0 AND NOT a.attisdropped AND a.attname <> 'id'
               AND EXISTS (SELECT 1 FROM pg_attribute b
                            WHERE b.attrelid = 'public.digital_thread'::regclass
                              AND b.attname = a.attname AND b.attnum > 0 AND NOT b.attisdropped);
            EXECUTE format('INSERT INTO public.digital_thread (%s) SELECT %s FROM public.audit_trail ORDER BY id',
                           v_cols, v_cols);
            GET DIAGNOSTICS v_rows = ROW_COUNT;
            -- Its view reads a partition by name, so it goes first; the partitions and the
            -- sequence go with the table.
            DROP VIEW IF EXISTS public.audit_trail_partition_health;
            DROP TABLE public.audit_trail;
            RAISE NOTICE '0000: a restored digital_thread met an audit_trail; % row(s) moved into it.', v_rows;
        END IF;

        ALTER TABLE public.digital_thread RENAME TO audit_trail;
        RAISE NOTICE '0000: digital_thread is audit_trail.';
    END IF;

    DROP VIEW IF EXISTS public.digital_thread_partition_health;

    -- Constraints first, each on its own table. Renaming a primary key renames its index with it;
    -- a CHECK is renamed on the parent, and PostgreSQL carries it to every partition.
    FOR r IN
        SELECT c.conrelid::regclass AS rel, c.conname
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
         WHERE t.relnamespace = 'public'::regnamespace
           AND c.conname LIKE '%digital\_thread%'
           AND NOT (c.contype = 'c' AND c.coninhcount > 0)
    LOOP
        EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I',
                       r.rel, r.conname, replace(r.conname, 'digital_thread', 'audit_trail'));
        v_count := v_count + 1;
    END LOOP;

    -- Then every relation left: the partitions, the sequence and the indexes.
    FOR r IN
        SELECT c.oid::regclass AS rel, c.relname, c.relkind
          FROM pg_class c
         WHERE c.relnamespace = 'public'::regnamespace
           AND c.relname LIKE '%digital\_thread%'
           AND c.relkind IN ('r', 'p', 'S', 'i', 'I')
    LOOP
        EXECUTE format('ALTER %s %s RENAME TO %I',
                       CASE WHEN r.relkind IN ('i', 'I') THEN 'INDEX'
                            WHEN r.relkind = 'S' THEN 'SEQUENCE'
                            ELSE 'TABLE' END,
                       r.rel, replace(r.relname, 'digital_thread', 'audit_trail'));
        v_count := v_count + 1;
    END LOOP;

    FOR r IN
        SELECT pol.polname, pol.polrelid::regclass AS rel
          FROM pg_policy pol
          JOIN pg_class t ON t.oid = pol.polrelid
         WHERE t.relnamespace = 'public'::regnamespace
           AND pol.polname LIKE '%digital\_thread%'
    LOOP
        EXECUTE format('DROP POLICY %I ON %s', r.polname, r.rel);
        v_count := v_count + 1;
    END LOOP;

    -- A partition's copy of a trigger goes with its parent's and cannot be dropped alone.
    FOR r IN
        SELECT tg.tgname, tg.tgrelid::regclass AS rel
          FROM pg_trigger tg
          JOIN pg_class t ON t.oid = tg.tgrelid
         WHERE t.relnamespace = 'public'::regnamespace
           AND NOT tg.tgisinternal
           AND tg.tgparentid = 0
           AND tg.tgname LIKE '%digital\_thread%'
    LOOP
        EXECUTE format('DROP TRIGGER %I ON %s', r.tgname, r.rel);
        v_count := v_count + 1;
    END LOOP;

    FOR r IN
        SELECT p.oid::regprocedure AS sig
          FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname LIKE '%digital\_thread%'
    LOOP
        EXECUTE format('DROP FUNCTION %s', r.sig);
        v_count := v_count + 1;
    END LOOP;

    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'change_proposals'
                  AND column_name = 'applied_thread_id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'change_proposals'
                          AND column_name = 'applied_trail_id') THEN
        ALTER TABLE public.change_proposals RENAME COLUMN applied_thread_id TO applied_trail_id;
        v_count := v_count + 1;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'retired_entities'
                  AND column_name = 'thread_id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'retired_entities'
                          AND column_name = 'trail_id') THEN
        ALTER TABLE public.retired_entities RENAME COLUMN thread_id TO trail_id;
        v_count := v_count + 1;
    END IF;

    -- `0002` schedules the job again under the new name; the old one would call a dropped function.
    IF to_regclass('cron.job') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'digital_thread_partitions') THEN
            PERFORM cron.unschedule('digital_thread_partitions');
            v_count := v_count + 1;
        END IF;
    END IF;

    IF v_count > 0 THEN
        RAISE NOTICE '0000: % object(s) renamed or dropped; 0001 declares the rest as audit_trail.', v_count;
    END IF;
END
$trail$;

-- ---------------------------------------------------------------------------------------------
-- 10. Self-check
-- ---------------------------------------------------------------------------------------------
-- Properties, not counts, and every one of them is already true on a fresh database -- which is
-- the point: this file leaves both kinds of database in the same state, and that state is what
-- `0001` is about to describe. `audit_trail` is deliberately not asserted partitioned: on a
-- fresh database it does not exist yet.
DO $check$
DECLARE
    v_problems text[] := ARRAY[]::text[];
BEGIN
    IF to_regclass('public.area_floors') IS NOT NULL THEN
        v_problems := v_problems || 'area_floors still exists'::text;
    END IF;

    IF to_regprocedure('public.create_service_principal(text, text)') IS NOT NULL THEN
        v_problems := v_problems || 'create_service_principal() still exists'::text;
    END IF;

    IF to_regprocedure('public.proposable_link_tags()') IS NOT NULL THEN
        v_problems := v_problems || 'proposable_link_tags() still exists'::text;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'cells' AND column_name = 'floor') THEN
        v_problems := v_problems || 'cells.floor still exists'::text;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'gateways' AND column_name = 'is_virtual') THEN
        v_problems := v_problems || 'gateways.is_virtual still exists'::text;
    END IF;

    IF to_regprocedure('public.sync_gateway_deployment()') IS NOT NULL THEN
        v_problems := v_problems || 'sync_gateway_deployment() still exists'::text;
    END IF;

    -- BY NAME, not by signature: the point of the sweep above is that the argument list of a
    -- stale declaration cannot be predicted, so neither can the assertion that it is gone.
    IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'authorize_virtual_gateway_credential') THEN
        v_problems := v_problems || 'authorize_virtual_gateway_credential() still exists'::text;
    END IF;

    -- A COUNT, EXCEPTIONALLY, and only of one name: an overload is invisible to every other check
    -- here, because both declarations are valid objects and only the argument list tells them
    -- apart. `0001` declares exactly one, so two means a stale one survived the sweep.
    IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'approve_quarantined_device') > 1 THEN
        v_problems := v_problems || 'approve_quarantined_device() has more than one declaration'::text;
    END IF;

    -- NESTED, NOT `AND`-ed. SQL does not promise to short-circuit, and
    -- `'public.audit_trail'::regclass` is resolved whether or not the left operand held --
    -- which raises "relation does not exist" on the fresh database this check exists to pass.
    IF to_regclass('public.audit_trail') IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM pg_partitioned_table
                        WHERE partrelid = 'public.audit_trail'::regclass) THEN
            v_problems := v_problems || 'audit_trail is still one table'::text;
        END IF;
    END IF;

    -- Nothing in the schema is still named for the Digital Thread, under any kind of name.
    IF EXISTS (SELECT 1 FROM pg_class
                WHERE relnamespace = 'public'::regnamespace AND relname LIKE '%digital\_thread%')
       OR EXISTS (SELECT 1 FROM pg_proc
                   WHERE pronamespace = 'public'::regnamespace AND proname LIKE '%digital\_thread%')
       OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname LIKE '%digital\_thread%')
       OR EXISTS (SELECT 1 FROM pg_policy WHERE polname LIKE '%digital\_thread%')
       OR EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
                   WHERE t.relnamespace = 'public'::regnamespace AND c.conname LIKE '%digital\_thread%') THEN
        v_problems := v_problems || 'an object is still named digital_thread'::text;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND (table_name, column_name) IN (('change_proposals', 'applied_thread_id'),
                                                    ('retired_entities', 'thread_id'))) THEN
        v_problems := v_problems || 'a column is still named for the thread'::text;
    END IF;

    IF to_regclass('public.permissions') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM public.permissions WHERE name = 'digital_thread:read') THEN
            v_problems := v_problems || 'the permission is still digital_thread:read'::text;
        END IF;
    END IF;

    IF to_regclass('public.system_settings') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM public.system_settings WHERE key = 'ui.digital_thread_poll_seconds') THEN
            v_problems := v_problems || 'the setting is still ui.digital_thread_poll_seconds'::text;
        END IF;
    END IF;

    IF to_regclass('cron.job') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'digital_thread_partitions') THEN
            v_problems := v_problems || 'the job digital_thread_partitions is still scheduled'::text;
        END IF;
    END IF;

    IF cardinality(v_problems) > 0 THEN
        RAISE EXCEPTION '0000 self-check: %', array_to_string(v_problems, '; ');
    END IF;

    RAISE NOTICE '0000 self-check passed: nothing the baseline stopped describing is still here.';
END
$check$;
