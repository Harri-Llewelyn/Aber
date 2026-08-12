-- =============================================================================================
-- Migration: 0011_device_nameplate.sql
-- IDTA 02006 Digital Nameplate: the submodel-template vocabulary, and per-device nameplate data
-- =============================================================================================
--
-- ⚠ VERIFY. The element idShorts and semanticIds seeded below are transcribed from
-- **IDTA 02006-3-0-1, "Digital Nameplate for Industrial Equipment", published October 2025**,
-- via the IDTA submodel-template documentation at industrialdigitaltwin.io. The submodel's own
-- semanticId, https://admin-shell.io/idta/nameplate/3/0/Nameplate, is confirmed. The IRDIs are
-- IEC CDD and ECLASS identifiers quoted verbatim from that template and have NOT been resolved
-- against the IEC CDD or ECLASS dictionaries themselves -- confirm before citing one as evidence
-- of a dictionary entry. Version 2.0 used a different namespace
-- (https://admin-shell.io/zvei/nameplate/2/0/Nameplate) and 4.0 is in development, so the version
-- is part of the identifier and not a detail.
--
-- WHY A TEMPLATE TABLE. `idta_submodel_templates` is reference data in exactly the sense
-- `mtconnect_vocabulary` and `opcua_vocabulary` are: a row is an element the standard DEFINES, not
-- a value a device published. It is what lets the AAS exporter attach a published semanticId to a
-- property without hard-coding thirty IRDIs into TypeScript, and what lets the UI show an operator
-- which fields a nameplate is supposed to carry.
--
-- WHY A SEPARATE `device_nameplate` RATHER THAN asset_config OR NEW devices COLUMNS.
-- `asset_config` is INGESTION-OWNED: ingestion.py upserts it from every DBIRTH, keyed
-- (asset_id, metric_name). Nameplate data entered by an operator would land in the same rows as
-- values the device asserted, be indistinguishable from them, and be churned on every rebirth.
-- That distinction is the whole point here -- a nameplate is a manufacturer's claim, and "the
-- device told us its serial number" and "somebody typed it in" are different facts with different
-- trust. `devices` was the other candidate and is already 24 columns of operational state; asset
-- identity is a different concern with a different write pattern and a different audience.
--
-- THE EXPORTER PREFERS THE DEVICE'S OWN ANSWER. OPC 40001 Machinery already defines Manufacturer,
-- SerialNumber, YearOfConstruction and ProductInstanceUri as data points a machine publishes, and
-- migration 0002 seeds them. Where a device publishes one, that value wins and this table is the
-- fallback -- so this is not a duplicate store, it is the answer for the many devices that publish
-- no identification at all.
-- =============================================================================================


-- ---------------------------------------------------------------------------------------------
-- IDTA submodel template vocabulary
-- ---------------------------------------------------------------------------------------------
-- Keyed on (template_id, id_short): an element name is only unique within its template, and a
-- later template (Technical Data, Handover Documentation) will reuse names like `Name`.

CREATE TABLE IF NOT EXISTS public.idta_submodel_templates (
    template_id text NOT NULL,
    template_name text NOT NULL,
    template_version text NOT NULL,
    id_short text NOT NULL,
    semantic_id text NOT NULL,
    semantic_id_type text NOT NULL,
    description text,
    is_mandatory boolean DEFAULT false NOT NULL,
    ordinal integer NOT NULL,
    CONSTRAINT idta_submodel_templates_semantic_id_type_valid
        CHECK ((semantic_id_type = ANY (ARRAY['IRI'::text, 'IRDI'::text]))),
    CONSTRAINT idta_submodel_templates_id_short_shape
        CHECK ((id_short ~ '^[A-Za-z][A-Za-z0-9_]*$'))
);

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'idta_submodel_templates_pkey'
       AND conrelid = 'public.idta_submodel_templates'::regclass
  ) THEN
    ALTER TABLE ONLY public.idta_submodel_templates
        ADD CONSTRAINT idta_submodel_templates_pkey PRIMARY KEY (template_id, id_short);
  END IF;
END
$migration$;

COMMENT ON TABLE public.idta_submodel_templates IS
  'IDTA Asset Administration Shell submodel-template elements. Reference data, not deployment state -- a row here is an element the template defines, not a value a device holds. semantic_id is issued by IDTA/IEC CDD/ECLASS and must never be minted locally.';
