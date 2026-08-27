-- =============================================================================================
-- 0046 · `Service_Ingestor`, the identity the ingestion daemon will hold. Roadmap §16.
-- =============================================================================================
-- §13 specified three identity profiles and shipped the mechanism for two. This is the third, and
-- §13's own text flagged it as different in kind: "`Service_Ingestor` is the genuinely new one --
-- and note it does not describe the current daemon, which holds the service-role key and writes
-- telemetry directly."
--
-- THIS MIGRATION CHANGES NOTHING ABOUT THE RUNNING DAEMON. It creates an identity and nothing
-- holds it yet. That is deliberate, and it is the answer to §16's third open question -- "what
-- happens to a deployed daemon mid-upgrade, since the credential it holds is in its environment
-- and the RPCs it would need do not exist until the migration runs." The sequence is: this
-- identity, then the write RPCs, then the daemon calling them while still holding the service key,
-- and only then the credential swap. At every step a deployed daemon keeps working, because
-- nothing it depends on is removed until after it has stopped depending on it.
--
-- ---------------------------------------------------------------------------------------------
-- WHY AN `auth.users` PRINCIPAL RATHER THAN A POSTGRES ROLE THE DAEMON CONNECTS AS
--
-- Both would work, and the Postgres role is arguably tighter -- table privileges instead of RLS,
-- no PostgREST hop, no token to expire. It was rejected for what it cannot do rather than for what
-- it costs: a Postgres role is invisible to everything §13 built. It does not appear in
-- `list_service_principals()` (0042), no token against it can be recorded by
-- `record_service_token_issued()` (0043), and the Access Control page cannot show it. The stack
-- would then have two trust paths for machine identity, one auditable from the dashboard and one
-- auditable only by reading `pg_roles` over a psql session.
--
-- It would also mean the daemon talks to Postgres two different ways -- as a Postgres role for
-- Supabase writes, and over its own connection for telemetry -- which reads as one pattern and is
-- two.
--
-- ---------------------------------------------------------------------------------------------
-- WHY `Operator`, WHICH LOOKS LIKE IT CANNOT POSSIBLY BE ENOUGH
--
-- It is not enough, and that is the design rather than an oversight. 0034 already recorded the
-- fact this rests on: "every write policy in this schema names Administrator or
-- Shopfloor_Manager". So an Operator principal can read the device and gateway rows the daemon
-- resolves against and write NONE of them. Every write it needs goes through a SECURITY DEFINER
-- function that pins the actor and validates its arguments -- the shape
-- `record_ingestion_rejection()` (0026) established when it replaced `service_role`'s direct
-- INSERT on the audit table.
--
-- That is the whole point of the item. A credential that could perform the daemon's writes by
-- holding a role that permits them would be a smaller `service_role`, not a narrower one: it could
-- still write anything that role can write, to any row, in any shape. A credential that can
-- perform them only by calling a fixed set of functions can do exactly that many things.
--
-- `Operator` is also the ceiling `create_service_principal()` (0044) will grant -- it refuses
-- Administrator and Shopfloor_Manager outright -- so choosing it keeps this principal inside the
-- envelope the Access Control page can already create and describe. An identity seeded here that
-- the page could not have made would be a second class of machine identity.
--
-- WHY NOT `Auditor`, which is the same question 0034 answered for the MCP client, with the same
-- answer. The difference between the two is `digital_thread_select_privileged_or_auditor` (0001):
-- an Auditor can READ the audit trail. The daemon writes to that table -- through
-- `record_ingestion_rejection()`, which is SECURITY DEFINER and therefore needs nothing from the
-- caller's role -- and never reads it. Granting Auditor would hand a credential sitting in the
-- process most exposed to the plant network the ability to read every attributed change anyone has
-- ever made to this stack, in support of a code path that does not exist.
--
-- ---------------------------------------------------------------------------------------------
-- WHY SEEDED HERE RATHER THAN CREATED THROUGH `create_service_principal()`
--
-- 0034's reason applies unchanged: "CI's RLS job applies the migrations and deliberately never
-- runs the seed, so a principal defined there would not exist in the environment where its
-- privileges are tested." The self-check at the bottom of this file is that test, and it can only
-- run against an identity the migration itself created.
--
-- There is a second reason particular to this one. 0044 exists so an ADMINISTRATOR can mint a
-- machine identity as an act with an audit trail. This identity is not an operator's choice -- the
-- stack does not function without an ingestion daemon, and the daemon does not function without
-- something to authenticate as. A fixed part of the deployment belongs in a migration; a thing
-- somebody decided to create belongs behind the page that records who decided it.
-- =============================================================================================

