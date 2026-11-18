-- 0302: An AGV reading has a vocabulary.
--
-- AGVs were the one asset class on the pilot shopfloor with no vocabulary. An AGV's battery level,
-- driving flag and operating mode were Custom metrics under names each site made up, so two sites'
-- battery levels had nothing in common. VDA 5050 publishes the message a vehicle reports, `state`,
-- as JSON Schema under the MIT licence, so the fields that are readings can be generated and
-- guarded as the other vocabularies are.
--
--   * vda5050_vocabulary: one row per scalar field of the `state` message that is a reading, 24 of
--     them (`driving`, `powerSupply.stateOfCharge`, `mobileRobotPosition.x`), each with its datatype,
--     the schema's unit and description, and an enum's values as permitted_values. A table of its
--     own, as ASHRAE 223P has one: VDA 5050 is not an OPC UA companion specification, so filing it
--     in opcua_vocabulary would misstate where it came from.
--   * The rows are generated from tag 3.0.0's state.schema, which scripts/vocabularies/ keeps whole
--     and pins by SHA-256. scripts/generate-vda5050-vocabulary.mjs writes the block below and
--     scripts/check-vda5050-seed-sync.mjs checks it. The arrays (`loads`, `errors`, `actionStates`)
--     are left out because Sparkplug B has no composite type, and so are the header and the order
--     flow: a device's identity comes from its Sparkplug topic.
--   * Ids are minted here, under https://aber.local/semantics/vda5050/v3.0/State/<path>: the VDA
--     issues none, and an id under its own name would claim an interoperability nobody agreed.
--   * The metric group AGV is registered. enforce_metric_group_spelling() makes the first spelling
--     of a group permanent, and `AGV` is the word the pilot shopfloor uses. VDA 5050 3.0 calls the
--     vehicle a mobile robot; the group's description says so.
--   * concept_definitions is declared again with a VDA 5050 arm after MTConnect's, so an export
--     defines these ids by the schema's descriptions. Both vocabularies mint their ids under
--     aber.local, as ISO 22400's are. The view's columns do not change, so its grants and
--     security_invoker stay. (A view, so not a `-- Redefines` line: those mark functions.) 0301
--     declared it with five arms; this file declares the whole set, and is the one that must stay
--     complete when a later file adds another.
--
-- A position is a reading on the device, never devices.cell_id: writing it there would fire the Audit
-- Trail's trigger on every update. Where an asset is belongs to the place model, not to this table.
--
-- ⚠ VERIFY. Every row is read from the schema at tag 3.0.0 (commit e9ba560b, 2026-03-18); nothing
-- here was typed from the specification's PDF, which prevails where the two differ. Three position
-- fields (x, y, theta) carry a unit and no description in the schema, so their description is NULL
-- and an export falls back to the catalog's text for them. The schema's `unit` is the VDA's own
-- spelling (`m/s`), not an MTConnect UnitEnum name, so it is not filled into Add Metric. Adopting
-- the vocabulary is not a conformance claim to VDA 5050.
--
-- Reasoning: supabase/README.md, "An AGV reading has a vocabulary (0302)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The table
-- -------------------------------------------------------------------------------------------------
-- Reference data, as mtconnect_vocabulary and ashrae223_vocabulary are: a row is a field the
-- standard defines, not a metric a device publishes. Keyed on `name`, the field's path in the state
-- message with dots between the levels.
CREATE TABLE IF NOT EXISTS public.vda5050_vocabulary (
    name text NOT NULL,
    datatype text NOT NULL,
    unit text,
    description text,
    permitted_values text[],
    semantic_id text NOT NULL,
    CONSTRAINT vda5050_vocabulary_pkey PRIMARY KEY (name),
    CONSTRAINT vda5050_vocabulary_datatype_valid
        CHECK ((datatype = ANY (ARRAY['Double'::text, 'Int64'::text, 'Boolean'::text, 'String'::text]))),
    CONSTRAINT vda5050_vocabulary_permitted_values_shape
        CHECK (((permitted_values IS NULL)
                OR ((cardinality(permitted_values) > 0) AND (array_position(permitted_values, NULL::text) IS NULL)))),
    -- Every id is minted here, under the major line. One under vda5050.org would assert a standing
    -- the VDA never gave it.
    CONSTRAINT vda5050_vocabulary_semantic_id_namespace
        CHECK ((semantic_id ~~ 'https://aber.local/semantics/vda5050/v3.0/State/%'::text))
);

ALTER TABLE public.vda5050_vocabulary OWNER TO postgres;
ALTER TABLE public.vda5050_vocabulary ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.vda5050_vocabulary IS
  'The scalar fields of the VDA 5050 state message that are readings, generated from its JSON Schema '
  'at tag 3.0.0 (MIT). Reference data, not deployment state: a row is a field the standard defines. '
  'The ids are minted here under aber.local. VDA 5050 3.0 calls the vehicle a mobile robot (0302).';
