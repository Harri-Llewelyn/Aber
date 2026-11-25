-- 0325: The id of a record cannot be changed.
--
-- An id is what everything else finds a record by: a foreign key, the Audit Trail, an exported shell,
-- an i3X or Factory+ client, and the sparkplug_id generated from it, which names a device's readings
-- and a gateway's broker account. Nothing in Aber changes one, but nothing refused it either. A
-- Shopfloor Manager's session could PATCH the id of an area, a cell, a gateway or a device, and a
-- foreign key refused only where another row already pointed at it.
--
--   * refuse_key_change() refuses an UPDATE that changes id, for every role, and names the kind and the
--     record. An UPDATE that sets id to the value it has passes, as a whole-row PATCH and an upsert do.
--   * One trigger on each table that a person's session may UPDATE and whose id is held outside its own
--     row, and one on automations, which the functions write.
--
-- No role is exempt. No migration and no function that runs as the owner changes an id.
--
-- Reasoning: supabase/README.md, "The id of a record cannot be changed (0325)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The refusal
-- -------------------------------------------------------------------------------------------------
-- TG_ARGV is the kind as a person says it, and the column that names the record.
CREATE OR REPLACE FUNCTION public.refuse_key_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.id IS NOT DISTINCT FROM OLD.id THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'the id of % "%" cannot be changed. Other records and other systems find it by this id.',
    TG_ARGV[0], to_jsonb(OLD) ->> TG_ARGV[1]
    USING ERRCODE = 'check_violation',
          HINT = 'Leave id out of the change, or send the id the record has.';
END $$;

ALTER FUNCTION public.refuse_key_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_key_change() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.refuse_key_change() IS 'Refuses an UPDATE that changes a row''s id, for every role, and names the kind (its first argument) and the record (the column its second argument names). An UPDATE that sets id to the value it has passes. sparkplug_id is generated from id, so it is held too (0325).';

-- -------------------------------------------------------------------------------------------------
-- 2. One trigger per table
-- -------------------------------------------------------------------------------------------------
-- UPDATE OF id, so a write that leaves id out of its SET list runs none of it.
SELECT public.replay_trigger('public.areas', 'trg_areas_id_cannot_change', $ddl$
CREATE TRIGGER trg_areas_id_cannot_change BEFORE UPDATE OF id ON public.areas FOR EACH ROW EXECUTE FUNCTION public.refuse_key_change('area', 'name');
$ddl$);

SELECT public.replay_trigger('public.cells', 'trg_cells_id_cannot_change', $ddl$
CREATE TRIGGER trg_cells_id_cannot_change BEFORE UPDATE OF id ON public.cells FOR EACH ROW EXECUTE FUNCTION public.refuse_key_change('cell', 'name');
$ddl$);

SELECT public.replay_trigger('public.gateways', 'trg_gateways_id_cannot_change', $ddl$
CREATE TRIGGER trg_gateways_id_cannot_change BEFORE UPDATE OF id ON public.gateways FOR EACH ROW EXECUTE FUNCTION public.refuse_key_change('gateway', 'name');
$ddl$);

SELECT public.replay_trigger('public.devices', 'trg_devices_id_cannot_change', $ddl$
CREATE TRIGGER trg_devices_id_cannot_change BEFORE UPDATE OF id ON public.devices FOR EACH ROW EXECUTE FUNCTION public.refuse_key_change('device', 'name');
$ddl$);

SELECT public.replay_trigger('public.schemas', 'trg_schemas_id_cannot_change', $ddl$
CREATE TRIGGER trg_schemas_id_cannot_change BEFORE UPDATE OF id ON public.schemas FOR EACH ROW EXECUTE FUNCTION public.refuse_key_change('schema', 'schema_name');
$ddl$);

SELECT public.replay_trigger('public.metric_catalog', 'trg_metric_catalog_id_cannot_change', $ddl$
CREATE TRIGGER trg_metric_catalog_id_cannot_change BEFORE UPDATE OF id ON public.metric_catalog FOR EACH ROW EXECUTE FUNCTION public.refuse_key_change('metric', 'name');
$ddl$);

SELECT public.replay_trigger('public.metric_groups', 'trg_metric_groups_id_cannot_change', $ddl$
CREATE TRIGGER trg_metric_groups_id_cannot_change BEFORE UPDATE OF id ON public.metric_groups FOR EACH ROW EXECUTE FUNCTION public.refuse_key_change('metric group', 'name');
$ddl$);

SELECT public.replay_trigger('public.links', 'trg_links_id_cannot_change', $ddl$
CREATE TRIGGER trg_links_id_cannot_change BEFORE UPDATE OF id ON public.links FOR EACH ROW EXECUTE FUNCTION public.refuse_key_change('link', 'display_name');
$ddl$);

SELECT public.replay_trigger('public.directory_services', 'trg_directory_services_id_cannot_change', $ddl$
CREATE TRIGGER trg_directory_services_id_cannot_change BEFORE UPDATE OF id ON public.directory_services FOR EACH ROW EXECUTE FUNCTION public.refuse_key_change('Directory service', 'service_name');
$ddl$);

SELECT public.replay_trigger('public.change_proposals', 'trg_change_proposals_id_cannot_change', $ddl$
CREATE TRIGGER trg_change_proposals_id_cannot_change BEFORE UPDATE OF id ON public.change_proposals FOR EACH ROW EXECUTE FUNCTION public.refuse_key_change('change proposal', 'id');
$ddl$);

SELECT public.replay_trigger('public.automations', 'trg_automations_id_cannot_change', $ddl$
CREATE TRIGGER trg_automations_id_cannot_change BEFORE UPDATE OF id ON public.automations FOR EACH ROW EXECUTE FUNCTION public.refuse_key_change('automation', 'alias');
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- 3. Self-check: each table's trigger is there and calls the function, and no API role may call it.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['areas', 'cells', 'gateways', 'devices', 'schemas', 'metric_catalog',
                                 'metric_groups', 'links', 'directory_services', 'change_proposals',
                                 'automations'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                    WHERE t.tgrelid = format('public.%I', v_table)::regclass
                      AND t.tgname = format('trg_%s_id_cannot_change', v_table)
                      AND t.tgfoid = 'public.refuse_key_change()'::regprocedure
                      AND t.tgenabled = 'O' AND NOT t.tgisinternal) THEN
      RAISE EXCEPTION '0325: public.% has no enabled trg_%_id_cannot_change', v_table, v_table;
    END IF;
  END LOOP;

  IF has_function_privilege('anon', 'public.refuse_key_change()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.refuse_key_change()', 'EXECUTE') THEN
    RAISE EXCEPTION '0325: an API role may execute refuse_key_change()';
  END IF;
END
$check$;