COMMENT ON COLUMN public.idta_submodel_templates.is_mandatory IS
  'Whether the template marks this element as mandatory. Recorded so the exporter can report what a shell would need to claim conformance -- it does NOT claim it; see the exporter.';
COMMENT ON COLUMN public.idta_submodel_templates.ordinal IS
  'Order the element appears in the published template, so the exported submodel reads like the specification rather than like a hash map.';

ALTER TABLE public.idta_submodel_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS idta_submodel_templates_select_authenticated ON public.idta_submodel_templates;
CREATE POLICY idta_submodel_templates_select_authenticated
    ON public.idta_submodel_templates FOR SELECT TO authenticated USING (true);

-- Reference data: readable by any signed-in user, writable by nobody through the API. There is no
-- write policy at all, which is the same shape mtconnect_vocabulary and opcua_vocabulary have --
-- the seed is the only writer, and it runs as the migration role.
REVOKE ALL ON TABLE public.idta_submodel_templates FROM PUBLIC;
REVOKE ALL ON TABLE public.idta_submodel_templates FROM anon;
GRANT SELECT ON TABLE public.idta_submodel_templates TO authenticated;
GRANT ALL ON TABLE public.idta_submodel_templates TO service_role;


-- ---------------------------------------------------------------------------------------------
-- Per-device nameplate data
-- ---------------------------------------------------------------------------------------------
-- One row per device, created on first edit rather than with the device: a device with no
-- nameplate data has NO ROW, not a row of nulls. The exporter's rule is that a submodel with
-- nothing in it is omitted entirely, and "no row" expresses that without every column being
-- checked for null.

CREATE TABLE IF NOT EXISTS public.device_nameplate (
    device_id uuid NOT NULL,
    manufacturer_name text,
    manufacturer_product_designation text,
    manufacturer_product_type text,
    serial_number text,
    year_of_construction text,
    date_of_manufacture date,
    hardware_version text,
    firmware_version text,
    software_version text,
    country_of_origin text,
    uri_of_the_product text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    -- IDTA types YearOfConstruction as a string, not an integer: the template's own example is a
    -- four-digit year, but the field is text in the specification and a manufacturer plate may
    -- carry a range or a week code. Storing it as an integer would reject a legitimate plate.
    CONSTRAINT device_nameplate_year_shape
        CHECK ((year_of_construction IS NULL) OR (year_of_construction ~ '^[0-9]{4}$')),
    -- A product URI is an IRI in the template; anything else silently exports as a broken
    -- xs:anyURI, which no consumer reports and every consumer mis-renders.
    CONSTRAINT device_nameplate_uri_shape
        CHECK ((uri_of_the_product IS NULL) OR (uri_of_the_product ~* '^[a-z][a-z0-9+.-]*:'))
);

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'device_nameplate_pkey' AND conrelid = 'public.device_nameplate'::regclass
  ) THEN
    ALTER TABLE ONLY public.device_nameplate
        ADD CONSTRAINT device_nameplate_pkey PRIMARY KEY (device_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'device_nameplate_device_id_fkey'
       AND conrelid = 'public.device_nameplate'::regclass
  ) THEN
    -- ON DELETE CASCADE: the nameplate describes the asset, so it has no meaning once the device
    -- row is gone. Note devices are normally ARCHIVED rather than deleted, and an archived device
    -- keeps its nameplate -- which is what a handover document needs.
    ALTER TABLE ONLY public.device_nameplate
        ADD CONSTRAINT device_nameplate_device_id_fkey
        FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE CASCADE;
  END IF;
END
$migration$;

COMMENT ON TABLE public.device_nameplate IS
  'Operator-supplied IDTA 02006 Digital Nameplate data, one row per device. The FALLBACK source: where a device publishes its own identification as birth metrics (OPC 40001 Machinery Manufacturer, SerialNumber, YearOfConstruction), the exporter prefers what the device said. Deliberately not in asset_config, which ingestion overwrites from every DBIRTH.';
COMMENT ON COLUMN public.device_nameplate.updated_by IS
  'Who last edited this nameplate. A nameplate is an assertion about an asset, so who made it is part of the record -- the same reason digital_thread exists.';