COMMENT ON COLUMN public.vda5050_vocabulary.name IS
  'The field''s path in the state message, with a dot between levels: driving, powerSupply.stateOfCharge. '
  'A metric is named AGV/<the path with slashes>, so velocity.vx is AGV/velocity/vx (0302).';
COMMENT ON COLUMN public.vda5050_vocabulary.datatype IS
  'The Sparkplug B datatype: Double for a JSON number, Int64 for an integer, Boolean and String. '
  'The Add Metric form offers Double, Boolean and String, so an integer would be a Double there (0302).';
COMMENT ON COLUMN public.vda5050_vocabulary.unit IS
  'The schema''s own unit keyword, as the VDA writes it (m/s, rad). Not an MTConnect UnitEnum name, '
  'so Add Metric does not fill it in. NULL for a field the schema gives none (0302).';
COMMENT ON COLUMN public.vda5050_vocabulary.description IS
  'The schema''s description of the field, on one line. NULL where the schema gives none (0302).';
COMMENT ON COLUMN public.vda5050_vocabulary.permitted_values IS
  'The values of an enum field, such as the seven operating modes. NULL for a field that is not one (0302).';
COMMENT ON COLUMN public.vda5050_vocabulary.semantic_id IS
  'Local-namespace IRI for the field, minted by this deployment, not issued by the VDA: '
  'https://aber.local/semantics/vda5050/v3.0/State/<path>. Pinned to the major line (0302).';

-- Anyone signed in reads it. Nobody writes it: the generated rows below are the only writer, and
-- run as the owner. anon is revoked by name.
REVOKE ALL ON TABLE public.vda5050_vocabulary FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.vda5050_vocabulary TO authenticated, service_role;

