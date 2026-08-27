-- =============================================================================================
-- 0033 · One relocation batch, one transaction, one causation_id
-- =============================================================================================
-- Rearrange mode on the Overview page is a MODE -- off by default, entered deliberately, left by
-- clicking "Rearranging — click to finish" -- but it was not a TRANSACTION. Every drop issued its
-- own `PUT /api/v1/devices/{id}` the moment the mouse was released, so reassigning six machines
-- (one decision, taken once, at one keyboard) landed as six independent UPDATEs: six transactions,
-- six `causation_id`s, and six rows in `digital_thread` with nothing tying them together.
--
-- THE AUDIT TRAIL IS THE REASON THIS EXISTS, not tidiness and not request count. 0026 added
-- `causation_id` so that "these rows were one act" is answerable, and the event drawer's "Same
-- transaction" control exists to show it. Until now the only multi-entity act on a fresh stack was
-- the one `supabase/seed.sql` commits deliberately so that control has something to demonstrate.
-- This is what lets a real operator action produce one.
--
-- WHY A FUNCTION AND NOT CLIENT-SIDE STAGING ALONE. Device writes go through PostgREST per row
-- (`supabase.from('devices').update(...).eq('id', ...)`). Staging in the browser and then firing
-- six requests on finish would still be six transactions and would change nothing about the
-- thread -- it would only move WHEN they happen. Worse, it introduces a half-applied batch: three
-- machines moved, three not, and no record that the other three were ever meant to. That is
-- strictly worse than the immediate writes it replaced, so the atomicity has to come from here.
--
-- NOTHING IN THIS FILE STAMPS AN AUDIT ROW. `log_digital_thread_event()` (0005, re-declared by
-- 0026) already stamps `txid_current()` on every row it writes, and every UPDATE below runs in
-- ONE transaction because they run in one function call. The shared causation is a CONSEQUENCE of
-- doing the work in one call, not a value this function invents -- which is the point: a
-- causation_id a caller could supply would be an assertion rather than a fact.
--
-- Shaped after `fork_schema()` (0001): SECURITY DEFINER, `search_path` pinned, authority checked
-- against the same allow-list as the RLS policy it stands in for, and every failure a RAISE
-- rather than a silently skipped row.
-- =============================================================================================

SET check_function_bodies = false;


