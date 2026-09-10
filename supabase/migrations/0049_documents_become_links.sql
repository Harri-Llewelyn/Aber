-- =============================================================================================
-- 0049 · `documents` becomes `links`, in the schema.
-- =============================================================================================
-- The feature was generalised from document links to links of any kind and the user-facing
-- vocabulary renamed; this renames the storage. A rename, not a redesign: the model was never
-- document-specific.
--
-- The permission's uuid does not move: `role_permissions` references it by id and
-- `PERMISSION_UUIDS.LINK_MANAGE` in the frontend is the same literal. Only the `name` changes.
--
-- Copies and drops rather than RENAME, because 0001 now creates `public.links` and runs first on
-- every boot, so on the upgrade boot `links` already exists, empty. No table holding data is
-- ever dropped (the copy and the drop are one transaction), and the surviving table is the one
-- 0001 defines, index, policies and grants included. Ids are carried across.
-- =============================================================================================

SET search_path TO public;

-- ---------------------------------------------------------------------------------------------
-- 1. Move the rows, then retire the old table
-- ---------------------------------------------------------------------------------------------
-- A no-op on a fresh install and on every boot after the first.
DO $migrate$
DECLARE
    v_moved   integer := 0;
    v_existing integer;
BEGIN
    IF to_regclass('public.documents') IS NULL THEN
        RETURN;  -- fresh install, or already migrated
    END IF;

    IF to_regclass('public.links') IS NULL THEN
        -- 0001 should have created it moments ago. If it did not, this file is running against a
        -- database whose baseline did not apply, and inventing the table here would paper over
        -- that -- the index, policies and grants would all be missing.
        RAISE EXCEPTION
            '0049: public.links does not exist. 0001 defines it and runs before this file, so a '
            'missing links table means the baseline did not apply cleanly. Refusing to guess.';
    END IF;

    -- Nothing should be in `links` yet on the upgrade boot. If something is, this is not the
    -- situation this migration was written for and merging blind could duplicate rows.
    SELECT count(*) INTO v_existing FROM public.links;
    IF v_existing > 0 THEN
        RAISE EXCEPTION
            '0049: public.links already holds % row(s) while public.documents still exists. '
            'Expected an empty links table freshly created by 0001. Resolve by hand rather than '
            'letting this merge two populated tables.', v_existing;
    END IF;

    INSERT INTO public.links (id, entity_type, entity_id, display_name, url, link_tag,
                              created_at, updated_at)
    SELECT id, entity_type, entity_id, display_name, url, document_tag, created_at, updated_at
      FROM public.documents;

    GET DIAGNOSTICS v_moved = ROW_COUNT;

    DROP TABLE public.documents;

    RAISE NOTICE '0049: moved % link(s) from public.documents and dropped it.', v_moved;
END;
$migrate$;

-- ---------------------------------------------------------------------------------------------
-- 2. The permission's name, and only its name
-- ---------------------------------------------------------------------------------------------
-- Matched on the id, not on the old name. 0002 seeds the new name for a fresh install; its
-- INSERT is ON CONFLICT (id) DO NOTHING and cannot correct a row that is already there.
UPDATE public.permissions
   SET name        = 'link:manage',
       description = 'Add, edit, and remove external links attached to assets'
 WHERE id = 'a012b345-6789-4c1d-8706-933e08544e38'
   AND (name IS DISTINCT FROM 'link:manage'
        OR description IS DISTINCT FROM 'Add, edit, and remove external links attached to assets');

-- ---------------------------------------------------------------------------------------------
-- 3. Self-check
-- ---------------------------------------------------------------------------------------------
-- The assertions whose failure is silent: a permission that lost its role grants, and a
-- leftover `documents` table.
DO $selfcheck$
DECLARE
    v_perm    CONSTANT uuid := 'a012b345-6789-4c1d-8706-933e08544e38';
    v_name    text;
    v_roles   integer;
    v_links   integer;
    v_pol     integer;
BEGIN
    IF to_regclass('public.links') IS NULL THEN
        RAISE EXCEPTION '0049 self-check: public.links does not exist.';
    END IF;

    IF to_regclass('public.documents') IS NOT NULL THEN
        RAISE EXCEPTION
            '0049 self-check: public.documents still exists alongside public.links. Two tables for '
            'one feature means half the writes land somewhere nothing reads.';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'links' AND column_name = 'link_tag'
    ) THEN
        RAISE EXCEPTION '0049 self-check: public.links has no link_tag column.';
    END IF;

    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'links' AND column_name = 'document_tag'
    ) THEN
        RAISE EXCEPTION
            '0049 self-check: public.links still carries document_tag. The rename is half applied '
            'and api.js writes one name while the other keeps its default.';
    END IF;

    -- The four policies from 0001, under their new names. RLS with no policy is not an open
    -- table, it is a closed one -- every read would return zero rows and the Links panel would
    -- render empty for everybody rather than erroring.
    SELECT count(*) INTO v_pol FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'links';
    IF v_pol <> 4 THEN
        RAISE EXCEPTION
            '0049 self-check: public.links carries % policies, expected 4. RLS is enabled, so a '
            'missing SELECT policy renders the Links panel empty rather than broken.', v_pol;
    END IF;

    SELECT name INTO v_name FROM public.permissions WHERE id = v_perm;
    IF v_name IS DISTINCT FROM 'link:manage' THEN
        RAISE EXCEPTION '0049 self-check: permission % is named %, expected link:manage.',
            v_perm, coalesce(v_name, 'NULL');
    END IF;

    -- THE ID DID NOT MOVE, asserted by counting what still points at it. This is the assertion the
    -- whole rename hangs on: a new row with a new id would satisfy the name check above and
    -- silently strip the capability from both roles.
    SELECT count(*) INTO v_roles FROM public.role_permissions WHERE permission_id = v_perm;
    IF v_roles < 2 THEN
        RAISE EXCEPTION
            '0049 self-check: permission % is granted to % role(s), expected at least 2. The id '
            'must not move -- role_permissions references it and the frontend holds the literal.',
            v_perm, v_roles;
    END IF;

    SELECT count(*) INTO v_links FROM public.links;
    RAISE NOTICE '0049 self-check passed: public.links holds % row(s) under 4 policies, '
                 'document_tag is gone, and link:manage kept its id and its % role grant(s).',
                 v_links, v_roles;
END;
$selfcheck$;
