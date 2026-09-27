-- =============================================================================================
-- Migration: 0010_a_metric_deprecation_reaches_the_thread.sql
-- Deprecating or restoring a metric is a Digital Thread event (#468)
-- =============================================================================================
--
-- `metric_catalog` carried no audit trigger, so a deprecation recorded neither who made it nor
-- when, and neither would its reversal. log_digital_thread_event() is attached for INSERT, UPDATE
-- and DELETE, as on `schemas`: deprecate and restore arrive as UPDATEs whose diff moves
-- `deprecated`, the way archive and restore arrive for the asset tables.
--
-- The rows go in the asset lane. Writing the catalog is Administrator-only, which the authority
-- rule would file as security, but every authenticated user reads the table: the exception
-- archived migration 0120 made for `schemas`. audit_domain_for() is 0001's with `metric_catalog`
-- added, and folds into it at the next squash.
--
-- Idempotent.
-- =============================================================================================

SET search_path TO public;

-- Rewritten in full because it is one CASE; the signature and return type are 0001's. Recorded in
-- check-docs-drift.mjs's INTENDED_REDECLARATIONS.
CREATE OR REPLACE FUNCTION public.audit_domain_for(p_entity_type text, p_action text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT CASE
    -- Identity and authority. Every act on these is Administrator-only to perform AND the table
    -- itself is Administrator-only to read, which is what makes the lane agree with its contents.
    WHEN p_entity_type IN ('service_principals', 'user_roles', 'system_settings')
      THEN 'security'

    -- The asset trail: the shopfloor's own history. CREDENTIAL_ISSUED lands here on `gateways`
    -- deliberately: a Manager may mint a host-run gateway's broker credential. `schemas` and
    -- `metric_catalog` are Administrator-only writes to tables every authenticated user reads.
    WHEN p_entity_type IN ('areas', 'cells', 'devices', 'gateways', 'links',
                           'schemas', 'device_nameplate', 'change_proposals',
                           'cell_links', 'gateway_links', 'device_links',
                           'metric_catalog')
      THEN 'asset'

    -- Fail-closed: a new entity_type nobody classified is restricted rather than exposed.
    ELSE 'security'
  END
$$;

ALTER FUNCTION public.audit_domain_for(p_entity_type text, p_action text) OWNER TO postgres;

COMMENT ON FUNCTION public.audit_domain_for(p_entity_type text, p_action text) IS 'Which lane a digital_thread row belongs in. The rule is WHO MAY PERFORM the act, not what the act is about -- see 0070 -- with `schemas` (0120) and `metric_catalog` (0010) the exceptions, because their own tables are readable by every authenticated user. Unrecognised input is ''security'': the safe failure is a row a Shopfloor_Manager cannot see, not a privileged act they can.';

-- 0001's ACL, restated; CREATE OR REPLACE keeps it either way.
REVOKE ALL ON FUNCTION public.audit_domain_for(p_entity_type text, p_action text) FROM PUBLIC, anon;
GRANT ALL ON FUNCTION public.audit_domain_for(p_entity_type text, p_action text) TO service_role;

DROP TRIGGER IF EXISTS trg_metric_catalog_digital_thread ON public.metric_catalog;
CREATE TRIGGER trg_metric_catalog_digital_thread AFTER INSERT OR DELETE OR UPDATE ON public.metric_catalog FOR EACH ROW EXECUTE FUNCTION public.log_digital_thread_event();

-- A row written earlier in the same boot -- a seed in 0002 once this trigger exists -- was stamped
-- by 0001's classifier, which files `metric_catalog` as security. audit_domain is the routing this
-- file changes, not a fact about the act, and the append-only trigger exempts `postgres`, which
-- db-init applies the chain as. A settled database matches nothing.
UPDATE public.digital_thread
   SET audit_domain = 'asset'
 WHERE entity_type = 'metric_catalog'
   AND audit_domain IS DISTINCT FROM 'asset';

-- What this file did, and nothing wider: the lane it opened, the arms it copied, the trigger it
-- attached, and the metric_catalog rows it re-stamped.
DO $check$
DECLARE
    v_entity   text;
    v_stranded bigint;
BEGIN
    IF public.audit_domain_for('metric_catalog', 'UPDATE') <> 'asset' THEN
        RAISE EXCEPTION '0010 self-check: audit_domain_for(''metric_catalog'') is %, not asset.',
            public.audit_domain_for('metric_catalog', 'UPDATE');
    END IF;

    -- The CASE is a copy of 0001's, and an arm lost in a copy is silent.
    FOREACH v_entity IN ARRAY ARRAY['areas', 'cells', 'devices', 'gateways', 'links', 'schemas',
                                    'device_nameplate', 'change_proposals',
                                    'cell_links', 'gateway_links', 'device_links'] LOOP
        IF public.audit_domain_for(v_entity, 'UPDATE') <> 'asset' THEN
            RAISE EXCEPTION '0010 self-check: % left the asset lane.', v_entity;
        END IF;
    END LOOP;
    FOREACH v_entity IN ARRAY ARRAY['service_principals', 'user_roles', 'system_settings'] LOOP
        IF public.audit_domain_for(v_entity, 'UPDATE') <> 'security' THEN
            RAISE EXCEPTION '0010 self-check: % left the security lane.', v_entity;
        END IF;
    END LOOP;
    IF public.audit_domain_for('a_table_invented_later', 'INSERT') <> 'security' THEN
        RAISE EXCEPTION '0010 self-check: an unclassified entity type no longer fails closed.';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'trg_metric_catalog_digital_thread'
           AND tgrelid = 'public.metric_catalog'::regclass
           AND tgfoid = 'public.log_digital_thread_event()'::regprocedure
           AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION '0010 self-check: the metric_catalog audit trigger is not attached.';
    END IF;

    SELECT count(*) INTO v_stranded
      FROM public.digital_thread
     WHERE entity_type = 'metric_catalog'
       AND audit_domain IS DISTINCT FROM public.audit_domain_for(entity_type, action);
    IF v_stranded > 0 THEN
        RAISE EXCEPTION '0010 self-check: % metric_catalog audit row(s) are outside the asset lane.',
            v_stranded;
    END IF;
END
$check$;