SET search_path TO public;


-- ---------------------------------------------------------------------------------------------
-- 1. The principal
-- ---------------------------------------------------------------------------------------------
-- The id continues 0034's block rather than starting a new one: `...0001` is the MCP reader,
-- `...0002` is this. Both are seeded machine identities that cannot sign in, and keeping them
-- adjacent means a reader who finds one in a JWT `sub` can find the other.
--
-- Minimal by construction, exactly as 0034 and 0044 are: no email, no password, no identity
-- provider. THIS ACCOUNT CANNOT SIGN IN. It also means 0042's predicate -- no email and no
-- password -- holds for it, so it appears in the Service Identities list on the Access Control
-- page beside the identities that page created itself.
INSERT INTO auth.users (id)
VALUES ('b0000000-0000-4000-8000-000000000002')
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
    v_operator integer;
BEGIN
    -- BY NAME, not by a hardcoded id -- 0034's reason: `roles.id` is an integer assigned by 0001,
    -- and a migration that hardcodes it is asserting a fact about a sequence.
    SELECT id INTO v_operator FROM public.roles WHERE name = 'Operator';
    IF v_operator IS NULL THEN
        RAISE EXCEPTION '0046: the Operator role is missing; 0001 did not run cleanly.';
    END IF;

    INSERT INTO public.user_roles (user_id, role_id)
    VALUES ('b0000000-0000-4000-8000-000000000002', v_operator)
    ON CONFLICT (user_id, role_id) DO NOTHING;
END $$;

COMMENT ON TABLE public.user_roles IS
  'Role assignment per auth user. Includes two seeded machine principals that cannot sign in: '
  'b0000000-0000-4000-8000-000000000001, the read-only principal the MCP client authenticates as '
  '(0034), and b0000000-0000-4000-8000-000000000002, Service_Ingestor, the identity the ingestion '
  'daemon authenticates as (0046). Both hold Operator and write nothing directly.';


-- ---------------------------------------------------------------------------------------------
-- 2. Self-check
-- ---------------------------------------------------------------------------------------------
-- THE PROPERTY WORTH ASSERTING IS THE GAP: that this principal can read what the daemon resolves
-- against, and cannot perform a single one of the writes the daemon makes. If that gap ever closes
-- -- because a write policy is widened to admit Operator -- then the RPCs stop being the only
-- route in, and this credential silently becomes as wide as the role. That is the failure mode the
-- whole item exists to prevent, and nothing else in the schema would report it.
--
-- Exercised as a real `authenticated` session with only `request.jwt.claims` set, for 0034's
-- reason: that is the single GUC PostgREST 12.2+ populates, and setting the pre-v10
-- `request.jwt.claim.sub` as well is how 0031's `updated_by` bug survived a passing test.
DO $selfcheck$
DECLARE
    v_principal CONSTANT text := 'b0000000-0000-4000-8000-000000000002';
    v_roles     text[];
    v_devices   integer;
    v_gateways  integer;
    v_rows      integer;
    v_denied    boolean;
