-- 0324: A nameplate holds the manufacturer's address and order code.
--
-- The Digital Nameplate (IDTA 02006, 3.0) asks for five elements at its top: URIOfTheProduct,
-- ManufacturerName, ManufacturerProductDesignation, AddressInformation and OrderCodeOfManufacturer.
-- device_nameplate had no column for the last two, so no device's nameplate could be complete, and no
-- exported one could say which template it follows.
--
--   * device_nameplate gains order_code_of_manufacturer and the five address columns. Text, like the
--     columns beside them: the template types the address elements as multi-language, with at most one
--     string in any language, and the AAS export writes them so.
--   * The change-proposal lane admits the six, and approve_proposal() applies them.
--   * idta_template_elements gains Contact Information (IDTA 02002) 1.0.4, 36 elements: the template that
--     defines the elements of AddressInformation, and gives them their ids.
--
-- Street, Zipcode, CityTown and NationalCode are mandatory in a nameplate by its specification's text
-- (*Mandatory information for address information*), and StateCounty is optional. No file says so:
-- Contact Information marks each of them ZeroToOne. The exporter and the Nameplate dialog name the four.
--
-- ⚠ VERIFY. Contact Information is read from admin-shell-io/submodel-templates at commit 5285185b
-- (2026-10-29), whose licence file is CC BY 4.0; nothing was typed from the specification's PDF. The file
-- as IDTA publishes it also carries 29 ConceptDescriptions with ECLASS text, and one sentence that quotes
-- ECLASS's definition of a language: the kept copy leaves both out. Listing a template is not a
-- conformance claim.
--
-- Reasoning: supabase/README.md, "A nameplate holds the manufacturer's address and order code (0324)".
-- Idempotent.
--
-- Redefines public.proposable_columns: 0324 admits the six new columns in the nameplate lane. The rest is
--   0202's, with 0176's search_path pin
-- Redefines public.approve_proposal: 0324 sets the six new columns in the nameplate branch. The rest is
--   0165's

-- -------------------------------------------------------------------------------------------------
-- 1. The columns
-- -------------------------------------------------------------------------------------------------
ALTER TABLE public.device_nameplate
    ADD COLUMN IF NOT EXISTS order_code_of_manufacturer text,
    ADD COLUMN IF NOT EXISTS address_street text,
    ADD COLUMN IF NOT EXISTS address_zipcode text,
    ADD COLUMN IF NOT EXISTS address_city_town text,
    ADD COLUMN IF NOT EXISTS address_state_county text,
    ADD COLUMN IF NOT EXISTS address_national_code text;

COMMENT ON COLUMN public.device_nameplate.order_code_of_manufacturer IS
  'The code the manufacturer takes an order for this product by (OrderCodeOfManufacturer). The template asks for it (0324).';
COMMENT ON COLUMN public.device_nameplate.address_street IS
  'The manufacturer''s street and house number (AddressInformation.Street). The template''s specification asks for it (0324).';
COMMENT ON COLUMN public.device_nameplate.address_zipcode IS
  'The manufacturer''s postal code (AddressInformation.Zipcode). The template''s specification asks for it (0324).';
COMMENT ON COLUMN public.device_nameplate.address_city_town IS
  'The manufacturer''s town or city (AddressInformation.CityTown). The template''s specification asks for it (0324).';
COMMENT ON COLUMN public.device_nameplate.address_state_county IS
  'The manufacturer''s state or county (AddressInformation.StateCounty). Optional (0324).';
COMMENT ON COLUMN public.device_nameplate.address_national_code IS
  'The manufacturer''s country, as an ISO 3166-1 code such as DE (AddressInformation.NationalCode). The template''s '
  'specification asks for it (0324).';

