-- =============================================================================================
-- Migration: 0002_seed_data.sql
-- Factory+ Asset Tracking Platform -- consolidated baseline data (public beta)
-- =============================================================================================
--
-- WHAT THIS IS. Every row the platform needs in order to come up usable, squashed out of the 38
-- incremental migrations `20260101000000` .. `20260101000037` (preserved under
-- `supabase/migrations/archive/`). It is the DML counterpart of `0001_baseline_schema.sql` and
-- assumes that file has already run.
--
-- SCOPE: PURE DML. No CREATE, no ALTER, no structure of any kind.
--
-- IT IS IDEMPOTENT, because supabase-db-init replays every /migrations/*.sql on every boot.
-- EVERY statement carries an ON CONFLICT clause, and THE CLAUSES DIFFER PER TABLE ON PURPOSE:
--
--   * Reference vocabularies (MTConnect, ISO 22400, OPC UA) use DO UPDATE, because they are
--     maintained by editing this file -- an edit has to reach a database that already exists.
--     MTConnect re-stamps ONLY `category`: `semantic_id` is an assertion that gets corrected, and
--     re-stamping it every boot would make a hand-entered crosswalk unfixable.
--   * Everything operator-facing uses DO NOTHING. A DO UPDATE on `devices` fires
--     log_digital_thread_event() whether or not any value actually differs, which appends a row
--     to an append-only audit table on every boot, forever. That trap was hit twice in this
--     codebase before it was understood; DO NOTHING is the fix, and "pre-registration, not
--     re-provisioning" is the rule.
--
-- WHAT IS DELIBERATELY ABSENT:
--   * `digital_thread`. Its rows are written by a trigger as a side effect of the inserts below,
--     so seeding them explicitly would duplicate the audit trail rather than restore it.
--   * `user_roles`, and the demo accounts themselves. Those belong to GoTrue and are seeded by
--     `supabase/seed.sql`, which runs after this file.
--   * `cells`. Unassigned and Site-Wide are derived lanes, never rows -- see the section below.
--   * the `storage.buckets` row, created by `scripts/storage-init.mjs`. See 0001's header.
--
-- PSQL VARIABLES. `supabase-db-init` passes `-v nodered_admin_token` and
-- `-v grafana_oauth_client_secret`. Both are defaulted at the point of use, so this file stays
-- runnable standalone, and both are treated as absent-is-normal rather than as an error.
-- =============================================================================================


-- -------------------------------------------------------------------------------------------
-- RBAC roles  (4 rows)
-- -------------------------------------------------------------------------------------------
-- Ids are explicit because seed.sql, the RLS policies and the tests all refer to them by number.
-- The sequence is advanced at the end of this file -- see the note there.

INSERT INTO public.roles VALUES (1, 'Administrator', 'Full unrestricted access to shopfloor configuration, archives, and onboarding approval')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.roles VALUES (2, 'Shopfloor_Manager', 'Can manage devices, cells, gateways, and approve quarantined onboarding')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.roles VALUES (3, 'Operator', 'Operational dashboard view, live telemetry streaming, and document viewing')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.roles VALUES (4, 'Auditor', 'Read-only audit trace and digital thread access')
ON CONFLICT (id) DO NOTHING;


-- -------------------------------------------------------------------------------------------
-- RBAC permissions  (13 rows)
-- -------------------------------------------------------------------------------------------
-- The permission UUIDs are mirrored by PERMISSION_UUIDS in frontend/src/constants.js.

INSERT INTO public.permissions VALUES ('cb46a943-42e1-4c1d-8706-933e08544e30', 'quarantine:view', 'View zero-touch onboarding quarantine queue in read-only mode')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.permissions VALUES ('cb46a943-42e1-4c1d-8706-933e08544e31', 'quarantine:approve', 'Approve discovered quarantined edge devices')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.permissions VALUES ('a123b456-7890-4c1d-8706-933e08544e32', 'quarantine:reject', 'Reject quarantined edge device discovery')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.permissions VALUES ('d987c654-3210-4c1d-8706-933e08544e33', 'device:manage', 'Create, edit, and reassign manufacturing devices')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.permissions VALUES ('c456d789-0123-4c1d-8706-933e08544e34', 'cell:manage', 'Create, update, and delete shopfloor cells')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.permissions VALUES ('e789a012-3456-4c1d-8706-933e08544e35', 'gateway:manage', 'Register and manage edge gateways')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.permissions VALUES ('f012a345-6789-4c1d-8706-933e08544e36', 'telemetry:read', 'View live telemetry streams and historical data')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.permissions VALUES ('b345c678-9012-4c1d-8706-933e08544e37', 'archive:manage', 'Archive, restore, and set retention auto-delete timers')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.permissions VALUES ('a012b345-6789-4c1d-8706-933e08544e38', 'document:manage', 'Add, edit, and remove external document links attached to assets')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.permissions VALUES ('e012c345-6789-4c1d-8706-933e08544e39', 'authz:manage', 'Manage roles, user permissions, and access checks')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.permissions VALUES ('f123d456-7890-4c1d-8706-933e08544e40', 'schema:manage', 'Register and validate industrial schemas')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.permissions VALUES ('c234e567-8901-4c1d-8706-933e08544e41', 'gitops:manage', 'Deploy flows and manage GitOps edge configurations')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.permissions VALUES ('d345e678-9012-4c1d-8706-933e08544e42', 'digital_thread:read', 'View continuous Digital Thread audit log entries')
ON CONFLICT (id) DO NOTHING;


-- -------------------------------------------------------------------------------------------
-- RBAC role/permission grants  (29 rows)
-- -------------------------------------------------------------------------------------------

INSERT INTO public.role_permissions VALUES (1, 'cb46a943-42e1-4c1d-8706-933e08544e30')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (1, 'cb46a943-42e1-4c1d-8706-933e08544e31')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (1, 'a123b456-7890-4c1d-8706-933e08544e32')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (1, 'd987c654-3210-4c1d-8706-933e08544e33')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (1, 'c456d789-0123-4c1d-8706-933e08544e34')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (1, 'e789a012-3456-4c1d-8706-933e08544e35')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (1, 'f012a345-6789-4c1d-8706-933e08544e36')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (1, 'b345c678-9012-4c1d-8706-933e08544e37')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (1, 'a012b345-6789-4c1d-8706-933e08544e38')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (1, 'e012c345-6789-4c1d-8706-933e08544e39')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (1, 'f123d456-7890-4c1d-8706-933e08544e40')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (1, 'c234e567-8901-4c1d-8706-933e08544e41')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (1, 'd345e678-9012-4c1d-8706-933e08544e42')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (2, 'cb46a943-42e1-4c1d-8706-933e08544e30')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (2, 'cb46a943-42e1-4c1d-8706-933e08544e31')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (2, 'a123b456-7890-4c1d-8706-933e08544e32')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (2, 'd987c654-3210-4c1d-8706-933e08544e33')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (2, 'c456d789-0123-4c1d-8706-933e08544e34')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (2, 'e789a012-3456-4c1d-8706-933e08544e35')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (2, 'f012a345-6789-4c1d-8706-933e08544e36')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (2, 'b345c678-9012-4c1d-8706-933e08544e37')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (2, 'a012b345-6789-4c1d-8706-933e08544e38')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (2, 'e012c345-6789-4c1d-8706-933e08544e39')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (2, 'f123d456-7890-4c1d-8706-933e08544e40')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (2, 'c234e567-8901-4c1d-8706-933e08544e41')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (2, 'd345e678-9012-4c1d-8706-933e08544e42')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (3, 'f012a345-6789-4c1d-8706-933e08544e36')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (3, 'cb46a943-42e1-4c1d-8706-933e08544e30')
ON CONFLICT DO NOTHING;
INSERT INTO public.role_permissions VALUES (4, 'd345e678-9012-4c1d-8706-933e08544e42')
ON CONFLICT DO NOTHING;


-- -------------------------------------------------------------------------------------------
-- Metric group registry  (132 rows)
-- -------------------------------------------------------------------------------------------
-- A registry of approved group SPELLINGS, not of membership -- membership is always derived from
-- the first segment of a metric's name. Seeded from MTConnect's component types plus the ISO 22400
-- families and OPC UA browse-path components.
--
-- DO NOTHING, not DO UPDATE: `enforce_metric_group_spelling()` treats whatever is already
-- registered as canonical, so re-stamping a spelling an operator has settled on would fight it.

INSERT INTO public.metric_groups VALUES ('9b710249-27b1-4e37-a8df-cf7ff25196b8', 'Actuator', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('8dd178fb-8af2-4122-b1dc-96bc1754dd3b', 'Adapter', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('4cbc0519-9f7f-402c-8f33-057bd5dc93d2', 'Adapters', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('d2aff514-15f3-4c02-8de3-ca79a0d27e0d', 'Agent', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('378311ee-bc67-4a68-89bd-f2a6c38941b9', 'AirHandler', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('11033b9c-1ea0-4f7a-b7fa-dd8834635f55', 'Amplifier', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('7fb318bb-8b62-4efe-8da1-864110ddc48c', 'AutomaticToolChanger', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('6745ff8e-e688-4dba-b288-5b94f6fc4c3e', 'Auxiliaries', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('a35f7145-0d6a-470c-b2b5-23ce5444e101', 'Auxiliary', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('02ad503e-7ce2-4ccd-83c5-22b0644866f4', 'Axes', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('9d01c797-7223-4613-bc7d-02b73bfd5f6b', 'Axis', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('1ee37db3-1cc7-4c14-b1f2-2e1809654c9b', 'Ballscrew', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('d9dae244-91f6-42e9-b5cf-1be9bc2dffd8', 'BarFeeder', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('2336ef70-a041-4d37-9057-a783131efeea', 'BarFeederInterface', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('1e3b85ba-cf9d-49cb-9825-5d56c4f11e26', 'Belt', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('a2a83d96-bbd7-4c14-a5fc-e70f25951cab', 'Brake', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('6ffc15d6-6b27-446e-97f5-d852ab2f5174', 'Chain', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('573fc863-3c9b-42aa-bb5c-075472e90bff', 'Chopper', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('620538e9-c81d-42c0-995d-8f4bfa068272', 'Chuck', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('a48cd3cb-2bfd-4416-a53b-4bccce0f8ef2', 'ChuckInterface', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('2165200a-5545-40f9-8343-45c2c57ff471', 'Chute', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('2bc786f9-1c2c-4b17-a0b1-c86db6b0f35f', 'CircuitBreaker', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('d43d1c27-d391-4120-a58e-7c820c684538', 'Clamp', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('d3434c84-9917-4dd5-964e-87026144f77a', 'Compressor', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('b18526ad-fb26-4c3a-8d0d-2942a2bb0914', 'Controller', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('839f2741-21f3-4150-9ca6-b94e84ffd197', 'Coolant', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('a7c081db-3818-41d9-b25f-f7ad9ade0435', 'Cooling', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('f92100e9-18a8-42cf-a797-b0a1121ebbe1', 'CoolingTower', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('a031bb50-2148-4848-807b-64cb28d06fef', 'CuttingTorch', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('3d0d5127-2865-4895-bb05-1f1fef3469c6', 'Deposition', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('0aa9a0b8-5d74-49fa-873b-64e34a6c5c1f', 'Dielectric', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('92098c3d-ef21-4fa2-b55b-cf1df2d52de7', 'Door', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('287e692f-9b61-471b-b031-d015aab50987', 'DoorInterface', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('f5502322-3031-4cbe-894f-797a68e7ed40', 'Drain', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('75957731-6b6f-44e1-9977-2de35cede241', 'Electric', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('7844394e-481d-424d-81a2-30311f3f5cb1', 'Electrode', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('4c75d2b4-c1a9-4eb5-b55b-bd826cbec237', 'Enclosure', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('3ce1b85e-136c-4250-a3c6-337e31ac1490', 'Encoder', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('41ec9f50-4b1b-492c-aeb9-f1070a32686e', 'EndEffector', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('cd0344fd-06dc-40c7-8817-94dd5ac64b61', 'ExpiredPot', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('ab835fc4-0223-402e-80fb-1f24bd9818c7', 'ExposureUnit', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('b4308ea5-c444-4655-b294-069eaba3fd6a', 'ExtrusionUnit', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('a7fe75ef-84ff-4b2f-8a30-068dcbe774d0', 'Fan', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('b5020954-6c63-44b1-a2f7-fd3e65f81cb3', 'FeatureOccurrence', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('4cd42737-3de9-4e90-8c53-546624925f12', 'Feeder', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('eb917490-d914-4ca3-ae59-11f65a1d9a2a', 'Filter', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('b9ccd01a-2d41-45b0-a347-52e7ee738d6c', 'Galvanomotor', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('26a9ea24-dbed-4bc3-8c3d-a8c1d9f36a44', 'GangToolBar', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('08569571-eede-4920-b33a-b76422aeb845', 'Gripper', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('f813fa7c-1af8-4c14-af50-ecc6d657d3be', 'Heating', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('55253125-6276-48d2-b931-5097889a9567', 'Hopper', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('b8459dce-a146-4f74-bd2b-75ebc480aff5', 'Hydraulic', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('64fe42e0-b9b5-4b6d-a801-c9204a058f91', 'Interface', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('b6f9cd1f-a490-4ad0-a097-d7119fec9e33', 'Interfaces', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('162b5dd9-c6e7-448b-9f36-c5332e506d09', 'Linear', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('512099a7-9b1c-451c-a1a6-97b4852f9445', 'LinearPositionFeedback', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('be077b98-958a-4e8c-a246-3aeb205858de', 'Link', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('f27b5f12-61c8-40fd-b7b2-34a801807fa1', 'Loader', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('f8fd1323-106e-44a2-9afc-81b0856209f1', 'Lock', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('8aae2762-4591-4f17-8fb3-df7464322718', 'Lubrication', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('e6c2642f-0b2a-4490-900a-3f8abbc5ee48', 'Material', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('d052e25a-d48d-415e-ac32-ea9f9b3851b5', 'MaterialHandlerInterface', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('92984fad-979d-453e-9f8b-7838042ff344', 'Materials', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('d77acc32-a344-4231-9231-af580cbeeb62', 'Motor', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('f7b1c0a8-6992-4295-ad01-f186386d1b14', 'Oil', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('35f6b295-4719-4d73-8306-30ded3589909', 'Part', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('8f98c932-de6d-463a-99c8-ad3cf61b9dfa', 'PartOccurrence', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('8e0922e3-8f6b-4267-9a4f-2dd2b3dcd9bf', 'OEE', 'ISO 22400 overall equipment effectiveness -- availability, performance, quality', '2026-08-02 05:44:35.294104+00', 'ISO 22400')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('e9f4e2a3-1bd6-45b0-ae90-88038d0bec2a', 'Parts', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('c30f2e3e-5e3e-4feb-b65e-636aaec824d3', 'Path', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('27ff7522-3ab8-40b8-a508-8692c8ccda16', 'Personnel', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('34bfbb07-fc99-4156-b441-f8cfec5ebd7f', 'PinTool', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('4a78f0cf-bcd3-4234-98e4-eb939e2e5905', 'Pneumatic', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('a8659a98-b508-4b6c-ba82-40e7d71ec81b', 'Pot', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('d8d2b3f0-3895-4807-a614-f2635fa5fd89', 'Power', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('99cfadc0-0e5b-4878-ba28-111065e236b7', 'PowerSupply', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('d662386a-8b57-4e10-82a1-c058c4a74250', 'Pressure', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('a3db4239-8c58-4ff1-939b-f844d8562d4e', 'Processes', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('57707bee-3303-4022-8ae3-661ced2e95d0', 'ProcessOccurrence', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('15f2007a-f242-4538-8388-113822558659', 'ProcessPower', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('3231590f-34da-468e-9c3a-c82354405cff', 'Protective', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('1251a38e-6a77-42a9-a981-055eecfafd21', 'Pulley', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('bc73a7d9-d078-4535-b27b-d8308debb218', 'Pump', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('cb44f43e-947c-42da-9ef1-c94c8ff08a95', 'Reel', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('d92a7fae-be65-4562-960b-2f8de54e23e2', 'RemovalPot', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('24512fc0-d463-42b3-9130-2462daa3dd31', 'Requester', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('9e0b7d71-ba34-4109-a91c-f3f943057c61', 'Resource', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('0478734f-3b52-43f9-ba69-e27622eaff23', 'Resources', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('bbc277e3-0519-42f7-9c7b-3a685f078cfe', 'Responder', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('63ffaf4f-ef74-412b-b2db-ad627173c79c', 'ReturnPot', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('50484983-5762-45f1-8fca-cfab04ef0f2d', 'Rotary', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('2e0cc414-fbee-492b-83ef-591d1539834f', 'SensingElement', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('c1e78c35-cff4-4d58-9ba8-bd74b1f888c1', 'Sensor', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('71ef732a-a4fa-445d-a350-6c2e05f2f240', 'Spindle', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('b90f64d1-18bd-4999-a6c0-c2886b375bb1', 'Spreader', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('9307be94-108b-4eb1-9b23-1036f39a1022', 'StagingPot', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('c89baca9-ccf0-46fe-bc04-2854380f53c7', 'Station', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('a9c1714f-c07c-4b14-b1ea-5593d8976f66', 'Stock', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('5bff8f58-6b0a-412e-8343-4a8eaa12d860', 'StorageBattery', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('b9e098ef-0cd0-4038-b3e5-088b428fd471', 'Structure', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('6b1dc0e3-def1-439c-a497-fe42bf901ba9', 'Structures', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('78c0d657-93d2-4341-811d-2d857d28d633', 'Switch', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('a080543f-70bf-4baf-9500-73cac728cbea', 'System', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('f0eb82e2-a78c-40fb-b552-837e54cc22a0', 'Systems', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('4d7246ad-c2c7-44d8-8549-1e40de669b64', 'Table', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('dda4f745-84d1-4c5f-91d3-216ddc18218b', 'Tank', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('c0487270-63cd-4c21-95ed-a869353c87fd', 'Tensioner', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('f658f387-3a23-4b8f-86a2-c47edb2bc36a', 'Thermostat', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('2e3157a3-0424-482e-86ef-a36028ef7571', 'ToolHolder', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('a1a45755-d9b6-4095-b2ba-75f0ee71be6b', 'ToolingDelivery', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('ddc9fc4c-efc3-4adb-9621-5dce0590d6fc', 'ToolMagazine', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('fedd128f-c799-48d0-8f31-45e5a21043e3', 'ToolRack', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('d47520e1-c12f-4a00-9a6d-1267b9d8a95f', 'TransferArm', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('b406c452-df70-4b1b-a3a3-c5f02d170540', 'TransferPot', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('47d13da8-9643-4532-9910-d6de9ec0f828', 'Transformer', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('2a771aac-1d0e-4aed-8782-2fdec25b4562', 'Turret', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('f35c27eb-b728-421c-8f86-44e7b16f6b81', 'Vacuum', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('13628c42-cc27-45f6-a8dc-473c3f449191', 'Valve', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('ff0d1f73-5851-4400-b2eb-5cc91b316ffe', 'Vat', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('ad2a1f6c-fb9e-4809-a1a0-81e22b40cd0d', 'Vibration', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('79e762d9-477f-471e-a16b-e580d0b090bd', 'WasteDisposal', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('548e8559-ae5b-4a15-856d-0a004362b761', 'Water', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('548a3f52-adc0-4397-a0f2-44496b42d579', 'Wire', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('5ca91a97-35ba-4a2b-81bf-c13f78654fc8', 'WorkEnvelope', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('c62ac75f-c4aa-4384-8541-6997421360b5', 'Workpiece', 'MTConnect component type', '2026-08-02 05:44:36.110595+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('f6e16336-8681-49a9-9f45-7e46c99eda49', 'Environmental', 'Ambient conditions around the asset -- temperature, humidity, pressure, air quality', '2026-08-02 05:44:35.294104+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('25b3b13c-748a-46b2-b77c-f517128e338a', 'Process', 'The physical process being run -- setpoints, feed rates, cycle counts', '2026-08-02 05:44:35.294104+00', 'MTConnect')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('ebc859af-3403-4697-8afa-2e57d467eae3', 'Quality', 'ISO 22400 quality outcomes -- scrap, rework and yield ratios', '2026-08-02 05:44:45.022929+00', 'ISO 22400')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('5f961090-eaff-4d12-b77a-49ffd5a0c962', 'Utilization', 'ISO 22400 loading and utilization ratios', '2026-08-02 05:44:45.022929+00', 'ISO 22400')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('7aa9cdb7-f49e-47e5-8aac-89c189ea795a', 'Maintenance', 'ISO 22400 maintenance KPIs -- MTBF, MTTR and related reliability measures', '2026-08-02 05:44:45.022929+00', 'ISO 22400')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('dd4107de-fe67-4a79-a393-83f1bb0215b0', 'Machine', 'OPC UA Machinery (OPC 40001) machine-level identification and state', '2026-08-02 05:44:45.874849+00', 'OPC UA')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups VALUES ('dabbe01c-1e55-4609-9c84-8ffe0930cb72', 'MotionDevice', 'OPC UA Robotics (OPC 40010) motion device -- axes, safety states and motion parameters', '2026-08-02 05:44:45.874849+00', 'OPC UA')
ON CONFLICT DO NOTHING;


-- -------------------------------------------------------------------------------------------
-- Metric catalog  (15 rows)
-- -------------------------------------------------------------------------------------------
-- What devices publish. `name` is IMMUTABLE -- a physical device is configured against that exact
-- string -- and `enforce_metric_catalog_immutability()` enforces it, so DO UPDATE here would be
-- rejected by the very trigger this data depends on. Changing a metric is deprecate-and-supersede:
-- set `deprecated` + `superseded_by` and add the replacement, never edit a row in place.
--
-- `OEE/PERFORMANCE` is present and deprecated, superseded by `OEE/EFFECTIVENESS`: ISO 22400-2
-- calls the second OEE factor Effectiveness. Both carry the SAME semantic_id -- two names for one
-- concept -- which is why the index on semantic_id is deliberately not unique.

INSERT INTO public.metric_catalog VALUES ('c0000001-0000-4000-8000-000000000007', 'OEE/AVAILABILITY', 10, 'ISO 22400 availability ratio -- NOT MTConnect AVAILABILITY, which means "device connected"', false, NULL, '2026-08-02 05:44:36.861147+00', DEFAULT, NULL, 'PERCENT', NULL, 'ISO 22400', 'https://factoryplus.local/semantics/iso22400/AVAILABILITY', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('c0000001-0000-4000-8000-000000000009', 'OEE/QUALITY', 10, 'ISO 22400 quality ratio', false, NULL, '2026-08-02 05:44:36.861147+00', DEFAULT, NULL, 'PERCENT', NULL, 'ISO 22400', 'https://factoryplus.local/semantics/iso22400/QUALITY', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('c0000001-0000-4000-8000-000000000010', 'OEE/EFFECTIVENESS', 10, 'ISO 22400 effectiveness ratio (E) -- the OEE factor commonly called Performance. Supersedes OEE/PERFORMANCE.', false, NULL, '2026-08-02 05:44:46.630269+00', DEFAULT, 'SAMPLE', 'PERCENT', NULL, 'ISO 22400', 'https://factoryplus.local/semantics/iso22400/EFFECTIVENESS', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('c0000001-0000-4000-8000-000000000008', 'OEE/PERFORMANCE', 10, 'ISO 22400 performance ratio', true, 'c0000001-0000-4000-8000-000000000010', '2026-08-02 05:44:36.861147+00', DEFAULT, NULL, 'PERCENT', NULL, 'ISO 22400', 'https://factoryplus.local/semantics/iso22400/EFFECTIVENESS', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('c0000001-0000-4000-8000-000000000001', 'Systems/TEMPERATURE', 10, 'Machine system temperature', false, NULL, '2026-08-02 05:44:36.861147+00', DEFAULT, 'SAMPLE', 'CELSIUS', NULL, 'MTConnect', 'https://factoryplus.local/semantics/mtconnect/v2.0/Systems/TEMPERATURE', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('c0000001-0000-4000-8000-000000000002', 'Axes/DISPLACEMENT', 10, 'Axis displacement amplitude (was: vibration)', false, NULL, '2026-08-02 05:44:36.861147+00', DEFAULT, 'SAMPLE', 'MILLIMETER', NULL, 'MTConnect', 'https://factoryplus.local/semantics/mtconnect/v2.0/Axes/DISPLACEMENT', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('c0000001-0000-4000-8000-000000000003', 'Controller/EXECUTION', 12, 'Controller execution state: READY / ACTIVE / INTERRUPTED / FEED_HOLD / STOPPED', false, NULL, '2026-08-02 05:44:36.861147+00', DEFAULT, 'EVENT', NULL, NULL, 'MTConnect', 'https://factoryplus.local/semantics/mtconnect/v2.0/Controller/EXECUTION', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('c0000001-0000-4000-8000-000000000004', 'Controller/EMERGENCY_STOP', 12, 'Emergency stop circuit: ARMED (healthy) or TRIGGERED', false, NULL, '2026-08-02 05:44:36.861147+00', DEFAULT, 'EVENT', NULL, NULL, 'MTConnect', 'https://factoryplus.local/semantics/mtconnect/v2.0/Controller/EMERGENCY_STOP', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('c0000001-0000-4000-8000-000000000005', 'Controller/FIRMWARE', 12, 'Controller firmware version', false, NULL, '2026-08-02 05:44:36.861147+00', DEFAULT, 'EVENT', NULL, NULL, 'MTConnect', 'https://factoryplus.local/semantics/mtconnect/v2.0/Controller/FIRMWARE', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('c0000001-0000-4000-8000-000000000006', 'SERIAL_NUMBER', 12, 'Manufacturer serial number', false, NULL, '2026-08-02 05:44:36.861147+00', DEFAULT, 'EVENT', NULL, NULL, 'MTConnect', 'https://factoryplus.local/semantics/mtconnect/v2.0/SERIAL_NUMBER', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('c0000001-0000-4000-8000-000000000011', 'Axes/C/ANGLE', 10, 'Angular position of the C axis (MTConnect ANGLE on the Axes component)', false, NULL, '2026-08-02 05:44:47.393993+00', DEFAULT, 'SAMPLE', 'DEGREE', NULL, 'MTConnect', 'https://factoryplus.local/semantics/mtconnect/v2.0/Axes/C/ANGLE', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('c0000001-0000-4000-8000-000000000012', 'Machine/OperatingMode', 12, 'Machine operating mode -- Processing, Setup, Maintenance or Normal. OPC 40001 calls this browse name MachineryOperationMode; the semantic id binds this metric to that concept.', false, NULL, '2026-08-02 05:44:47.393993+00', DEFAULT, 'EVENT', NULL, NULL, 'OPC UA', 'http://opcfoundation.org/UA/Machinery/MachineryOperationMode', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('c0000001-0000-4000-8000-000000000013', 'MotionDevice/OverridePercent', 10, 'Operator speed override applied to programmed motion. OPC 40010 calls this browse name SpeedOverride; the semantic id binds this metric to that concept.', false, NULL, '2026-08-02 05:44:47.393993+00', DEFAULT, 'SAMPLE', 'PERCENT', NULL, 'OPC UA', 'http://opcfoundation.org/UA/Robotics/SpeedOverride', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('e5f5b550-25f7-4c28-9cd4-36eb9c2224af', 'safety_interlock', 11, 'Safety interlock present/enabled (local extension)', false, NULL, '2026-08-02 05:44:32.25444+00', DEFAULT, 'EVENT', NULL, NULL, NULL, 'https://factoryplus.local/semantics/local/safety_interlock', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('a469cb73-0d73-46b3-928e-7ecfd7fc43f0', 'max_temp_threshold', 10, 'Configured maximum temperature threshold (local extension)', false, NULL, '2026-08-02 05:44:32.25444+00', DEFAULT, 'SAMPLE', 'CELSIUS', NULL, NULL, 'https://factoryplus.local/semantics/local/max_temp_threshold', 'IRI')
ON CONFLICT (name) DO NOTHING;


-- -------------------------------------------------------------------------------------------
-- MTConnect vocabulary (598 rows)  (598 rows)
-- -------------------------------------------------------------------------------------------
-- MTConnect's controlled vocabularies: data item types with their category, subtypes, units and
-- component types. Reference data, not a catalog -- `ANGLE` is a type, `Axes/C/ANGLE` is a metric.
--
-- ONLY `category` IS RE-STAMPED, and that is the original behaviour preserved deliberately.
-- `semantic_id` is set on insert and never updated, because a semantic id is an assertion that
-- gets CORRECTED -- re-stamping it every boot would make a hand-entered crosswalk unfixable.
--
-- Generated by scripts/generate-mtconnect-vocabulary.mjs. To adopt a newer MTConnect release,
-- bump SCHEMA_VERSION there and regenerate rather than editing these rows.

-- >>> BEGIN GENERATED mtconnect_vocabulary -- MTConnect 2.8, 598 rows, sha256:5012ad00298ab9cb
-- GENERATED. Do not edit these rows by hand: bump SCHEMA_VERSION in
-- scripts/generate-mtconnect-vocabulary.mjs and re-run it. CI verifies the digest above.
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ACCELERATION', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ACCELERATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ACCUMULATED_TIME', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ACCUMULATED_TIME')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ACTIVATION_COUNT', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ACTIVATION_COUNT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ACTIVE_AXES', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ACTIVE_AXES')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ACTIVE_POWER_SOURCE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ACTIVE_POWER_SOURCE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ACTUATOR', 'CONDITION', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ACTUATOR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ACTUATOR_STATE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ACTUATOR_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ADAPTER_SOFTWARE_VERSION', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ADAPTER_SOFTWARE_VERSION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ADAPTER_URI', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ADAPTER_URI')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ALARM', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ALARM')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ALARM_LIMIT', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ALARM_LIMIT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ALARM_LIMITS', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ALARM_LIMITS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'AMPERAGE', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/AMPERAGE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'AMPERAGE_AC', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/AMPERAGE_AC')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'AMPERAGE_DC', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/AMPERAGE_DC')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ANGLE', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ANGLE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ANGULAR_ACCELERATION', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ANGULAR_ACCELERATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ANGULAR_DECELERATION', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ANGULAR_DECELERATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ANGULAR_VELOCITY', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ANGULAR_VELOCITY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'APPLICATION', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/APPLICATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ASSET_ADDED', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ASSET_ADDED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ASSET_CHANGED', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ASSET_CHANGED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ASSET_COUNT', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ASSET_COUNT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ASSET_REMOVED', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ASSET_REMOVED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ASSET_UPDATE_RATE', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ASSET_UPDATE_RATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ASSOCIATED_ASSET_ID', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ASSOCIATED_ASSET_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'AVAILABILITY', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/AVAILABILITY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'AXIS_COUPLING', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/AXIS_COUPLING')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'AXIS_FEEDRATE', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/AXIS_FEEDRATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'AXIS_FEEDRATE_OVERRIDE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/AXIS_FEEDRATE_OVERRIDE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'AXIS_INTERLOCK', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/AXIS_INTERLOCK')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'AXIS_STATE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/AXIS_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'BATTERY_CAPACITY', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/BATTERY_CAPACITY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'BATTERY_CHARGE', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/BATTERY_CHARGE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'BATTERY_STATE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/BATTERY_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'BINDING_STATE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/BINDING_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'BLOCK', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/BLOCK')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'BLOCK_COUNT', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/BLOCK_COUNT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CAPACITY_FLUID', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/CAPACITY_FLUID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CAPACITY_SPATIAL', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/CAPACITY_SPATIAL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CHARACTERISTIC_PERSISTENT_ID', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/CHARACTERISTIC_PERSISTENT_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CHARACTERISTIC_STATUS', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/CHARACTERISTIC_STATUS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CHARGE_RATE', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/CHARGE_RATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CHUCK_INTERLOCK', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/CHUCK_INTERLOCK')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CHUCK_STATE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/CHUCK_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CLOCK_TIME', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/CLOCK_TIME')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CODE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/CODE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'COMMUNICATIONS', 'CONDITION', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/COMMUNICATIONS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'COMPONENT_DATA', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/COMPONENT_DATA')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'COMPOSITION_STATE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/COMPOSITION_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CONCENTRATION', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/CONCENTRATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CONDUCTIVITY', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/CONDUCTIVITY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CONNECTION_STATUS', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/CONNECTION_STATUS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CONTROL_LIMIT', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/CONTROL_LIMIT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CONTROL_LIMITS', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/CONTROL_LIMITS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CONTROLLER_MODE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/CONTROLLER_MODE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CONTROLLER_MODE_OVERRIDE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/CONTROLLER_MODE_OVERRIDE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'COUPLED_AXES', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/COUPLED_AXES')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CUTTING_SPEED', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/CUTTING_SPEED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CYCLE_COUNT', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/CYCLE_COUNT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DATA_RANGE', 'CONDITION', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/DATA_RANGE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DATE_CODE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/DATE_CODE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DEACTIVATION_COUNT', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/DEACTIVATION_COUNT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DECELERATION', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/DECELERATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DENSITY', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/DENSITY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DEPOSITION_ACCELERATION_VOLUMETRIC', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/DEPOSITION_ACCELERATION_VOLUMETRIC')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DEPOSITION_DENSITY', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/DEPOSITION_DENSITY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DEPOSITION_MASS', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/DEPOSITION_MASS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DEPOSITION_RATE_VOLUMETRIC', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/DEPOSITION_RATE_VOLUMETRIC')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DEPOSITION_VOLUME', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/DEPOSITION_VOLUME')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DEPTH', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/DEPTH')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DEVICE_ADDED', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/DEVICE_ADDED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DEVICE_CHANGED', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/DEVICE_CHANGED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DEVICE_REMOVED', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/DEVICE_REMOVED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DEVICE_UUID', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/DEVICE_UUID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DEW_POINT', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/DEW_POINT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DIAMETER', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/DIAMETER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DIRECTION', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/DIRECTION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DISCHARGE_RATE', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/DISCHARGE_RATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DISPLACEMENT', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/DISPLACEMENT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DISPLACEMENT_ANGULAR', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/DISPLACEMENT_ANGULAR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DISPLACEMENT_LINEAR', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/DISPLACEMENT_LINEAR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DOOR_STATE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/DOOR_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ELECTRICAL_ENERGY', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ELECTRICAL_ENERGY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ELEVATION', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ELEVATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'EMERGENCY_STOP', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/EMERGENCY_STOP')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'END_OF_BAR', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/END_OF_BAR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'EQUIPMENT_MODE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/EQUIPMENT_MODE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'EQUIPMENT_TIMER', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/EQUIPMENT_TIMER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'EXECUTION', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/EXECUTION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'FEATURE_MEASUREMENT', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/FEATURE_MEASUREMENT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'FEATURE_PERSISTENT_ID', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/FEATURE_PERSISTENT_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'FILL_HEIGHT', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/FILL_HEIGHT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'FILL_LEVEL', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/FILL_LEVEL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'FIRMWARE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/FIRMWARE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'FIXTURE_ASSET_ID', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/FIXTURE_ASSET_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'FIXTURE_ID', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/FIXTURE_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'FLOW', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/FLOW')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'FOLLOWING_ERROR', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/FOLLOWING_ERROR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'FOLLOWING_ERROR_ANGULAR', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/FOLLOWING_ERROR_ANGULAR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'FOLLOWING_ERROR_LINEAR', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/FOLLOWING_ERROR_LINEAR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'FREQUENCY', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/FREQUENCY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'FUNCTIONAL_MODE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/FUNCTIONAL_MODE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'GLOBAL_POSITION', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/GLOBAL_POSITION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'GRAVITATIONAL_ACCELERATION', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/GRAVITATIONAL_ACCELERATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'GRAVITATIONAL_FORCE', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/GRAVITATIONAL_FORCE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'HARDNESS', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/HARDNESS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'HARDWARE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/HARDWARE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'HOST_NAME', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/HOST_NAME')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'HUMIDITY_ABSOLUTE', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/HUMIDITY_ABSOLUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'HUMIDITY_RELATIVE', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/HUMIDITY_RELATIVE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'HUMIDITY_SPECIFIC', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/HUMIDITY_SPECIFIC')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LEAK_DETECT', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/LEAK_DETECT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LENGTH', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/LENGTH')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LEVEL', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/LEVEL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LIBRARY', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/LIBRARY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LINE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/LINE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LINE_LABEL', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/LINE_LABEL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LINE_NUMBER', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/LINE_NUMBER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LINEAR_FORCE', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/LINEAR_FORCE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LOAD', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/LOAD')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LOAD_COUNT', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/LOAD_COUNT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LOCATION_ADDRESS', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/LOCATION_ADDRESS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LOCATION_NARRATIVE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/LOCATION_NARRATIVE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LOCATION_SPATIAL_GEOGRAPHIC', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/LOCATION_SPATIAL_GEOGRAPHIC')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LOCK_STATE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/LOCK_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LOGIC_PROGRAM', 'CONDITION', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/LOGIC_PROGRAM')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'MAINTENANCE_LIST', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/MAINTENANCE_LIST')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'MASS', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/MASS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'MATERIAL', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/MATERIAL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'MATERIAL_LAYER', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/MATERIAL_LAYER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'MEASUREMENT_TYPE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/MEASUREMENT_TYPE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'MEASUREMENT_UNITS', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/MEASUREMENT_UNITS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'MEASUREMENT_VALUE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/MEASUREMENT_VALUE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'MESSAGE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/MESSAGE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'MOTION_PROGRAM', 'CONDITION', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/MOTION_PROGRAM')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'MTCONNECT_VERSION', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/MTCONNECT_VERSION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'NETWORK', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/NETWORK')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'NETWORK_PORT', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/NETWORK_PORT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'OBSERVATION_UPDATE_RATE', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/OBSERVATION_UPDATE_RATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'OPENNESS', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/OPENNESS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'OPERATING_MODE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/OPERATING_MODE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'OPERATING_SYSTEM', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/OPERATING_SYSTEM')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'OPERATOR_ID', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/OPERATOR_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ORIENTATION', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ORIENTATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PALLET_ID', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PALLET_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PART_COUNT', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PART_COUNT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PART_COUNT_TYPE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PART_COUNT_TYPE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PART_DETECT', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PART_DETECT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PART_GROUP_ID', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PART_GROUP_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PART_ID', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PART_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PART_INDEX', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PART_INDEX')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PART_KIND_ID', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PART_KIND_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PART_NUMBER', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PART_NUMBER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PART_PROCESSING_STATE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PART_PROCESSING_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PART_STATUS', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PART_STATUS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PART_UNIQUE_ID', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PART_UNIQUE_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PARTICLE_COUNT', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PARTICLE_COUNT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PARTICLE_SIZE', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PARTICLE_SIZE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PATH_FEEDRATE', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PATH_FEEDRATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PATH_FEEDRATE_OVERRIDE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PATH_FEEDRATE_OVERRIDE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PATH_FEEDRATE_PER_REVOLUTION', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PATH_FEEDRATE_PER_REVOLUTION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PATH_MODE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PATH_MODE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PATH_POSITION', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PATH_POSITION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PH', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PH')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'POSITION', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/POSITION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'POSITION_CARTESIAN', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/POSITION_CARTESIAN')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'POWER_FACTOR', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/POWER_FACTOR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'POWER_STATE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/POWER_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'POWER_STATUS', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/POWER_STATUS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PRESSURE', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PRESSURE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PRESSURE_ABSOLUTE', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PRESSURE_ABSOLUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PRESSURIZATION_RATE', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PRESSURIZATION_RATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROCESS_AGGREGATE_ID', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PROCESS_AGGREGATE_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROCESS_KIND_ID', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PROCESS_KIND_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROCESS_OCCURRENCE_ID', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PROCESS_OCCURRENCE_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROCESS_STATE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PROCESS_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROCESS_TIME', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PROCESS_TIME')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROCESS_TIMER', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PROCESS_TIMER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROGRAM', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PROGRAM')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROGRAM_COMMENT', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PROGRAM_COMMENT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROGRAM_EDIT', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PROGRAM_EDIT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROGRAM_EDIT_NAME', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PROGRAM_EDIT_NAME')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROGRAM_HEADER', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PROGRAM_HEADER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROGRAM_LOCATION', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PROGRAM_LOCATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROGRAM_LOCATION_TYPE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PROGRAM_LOCATION_TYPE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROGRAM_NEST_LEVEL', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/PROGRAM_NEST_LEVEL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'RESISTANCE', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/RESISTANCE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'RESISTIVITY', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/RESISTIVITY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ROTARY_MODE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ROTARY_MODE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ROTARY_VELOCITY', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ROTARY_VELOCITY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ROTARY_VELOCITY_OVERRIDE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ROTARY_VELOCITY_OVERRIDE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ROTATION', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/ROTATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SENSOR_ATTACHMENT', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/SENSOR_ATTACHMENT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SENSOR_STATE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/SENSOR_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SERIAL_NUMBER', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/SERIAL_NUMBER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SETTLING_ERROR', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/SETTLING_ERROR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SETTLING_ERROR_ANGULAR', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/SETTLING_ERROR_ANGULAR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SETTLING_ERROR_LINEAR', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/SETTLING_ERROR_LINEAR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SOUND_LEVEL', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/SOUND_LEVEL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SPECIFICATION_LIMIT', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/SPECIFICATION_LIMIT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SPECIFICATION_LIMITS', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/SPECIFICATION_LIMITS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SPINDLE_INTERLOCK', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/SPINDLE_INTERLOCK')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SPINDLE_SPEED', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/SPINDLE_SPEED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'STRAIN', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/STRAIN')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SWING_ANGLE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/SWING_ANGLE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SWING_DIAMETER', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/SWING_DIAMETER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SWING_RADIUS', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/SWING_RADIUS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SYSTEM', 'CONDITION', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/SYSTEM')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TASK_ASSET_ID', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/TASK_ASSET_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TEMPERATURE', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/TEMPERATURE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TENSION', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/TENSION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'THICKNESS', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/THICKNESS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TILT', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/TILT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TOOL_ASSET_ID', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/TOOL_ASSET_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TOOL_CUTTING_ITEM', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/TOOL_CUTTING_ITEM')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TOOL_GROUP', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/TOOL_GROUP')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TOOL_ID', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/TOOL_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TOOL_NUMBER', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/TOOL_NUMBER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TOOL_OFFSET', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/TOOL_OFFSET')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TOOL_OFFSETS', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/TOOL_OFFSETS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TORQUE', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/TORQUE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TRANSFER_COUNT', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/TRANSFER_COUNT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TRANSLATION', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/TRANSLATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'UNCERTAINTY', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/UNCERTAINTY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'UNCERTAINTY_TYPE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/UNCERTAINTY_TYPE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'UNLOAD_COUNT', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/UNLOAD_COUNT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'USER', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/USER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'VALVE_STATE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/VALVE_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'VARIABLE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/VARIABLE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'VELOCITY', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/VELOCITY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'VISCOSITY', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/VISCOSITY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'VOLT_AMPERE', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/VOLT_AMPERE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'VOLT_AMPERE_REACTIVE', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/VOLT_AMPERE_REACTIVE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'VOLTAGE', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/VOLTAGE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'VOLTAGE_AC', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/VOLTAGE_AC')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'VOLTAGE_DC', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/VOLTAGE_DC')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'VOLUME_FLUID', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/VOLUME_FLUID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'VOLUME_SPATIAL', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/VOLUME_SPATIAL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'WAIT_STATE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/WAIT_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'WATER_HARDNESS', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/WATER_HARDNESS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'WATTAGE', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/WATTAGE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'WIRE', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/WIRE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'WORK_OFFSET', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/WORK_OFFSET')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'WORK_OFFSETS', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/WORK_OFFSETS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'WORKHOLDING_ID', 'EVENT', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/WORKHOLDING_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'X_DIMENSION', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/X_DIMENSION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'Y_DIMENSION', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/Y_DIMENSION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'Z_DIMENSION', 'SAMPLE', 'https://factoryplus.local/semantics/mtconnect/v2.0/DataItemType/Z_DIMENSION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ABORTED', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/ABORTED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ABSOLUTE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/ABSOLUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ACTION', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/ACTION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ACTIVE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/ACTIVE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ACTIVITY', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/ACTIVITY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ACTUAL', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/ACTUAL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ALL', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/ALL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ALTERNATING', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/ALTERNATING')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'AUXILIARY', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/AUXILIARY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'A_SCALE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/A_SCALE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'BAD', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/BAD')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'BATCH', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/BATCH')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'BINARY', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/BINARY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'BOOLEAN', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/BOOLEAN')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'BRINELL', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/BRINELL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'B_SCALE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/B_SCALE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'COMMANDED', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/COMMANDED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'COMPLETE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/COMPLETE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'CONSUMED', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/CONSUMED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'CONTROL', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/CONTROL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'CUT', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/CUT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'C_SCALE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/C_SCALE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'DELAY', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/DELAY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'DETECT', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/DETECT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'DIRECT', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/DIRECT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'DRY_RUN', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/DRY_RUN')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'D_SCALE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/D_SCALE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ELECTRODE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/ELECTRODE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ENDED', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/ENDED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ENUMERATED', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/ENUMERATED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'EXPIRATION', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/EXPIRATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'FAILED', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/FAILED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'FILLER', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/FILLER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'FIRST_USE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/FIRST_USE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'GAS', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/GAS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'GATEWAY', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/GATEWAY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'GOOD', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/GOOD')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'GROUND_LEVEL', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/GROUND_LEVEL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'HEAT_TREAT', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/HEAT_TREAT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'INCREMENTAL', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/INCREMENTAL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'INSTALL_DATE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/INSTALL_DATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'IPV4_ADDRESS', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/IPV4_ADDRESS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'IPV6_ADDRESS', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/IPV6_ADDRESS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ISO_STEP_EXECUTABLE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/ISO_STEP_EXECUTABLE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'JOG', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/JOG')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'LATERAL', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/LATERAL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'LAYER', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/LAYER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'LEEB', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/LEEB')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'LENGTH', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/LENGTH')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'LICENSE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/LICENSE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'LINE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/LINE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'LINEAR', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/LINEAR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'LIQUID', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/LIQUID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'LOADED', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/LOADED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'LOT', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/LOT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MACHINE_AXIS_LOCK', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/MACHINE_AXIS_LOCK')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MAC_ADDRESS', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/MAC_ADDRESS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MAIN', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/MAIN')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MAINTENANCE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/MAINTENANCE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MANUAL_UNCLAMP', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/MANUAL_UNCLAMP')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MANUFACTURE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/MANUFACTURE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MANUFACTURER', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/MANUFACTURER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MAXIMUM', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/MAXIMUM')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MEAN_SEA_LEVEL', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/MEAN_SEA_LEVEL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MEASURED', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/MEASURED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MINIMUM', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/MINIMUM')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MODEL', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/MODEL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MOHS', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/MOHS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MOTION', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/MOTION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'NO_SCALE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/NO_SCALE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'OPERATING', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/OPERATING')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'OPERATION', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/OPERATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'OPERATOR', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/OPERATOR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'OPTIONAL_STOP', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/OPTIONAL_STOP')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ORDER_NUMBER', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/ORDER_NUMBER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'OVERRIDE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/OVERRIDE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'PART', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/PART')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'PART_FAMILY', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/PART_FAMILY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'PART_NAME', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/PART_NAME')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'PART_NUMBER', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/PART_NUMBER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'PECK', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/PECK')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'PLUNGE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/PLUNGE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'POWERED', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/POWERED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'PRIMARY', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/PRIMARY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'PROBE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/PROBE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'PROCESS', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/PROCESS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'PROCESS_NAME', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/PROCESS_NAME')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'PROCESS_PLAN', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/PROCESS_PLAN')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'PROCESS_STEP', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/PROCESS_STEP')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'PROGRAMMED', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/PROGRAMMED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'RADIAL', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/RADIAL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'RAPID', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/RAPID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'RAW_MATERIAL', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/RAW_MATERIAL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'RECIPE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/RECIPE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'RELEASE_DATE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/RELEASE_DATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'REMAINING', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/REMAINING')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'REQUEST', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/REQUEST')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'RESPONSE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/RESPONSE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ROCKWELL', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/ROCKWELL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ROTARY', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/ROTARY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'SCHEDULE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/SCHEDULE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'SEGMENT', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/SEGMENT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'SERIAL_NUMBER', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/SERIAL_NUMBER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'SET_UP', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/SET_UP')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'SHORE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/SHORE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'SINGLE_BLOCK', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/SINGLE_BLOCK')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'SOLID', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/SOLID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'STANDARD', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/STANDARD')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'START', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/START')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'SUBNET_MASK', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/SUBNET_MASK')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'SWITCHED', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/SWITCHED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'TARGET', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/TARGET')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'TARGET_COMPLETION', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/TARGET_COMPLETION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'TOOL_CHANGE_STOP', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/TOOL_CHANGE_STOP')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'USEABLE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/USEABLE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'UUID', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/UUID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'VERSION', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/VERSION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'VERTICAL', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/VERTICAL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'VICKERS', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/VICKERS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'VLAN_ID', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/VLAN_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'WASTE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/WASTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'WIRELESS', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/WIRELESS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'WORKING', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/SubType/WORKING')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'AMPERE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/AMPERE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'CELSIUS', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/CELSIUS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'COULOMB', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/COULOMB')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'COUNT', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/COUNT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'COUNT/SECOND', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/COUNT/SECOND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'CUBIC_METER', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/CUBIC_METER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'CUBIC_MILLIMETER', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/CUBIC_MILLIMETER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'CUBIC_MILLIMETER/SECOND', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/CUBIC_MILLIMETER/SECOND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'CUBIC_MILLIMETER/SECOND^2', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/CUBIC_MILLIMETER/SECOND^2')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'DECIBEL', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/DECIBEL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'DEGREE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/DEGREE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'DEGREE/SECOND', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/DEGREE/SECOND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'DEGREE/SECOND^2', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/DEGREE/SECOND^2')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'DEGREE_3D', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/DEGREE_3D')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'GRAM', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/GRAM')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'GRAM/CUBIC_METER', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/GRAM/CUBIC_METER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'HERTZ', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/HERTZ')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'JOULE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/JOULE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'KILOGRAM', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/KILOGRAM')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'LITER', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/LITER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'LITER/SECOND', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/LITER/SECOND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'METER', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/METER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'METER/SECOND^2', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/METER/SECOND^2')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'MICRO_RADIAN', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/MICRO_RADIAN')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'MILLIGRAM', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/MILLIGRAM')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'MILLIGRAM/CUBIC_MILLIMETER', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/MILLIGRAM/CUBIC_MILLIMETER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'MILLIGRAM/LITER', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/MILLIGRAM/LITER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'MILLILITER', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/MILLILITER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'MILLIMETER', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/MILLIMETER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'MILLIMETER/REVOLUTION', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/MILLIMETER/REVOLUTION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'MILLIMETER/SECOND', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/MILLIMETER/SECOND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'MILLIMETER/SECOND^2', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/MILLIMETER/SECOND^2')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'MILLIMETER_3D', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/MILLIMETER_3D')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'NEWTON', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/NEWTON')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'NEWTON_METER', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/NEWTON_METER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'OHM', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/OHM')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'OHM_METER', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/OHM_METER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'PASCAL', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/PASCAL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'PASCAL/SECOND', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/PASCAL/SECOND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'PASCAL_SECOND', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/PASCAL_SECOND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'PERCENT', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/PERCENT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'PH', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/PH')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'REVOLUTION/MINUTE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/REVOLUTION/MINUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'REVOLUTION/SECOND', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/REVOLUTION/SECOND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'REVOLUTION/SECOND^2', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/REVOLUTION/SECOND^2')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'SECOND', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/SECOND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'SIEMENS/METER', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/SIEMENS/METER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'SQUARE_MILLIMETER', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/SQUARE_MILLIMETER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'UNIT_VECTOR_3D', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/UNIT_VECTOR_3D')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'VOLT', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/VOLT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'VOLT_AMPERE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/VOLT_AMPERE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'VOLT_AMPERE_REACTIVE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/VOLT_AMPERE_REACTIVE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'WATT', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/WATT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'WATT_SECOND', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Unit/WATT_SECOND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'AMPERE_HOUR', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/AMPERE_HOUR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'BAR', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/BAR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'CENTIPOISE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/CENTIPOISE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'COUNT/MILLION', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/COUNT/MILLION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'COUNT/TRILLION', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/COUNT/TRILLION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'CUBIC_FOOT', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/CUBIC_FOOT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'CUBIC_FOOT/HOUR', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/CUBIC_FOOT/HOUR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'CUBIC_FOOT/MINUTE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/CUBIC_FOOT/MINUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'DEGREE/MINUTE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/DEGREE/MINUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'FAHRENHEIT', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/FAHRENHEIT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'FOOT', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/FOOT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'FOOT/MINUTE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/FOOT/MINUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'FOOT/SECOND', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/FOOT/SECOND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'FOOT/SECOND^2', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/FOOT/SECOND^2')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'FOOT_3D', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/FOOT_3D')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'GALLON/MINUTE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/GALLON/MINUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'GRAVITATIONAL_ACCELERATION', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/GRAVITATIONAL_ACCELERATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'GRAVITATIONAL_FORCE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/GRAVITATIONAL_FORCE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'HOUR', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/HOUR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'INCH', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/INCH')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'INCH/MINUTE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/INCH/MINUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'INCH/REVOLUTION', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/INCH/REVOLUTION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'INCH/SECOND', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/INCH/SECOND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'INCH/SECOND^2', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/INCH/SECOND^2')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'INCH_3D', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/INCH_3D')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'INCH_POUND', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/INCH_POUND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'KELVIN', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/KELVIN')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'KILOWATT', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/KILOWATT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'KILOWATT_HOUR', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/KILOWATT_HOUR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'LITER/MINUTE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/LITER/MINUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'MICROMETER', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/MICROMETER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'MICROTORR', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/MICROTORR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'MILLIMETER/MINUTE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/MILLIMETER/MINUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'MILLIMETER_MERCURY', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/MILLIMETER_MERCURY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'MINUTE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/MINUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'OTHER', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/OTHER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'PASCAL/MINUTE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/PASCAL/MINUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'POUND', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/POUND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'POUND/INCH^2', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/POUND/INCH^2')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'RADIAN', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/RADIAN')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'RADIAN/MINUTE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/RADIAN/MINUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'RADIAN/SECOND', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/RADIAN/SECOND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'RADIAN/SECOND^2', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/RADIAN/SECOND^2')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'RANKINE', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/RANKINE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'SQUARE_INCH', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/SQUARE_INCH')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'TORR', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/NativeUnit/TORR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Actuator', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Actuator')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Adapter', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Adapter')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Adapters', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Adapters')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Agent', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Agent')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'AirHandler', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/AirHandler')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Amplifier', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Amplifier')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'AutomaticToolChanger', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/AutomaticToolChanger')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Auxiliaries', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Auxiliaries')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Auxiliary', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Auxiliary')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Axes', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Axes')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Axis', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Axis')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Ballscrew', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Ballscrew')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'BarFeeder', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/BarFeeder')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'BarFeederInterface', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/BarFeederInterface')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Belt', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Belt')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Brake', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Brake')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Chain', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Chain')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Chopper', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Chopper')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Chuck', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Chuck')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'ChuckInterface', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/ChuckInterface')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Chute', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Chute')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'CircuitBreaker', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/CircuitBreaker')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Clamp', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Clamp')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Compressor', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Compressor')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Controller', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Controller')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Coolant', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Coolant')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Cooling', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Cooling')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'CoolingTower', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/CoolingTower')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'CuttingTorch', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/CuttingTorch')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Deposition', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Deposition')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Dielectric', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Dielectric')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Door', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Door')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'DoorInterface', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/DoorInterface')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Drain', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Drain')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Electric', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Electric')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Electrode', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Electrode')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Enclosure', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Enclosure')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Encoder', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Encoder')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'EndEffector', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/EndEffector')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Environmental', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Environmental')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'ExpiredPot', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/ExpiredPot')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'ExposureUnit', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/ExposureUnit')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'ExtrusionUnit', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/ExtrusionUnit')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Fan', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Fan')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'FeatureOccurrence', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/FeatureOccurrence')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Feeder', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Feeder')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Filter', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Filter')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Galvanomotor', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Galvanomotor')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'GangToolBar', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/GangToolBar')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Gripper', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Gripper')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Heating', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Heating')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Hopper', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Hopper')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Hydraulic', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Hydraulic')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Interface', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Interface')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Interfaces', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Interfaces')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Linear', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Linear')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'LinearPositionFeedback', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/LinearPositionFeedback')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Link', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Link')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Loader', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Loader')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Lock', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Lock')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Lubrication', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Lubrication')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Material', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Material')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'MaterialHandlerInterface', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/MaterialHandlerInterface')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Materials', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Materials')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Motor', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Motor')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Oil', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Oil')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Part', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Part')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'PartOccurrence', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/PartOccurrence')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Parts', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Parts')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Path', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Path')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Personnel', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Personnel')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'PinTool', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/PinTool')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Pneumatic', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Pneumatic')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Pot', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Pot')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Power', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Power')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'PowerSupply', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/PowerSupply')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Pressure', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Pressure')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Process', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Process')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Processes', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Processes')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'ProcessOccurrence', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/ProcessOccurrence')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'ProcessPower', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/ProcessPower')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Protective', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Protective')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Pulley', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Pulley')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Pump', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Pump')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Reel', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Reel')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'RemovalPot', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/RemovalPot')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Requester', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Requester')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Resource', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Resource')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Resources', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Resources')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Responder', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Responder')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'ReturnPot', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/ReturnPot')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Rotary', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Rotary')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'SensingElement', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/SensingElement')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Sensor', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Sensor')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Spindle', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Spindle')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Spreader', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Spreader')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'StagingPot', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/StagingPot')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Station', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Station')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Stock', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Stock')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'StorageBattery', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/StorageBattery')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Structure', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Structure')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Structures', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Structures')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Switch', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Switch')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'System', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/System')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Systems', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Systems')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Table', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Table')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Tank', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Tank')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Tensioner', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Tensioner')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Thermostat', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Thermostat')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'ToolHolder', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/ToolHolder')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'ToolingDelivery', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/ToolingDelivery')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'ToolMagazine', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/ToolMagazine')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'ToolRack', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/ToolRack')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'TransferArm', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/TransferArm')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'TransferPot', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/TransferPot')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Transformer', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Transformer')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Turret', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Turret')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Vacuum', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Vacuum')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Valve', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Valve')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Vat', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Vat')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Vibration', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Vibration')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'WasteDisposal', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/WasteDisposal')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Water', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Water')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Wire', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Wire')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'WorkEnvelope', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/WorkEnvelope')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Workpiece', NULL, 'https://factoryplus.local/semantics/mtconnect/v2.0/Component/Workpiece')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
-- <<< END GENERATED mtconnect_vocabulary


-- -------------------------------------------------------------------------------------------
-- ISO 22400 vocabulary (8 rows)  (8 rows)
-- -------------------------------------------------------------------------------------------
-- The computed KPIs that MTConnect and OPC UA both deliberately exclude. `kpi_id` is the ISO
-- SYMBOL, not a clause number -- none are asserted, because the standard is paywalled and they
-- could not be checked.
--
-- MTConnect's `AVAILABILITY` is a trap: it is an EVENT meaning "device connected", whereas the OEE
-- availability RATIO here is ISO 22400. Never map one onto the other.

INSERT INTO public.iso22400_vocabulary VALUES ('AVAILABILITY', 'A', 'Availability ratio: the share of planned busy time the equipment was actually producing. ISO 22400-2 "Availability". NOT MTConnect AVAILABILITY, which is an EVENT meaning the device is connected.', 'OEE', 'PERCENT', 'A = APT / PBT', 'https://factoryplus.local/semantics/iso22400/AVAILABILITY')
ON CONFLICT (name) DO UPDATE SET
  kpi_id      = EXCLUDED.kpi_id,
  description = EXCLUDED.description,
  category    = EXCLUDED.category,
  unit        = EXCLUDED.unit,
  formula     = EXCLUDED.formula,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.iso22400_vocabulary VALUES ('EFFECTIVENESS', 'E', 'Effectiveness ratio: actual output against what the run time should have produced. ISO 22400-2 calls this KPI "Effectiveness"; it is the factor the industry almost always calls Performance, and the catalog''s superseded OEE/PERFORMANCE metric measured exactly this.', 'OEE', 'PERCENT', 'E = (PRI x PQ) / APT', 'https://factoryplus.local/semantics/iso22400/EFFECTIVENESS')
ON CONFLICT (name) DO UPDATE SET
  kpi_id      = EXCLUDED.kpi_id,
  description = EXCLUDED.description,
  category    = EXCLUDED.category,
  unit        = EXCLUDED.unit,
  formula     = EXCLUDED.formula,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.iso22400_vocabulary VALUES ('QUALITY', 'Q', 'Quality ratio: good quantity as a share of total produced quantity. ISO 22400-2 "Quality ratio".', 'OEE', 'PERCENT', 'Q = GQ / PQ', 'https://factoryplus.local/semantics/iso22400/QUALITY')
ON CONFLICT (name) DO UPDATE SET
  kpi_id      = EXCLUDED.kpi_id,
  description = EXCLUDED.description,
  category    = EXCLUDED.category,
  unit        = EXCLUDED.unit,
  formula     = EXCLUDED.formula,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.iso22400_vocabulary VALUES ('OEE', 'OEE', 'Overall equipment effectiveness: the product of the three factors above. ISO 22400-2 "OEE index". A composite -- derive it from A, E and Q rather than having a device report it independently, or the four values can disagree.', 'OEE', 'PERCENT', 'OEE = A x E x Q', 'https://factoryplus.local/semantics/iso22400/OEE')
ON CONFLICT (name) DO UPDATE SET
  kpi_id      = EXCLUDED.kpi_id,
  description = EXCLUDED.description,
  category    = EXCLUDED.category,
  unit        = EXCLUDED.unit,
  formula     = EXCLUDED.formula,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.iso22400_vocabulary VALUES ('SCRAP_RATIO', 'SR', 'Scrap ratio: scrap quantity as a share of produced quantity. ISO 22400-2 "Scrap ratio". The complement of the quality ratio only when rework is zero -- they are separate KPIs for that reason.', 'Quality', 'PERCENT', 'SR = SQ / PQ', 'https://factoryplus.local/semantics/iso22400/SCRAP_RATIO')
ON CONFLICT (name) DO UPDATE SET
  kpi_id      = EXCLUDED.kpi_id,
  description = EXCLUDED.description,
  category    = EXCLUDED.category,
  unit        = EXCLUDED.unit,
  formula     = EXCLUDED.formula,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.iso22400_vocabulary VALUES ('UTILIZATION', 'UR', 'Utilization (loading) ratio: planned busy time as a share of calendar time. The common industry ratio rather than a verbatim ISO 22400-2 KPI -- it answers "how much of the day was this asset scheduled to work?", which availability deliberately does not. Verify against the standard before citing it as ISO 22400.', 'Utilization', 'PERCENT', 'UR = PBT / CAL', 'https://factoryplus.local/semantics/iso22400/UTILIZATION')
ON CONFLICT (name) DO UPDATE SET
  kpi_id      = EXCLUDED.kpi_id,
  description = EXCLUDED.description,
  category    = EXCLUDED.category,
  unit        = EXCLUDED.unit,
  formula     = EXCLUDED.formula,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.iso22400_vocabulary VALUES ('MTBF', 'MTBF', 'Mean operating time between failures. ISO 22400-2 "Mean operating time between failures".', 'Maintenance', 'HOUR', 'MTBF = APT / number of failures', 'https://factoryplus.local/semantics/iso22400/MTBF')
ON CONFLICT (name) DO UPDATE SET
  kpi_id      = EXCLUDED.kpi_id,
  description = EXCLUDED.description,
  category    = EXCLUDED.category,
  unit        = EXCLUDED.unit,
  formula     = EXCLUDED.formula,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.iso22400_vocabulary VALUES ('MTTR', 'MTTR', 'Mean time to restoration -- the average time to return the asset to service after a failure. ISO 22400-2 "Mean time to restoration"; MTTR is the common abbreviation and is often expanded as "mean time to repair".', 'Maintenance', 'HOUR', 'MTTR = total repair time / number of repairs', 'https://factoryplus.local/semantics/iso22400/MTTR')
ON CONFLICT (name) DO UPDATE SET
  kpi_id      = EXCLUDED.kpi_id,
  description = EXCLUDED.description,
  category    = EXCLUDED.category,
  unit        = EXCLUDED.unit,
  formula     = EXCLUDED.formula,
  semantic_id = EXCLUDED.semantic_id;


-- -------------------------------------------------------------------------------------------
-- OPC UA vocabulary (25 rows)  (25 rows)
-- -------------------------------------------------------------------------------------------
-- Companion-specification data points from OPC 40001 (Machinery) and OPC 40010 (Robotics).
--
-- `node_id` is a BROWSE PATH, not a numeric NodeId -- `nsu=<ns>;s=<BrowsePath>`. The numeric ids
-- live in each spec's NodeSet2 XML, which is not vendored; they were not invented. The browse
-- names are transcribed and still want confirming against those files.
--
-- Keyed on (companion_spec, name) because Machinery and Robotics both define names like
-- `Manufacturer`.

INSERT INTO public.opcua_vocabulary VALUES ('Manufacturer', 'OPC 40001 Machinery', 'nsu=http://opcfoundation.org/UA/Machinery/;s=Machine/Identification/Manufacturer', 'Name of the machine manufacturer.', 'LocalizedText', NULL, 'http://opcfoundation.org/UA/Machinery/Manufacturer')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('Model', 'OPC 40001 Machinery', 'nsu=http://opcfoundation.org/UA/Machinery/;s=Machine/Identification/Model', 'Manufacturer-assigned model name of the machine.', 'LocalizedText', NULL, 'http://opcfoundation.org/UA/Machinery/Model')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('SerialNumber', 'OPC 40001 Machinery', 'nsu=http://opcfoundation.org/UA/Machinery/;s=Machine/Identification/SerialNumber', 'Serial number uniquely identifying this machine instance for its manufacturer.', 'String', NULL, 'http://opcfoundation.org/UA/Machinery/SerialNumber')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('ProductInstanceUri', 'OPC 40001 Machinery', 'nsu=http://opcfoundation.org/UA/Machinery/;s=Machine/Identification/ProductInstanceUri', 'Globally unique URI for this machine instance. The closest OPC UA equivalent to an AAS globalAssetId, and the natural anchor when cross-referencing a shell.', 'String', NULL, 'http://opcfoundation.org/UA/Machinery/ProductInstanceUri')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('SoftwareRevision', 'OPC 40001 Machinery', 'nsu=http://opcfoundation.org/UA/Machinery/;s=Machine/Identification/SoftwareRevision', 'Software or firmware revision of the machine.', 'String', NULL, 'http://opcfoundation.org/UA/Machinery/SoftwareRevision')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('YearOfConstruction', 'OPC 40001 Machinery', 'nsu=http://opcfoundation.org/UA/Machinery/;s=Machine/Identification/YearOfConstruction', 'Year the machine was built.', 'UInt16', NULL, 'http://opcfoundation.org/UA/Machinery/YearOfConstruction')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('MachineryItemState', 'OPC 40001 Machinery', 'nsu=http://opcfoundation.org/UA/Machinery/;s=Machine/MachineryItemState/CurrentState', 'Lifecycle state of the machine: Executing, NotExecuting, NotAvailable or OutOfService. The OPC UA analogue of the execution state a controller reports -- a discrete state, so a String metric rather than a numeric one.', 'LocalizedText', NULL, 'http://opcfoundation.org/UA/Machinery/MachineryItemState')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('MachineryOperationMode', 'OPC 40001 Machinery', 'nsu=http://opcfoundation.org/UA/Machinery/;s=Machine/MachineryOperationMode/CurrentState', 'Operating mode of the machine: Processing, Setup, Maintenance or Normal.', 'LocalizedText', NULL, 'http://opcfoundation.org/UA/Machinery/MachineryOperationMode')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('OperationalTime', 'OPC 40001 Machinery', 'nsu=http://opcfoundation.org/UA/Machinery/;s=Machine/MachineryBuildingBlocks/OperationCounters/OperationalTime', 'Accumulated time the machine has been operational. Feeds the ISO 22400 availability and MTBF calculations rather than replacing them.', 'Double', 'SECOND', 'http://opcfoundation.org/UA/Machinery/OperationalTime')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('PowerOnDuration', 'OPC 40001 Machinery', 'nsu=http://opcfoundation.org/UA/Machinery/;s=Machine/MachineryBuildingBlocks/OperationCounters/PowerOnDuration', 'Accumulated time the machine has been powered on.', 'Double', 'SECOND', 'http://opcfoundation.org/UA/Machinery/PowerOnDuration')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('ActualPosition', 'OPC 40010 Robotics', 'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/Axes/Axis/ActualPosition', 'Current position of an axis. Units follow the axis type -- MILLIMETER for a linear axis, DEGREE for a rotary one -- so the unit is a choice at metric-creation time, not a property of the browse name.', 'Double', 'MILLIMETER', 'http://opcfoundation.org/UA/Robotics/ActualPosition')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('ActualSpeed', 'OPC 40010 Robotics', 'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/Axes/Axis/ActualSpeed', 'Current speed of an axis. On a rotary axis this is the angular velocity; pick DEGREE/SECOND rather than MILLIMETER/SECOND for those.', 'Double', 'MILLIMETER/SECOND', 'http://opcfoundation.org/UA/Robotics/ActualSpeed')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('ActualAcceleration', 'OPC 40010 Robotics', 'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/Axes/Axis/ActualAcceleration', 'Current acceleration of an axis.', 'Double', NULL, 'http://opcfoundation.org/UA/Robotics/ActualAcceleration')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('MotionProfile', 'OPC 40010 Robotics', 'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/Axes/Axis/MotionProfile', 'Kind of motion the axis performs -- rotary, linear or spindle.', 'String', NULL, 'http://opcfoundation.org/UA/Robotics/MotionProfile')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('SpeedOverride', 'OPC 40010 Robotics', 'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/ParameterSet/SpeedOverride', 'Operator speed override applied to programmed motion, as a percentage. The robotics counterpart of a machine tool feed-rate override.', 'Double', 'PERCENT', 'http://opcfoundation.org/UA/Robotics/SpeedOverride')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('InControl', 'OPC 40010 Robotics', 'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/ParameterSet/InControl', 'Whether the motion device is under control of its controller.', 'Boolean', NULL, 'http://opcfoundation.org/UA/Robotics/InControl')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('OnPath', 'OPC 40010 Robotics', 'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/ParameterSet/OnPath', 'Whether the motion device is on its programmed path.', 'Boolean', NULL, 'http://opcfoundation.org/UA/Robotics/OnPath')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('MotionDeviceCategory', 'OPC 40010 Robotics', 'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/MotionDeviceCategory', 'Kind of motion device -- articulated robot, cartesian robot, AGV and so on.', 'String', NULL, 'http://opcfoundation.org/UA/Robotics/MotionDeviceCategory')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('Mass', 'OPC 40010 Robotics', 'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/AdditionalLoad/Mass', 'Mass of a load carried by the motion device -- the payload weight, including the tool where the tool is modelled as part of the load.', 'Double', 'KILOGRAM', 'http://opcfoundation.org/UA/Robotics/Mass')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('EmergencyStop', 'OPC 40010 Robotics', 'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/SafetyStates/SafetyState/EmergencyStop', 'Emergency stop state of the motion device. Note the sense: this asserts the stop is active, the inverse of a "safety OK" boolean.', 'Boolean', NULL, 'http://opcfoundation.org/UA/Robotics/EmergencyStop')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('ProtectiveStop', 'OPC 40010 Robotics', 'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/SafetyStates/SafetyState/ProtectiveStop', 'Protective stop state -- a guard, light curtain or safety-rated sensor has halted motion.', 'Boolean', NULL, 'http://opcfoundation.org/UA/Robotics/ProtectiveStop')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('OperationalMode', 'OPC 40010 Robotics', 'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/SafetyStates/SafetyState/OperationalMode', 'Safety-relevant operating mode of the motion device -- automatic, manual reduced speed, manual high speed.', 'String', NULL, 'http://opcfoundation.org/UA/Robotics/OperationalMode')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('TaskProgramName', 'OPC 40010 Robotics', 'nsu=http://opcfoundation.org/UA/Robotics/;s=Controller/TaskControl/TaskProgramName', 'Name of the task program currently loaded on the controller.', 'String', NULL, 'http://opcfoundation.org/UA/Robotics/TaskProgramName')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('ExecutionMode', 'OPC 40010 Robotics', 'nsu=http://opcfoundation.org/UA/Robotics/;s=Controller/TaskControl/ExecutionMode', 'Execution mode of the loaded task program -- continuous, step or cycle.', 'String', NULL, 'http://opcfoundation.org/UA/Robotics/ExecutionMode')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('TotalPowerOnTime', 'OPC 40010 Robotics', 'nsu=http://opcfoundation.org/UA/Robotics/;s=Controller/ParameterSet/TotalPowerOnTime', 'Accumulated controller power-on time.', 'Double', 'SECOND', 'http://opcfoundation.org/UA/Robotics/TotalPowerOnTime')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;


-- -------------------------------------------------------------------------------------------
-- Default schema  (1 row)
-- -------------------------------------------------------------------------------------------
-- The single default schema, spanning all three standards.
--
-- It is a SUPERSET of what the simulator publishes, deliberately: the Unmodelled finding is
-- (declared) - (modelled), so a schema holding only the "interesting" metrics would flag the demo
-- device for publishing exactly what it was provisioned to publish.
--
-- DO NOTHING is load-bearing now that schemas are versioned. Once an operator publishes a v2, this
-- row is `archived` -- a DO UPDATE would rewrite history on every boot, and re-pinning it is what
-- used to drag the demo device back onto a superseded version each time the stack came up.

INSERT INTO public.schemas VALUES ('e3333333-4444-5555-6666-777777777777', 'Simulated_CNC_01_Schema', 'Default tri-standard schema for the demo CNC: MTConnect observations, ISO 22400 KPIs and OPC UA companion-specification data points.', '{"type": "object", "required": ["Systems/TEMPERATURE", "Controller/EXECUTION", "Controller/EMERGENCY_STOP"], "properties": {"OEE/QUALITY": {"type": "number"}, "Axes/C/ANGLE": {"type": "number"}, "SERIAL_NUMBER": {"type": "string"}, "OEE/AVAILABILITY": {"type": "number"}, "safety_interlock": {"type": "boolean"}, "Axes/DISPLACEMENT": {"type": "number"}, "OEE/EFFECTIVENESS": {"type": "number"}, "max_temp_threshold": {"type": "number"}, "Controller/FIRMWARE": {"type": "string"}, "Systems/TEMPERATURE": {"type": "number"}, "Controller/EXECUTION": {"type": "string"}, "Machine/OperatingMode": {"type": "string"}, "Controller/EMERGENCY_STOP": {"type": "string"}, "MotionDevice/OverridePercent": {"type": "number"}}}', '2026-08-02 05:44:47.407135+00', 'https://factoryplus.local/semantics/schema/SimulatedCNC01', 'IRI', 1, NULL, 'active', 'Initial release')
ON CONFLICT (schema_name) DO NOTHING;


-- -------------------------------------------------------------------------------------------
-- Factory cells  (0 rows)
-- -------------------------------------------------------------------------------------------
-- None seeded. Unassigned and Site-Wide are DERIVED lanes, not rows: a magic cell would put
-- semantics in a free-text name, and the pg_cron purge runs as superuser, past any RLS guard.

-- (no rows)


-- -------------------------------------------------------------------------------------------
-- Edge gateways  (1 row)
-- -------------------------------------------------------------------------------------------
-- The virtual gateway Node-RED publishes through. Its UUID is PINNED: `sparkplug_id` is generated
-- from the primary key, so an auto-discovered gateway would get a different wire identity on every
-- rebuild, silently detaching previously recorded telemetry from the asset that produced it.

-- NAMED COLUMNS, not positional. pg_dump emits `INSERT INTO t VALUES (...)`, which binds to the
-- column ORDER of the table as it stood when the dump was taken -- so dropping a column (0004
-- removed `ip_address`) makes this fail with "INSERT has more expressions than target columns",
-- and, far worse, ADDING one in the middle would silently shift every value one column left
-- without erroring at all. Naming the columns makes the statement independent of the table's
-- shape. `sparkplug_id` is omitted because it is GENERATED ALWAYS ... STORED and cannot be
-- written; it derives from the pinned id above.
INSERT INTO public.gateways (
  id, name, cell_id, access_url, status, created_at,
  is_archived, archived_at, auto_delete_at, last_heartbeat, is_virtual, location_scope
) VALUES (
  '10000000-0000-4000-8000-000000000001', 'Virtual_Gateway_NodeRED', NULL, 'http://localhost:1880',
  'OFFLINE', '2026-08-02 05:44:29.274898+00', false, NULL, NULL, NULL, true, 'cell'
)
ON CONFLICT (id) DO NOTHING;


-- -------------------------------------------------------------------------------------------
-- Demo device  (1 row)
-- -------------------------------------------------------------------------------------------
-- Pre-registered rather than left to be auto-discovered, for the same pinned-UUID reason as the
-- gateway above. `20000000-0000-4000-8000-000000000002` is the UUID behind the documented id
-- `dev200000000000400080000` that node_red_flow.json publishes under.
--
-- STILL QUARANTINED, deliberately: that preserves the zero-touch onboarding demo. An Administrator
-- approves it before its telemetry is stored; the difference is that the row already exists with
-- its schema attached, so approving lights up tags, unmodelled detection, telemetry and the
-- Grafana dashboards together instead of leaving them blank until someone also picks a schema.
--
-- DO NOTHING, never DO UPDATE. This is pre-registration, not re-provisioning: an UPDATE fires
-- log_digital_thread_event() whether or not any value differs, so a DO UPDATE here appended a row
-- to an append-only audit table on every single boot.

INSERT INTO public.devices VALUES ('20000000-0000-4000-8000-000000000002', 'Simulated_CNC_01', '10000000-0000-4000-8000-000000000001', 'OFFLINE', true, '2026-08-02 05:44:38.321627+00', false, NULL, NULL, NULL, 'Sparkplug B', NULL, 'e3333333-4444-5555-6666-777777777777', DEFAULT, NULL, 'UNKNOWN_DEVICE', NULL, NULL, NULL, NULL, NULL, 'cell')
ON CONFLICT (id) DO NOTHING;


-- -------------------------------------------------------------------------------------------
-- Device submodel attachments  (1 row)
-- -------------------------------------------------------------------------------------------
-- The join that lets a device carry more than one schema, one AAS Submodel each. `devices.schema_id`
-- is retained as the fallback arm for devices with no rows here; readers resolve the union through
-- the `device_schemas` view.

INSERT INTO public.device_submodels VALUES ('d577cbc0-66ae-4a0f-bb85-ff7fe96bcbb0', '20000000-0000-4000-8000-000000000002', 'e3333333-4444-5555-6666-777777777777', NULL, '2026-08-02 05:44:48.1724+00')
ON CONFLICT (device_id, schema_id) DO NOTHING;


-- -------------------------------------------------------------------------------------------
-- Service directory  (13 rows)
-- -------------------------------------------------------------------------------------------

INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-000000000001', 'Supabase Studio', 'GRAPHICAL_UI', 'http://127.0.0.1:54323', 'ACTIVE', '2026-08-02 05:44:29.276449+00', NULL)
ON CONFLICT (service_name) DO NOTHING;
INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-000000000002', 'Factory+ Web Dashboard', 'GRAPHICAL_UI', 'http://localhost:3000', 'ACTIVE', '2026-08-02 05:44:29.276449+00', NULL)
ON CONFLICT (service_name) DO NOTHING;
INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-000000000003', 'Node-RED Edge Gateway', 'EDGE_NODE', 'http://localhost:1880', 'ACTIVE', '2026-08-02 05:44:29.276449+00', NULL)
ON CONFLICT (service_name) DO NOTHING;
INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-000000000004', 'Mosquitto MQTT Broker', 'MQTT_BROKER', 'mqtt://localhost:1883', 'ACTIVE', '2026-08-02 05:44:29.276449+00', NULL)
ON CONFLICT (service_name) DO NOTHING;
INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-000000000005', 'TimescaleDB Telemetry Store', 'TIME_SERIES_DB', 'postgres://localhost:5433', 'ACTIVE', '2026-08-02 05:44:29.276449+00', NULL)
ON CONFLICT (service_name) DO NOTHING;
INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-000000000006', 'Grafana Dashboards', 'MONITORING', 'http://localhost:3002', 'ACTIVE', '2026-08-02 05:44:29.276449+00', NULL)
ON CONFLICT (service_name) DO NOTHING;
INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-000000000007', 'Supabase API Gateway (Kong)', 'API_GATEWAY', 'http://127.0.0.1:54321', 'ACTIVE', '2026-08-02 05:44:29.276449+00', NULL)
ON CONFLICT (service_name) DO NOTHING;
INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-000000000008', 'Supabase Auth (GoTrue)', 'AUTHENTICATION', 'http://127.0.0.1:54321/auth/v1', 'ACTIVE', '2026-08-02 05:44:29.276449+00', NULL)
ON CONFLICT (service_name) DO NOTHING;
INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-000000000009', 'Supabase PostgREST API', 'REST_API', 'http://127.0.0.1:54321/rest/v1', 'ACTIVE', '2026-08-02 05:44:29.276449+00', NULL)
ON CONFLICT (service_name) DO NOTHING;
INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-00000000000a', 'Supabase Edge Functions', 'SERVERLESS', 'http://127.0.0.1:54321/functions/v1', 'ACTIVE', '2026-08-02 05:44:29.276449+00', NULL)
ON CONFLICT (service_name) DO NOTHING;
INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-00000000000b', 'Supabase PostgreSQL', 'DATABASE', 'postgres://localhost:54322', 'ACTIVE', '2026-08-02 05:44:29.276449+00', NULL)
ON CONFLICT (service_name) DO NOTHING;
INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-00000000000c', 'Sparkplug B Ingestion Engine', 'INGESTION', 'mqtt://mosquitto:1883/spBv1.0/#', 'ACTIVE', '2026-08-02 05:44:29.276449+00', NULL)
ON CONFLICT (service_name) DO NOTHING;
INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-00000000000d', 'API Reference (Swagger UI)', 'DOCUMENTATION', 'http://localhost:8088', 'ACTIVE', '2026-08-02 05:44:29.276449+00', NULL)
ON CONFLICT (service_name) DO NOTHING;


-- -------------------------------------------------------------------------------------------
-- Outbound webhook targets  (1 row)
-- -------------------------------------------------------------------------------------------
-- Migration-managed and deliberately given NO write RLS policy: a writable endpoint table is an
-- SSRF primitive. `anon` is revoked at the grant level too.
--
-- pg_net has no retries, ordering or dead-letter queue. Advisory notifications only -- if delivery
-- must be guaranteed, publish over MQTT from the ingestion daemon instead.

INSERT INTO public.webhook_endpoints VALUES ('3484ec9d-e07f-49ee-8aa3-f95d40d38a54', 'device.quarantined', 'http://node-red:1880/hooks/quarantine', 'nodered_admin_token', true, '2026-08-02 05:44:42.806298+00')
ON CONFLICT (event_key, url) DO NOTHING;


-- ---------------------------------------------------------------------------------------------
-- Sequence reconciliation
-- ---------------------------------------------------------------------------------------------
-- FIXES A DEFECT THE INCREMENTAL CHAIN CARRIED. `roles` is seeded with explicit ids, which does
-- not advance `roles_id_seq` -- it sat at 1 while max(id) was 4, so inserting a NEW role without
-- naming an id failed on `roles_pkey`. The manual `setval` used to be documented as the
-- workaround; a squashed baseline is the right place to stop needing one.
--
-- `GREATEST(..., 1)` because setval rejects a value below the sequence minimum, which is what an
-- empty table would produce.
SELECT setval('public.roles_id_seq', GREATEST((SELECT COALESCE(max(id), 0) FROM public.roles), 1));


-- ---------------------------------------------------------------------------------------------
-- Scheduled maintenance jobs (pg_cron)
-- ---------------------------------------------------------------------------------------------
-- JANITORIAL ONLY. No job derives application state -- gateway staleness is a VIEW, not a cron
-- writer, because log_digital_thread_event() fires on every UPDATE to `gateways` and a sweep
-- writing STALE would append to an append-only audit table forever, while being correct only
-- between ticks.
--
-- public.ensure_cron_job() is DDL and lives in 0001; these are the scheduling calls, which are
-- DML against cron.job. It exists because cron.schedule() appends rather than replaces, and
-- this file is replayed on every boot.

-- 1. Prune pg_net's response log ------------------------------------------------------------
--
-- pg_net records every response in net._http_response and never prunes it; left alone it grows
-- for the life of the database. Scheduled here rather than in Phase 4 so the janitor exists
-- before the thing it cleans up.
--
-- The guard matters: pg_net is not installed until Phase 4 (migration 0026), so an unguarded
-- DELETE would fail every 15 minutes until then and fill cron.job_run_details with errors --
-- the job would be generating exactly the noise it exists to remove. to_regclass() returns
-- NULL rather than raising for a missing relation, so this no-ops cleanly and starts working
-- by itself the moment the extension is created.
SELECT public.ensure_cron_job(
  'prune_net_responses',
  '*/15 * * * *',
  $job$
    DO $prune$
    BEGIN
      IF to_regclass('net._http_response') IS NOT NULL THEN
        DELETE FROM net._http_response WHERE created < NOW() - INTERVAL '6 hours';
      END IF;
    END $prune$;
  $job$
);

