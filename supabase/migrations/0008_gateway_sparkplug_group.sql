-- =============================================================================================
-- Migration: 0008_gateway_sparkplug_group.sql
-- Make the Sparkplug Group ID part of a gateway's address
-- =============================================================================================
--
-- WHY. Ingestion parsed `spBv1.0/<group>/<type>/<node>/<device>` and never read the group at
-- all, so two groups publishing the same edge node id resolved to ONE row -- silently. Factory+
-- addresses an edge node as (group, node), which is why its Directory keys on
-- /v1/address/{group_id}/{node_id}, and this column is what lets that endpoint mean anything.
--
-- DEFAULT 'FactoryPlus' matches what the simulator and validate.py publish. Existing rows adopt
-- it, so a stack in flight keeps resolving -- and ingestion carries a group-agnostic fallback arm
-- with a throttled deprecation warning for anything still publishing under another group.
--
-- ensure_gateway_status_view() must be called after ANY change to the columns of
-- public.gateways: the view's body selects `g.*`, and CREATE OR REPLACE VIEW cannot widen a view
-- in place. See supabase/README.md -> "Dropping a gateways column (0004)".
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- 1. The column
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.gateways
  ADD COLUMN IF NOT EXISTS sparkplug_group text NOT NULL DEFAULT 'FactoryPlus';

COMMENT ON COLUMN public.gateways.sparkplug_group IS
  'Sparkplug B Group ID -- the second topic segment. With sparkplug_id it forms the edge node '
  'address Factory+ resolves as (group, node). Editable: unlike sparkplug_id it is a '
  'configuration choice, not an issued identity.';

-- A group is a topic segment, so the characters MQTT reserves cannot appear in it. Guarded
-- rather than unconditional, because db-init replays this file on every boot.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'gateways_sparkplug_group_format'
       AND conrelid = 'public.gateways'::regclass
  ) THEN
    ALTER TABLE public.gateways
      ADD CONSTRAINT gateways_sparkplug_group_format
      CHECK (sparkplug_group <> '' AND sparkplug_group !~ '[/+#]');
  END IF;
END;
$$;

-- Resolution is by (group, sparkplug_id), so that pair is what wants an index. sparkplug_id is
-- already unique on its own; this one serves the group-qualified lookup without a second scan.
CREATE INDEX IF NOT EXISTS idx_gateways_group_sparkplug_id
  ON public.gateways (sparkplug_group, sparkplug_id);


-- ---------------------------------------------------------------------------------------------
-- 2. Rebuild the status view so it carries the new column
-- ---------------------------------------------------------------------------------------------
-- Not cosmetic: the frontend and the Gateways page read gateway_status, not gateways, so a view
-- left un-rebuilt would omit sparkplug_group with no error anywhere.
SELECT public.ensure_gateway_status_view();


-- ---------------------------------------------------------------------------------------------
-- 3. Self-check
-- ---------------------------------------------------------------------------------------------
-- Asserts the outcome rather than the statements. The second check is the one that matters --
-- adding the column while forgetting the view is the failure mode this migration exists around.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'gateways' AND column_name = 'sparkplug_group'
  ) THEN
    RAISE EXCEPTION '0008 self-check: gateways.sparkplug_group was not created';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'gateway_status'
       AND column_name = 'sparkplug_group'
  ) THEN
    RAISE EXCEPTION '0008 self-check: gateway_status does not expose sparkplug_group; '
                    'ensure_gateway_status_view() did not rebuild the view';
  END IF;

  IF EXISTS (SELECT 1 FROM public.gateways WHERE sparkplug_group IS NULL OR sparkplug_group = '') THEN
    RAISE EXCEPTION '0008 self-check: a gateway has no Sparkplug group; the default did not apply';
  END IF;

  RAISE NOTICE '0008 self-check passed: gateways.sparkplug_group exists and gateway_status exposes it.';
END;
$$;
