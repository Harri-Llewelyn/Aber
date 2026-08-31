-- =============================================================================================
-- Migration: 0070_audit_domain_and_the_acts_nothing_recorded.sql
-- The digital thread gains a security lane, and starts recording the acts that make one necessary
-- =============================================================================================
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- ---------------------------------------------------------------------------------------------
-- TWO GAPS, AND THEY ARE THE SAME GAP FROM OPPOSITE ENDS
--
-- 1. NOTHING RECORDED A ROLE GRANT. `log_digital_thread_event()` is attached to `cells`, `devices`
--    and `gateways` and to nothing else, so an account becoming an Administrator left no row
--    anywhere -- including the account that became one on the boot `0069` landed. Neither did a
--    change to `system_settings`, which is where the archive switch and the retention windows live.
--
-- 2. EVERY PRIVILEGED ROW IT DID RECORD WAS READABLE BY EVERYONE PRIVILEGED.
--    `digital_thread_select_privileged_or_auditor` grants Administrator, Shopfloor_Manager AND
--    Auditor read over the whole table, so a Manager could read every service principal created
--    and every token minted for one -- both Administrator-only acts (`0042`, `0044`).
--
-- Fixing 1 without 2 makes it worse: it would add role grants to a table a Shopfloor_Manager can
-- read in full. So the lane and the coverage land together.
--
-- ---------------------------------------------------------------------------------------------
-- ONE TABLE, BECAUSE `causation_id` CANNOT CROSS TWO
--
-- The tempting shape is a second table -- a security log beside the asset log, with its own
-- policies. `causation_id` links the rows written by a single act and can only do that within one
-- table, and a privileged act and its asset consequences are routinely the same act. Splitting the
-- store breaks every chain that crosses the boundary and buys a second copy of `0003`'s
-- immutability trigger to keep in step. So: one table, one column, a policy per domain.
--
-- ---------------------------------------------------------------------------------------------
-- THE DOMAIN IS STAMPED BY TRIGGER, NEVER SUPPLIED BY A CALLER
--
-- Nine writers insert into this table today -- the audit trigger plus eight RPCs -- and asking each
-- to pass a domain is asking nine call sites to agree forever, with the failure being a security
-- row filed as an asset row and read by a role that should not see it. A BEFORE INSERT trigger
-- stamping it from one closed function means every existing writer is classified without being
-- touched, and a writer added later cannot forget.
--
-- IT IS FAIL-CLOSED. An (entity_type, action) the classifier does not recognise is 'security'. The
-- two failures are not symmetrical: an unclassified ASSET row is one a Shopfloor_Manager cannot see
-- -- visible, complained about, corrected in a line -- while an unclassified SECURITY row is a
-- privileged act sitting in a lane a Manager reads, silently, which is the thing this migration
-- exists to prevent.
--
-- ---------------------------------------------------------------------------------------------
-- THE RULE IS AUTHORITY, NOT SUBJECT MATTER, AND README §22 SAID OTHERWISE
--
-- That entry names `CREDENTIAL_ISSUED` alongside `TOKEN_MINTED` as rows a Shopfloor_Manager should
-- not read. Followed literally it contradicts the entry's own sequencing argument -- *"who may
-- perform a privileged act" and "who may read that it happened" become the same set* -- because
-- `0041` admits a Shopfloor_Manager to `issue_virtual_gateway_credential()`. A Manager would mint a
-- broker credential and watch the record of it vanish, which is not an honest empty lane: those
-- rows are their own acts.
--
-- So the domain follows WHO MAY PERFORM THE ACT:
--
--     security   service_principals   Administrator-only to create (0042, 0044) and to mint for
--                user_roles           who holds which role
--                system_settings      Administrator-only for read AND write (0031)
--                schemas              `schema:manage` became Administrator-only in 0069
--     asset      cells, devices,      Shopfloor_Manager's own work, CREDENTIAL_ISSUED included
--                gateways, links
--
-- The README is corrected to match rather than the code bent to fit it.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT IS NOT BACKFILLED, AND WHY THAT IS THE HONEST ANSWER
--
-- Existing ROWS are classified -- they carry an entity_type and an action, which is all the
-- classifier reads. Existing GRANTS are not: `user_roles` holds who currently holds what and says
-- nothing about when it was granted or by whom, so a backfill would have to invent a
-- `recorded_at` and an actor. `0031` sets the bar at *"a half-legible audit entry is worse than an
-- absent one, because it looks like the feature works"*, and a fabricated timestamp is worse than
-- half-legible. The trail starts when the trigger does.
--
-- THE BACKFILL IS AN UPDATE ON AN APPEND-ONLY TABLE, which works for one stated reason:
-- `enforce_digital_thread_append_only()` exempts `postgres` and `supabase_admin`, and db-init is
-- one of them. It is not an exception being taken quietly -- 0003's header says that exemption
-- exists because *"clearing audit rows is an act that should require the same authority as
-- dropping a table"*, and a migration holds exactly that authority.
--
-- Related: 0001 (the trigger and the table), 0003 (immutability), 0005/0026 (attribution and
--          causation), 0031 (system_settings), 0041/0043/0044/0062 (the direct writers),
--          0069 (the role split this depends on), README.md §22.
-- =============================================================================================