-- -------------------------------------------------------------------------------------------------
-- 2. The change-proposal lane
-- -------------------------------------------------------------------------------------------------
-- 0202's definition with the six columns. The SET clause restates the pin, which a CREATE OR REPLACE
-- would otherwise clear.
CREATE OR REPLACE FUNCTION public.proposable_columns(p_entity_type text) RETURNS text[]
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public'
    AS $$
  SELECT CASE p_entity_type
    -- `area_id` joins `cell_id` and `location_scope`: the three together say where an asset sits,
    -- and the table's CHECKs decide whether the triple is sayable, so one proposal can relocate.
    WHEN 'devices' THEN ARRAY[
      'name', 'description', 'cell_id', 'area_id', 'location_scope', 'model_3d_path'
    ]
    WHEN 'device_nameplate' THEN ARRAY[
      'manufacturer_name', 'manufacturer_product_designation', 'manufacturer_product_type',
      'serial_number', 'year_of_construction', 'date_of_manufacture', 'hardware_version',
      'firmware_version', 'software_version', 'country_of_origin', 'uri_of_the_product',
      'order_code_of_manufacturer', 'address_street', 'address_zipcode', 'address_city_town',
      'address_state_county', 'address_national_code'
    ]

    -- Every column of an area a person chooses; the other two are the platform's. `name` reaches
    -- MQTT as the <area> segment of every uns/ topic beneath it, which is why the table carries
    -- `areas_name_topic_safe` and a UNIQUE -- both run on the approval's UPDATE. `icon` is one of
    -- the eight names `areas_icon_valid` admits.
    WHEN 'areas' THEN ARRAY['name', 'description', 'icon']

    -- `icon` is one of eight names the CHECK on the table admits. `area_id` and the place are where
    -- the cell is; the cells trigger decides whether the three agree. A cell's dashboard is one of
    -- its links.
    WHEN 'cells' THEN ARRAY['name', 'icon', 'area_id', 'plan_x', 'plan_y', 'description']

    WHEN 'gateways' THEN ARRAY['name', 'description', 'cell_id', 'area_id', 'location_scope', 'access_url']

    -- 'schemas' is absent on purpose, and so are the three link lanes 0108 withdrew: the empty
    -- array is how this function closes a lane.
    ELSE ARRAY[]::text[]
  END
$$;

COMMENT ON FUNCTION public.proposable_columns(p_entity_type text) IS
  'Which columns a change proposal may name, per entity type. An unknown or withdrawn entity type '
  'yields the empty array, so a lane nobody has written an allowlist for can propose nothing at all '
  'rather than everything. Withdrawn: schemas (0090) and the three link lanes (0108). Areas joined in '
  '0123, and a nameplate''s order code and address in 0324.';