-- 2. Prune pg_cron's own run history --------------------------------------------------------
-- cron.job_run_details grows one row per job per run and is not self-limiting.
SELECT public.ensure_cron_job(
  'prune_cron_history',
  '0 3 * * *',
  $job$DELETE FROM cron.job_run_details WHERE end_time < NOW() - INTERVAL '7 days'$job$
);

-- 3. Honour the archive retention timer ------------------------------------------------------
--
-- This does NOT invent a retention policy. public.{cells,gateways,devices}.auto_delete_at
-- (migration 0001) is set per row by the Archive dialog when the user picks a retention
-- period, and the UI already tells them it will happen -- ArchivesTab renders
-- "Purges: <date>" and CellsTab renders "Retention purge timer active (auto-purges on
-- <date>)". Nothing has ever implemented it. This job is what makes that promise true.
--
-- auto_delete_at IS NULL means PERMANENT RETENTION -- the UI says so explicitly
-- ("Permanent retention active (no auto-purge)") -- so the NOT NULL test is load-bearing.
-- Purging on archived_at age instead would silently destroy rows the user deliberately
-- marked to keep forever.
--
-- These DELETEs do fire log_digital_thread_event(), by design: a permanent deletion is
-- exactly the kind of event the audit trail should record. That is the opposite of the
-- staleness-sweep case, where the writes carried no information.
--
-- Order matters. devices reference gateways which reference cells, so children go first;
-- a parent whose child is not yet due simply fails to delete this run and is retried the
-- next, rather than cascading a child out from under its own timer.
SELECT public.ensure_cron_job(
  'purge_expired_archives',
  '30 3 * * *',
  $job$
    DELETE FROM public.devices
      WHERE is_archived AND auto_delete_at IS NOT NULL AND auto_delete_at <= NOW();
    DELETE FROM public.gateways
      WHERE is_archived AND auto_delete_at IS NOT NULL AND auto_delete_at <= NOW();
    DELETE FROM public.cells
      WHERE is_archived AND auto_delete_at IS NOT NULL AND auto_delete_at <= NOW();
  $job$
);

