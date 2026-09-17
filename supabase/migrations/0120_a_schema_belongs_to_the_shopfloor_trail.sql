-- 0120: a schema change is a shopfloor event, so a Shopfloor_Manager can read one.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- `schemas` joins the asset lane of audit_domain_for(), so digital_thread_select_asset admits a
-- Shopfloor_Manager to it. Listed in neither arm before, it took the fail-closed 'security'
-- default while constants.js declares the kind an asset one -- so the page offered that role a
-- Schemas filter the policy could only answer empty.
--
-- The classifier's rule is who may PERFORM the act, and a schema is Administrator-only to write.
-- `schemas` is the exception because its own table is readable by every authenticated user, which
-- no other security lane is. The reasoning is in supabase/README.md, "The lane a Manager was
-- offered and denied".
--
-- The UPDATE below re-stamps rows already recorded: audit_domain is written once, at INSERT, so
-- they would otherwise keep 'security'. It is permitted because the append-only trigger exempts
-- `postgres`, which is the role db-init applies the chain as.

SET search_path TO public;

-- Rewritten in full because it is one CASE. CREATE OR REPLACE suffices: the argument list does not
-- change, so no second declaration is left standing. The chain replays in filename order and this
-- file is the last to declare it. Recorded in check-docs-drift.mjs's INTENDED_REDECLARATIONS.

CREATE OR REPLACE FUNCTION public.audit_domain_for(p_entity_type text, p_action text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
    -- Identity and authority. Every act on these is Administrator-only to perform AND the table
    -- itself is Administrator-only to read, which is what makes the lane agree with its contents.
    WHEN p_entity_type IN ('service_principals', 'user_roles', 'system_settings')
      THEN 'security'

    -- The asset trail: the shopfloor's own history. CREDENTIAL_ISSUED lands here on `gateways`
    -- deliberately: a Manager may mint a virtual gateway's broker credential. `schemas` joined in
    -- 0120 -- see the header for why an Administrator-only write is still an asset-lane record.
    WHEN p_entity_type IN ('areas', 'cells', 'devices', 'gateways', 'links',
                           'schemas', 'device_nameplate', 'change_proposals',
                           'cell_links', 'gateway_links', 'device_links')
      THEN 'asset'

    -- Fail-closed: a new entity_type nobody classified is restricted rather than exposed.
    ELSE 'security'
  END
$$;

COMMENT ON FUNCTION public.audit_domain_for(p_entity_type text, p_action text) IS
  'Which lane a digital_thread row belongs in. The rule is WHO MAY PERFORM the act, not what the act is about -- see 0070 -- with `schemas` the one exception 0120 makes, because its own table is readable by every authenticated user. Unrecognised input is ''security'': the safe failure is a row a Shopfloor_Manager cannot see, not a privileged act they can.';

-- Idempotent by the predicate: a replay updates nothing. Scoped to `schemas` rather than
-- re-stamping the table from audit_domain_for(), which would silently carry every later
-- reclassification as well.
UPDATE public.digital_thread
   SET audit_domain = 'asset'
 WHERE entity_type = 'schemas'
   AND audit_domain IS DISTINCT FROM 'asset';

-- Every lane is asserted, not just the one that moved: a rewritten CASE is a copy, and an arm lost
-- in a copy is silent. The last assertion is the invariant the UPDATE above exists to keep.
DO $check$
DECLARE
    v_entity  text;
    v_stranded bigint;
    v_moved    bigint;
BEGIN
    IF public.audit_domain_for('schemas', 'UPDATE') <> 'asset' THEN
        RAISE EXCEPTION
            '0120 self-check: audit_domain_for(''schemas'') is %, not asset -- the lane this file '
            'exists to open is still shut.', public.audit_domain_for('schemas', 'UPDATE');
    END IF;

    -- Every other lane is unmoved: naming each one tells "schemas moved" from "the asset arm was
    -- retyped".
    FOREACH v_entity IN ARRAY ARRAY['areas', 'cells', 'devices', 'gateways', 'links',
                                    'device_nameplate', 'change_proposals',
                                    'cell_links', 'gateway_links', 'device_links'] LOOP
        IF public.audit_domain_for(v_entity, 'UPDATE') <> 'asset' THEN
            RAISE EXCEPTION
                '0120 self-check: % left the asset lane.', v_entity;
        END IF;
    END LOOP;

    FOREACH v_entity IN ARRAY ARRAY['service_principals', 'user_roles', 'system_settings'] LOOP
        IF public.audit_domain_for(v_entity, 'UPDATE') <> 'security' THEN
            RAISE EXCEPTION
                '0120 self-check: % left the security lane.', v_entity;
        END IF;
    END LOOP;

    IF public.audit_domain_for('a_table_invented_later', 'INSERT') <> 'security' THEN
        RAISE EXCEPTION
            '0120 self-check: an unclassified entity type no longer fails closed.';
    END IF;

    -- The backfill reached everything. Asserted over the whole table, not over `schemas`: the
    -- invariant test_audit_domain.py holds is that no stored row disagrees with the classifier.
    SELECT count(*) INTO v_stranded
      FROM public.digital_thread
     WHERE audit_domain IS DISTINCT FROM public.audit_domain_for(entity_type, action);

    IF v_stranded > 0 THEN
        RAISE EXCEPTION
            '0120 self-check: % stored row(s) disagree with the classifier after the backfill -- '
            'a row in the wrong lane is readable by the wrong role.', v_stranded;
    END IF;

    SELECT count(*) INTO v_moved
      FROM public.digital_thread
     WHERE entity_type = 'schemas';

    RAISE NOTICE '0120: schemas is an asset lane; % recorded schema row(s) now read by '
                 'Shopfloor_Manager as well.', v_moved;
END
$check$;