-- 0165's definition with the six columns in the nameplate branch.
CREATE OR REPLACE FUNCTION public.approve_proposal(p_proposal_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_proposal  public.change_proposals%ROWTYPE;
    v_device    public.devices%ROWTYPE;
    v_merged    public.devices%ROWTYPE;
    v_plate     public.device_nameplate%ROWTYPE;
    v_plate_new public.device_nameplate%ROWTYPE;
    v_area      public.areas%ROWTYPE;
    v_area_new  public.areas%ROWTYPE;
    v_cell      public.cells%ROWTYPE;
    v_cell_new  public.cells%ROWTYPE;
    v_gateway   public.gateways%ROWTYPE;
    v_gw_new    public.gateways%ROWTYPE;
    v_actor     uuid := auth.uid();
    v_allowed   text[];
    v_key       text;
    v_trail    bigint;
BEGIN
    -- The outer gate is the union of everybody who may decide anything; the lane's own gate below
    -- is the one that decides.
    IF NOT (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
            OR public.has_authority(ARRAY['cell:manage', 'gateway:manage'])) THEN
        RAISE EXCEPTION 'not permitted to decide change proposals'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM public.require_mfa();

    SELECT * INTO v_proposal FROM public.change_proposals
     WHERE id = p_proposal_id FOR UPDATE;
    IF NOT FOUND THEN
        PERFORM public.raise_not_found(format('proposal %s not found', p_proposal_id));
    END IF;

    IF NOT public.may_decide_proposal(v_proposal.entity_type) THEN
        RAISE EXCEPTION 'not permitted to decide proposals on %', v_proposal.entity_type
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF v_proposal.status <> 'open' THEN
        RAISE EXCEPTION 'proposal % is already %', p_proposal_id, v_proposal.status
            USING ERRCODE = 'check_violation';
    END IF;

    -- Re-validated, not trusted: the patch may have been edited since the insert trigger checked
    -- it, and the allowlist may have narrowed.
    v_allowed := public.proposable_columns(v_proposal.entity_type);
    FOREACH v_key IN ARRAY ARRAY(SELECT jsonb_object_keys(v_proposal.patch)) LOOP
        IF NOT (v_key = ANY (v_allowed)) THEN
            RAISE EXCEPTION 'proposal % names % , which is not proposable on %; reject it, and ask for a new proposal without it',
                p_proposal_id, v_key, v_proposal.entity_type
                USING ERRCODE = 'invalid_parameter_value';
        END IF;
    END LOOP;

    -- Already true is not approvable: the repair is a rejection naming what happened.
    IF public.proposal_is_already_true(p_proposal_id) THEN
        RAISE EXCEPTION
            'this change is already in place -- somebody made it while the proposal was open; reject it with that as the reason rather than recording an approval that changes nothing'
            USING ERRCODE = 'check_violation';
    END IF;

    -- Attribute every trigger-written audit row in this transaction to the approver. SET LOCAL,
    -- so it is discarded at COMMIT.
    PERFORM set_config('aber.actor_id', v_actor::text, true);

    IF v_proposal.entity_type = 'devices' THEN
        SELECT * INTO v_device FROM public.devices
         WHERE id = v_proposal.entity_id FOR UPDATE;
        IF NOT FOUND THEN
            PERFORM public.raise_not_found(
                format('device %s no longer exists', v_proposal.entity_id));
        END IF;

        SELECT * INTO v_merged FROM jsonb_populate_record(v_device, v_proposal.patch);

        UPDATE public.devices
           SET name              = v_merged.name,
               description       = v_merged.description,
               cell_id           = v_merged.cell_id,
               area_id           = v_merged.area_id,
               location_scope    = v_merged.location_scope,
               model_3d_path     = v_merged.model_3d_path
         WHERE id = v_device.id;

    ELSIF v_proposal.entity_type = 'device_nameplate' THEN
        -- A device with no nameplate row yet is the normal case: the row is created by whoever
        -- first asserts something about the asset.
        INSERT INTO public.device_nameplate (device_id) VALUES (v_proposal.entity_id)
        ON CONFLICT (device_id) DO NOTHING;

        SELECT * INTO v_plate FROM public.device_nameplate
         WHERE device_id = v_proposal.entity_id FOR UPDATE;

        SELECT * INTO v_plate_new FROM jsonb_populate_record(v_plate, v_proposal.patch);

        UPDATE public.device_nameplate
           SET manufacturer_name                = v_plate_new.manufacturer_name,
               manufacturer_product_designation = v_plate_new.manufacturer_product_designation,
               manufacturer_product_type        = v_plate_new.manufacturer_product_type,
               serial_number                    = v_plate_new.serial_number,
               year_of_construction             = v_plate_new.year_of_construction,
               date_of_manufacture              = v_plate_new.date_of_manufacture,
               hardware_version                 = v_plate_new.hardware_version,
               firmware_version                 = v_plate_new.firmware_version,
               software_version                 = v_plate_new.software_version,
               country_of_origin                = v_plate_new.country_of_origin,
               uri_of_the_product               = v_plate_new.uri_of_the_product,
               order_code_of_manufacturer       = v_plate_new.order_code_of_manufacturer,
               address_street                   = v_plate_new.address_street,
               address_zipcode                  = v_plate_new.address_zipcode,
               address_city_town                = v_plate_new.address_city_town,
               address_state_county             = v_plate_new.address_state_county,
               address_national_code            = v_plate_new.address_national_code,
               updated_at                       = now(),
               -- The proposer: a nameplate is an assertion about the asset, and who made it is
               -- part of the record.
               updated_by                       = v_proposal.proposed_by
         WHERE device_id = v_proposal.entity_id;

    ELSIF v_proposal.entity_type = 'areas' THEN
        SELECT * INTO v_area FROM public.areas
         WHERE id = v_proposal.entity_id FOR UPDATE;
        IF NOT FOUND THEN
            PERFORM public.raise_not_found(
                format('area %s no longer exists', v_proposal.entity_id));
        END IF;

        SELECT * INTO v_area_new FROM jsonb_populate_record(v_area, v_proposal.patch);

        -- `areas_name_topic_safe`, `areas_name_key` and `areas_icon_valid` run on this UPDATE, so a
        -- taken name, a topic separator or an unknown icon aborts the approval with the database's
        -- own sentence and the proposal stays open.
        UPDATE public.areas
           SET name        = v_area_new.name,
               description = v_area_new.description,
               icon        = v_area_new.icon
         WHERE id = v_area.id;

    ELSIF v_proposal.entity_type = 'cells' THEN
        SELECT * INTO v_cell FROM public.cells
         WHERE id = v_proposal.entity_id FOR UPDATE;
        IF NOT FOUND THEN
            PERFORM public.raise_not_found(
                format('cell %s no longer exists', v_proposal.entity_id));
        END IF;

        SELECT * INTO v_cell_new FROM jsonb_populate_record(v_cell, v_proposal.patch);

        -- The table's CHECKs, the area foreign key and place_cell_in_its_area() run on this
        -- UPDATE, so an unknown icon, a deleted area or a place too close to a neighbour aborts
        -- the approval rather than being stored.
        UPDATE public.cells
           SET name        = v_cell_new.name,
               icon        = v_cell_new.icon,
               area_id     = v_cell_new.area_id,
               plan_x      = v_cell_new.plan_x,
               plan_y      = v_cell_new.plan_y,
               description = v_cell_new.description
         WHERE id = v_cell.id;

    ELSIF v_proposal.entity_type = 'gateways' THEN
        SELECT * INTO v_gateway FROM public.gateways
         WHERE id = v_proposal.entity_id FOR UPDATE;
        IF NOT FOUND THEN
            PERFORM public.raise_not_found(
                format('gateway %s no longer exists', v_proposal.entity_id));
        END IF;

        SELECT * INTO v_gw_new FROM jsonb_populate_record(v_gateway, v_proposal.patch);

        -- The location CHECKs guard this statement; a relocation that breaks one fails here, inside
        -- the approver's transaction, and the proposal stays open with the database's own sentence.
        UPDATE public.gateways
           SET name           = v_gw_new.name,
               description    = v_gw_new.description,
               cell_id        = v_gw_new.cell_id,
               area_id        = v_gw_new.area_id,
               location_scope = v_gw_new.location_scope,
               access_url     = v_gw_new.access_url
         WHERE id = v_gateway.id;

    END IF;
    -- No `schemas` or link branch: those lanes are withdrawn and may_decide_proposal() refuses
    -- them above.

    -- The row that names both parties; the target's own audit trigger records only the approver.
    -- causation_id is this transaction, which the trigger also stamped on the target's row, so
    -- the two group as one act.
    INSERT INTO public.audit_trail
        (entity_type, entity_id, action, old_data, new_data, changed_by, actor_source,
         causation_id, audit_domain)
    VALUES (
        v_proposal.entity_type,
        v_proposal.entity_id,
        'PROPOSAL_APPLIED',
        NULL,
        jsonb_build_object(
            'proposal_id',       v_proposal.id,
            'proposed_by',       v_proposal.proposed_by,
            'proposed_by_email', v_proposal.proposed_by_email,
            'approved_by',       v_actor,
            'patch',             v_proposal.patch,
            'rationale',         v_proposal.rationale
        ),
        v_actor,
        'user',
        txid_current(),
        public.audit_domain_for(v_proposal.entity_type, 'PROPOSAL_APPLIED')
    )
    RETURNING id INTO v_trail;

    PERFORM set_config('aber.proposal_transition', 'on', true);

    UPDATE public.change_proposals
       SET status = 'applied', decided_by = v_actor, decided_at = now(),
           applied_trail_id = v_trail
     WHERE id = p_proposal_id;

    RETURN jsonb_build_object(
        'id', p_proposal_id, 'status', 'applied', 'trail_id', v_trail
    );
END;
$$;

ALTER FUNCTION public.approve_proposal(p_proposal_id uuid) OWNER TO postgres;

-- -------------------------------------------------------------------------------------------------
-- 3. The template the address elements come from
-- -------------------------------------------------------------------------------------------------
-- >>> BEGIN GENERATED idta_template_elements -- 36 rows, sha256:da82d4e3b3eb6ae7
-- GENERATED by scripts/generate-idta-template.mjs from
--   scripts/vocabularies/idta-02002-1-0-4-contact-information.json (IDTA 02002, Contact Information 1.0.4)
-- Do not edit these rows by hand: change the script and re-run it. CI verifies the digest above.
INSERT INTO public.idta_template_elements (template_id, template_name, template_number, template_version, path, parent_path, ordinal, id_short, model_type, value_type, semantic_id, semantic_id_type, supplemental_semantic_ids, cardinality, definition, example_value)
SELECT 'https://admin-shell.io/zvei/nameplate/1/0/ContactInformations', 'Contact Information', 'IDTA 02002', '1.0.4',
       e.path::text, e.parent_path::text, e.ordinal::integer, e.id_short::text, e.model_type::text, e.value_type::text, e.semantic_id::text, e.semantic_id_type::text, e.supplemental_semantic_ids, e.cardinality::text, e.definition::text, e.example_value::text
  FROM (VALUES
('ContactInformation', NULL, 1, 'ContactInformation', 'SubmodelElementCollection', NULL, 'https://admin-shell.io/zvei/nameplate/1/0/ContactInformations/ContactInformation', 'IRI', ARRAY[]::text[], 'OneToMany', 'The SMC “ContactInformation” contains information on how to contact the manufacturer or an authorised service provider, e.g. when a maintenance service is required', NULL),
('ContactInformation.RoleOfContactPerson', 'ContactInformation', 2, 'RoleOfContactPerson', 'Property', 'xs:string', '0173-1#02-AAO204#003', 'IRDI', ARRAY[]::text[], 'ZeroToOne', 'enumeration: 0173-1#07-AAS927#001 (administrativ contact), 0173-1#07-AAS928#001 (commercial contact), 0173-1#07-AAS929#001 (other contact), 0173-1#07-AAS930#001 (hazardous goods contact), 0173-1#07-AAS931#001 (technical contact). Note: the above mentioned ECLASS enumeration should be declared as “open” for further addition. ECLASS enumeration IRDI is preferable. If no IRDI available, custom input as String may also be accepted.', '0173-1#07-AAS931#001'),
('ContactInformation.NationalCode', 'ContactInformation', 3, 'NationalCode', 'MultiLanguageProperty', NULL, '0173-1#02-AAO134#002', 'IRDI', ARRAY[]::text[], 'ZeroToOne', 'Note: country codes defined accord. to ISO 3166-1. Recommendation: property declaration as MLP is required by its semantic definition. As the property value is language independent, users are recommended to provide maximal 1 string in any language of the user’s choice.', 'DE'),
('ContactInformation.Language', 'ContactInformation', 4, 'Language', 'Property', 'xs:string', 'https://admin-shell.io/zvei/nameplate/1/0/ContactInformations/ContactInformation/Language', 'IRI', ARRAY[]::text[], 'ZeroToMany', 'Note: language codes defined accord. to ISO 639-1.', 'de'),
('ContactInformation.TimeZone', 'ContactInformation', 5, 'TimeZone', 'Property', 'xs:string', 'https://admin-shell.io/zvei/nameplate/1/0/ContactInformations/ContactInformation/TimeZone', 'IRI', ARRAY[]::text[], 'ZeroToOne', 'offsets from Coordinated Universal Time (UTC). Note: notation accord. to ISO 8601 Note: for time in UTC the zone designator “Z” is to be used', 'Z'),
('ContactInformation.CityTown', 'ContactInformation', 6, 'CityTown', 'MultiLanguageProperty', NULL, '0173-1#02-AAO132#002', 'IRDI', ARRAY[]::text[], 'ZeroToOne', NULL, 'Musterstadt'),
('ContactInformation.Company', 'ContactInformation', 7, 'Company', 'MultiLanguageProperty', NULL, '0173-1#02-AAW001#001', 'IRDI', ARRAY[]::text[], 'ZeroToOne', NULL, 'ABC Company'),
('ContactInformation.Department', 'ContactInformation', 8, 'Department', 'MultiLanguageProperty', NULL, '0173-1#02-AAO127#003', 'IRDI', ARRAY[]::text[], 'ZeroToOne', NULL, 'Vertrieb'),
('ContactInformation.Phone', 'ContactInformation', 9, 'Phone', 'SubmodelElementCollection', NULL, 'https://admin-shell.io/zvei/nameplate/1/0/ContactInformations/ContactInformation/Phone', 'IRI', ARRAY[]::text[], 'ZeroToOne', 'Phone number including type', NULL),
('ContactInformation.Phone.TelephoneNumber', 'ContactInformation.Phone', 10, 'TelephoneNumber', 'MultiLanguageProperty', NULL, '0173-1#02-AAO136#002', 'IRDI', ARRAY[]::text[], 'One', 'Recommendation: property declaration as MLP is required by its semantic definition. As the property value is language independent, users are recommended to provide maximal 1 string in any language of the user’s choice.', '+491234567890'),
('ContactInformation.Phone.TypeOfTelephone', 'ContactInformation.Phone', 11, 'TypeOfTelephone', 'Property', 'xs:string', '0173-1#02-AAO137#003', 'IRDI', ARRAY[]::text[], 'ZeroToOne', 'enumeration: 0173-1#07-AAS754#001 (office), 0173-1#07-AAS755#001 (office mobile), 0173-1#07-AAS756#001 (secretary), 0173-1#07-AAS757#001 (substitute), 0173-1#07-AAS758#001 (home), 0173-1#07-AAS759#001 (private mobile)', '0173-1#07-AAS754#001'),
('ContactInformation.Phone.AvailableTime', 'ContactInformation.Phone', 12, 'AvailableTime', 'MultiLanguageProperty', NULL, 'https://admin-shell.io/zvei/nameplate/1/0/ContactInformations/ContactInformation/AvailableTime/', 'IRI', ARRAY[]::text[], 'ZeroToOne', 'Specification of the available time window', 'Montag – Freitag 08:00 bis 16:00'),
('ContactInformation.Fax', 'ContactInformation', 13, 'Fax', 'SubmodelElementCollection', NULL, '0173-1#02-AAQ834#005', 'IRDI', ARRAY[]::text[], 'ZeroToOne', NULL, NULL),
('ContactInformation.Fax.FaxNumber', 'ContactInformation.Fax', 14, 'FaxNumber', 'MultiLanguageProperty', NULL, '0173-1#02-AAO195#002', 'IRDI', ARRAY[]::text[], 'One', 'Recommendation: property declaration as MLP is required by its semantic definition. As the property value is language independent, users are recommended to provide maximal 1 string in any language of the user’s choice.', '+491234567890'),
('ContactInformation.Fax.TypeOfFaxNumber', 'ContactInformation.Fax', 15, 'TypeOfFaxNumber', 'Property', 'xs:string', '0173-1#02-AAO196#003', 'IRDI', ARRAY[]::text[], 'ZeroToOne', 'enumeration: 0173-1#07-AAS754#001 (office), 0173-1#07-AAS756#001 (secretary), 0173-1#07-AAS758#001 (home)', '0173-1#07-AAS754#001'),
('ContactInformation.Email', 'ContactInformation', 16, 'Email', 'SubmodelElementCollection', NULL, '0173-1#02-AAQ836#005', 'IRDI', ARRAY[]::text[], 'ZeroToOne', NULL, NULL),
('ContactInformation.Email.EmailAddress', 'ContactInformation.Email', 17, 'EmailAddress', 'Property', 'xs:string', '0173-1#02-AAO198#002', 'IRDI', ARRAY[]::text[], 'One', NULL, 'email@muster-ag.de'),
('ContactInformation.Email.PublicKey', 'ContactInformation.Email', 18, 'PublicKey', 'MultiLanguageProperty', NULL, '0173-1#02-AAO200#002', 'IRDI', ARRAY[]::text[], 'ZeroToOne', 'Recommendation: property declaration as MLP is required by its semantic definition. As the property value is language independent, users are recommended to provide maximal 1 string in any language of the user’s choice.', 'PGPKEY-12345'),
('ContactInformation.Email.TypeOfEmailAddress', 'ContactInformation.Email', 19, 'TypeOfEmailAddress', 'Property', 'xs:string', '0173-1#02-AAO199#003', 'IRDI', ARRAY[]::text[], 'ZeroToOne', 'enumeration: 0173-1#07-AAS754#001 (office), 0173-1#07-AAS756#001 (secretary), 0173-1#07-AAS757#001 (substitute), 0173-1#07-AAS758#001 (home)', '0173-1#07-AAS754#001'),
('ContactInformation.Email.TypeOfPublicKey', 'ContactInformation.Email', 20, 'TypeOfPublicKey', 'MultiLanguageProperty', NULL, '0173-1#02-AAO201#002', 'IRDI', ARRAY[]::text[], 'ZeroToOne', NULL, 'PGP'),
('ContactInformation.IPCommunication__00__', 'ContactInformation', 21, 'IPCommunication__00__', 'SubmodelElementCollection', NULL, 'https://admin-shell.io/zvei/nameplate/1/0/ContactInformations/ContactInformation/IPCommunication', 'IRI', ARRAY[]::text[], 'ZeroToMany', NULL, NULL),
('ContactInformation.IPCommunication__00__.AddressOfAdditionalLink', 'ContactInformation.IPCommunication__00__', 22, 'AddressOfAdditionalLink', 'Property', 'xs:string', '0173-1#02-AAQ326#002', 'IRDI', ARRAY[]::text[], 'One', NULL, NULL),
('ContactInformation.IPCommunication__00__.TypeOfCommunication', 'ContactInformation.IPCommunication__00__', 23, 'TypeOfCommunication', 'Property', 'xs:string', 'https://admin-shell.io/zvei/nameplate/1/0/ContactInformations/ContactInformation/IPCommunication/TypeOfCommunication', 'IRI', ARRAY[]::text[], 'ZeroToOne', 'characterization of an IP-based communication channel', 'Chat'),
('ContactInformation.IPCommunication__00__.AvailableTime', 'ContactInformation.IPCommunication__00__', 24, 'AvailableTime', 'MultiLanguageProperty', NULL, 'https://admin-shell.io/zvei/nameplate/1/0/ContactInformations/ContactInformation/AvailableTime/', 'IRI', ARRAY[]::text[], 'ZeroToOne', 'Specification of the available time window', 'Montag – Freitag 08:00 bis 16:00'),
('ContactInformation.Street', 'ContactInformation', 25, 'Street', 'MultiLanguageProperty', NULL, '0173-1#02-AAO128#002', 'IRDI', ARRAY[]::text[], 'ZeroToOne', NULL, 'Musterstraße 1'),
('ContactInformation.Zipcode', 'ContactInformation', 26, 'Zipcode', 'MultiLanguageProperty', NULL, '0173-1#02-AAO129#002', 'IRDI', ARRAY[]::text[], 'ZeroToOne', 'Recommendation: property declaration as MLP is required by its semantic definition. As the property value is language independent, users are recommended to provide maximal 1 string in any language of the user’s choice.', '12345'),
('ContactInformation.POBox', 'ContactInformation', 27, 'POBox', 'MultiLanguageProperty', NULL, '0173-1#02-AAO130#002', 'IRDI', ARRAY[]::text[], 'ZeroToOne', NULL, 'PF 1234'),
('ContactInformation.ZipCodeOfPOBox', 'ContactInformation', 28, 'ZipCodeOfPOBox', 'MultiLanguageProperty', NULL, '0173-1#02-AAO131#002', 'IRDI', ARRAY[]::text[], 'ZeroToOne', 'Recommendation: property declaration as MLP is required by its semantic definition. As the property value is language independent, users are recommended to provide maximal 1 string in any language of the user’s choice.', '12345'),
('ContactInformation.StateCounty', 'ContactInformation', 29, 'StateCounty', 'MultiLanguageProperty', NULL, '0173-1#02-AAO133#002', 'IRDI', ARRAY[]::text[], 'ZeroToOne', NULL, 'Muster-Bundesland'),
('ContactInformation.NameOfContact', 'ContactInformation', 30, 'NameOfContact', 'MultiLanguageProperty', NULL, '0173-1#02-AAO205#002', 'IRDI', ARRAY[]::text[], 'ZeroToOne', NULL, 'Doe'),
('ContactInformation.FirstName', 'ContactInformation', 31, 'FirstName', 'MultiLanguageProperty', NULL, '0173-1#02-AAO206#002', 'IRDI', ARRAY[]::text[], 'ZeroToOne', NULL, 'John'),
('ContactInformation.MiddleNames', 'ContactInformation', 32, 'MiddleNames', 'MultiLanguageProperty', NULL, '0173-1#02-AAO207#002', 'IRDI', ARRAY[]::text[], 'ZeroToOne', NULL, 'A.'),
('ContactInformation.Title', 'ContactInformation', 33, 'Title', 'MultiLanguageProperty', NULL, '0173-1#02-AAO208#003', 'IRDI', ARRAY[]::text[], 'ZeroToOne', NULL, 'Mr.'),
('ContactInformation.AcademicTitle', 'ContactInformation', 34, 'AcademicTitle', 'MultiLanguageProperty', NULL, '0173-1#02-AAO209#003', 'IRDI', ARRAY[]::text[], 'ZeroToOne', NULL, 'Dr.'),
('ContactInformation.FurtherDetailsOfContact', 'ContactInformation', 35, 'FurtherDetailsOfContact', 'MultiLanguageProperty', NULL, '0173-1#02-AAO210#002', 'IRDI', ARRAY[]::text[], 'ZeroToOne', NULL, 'Contact available weekdays only'),
('ContactInformation.AddressOfAdditionalLink', 'ContactInformation', 36, 'AddressOfAdditionalLink', 'Property', 'xs:string', '0173-1#02-AAQ326#002', 'IRDI', ARRAY[]::text[], 'ZeroToOne', NULL, 'AddressOfAdditionalLink')
  ) AS e (path, parent_path, ordinal, id_short, model_type, value_type, semantic_id, semantic_id_type, supplemental_semantic_ids, cardinality, definition, example_value)
ON CONFLICT (template_id, path) DO UPDATE SET
  template_name = EXCLUDED.template_name,
  template_number = EXCLUDED.template_number,
  template_version = EXCLUDED.template_version,
  parent_path = EXCLUDED.parent_path,
  ordinal = EXCLUDED.ordinal,
  id_short = EXCLUDED.id_short,
  model_type = EXCLUDED.model_type,
  value_type = EXCLUDED.value_type,
  semantic_id = EXCLUDED.semantic_id,
  semantic_id_type = EXCLUDED.semantic_id_type,
  supplemental_semantic_ids = EXCLUDED.supplemental_semantic_ids,
  cardinality = EXCLUDED.cardinality,
  definition = EXCLUDED.definition,
  example_value = EXCLUDED.example_value
 WHERE (idta_template_elements.template_name, idta_template_elements.template_number, idta_template_elements.template_version, idta_template_elements.parent_path, idta_template_elements.ordinal, idta_template_elements.id_short, idta_template_elements.model_type, idta_template_elements.value_type, idta_template_elements.semantic_id, idta_template_elements.semantic_id_type, idta_template_elements.supplemental_semantic_ids, idta_template_elements.cardinality, idta_template_elements.definition, idta_template_elements.example_value)
       IS DISTINCT FROM (EXCLUDED.template_name, EXCLUDED.template_number, EXCLUDED.template_version, EXCLUDED.parent_path, EXCLUDED.ordinal, EXCLUDED.id_short, EXCLUDED.model_type, EXCLUDED.value_type, EXCLUDED.semantic_id, EXCLUDED.semantic_id_type, EXCLUDED.supplemental_semantic_ids, EXCLUDED.cardinality, EXCLUDED.definition, EXCLUDED.example_value);
-- <<< END GENERATED idta_template_elements

COMMENT ON TABLE public.idta_template_elements IS
  'The elements of the IDTA submodel templates Aber seeds, nested ones included, generated from the '
  'templates'' own JSON (CC BY 4.0). Reference data, not deployment state: a row is an element a template '
  'defines. Listing a template claims no conformance to it. The AAS export reads the Digital Nameplate''s '
  'cardinalities and types here, and Contact Information''s address elements (0324). The Nameplate''s '
  'top-level elements are also in idta_submodel_templates, with their ids (0320).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_new   text[] := ARRAY['order_code_of_manufacturer', 'address_street', 'address_zipcode', 'address_city_town',
                          'address_state_county', 'address_national_code'];
  v_lane  text[] := public.proposable_columns('device_nameplate');
  v_fn    regprocedure := 'public.approve_proposal(uuid)'::regprocedure;
  v_body  text;
  c       text;
