-- 0171: An OPC UA concept carries the identifier OPC UA publishes.
--
-- Every opcua_vocabulary row's node_id and semantic_id are now the ExpandedNodeId its
-- specification's NodeSet declares, `nsu=<namespace URI>;i=<id>`, written by
-- scripts/generate-opcua-vocabulary.mjs into 0002. They were `<namespace URI><name>`, an IRI the OPC
-- Foundation never issued. This file moves what the platform holds onto the new ids: a catalog
-- metric or a schema carrying a former id exactly takes the new one, typed `ExpandedNodeId`, and a
-- vocabulary row 0002 no longer writes is removed.
--
-- `ExpandedNodeId` is the third semantic_id_type. 0001 declares it in both CHECKs, not this file:
-- 0001 replays first on every boot and drops a CHECK whose definition differs from its own, so a
-- CHECK widened here would be narrowed again by the next boot, which then fails on the first row
-- holding the new value.

-- -------------------------------------------------------------------------------------------------
-- Former ids become the new ones
-- -------------------------------------------------------------------------------------------------
-- The map is read from the rows 0002 has just written: a former id was the row's namespace (the
-- `nsu=` part of its new id) followed by its name. Only an exact match moves, so an id an
-- Administrator typed in another form is left as it is. A second boot finds nothing to move.
DO $$
DECLARE
  v_table text;
  v_moved bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'metric_catalog_semantic_id_type_valid'
                    AND conrelid = 'public.metric_catalog'::regclass
                    AND pg_get_constraintdef(oid) LIKE '%''ExpandedNodeId''%')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conname = 'schemas_semantic_id_type_valid'
                       AND conrelid = 'public.schemas'::regclass
                       AND pg_get_constraintdef(oid) LIKE '%''ExpandedNodeId''%') THEN
    RAISE EXCEPTION '0171: semantic_id_type does not admit ExpandedNodeId; 0001 declares it in both CHECKs';
  END IF;

  FOREACH v_table IN ARRAY ARRAY['metric_catalog', 'schemas'] LOOP
    EXECUTE format(
      'UPDATE public.%I AS t
          SET semantic_id = v.semantic_id, semantic_id_type = %L
         FROM public.opcua_vocabulary AS v
        WHERE v.semantic_id LIKE %L
          AND t.semantic_id = substring(v.semantic_id FROM %L) || v.name',
      v_table, 'ExpandedNodeId', 'nsu=%', '^nsu=([^;]+);');
    GET DIAGNOSTICS v_moved = ROW_COUNT;
    IF v_moved > 0 THEN
      RAISE NOTICE '0171: % row(s) in public.% now carry the ExpandedNodeId of their OPC UA concept',
                   v_moved, v_table;
    END IF;
  END LOOP;
END
$$;

-- -------------------------------------------------------------------------------------------------
-- Rows 0002 no longer writes
-- -------------------------------------------------------------------------------------------------
-- Every row 0002 writes carries an ExpandedNodeId, so a row without one is a former row. OPC 40001
-- Machinery `OperationalTime` is the one today: no Machinery NodeSet declares it. A metric that
-- carries its former id keeps it.
DELETE FROM public.opcua_vocabulary
 WHERE semantic_id IS NULL OR semantic_id NOT LIKE 'nsu=%';

-- What this file did: no metric or schema carries a former id of a row the vocabulary holds, and
-- every vocabulary row names its node by the id it carries.
DO $check$
DECLARE
  v_table text;
  v_left  bigint;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['metric_catalog', 'schemas'] LOOP
    EXECUTE format(
      'SELECT count(*) FROM public.%I AS t JOIN public.opcua_vocabulary AS v
           ON t.semantic_id = substring(v.semantic_id FROM %L) || v.name',
      v_table, '^nsu=([^;]+);')
      INTO v_left;
    IF v_left > 0 THEN
      RAISE EXCEPTION '0171 self-check: % row(s) in public.% still carry a former OPC UA id', v_left, v_table;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.opcua_vocabulary
              WHERE semantic_id NOT LIKE 'nsu=%' OR node_id IS DISTINCT FROM semantic_id) THEN
    RAISE EXCEPTION '0171 self-check: an opcua_vocabulary row does not carry its ExpandedNodeId as node_id and semantic_id';
  END IF;
END
$check$;
