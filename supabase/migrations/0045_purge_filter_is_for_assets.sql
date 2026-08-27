-- =============================================================================================
-- 0045_purge_filter_is_for_assets.sql
--
-- `digital_thread_page()` hides every TOKEN_MINTED row. This makes its purge filter apply to the
-- three ASSET tables it was written for, and to nothing else.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT BROKE, AND THE FILE PREDICTED IT
--
-- 0039 derives `is_purged` as an anti-join against cells, gateways and devices, and its comment
-- states the trade deliberately:
--
--     NOT NARROWED BY `entity_type`: the audit row records which TABLE the trigger fired on, and
--     an asset is live if it is still in any of them -- three cheap index probes on a uuid, rather
--     than a CASE that would have to stay in step with the trigger's TG_TABLE_NAME vocabulary.
--
-- That was correct when every row in the table came from the trigger and named one of three
-- tables. It stopped being correct in 0043 and 0044, which write `entity_type = 'service_principals'`
-- -- an entity type that is NOT A TABLE, has no primary key to probe, and was never going to be
-- found in any of the three.
--
-- So every service-principal row evaluated as `is_purged = true` and was filtered out by
-- `WHERE p_include_purged OR NOT is_purged`. THE AUDIT TRAIL THIS FEATURE EXISTS TO PRODUCE WAS
-- INVISIBLE ON THE PAGE, and behind the "show deleted assets" toggle it appeared as a purged
-- asset -- describing an identity that had just been created as one that had been destroyed.
--
-- THE VOCABULARY THE COMMENT DID NOT WANT TO TRACK IS NOW TRACKED, and it is the narrowest form of
-- that: a single list of the entity types the anti-join can actually answer for. Anything else is
-- not purged, because "purged" is a claim about a row having been deleted from a table, and there
-- is no table to have been deleted from.
--
-- ---------------------------------------------------------------------------------------------
-- WHY NOT DROP THE PURGE FILTER, or make it purely client-side again
--
-- 0039 exists because it could not be client-side: "the query is capped at 200 rows", and 87 of a
-- 200-row page were once spent on deleted assets the page then hid. That reasoning is untouched --
-- what changes is only which rows the question is asked about.
--
-- ---------------------------------------------------------------------------------------------
-- THE COUNT FOLLOWS AUTOMATICALLY. `purged_assets` counts `DISTINCT entity_id ... WHERE is_purged`,
-- so a service principal no longer inflates the "N deleted assets are hidden" figure on a stack
-- where nothing has been deleted at all.
-- =============================================================================================

SET search_path TO public;