BEGIN
  SELECT prosrc INTO v_body FROM pg_proc WHERE oid = v_fn;
  FOREACH c IN ARRAY v_new LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.device_nameplate'::regclass
                    AND attname = c AND atttypid = 'text'::regtype AND NOT attnotnull AND NOT attisdropped) THEN
      RAISE EXCEPTION '0324: device_nameplate.% is missing, or is not an optional text column', c;
    END IF;
    IF NOT (c = ANY (v_lane)) THEN
      RAISE EXCEPTION '0324: proposable_columns(''device_nameplate'') does not admit %', c;
    END IF;
    IF position('v_plate_new.' || c IN v_body) = 0 THEN
      RAISE EXCEPTION '0324: approve_proposal() does not set device_nameplate.%', c;
    END IF;
  END LOOP;
  IF NOT v_lane @> ARRAY['manufacturer_name', 'manufacturer_product_designation', 'manufacturer_product_type',
                         'serial_number', 'year_of_construction', 'date_of_manufacture', 'hardware_version',
                         'firmware_version', 'software_version', 'country_of_origin', 'uri_of_the_product'] THEN
    RAISE EXCEPTION '0324: proposable_columns(''device_nameplate'') lost a column it admits: %', v_lane;
  END IF;
  IF 'updated_by' = ANY (v_lane) OR 'updated_at' = ANY (v_lane) OR 'device_id' = ANY (v_lane) THEN
    RAISE EXCEPTION '0324: proposable_columns(''device_nameplate'') admits a column the database writes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.proposable_columns(text)'::regprocedure
                  AND coalesce(proconfig, '{}') @> ARRAY['search_path=public']) THEN
    RAISE EXCEPTION '0324: proposable_columns() does not pin its search_path';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn
                  AND prosecdef AND coalesce(proconfig, '{}') @> ARRAY['search_path=public']
                  AND position('public.require_mfa()' IN prosrc) > 0
                  AND position('public.proposable_columns(v_proposal.entity_type)' IN prosrc) > 0) THEN
    RAISE EXCEPTION '0324: approve_proposal() is not SECURITY DEFINER with its search_path pinned, no longer asks for a '
      'second factor, or no longer re-checks the patch';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0324: anon may execute approve_proposal()';
  END IF;
  -- The five address elements, each with an id, in the seeded template. Seeded rows alone.
  IF (SELECT count(DISTINCT e.id_short) FROM public.idta_template_elements e
       WHERE e.template_id = 'https://admin-shell.io/zvei/nameplate/1/0/ContactInformations'
         AND e.parent_path = 'ContactInformation' AND e.semantic_id IS NOT NULL
         AND e.id_short IN ('Street', 'Zipcode', 'CityTown', 'StateCounty', 'NationalCode')) <> 5 THEN
    RAISE EXCEPTION '0324: Contact Information does not hold the five address elements with their ids';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