SET search_path TO public;

-- ---------------------------------------------------------------------------------------------
-- 1. The rule, in one place
-- ---------------------------------------------------------------------------------------------
-- IMMUTABLE because it is a pure lookup over two text values, which lets the CHECK constraint and
-- the policies below reference it without a per-row function call becoming the page's cost.
--
-- ENTITY TYPE FIRST, ACTION SECOND. Only one case needs the action at all today, and it is the one
-- the README got wrong -- so the action arm exists to be READ, as the place where "is this act
-- privileged" is decided when the table alone cannot say.
CREATE OR REPLACE FUNCTION public.audit_domain_for(p_entity_type text, p_action text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    -- Identity and authority. Every act on these is Administrator-only to perform, so it is
    -- Administrator-and-Auditor to read.
    WHEN p_entity_type IN ('service_principals', 'user_roles', 'system_settings')
      THEN 'security'

    -- The asset trail: the shopfloor's own history, which is what a Shopfloor_Manager manages.
    -- CREDENTIAL_ISSUED lands here on `gateways` deliberately -- see the header. A Manager may
    -- mint a virtual gateway's broker credential, so a Manager may read that one was minted.
    WHEN p_entity_type IN ('cells', 'devices', 'gateways', 'links')
      THEN 'asset'

    -- FAIL-CLOSED. A new entity_type nobody classified is restricted rather than exposed. The
    -- cost is a lane a Manager cannot see and will report; the alternative is a privileged act
    -- they can, and will not.
    ELSE 'security'
  END
$$;

COMMENT ON FUNCTION public.audit_domain_for(text, text) IS
  'Which lane a digital_thread row belongs in. The rule is WHO MAY PERFORM the act, not what the '
  'act is about -- see 0070. Unrecognised input is ''security'': the safe failure is a row a '
  'Shopfloor_Manager cannot see, not a privileged act they can.';

-- ---------------------------------------------------------------------------------------------
-- 2. The column
-- ---------------------------------------------------------------------------------------------
-- Added nullable, backfilled, then constrained -- in that order, because the table is not empty on
-- any stack that has ever run and a NOT NULL with no default would fail on the existing rows.
ALTER TABLE public.digital_thread
  ADD COLUMN IF NOT EXISTS audit_domain text;

-- Idempotent by predicate rather than by claim: a replay matches no rows because the first run
-- stamped them all, and any row a hand-run script inserted without a domain is repaired here.
UPDATE public.digital_thread
   SET audit_domain = public.audit_domain_for(entity_type, action)
 WHERE audit_domain IS NULL;

ALTER TABLE public.digital_thread
  ALTER COLUMN audit_domain SET NOT NULL;

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'digital_thread_audit_domain_check'
       AND conrelid = 'public.digital_thread'::regclass
  ) THEN
    ALTER TABLE public.digital_thread
      ADD CONSTRAINT digital_thread_audit_domain_check
      CHECK (audit_domain IN ('asset', 'security'));
  END IF;
END;
$constraint$;

COMMENT ON COLUMN public.digital_thread.audit_domain IS
  'asset | security. Stamped by trg_digital_thread_stamp_domain from audit_domain_for(); callers '
  'do not supply it and cannot override it. Decides which SELECT policy admits the row.';