-- ---------------------------------------------------------------------------------------------
-- 1. The batch relocation RPC
-- ---------------------------------------------------------------------------------------------
-- `p_moves` is a JSON array of `{device_id, cell_id, location_scope}`. `cell_id` may be null or
-- absent; `location_scope` is REQUIRED and deliberately not defaulted -- see the loop for why.
CREATE OR REPLACE FUNCTION public.relocate_devices(p_moves jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $fn$
DECLARE
  v_move      jsonb;
  v_device_id uuid;
  v_scope     text;
  v_cell      uuid;
  v_raw_cell  text;
  v_len       integer;
  v_applied   integer := 0;
  v_unchanged integer := 0;
  v_before    public.devices%ROWTYPE;
  v_after     public.devices%ROWTYPE;
  v_results   jsonb := '[]'::jsonb;
  v_changed   boolean;
BEGIN
  -- Fail closed, before anything observable happens. SECURITY DEFINER means RLS does not apply
  -- inside this function, so `devices_update_privileged` -- the policy that would otherwise be
  -- the gate -- is not consulted at all. This re-derives its allow-list from the database rather
  -- than trusting that the caller reached us through a UI that checked. The same list,
  -- deliberately: relocating in a batch must not be authorised more loosely than relocating one
  -- device at a time.
  IF NOT public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']) THEN
    RAISE EXCEPTION 'insufficient privileges to relocate devices'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_moves IS NULL OR jsonb_typeof(p_moves) <> 'array' THEN
    RAISE EXCEPTION 'p_moves must be a JSON array of moves, got %',
                    COALESCE(jsonb_typeof(p_moves), 'null')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_len := jsonb_array_length(p_moves);

  -- An empty batch is a CALLER BUG, not a no-op, and it is raised rather than absorbed. The page
  -- disables Apply at zero staged moves; a request arriving here with none means that guard is
  -- gone, and answering "success, nothing done" would make the regression invisible.
  IF v_len = 0 THEN
    RAISE EXCEPTION 'p_moves is empty; nothing to relocate'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- A ceiling, because there is not one anywhere else. Every row below takes a FOR UPDATE lock
  -- held until commit, so an unbounded array is an unbounded lock hold on `devices` by an
  -- ordinary authenticated user. 200 is far above any plausible rearrange gesture -- the page
  -- renders one draggable chip per device -- and far below anything that would matter.
  IF v_len > 200 THEN
    RAISE EXCEPTION 'a relocation batch is limited to 200 moves; got %', v_len
      USING ERRCODE = 'program_limit_exceeded',
            HINT = 'Apply the rearrangement in smaller batches.';
  END IF;

  -- ONE DEVICE MAY APPEAR ONCE. Dragging a chip twice before applying is a legitimate gesture and
  -- the page collapses it to a single staged entry keyed by device -- but if two entries ever do
  -- arrive, "last one wins" would silently discard an instruction the operator gave. The whole
  -- point of a batch is that its outcome is stated, so an ambiguous batch is refused instead.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_moves) m
     GROUP BY m ->> 'device_id'
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'p_moves names the same device more than once; a batch must state one destination per device'
      USING ERRCODE = 'cardinality_violation';
  END IF;

  -- ORDERED BY device_id, AND THAT ORDER IS LOAD-BEARING. Each iteration takes a row lock held
  -- until commit, so two operators applying overlapping batches in opposite orders would deadlock
  -- and one of them would lose a rearrangement to a message about a lock. A total order over the
  -- locked rows makes that impossible, and the primary key is the cheapest one available.
  FOR v_move IN
    SELECT m FROM jsonb_array_elements(p_moves) m ORDER BY m ->> 'device_id'
  LOOP
    IF jsonb_typeof(v_move) <> 'object' THEN
      RAISE EXCEPTION 'every element of p_moves must be an object, got %', jsonb_typeof(v_move)
        USING ERRCODE = 'invalid_parameter_value';
    END IF;

    IF (v_move ->> 'device_id') IS NULL THEN
      RAISE EXCEPTION 'every move must name a device_id' USING ERRCODE = 'null_value_not_allowed';
    END IF;

    BEGIN
      v_device_id := (v_move ->> 'device_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'device_id % is not a uuid', v_move ->> 'device_id'
        USING ERRCODE = 'invalid_parameter_value';
    END;

    -- REQUIRED, NOT DEFAULTED TO 'cell'. Defaulting would mean a caller that simply forgot the
    -- key silently clears `site_wide` off an asset deliberately marked as having no cell -- an
    -- assertion an operator made, undone by an omission. Absent is not the same as 'cell' here,
    -- so absent is an error.
    v_scope := v_move ->> 'location_scope';
    IF v_scope IS NULL THEN
      RAISE EXCEPTION 'move for device % must state location_scope (cell or site_wide)', v_device_id
        USING ERRCODE = 'null_value_not_allowed';
    END IF;
    IF v_scope NOT IN ('cell', 'site_wide') THEN
      RAISE EXCEPTION 'location_scope % is not valid for device %; expected cell or site_wide',
                      v_scope, v_device_id
        USING ERRCODE = 'check_violation';
    END IF;

    -- Empty string reads as absent, the same normalisation `emptyToNull()` performs on the
    -- single-device path in frontend/src/api.js. Two spellings of "no cell" is how a
    -- `WHERE cell_id IS NULL` starts missing rows.
    v_raw_cell := NULLIF(btrim(COALESCE(v_move ->> 'cell_id', '')), '');
    IF v_raw_cell IS NULL THEN
      v_cell := NULL;
    ELSE
      BEGIN
        v_cell := v_raw_cell::uuid;
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'cell_id % is not a uuid', v_raw_cell
          USING ERRCODE = 'invalid_parameter_value';
      END;
    END IF;

    -- Mirrors devices_site_wide_has_no_cell, and mirrors locationFieldsFrom() in
    -- frontend/src/api.js which normalises the same way on the single-device path. FORCED rather
    -- than rejected: "site-wide, in cell 3" is not a refusal case, it is an incompletely cleared
    -- form, and the CHECK constraint would refuse it with a message naming a constraint.
    IF v_scope = 'site_wide' THEN
      v_cell := NULL;
    END IF;

    -- FOR UPDATE, for the ordering reason above and because the no-op comparison below has to be
    -- read against a row nobody else can move underneath it.
    SELECT * INTO v_before FROM public.devices WHERE id = v_device_id FOR UPDATE;
    IF NOT FOUND THEN
      -- THE WHOLE BATCH FAILS, and that is the behaviour this item asks for. A half-applied
      -- rearrangement is the failure mode deferring the commit exists to remove, so one unknown
      -- device rolls back the other five moves rather than leaving them applied and unrecorded.
      RAISE EXCEPTION 'device % not found; no part of this batch was applied', v_device_id
        USING ERRCODE = 'no_data_found';
    END IF;

    IF v_cell IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.cells c WHERE c.id = v_cell) THEN
      RAISE EXCEPTION 'cell % not found; no part of this batch was applied', v_cell
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- THE GATEWAY IS DELIBERATELY LEFT ALONE, exactly as the single-device drop path leaves it.
    -- A drop says where the machine IS; it says nothing about which connector reaches it, and
    -- rewiring the data path to express a location is the coupling archived migration 0036
    -- removed. Only these two columns move.
    UPDATE public.devices
       SET cell_id        = v_cell,
           location_scope = v_scope
     WHERE id = v_device_id
    RETURNING * INTO v_after;

    v_changed := v_before.cell_id IS DISTINCT FROM v_after.cell_id
              OR v_before.location_scope IS DISTINCT FROM v_after.location_scope;

    -- A move that changes nothing is COUNTED, but not called applied. The audit trigger already
    -- suppresses the no-op row -- `to_jsonb(NEW) - 'last_heartbeat' IS NOT DISTINCT FROM OLD` in
    -- 0005 -- so reporting it as applied would promise a thread row that deliberately does not
    -- exist. Dragging a device back where it started is the ordinary way this arises.
    IF v_changed THEN
      v_applied := v_applied + 1;
    ELSE
      v_unchanged := v_unchanged + 1;
    END IF;

    v_results := v_results || jsonb_build_object(
      'device_id',      v_after.id,
      'cell_id',        v_after.cell_id,
      'location_scope', v_after.location_scope,
      'changed',        v_changed
    );
  END LOOP;

  RETURN jsonb_build_object(
    -- REPORTED, NOT GENERATED. This is the transaction the UPDATEs above ran in, which is the
    -- same number `log_digital_thread_event()` stamped on every row it wrote -- so a caller can
    -- follow it straight into the Digital Thread's "Same transaction" view. NULL when nothing
    -- changed, because the trigger then wrote no row at all: handing back a transaction id with
    -- no rows under it would be a link to an empty result.
    'causation_id', CASE WHEN v_applied > 0 THEN txid_current() ELSE NULL END,
    'requested',    v_len,
    'applied',      v_applied,
    'unchanged',    v_unchanged,
    'devices',      v_results
  );