BEGIN
    SELECT array_agg(r.name) INTO v_roles
      FROM public.user_roles ur
      JOIN public.roles r ON r.id = ur.role_id
     WHERE ur.user_id = v_principal;

    IF v_roles IS NULL OR NOT ('Operator' = ANY(v_roles)) THEN
        RAISE EXCEPTION '0046 self-check: Service_Ingestor does not hold Operator (holds %).',
                        COALESCE(array_to_string(v_roles, ','), 'nothing');
    END IF;

    IF 'Administrator' = ANY(v_roles) OR 'Shopfloor_Manager' = ANY(v_roles) OR 'Auditor' = ANY(v_roles) THEN
        RAISE EXCEPTION
          '0046 self-check: Service_Ingestor holds % -- a privileged or audit-reading role. This '
          'credential lives in the environment of the process most exposed to the plant network; '
          'every write it needs goes through a SECURITY DEFINER function precisely so that the '
          'role it holds can stay unable to write.', array_to_string(v_roles, ',');
    END IF;

    BEGIN
        PERFORM set_config('request.jwt.claims',
                           json_build_object('sub', v_principal, 'role', 'authenticated')::text,
                           true);
        SET LOCAL ROLE authenticated;

        -- It must be able to do its job. `resolve_device()` and `resolve_gateway()` in the daemon
        -- select from exactly these two relations, and a principal that cannot read them cannot
        -- resolve a wire identity to a row at all.
        SELECT count(*) INTO v_devices  FROM public.devices;
        SELECT count(*) INTO v_gateways FROM public.gateways;

        -- And none of the writes. A non-matching UPDATE affects ZERO ROWS WITHOUT ERRORING under
        -- RLS, so for the UPDATE paths the row count is the assertion -- an exception here would
        -- be the wrong shape of evidence.
        UPDATE public.devices SET status = 'OFFLINE' WHERE true;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows <> 0 THEN
            RAISE EXCEPTION
              '0046 self-check: Service_Ingestor updated % device row(s) directly. A write policy '
              'now admits Operator, so the ingestion write RPCs are no longer the only route in.',
              v_rows;
        END IF;

        UPDATE public.gateways SET name = name WHERE true;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows <> 0 THEN
            RAISE EXCEPTION
              '0046 self-check: Service_Ingestor updated % gateway row(s) directly. A write policy '
              'now admits Operator, so the ingestion write RPCs are no longer the only route in.',
              v_rows;
        END IF;

        -- INSERT is the other shape: a failed WITH CHECK RAISES rather than affecting zero rows,
        -- so here the ABSENCE of an exception is the failure. Nested, because 42501 is not P0001
        -- and would otherwise sail straight past the outer handler.
        v_denied := false;
        BEGIN
            INSERT INTO public.devices (name, status, is_quarantined)
            VALUES ('_ingestor_probe', 'ONLINE', true);
        EXCEPTION WHEN insufficient_privilege THEN
            v_denied := true;
        END;
        IF NOT v_denied THEN
            RAISE EXCEPTION
              '0046 self-check: Service_Ingestor inserted a device row directly. The quarantine '
              'insert is meant to be reachable only through its RPC, which pins is_quarantined and '
              'the identity source; a direct INSERT can set neither honestly.';
        END IF;

        v_denied := false;
        BEGIN
            -- `asset_config.asset_id` is text holding a `sparkplug_id`, not the device uuid --
            -- devices.sparkplug_id's own comment says so ("keys telemetry in TimescaleDB and
            -- birth parameters in asset_config"). Selecting `id` here would fail on the uuid/text
            -- mismatch, which is not the error this probe is looking for and would escape the
            -- handler below.
            INSERT INTO public.asset_config (asset_id, metric_name)
            SELECT sparkplug_id, '_ingestor_probe' FROM public.devices LIMIT 1;
        EXCEPTION WHEN insufficient_privilege THEN
            v_denied := true;
        END;
        -- LIMIT 1 over an empty `devices` inserts nothing and raises nothing, which is not
        -- evidence either way. Only assert when there was a row to insert against.
        IF NOT v_denied AND v_devices > 0 THEN
            RAISE EXCEPTION
              '0046 self-check: Service_Ingestor wrote asset_config directly. Birth parameters are '
              'meant to arrive only through their RPC.';
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

    RAISE NOTICE '0046 self-check passed: Service_Ingestor reads % device(s) and % gateway(s), and '
                 'cannot perform any of the daemon''s writes directly.', v_devices, v_gateways;
END;
$selfcheck$;
