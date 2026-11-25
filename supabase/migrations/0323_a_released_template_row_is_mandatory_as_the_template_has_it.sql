-- 0323: A released template row is mandatory as the template has it.
--
-- Two of the 20 Digital Nameplate rows 0002 seeds in idta_submodel_templates keep version 2.0's answer:
-- YearOfConstruction is mandatory there and OrderCodeOfManufacturer is optional. Version 3.0 swapped the
-- two. idta_template_elements (0320) holds the template's own cardinalities, generated from its file.
--
--   * idta_submodel_template_as_generated(), a BEFORE INSERT OR UPDATE trigger on idta_submodel_templates,
--     sets is_mandatory from the element's cardinality wherever idta_template_elements holds the element.
--   * It also skips an UPDATE that would leave the row as it is.
--   * The rows that differ are corrected once, below.
--
-- 0002 is released and its rows are not edited. db-init replays its upsert on every boot ahead of this
-- file, so a correction here alone would be undone and made again on every boot, and a person could read
-- the old answer in between. With the trigger in place the upsert carries the template's answer, finds
-- nothing to change, and writes no row.
--
-- Reasoning: supabase/README.md, "A released template row is mandatory as the template has it (0323)".
-- Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. is_mandatory is the template's own
-- -------------------------------------------------------------------------------------------------
-- 0002's upsert proposes the released value. It runs before this trigger exists on a first boot, and
-- through it on every later one.
CREATE OR REPLACE FUNCTION public.idta_submodel_template_as_generated() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
    v_cardinality text;
BEGIN
    SELECT e.cardinality INTO v_cardinality
      FROM public.idta_template_elements e
     WHERE e.template_id = NEW.template_id AND e.path = NEW.id_short;
    -- NULL where the generated table has no such element, or the template states no cardinality.
    IF v_cardinality IS NOT NULL THEN
        NEW.is_mandatory := v_cardinality IN ('One', 'OneToMany');
    END IF;
    IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$;

ALTER FUNCTION public.idta_submodel_template_as_generated() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.idta_submodel_template_as_generated() FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.idta_submodel_template_as_generated() IS
  'BEFORE INSERT OR UPDATE trigger on idta_submodel_templates. Sets is_mandatory from '
  'idta_template_elements.cardinality (One or OneToMany) where that table holds the element, whatever the '
  'statement proposed, and skips an UPDATE that would leave the row as it is. So 0002''s upsert, replayed on '
  'every boot with the values it was released with, changes nothing (0323).';

SELECT public.replay_trigger('public.idta_submodel_templates', 'idta_submodel_template_as_generated', $ddl$
CREATE TRIGGER idta_submodel_template_as_generated BEFORE INSERT OR UPDATE ON public.idta_submodel_templates FOR EACH ROW EXECUTE FUNCTION public.idta_submodel_template_as_generated();
$ddl$);

COMMENT ON COLUMN public.idta_submodel_templates.is_mandatory IS
  'Whether the template asks for this element: its cardinality is One or OneToMany. It follows '
  'idta_template_elements.cardinality wherever that table holds the element, whatever a statement proposes (0323).';

-- -------------------------------------------------------------------------------------------------
-- 2. The rows that differ, once
-- -------------------------------------------------------------------------------------------------
UPDATE public.idta_submodel_templates t
   SET is_mandatory = (e.cardinality IN ('One', 'OneToMany'))
  FROM public.idta_template_elements e
 WHERE e.template_id = t.template_id
   AND e.path = t.id_short
   AND e.cardinality IS NOT NULL
   AND t.is_mandatory IS DISTINCT FROM (e.cardinality IN ('One', 'OneToMany'));

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn   regprocedure := 'public.idta_submodel_template_as_generated()'::regprocedure;
  v_type smallint;
  r      text;
BEGIN
  SELECT t.tgtype INTO v_type
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.idta_submodel_templates'::regclass
     AND t.tgname = 'idta_submodel_template_as_generated'
     AND t.tgfoid = v_fn
     AND t.tgenabled = 'O';
  -- ROW (1), BEFORE (2), INSERT (4) and UPDATE (16).
  IF v_type IS NULL OR v_type & 23 <> 23 THEN
    RAISE EXCEPTION '0323: idta_submodel_template_as_generated is missing, disabled, or not BEFORE INSERT OR '
      'UPDATE FOR EACH ROW (tgtype %), so 0002 would put version 2.0''s answer back', v_type;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn
                  AND NOT prosecdef AND 'search_path=public, pg_catalog' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0323: idta_submodel_template_as_generated() lost its search_path pin or became SECURITY DEFINER';
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(r, v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0323: % may execute idta_submodel_template_as_generated()', r;
    END IF;
  END LOOP;
  -- Seeded rows alone, and the trigger holds each of them, so nothing a site does can fail it.
  IF EXISTS (SELECT 1 FROM public.idta_submodel_templates t
              JOIN public.idta_template_elements e ON e.template_id = t.template_id AND e.path = t.id_short
             WHERE e.cardinality IS NOT NULL
               AND t.is_mandatory IS DISTINCT FROM (e.cardinality IN ('One', 'OneToMany'))) THEN
    RAISE EXCEPTION '0323: a row of idta_submodel_templates is not mandatory as its template has it';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