CREATE OR REPLACE FUNCTION public.digital_thread_page(
    p_limit          integer      DEFAULT 200,
    p_include_purged boolean      DEFAULT false,
    p_entity_type    text         DEFAULT NULL,
    p_action         text         DEFAULT NULL,
    p_entity_ids     uuid[]       DEFAULT NULL,
    p_since          timestamptz  DEFAULT NULL,
    p_until          timestamptz  DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $fn$
WITH matching AS (
    SELECT t.*,
           -- SCOPED TO THE THREE ASSET TYPES. The anti-join is unchanged and still not narrowed
           -- BETWEEN them -- an asset is live if it is still in any of the three, which is what
           -- makes it three index probes rather than a CASE per table. What is narrowed is WHICH
           -- ROWS ARE ASKED AT ALL: only the entity types that name one of those tables can be
           -- purged from it, and for anything else the question is meaningless rather than false.
           --
           -- `service_principals` (0043, 0044) is the type that forced this. It is an auth.users
           -- row, in GoTrue's schema, with no public table to probe -- so it answered "absent from
           -- all three" and was hidden as deleted.
           t.entity_type IN ('cells', 'gateways', 'devices')
       AND NOT EXISTS (SELECT 1 FROM public.cells    c WHERE c.id = t.entity_id)
       AND NOT EXISTS (SELECT 1 FROM public.gateways g WHERE g.id = t.entity_id)
       AND NOT EXISTS (SELECT 1 FROM public.devices  d WHERE d.id = t.entity_id)
               AS is_purged
      FROM public.digital_thread t
     WHERE (p_entity_type IS NULL OR t.entity_type = p_entity_type)
       AND (p_action      IS NULL OR t.action      = p_action)
       AND (p_entity_ids  IS NULL OR t.entity_id   = ANY (p_entity_ids))
       AND (p_since       IS NULL OR t.recorded_at >= p_since)
       AND (p_until       IS NULL OR t.recorded_at <= p_until)
),
visible AS (
    SELECT * FROM matching
     WHERE p_include_purged OR NOT is_purged
     ORDER BY recorded_at DESC
     LIMIT greatest(1, least(coalesce(p_limit, 200), 1000))
)
SELECT jsonb_build_object(
    'events', coalesce(
        (SELECT jsonb_agg(to_jsonb(v) - 'is_purged' ORDER BY v.recorded_at DESC) FROM visible v),
        '[]'::jsonb),
    'purged_assets', (SELECT count(DISTINCT entity_id) FROM matching WHERE is_purged),
    'truncated', (SELECT count(*) FROM visible) >= greatest(1, least(coalesce(p_limit, 200), 1000))
);
$fn$;

COMMENT ON FUNCTION public.digital_thread_page(integer, boolean, text, text, uuid[], timestamptz, timestamptz) IS
  'One page of the Digital Thread, with deleted assets filtered server-side and counted over the '
  'whole match rather than the page. `is_purged` applies only to cells, gateways and devices -- '
  'an entity type with no table behind it cannot have been deleted from one.';


-- ---------------------------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------------------------
-- ASSERTS THE ROW IS VISIBLE WITHOUT ASKING FOR PURGED ONES, which is the whole defect. Written
-- against a synthetic row inside a transaction that is rolled back, so it holds on a fresh
-- database where no token has been minted -- and does not depend on one having been.
DO $selfcheck$
DECLARE
  v_principal uuid;
  v_events    jsonb;
BEGIN
  SELECT id INTO v_principal FROM auth.users
   WHERE email IS NULL AND (encrypted_password IS NULL OR encrypted_password = '')
   ORDER BY id LIMIT 1;

  IF v_principal IS NULL THEN
    RAISE NOTICE '0045 self-check skipped: no service principal to write a probe row against.';
    RETURN;
  END IF;

  -- THE PROBE ROW MUST NOT SURVIVE. `digital_thread` is append-only for every role that reaches it
  -- through the API -- 0026 revoked DELETE even from service_role -- but this runs as the migration
  -- owner, and a self-check that leaves a fabricated audit row behind is worse than no self-check.
  --
  -- 0033's pattern: do the work in a subtransaction and abort it with a sentinel, which rolls the
  -- INSERT back with it. The sentinel is compared by MESSAGE because a genuine failure below raises
  -- the same condition, and swallowing that would turn this check into decoration.
  BEGIN
    INSERT INTO public.digital_thread (entity_type, entity_id, action, new_data, actor_source)
    VALUES ('service_principals', v_principal, 'TOKEN_MINTED',
            jsonb_build_object('probe', true), 'service');

    SELECT public.digital_thread_page(
             p_limit => 200, p_include_purged => false, p_entity_type => 'service_principals'
           ) -> 'events'
      INTO v_events;

    IF v_events IS NULL OR jsonb_array_length(v_events) = 0 THEN
      RAISE EXCEPTION
        '0045 self-check: a service_principals row is still filtered out of the default page. The '
        'purge anti-join is treating an entity type with no table behind it as a deleted asset.';
    END IF;

    RAISE EXCEPTION 'rollback_selfcheck';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rollback_selfcheck' THEN RAISE; END IF;
  END;

  RAISE NOTICE '0045 self-check passed: service-principal rows reach the page without asking for '
               'purged assets.';
END;
$selfcheck$;

NOTIFY pgrst, 'reload schema';