-- The policies filter on it, and this table is the one page an operator scrolls.
CREATE INDEX IF NOT EXISTS idx_digital_thread_domain
  ON public.digital_thread (audit_domain, recorded_at DESC);

-- ---------------------------------------------------------------------------------------------
-- 3. The stamp
-- ---------------------------------------------------------------------------------------------
-- OVERWRITES WHATEVER WAS SUPPLIED, rather than defaulting when NULL. A caller passing its own
-- domain is a caller classifying its own act, which is the assertion this design removes -- the
-- same reasoning that keeps `actor_source = 'user'` from being accepted off a request header.
CREATE OR REPLACE FUNCTION public.stamp_audit_domain()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  NEW.audit_domain := public.audit_domain_for(NEW.entity_type, NEW.action);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_digital_thread_stamp_domain ON public.digital_thread;
CREATE TRIGGER trg_digital_thread_stamp_domain
  BEFORE INSERT ON public.digital_thread
  FOR EACH ROW EXECUTE FUNCTION public.stamp_audit_domain();

-- ---------------------------------------------------------------------------------------------
-- 4. A policy per domain
-- ---------------------------------------------------------------------------------------------
-- TWO POLICIES, NOT ONE WITH A CASE. Multiple permissive policies for the same command are OR'd,
-- so this reads as two grants rather than one expression that has to stay correct in both arms --
-- and a reader of `\d digital_thread` sees the two lanes named.
--
-- AUDITOR STOPS BEING A SYNONYM HERE. The role holds one permission, `digital_thread:read`, and
-- until now did nothing a read-only Administrator could not. Reviewing privileged acts without
-- being able to perform them is separation of duties, which is what the role was named for.
DROP POLICY IF EXISTS digital_thread_select_privileged_or_auditor ON public.digital_thread;

DROP POLICY IF EXISTS digital_thread_select_asset ON public.digital_thread;
CREATE POLICY digital_thread_select_asset ON public.digital_thread
  FOR SELECT TO authenticated
  USING (
    audit_domain = 'asset'
    AND public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text, 'Auditor'::text])
  );

DROP POLICY IF EXISTS digital_thread_select_security ON public.digital_thread;
CREATE POLICY digital_thread_select_security ON public.digital_thread
  FOR SELECT TO authenticated
  USING (
    audit_domain = 'security'
    AND public.has_role(ARRAY['Administrator'::text, 'Auditor'::text])
  );

-- ---------------------------------------------------------------------------------------------
-- 5. The acts nothing recorded
-- ---------------------------------------------------------------------------------------------

-- `system_settings` carries a uuid `id`, so the generic trigger fits it unchanged. It is the
-- Administrator-only table `0031` built -- the archive switch, the retention windows -- and a
-- change to one of them is a change to what the stack does when nobody is watching.
--
-- TWO TRIGGERS, AND THE SPLIT IS THE POINT. `seed_setting()` rewrites every seeded row on every
-- boot with the values it already holds, and bumps `updated_at` doing it -- so the generic
-- function's own suppression, which compares the rows minus `last_heartbeat`, sees two rows that
-- differ and logs. `check-migration-idempotency.mjs` caught exactly that: six settings rows
-- appended as `migration` on a replay of a table that is append-only and cannot be pruned.
--
-- THE SUPPRESSION GOES IN A `WHEN` CLAUSE, NOT IN THE SHARED FUNCTION. Teaching
-- `log_digital_thread_event()` about `updated_at` would mean reproducing its whole body -- it is
-- redeclared five times already and the live copy is 0048's -- to give one table's churn column a
-- special case that every other table would then inherit silently. A trigger-level `WHEN` states
-- it where the column actually lives, and costs the shared function nothing.
--
-- `updated_by` rides with it: `0031` stamps it by trigger from the JWT, so a save that changes no
-- value still moves it, and a row recording that nothing changed is the half-legible entry 0031's
-- own header sets the bar against.
DROP TRIGGER IF EXISTS trg_system_settings_digital_thread ON public.system_settings;
CREATE TRIGGER trg_system_settings_digital_thread
  AFTER INSERT OR DELETE ON public.system_settings
  FOR EACH ROW EXECUTE FUNCTION public.log_digital_thread_event();