ALTER TABLE public.device_nameplate ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS device_nameplate_select_authenticated ON public.device_nameplate;
CREATE POLICY device_nameplate_select_authenticated
    ON public.device_nameplate FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS device_nameplate_insert_privileged ON public.device_nameplate;
CREATE POLICY device_nameplate_insert_privileged
    ON public.device_nameplate FOR INSERT TO authenticated
    WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

DROP POLICY IF EXISTS device_nameplate_update_privileged ON public.device_nameplate;
CREATE POLICY device_nameplate_update_privileged
    ON public.device_nameplate FOR UPDATE TO authenticated
    USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]))
    WITH CHECK (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

DROP POLICY IF EXISTS device_nameplate_delete_privileged ON public.device_nameplate;
CREATE POLICY device_nameplate_delete_privileged
    ON public.device_nameplate FOR DELETE TO authenticated
    USING (public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text]));

REVOKE ALL ON TABLE public.device_nameplate FROM PUBLIC;
REVOKE ALL ON TABLE public.device_nameplate FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.device_nameplate TO authenticated;
GRANT ALL ON TABLE public.device_nameplate TO service_role;


-- ---------------------------------------------------------------------------------------------
-- Seed: IDTA 02006 Digital Nameplate v3.0, top-level elements
-- ---------------------------------------------------------------------------------------------
-- Idempotent, because db-init replays every migration on every boot with no applied-migrations
-- ledger. DO UPDATE on the descriptive columns so a corrected transcription reaches an existing
-- database; the key (template_id, id_short) is what a row IS and is never updated.
--
-- Only the TOP-LEVEL elements are seeded. AddressInformation, Markings and AssetSpecificProperties
-- are SubmodelElementCollections with their own nested structures, and flattening them into this
-- table would misrepresent the template -- they are recorded here so the set is complete and their
-- children are deliberately out of scope until something needs them.

INSERT INTO public.idta_submodel_templates
  (template_id, template_name, template_version, id_short, semantic_id, semantic_id_type, description, is_mandatory, ordinal)