-- ---------------------------------------------------------------------------------------------
-- Vault: the Node-RED admin token
-- ---------------------------------------------------------------------------------------------
-- Vault holds only secrets read FROM SQL -- in practice just this one, which
-- public.dispatch_device_quarantine_webhook() attaches to its outbound pg_net request.
-- MQTT_PASSWORD / DB_PASSWORD / POSTGRES_PASSWORD stay in .env: mosquitto-init and supabase-db
-- need them before the database accepts connections, so duplicating them here would create a
-- second source of truth.
\if :{?nodered_admin_token}
\else
\set nodered_admin_token ''
\endif

-- psql does NOT substitute :variables inside dollar-quoted strings, so the token cannot be
-- referenced directly from the DO block below -- it would be read as literal text and fail to
-- parse. Migration 0010 gets away with :'ts_host' because those appear in plain SQL.
-- Stash it in a session GUC out here, where substitution does happen, and read it back inside.
-- Session-local (is_local = false but never committed to a role), so it does not persist.
SELECT set_config('factoryplus.nodered_admin_token', :'nodered_admin_token', false);

DO $$
DECLARE
  v_token TEXT := current_setting('factoryplus.nodered_admin_token', true);
  v_id    UUID;
BEGIN
  -- An absent token is the default stack's normal state: Node-RED runs without adminAuth, so
  -- there is nothing to authenticate with. Seeding an empty secret would be indistinguishable
  -- from a real one at dispatch time, so record nothing and let the webhook go unauthenticated.
  IF v_token IS NULL OR v_token = '' THEN
    RAISE NOTICE 'vault: nodered_admin_token not supplied; leaving it unset';
    RETURN;
  END IF;

  SELECT id INTO v_id FROM vault.secrets WHERE name = 'nodered_admin_token';

  IF v_id IS NULL THEN
    PERFORM vault.create_secret(
      v_token,
      'nodered_admin_token',
      'Bearer token for the Node-RED admin API. Read by '
      'public.dispatch_device_quarantine_webhook() (migration 0027).'
    );
  ELSE
    -- update_secret rather than create: supabase-db-init replays every migration on every
    -- stack start, and create_secret would fail the UNIQUE on name the second time.
    PERFORM vault.update_secret(v_id, v_token);
  END IF;