DROP TRIGGER IF EXISTS trg_system_settings_digital_thread_update ON public.system_settings;
CREATE TRIGGER trg_system_settings_digital_thread_update
  AFTER UPDATE ON public.system_settings
  FOR EACH ROW
  WHEN (
    (to_jsonb(NEW) - 'updated_at' - 'updated_by')
      IS DISTINCT FROM
    (to_jsonb(OLD) - 'updated_at' - 'updated_by')
  )
  EXECUTE FUNCTION public.log_digital_thread_event();

-- `schemas` is the third act §22 names, and it lands in the security lane by the classifier's
-- fall-through rather than by being listed: publishing a schema decides what ingestion accepts as
-- conformant, and `0069` made `schema:manage` Administrator-only. The fail-closed arm getting this
-- right on its own is the argument for having it.
--
-- ALREADY PARTLY RECORDED, WHICH IS WHY THE GAP IS NARROWER THAN "NOTHING". `publish_schema_version()`
-- rebinds every attached device, and `0001`'s comment says why that is where it belongs -- *"the
-- rebinding lands in the audit trail per device, which is where the history of 'what was this
-- machine judged against, when' belongs."* What was missing is the act itself: which version became
-- active, and who published it.
--
-- SAFE UNDER REPLAY because `log_digital_thread_event()` suppresses an UPDATE whose row is
-- unchanged, and `0019`/`0033` rewrite the seeded schemas by name on every boot with the same
-- values. `check-migration-idempotency.mjs` asserts a replay writes no `migration` rows, which is
-- what proves that rather than assumes it.
DROP TRIGGER IF EXISTS trg_schemas_digital_thread ON public.schemas;
CREATE TRIGGER trg_schemas_digital_thread
  AFTER INSERT OR UPDATE OR DELETE ON public.schemas
  FOR EACH ROW EXECUTE FUNCTION public.log_digital_thread_event();

