-- 0342: A schema is built from a template.
--
-- A schema that implements an IDTA submodel template was put together by hand: a person worked out
-- which catalogue metrics carry the template's elements, ticked them, and typed the template's id as
-- the schema's semantic id. Build Schema from Template does the three, and a version now says which
-- template it was built from and which element each of its metrics fills.
--
--   * schemas.template_id is the template (idta_template_elements.template_id), NULL for a schema built
--     any other way. schemas.template_elements is the element each metric fills, by catalogue name:
--     {"<metric>": {"path": <idShortPath>, "semantic_id": <the element's id>}}. Both are columns of the
--     version, so prevent_active_schema_mutation() freezes them, a change of them is the schema's own
--     row in the Audit Trail, and the version's policies are their policies.
--   * schema_template_elements() is the rule: a metric fills the first Property or
--     MultiLanguageProperty of the template whose semantic id is the metric's own, or else one of its
--     further ids (metric_semantic_ids). template_required_paths() names the elements a submodel of
--     the template must hold: one or more of them, inside nothing that may be left out.
--   * trg_schemas_template writes template_elements whenever the definition, the semantic id or the
--     template changes, and refuses a version that leaves out an element the template requires, or
--     whose semantic id is not the template's. What a caller sends for template_elements is replaced.
--     A version inserted with neither column takes its parent's, so fork_schema() carries both and is
--     not declared again. A copy of its parent keeps its parent's elements and is not checked again.
--
-- Nothing is filled: every version there is was built some other way, and keeps NULL in both.
--
-- Reasoning: supabase/README.md, "A schema is built from a template (0342)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The columns
-- -------------------------------------------------------------------------------------------------
ALTER TABLE public.schemas ADD COLUMN IF NOT EXISTS template_id text;
ALTER TABLE public.schemas ADD COLUMN IF NOT EXISTS template_elements jsonb;

COMMENT ON COLUMN public.schemas.template_id IS 'The IDTA submodel template this version was built from (idta_template_elements.template_id), whose id is then its semantic id. NULL for a schema built any other way. Part of the version: fixed once it is published, and a version made without one takes its parent''s (0342).';
COMMENT ON COLUMN public.schemas.template_elements IS 'The element of the template each metric of the version fills, by catalogue name: {"<metric>": {"path", "semantic_id"}}, written by trg_schemas_template from schema_template_elements(). The AAS export makes the element''s id the metric''s semanticId in this version''s submodel. NULL without a template (0342).';

-- -------------------------------------------------------------------------------------------------
-- 2. The rule
-- -------------------------------------------------------------------------------------------------
-- The element of the template each metric the definition models fills, in the shape template_elements
-- holds. A metric fills an element a value can be put in, a Property or a MultiLanguageProperty, whose
-- semantic id is the metric's own id, or else one of its further ids; of several, the first in the
-- template's order. templateElementFill() in utils/idtaTemplates.js is the same rule, and
-- test-harness/fixtures/schema-template-elements.json holds the two together.
CREATE OR REPLACE FUNCTION public.schema_template_elements(p_template_id text, p_definition jsonb) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT coalesce(jsonb_object_agg(f.metric_name, jsonb_build_object('path', f.path, 'semantic_id', f.semantic_id)), '{}'::jsonb)
    FROM (SELECT DISTINCT ON (m.name) m.name AS metric_name, e.path, e.semantic_id
            FROM unnest(public.schema_modelled_metrics(p_definition)) AS m(name)
            JOIN public.metric_catalog c ON c.name = m.name
            JOIN public.idta_template_elements e
              ON e.template_id = p_template_id
             AND e.model_type IN ('Property', 'MultiLanguageProperty')
             AND e.semantic_id IS NOT NULL
             AND (e.semantic_id = c.semantic_id
                  OR EXISTS (SELECT 1 FROM public.metric_semantic_ids s
                              WHERE s.metric_id = c.id AND s.semantic_id = e.semantic_id))
           ORDER BY m.name, (e.semantic_id IS NOT DISTINCT FROM c.semantic_id) DESC, e.ordinal) f;
$$;

ALTER FUNCTION public.schema_template_elements(text, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.schema_template_elements(text, jsonb) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.schema_template_elements(text, jsonb) IS
  'The element of a template each metric a definition models fills: {"<metric>": {"path", "semantic_id"}}. '
  'A metric fills the first Property or MultiLanguageProperty, in the template''s order, whose semantic id '
  'is its own id, or else one of its further ids. A metric that fills none is not in it (0342).';

-- The elements a submodel of the template must hold that a metric can fill, in the template's order: a
-- Property or a MultiLanguageProperty with a semantic id, whose cardinality is One or OneToMany, inside
-- no element whose cardinality is anything else. An element inside one that may be left out is asked
-- for only where that one is there, which a schema of metrics does not say. requiredTemplatePaths() in
-- utils/idtaTemplates.js is the same rule.
CREATE OR REPLACE FUNCTION public.template_required_paths(p_template_id text) RETURNS text[]
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  SELECT ARRAY(
    SELECT e.path
      FROM public.idta_template_elements e
     WHERE e.template_id = p_template_id
       AND e.model_type IN ('Property', 'MultiLanguageProperty')
       AND e.semantic_id IS NOT NULL
       AND e.cardinality IN ('One', 'OneToMany')
       AND NOT EXISTS (SELECT 1 FROM public.idta_template_elements a
                        WHERE a.template_id = e.template_id
                          AND (starts_with(e.path, a.path || '.') OR starts_with(e.path, a.path || '['))
                          AND a.cardinality IS DISTINCT FROM 'One' AND a.cardinality IS DISTINCT FROM 'OneToMany')
     ORDER BY e.ordinal);
$$;

ALTER FUNCTION public.template_required_paths(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.template_required_paths(text) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.template_required_paths(text) IS
  'The paths of the elements a submodel of the template must hold that a metric can fill, in the '
  'template''s order: a Property or MultiLanguageProperty with a semantic id, of cardinality One or '
  'OneToMany, inside no element of another cardinality (0342).';

-- Every reason a version built from the template may not be saved, in words a person reads, in the order
-- the editor says them (templateProblems() in utils/idtaTemplates.js). No row means it may be.
CREATE OR REPLACE FUNCTION public.schema_template_problems(p_template_id text, p_semantic_id text, p_elements jsonb)
RETURNS TABLE (problem text)
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
DECLARE
  v_title   text;
  v_missing text;
BEGIN
  SELECT e.template_name || ' ' || e.template_version INTO v_title
    FROM public.idta_template_elements e
   WHERE e.template_id = p_template_id
   LIMIT 1;
  IF v_title IS NULL THEN
    problem := format('%s is not a template Aber holds. Choose one on the Vocabulary page''s Templates tab.', p_template_id);
    RETURN NEXT;
    RETURN;
  END IF;
  IF p_semantic_id IS DISTINCT FROM p_template_id THEN
    problem := format('A schema built from %s carries the template''s id as its semantic id: %s.', v_title, p_template_id);
    RETURN NEXT;
  END IF;
  SELECT string_agg(r.path, ', ' ORDER BY r.ord) INTO v_missing
    FROM unnest(public.template_required_paths(p_template_id)) WITH ORDINALITY AS r(path, ord)
   WHERE NOT EXISTS (SELECT 1 FROM jsonb_each(coalesce(p_elements, '{}'::jsonb)) f WHERE f.value ->> 'path' = r.path);
  IF v_missing IS NOT NULL THEN
    problem := format('No metric here fills %s, which %s requires. A metric fills an element when the element''s semantic id is the metric''s own or one of its further ids.', v_missing, v_title);
    RETURN NEXT;
  END IF;
END
$$;

ALTER FUNCTION public.schema_template_problems(text, text, jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.schema_template_problems(text, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.schema_template_problems(text, text, jsonb) IS
  'Every reason a version built from a template may not be saved, in words: a template Aber does not '
  'hold, a semantic id that is not the template''s, and the elements the template requires that no '
  'metric fills (template_required_paths()). No row means it may be (0342).';

-- -------------------------------------------------------------------------------------------------
-- 3. The trigger
-- -------------------------------------------------------------------------------------------------
-- SECURITY DEFINER: the parent's row, the catalogue's further ids and the template's rows must not depend
-- on the caller.
CREATE OR REPLACE FUNCTION public.schemas_fill_their_template() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_base     public.schemas;
  v_problems text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.parent_schema_id IS NOT NULL THEN
      SELECT * INTO v_base FROM public.schemas p WHERE p.id = NEW.parent_schema_id;
      -- Neither given: the parent's. template_elements given alone says none, and is cleared below.
      IF NEW.template_id IS NULL AND NEW.template_elements IS NULL THEN
        NEW.template_id := v_base.template_id;
      END IF;
    END IF;
  ELSE
    v_base := OLD;
  END IF;

  IF NEW.template_id IS NULL THEN
    NEW.template_elements := NULL;
    RETURN NEW;
  END IF;

  -- A copy of its parent, and an edit that changes none of what the elements follow from, keeps the
  -- elements it has. Create Version must not be refused by what a published version says, since nobody
  -- can edit that.
  IF NEW.template_id = v_base.template_id AND NEW.schema_definition = v_base.schema_definition
     AND NEW.semantic_id IS NOT DISTINCT FROM v_base.semantic_id THEN
    NEW.template_elements := v_base.template_elements;
    RETURN NEW;
  END IF;

  NEW.template_elements := public.schema_template_elements(NEW.template_id, NEW.schema_definition);
  SELECT string_agg(p.problem, ' ' ORDER BY p.ord) INTO v_problems
    FROM public.schema_template_problems(NEW.template_id, NEW.semantic_id, NEW.template_elements)
         WITH ORDINALITY AS p(problem, ord);
  IF v_problems IS NOT NULL THEN
    RAISE EXCEPTION '%', v_problems USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

ALTER FUNCTION public.schemas_fill_their_template() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.schemas_fill_their_template() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.schemas_fill_their_template() IS
  'BEFORE INSERT, and BEFORE UPDATE of schema_definition, semantic_id, template_id or template_elements, '
  'on schemas: writes template_elements from schema_template_elements(), and refuses the row with every '
  'reason schema_template_problems() gives. A version inserted with neither column takes its parent''s '
  'template. A copy of its parent, and an edit that changes neither the template, the definition nor the '
  'semantic id, keeps the elements it has and is not checked again (0342).';

SELECT public.replay_trigger('public.schemas', 'trg_schemas_template', $ddl$
CREATE TRIGGER trg_schemas_template BEFORE INSERT OR UPDATE OF schema_definition, semantic_id, template_id, template_elements ON public.schemas FOR EACH ROW EXECUTE FUNCTION public.schemas_fill_their_template();
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
-- Structure only. Nothing is planted and no site's rows are read.
DO $check$
DECLARE
  v_fn text;
BEGIN
  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid = 'public.schemas'::regclass AND NOT attisdropped
         AND ((attname = 'template_id' AND atttypid = 'text'::regtype)
              OR (attname = 'template_elements' AND atttypid = 'jsonb'::regtype))) <> 2 THEN
    RAISE EXCEPTION '0342: schemas.template_id or schemas.template_elements is missing or of another type';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.schemas'::regclass AND t.tgname = 'trg_schemas_template'
                    AND t.tgenabled <> 'D') THEN
    RAISE EXCEPTION '0342: trg_schemas_template is missing or disabled';
  END IF;
  -- The guard that freezes a published version reads every column but `status`, these among them.
  IF position('allowed CONSTANT text[] := ARRAY[''status'']' IN
              (SELECT p.prosrc FROM pg_proc p WHERE p.oid = 'public.prevent_active_schema_mutation()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION '0342: prevent_active_schema_mutation() no longer freezes every column but status';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY['public.schema_template_elements(text, jsonb)', 'public.template_required_paths(text)',
                              'public.schema_template_problems(text, text, jsonb)',
                              'public.schemas_fill_their_template()'] LOOP
    IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0342: a browser-facing role may execute %', v_fn;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_proc p
                    WHERE p.oid = v_fn::regprocedure AND p.proconfig = ARRAY['search_path=public']) THEN
      RAISE EXCEPTION '0342: % does not pin its search_path', v_fn;
    END IF;
  END LOOP;
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'public.schemas_fill_their_template()'::regprocedure) THEN
    RAISE EXCEPTION '0342: schemas_fill_their_template() is not SECURITY DEFINER';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