END $$;

-- vault.decrypted_secrets is a view that decrypts on read. It must never become reachable
-- through PostgREST -- `vault` is not in PGRST_DB_SCHEMAS today, but these REVOKEs mean that
-- adding it later still would not expose plaintext to a logged-in user.
REVOKE ALL ON vault.decrypted_secrets FROM anon, authenticated;
REVOKE ALL ON vault.secrets           FROM anon, authenticated;

-- Do not leave the plaintext sitting in the session's settings after the migration.
SELECT set_config('factoryplus.nodered_admin_token', '', false);

-- ---------------------------------------------------------------------------------------------
-- Grafana OAuth client registration
-- ---------------------------------------------------------------------------------------------
-- Grafana is an OAuth client of GoTrue's OAuth 2.1 server. `client_secret_hash` is
-- base64url(sha256(secret)) unpadded -- NOT bcrypt -- and `token_endpoint_auth_method` must stay
-- `client_secret_basic` to match `auth_style = InHeader` in grafana.ini.
\if :{?grafana_oauth_client_secret}
\else
\set grafana_oauth_client_secret ''
\endif

-- THE PUBLIC ORIGIN GRAFANA IS REACHED ON, and it MUST be a variable rather than a literal.
--
-- This row used to hardcode `http://localhost:3002`, and because the upsert below is DO UPDATE
-- (correctly -- a rotated secret has to reach an existing database), supabase-db-init REWROTE it
-- back to localhost on every single boot. Correcting the row by hand survived until the next
-- restart and then silently reverted, with no event marking the change: the worst shape this
-- failure can take. Any deployment not reached at localhost:3002 -- a Compose stack on a remote
-- host, and every Kubernetes deployment, where subdomain ingress means the origin is never
-- localhost -- had Grafana SSO fail with `invalid redirect_uri` and no way to fix it durably.
--
-- Same treatment migration 0003 gives Node-RED's client, with one deliberate difference: 0003 is
-- passed the WHOLE callback URL, because docker-compose builds it there from NODERED_PUBLIC_URL.
-- Grafana needs BOTH `client_uri` (the origin) and `redirect_uris` (origin + a fixed path), so the
-- ORIGIN is what is passed and the callback is derived here. /login/generic_oauth is Grafana's own
-- fixed route, exactly as /auth/strategy/callback is Node-RED's -- only the origin is
-- deployment-specific, and it is the address the BROWSER reaches Grafana on, never the
-- compose-internal or in-cluster one.
--
-- GF_SERVER_ROOT_URL is built from the same GRAFANA_PUBLIC_URL in docker-compose.yml, so this row
-- and Grafana's own idea of where it lives cannot drift apart.
\if :{?grafana_public_url}
\else
\set grafana_public_url ''
\endif