-- `user_roles` needs its own, and the reason is structural rather than stylistic: it has NO `id`
-- COLUMN. Its primary key is (user_id, role_id) and `log_digital_thread_event()` reads `NEW.id` to
-- fill `entity_id`, so the generic trigger would fail on every grant with a column that does not
-- exist. `user_id` is `text` holding a uuid, and `digital_thread.entity_id` is `uuid`, so the cast
-- is the other thing this function exists to do.
--
-- NAMED ACTIONS rather than INSERT/DELETE, matching CREDENTIAL_ISSUED and TOKEN_MINTED: the raw
-- verb would say a row appeared in a join table, where what happened is that somebody became an
-- Administrator. `DIGITAL_THREAD_ACTIONS` in frontend/src/constants.js is the filter's allow-list
-- and carries both -- an action missing from it applies NO predicate and returns every kind of
-- event, which is the trap that constant's own comment records.
--
-- UPDATE IS RECORDED AS A GRANT. Both columns are the primary key, so an UPDATE is a different
-- grant rather than an edit of one; there is no third state to name.
CREATE OR REPLACE FUNCTION public.log_role_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_row     record;
  v_action  text;
  v_actor   uuid;
  v_source  text;
  v_role    text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := OLD;
    v_action := 'ROLE_REVOKED';
  ELSE
    v_row := NEW;
    v_action := 'ROLE_GRANTED';
  END IF;

  -- Attribution, the short form. The full ladder in `log_digital_thread_event()` distinguishes an
  -- ingestion write from an edge function by request header; neither ever touches this table.
  -- What reaches it is a person with a session, or a migration -- so the two arms that matter are
  -- `auth.uid()` and the role the statement is running as.
  v_actor := auth.uid();
  IF v_actor IS NOT NULL AND NOT public.is_machine_principal(v_actor) THEN
    v_source := 'user';
  ELSE
    -- `current_user` is the function OWNER inside a SECURITY DEFINER body -- always `postgres` --
    -- which is the bug 0026's header records as having labelled every ingestion write
    -- 'migration'. `role` is what PostgREST SET ROLEs to; a psql session never sets it and
    -- reports 'none', where `session_user` is the honest answer.
    v_role := NULLIF(current_setting('role', true), 'none');
    IF v_role IS NULL OR v_role = '' THEN
      v_role := session_user;
    END IF;
    v_source := CASE WHEN v_role IN ('postgres', 'supabase_admin') THEN 'migration' ELSE 'service' END;
  END IF;

  INSERT INTO public.digital_thread (
    entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
    causation_id, recorded_at
  ) VALUES (
    'user_roles',
    v_row.user_id::uuid,
    v_action,
    CASE WHEN TG_OP = 'DELETE'
      THEN jsonb_build_object('role_id', OLD.role_id,
                              'role', (SELECT name FROM public.roles WHERE id = OLD.role_id))
      ELSE NULL END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL
      ELSE jsonb_build_object('role_id', NEW.role_id,
                              'role', (SELECT name FROM public.roles WHERE id = NEW.role_id))
      END,
    v_actor,
    v_source,
    txid_current(),
    now()
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.log_role_assignment() IS
  'Audit trigger for public.user_roles. Separate from log_digital_thread_event() because that '
  'function reads NEW.id and user_roles has no id column -- its key is (user_id, role_id).';

DROP TRIGGER IF EXISTS trg_user_roles_digital_thread ON public.user_roles;
CREATE TRIGGER trg_user_roles_digital_thread
  AFTER INSERT OR UPDATE OR DELETE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.log_role_assignment();

-- ---------------------------------------------------------------------------------------------
-- 6. Self-check
-- ---------------------------------------------------------------------------------------------
DO $selfcheck$
DECLARE
  v_unstamped int;
  v_misfiled  int;
  v_policies  int;
  v_wide      text;
BEGIN
  SELECT count(*) INTO v_unstamped FROM public.digital_thread WHERE audit_domain IS NULL;
  IF v_unstamped > 0 THEN
    RAISE EXCEPTION '0070 self-check: % row(s) carry no audit_domain.', v_unstamped;
  END IF;

  -- EVERY ROW AGREES WITH THE CLASSIFIER, not merely "is not null". The trigger overwrites what a
  -- caller supplies, so a disagreement means a row was written before the trigger existed and the
  -- backfill missed it -- which would be a security act sitting in the asset lane.
  SELECT count(*) INTO v_misfiled
    FROM public.digital_thread
   WHERE audit_domain IS DISTINCT FROM public.audit_domain_for(entity_type, action);
  IF v_misfiled > 0 THEN
    RAISE EXCEPTION
      '0070 self-check: % row(s) disagree with audit_domain_for(). A row filed against the wrong '
      'lane is readable by the wrong role, which is the whole subject of this migration.',
      v_misfiled;
  END IF;

  -- The old single policy must be GONE, not merely joined. Permissive policies are OR''d, so
  -- leaving it in place would grant Shopfloor_Manager the security lane through the back door and
  -- every test below would still pass.
  SELECT string_agg(policyname, ', ') INTO v_wide
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'digital_thread'
     AND policyname NOT IN ('digital_thread_select_asset', 'digital_thread_select_security');
  IF v_wide IS NOT NULL THEN
    RAISE EXCEPTION
      '0070 self-check: digital_thread also carries %. Policies for one command are OR''d, so an '
      'extra one re-opens the security lane to whoever it names.', v_wide;
  END IF;

  SELECT count(*) INTO v_policies
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'digital_thread'
     AND cmd = 'SELECT'
     AND qual LIKE '%Shopfloor_Manager%'
     AND qual LIKE '%security%';
  IF v_policies > 0 THEN
    RAISE EXCEPTION
      '0070 self-check: a policy admits Shopfloor_Manager to the security lane.';
  END IF;

  IF to_regclass('public.digital_thread') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'public.user_roles'::regclass
          AND tgname = 'trg_user_roles_digital_thread'
     ) THEN
    RAISE EXCEPTION
      '0070 self-check: user_roles carries no audit trigger, so an account becoming an '
      'Administrator still leaves no row anywhere.';
  END IF;

  RAISE NOTICE
    '0070 self-check passed: every digital_thread row agrees with audit_domain_for(), the table '
    'carries exactly the two lane policies, and role grants and settings changes are recorded.';
END;
$selfcheck$;
