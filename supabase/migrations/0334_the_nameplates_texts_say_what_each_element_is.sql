-- 0334: The Nameplate's texts say what each element is.
--
-- A row of idta_submodel_templates has a description. The Nameplate dialog shows it, the semantic id picker
-- shows it, and an export gives it as the definition of the element's ConceptDescription. Ten of the 20 were
-- not definitions. ManufacturerProductFamily and ManufacturerProductType each said they were mandatory unless
-- the other was given, and Digital Nameplate 3.0.3 asks for neither. The other eight held a note on the seed,
-- on the template's layout or on this platform, which a reader of an exported shell has no use for.
--
--   * idta_submodel_template_as_generated(), 0323's trigger, gives each of the ten a text in this project's own
--     words, whatever a statement proposes. The other ten rows keep what 0002 says of them.
--   * The rows that differ are corrected once, below.
--
-- 0002 is released and its rows are not edited. db-init replays its upsert on every boot ahead of this file, so
-- an UPDATE alone would be undone and made again on every boot: ten rows written twice. Through the trigger the
-- upsert finds nothing to change, and writes no row.
--
-- Redefines public.idta_submodel_template_as_generated: 0334 gives ten descriptions. The rest is 0323's.
--
-- Reasoning: supabase/README.md, "The Nameplate's texts say what each element is (0334)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The texts
-- -------------------------------------------------------------------------------------------------
-- Each says what the element is, and nothing of the seed, the template's layout or this platform. None is
-- IDTA's, IEC CDD's or ECLASS's own sentence.
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
    IF NEW.template_id = 'https://admin-shell.io/idta/nameplate/3/0/Nameplate' THEN
        NEW.description := CASE NEW.id_short
            WHEN 'URIOfTheProduct' THEN 'URI the manufacturer gives this one unit, which no other product has.'
            WHEN 'AddressInformation' THEN 'Contact address of the manufacturer, such as its street, postal code, town and country. A nested collection.'
            WHEN 'ManufacturerProductFamily' THEN 'Family of products the manufacturer places this product in, one level below its product root.'
            WHEN 'ManufacturerProductType' THEN 'Type or variant of the product as the manufacturer names it, which tells it from the others of its family.'
            WHEN 'SerialNumber' THEN 'Serial number uniquely identifying this instance for its manufacturer.'
            WHEN 'YearOfConstruction' THEN 'Year the product was built.'
            WHEN 'FirmwareVersion' THEN 'Firmware version of the product.'
            WHEN 'UniqueFacilityIdentifier' THEN 'Unique identifier of the facility the product was made in.'
            WHEN 'CompanyLogo' THEN 'Manufacturer logo, as a file.'
            WHEN 'AssetSpecificProperties' THEN 'Manufacturer-specific properties that are not part of the standard set. A nested collection.'
            ELSE NEW.description
        END;
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
  'idta_template_elements.cardinality (One or OneToMany) where that table holds the element, and the description of '
  'the ten Digital Nameplate elements whose released text was no definition, whatever the statement proposed. It '
  'skips an UPDATE that would leave the row as it is. So 0002''s upsert, replayed on every boot with the values it '
  'was released with, changes nothing (0323, 0334).';

COMMENT ON COLUMN public.idta_submodel_templates.description IS
  'What the element is, in this project''s own words. An export gives it as the definition of the element''s '
  'ConceptDescription, so it holds no note on the seed or on this platform (0334).';

-- -------------------------------------------------------------------------------------------------
-- 2. The rows that differ, once
-- -------------------------------------------------------------------------------------------------
-- The trigger gives each its text. It skips a row that has it, so a replay writes none.
UPDATE public.idta_submodel_templates
   SET description = description
 WHERE template_id = 'https://admin-shell.io/idta/nameplate/3/0/Nameplate';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn regprocedure := 'public.idta_submodel_template_as_generated()'::regprocedure;
  r    text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.idta_submodel_templates'::regclass
                    AND t.tgname = 'idta_submodel_template_as_generated'
                    AND t.tgfoid = v_fn AND t.tgenabled = 'O') THEN
    RAISE EXCEPTION '0334: idta_submodel_template_as_generated is missing or disabled, so 0002 would put its own texts back';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn
                  AND NOT prosecdef AND 'search_path=public, pg_catalog' = ANY (proconfig)) THEN
    RAISE EXCEPTION '0334: idta_submodel_template_as_generated() lost its search_path pin or became SECURITY DEFINER';
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF has_function_privilege(r, v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '0334: % may execute idta_submodel_template_as_generated()', r;
    END IF;
  END LOOP;
  -- Seeded rows alone, and the trigger holds each of them, so nothing a site does can fail it.
  IF EXISTS (SELECT 1 FROM public.idta_submodel_templates t
              WHERE t.template_id = 'https://admin-shell.io/idta/nameplate/3/0/Nameplate'
                AND t.id_short IN ('AddressInformation', 'ManufacturerProductFamily', 'ManufacturerProductType')
                AND (strpos(t.description, 'Mandatory unless') > 0 OR strpos(t.description, 'the template') > 0)) THEN
    RAISE EXCEPTION '0334: a Digital Nameplate row still has the text it was released with';
  END IF;
END
$check$;