-- psql does not substitute :variables inside dollar-quoted blocks (see migration 0026), so
-- both values are staged through session GUCs where substitution does happen.
SELECT set_config('factoryplus.grafana_oauth_client_secret', :'grafana_oauth_client_secret', false);
SELECT set_config('factoryplus.grafana_public_url',          :'grafana_public_url',          false);

DO $$
DECLARE
  -- Pinned, not generated: grafana.ini carries this as client_id, and a fresh UUID on every
  -- stack rebuild would silently break the integration. Same reasoning as the pinned gateway
  -- UUID in migration 0009.
  v_client_id CONSTANT UUID := 'c0ffee00-0000-4000-8000-000000000001';
  v_secret    TEXT := current_setting('factoryplus.grafana_oauth_client_secret', true);
  -- The trailing slash is trimmed. GRAFANA_PUBLIC_URL is documented without one, but a value
  -- copied from a browser address bar carries it, and `http://host//login/generic_oauth` is not
  -- the string GoTrue compares against -- it fails as `invalid redirect_uri`, which reads as a
  -- Grafana fault rather than as a stray character in .env.
  v_base      TEXT := rtrim(
                        COALESCE(
                          NULLIF(current_setting('factoryplus.grafana_public_url', true), ''),
                          'http://localhost:3002'),
                        '/');
  v_hash      TEXT;
