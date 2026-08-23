-- =============================================================================================
-- 0034 · A dedicated read-only principal for the MCP client
-- =============================================================================================
-- `i3x-mcp` takes a STATIC `I3X_TOKEN` out of its host's config file -- typically
-- `claude_desktop_config.json` -- and `GOTRUE_JWT_EXP` is 3600. A token pasted there stops working
-- within the hour, and it fails the way i3x/README.md already describes for i3X Explorer: as a
-- broken server rather than a stale credential. Nothing in the failure points at the token, which
-- is what made this worth fixing rather than documenting.
--
-- THIS MIGRATION DOES NOT MINT ANYTHING. It creates the IDENTITY the token will name.
-- `scripts/mint-mcp-token.mjs` signs a long-lived JWT for it with the same HS256 secret the rest of
-- the stack uses, so PostgREST validates it exactly as it validates a GoTrue token. The expiry is a
-- property of the token, not of this row -- GOTRUE_JWT_EXP governs what GoTrue issues and has no
-- bearing on a JWT signed outside it.
--
-- WHY NOT `service_role`, which would be the one-line answer. The i3X server passes the caller's
-- bearer straight through to PostgREST precisely so that it queries AS THEM. A key that bypasses
-- RLS would discard the single property that makes handing this to a model defensible -- that a
-- question answered through MCP returns exactly what the asker is entitled to see. It would also
-- make every read indistinguishable from the ingestion daemon's.
--
-- WHY NOT ONE OF THE DEMO PERSONAS either. A machine credential borrowing a human account conflates
-- two lifecycles: the account gets deleted when the person leaves, and the audit trail attributes
-- machine reads to somebody who was not there.
--
-- WHY `Operator` AND NOT `Auditor`, WHICH IS THE INTERESTING CHOICE. Both write nothing -- every
-- write policy in this schema names Administrator or Shopfloor_Manager. The difference is
-- `digital_thread_select_privileged_or_auditor` (0001): an Auditor can READ THE AUDIT TRAIL.
--
-- The MCP client has no surface for the Digital Thread and deliberately never will -- i3X models
-- objects, values and history and has no audit concept, and the decision not to build a second
-- server for it is recorded in i3x/README.md. So granting Auditor would hand this credential a
-- capability nothing can use, and leave it sitting there for whoever DOES later point something at
-- it. Operator reads every relation the address space is assembled from -- all five are
-- `FOR SELECT TO authenticated USING (true)` -- and reaches nothing else.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. The principal
-- ---------------------------------------------------------------------------------------------
-- `id` is the only column on this image's `auth.users` without a default, which is what makes
-- seeding one here viable at all -- and is why this lives in a migration rather than in seed.sql.
-- CI's RLS job applies the migrations and deliberately never runs the seed, so a principal defined
-- there would not exist in the environment where its privileges are tested.
--
-- The row is deliberately minimal: no email, no password, no identity provider. THIS ACCOUNT
-- CANNOT SIGN IN. It exists so that a subject in a JWT resolves to something real, and so that
-- `digital_thread.changed_by` has a foreign key to satisfy in the event that anything ever writes
-- as it -- which nothing should, and which the self-check below proves nothing can.
INSERT INTO auth.users (id)
VALUES ('b0000000-0000-4000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
    v_operator integer;
BEGIN
    -- BY NAME, not by a hardcoded id. `roles.id` is an integer assigned by 0001, and a migration
    -- that hardcodes it is asserting a fact about a sequence.
    SELECT id INTO v_operator FROM public.roles WHERE name = 'Operator';
    IF v_operator IS NULL THEN
        RAISE EXCEPTION '0034: the Operator role is missing; 0001 did not run cleanly.';
    END IF;

    INSERT INTO public.user_roles (user_id, role_id)
    VALUES ('b0000000-0000-4000-8000-000000000001', v_operator)
    ON CONFLICT (user_id, role_id) DO NOTHING;
END $$;

COMMENT ON TABLE public.user_roles IS
  'Role assignment per auth user. Includes b0000000-0000-4000-8000-000000000001, the read-only '
  'principal the MCP client authenticates as -- see 0034.';


-- ---------------------------------------------------------------------------------------------
-- 2. Self-check
-- ---------------------------------------------------------------------------------------------
-- THE PROPERTY WORTH ASSERTING IS WHAT THIS PRINCIPAL CANNOT DO. That it exists is guaranteed by
-- the INSERT above; that it stays harmless is not, because a later migration could add the
-- Operator role to a write policy without anyone connecting that change to a credential pasted
-- into a desktop config file somewhere.
--
-- Exercised as a real `authenticated` session with only `request.jwt.claims` set -- the single GUC
-- PostgREST 12.2+ populates. Setting the pre-v10 `request.jwt.claim.sub` as well is how 0031's
-- `updated_by` bug survived a passing test, so it is deliberately not set.
DO $selfcheck$
DECLARE
    v_principal CONSTANT text := 'b0000000-0000-4000-8000-000000000001';
    v_roles     text[];
    v_readable  integer;
    v_thread    integer;
BEGIN
    SELECT array_agg(r.name) INTO v_roles
      FROM public.user_roles ur
      JOIN public.roles r ON r.id = ur.role_id
     WHERE ur.user_id = v_principal;

    IF v_roles IS NULL OR NOT ('Operator' = ANY(v_roles)) THEN
        RAISE EXCEPTION '0034 self-check: the MCP principal does not hold Operator (holds %).',
                        COALESCE(array_to_string(v_roles, ','), 'nothing');
    END IF;

    IF 'Administrator' = ANY(v_roles) OR 'Shopfloor_Manager' = ANY(v_roles) OR 'Auditor' = ANY(v_roles) THEN
        RAISE EXCEPTION
          '0034 self-check: the MCP principal holds % -- a privileged or audit-reading role. This '
          'credential is signed with a long expiry and pasted into a desktop config file; it must '
          'reach nothing beyond the i3X address space.', array_to_string(v_roles, ',');
    END IF;

    BEGIN
        PERFORM set_config('request.jwt.claims',
                           json_build_object('sub', v_principal, 'role', 'authenticated')::text,
                           true);
        SET LOCAL ROLE authenticated;

        -- It must be able to do its job.
        SELECT count(*) INTO v_readable FROM public.devices;

        -- And nothing else. A non-matching UPDATE affects ZERO ROWS WITHOUT ERRORING under RLS, so
        -- the row count is the assertion -- an exception here would be the wrong shape of evidence.
        UPDATE public.devices SET name = name || '_mcp_probe' WHERE true;
        GET DIAGNOSTICS v_thread = ROW_COUNT;
        IF v_thread <> 0 THEN
            RAISE EXCEPTION
              '0034 self-check: the MCP principal updated % device row(s). A write policy now '
              'admits Operator, and a long-lived credential in a config file can reach it.', v_thread;
        END IF;

        -- The audit trail is out of reach, which is the point of choosing Operator over Auditor.
        SELECT count(*) INTO v_thread FROM public.digital_thread;
        IF v_thread <> 0 THEN
            RAISE EXCEPTION
              '0034 self-check: the MCP principal read % digital_thread row(s). Operator was chosen '
              'over Auditor precisely so it could not.', v_thread;
        END IF;

        RESET ROLE;
        PERFORM set_config('request.jwt.claims', '', true);
        RAISE EXCEPTION 'rollback_selfcheck';
    EXCEPTION
        WHEN raise_exception THEN
            RESET ROLE;
            PERFORM set_config('request.jwt.claims', '', true);
            IF SQLERRM <> 'rollback_selfcheck' THEN RAISE; END IF;
    END;

    RAISE NOTICE '0034 self-check passed: the MCP principal reads the address space (% devices), '
                 'writes nothing, and cannot see the audit trail.', v_readable;
END;
$selfcheck$;