END;
$fn$;

COMMENT ON FUNCTION public.relocate_devices(p_moves jsonb) IS
  'Apply a batch of device relocations in ONE transaction, so the whole rearrangement shares a '
  'single digital_thread causation_id. Refuses the batch outright on an unknown device, an '
  'unknown cell, a duplicate device or a missing location_scope -- a half-applied batch is the '
  'failure mode this exists to remove. Authority: Administrator or Shopfloor_Manager.';


-- ---------------------------------------------------------------------------------------------
-- 2. Grants
-- ---------------------------------------------------------------------------------------------
-- REVOKE FIRST, AND THAT IS NOT BOILERPLATE. This database carries a `supabase_admin` DEFAULT ACL
-- granting EXECUTE on every new public function to anon, authenticated AND service_role, so the
-- GRANT below is additive and only the REVOKE narrows anything. 0031 shipped exactly that bug on
-- `system_settings_stamp()`, and validate.py's anon-privilege baseline is what caught it.
--
-- The function checks `has_role()` itself, so anon EXECUTE would not actually move a device --
-- but it would let an unauthenticated caller probe device and cell existence apart through the
-- distinct error codes above, and "it fails safe anyway" is not a reason to publish an entry
-- point to an unauthenticated role.
REVOKE ALL ON FUNCTION public.relocate_devices(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.relocate_devices(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.relocate_devices(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.relocate_devices(jsonb) TO service_role;


-- ---------------------------------------------------------------------------------------------
-- 3. Self-check
-- ---------------------------------------------------------------------------------------------
-- The property worth asserting on every boot is not "the function exists" -- `CREATE OR REPLACE`
-- above already guarantees that -- it is THAT A BATCH SHARES ONE CAUSATION. That depends on a
-- trigger declared in a different file, which a later migration could re-declare without
-- stamping causation at all (0026's own self-check exists for the same reason). So this moves two
-- real devices, reads the thread back, and rolls the whole thing away.
--
-- IT HAS TO BORROW A JWT TO DO IT. `has_role()` resolves `auth.uid()` out of
-- `request.jwt.claims` and has NO superuser escape hatch -- a migration runs as `postgres` with
-- no claims at all, so calling the RPC directly here would raise insufficient_privilege and fail
-- the boot. So the check adopts a seeded Administrator for the duration, and the borrowing is
-- bounded twice over: `set_config(..., is_local := true)` is reverted when the subtransaction
-- below aborts, and it is cleared again explicitly afterwards. A claim leaking past this block
-- would attribute every later migration's writes to that operator.
--
-- ONLY `request.jwt.claims` is set, never the pre-v10 `request.jwt.claim.sub`. PostgREST 12.2
-- sets only the former, and a fixture that sets both is how 0031's `updated_by` bug stayed hidden
-- through a passing test.
DO $selfcheck$
DECLARE
    v_ids        uuid[];
    v_cell       uuid;
    v_admin      text;
    v_result     jsonb;
    v_causations bigint[];
    v_watermark  bigint;
    v_anon_exec  boolean;
BEGIN
    -- anon must not hold EXECUTE. Checked here rather than trusted, because the REVOKE above is
    -- narrowing a DEFAULT ACL rather than declining to grant -- if that ACL ever changes shape,
    -- the REVOKE is what stops being sufficient, and nothing else in this file would notice.
    SELECT has_function_privilege('anon', 'public.relocate_devices(jsonb)', 'EXECUTE')
      INTO v_anon_exec;
    IF v_anon_exec THEN
        RAISE EXCEPTION
          '0033 self-check: anon holds EXECUTE on relocate_devices(). The REVOKE did not take, '
          'and an unauthenticated caller can probe the device and cell tables through its error '
          'codes.';
    END IF;

    SELECT id INTO v_cell FROM public.cells ORDER BY id LIMIT 1;

    -- `cell_id IS DISTINCT FROM v_cell`, SO BOTH MOVES ARE GUARANTEED TO CHANGE SOMETHING. The
    -- first version of this took the two lowest device ids outright, and the lowest one was
    -- already sitting in the lowest cell -- so its move was a correctly-reported no-op, the batch
    -- applied 1 of 2, and the causation assertion below would have been reading a SINGLE row's
    -- thread entry while claiming to prove that two rows share one transaction. That is the
    -- vacuous pass this whole check exists to avoid, and it was the check itself that caught it.
    SELECT array_agg(id) INTO v_ids FROM (
        SELECT id FROM public.devices WHERE cell_id IS DISTINCT FROM v_cell ORDER BY id LIMIT 2
    ) d;

    -- JOINED TO auth.users, NOT JUST user_roles, and that join is the whole fixture. `user_roles`
    -- carries rows for subjects that do not exist in `auth.users` -- the RLS suites self-seed
    -- their own personas there precisely because CI never runs seed.sql -- while
    -- `digital_thread.changed_by` is FK'd to `auth.users`. Borrowing one of those identities makes
    -- the trigger's own INSERT violate the foreign key, which fails the migration inside the
    -- audit path rather than in this check, with a message about a constraint. Found by running
    -- it: the first spelling picked 44444444-... and did exactly that.
    SELECT ur.user_id INTO v_admin
      FROM public.user_roles ur
      JOIN public.roles r ON r.id = ur.role_id
      JOIN auth.users u ON u.id::text = ur.user_id
     WHERE r.name = 'Administrator'
     ORDER BY ur.user_id
     LIMIT 1;

    -- A database with fewer than two devices, no cell, or no Administrator has nothing to
    -- exercise this against. SKIPPED RATHER THAN FAILED, because the migrations run before the
    -- seed on every path -- CI's RLS job applies them and deliberately never runs seed.sql -- and
    -- a self-check that fails on an empty database blocks the boot that would populate it.
    IF v_ids IS NULL OR array_length(v_ids, 1) < 2 OR v_cell IS NULL OR v_admin IS NULL THEN
        RAISE NOTICE '0033 self-check skipped: needs two devices, one cell and a seeded '
                     'Administrator to exercise a batch.';
        RETURN;
    END IF;

    BEGIN
        PERFORM set_config('request.jwt.claims',
                           json_build_object('sub', v_admin, 'role', 'authenticated')::text,
                           true);

        -- Taken IMMEDIATELY before the call and inside the same subtransaction, so every row the
        -- batch appends is above it and nothing that preceded it can be.
        SELECT coalesce(max(id), 0) INTO v_watermark FROM public.digital_thread;

        -- Both to the same cell, which neither of them is in. Two rows must change, so neither
        -- can be a no-op the trigger suppresses.
        SELECT public.relocate_devices(jsonb_build_array(
            jsonb_build_object('device_id', v_ids[1], 'cell_id', v_cell, 'location_scope', 'cell'),
            jsonb_build_object('device_id', v_ids[2], 'cell_id', v_cell, 'location_scope', 'cell')
        )) INTO v_result;

        IF (v_result ->> 'applied')::int <> 2 THEN
            RAISE EXCEPTION
              '0033 self-check: expected 2 applied moves, got %. The batch reported %',
              v_result ->> 'applied', v_result;
        END IF;

        -- THE ACTUAL POINT. Two devices, two thread rows, ONE causation_id -- read from the audit
        -- table rather than from the function's own return value, which could report a shared
        -- transaction while the trigger stamped nothing.
        --
        -- BOUNDED BY A WATERMARK, NOT BY A TIME WINDOW, and the difference is not academic. This
        -- read `recorded_at > now() - interval '1 minute'`, which is a guess at "rows this batch
        -- just wrote" and holds only while nothing else has touched these devices lately. Roadmap
        -- §14 made that assumption false: the demonstration floor is opt-in now, so the documented
        -- way to get one is `npm run provision:gateways` followed by a restart -- which means
        -- db-init reaches this check seconds after six devices were CREATED, with their INSERT and
        -- placement rows still inside the window and each carrying its own causation_id.
        --
        -- It fails loudly and blames the wrong thing: "relocate_devices() is no longer one
        -- transaction", on a stack where it is, because the check counted four causation ids and
        -- two of them belonged to provisioning. Bounding on the sequence instead asks the question
        -- the check means to ask -- rows written AFTER the call -- and cannot be widened by
        -- anything that happened before it.
        SELECT array_agg(DISTINCT causation_id) INTO v_causations
          FROM public.digital_thread
         WHERE entity_id = ANY(v_ids)
           AND id > v_watermark
           AND causation_id IS NOT NULL;

        IF v_causations IS NULL OR array_length(v_causations, 1) <> 1 THEN
            RAISE EXCEPTION
              '0033 self-check: a two-device batch produced % distinct causation_id(s), expected '
              'exactly 1. relocate_devices() is no longer one transaction, or '
              'log_digital_thread_event() has been re-declared without stamping causation -- see '
              '0026.', COALESCE(array_length(v_causations, 1), 0);
        END IF;

        IF v_causations[1] IS DISTINCT FROM (v_result ->> 'causation_id')::bigint THEN
            RAISE EXCEPTION
              '0033 self-check: the batch reported causation_id % but the thread rows carry %. '
              'The returned id must be the one an operator can follow into the thread.',
              v_result ->> 'causation_id', v_causations[1];
        END IF;

        RAISE EXCEPTION 'rollback_selfcheck';
    EXCEPTION
        WHEN raise_exception THEN
            -- The borrowed claim is already gone here -- aborting this subtransaction reverts a
            -- local set_config along with the row changes -- but it is cleared again below
            -- regardless. Correctness of every migration after this one should not rest on a
            -- subtlety of when Postgres unwinds a GUC.
            IF SQLERRM <> 'rollback_selfcheck' THEN
                PERFORM set_config('request.jwt.claims', '', true);
                RAISE;
            END IF;
    END;

    PERFORM set_config('request.jwt.claims', '', true);

    RAISE NOTICE '0033 self-check passed: a two-device batch shares one causation_id.';
END;
$selfcheck$;