BEGIN
  IF v_secret IS NULL OR v_secret = '' THEN
    RAISE WARNING 'grafana oauth client secret not supplied; skipping client registration. '
                  'Set GRAFANA_OAUTH_CLIENT_SECRET in .env and re-run.';
    RETURN;
  END IF;

  v_hash := rtrim(translate(encode(extensions.digest(v_secret, 'sha256'), 'base64'), '+/', '-_'), '=');

  INSERT INTO auth.oauth_clients (
    id, client_secret_hash, registration_type, redirect_uris, grant_types,
    client_name, client_uri, client_type, token_endpoint_auth_method
  ) VALUES (
    v_client_id,
    v_hash,
    'manual',                                        -- seeded, not self-registered
    v_base || '/login/generic_oauth',                -- Grafana's fixed generic_oauth callback
    'authorization_code,refresh_token',
    'Factory+ Grafana',
    v_base,
    'confidential',
    'client_secret_basic'
  )
  ON CONFLICT (id) DO UPDATE SET
    client_secret_hash         = EXCLUDED.client_secret_hash,
    redirect_uris              = EXCLUDED.redirect_uris,
    grant_types                = EXCLUDED.grant_types,
    client_name                = EXCLUDED.client_name,
    client_uri                 = EXCLUDED.client_uri,
    token_endpoint_auth_method = EXCLUDED.token_endpoint_auth_method,
    deleted_at                 = NULL,
    updated_at                 = NOW();
  -- DO UPDATE, not DO NOTHING: supabase-db-init replays every migration on every stack start,
  -- so a rotated GRAFANA_OAUTH_CLIENT_SECRET in .env has to take effect on the next boot.
END $$;

SELECT set_config('factoryplus.grafana_oauth_client_secret', '', false);

NOTIFY pgrst, 'reload schema';