SELECT public.replay_policy('public.vda5050_vocabulary', 'vda5050_vocabulary_select_authenticated', $ddl$
CREATE POLICY vda5050_vocabulary_select_authenticated ON public.vda5050_vocabulary FOR SELECT TO authenticated USING (true);
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- 2. The metric group these fields file under
-- -------------------------------------------------------------------------------------------------
-- One group, as BMS is for 223P. `AGV/<path>` reads as the pilot shopfloor says it. A name that
-- differs only in case from a group a site already made is left to that site's: the insert does
-- nothing, and the self-check below looks for the group without regard to case.
INSERT INTO public.metric_groups (id, name, description, standard)
VALUES ('12184fb4-e38c-4b83-9230-f8b9aa3186af', 'AGV',
        'VDA 5050 automated guided vehicle readings: driving state, battery, velocity, position and safety. VDA 5050 3.0 calls the vehicle a mobile robot.',
        'VDA 5050')
ON CONFLICT DO NOTHING;

-- -------------------------------------------------------------------------------------------------
-- 3. The fields
-- -------------------------------------------------------------------------------------------------
-- >>> BEGIN GENERATED vda5050_vocabulary -- VDA 5050 3.0.0, 24 rows, sha256:f8748af0fca686c1
-- GENERATED from scripts/vocabularies/vda5050-3.0.0-state.schema by scripts/generate-vda5050-vocabulary.mjs.
-- Do not edit these rows by hand: change the script and re-run it. CI verifies the digest above.
INSERT INTO public.vda5050_vocabulary VALUES ('distanceSinceLastNode', 'Double', NULL, 'Used by line guided vehicles to indicate the distance it has been driving past the lastNodeId. Distance is in meters.', NULL, 'https://aber.local/semantics/vda5050/v3.0/State/distanceSinceLastNode')
ON CONFLICT (name) DO UPDATE SET
  datatype         = EXCLUDED.datatype,
  unit             = EXCLUDED.unit,
  description      = EXCLUDED.description,
  permitted_values = EXCLUDED.permitted_values,
  semantic_id      = EXCLUDED.semantic_id
 WHERE (vda5050_vocabulary.datatype, vda5050_vocabulary.unit, vda5050_vocabulary.description,
        vda5050_vocabulary.permitted_values, vda5050_vocabulary.semantic_id)
       IS DISTINCT FROM (EXCLUDED.datatype, EXCLUDED.unit, EXCLUDED.description,
                         EXCLUDED.permitted_values, EXCLUDED.semantic_id);
INSERT INTO public.vda5050_vocabulary VALUES ('driving', 'Boolean', NULL, 'True: indicates that the mobile robot is driving and/or rotating. Other movements of the mobile robot (e.g., lift movements) are not included here. False: indicates that the mobile robot is neither driving nor rotating', NULL, 'https://aber.local/semantics/vda5050/v3.0/State/driving')
ON CONFLICT (name) DO UPDATE SET
  datatype         = EXCLUDED.datatype,
  unit             = EXCLUDED.unit,
  description      = EXCLUDED.description,
  permitted_values = EXCLUDED.permitted_values,
  semantic_id      = EXCLUDED.semantic_id
 WHERE (vda5050_vocabulary.datatype, vda5050_vocabulary.unit, vda5050_vocabulary.description,
        vda5050_vocabulary.permitted_values, vda5050_vocabulary.semantic_id)
       IS DISTINCT FROM (EXCLUDED.datatype, EXCLUDED.unit, EXCLUDED.description,
                         EXCLUDED.permitted_values, EXCLUDED.semantic_id);
INSERT INTO public.vda5050_vocabulary VALUES ('lastNodeId', 'String', NULL, 'Node ID of last reached node or, if mobile robot is currently on a node, current node (e.g., "node7"). Empty string ("") if no lastNodeId is available.', NULL, 'https://aber.local/semantics/vda5050/v3.0/State/lastNodeId')
ON CONFLICT (name) DO UPDATE SET
  datatype         = EXCLUDED.datatype,
  unit             = EXCLUDED.unit,
  description      = EXCLUDED.description,
  permitted_values = EXCLUDED.permitted_values,
  semantic_id      = EXCLUDED.semantic_id
 WHERE (vda5050_vocabulary.datatype, vda5050_vocabulary.unit, vda5050_vocabulary.description,
        vda5050_vocabulary.permitted_values, vda5050_vocabulary.semantic_id)
       IS DISTINCT FROM (EXCLUDED.datatype, EXCLUDED.unit, EXCLUDED.description,
                         EXCLUDED.permitted_values, EXCLUDED.semantic_id);
INSERT INTO public.vda5050_vocabulary VALUES ('mobileRobotPosition.deviationRange', 'Double', 'm', 'Value for position deviation range in meters. Optional for vehicles that cannot estimate their deviation, e.g., grid-based localization. Only for logging and visualization purposes.', NULL, 'https://aber.local/semantics/vda5050/v3.0/State/mobileRobotPosition.deviationRange')
ON CONFLICT (name) DO UPDATE SET
  datatype         = EXCLUDED.datatype,
  unit             = EXCLUDED.unit,
  description      = EXCLUDED.description,
  permitted_values = EXCLUDED.permitted_values,
  semantic_id      = EXCLUDED.semantic_id
 WHERE (vda5050_vocabulary.datatype, vda5050_vocabulary.unit, vda5050_vocabulary.description,
        vda5050_vocabulary.permitted_values, vda5050_vocabulary.semantic_id)
       IS DISTINCT FROM (EXCLUDED.datatype, EXCLUDED.unit, EXCLUDED.description,
                         EXCLUDED.permitted_values, EXCLUDED.semantic_id);
INSERT INTO public.vda5050_vocabulary VALUES ('mobileRobotPosition.localizationScore', 'Double', NULL, 'Describes the quality of the localization and therefore, can be used, e.g., by SLAM mobile robot to describe how accurate the current position information is. 0.0: position unknown 1.0: position known Optional for vehicles that cannot estimate their localization score. Only for logging and visualization purposes', NULL, 'https://aber.local/semantics/vda5050/v3.0/State/mobileRobotPosition.localizationScore')
ON CONFLICT (name) DO UPDATE SET
  datatype         = EXCLUDED.datatype,
  unit             = EXCLUDED.unit,
  description      = EXCLUDED.description,
  permitted_values = EXCLUDED.permitted_values,
  semantic_id      = EXCLUDED.semantic_id
 WHERE (vda5050_vocabulary.datatype, vda5050_vocabulary.unit, vda5050_vocabulary.description,
        vda5050_vocabulary.permitted_values, vda5050_vocabulary.semantic_id)
       IS DISTINCT FROM (EXCLUDED.datatype, EXCLUDED.unit, EXCLUDED.description,
                         EXCLUDED.permitted_values, EXCLUDED.semantic_id);
INSERT INTO public.vda5050_vocabulary VALUES ('mobileRobotPosition.localized', 'Boolean', NULL, 'True: mobile robot is localized. x, y, and theta can be trusted. False: mobile robot is not localized. x, y, and theta cannot be trusted.', NULL, 'https://aber.local/semantics/vda5050/v3.0/State/mobileRobotPosition.localized')
ON CONFLICT (name) DO UPDATE SET
  datatype         = EXCLUDED.datatype,
  unit             = EXCLUDED.unit,
  description      = EXCLUDED.description,
  permitted_values = EXCLUDED.permitted_values,
  semantic_id      = EXCLUDED.semantic_id
 WHERE (vda5050_vocabulary.datatype, vda5050_vocabulary.unit, vda5050_vocabulary.description,
        vda5050_vocabulary.permitted_values, vda5050_vocabulary.semantic_id)
       IS DISTINCT FROM (EXCLUDED.datatype, EXCLUDED.unit, EXCLUDED.description,
                         EXCLUDED.permitted_values, EXCLUDED.semantic_id);
INSERT INTO public.vda5050_vocabulary VALUES ('mobileRobotPosition.mapId', 'String', NULL, 'Unique identification of the map.', NULL, 'https://aber.local/semantics/vda5050/v3.0/State/mobileRobotPosition.mapId')
ON CONFLICT (name) DO UPDATE SET
  datatype         = EXCLUDED.datatype,
  unit             = EXCLUDED.unit,
  description      = EXCLUDED.description,
  permitted_values = EXCLUDED.permitted_values,
  semantic_id      = EXCLUDED.semantic_id
 WHERE (vda5050_vocabulary.datatype, vda5050_vocabulary.unit, vda5050_vocabulary.description,
        vda5050_vocabulary.permitted_values, vda5050_vocabulary.semantic_id)
       IS DISTINCT FROM (EXCLUDED.datatype, EXCLUDED.unit, EXCLUDED.description,
                         EXCLUDED.permitted_values, EXCLUDED.semantic_id);
INSERT INTO public.vda5050_vocabulary VALUES ('mobileRobotPosition.theta', 'Double', 'rad', NULL, NULL, 'https://aber.local/semantics/vda5050/v3.0/State/mobileRobotPosition.theta')
ON CONFLICT (name) DO UPDATE SET
  datatype         = EXCLUDED.datatype,
  unit             = EXCLUDED.unit,
  description      = EXCLUDED.description,
  permitted_values = EXCLUDED.permitted_values,
  semantic_id      = EXCLUDED.semantic_id
 WHERE (vda5050_vocabulary.datatype, vda5050_vocabulary.unit, vda5050_vocabulary.description,
        vda5050_vocabulary.permitted_values, vda5050_vocabulary.semantic_id)
       IS DISTINCT FROM (EXCLUDED.datatype, EXCLUDED.unit, EXCLUDED.description,
                         EXCLUDED.permitted_values, EXCLUDED.semantic_id);
INSERT INTO public.vda5050_vocabulary VALUES ('mobileRobotPosition.x', 'Double', 'm', NULL, NULL, 'https://aber.local/semantics/vda5050/v3.0/State/mobileRobotPosition.x')
ON CONFLICT (name) DO UPDATE SET
  datatype         = EXCLUDED.datatype,
  unit             = EXCLUDED.unit,
  description      = EXCLUDED.description,
  permitted_values = EXCLUDED.permitted_values,
  semantic_id      = EXCLUDED.semantic_id
 WHERE (vda5050_vocabulary.datatype, vda5050_vocabulary.unit, vda5050_vocabulary.description,
        vda5050_vocabulary.permitted_values, vda5050_vocabulary.semantic_id)
       IS DISTINCT FROM (EXCLUDED.datatype, EXCLUDED.unit, EXCLUDED.description,
                         EXCLUDED.permitted_values, EXCLUDED.semantic_id);
INSERT INTO public.vda5050_vocabulary VALUES ('mobileRobotPosition.y', 'Double', 'm', NULL, NULL, 'https://aber.local/semantics/vda5050/v3.0/State/mobileRobotPosition.y')
ON CONFLICT (name) DO UPDATE SET
  datatype         = EXCLUDED.datatype,
  unit             = EXCLUDED.unit,
  description      = EXCLUDED.description,
  permitted_values = EXCLUDED.permitted_values,
  semantic_id      = EXCLUDED.semantic_id
 WHERE (vda5050_vocabulary.datatype, vda5050_vocabulary.unit, vda5050_vocabulary.description,
        vda5050_vocabulary.permitted_values, vda5050_vocabulary.semantic_id)
       IS DISTINCT FROM (EXCLUDED.datatype, EXCLUDED.unit, EXCLUDED.description,
                         EXCLUDED.permitted_values, EXCLUDED.semantic_id);
INSERT INTO public.vda5050_vocabulary VALUES ('newBaseRequest', 'Boolean', NULL, 'True: mobile robot is almost at the end of the base and will reduce speed if no new base is transmitted. Trigger for fleet control to send new base False: no base update required.', NULL, 'https://aber.local/semantics/vda5050/v3.0/State/newBaseRequest')
ON CONFLICT (name) DO UPDATE SET
  datatype         = EXCLUDED.datatype,
  unit             = EXCLUDED.unit,
  description      = EXCLUDED.description,
  permitted_values = EXCLUDED.permitted_values,
  semantic_id      = EXCLUDED.semantic_id
 WHERE (vda5050_vocabulary.datatype, vda5050_vocabulary.unit, vda5050_vocabulary.description,
        vda5050_vocabulary.permitted_values, vda5050_vocabulary.semantic_id)
       IS DISTINCT FROM (EXCLUDED.datatype, EXCLUDED.unit, EXCLUDED.description,
                         EXCLUDED.permitted_values, EXCLUDED.semantic_id);
INSERT INTO public.vda5050_vocabulary VALUES ('operatingMode', 'String', NULL, 'Current operating mode of the mobile robot.', ARRAY['STARTUP', 'AUTOMATIC', 'SEMIAUTOMATIC', 'INTERVENED', 'MANUAL', 'SERVICE', 'TEACH_IN'], 'https://aber.local/semantics/vda5050/v3.0/State/operatingMode')
ON CONFLICT (name) DO UPDATE SET
  datatype         = EXCLUDED.datatype,
  unit             = EXCLUDED.unit,
  description      = EXCLUDED.description,
  permitted_values = EXCLUDED.permitted_values,
  semantic_id      = EXCLUDED.semantic_id
 WHERE (vda5050_vocabulary.datatype, vda5050_vocabulary.unit, vda5050_vocabulary.description,
        vda5050_vocabulary.permitted_values, vda5050_vocabulary.semantic_id)
       IS DISTINCT FROM (EXCLUDED.datatype, EXCLUDED.unit, EXCLUDED.description,
                         EXCLUDED.permitted_values, EXCLUDED.semantic_id);
INSERT INTO public.vda5050_vocabulary VALUES ('paused', 'Boolean', NULL, 'True: mobile robot is currently in a paused state, either because of the push of a physical button on the mobile robot or because of an instantAction. The mobile robot can resume the order. False: The mobile robot is currently not in a paused state.', NULL, 'https://aber.local/semantics/vda5050/v3.0/State/paused')
ON CONFLICT (name) DO UPDATE SET
  datatype         = EXCLUDED.datatype,
  unit             = EXCLUDED.unit,
  description      = EXCLUDED.description,
  permitted_values = EXCLUDED.permitted_values,
  semantic_id      = EXCLUDED.semantic_id
 WHERE (vda5050_vocabulary.datatype, vda5050_vocabulary.unit, vda5050_vocabulary.description,
        vda5050_vocabulary.permitted_values, vda5050_vocabulary.semantic_id)
       IS DISTINCT FROM (EXCLUDED.datatype, EXCLUDED.unit, EXCLUDED.description,
                         EXCLUDED.permitted_values, EXCLUDED.semantic_id);
INSERT INTO public.vda5050_vocabulary VALUES ('powerSupply.batteryCurrent', 'Double', NULL, 'Battery current in Ampere (A)', NULL, 'https://aber.local/semantics/vda5050/v3.0/State/powerSupply.batteryCurrent')
ON CONFLICT (name) DO UPDATE SET
  datatype         = EXCLUDED.datatype,
  unit             = EXCLUDED.unit,
  description      = EXCLUDED.description,
  permitted_values = EXCLUDED.permitted_values,
  semantic_id      = EXCLUDED.semantic_id
 WHERE (vda5050_vocabulary.datatype, vda5050_vocabulary.unit, vda5050_vocabulary.description,
        vda5050_vocabulary.permitted_values, vda5050_vocabulary.semantic_id)
       IS DISTINCT FROM (EXCLUDED.datatype, EXCLUDED.unit, EXCLUDED.description,
                         EXCLUDED.permitted_values, EXCLUDED.semantic_id);
INSERT INTO public.vda5050_vocabulary VALUES ('powerSupply.batteryHealth', 'Double', NULL, 'State of health in percent.', NULL, 'https://aber.local/semantics/vda5050/v3.0/State/powerSupply.batteryHealth')
ON CONFLICT (name) DO UPDATE SET
  datatype         = EXCLUDED.datatype,
  unit             = EXCLUDED.unit,
  description      = EXCLUDED.description,
  permitted_values = EXCLUDED.permitted_values,
  semantic_id      = EXCLUDED.semantic_id
 WHERE (vda5050_vocabulary.datatype, vda5050_vocabulary.unit, vda5050_vocabulary.description,
        vda5050_vocabulary.permitted_values, vda5050_vocabulary.semantic_id)
       IS DISTINCT FROM (EXCLUDED.datatype, EXCLUDED.unit, EXCLUDED.description,
                         EXCLUDED.permitted_values, EXCLUDED.semantic_id);
INSERT INTO public.vda5050_vocabulary VALUES ('powerSupply.batteryVoltage', 'Double', NULL, 'Battery voltage', NULL, 'https://aber.local/semantics/vda5050/v3.0/State/powerSupply.batteryVoltage')
ON CONFLICT (name) DO UPDATE SET
  datatype         = EXCLUDED.datatype,
  unit             = EXCLUDED.unit,
  description      = EXCLUDED.description,
  permitted_values = EXCLUDED.permitted_values,
  semantic_id      = EXCLUDED.semantic_id
 WHERE (vda5050_vocabulary.datatype, vda5050_vocabulary.unit, vda5050_vocabulary.description,
        vda5050_vocabulary.permitted_values, vda5050_vocabulary.semantic_id)
       IS DISTINCT FROM (EXCLUDED.datatype, EXCLUDED.unit, EXCLUDED.description,
                         EXCLUDED.permitted_values, EXCLUDED.semantic_id);
INSERT INTO public.vda5050_vocabulary VALUES ('powerSupply.charging', 'Boolean', NULL, 'True: charging in progress. False: mobile robot is currently not charging.', NULL, 'https://aber.local/semantics/vda5050/v3.0/State/powerSupply.charging')
ON CONFLICT (name) DO UPDATE SET
  datatype         = EXCLUDED.datatype,
  unit             = EXCLUDED.unit,
  description      = EXCLUDED.description,
  permitted_values = EXCLUDED.permitted_values,
  semantic_id      = EXCLUDED.semantic_id
 WHERE (vda5050_vocabulary.datatype, vda5050_vocabulary.unit, vda5050_vocabulary.description,
        vda5050_vocabulary.permitted_values, vda5050_vocabulary.semantic_id)
       IS DISTINCT FROM (EXCLUDED.datatype, EXCLUDED.unit, EXCLUDED.description,
                         EXCLUDED.permitted_values, EXCLUDED.semantic_id);
INSERT INTO public.vda5050_vocabulary VALUES ('powerSupply.range', 'Double', NULL, 'Estimated reach with current State of Charge in meter.', NULL, 'https://aber.local/semantics/vda5050/v3.0/State/powerSupply.range')
ON CONFLICT (name) DO UPDATE SET
  datatype         = EXCLUDED.datatype,
  unit             = EXCLUDED.unit,
  description      = EXCLUDED.description,
  permitted_values = EXCLUDED.permitted_values,
  semantic_id      = EXCLUDED.semantic_id
 WHERE (vda5050_vocabulary.datatype, vda5050_vocabulary.unit, vda5050_vocabulary.description,
        vda5050_vocabulary.permitted_values, vda5050_vocabulary.semantic_id)
       IS DISTINCT FROM (EXCLUDED.datatype, EXCLUDED.unit, EXCLUDED.description,
                         EXCLUDED.permitted_values, EXCLUDED.semantic_id);
INSERT INTO public.vda5050_vocabulary VALUES ('powerSupply.stateOfCharge', 'Double', NULL, 'State of Charge in %: If mobile robot only provides values for good or bad battery levels, these will be indicated as 20% (bad) and 80% (good).', NULL, 'https://aber.local/semantics/vda5050/v3.0/State/powerSupply.stateOfCharge')
ON CONFLICT (name) DO UPDATE SET
  datatype         = EXCLUDED.datatype,
  unit             = EXCLUDED.unit,
  description      = EXCLUDED.description,
  permitted_values = EXCLUDED.permitted_values,
  semantic_id      = EXCLUDED.semantic_id
 WHERE (vda5050_vocabulary.datatype, vda5050_vocabulary.unit, vda5050_vocabulary.description,
        vda5050_vocabulary.permitted_values, vda5050_vocabulary.semantic_id)
       IS DISTINCT FROM (EXCLUDED.datatype, EXCLUDED.unit, EXCLUDED.description,
                         EXCLUDED.permitted_values, EXCLUDED.semantic_id);
INSERT INTO public.vda5050_vocabulary VALUES ('safetyState.activeEmergencyStop', 'String', NULL, 'EmergencyStop-Types: MANUAL: e-stop shall be acknowledged manually at the mobile robot. REMOTE: facility e-stop shall be acknowledged remotely. NONE: no e-stop activated.', ARRAY['MANUAL', 'REMOTE', 'NONE'], 'https://aber.local/semantics/vda5050/v3.0/State/safetyState.activeEmergencyStop')
ON CONFLICT (name) DO UPDATE SET
  datatype         = EXCLUDED.datatype,
  unit             = EXCLUDED.unit,
  description      = EXCLUDED.description,
  permitted_values = EXCLUDED.permitted_values,
  semantic_id      = EXCLUDED.semantic_id
 WHERE (vda5050_vocabulary.datatype, vda5050_vocabulary.unit, vda5050_vocabulary.description,
        vda5050_vocabulary.permitted_values, vda5050_vocabulary.semantic_id)
       IS DISTINCT FROM (EXCLUDED.datatype, EXCLUDED.unit, EXCLUDED.description,
                         EXCLUDED.permitted_values, EXCLUDED.semantic_id);
INSERT INTO public.vda5050_vocabulary VALUES ('safetyState.fieldViolation', 'Boolean', NULL, 'Protective field violation. True: field is violated. False: field is not violated.', NULL, 'https://aber.local/semantics/vda5050/v3.0/State/safetyState.fieldViolation')
ON CONFLICT (name) DO UPDATE SET
  datatype         = EXCLUDED.datatype,
  unit             = EXCLUDED.unit,
  description      = EXCLUDED.description,
  permitted_values = EXCLUDED.permitted_values,
  semantic_id      = EXCLUDED.semantic_id
 WHERE (vda5050_vocabulary.datatype, vda5050_vocabulary.unit, vda5050_vocabulary.description,
        vda5050_vocabulary.permitted_values, vda5050_vocabulary.semantic_id)
       IS DISTINCT FROM (EXCLUDED.datatype, EXCLUDED.unit, EXCLUDED.description,
                         EXCLUDED.permitted_values, EXCLUDED.semantic_id);
INSERT INTO public.vda5050_vocabulary VALUES ('velocity.omega', 'Double', 'rad/s', 'The mobile robot''s turning speed around its z axis.', NULL, 'https://aber.local/semantics/vda5050/v3.0/State/velocity.omega')
ON CONFLICT (name) DO UPDATE SET
  datatype         = EXCLUDED.datatype,
  unit             = EXCLUDED.unit,
  description      = EXCLUDED.description,
  permitted_values = EXCLUDED.permitted_values,
  semantic_id      = EXCLUDED.semantic_id
 WHERE (vda5050_vocabulary.datatype, vda5050_vocabulary.unit, vda5050_vocabulary.description,
        vda5050_vocabulary.permitted_values, vda5050_vocabulary.semantic_id)
       IS DISTINCT FROM (EXCLUDED.datatype, EXCLUDED.unit, EXCLUDED.description,
                         EXCLUDED.permitted_values, EXCLUDED.semantic_id);
INSERT INTO public.vda5050_vocabulary VALUES ('velocity.vx', 'Double', 'm/s', 'The mobile robot''s velocity in its x direction', NULL, 'https://aber.local/semantics/vda5050/v3.0/State/velocity.vx')
ON CONFLICT (name) DO UPDATE SET
  datatype         = EXCLUDED.datatype,
  unit             = EXCLUDED.unit,
  description      = EXCLUDED.description,
  permitted_values = EXCLUDED.permitted_values,
  semantic_id      = EXCLUDED.semantic_id
 WHERE (vda5050_vocabulary.datatype, vda5050_vocabulary.unit, vda5050_vocabulary.description,
        vda5050_vocabulary.permitted_values, vda5050_vocabulary.semantic_id)
       IS DISTINCT FROM (EXCLUDED.datatype, EXCLUDED.unit, EXCLUDED.description,
                         EXCLUDED.permitted_values, EXCLUDED.semantic_id);
INSERT INTO public.vda5050_vocabulary VALUES ('velocity.vy', 'Double', 'm/s', 'The mobile robot''s velocity in its y direction', NULL, 'https://aber.local/semantics/vda5050/v3.0/State/velocity.vy')
ON CONFLICT (name) DO UPDATE SET
  datatype         = EXCLUDED.datatype,
  unit             = EXCLUDED.unit,
  description      = EXCLUDED.description,
  permitted_values = EXCLUDED.permitted_values,
  semantic_id      = EXCLUDED.semantic_id
 WHERE (vda5050_vocabulary.datatype, vda5050_vocabulary.unit, vda5050_vocabulary.description,
        vda5050_vocabulary.permitted_values, vda5050_vocabulary.semantic_id)
       IS DISTINCT FROM (EXCLUDED.datatype, EXCLUDED.unit, EXCLUDED.description,
                         EXCLUDED.permitted_values, EXCLUDED.semantic_id);
-- <<< END GENERATED vda5050_vocabulary

-- -------------------------------------------------------------------------------------------------
-- 4. The view
-- -------------------------------------------------------------------------------------------------
-- 0301's view with the sixth arm. An id held by two vocabularies takes the first in this order:
-- IDTA (issued by IDTA, IEC CDD and ECLASS), ASHRAE 223P (the ontology's own IRIs), OPC UA (derived
-- from a published namespace), then ISO 22400, MTConnect and VDA 5050 (minted under aber.local).
-- Within one vocabulary, the first by its key. A row with no text defines nothing, so it is left out
-- and the exporter falls back as it would for an id no vocabulary holds.
CREATE OR REPLACE VIEW public.concept_definitions WITH (security_invoker='true') AS
 SELECT DISTINCT ON (c.semantic_id)
    c.semantic_id,
    c.name,
    c.definition,
    c.standard
   FROM ( SELECT 1 AS precedence, t.template_id || ' ' || t.id_short AS tiebreak,
            t.semantic_id, t.id_short AS name, t.description AS definition, 'IDTA'::text AS standard
           FROM public.idta_submodel_templates t
        UNION ALL
         SELECT 2, v.name, v.semantic_id, v.name, v.description, 'ASHRAE 223P'::text
           FROM public.ashrae223_vocabulary v
        UNION ALL
         SELECT 3, v.companion_spec || ' ' || v.name, v.semantic_id, v.name, v.description,
            'OPC UA'::text
           FROM public.opcua_vocabulary v
        UNION ALL
         SELECT 4, v.name, v.semantic_id, v.name, v.description, 'ISO 22400'::text
           FROM public.iso22400_vocabulary v
        UNION ALL
         SELECT 5, v.kind || ' ' || v.name, v.semantic_id, v.name, v.description, 'MTConnect'::text
           FROM public.mtconnect_vocabulary v
        UNION ALL
         SELECT 6, v.name, v.semantic_id, v.name, v.description, 'VDA 5050'::text
           FROM public.vda5050_vocabulary v) c
  WHERE (NULLIF(btrim(c.semantic_id), '') IS NOT NULL)
    AND (NULLIF(btrim(c.definition), '') IS NOT NULL)
  ORDER BY c.semantic_id, c.precedence, c.tiebreak;

ALTER VIEW public.concept_definitions OWNER TO postgres;

COMMENT ON VIEW public.concept_definitions IS 'One row per semantic id a vocabulary defines: the concept''s name and its vocabulary''s own definition text. IDTA, ASHRAE 223P, OPC UA, ISO 22400, MTConnect and VDA 5050. An id held by two vocabularies takes the first in that order. The AAS exporter reads it for ConceptDescription definitions.';

-- Reference data, read as the vocabularies are: security_invoker applies their SELECT policies to
-- the caller, so aas-api's caller-bound client reads it as itself.
REVOKE ALL ON TABLE public.concept_definitions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.concept_definitions TO authenticated, service_role;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.vda5050_vocabulary'::regclass AND c.relrowsecurity) THEN
    RAISE EXCEPTION '0302: row security is off on vda5050_vocabulary';
  END IF;
  IF has_table_privilege('anon', 'public.vda5050_vocabulary', 'SELECT')
     OR has_table_privilege('authenticated', 'public.vda5050_vocabulary', 'INSERT')
     OR has_table_privilege('authenticated', 'public.vda5050_vocabulary', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.vda5050_vocabulary', 'DELETE') THEN
    RAISE EXCEPTION '0302: vda5050_vocabulary is readable by anon or writable by authenticated';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.vda5050_vocabulary', 'SELECT') THEN
    RAISE EXCEPTION '0302: authenticated cannot read vda5050_vocabulary';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.metric_groups WHERE lower(name) = 'agv') THEN
    RAISE EXCEPTION '0302: no AGV metric group is registered';
  END IF;
  -- The field the issue names first, defined by the schema's own text and by no other vocabulary.
  IF NOT EXISTS (SELECT 1 FROM public.vda5050_vocabulary v
                   JOIN public.concept_definitions c ON c.semantic_id = v.semantic_id
                  WHERE v.name = 'driving' AND c.standard = 'VDA 5050' AND c.definition = v.description) THEN
    RAISE EXCEPTION '0302: concept_definitions does not define the driving field by its VDA 5050 text';
  END IF;
  IF has_table_privilege('anon', 'public.concept_definitions', 'SELECT') THEN
    RAISE EXCEPTION '0302: anon may read concept_definitions';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.concept_definitions', 'SELECT') THEN
    RAISE EXCEPTION '0302: authenticated may not read concept_definitions; aas-api reads it as the caller';
  END IF;
  IF EXISTS (SELECT 1 FROM public.concept_definitions GROUP BY semantic_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION '0302: concept_definitions holds a semantic id twice';
  END IF;
  -- The MTConnect arm 0301 added is still here: this file declares the whole view.
  IF NOT EXISTS (SELECT 1 FROM public.concept_definitions WHERE standard = 'MTConnect') THEN
    RAISE EXCEPTION '0302: concept_definitions lost its MTConnect arm';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