VALUES
  ('https://admin-shell.io/idta/nameplate/3/0/Nameplate', 'Digital Nameplate', '3.0', 'URIOfTheProduct', '0112/2///61987#ABN590#002', 'IRDI', 'Unique global identifier of the product instance -- the manufacturer''s own product URI, not this platform''s globalAssetId.', true, 1),
  ('https://admin-shell.io/idta/nameplate/3/0/Nameplate', 'Digital Nameplate', '3.0', 'ManufacturerName', '0112/2///61987#ABA565#009', 'IRDI', 'Legal name of the manufacturer.', true, 2),
  ('https://admin-shell.io/idta/nameplate/3/0/Nameplate', 'Digital Nameplate', '3.0', 'ManufacturerProductDesignation', '0112/2///61987#ABA567#009', 'IRDI', 'Short designation the manufacturer gives the product.', true, 3),
  ('https://admin-shell.io/idta/nameplate/3/0/Nameplate', 'Digital Nameplate', '3.0', 'AddressInformation', 'https://admin-shell.io/zvei/nameplate/1/0/ContactInformations/AddressInformation', 'IRI', 'Manufacturer contact address. A nested collection; note the template still points this at the 1/0 ContactInformations namespace, not 3/0.', true, 4),
  ('https://admin-shell.io/idta/nameplate/3/0/Nameplate', 'Digital Nameplate', '3.0', 'ManufacturerProductRoot', '0112/2///61360_7#AAS011#001', 'IRDI', 'Top-level product family the product belongs to.', false, 5),
  ('https://admin-shell.io/idta/nameplate/3/0/Nameplate', 'Digital Nameplate', '3.0', 'ManufacturerProductFamily', '0112/2///61987#ABP464#002', 'IRDI', 'Product family. Mandatory unless ManufacturerProductType is given.', false, 6),
  ('https://admin-shell.io/idta/nameplate/3/0/Nameplate', 'Digital Nameplate', '3.0', 'ManufacturerProductType', '0112/2///61987#ABA300#008', 'IRDI', 'Product type as characterised by the manufacturer. Mandatory unless ManufacturerProductFamily is given.', false, 7),
  ('https://admin-shell.io/idta/nameplate/3/0/Nameplate', 'Digital Nameplate', '3.0', 'OrderCodeOfManufacturer', '0112/2///61987#ABA950#008', 'IRDI', 'Manufacturer order code for the product.', false, 8),
  ('https://admin-shell.io/idta/nameplate/3/0/Nameplate', 'Digital Nameplate', '3.0', 'ProductArticleNumberOfManufacturer', '0112/2///61987#ABA581#007', 'IRDI', 'Manufacturer article number.', false, 9),
  ('https://admin-shell.io/idta/nameplate/3/0/Nameplate', 'Digital Nameplate', '3.0', 'SerialNumber', '0112/2///61987#ABA951#009', 'IRDI', 'Serial number uniquely identifying this instance for its manufacturer. The closest thing a physical plate has to an identity, and NOT the same as sparkplug_id, which this platform issues.', false, 10),
  ('https://admin-shell.io/idta/nameplate/3/0/Nameplate', 'Digital Nameplate', '3.0', 'YearOfConstruction', '0112/2///61987#ABP000#002', 'IRDI', 'Year the product was built. Typed as a string in the template, not an integer.', true, 11),
  ('https://admin-shell.io/idta/nameplate/3/0/Nameplate', 'Digital Nameplate', '3.0', 'DateOfManufacture', '0112/2///61987#ABB757#007', 'IRDI', 'Date the product was manufactured.', false, 12),
  ('https://admin-shell.io/idta/nameplate/3/0/Nameplate', 'Digital Nameplate', '3.0', 'HardwareVersion', '0112/2///61987#ABA926#008', 'IRDI', 'Hardware version of the product.', false, 13),
  ('https://admin-shell.io/idta/nameplate/3/0/Nameplate', 'Digital Nameplate', '3.0', 'FirmwareVersion', '0112/2///61987#ABA302#006', 'IRDI', 'Firmware version of the product. Often published by the device itself, in which case the device''s answer is the one exported.', false, 14),
  ('https://admin-shell.io/idta/nameplate/3/0/Nameplate', 'Digital Nameplate', '3.0', 'SoftwareVersion', '0112/2///61987#ABA601#008', 'IRDI', 'Software version of the product.', false, 15),
  ('https://admin-shell.io/idta/nameplate/3/0/Nameplate', 'Digital Nameplate', '3.0', 'CountryOfOrigin', '0112/2///61987#ABP462#001', 'IRDI', 'Country the product originates from.', false, 16),
  ('https://admin-shell.io/idta/nameplate/3/0/Nameplate', 'Digital Nameplate', '3.0', 'UniqueFacilityIdentifier', 'https://admin-shell.io/idta/nameplate/3/0/UniqueFacilityIdentifier', 'IRI', 'Unique identifier of the facility the product was made in. One of the few 3.0 elements identified by an admin-shell.io IRI rather than an IRDI.', false, 17),
  ('https://admin-shell.io/idta/nameplate/3/0/Nameplate', 'Digital Nameplate', '3.0', 'CompanyLogo', '0112/2///61987#ABP463#001', 'IRDI', 'Manufacturer logo. A File element in the template, so it is not stored as nameplate text here.', false, 18),
  ('https://admin-shell.io/idta/nameplate/3/0/Nameplate', 'Digital Nameplate', '3.0', 'Markings', '0112/2///61360_7#AAS006#001', 'IRDI', 'Conformity markings -- CE, UKCA and the like. A nested collection.', false, 19),
  ('https://admin-shell.io/idta/nameplate/3/0/Nameplate', 'Digital Nameplate', '3.0', 'AssetSpecificProperties', '0173-1#02-ABI218#003/0173-1#01-AGZ672#004', 'IRDI', 'Manufacturer-specific properties that are not part of the standard set. A nested collection, and the only seeded id that is an ECLASS pair rather than a single IRDI.', false, 20)
ON CONFLICT (template_id, id_short) DO UPDATE SET
  template_name    = EXCLUDED.template_name,
  template_version = EXCLUDED.template_version,
  semantic_id      = EXCLUDED.semantic_id,
  semantic_id_type = EXCLUDED.semantic_id_type,
  description      = EXCLUDED.description,
  is_mandatory     = EXCLUDED.is_mandatory,
  ordinal          = EXCLUDED.ordinal;


NOTIFY pgrst, 'reload schema';
