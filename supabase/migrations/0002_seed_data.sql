-- =============================================================================================
-- Migration: 0002_seed_data.sql
-- ACS-Cymru Asset Tracking Platform -- consolidated baseline data (public beta)
-- =============================================================================================
--
-- Every row the platform needs to come up usable: pure DML, the counterpart of
-- `0001_baseline_schema.sql`, which must have run.
--
-- IDEMPOTENT, because supabase-db-init replays every /migrations/*.sql on every boot. Every
-- statement carries an ON CONFLICT clause, and the clauses differ per table on purpose:
--   * Reference vocabularies use DO UPDATE, because they are maintained by editing this file.
--     MTConnect re-stamps only `category`: `semantic_id` is a hand-corrected assertion.
--   * Everything operator-facing uses DO NOTHING. A DO UPDATE on `devices` fires
--     log_digital_thread_event() whether or not a value differs, appending an audit row on
--     every boot forever.
--
-- Not here: `digital_thread` (written by trigger as a side effect of the inserts below);
-- `user_roles` and the demo accounts (GoTrue's, seeded by `supabase/seed.sql`); `cells`
-- (Unassigned and Site-Wide are derived lanes, never rows); the `storage.buckets` row (created
-- by `scripts/storage-init.mjs`).
--
-- PSQL VARIABLES. `-v nodered_admin_token` and `-v grafana_oauth_client_secret`, defaulted at
-- the point of use, with an absent value treated as normal rather than as an error.
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
-- `link:manage`, renamed from `document:manage` by 0049. THE ID DOES NOT MOVE:
-- role_permissions references it, and PERMISSION_UUIDS.LINK_MANAGE in the frontend is this same
-- literal. Only the name string changed. Seeded under the new name here as well as updated there,
-- because ON CONFLICT (id) DO NOTHING below means this INSERT cannot correct an existing row.
INSERT INTO public.permissions VALUES ('a012b345-6789-4c1d-8706-933e08544e38', 'link:manage', 'Add, edit, and remove external links attached to assets')
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
-- RBAC role/permission grants  (26 rows)
-- -------------------------------------------------------------------------------------------
-- 13 Administrator, 10 Shopfloor_Manager, 2 Operator, 1 Auditor. `authz:manage`,
-- `schema:manage` and `gitops:manage` belong to Administrator alone; 0069 withdraws them from
-- databases seeded before the split, and its DELETE matches no rows on a new stack.
--
-- Mirrored by DEFAULT_ROLE_PERMISSIONS_MAP in frontend/src/hooks/usePermissions.js and
-- compared by scripts/check-mirror-drift.mjs.

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
-- Not granted to role 2: `authz:manage` (...e39), `schema:manage` (...e40) and `gitops:manage`
-- (...e41) are Administrator's. Adding one back here does not restore it: 0069 replays after
-- this file and deletes exactly these three from role 2.
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
-- A registry of approved group spellings, not of membership; membership is derived from the
-- first segment of a metric's name. DO NOTHING: `enforce_metric_group_spelling()` treats
-- whatever is registered as canonical.

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

-- Groups for the companion specifications below. Registered here rather than left to appear on
-- first use, because enforce_metric_group_spelling() fixes whatever casing arrives first.
-- >>> BEGIN GENERATED opcua_metric_groups_companion_extensions -- 9 rows, sha256:47d492f9587d304b
-- GENERATED by scripts/generate-opcua-vocabulary.mjs. CI verifies the digest above.
INSERT INTO public.metric_groups (id, name, description, standard) VALUES ('851692e8-72c2-48fe-b488-b907363c922a', 'Channel', 'OPC UA Machine Tools (OPC 40501) channel monitoring -- overrides, channel state and the program modifiers', 'OPC UA')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups (id, name, description, standard) VALUES ('d6b8f5fa-ad3f-41fa-9c91-033f6fab5afc', 'Energy', 'OPC UA Machinery Energy Management (OPC 40001-4) utility flow measurements -- compressed air, water, gas and the like', 'OPC UA')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups (id, name, description, standard) VALUES ('d171cbf6-ec1c-442d-8b3a-1820fa241b59', 'Feedstock', 'OPC UA Additive Manufacturing (OPC 40540) feedstock -- the powder, filament or resin a printer consumes', 'OPC UA')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups (id, name, description, standard) VALUES ('1a8f6f60-cea0-4361-9829-80ab733a2247', 'MachineOperation', 'OPC UA Machine Tools (OPC 40501) machine-level operation mode and power-on time', 'OPC UA')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups (id, name, description, standard) VALUES ('0d760608-9d01-4327-b152-9f7d4007c2e5', 'PackML', 'OPC UA for PackML (OPC 30050) unit status, mode and the state/mode time accumulators', 'OPC UA')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups (id, name, description, standard) VALUES ('ff4c9659-71cf-4556-9fea-313ec996266f', 'ProcessValue', 'OPC UA Additive Manufacturing (OPC 40540) in-process sensor readings', 'OPC UA')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups (id, name, description, standard) VALUES ('651ade9b-95ae-42d5-ae2e-22b3139b4afa', 'Production', 'OPC UA Machine Tools (OPC 40501) production counters, part quality and process irregularities', 'OPC UA')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups (id, name, description, standard) VALUES ('e7effc84-110a-4be8-a41e-07374bc07273', 'Spindle', 'OPC UA Machine Tools (OPC 40501) spindle monitoring', 'OPC UA')
ON CONFLICT DO NOTHING;
INSERT INTO public.metric_groups (id, name, description, standard) VALUES ('d705dd72-ce6d-4cd2-9ffb-a6568c60793b', 'Tool', 'OPC UA Machine Tools (OPC 40501) tool management state', 'OPC UA')
ON CONFLICT DO NOTHING;
-- <<< END GENERATED opcua_metric_groups_companion_extensions

-- -------------------------------------------------------------------------------------------
-- Metric catalog  (15 rows)
-- -------------------------------------------------------------------------------------------
-- `name` is immutable (`enforce_metric_catalog_immutability()`), so DO UPDATE would be rejected
-- by the trigger. Changing a metric is deprecate-and-supersede. `OEE/PERFORMANCE` is deprecated
-- in favour of `OEE/EFFECTIVENESS` (ISO 22400-2's name); both carry the same semantic_id, which
-- is why that index is not unique.

INSERT INTO public.metric_catalog VALUES ('c0000001-0000-4000-8000-000000000007', 'OEE/AVAILABILITY', 10, 'ISO 22400 availability ratio -- NOT MTConnect AVAILABILITY, which means "device connected"', false, NULL, '2026-08-02 05:44:36.861147+00', DEFAULT, NULL, 'PERCENT', NULL, 'ISO 22400', 'https://acs-cymru.local/semantics/iso22400/AVAILABILITY', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('c0000001-0000-4000-8000-000000000009', 'OEE/QUALITY', 10, 'ISO 22400 quality ratio', false, NULL, '2026-08-02 05:44:36.861147+00', DEFAULT, NULL, 'PERCENT', NULL, 'ISO 22400', 'https://acs-cymru.local/semantics/iso22400/QUALITY', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('c0000001-0000-4000-8000-000000000010', 'OEE/EFFECTIVENESS', 10, 'ISO 22400 effectiveness ratio (E) -- the OEE factor commonly called Performance. Supersedes OEE/PERFORMANCE.', false, NULL, '2026-08-02 05:44:46.630269+00', DEFAULT, 'SAMPLE', 'PERCENT', NULL, 'ISO 22400', 'https://acs-cymru.local/semantics/iso22400/EFFECTIVENESS', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('c0000001-0000-4000-8000-000000000008', 'OEE/PERFORMANCE', 10, 'ISO 22400 performance ratio', true, 'c0000001-0000-4000-8000-000000000010', '2026-08-02 05:44:36.861147+00', DEFAULT, NULL, 'PERCENT', NULL, 'ISO 22400', 'https://acs-cymru.local/semantics/iso22400/EFFECTIVENESS', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('c0000001-0000-4000-8000-000000000001', 'Systems/TEMPERATURE', 10, 'Machine system temperature', false, NULL, '2026-08-02 05:44:36.861147+00', DEFAULT, 'SAMPLE', 'CELSIUS', NULL, 'MTConnect', 'https://acs-cymru.local/semantics/mtconnect/v2.0/Systems/TEMPERATURE', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('c0000001-0000-4000-8000-000000000002', 'Axes/DISPLACEMENT', 10, 'Axis displacement amplitude (was: vibration)', false, NULL, '2026-08-02 05:44:36.861147+00', DEFAULT, 'SAMPLE', 'MILLIMETER', NULL, 'MTConnect', 'https://acs-cymru.local/semantics/mtconnect/v2.0/Axes/DISPLACEMENT', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('c0000001-0000-4000-8000-000000000003', 'Controller/EXECUTION', 12, 'Controller execution state: READY / ACTIVE / INTERRUPTED / FEED_HOLD / STOPPED', false, NULL, '2026-08-02 05:44:36.861147+00', DEFAULT, 'EVENT', NULL, NULL, 'MTConnect', 'https://acs-cymru.local/semantics/mtconnect/v2.0/Controller/EXECUTION', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('c0000001-0000-4000-8000-000000000004', 'Controller/EMERGENCY_STOP', 12, 'Emergency stop circuit: ARMED (healthy) or TRIGGERED', false, NULL, '2026-08-02 05:44:36.861147+00', DEFAULT, 'EVENT', NULL, NULL, 'MTConnect', 'https://acs-cymru.local/semantics/mtconnect/v2.0/Controller/EMERGENCY_STOP', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('c0000001-0000-4000-8000-000000000005', 'Controller/FIRMWARE', 12, 'Controller firmware version', false, NULL, '2026-08-02 05:44:36.861147+00', DEFAULT, 'EVENT', NULL, NULL, 'MTConnect', 'https://acs-cymru.local/semantics/mtconnect/v2.0/Controller/FIRMWARE', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('c0000001-0000-4000-8000-000000000006', 'SERIAL_NUMBER', 12, 'Manufacturer serial number', false, NULL, '2026-08-02 05:44:36.861147+00', DEFAULT, 'EVENT', NULL, NULL, 'MTConnect', 'https://acs-cymru.local/semantics/mtconnect/v2.0/SERIAL_NUMBER', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('c0000001-0000-4000-8000-000000000011', 'Axes/C/ANGLE', 10, 'Angular position of the C axis (MTConnect ANGLE on the Axes component)', false, NULL, '2026-08-02 05:44:47.393993+00', DEFAULT, 'SAMPLE', 'DEGREE', NULL, 'MTConnect', 'https://acs-cymru.local/semantics/mtconnect/v2.0/Axes/C/ANGLE', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('c0000001-0000-4000-8000-000000000012', 'Machine/OperatingMode', 12, 'Machine operating mode -- Processing, Setup, Maintenance or Normal. OPC 40001 calls this browse name MachineryOperationMode; the semantic id binds this metric to that concept.', false, NULL, '2026-08-02 05:44:47.393993+00', DEFAULT, 'EVENT', NULL, NULL, 'OPC UA', 'http://opcfoundation.org/UA/Machinery/MachineryOperationMode', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('c0000001-0000-4000-8000-000000000013', 'MotionDevice/OverridePercent', 10, 'Operator speed override applied to programmed motion. OPC 40010 calls this browse name SpeedOverride; the semantic id binds this metric to that concept.', false, NULL, '2026-08-02 05:44:47.393993+00', DEFAULT, 'SAMPLE', 'PERCENT', NULL, 'OPC UA', 'http://opcfoundation.org/UA/Robotics/SpeedOverride', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('e5f5b550-25f7-4c28-9cd4-36eb9c2224af', 'safety_interlock', 11, 'Safety interlock present/enabled (local extension)', false, NULL, '2026-08-02 05:44:32.25444+00', DEFAULT, 'EVENT', NULL, NULL, NULL, 'https://acs-cymru.local/semantics/local/safety_interlock', 'IRI')
ON CONFLICT (name) DO NOTHING;
INSERT INTO public.metric_catalog VALUES ('a469cb73-0d73-46b3-928e-7ecfd7fc43f0', 'max_temp_threshold', 10, 'Configured maximum temperature threshold (local extension)', false, NULL, '2026-08-02 05:44:32.25444+00', DEFAULT, 'SAMPLE', 'CELSIUS', NULL, NULL, 'https://acs-cymru.local/semantics/local/max_temp_threshold', 'IRI')
ON CONFLICT (name) DO NOTHING;

-- -------------------------------------------------------------------------------------------
-- MTConnect vocabulary (598 rows)  (598 rows)
-- -------------------------------------------------------------------------------------------
-- Reference data, not a catalog: `ANGLE` is a type, `Axes/C/ANGLE` is a metric. Only
-- `category` is re-stamped; `semantic_id` is a hand-corrected assertion. Generated by
-- scripts/generate-mtconnect-vocabulary.mjs: bump SCHEMA_VERSION there and regenerate.

-- >>> BEGIN GENERATED mtconnect_vocabulary -- MTConnect 2.8, 598 rows, sha256:cd9b10a6858769c5
-- GENERATED. Do not edit these rows by hand: bump SCHEMA_VERSION in
-- scripts/generate-mtconnect-vocabulary.mjs and re-run it. CI verifies the digest above.
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ACCELERATION', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ACCELERATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ACCUMULATED_TIME', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ACCUMULATED_TIME')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ACTIVATION_COUNT', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ACTIVATION_COUNT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ACTIVE_AXES', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ACTIVE_AXES')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ACTIVE_POWER_SOURCE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ACTIVE_POWER_SOURCE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ACTUATOR', 'CONDITION', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ACTUATOR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ACTUATOR_STATE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ACTUATOR_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ADAPTER_SOFTWARE_VERSION', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ADAPTER_SOFTWARE_VERSION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ADAPTER_URI', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ADAPTER_URI')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ALARM', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ALARM')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ALARM_LIMIT', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ALARM_LIMIT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ALARM_LIMITS', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ALARM_LIMITS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'AMPERAGE', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/AMPERAGE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'AMPERAGE_AC', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/AMPERAGE_AC')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'AMPERAGE_DC', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/AMPERAGE_DC')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ANGLE', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ANGLE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ANGULAR_ACCELERATION', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ANGULAR_ACCELERATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ANGULAR_DECELERATION', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ANGULAR_DECELERATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ANGULAR_VELOCITY', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ANGULAR_VELOCITY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'APPLICATION', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/APPLICATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ASSET_ADDED', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ASSET_ADDED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ASSET_CHANGED', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ASSET_CHANGED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ASSET_COUNT', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ASSET_COUNT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ASSET_REMOVED', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ASSET_REMOVED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ASSET_UPDATE_RATE', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ASSET_UPDATE_RATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ASSOCIATED_ASSET_ID', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ASSOCIATED_ASSET_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'AVAILABILITY', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/AVAILABILITY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'AXIS_COUPLING', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/AXIS_COUPLING')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'AXIS_FEEDRATE', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/AXIS_FEEDRATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'AXIS_FEEDRATE_OVERRIDE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/AXIS_FEEDRATE_OVERRIDE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'AXIS_INTERLOCK', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/AXIS_INTERLOCK')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'AXIS_STATE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/AXIS_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'BATTERY_CAPACITY', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/BATTERY_CAPACITY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'BATTERY_CHARGE', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/BATTERY_CHARGE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'BATTERY_STATE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/BATTERY_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'BINDING_STATE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/BINDING_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'BLOCK', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/BLOCK')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'BLOCK_COUNT', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/BLOCK_COUNT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CAPACITY_FLUID', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/CAPACITY_FLUID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CAPACITY_SPATIAL', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/CAPACITY_SPATIAL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CHARACTERISTIC_PERSISTENT_ID', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/CHARACTERISTIC_PERSISTENT_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CHARACTERISTIC_STATUS', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/CHARACTERISTIC_STATUS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CHARGE_RATE', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/CHARGE_RATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CHUCK_INTERLOCK', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/CHUCK_INTERLOCK')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CHUCK_STATE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/CHUCK_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CLOCK_TIME', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/CLOCK_TIME')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CODE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/CODE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'COMMUNICATIONS', 'CONDITION', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/COMMUNICATIONS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'COMPONENT_DATA', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/COMPONENT_DATA')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'COMPOSITION_STATE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/COMPOSITION_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CONCENTRATION', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/CONCENTRATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CONDUCTIVITY', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/CONDUCTIVITY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CONNECTION_STATUS', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/CONNECTION_STATUS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CONTROL_LIMIT', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/CONTROL_LIMIT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CONTROL_LIMITS', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/CONTROL_LIMITS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CONTROLLER_MODE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/CONTROLLER_MODE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CONTROLLER_MODE_OVERRIDE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/CONTROLLER_MODE_OVERRIDE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'COUPLED_AXES', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/COUPLED_AXES')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CUTTING_SPEED', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/CUTTING_SPEED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'CYCLE_COUNT', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/CYCLE_COUNT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DATA_RANGE', 'CONDITION', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/DATA_RANGE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DATE_CODE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/DATE_CODE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DEACTIVATION_COUNT', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/DEACTIVATION_COUNT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DECELERATION', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/DECELERATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DENSITY', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/DENSITY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DEPOSITION_ACCELERATION_VOLUMETRIC', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/DEPOSITION_ACCELERATION_VOLUMETRIC')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DEPOSITION_DENSITY', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/DEPOSITION_DENSITY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DEPOSITION_MASS', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/DEPOSITION_MASS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DEPOSITION_RATE_VOLUMETRIC', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/DEPOSITION_RATE_VOLUMETRIC')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DEPOSITION_VOLUME', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/DEPOSITION_VOLUME')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DEPTH', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/DEPTH')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DEVICE_ADDED', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/DEVICE_ADDED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DEVICE_CHANGED', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/DEVICE_CHANGED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DEVICE_REMOVED', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/DEVICE_REMOVED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DEVICE_UUID', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/DEVICE_UUID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DEW_POINT', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/DEW_POINT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DIAMETER', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/DIAMETER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DIRECTION', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/DIRECTION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DISCHARGE_RATE', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/DISCHARGE_RATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DISPLACEMENT', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/DISPLACEMENT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DISPLACEMENT_ANGULAR', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/DISPLACEMENT_ANGULAR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DISPLACEMENT_LINEAR', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/DISPLACEMENT_LINEAR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'DOOR_STATE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/DOOR_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ELECTRICAL_ENERGY', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ELECTRICAL_ENERGY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ELEVATION', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ELEVATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'EMERGENCY_STOP', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/EMERGENCY_STOP')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'END_OF_BAR', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/END_OF_BAR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'EQUIPMENT_MODE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/EQUIPMENT_MODE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'EQUIPMENT_TIMER', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/EQUIPMENT_TIMER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'EXECUTION', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/EXECUTION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'FEATURE_MEASUREMENT', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/FEATURE_MEASUREMENT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'FEATURE_PERSISTENT_ID', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/FEATURE_PERSISTENT_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'FILL_HEIGHT', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/FILL_HEIGHT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'FILL_LEVEL', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/FILL_LEVEL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'FIRMWARE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/FIRMWARE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'FIXTURE_ASSET_ID', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/FIXTURE_ASSET_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'FIXTURE_ID', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/FIXTURE_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'FLOW', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/FLOW')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'FOLLOWING_ERROR', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/FOLLOWING_ERROR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'FOLLOWING_ERROR_ANGULAR', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/FOLLOWING_ERROR_ANGULAR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'FOLLOWING_ERROR_LINEAR', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/FOLLOWING_ERROR_LINEAR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'FREQUENCY', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/FREQUENCY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'FUNCTIONAL_MODE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/FUNCTIONAL_MODE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'GLOBAL_POSITION', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/GLOBAL_POSITION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'GRAVITATIONAL_ACCELERATION', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/GRAVITATIONAL_ACCELERATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'GRAVITATIONAL_FORCE', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/GRAVITATIONAL_FORCE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'HARDNESS', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/HARDNESS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'HARDWARE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/HARDWARE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'HOST_NAME', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/HOST_NAME')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'HUMIDITY_ABSOLUTE', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/HUMIDITY_ABSOLUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'HUMIDITY_RELATIVE', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/HUMIDITY_RELATIVE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'HUMIDITY_SPECIFIC', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/HUMIDITY_SPECIFIC')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LEAK_DETECT', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/LEAK_DETECT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LENGTH', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/LENGTH')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LEVEL', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/LEVEL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LIBRARY', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/LIBRARY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LINE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/LINE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LINE_LABEL', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/LINE_LABEL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LINE_NUMBER', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/LINE_NUMBER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LINEAR_FORCE', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/LINEAR_FORCE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LOAD', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/LOAD')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LOAD_COUNT', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/LOAD_COUNT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LOCATION_ADDRESS', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/LOCATION_ADDRESS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LOCATION_NARRATIVE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/LOCATION_NARRATIVE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LOCATION_SPATIAL_GEOGRAPHIC', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/LOCATION_SPATIAL_GEOGRAPHIC')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LOCK_STATE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/LOCK_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'LOGIC_PROGRAM', 'CONDITION', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/LOGIC_PROGRAM')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'MAINTENANCE_LIST', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/MAINTENANCE_LIST')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'MASS', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/MASS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'MATERIAL', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/MATERIAL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'MATERIAL_LAYER', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/MATERIAL_LAYER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'MEASUREMENT_TYPE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/MEASUREMENT_TYPE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'MEASUREMENT_UNITS', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/MEASUREMENT_UNITS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'MEASUREMENT_VALUE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/MEASUREMENT_VALUE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'MESSAGE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/MESSAGE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'MOTION_PROGRAM', 'CONDITION', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/MOTION_PROGRAM')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'MTCONNECT_VERSION', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/MTCONNECT_VERSION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'NETWORK', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/NETWORK')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'NETWORK_PORT', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/NETWORK_PORT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'OBSERVATION_UPDATE_RATE', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/OBSERVATION_UPDATE_RATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'OPENNESS', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/OPENNESS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'OPERATING_MODE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/OPERATING_MODE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'OPERATING_SYSTEM', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/OPERATING_SYSTEM')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'OPERATOR_ID', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/OPERATOR_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ORIENTATION', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ORIENTATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PALLET_ID', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PALLET_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PART_COUNT', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PART_COUNT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PART_COUNT_TYPE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PART_COUNT_TYPE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PART_DETECT', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PART_DETECT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PART_GROUP_ID', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PART_GROUP_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PART_ID', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PART_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PART_INDEX', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PART_INDEX')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PART_KIND_ID', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PART_KIND_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PART_NUMBER', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PART_NUMBER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PART_PROCESSING_STATE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PART_PROCESSING_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PART_STATUS', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PART_STATUS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PART_UNIQUE_ID', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PART_UNIQUE_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PARTICLE_COUNT', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PARTICLE_COUNT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PARTICLE_SIZE', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PARTICLE_SIZE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PATH_FEEDRATE', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PATH_FEEDRATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PATH_FEEDRATE_OVERRIDE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PATH_FEEDRATE_OVERRIDE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PATH_FEEDRATE_PER_REVOLUTION', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PATH_FEEDRATE_PER_REVOLUTION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PATH_MODE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PATH_MODE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PATH_POSITION', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PATH_POSITION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PH', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PH')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'POSITION', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/POSITION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'POSITION_CARTESIAN', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/POSITION_CARTESIAN')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'POWER_FACTOR', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/POWER_FACTOR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'POWER_STATE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/POWER_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'POWER_STATUS', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/POWER_STATUS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PRESSURE', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PRESSURE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PRESSURE_ABSOLUTE', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PRESSURE_ABSOLUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PRESSURIZATION_RATE', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PRESSURIZATION_RATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROCESS_AGGREGATE_ID', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PROCESS_AGGREGATE_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROCESS_KIND_ID', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PROCESS_KIND_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROCESS_OCCURRENCE_ID', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PROCESS_OCCURRENCE_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROCESS_STATE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PROCESS_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROCESS_TIME', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PROCESS_TIME')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROCESS_TIMER', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PROCESS_TIMER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROGRAM', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PROGRAM')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROGRAM_COMMENT', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PROGRAM_COMMENT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROGRAM_EDIT', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PROGRAM_EDIT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROGRAM_EDIT_NAME', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PROGRAM_EDIT_NAME')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROGRAM_HEADER', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PROGRAM_HEADER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROGRAM_LOCATION', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PROGRAM_LOCATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROGRAM_LOCATION_TYPE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PROGRAM_LOCATION_TYPE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'PROGRAM_NEST_LEVEL', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/PROGRAM_NEST_LEVEL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'RESISTANCE', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/RESISTANCE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'RESISTIVITY', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/RESISTIVITY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ROTARY_MODE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ROTARY_MODE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ROTARY_VELOCITY', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ROTARY_VELOCITY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ROTARY_VELOCITY_OVERRIDE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ROTARY_VELOCITY_OVERRIDE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'ROTATION', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/ROTATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SENSOR_ATTACHMENT', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/SENSOR_ATTACHMENT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SENSOR_STATE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/SENSOR_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SERIAL_NUMBER', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/SERIAL_NUMBER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SETTLING_ERROR', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/SETTLING_ERROR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SETTLING_ERROR_ANGULAR', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/SETTLING_ERROR_ANGULAR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SETTLING_ERROR_LINEAR', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/SETTLING_ERROR_LINEAR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SOUND_LEVEL', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/SOUND_LEVEL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SPECIFICATION_LIMIT', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/SPECIFICATION_LIMIT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SPECIFICATION_LIMITS', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/SPECIFICATION_LIMITS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SPINDLE_INTERLOCK', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/SPINDLE_INTERLOCK')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SPINDLE_SPEED', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/SPINDLE_SPEED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'STRAIN', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/STRAIN')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SWING_ANGLE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/SWING_ANGLE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SWING_DIAMETER', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/SWING_DIAMETER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SWING_RADIUS', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/SWING_RADIUS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'SYSTEM', 'CONDITION', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/SYSTEM')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TASK_ASSET_ID', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/TASK_ASSET_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TEMPERATURE', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/TEMPERATURE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TENSION', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/TENSION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'THICKNESS', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/THICKNESS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TILT', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/TILT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TOOL_ASSET_ID', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/TOOL_ASSET_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TOOL_CUTTING_ITEM', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/TOOL_CUTTING_ITEM')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TOOL_GROUP', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/TOOL_GROUP')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TOOL_ID', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/TOOL_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TOOL_NUMBER', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/TOOL_NUMBER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TOOL_OFFSET', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/TOOL_OFFSET')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TOOL_OFFSETS', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/TOOL_OFFSETS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TORQUE', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/TORQUE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TRANSFER_COUNT', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/TRANSFER_COUNT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'TRANSLATION', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/TRANSLATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'UNCERTAINTY', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/UNCERTAINTY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'UNCERTAINTY_TYPE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/UNCERTAINTY_TYPE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'UNLOAD_COUNT', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/UNLOAD_COUNT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'USER', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/USER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'VALVE_STATE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/VALVE_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'VARIABLE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/VARIABLE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'VELOCITY', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/VELOCITY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'VISCOSITY', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/VISCOSITY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'VOLT_AMPERE', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/VOLT_AMPERE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'VOLT_AMPERE_REACTIVE', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/VOLT_AMPERE_REACTIVE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'VOLTAGE', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/VOLTAGE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'VOLTAGE_AC', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/VOLTAGE_AC')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'VOLTAGE_DC', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/VOLTAGE_DC')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'VOLUME_FLUID', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/VOLUME_FLUID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'VOLUME_SPATIAL', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/VOLUME_SPATIAL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'WAIT_STATE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/WAIT_STATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'WATER_HARDNESS', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/WATER_HARDNESS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'WATTAGE', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/WATTAGE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'WIRE', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/WIRE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'WORK_OFFSET', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/WORK_OFFSET')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'WORK_OFFSETS', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/WORK_OFFSETS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'WORKHOLDING_ID', 'EVENT', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/WORKHOLDING_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'X_DIMENSION', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/X_DIMENSION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'Y_DIMENSION', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/Y_DIMENSION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('DATA_ITEM_TYPE', 'Z_DIMENSION', 'SAMPLE', 'https://acs-cymru.local/semantics/mtconnect/v2.0/DataItemType/Z_DIMENSION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ABORTED', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/ABORTED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ABSOLUTE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/ABSOLUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ACTION', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/ACTION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ACTIVE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/ACTIVE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ACTIVITY', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/ACTIVITY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ACTUAL', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/ACTUAL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ALL', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/ALL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ALTERNATING', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/ALTERNATING')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'AUXILIARY', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/AUXILIARY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'A_SCALE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/A_SCALE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'BAD', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/BAD')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'BATCH', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/BATCH')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'BINARY', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/BINARY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'BOOLEAN', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/BOOLEAN')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'BRINELL', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/BRINELL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'B_SCALE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/B_SCALE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'COMMANDED', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/COMMANDED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'COMPLETE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/COMPLETE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'CONSUMED', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/CONSUMED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'CONTROL', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/CONTROL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'CUT', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/CUT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'C_SCALE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/C_SCALE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'DELAY', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/DELAY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'DETECT', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/DETECT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'DIRECT', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/DIRECT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'DRY_RUN', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/DRY_RUN')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'D_SCALE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/D_SCALE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ELECTRODE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/ELECTRODE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ENDED', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/ENDED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ENUMERATED', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/ENUMERATED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'EXPIRATION', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/EXPIRATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'FAILED', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/FAILED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'FILLER', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/FILLER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'FIRST_USE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/FIRST_USE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'GAS', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/GAS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'GATEWAY', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/GATEWAY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'GOOD', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/GOOD')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'GROUND_LEVEL', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/GROUND_LEVEL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'HEAT_TREAT', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/HEAT_TREAT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'INCREMENTAL', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/INCREMENTAL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'INSTALL_DATE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/INSTALL_DATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'IPV4_ADDRESS', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/IPV4_ADDRESS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'IPV6_ADDRESS', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/IPV6_ADDRESS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ISO_STEP_EXECUTABLE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/ISO_STEP_EXECUTABLE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'JOG', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/JOG')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'LATERAL', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/LATERAL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'LAYER', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/LAYER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'LEEB', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/LEEB')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'LENGTH', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/LENGTH')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'LICENSE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/LICENSE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'LINE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/LINE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'LINEAR', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/LINEAR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'LIQUID', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/LIQUID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'LOADED', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/LOADED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'LOT', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/LOT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MACHINE_AXIS_LOCK', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/MACHINE_AXIS_LOCK')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MAC_ADDRESS', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/MAC_ADDRESS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MAIN', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/MAIN')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MAINTENANCE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/MAINTENANCE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MANUAL_UNCLAMP', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/MANUAL_UNCLAMP')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MANUFACTURE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/MANUFACTURE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MANUFACTURER', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/MANUFACTURER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MAXIMUM', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/MAXIMUM')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MEAN_SEA_LEVEL', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/MEAN_SEA_LEVEL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MEASURED', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/MEASURED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MINIMUM', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/MINIMUM')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MODEL', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/MODEL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MOHS', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/MOHS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'MOTION', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/MOTION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'NO_SCALE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/NO_SCALE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'OPERATING', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/OPERATING')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'OPERATION', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/OPERATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'OPERATOR', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/OPERATOR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'OPTIONAL_STOP', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/OPTIONAL_STOP')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ORDER_NUMBER', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/ORDER_NUMBER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'OVERRIDE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/OVERRIDE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'PART', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/PART')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'PART_FAMILY', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/PART_FAMILY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'PART_NAME', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/PART_NAME')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'PART_NUMBER', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/PART_NUMBER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'PECK', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/PECK')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'PLUNGE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/PLUNGE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'POWERED', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/POWERED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'PRIMARY', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/PRIMARY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'PROBE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/PROBE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'PROCESS', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/PROCESS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'PROCESS_NAME', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/PROCESS_NAME')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'PROCESS_PLAN', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/PROCESS_PLAN')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'PROCESS_STEP', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/PROCESS_STEP')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'PROGRAMMED', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/PROGRAMMED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'RADIAL', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/RADIAL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'RAPID', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/RAPID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'RAW_MATERIAL', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/RAW_MATERIAL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'RECIPE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/RECIPE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'RELEASE_DATE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/RELEASE_DATE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'REMAINING', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/REMAINING')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'REQUEST', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/REQUEST')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'RESPONSE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/RESPONSE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ROCKWELL', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/ROCKWELL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ROTARY', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/ROTARY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'SCHEDULE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/SCHEDULE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'SEGMENT', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/SEGMENT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'SERIAL_NUMBER', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/SERIAL_NUMBER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'SET_UP', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/SET_UP')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'SHORE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/SHORE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'SINGLE_BLOCK', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/SINGLE_BLOCK')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'SOLID', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/SOLID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'STANDARD', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/STANDARD')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'START', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/START')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'SUBNET_MASK', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/SUBNET_MASK')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'SWITCHED', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/SWITCHED')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'TARGET', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/TARGET')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'TARGET_COMPLETION', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/TARGET_COMPLETION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'TOOL_CHANGE_STOP', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/TOOL_CHANGE_STOP')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'USEABLE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/USEABLE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'UUID', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/UUID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'VERSION', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/VERSION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'VERTICAL', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/VERTICAL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'VICKERS', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/VICKERS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'VLAN_ID', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/VLAN_ID')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'WASTE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/WASTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'WIRELESS', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/WIRELESS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'WORKING', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/SubType/WORKING')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'AMPERE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/AMPERE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'CELSIUS', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/CELSIUS')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'COULOMB', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/COULOMB')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'COUNT', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/COUNT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'COUNT/SECOND', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/COUNT/SECOND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'CUBIC_METER', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/CUBIC_METER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'CUBIC_MILLIMETER', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/CUBIC_MILLIMETER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'CUBIC_MILLIMETER/SECOND', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/CUBIC_MILLIMETER/SECOND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'CUBIC_MILLIMETER/SECOND^2', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/CUBIC_MILLIMETER/SECOND^2')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'DECIBEL', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/DECIBEL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'DEGREE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/DEGREE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'DEGREE/SECOND', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/DEGREE/SECOND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'DEGREE/SECOND^2', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/DEGREE/SECOND^2')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'DEGREE_3D', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/DEGREE_3D')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'GRAM', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/GRAM')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'GRAM/CUBIC_METER', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/GRAM/CUBIC_METER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'HERTZ', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/HERTZ')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'JOULE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/JOULE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'KILOGRAM', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/KILOGRAM')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'LITER', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/LITER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'LITER/SECOND', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/LITER/SECOND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'METER', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/METER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'METER/SECOND^2', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/METER/SECOND^2')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'MICRO_RADIAN', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/MICRO_RADIAN')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'MILLIGRAM', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/MILLIGRAM')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'MILLIGRAM/CUBIC_MILLIMETER', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/MILLIGRAM/CUBIC_MILLIMETER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'MILLIGRAM/LITER', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/MILLIGRAM/LITER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'MILLILITER', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/MILLILITER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'MILLIMETER', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/MILLIMETER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'MILLIMETER/REVOLUTION', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/MILLIMETER/REVOLUTION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'MILLIMETER/SECOND', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/MILLIMETER/SECOND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'MILLIMETER/SECOND^2', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/MILLIMETER/SECOND^2')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'MILLIMETER_3D', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/MILLIMETER_3D')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'NEWTON', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/NEWTON')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'NEWTON_METER', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/NEWTON_METER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'OHM', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/OHM')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'OHM_METER', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/OHM_METER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'PASCAL', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/PASCAL')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'PASCAL/SECOND', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/PASCAL/SECOND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'PASCAL_SECOND', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/PASCAL_SECOND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'PERCENT', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/PERCENT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'PH', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/PH')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'REVOLUTION/MINUTE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/REVOLUTION/MINUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'REVOLUTION/SECOND', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/REVOLUTION/SECOND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'REVOLUTION/SECOND^2', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/REVOLUTION/SECOND^2')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'SECOND', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/SECOND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'SIEMENS/METER', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/SIEMENS/METER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'SQUARE_MILLIMETER', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/SQUARE_MILLIMETER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'UNIT_VECTOR_3D', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/UNIT_VECTOR_3D')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'VOLT', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/VOLT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'VOLT_AMPERE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/VOLT_AMPERE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'VOLT_AMPERE_REACTIVE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/VOLT_AMPERE_REACTIVE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'WATT', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/WATT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'WATT_SECOND', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Unit/WATT_SECOND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'AMPERE_HOUR', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/AMPERE_HOUR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'BAR', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/BAR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'CENTIPOISE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/CENTIPOISE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'COUNT/MILLION', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/COUNT/MILLION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'COUNT/TRILLION', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/COUNT/TRILLION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'CUBIC_FOOT', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/CUBIC_FOOT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'CUBIC_FOOT/HOUR', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/CUBIC_FOOT/HOUR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'CUBIC_FOOT/MINUTE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/CUBIC_FOOT/MINUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'DEGREE/MINUTE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/DEGREE/MINUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'FAHRENHEIT', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/FAHRENHEIT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'FOOT', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/FOOT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'FOOT/MINUTE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/FOOT/MINUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'FOOT/SECOND', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/FOOT/SECOND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'FOOT/SECOND^2', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/FOOT/SECOND^2')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'FOOT_3D', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/FOOT_3D')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'GALLON/MINUTE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/GALLON/MINUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'GRAVITATIONAL_ACCELERATION', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/GRAVITATIONAL_ACCELERATION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'GRAVITATIONAL_FORCE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/GRAVITATIONAL_FORCE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'HOUR', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/HOUR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'INCH', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/INCH')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'INCH/MINUTE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/INCH/MINUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'INCH/REVOLUTION', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/INCH/REVOLUTION')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'INCH/SECOND', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/INCH/SECOND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'INCH/SECOND^2', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/INCH/SECOND^2')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'INCH_3D', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/INCH_3D')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'INCH_POUND', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/INCH_POUND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'KELVIN', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/KELVIN')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'KILOWATT', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/KILOWATT')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'KILOWATT_HOUR', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/KILOWATT_HOUR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'LITER/MINUTE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/LITER/MINUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'MICROMETER', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/MICROMETER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'MICROTORR', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/MICROTORR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'MILLIMETER/MINUTE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/MILLIMETER/MINUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'MILLIMETER_MERCURY', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/MILLIMETER_MERCURY')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'MINUTE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/MINUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'OTHER', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/OTHER')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'PASCAL/MINUTE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/PASCAL/MINUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'POUND', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/POUND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'POUND/INCH^2', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/POUND/INCH^2')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'RADIAN', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/RADIAN')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'RADIAN/MINUTE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/RADIAN/MINUTE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'RADIAN/SECOND', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/RADIAN/SECOND')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'RADIAN/SECOND^2', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/RADIAN/SECOND^2')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'RANKINE', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/RANKINE')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'SQUARE_INCH', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/SQUARE_INCH')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'TORR', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/NativeUnit/TORR')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Actuator', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Actuator')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Adapter', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Adapter')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Adapters', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Adapters')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Agent', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Agent')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'AirHandler', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/AirHandler')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Amplifier', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Amplifier')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'AutomaticToolChanger', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/AutomaticToolChanger')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Auxiliaries', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Auxiliaries')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Auxiliary', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Auxiliary')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Axes', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Axes')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Axis', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Axis')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Ballscrew', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Ballscrew')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'BarFeeder', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/BarFeeder')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'BarFeederInterface', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/BarFeederInterface')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Belt', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Belt')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Brake', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Brake')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Chain', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Chain')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Chopper', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Chopper')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Chuck', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Chuck')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'ChuckInterface', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/ChuckInterface')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Chute', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Chute')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'CircuitBreaker', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/CircuitBreaker')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Clamp', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Clamp')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Compressor', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Compressor')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Controller', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Controller')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Coolant', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Coolant')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Cooling', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Cooling')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'CoolingTower', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/CoolingTower')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'CuttingTorch', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/CuttingTorch')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Deposition', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Deposition')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Dielectric', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Dielectric')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Door', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Door')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'DoorInterface', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/DoorInterface')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Drain', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Drain')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Electric', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Electric')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Electrode', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Electrode')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Enclosure', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Enclosure')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Encoder', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Encoder')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'EndEffector', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/EndEffector')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Environmental', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Environmental')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'ExpiredPot', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/ExpiredPot')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'ExposureUnit', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/ExposureUnit')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'ExtrusionUnit', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/ExtrusionUnit')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Fan', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Fan')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'FeatureOccurrence', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/FeatureOccurrence')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Feeder', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Feeder')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Filter', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Filter')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Galvanomotor', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Galvanomotor')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'GangToolBar', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/GangToolBar')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Gripper', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Gripper')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Heating', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Heating')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Hopper', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Hopper')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Hydraulic', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Hydraulic')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Interface', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Interface')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Interfaces', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Interfaces')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Linear', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Linear')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'LinearPositionFeedback', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/LinearPositionFeedback')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Link', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Link')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Loader', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Loader')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Lock', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Lock')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Lubrication', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Lubrication')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Material', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Material')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'MaterialHandlerInterface', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/MaterialHandlerInterface')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Materials', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Materials')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Motor', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Motor')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Oil', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Oil')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Part', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Part')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'PartOccurrence', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/PartOccurrence')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Parts', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Parts')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Path', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Path')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Personnel', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Personnel')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'PinTool', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/PinTool')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Pneumatic', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Pneumatic')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Pot', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Pot')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Power', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Power')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'PowerSupply', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/PowerSupply')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Pressure', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Pressure')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Process', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Process')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Processes', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Processes')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'ProcessOccurrence', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/ProcessOccurrence')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'ProcessPower', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/ProcessPower')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Protective', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Protective')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Pulley', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Pulley')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Pump', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Pump')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Reel', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Reel')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'RemovalPot', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/RemovalPot')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Requester', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Requester')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Resource', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Resource')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Resources', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Resources')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Responder', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Responder')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'ReturnPot', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/ReturnPot')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Rotary', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Rotary')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'SensingElement', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/SensingElement')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Sensor', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Sensor')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Spindle', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Spindle')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Spreader', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Spreader')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'StagingPot', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/StagingPot')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Station', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Station')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Stock', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Stock')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'StorageBattery', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/StorageBattery')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Structure', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Structure')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Structures', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Structures')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Switch', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Switch')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'System', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/System')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Systems', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Systems')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Table', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Table')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Tank', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Tank')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Tensioner', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Tensioner')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Thermostat', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Thermostat')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'ToolHolder', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/ToolHolder')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'ToolingDelivery', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/ToolingDelivery')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'ToolMagazine', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/ToolMagazine')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'ToolRack', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/ToolRack')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'TransferArm', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/TransferArm')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'TransferPot', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/TransferPot')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Transformer', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Transformer')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Turret', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Turret')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Vacuum', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Vacuum')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Valve', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Valve')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Vat', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Vat')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Vibration', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Vibration')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'WasteDisposal', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/WasteDisposal')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Water', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Water')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Wire', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Wire')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'WorkEnvelope', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/WorkEnvelope')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
INSERT INTO public.mtconnect_vocabulary VALUES ('COMPONENT', 'Workpiece', NULL, 'https://acs-cymru.local/semantics/mtconnect/v2.0/Component/Workpiece')
ON CONFLICT (kind, name) DO UPDATE SET category = EXCLUDED.category;
-- <<< END GENERATED mtconnect_vocabulary

-- -------------------------------------------------------------------------------------------
-- ISO 22400 vocabulary (8 rows)  (8 rows)
-- -------------------------------------------------------------------------------------------
-- The computed KPIs MTConnect and OPC UA exclude. `kpi_id` is the ISO symbol, not a clause
-- number. MTConnect's `AVAILABILITY` is an event meaning "device connected"; the OEE
-- availability ratio here is ISO 22400. Never map one onto the other.

INSERT INTO public.iso22400_vocabulary VALUES ('AVAILABILITY', 'A', 'Availability ratio: the share of planned busy time the equipment was actually producing. ISO 22400-2 "Availability". NOT MTConnect AVAILABILITY, which is an EVENT meaning the device is connected.', 'OEE', 'PERCENT', 'A = APT / PBT', 'https://acs-cymru.local/semantics/iso22400/AVAILABILITY')
ON CONFLICT (name) DO UPDATE SET
  kpi_id      = EXCLUDED.kpi_id,
  description = EXCLUDED.description,
  category    = EXCLUDED.category,
  unit        = EXCLUDED.unit,
  formula     = EXCLUDED.formula,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.iso22400_vocabulary VALUES ('EFFECTIVENESS', 'E', 'Effectiveness ratio: actual output against what the run time should have produced. ISO 22400-2 calls this KPI "Effectiveness"; it is the factor the industry almost always calls Performance, and the catalog''s superseded OEE/PERFORMANCE metric measured exactly this.', 'OEE', 'PERCENT', 'E = (PRI x PQ) / APT', 'https://acs-cymru.local/semantics/iso22400/EFFECTIVENESS')
ON CONFLICT (name) DO UPDATE SET
  kpi_id      = EXCLUDED.kpi_id,
  description = EXCLUDED.description,
  category    = EXCLUDED.category,
  unit        = EXCLUDED.unit,
  formula     = EXCLUDED.formula,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.iso22400_vocabulary VALUES ('QUALITY', 'Q', 'Quality ratio: good quantity as a share of total produced quantity. ISO 22400-2 "Quality ratio".', 'OEE', 'PERCENT', 'Q = GQ / PQ', 'https://acs-cymru.local/semantics/iso22400/QUALITY')
ON CONFLICT (name) DO UPDATE SET
  kpi_id      = EXCLUDED.kpi_id,
  description = EXCLUDED.description,
  category    = EXCLUDED.category,
  unit        = EXCLUDED.unit,
  formula     = EXCLUDED.formula,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.iso22400_vocabulary VALUES ('OEE', 'OEE', 'Overall equipment effectiveness: the product of the three factors above. ISO 22400-2 "OEE index". A composite -- derive it from A, E and Q rather than having a device report it independently, or the four values can disagree.', 'OEE', 'PERCENT', 'OEE = A x E x Q', 'https://acs-cymru.local/semantics/iso22400/OEE')
ON CONFLICT (name) DO UPDATE SET
  kpi_id      = EXCLUDED.kpi_id,
  description = EXCLUDED.description,
  category    = EXCLUDED.category,
  unit        = EXCLUDED.unit,
  formula     = EXCLUDED.formula,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.iso22400_vocabulary VALUES ('SCRAP_RATIO', 'SR', 'Scrap ratio: scrap quantity as a share of produced quantity. ISO 22400-2 "Scrap ratio". The complement of the quality ratio only when rework is zero -- they are separate KPIs for that reason.', 'Quality', 'PERCENT', 'SR = SQ / PQ', 'https://acs-cymru.local/semantics/iso22400/SCRAP_RATIO')
ON CONFLICT (name) DO UPDATE SET
  kpi_id      = EXCLUDED.kpi_id,
  description = EXCLUDED.description,
  category    = EXCLUDED.category,
  unit        = EXCLUDED.unit,
  formula     = EXCLUDED.formula,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.iso22400_vocabulary VALUES ('UTILIZATION', 'UR', 'Utilization (loading) ratio: planned busy time as a share of calendar time. The common industry ratio rather than a verbatim ISO 22400-2 KPI -- it answers "how much of the day was this asset scheduled to work?", which availability deliberately does not. Verify against the standard before citing it as ISO 22400.', 'Utilization', 'PERCENT', 'UR = PBT / CAL', 'https://acs-cymru.local/semantics/iso22400/UTILIZATION')
ON CONFLICT (name) DO UPDATE SET
  kpi_id      = EXCLUDED.kpi_id,
  description = EXCLUDED.description,
  category    = EXCLUDED.category,
  unit        = EXCLUDED.unit,
  formula     = EXCLUDED.formula,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.iso22400_vocabulary VALUES ('MTBF', 'MTBF', 'Mean operating time between failures. ISO 22400-2 "Mean operating time between failures".', 'Maintenance', 'HOUR', 'MTBF = APT / number of failures', 'https://acs-cymru.local/semantics/iso22400/MTBF')
ON CONFLICT (name) DO UPDATE SET
  kpi_id      = EXCLUDED.kpi_id,
  description = EXCLUDED.description,
  category    = EXCLUDED.category,
  unit        = EXCLUDED.unit,
  formula     = EXCLUDED.formula,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.iso22400_vocabulary VALUES ('MTTR', 'MTTR', 'Mean time to restoration -- the average time to return the asset to service after a failure. ISO 22400-2 "Mean time to restoration"; MTTR is the common abbreviation and is often expanded as "mean time to repair".', 'Maintenance', 'HOUR', 'MTTR = total repair time / number of repairs', 'https://acs-cymru.local/semantics/iso22400/MTTR')
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
-- `node_id` is a browse path (`nsu=<ns>;s=<BrowsePath>`), not a numeric NodeId; these rows were
-- transcribed by hand. Keyed on (companion_spec, name) because both specs define `Manufacturer`.

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

-- The rows below are generated: browse names and datatypes are read out of the OPC Foundation
-- NodeSet2 XML by scripts/generate-opcua-vocabulary.mjs; the selection, prose and units are
-- curated.
-- >>> BEGIN GENERATED opcua_vocabulary_companion_extensions -- 51 rows, sha256:ac69ec9b4fd0664e
-- GENERATED from the OPC Foundation NodeSet2 XML by scripts/generate-opcua-vocabulary.mjs.
-- Do not edit these rows by hand: change ENTRIES in that script and re-run it. Browse names
-- and datatypes are verified against the NodeSet; the selection, prose and units are curated.
-- CI verifies the digest above.
INSERT INTO public.opcua_vocabulary VALUES ('FeedOverride', 'OPC 40501 Machine Tools', 'nsu=http://opcfoundation.org/UA/MachineTool/;s=MachineTool/Monitoring/Channels/<Channel>/FeedOverride', 'Operator feed-rate override applied to the programmed feed on this channel, as a percentage. The machine-tool counterpart of Robotics SpeedOverride; a channel is one independent NC program stream, so a machine with two channels reports two of these.', 'Double', 'PERCENT', 'http://opcfoundation.org/UA/MachineTool/FeedOverride')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('RapidOverride', 'OPC 40501 Machine Tools', 'nsu=http://opcfoundation.org/UA/MachineTool/;s=MachineTool/Monitoring/Channels/<Channel>/RapidOverride', 'Operator override applied to rapid traverse moves on this channel, as a percentage. Separate from FeedOverride because controls override the two independently.', 'Double', 'PERCENT', 'http://opcfoundation.org/UA/MachineTool/RapidOverride')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('ChannelState', 'OPC 40501 Machine Tools', 'nsu=http://opcfoundation.org/UA/MachineTool/;s=ChannelMonitoringType/ChannelState', 'Execution state of the channel. The MachineTool enumeration, whose values are Interrupted, Reset, Running and Waiting -- the closest OPC UA analogue of MTConnect Controller/EXECUTION.', 'String', NULL, 'http://opcfoundation.org/UA/MachineTool/ChannelState')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('ChannelMode', 'OPC 40501 Machine Tools', 'nsu=http://opcfoundation.org/UA/MachineTool/;s=ChannelMonitoringType/ChannelMode', 'Operating mode of the channel: Auto, MDI or Manual. What the operator selected, as opposed to what the channel is currently doing.', 'String', NULL, 'http://opcfoundation.org/UA/MachineTool/ChannelMode')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('DryRun', 'OPC 40501 Machine Tools', 'nsu=http://opcfoundation.org/UA/MachineTool/;s=ChannelModifierType/DryRun', 'Whether dry-run is active on this channel -- the program is executed without cutting. Production counted while this is true is not saleable output, which is exactly the distinction an OEE calculation must not lose.', 'Boolean', NULL, 'http://opcfoundation.org/UA/MachineTool/DryRun')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('SingleStep', 'OPC 40501 Machine Tools', 'nsu=http://opcfoundation.org/UA/MachineTool/;s=ChannelModifierType/SingleStep', 'Whether the channel is executing one program block per start command rather than running continuously.', 'Boolean', NULL, 'http://opcfoundation.org/UA/MachineTool/SingleStep')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('OptionalStop', 'OPC 40501 Machine Tools', 'nsu=http://opcfoundation.org/UA/MachineTool/;s=ChannelModifierType/OptionalStop', 'Whether programmed optional stops (M01) are honoured on this channel.', 'Boolean', NULL, 'http://opcfoundation.org/UA/MachineTool/OptionalStop')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('BlockSkip', 'OPC 40501 Machine Tools', 'nsu=http://opcfoundation.org/UA/MachineTool/;s=ChannelModifierType/BlockSkip', 'Whether program blocks marked as skippable are being skipped on this channel.', 'Boolean', NULL, 'http://opcfoundation.org/UA/MachineTool/BlockSkip')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('TestMode', 'OPC 40501 Machine Tools', 'nsu=http://opcfoundation.org/UA/MachineTool/;s=ChannelModifierType/TestMode', 'Whether the channel is in test mode. Like DryRun, this marks output that should not be counted as production.', 'Boolean', NULL, 'http://opcfoundation.org/UA/MachineTool/TestMode')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('IsRotating', 'OPC 40501 Machine Tools', 'nsu=http://opcfoundation.org/UA/MachineTool/;s=SpindleMonitoringType/IsRotating', 'Whether the spindle is turning. A cheap cutting-versus-idle discriminator where no power or load metric is published.', 'Boolean', NULL, 'http://opcfoundation.org/UA/MachineTool/IsRotating')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('Override', 'OPC 40501 Machine Tools', 'nsu=http://opcfoundation.org/UA/MachineTool/;s=SpindleMonitoringType/Override', 'Operator override applied to the programmed spindle speed, as a percentage. The browse name is bare `Override` in the specification; it is spindle-scoped by the type that declares it, not by its name.', 'Double', 'PERCENT', 'http://opcfoundation.org/UA/MachineTool/Override')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('OperationMode', 'OPC 40501 Machine Tools', 'nsu=http://opcfoundation.org/UA/MachineTool/;s=MachineOperationMonitoringType/OperationMode', 'Machine-level operating mode: Auto, Manual, MDI or Setup. Distinct from ChannelMode, which is per NC channel -- a machine has one of these and may have several of those.', 'String', NULL, 'http://opcfoundation.org/UA/MachineTool/OperationMode')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('PowerOnDuration', 'OPC 40501 Machine Tools', 'nsu=http://opcfoundation.org/UA/MachineTool/;s=MachineOperationMonitoringType/PowerOnDuration', 'Accumulated time this machine has been powered on. OPC 40001 Machinery defines a metric of the same name as a Double; this is the MachineTool declaration and is a UInt32 count of seconds.', 'UInt32', 'SECOND', 'http://opcfoundation.org/UA/MachineTool/PowerOnDuration')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('IsWarmUp', 'OPC 40501 Machine Tools', 'nsu=http://opcfoundation.org/UA/MachineTool/;s=MachineOperationMonitoringType/IsWarmUp', 'Whether the machine is running a warm-up cycle. Warm-up is neither downtime nor production, and conflating it with either distorts availability.', 'Boolean', NULL, 'http://opcfoundation.org/UA/MachineTool/IsWarmUp')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('PartsCompleted', 'OPC 40501 Machine Tools', 'nsu=http://opcfoundation.org/UA/MachineTool/;s=ProductionJobType/PartsCompleted', 'Parts completed by the active job, good and bad together. Pair with PartsGood to get scrap; on its own it is throughput, not yield.', 'UInt32', 'COUNT', 'http://opcfoundation.org/UA/MachineTool/PartsCompleted')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('PartsGood', 'OPC 40501 Machine Tools', 'nsu=http://opcfoundation.org/UA/MachineTool/;s=ProductionJobType/PartsGood', 'Parts completed by the active job that met quality requirements. This is the good-count an ISO 22400 quality ratio needs, published by the machine rather than inferred.', 'UInt32', 'COUNT', 'http://opcfoundation.org/UA/MachineTool/PartsGood')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('RunsCompleted', 'OPC 40501 Machine Tools', 'nsu=http://opcfoundation.org/UA/MachineTool/;s=ProductionJobType/RunsCompleted', 'Runs of the active job completed so far. A run may produce several parts -- see ProductionPartSetType.', 'UInt32', 'COUNT', 'http://opcfoundation.org/UA/MachineTool/RunsCompleted')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('RunsPlanned', 'OPC 40501 Machine Tools', 'nsu=http://opcfoundation.org/UA/MachineTool/;s=ProductionJobType/RunsPlanned', 'Runs the active job is planned to perform. Note this is a property of the job the machine was given, not a schedule this platform stores.', 'UInt32', 'COUNT', 'http://opcfoundation.org/UA/MachineTool/RunsPlanned')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('PartsProducedInLifetime', 'OPC 40501 Machine Tools', 'nsu=http://opcfoundation.org/UA/MachineTool/;s=ProductionStatisticsType/PartsProducedInLifetime', 'Parts produced by this machine over its lifetime. Monotonic across jobs and power cycles, so it is a counter to difference rather than a value to read.', 'UInt32', 'COUNT', 'http://opcfoundation.org/UA/MachineTool/PartsProducedInLifetime')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('PartQuality', 'OPC 40501 Machine Tools', 'nsu=http://opcfoundation.org/UA/MachineTool/;s=ProductionPartType/PartQuality', 'Quality disposition of a produced part: Bad, Good, Scrap or Unclassified. The disposition an MES would otherwise have to supply, published here by the machine itself.', 'String', NULL, 'http://opcfoundation.org/UA/MachineTool/PartQuality')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('ProcessIrregularity', 'OPC 40501 Machine Tools', 'nsu=http://opcfoundation.org/UA/MachineTool/;s=ProductionPartType/ProcessIrregularity', 'Whether an irregularity occurred while producing the part: Irregularity, NoIrregularity or Unknown. A machine-asserted reason to distrust the part, distinct from PartQuality, which is the verdict.', 'String', NULL, 'http://opcfoundation.org/UA/MachineTool/ProcessIrregularity')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('Locked', 'OPC 40501 Machine Tools', 'nsu=http://opcfoundation.org/UA/MachineTool/;s=ToolType/Locked', 'Whether the tool is locked out of use. A locked tool in a magazine is capacity the machine cannot use, which is a common and otherwise invisible cause of a stoppage.', 'Boolean', NULL, 'http://opcfoundation.org/UA/MachineTool/Locked')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('PlannedForOperating', 'OPC 40501 Machine Tools', 'nsu=http://opcfoundation.org/UA/MachineTool/;s=ToolType/PlannedForOperating', 'Whether the tool is planned for use by the current setup.', 'Boolean', NULL, 'http://opcfoundation.org/UA/MachineTool/PlannedForOperating')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('RemainingQuantity', 'OPC 40540 Additive Manufacturing', 'nsu=http://opcfoundation.org/UA/AdditiveManufacturing/;s=FeedstockType/RemainingQuantity', 'Quantity of this feedstock remaining. The specification types it as the abstract Number, so the concrete Sparkplug type is a choice at metric-creation time; the unit follows the feedstock -- KILOGRAM for powder, MILLIMETER of filament, MILLILITER of resin.', 'Double', NULL, 'http://opcfoundation.org/UA/AdditiveManufacturing/RemainingQuantity')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('ReadyForProduction', 'OPC 40540 Additive Manufacturing', 'nsu=http://opcfoundation.org/UA/AdditiveManufacturing/;s=FeedstockType/ReadyForProduction', 'Whether this feedstock is ready to be consumed. A printer with a full hopper that is not ready -- unconditioned powder, an unpurged nozzle -- is unavailable for a reason no quantity metric shows.', 'Boolean', NULL, 'http://opcfoundation.org/UA/AdditiveManufacturing/ReadyForProduction')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('Cycle', 'OPC 40540 Additive Manufacturing', 'nsu=http://opcfoundation.org/UA/AdditiveManufacturing/;s=FeedstockType/Cycle', 'How many times this feedstock has been through the machine. Recycled powder degrades with each cycle, so this is a quality input rather than an inventory one.', 'UInt32', 'COUNT', 'http://opcfoundation.org/UA/AdditiveManufacturing/Cycle')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('Manufacturer', 'OPC 40540 Additive Manufacturing', 'nsu=http://opcfoundation.org/UA/AdditiveManufacturing/;s=FeedstockType/Manufacturer', 'Manufacturer of the feedstock. Part of the material traceability an additive part needs and a subtractive one usually does not.', 'String', NULL, 'http://opcfoundation.org/UA/AdditiveManufacturing/Manufacturer')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('Category', 'OPC 40540 Additive Manufacturing', 'nsu=http://opcfoundation.org/UA/AdditiveManufacturing/;s=ProcessValueAMType/Category', 'Category of an in-process sensor reading, from the SensorCategory enumeration -- what kind of thing is being measured.', 'String', NULL, 'http://opcfoundation.org/UA/AdditiveManufacturing/Category')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('Severity', 'OPC 40540 Additive Manufacturing', 'nsu=http://opcfoundation.org/UA/AdditiveManufacturing/;s=ProcessValueAMType/Severity', 'Severity attached to an in-process sensor reading, from the SensorSeverity enumeration. The machine grading its own measurement, which is not the same as an alarm.', 'String', NULL, 'http://opcfoundation.org/UA/AdditiveManufacturing/Severity')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('CurMachSpeed', 'OPC 30050 PackML', 'nsu=http://opcfoundation.org/UA/PackML/;s=PackMLStatusObjectType/CurMachSpeed', 'Current operating speed of the unit. The units belong to the machine -- parts, containers or metres per minute -- so the unit is a choice at metric-creation time rather than a property of the browse name.', 'Float', NULL, 'http://opcfoundation.org/UA/PackML/CurMachSpeed')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('MachSpeed', 'OPC 30050 PackML', 'nsu=http://opcfoundation.org/UA/PackML/;s=PackMLStatusObjectType/MachSpeed', 'Speed the unit has been commanded to run at. Paired with CurMachSpeed it separates "running slowly" from "asked to run slowly", which an availability figure alone cannot.', 'Float', NULL, 'http://opcfoundation.org/UA/PackML/MachSpeed')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('MachDesignSpeed', 'OPC 30050 PackML', 'nsu=http://opcfoundation.org/UA/PackML/;s=PackMLAdminObjectType/MachDesignSpeed', 'Nameplate design speed of the unit. The denominator an ISO 22400 performance ratio needs, published by the machine rather than configured by hand.', 'Float', NULL, 'http://opcfoundation.org/UA/PackML/MachDesignSpeed')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('EquipmentBlocked', 'OPC 30050 PackML', 'nsu=http://opcfoundation.org/UA/PackML/;s=PackMLStatusObjectType/EquipmentBlocked', 'Whether the unit is blocked by equipment downstream. A stoppage this unit did not cause -- the distinction between its own downtime and downtime belonging to the line.', 'Boolean', NULL, 'http://opcfoundation.org/UA/PackML/EquipmentBlocked')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('EquipmentStarved', 'OPC 30050 PackML', 'nsu=http://opcfoundation.org/UA/PackML/;s=PackMLStatusObjectType/EquipmentStarved', 'Whether the unit is starved by equipment upstream. The other half of EquipmentBlocked, and just as important for attributing a stoppage.', 'Boolean', NULL, 'http://opcfoundation.org/UA/PackML/EquipmentStarved')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('MaterialInterlocked', 'OPC 30050 PackML', 'nsu=http://opcfoundation.org/UA/PackML/;s=PackMLStatusObjectType/MaterialInterlocked', 'Whether the unit is held by a material interlock.', 'Boolean', NULL, 'http://opcfoundation.org/UA/PackML/MaterialInterlocked')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('UnitModeCurrent', 'OPC 30050 PackML', 'nsu=http://opcfoundation.org/UA/PackML/;s=PackMLStatusObjectType/UnitModeCurrent', 'Current unit mode -- Production, Maintenance or Manual in the base model. Mode and state are orthogonal in PackML: a unit can be executing in Maintenance, and counting that as production is exactly the error the two fields exist to prevent.', 'String', NULL, 'http://opcfoundation.org/UA/PackML/UnitModeCurrent')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('StateRequested', 'OPC 30050 PackML', 'nsu=http://opcfoundation.org/UA/PackML/;s=PackMLStatusObjectType/StateRequested', 'State number the unit has been asked to move to. Requested, not reached -- StateChangeInProcess says whether the transition is still running.', 'Int32', NULL, 'http://opcfoundation.org/UA/PackML/StateRequested')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('StateChangeInProcess', 'OPC 30050 PackML', 'nsu=http://opcfoundation.org/UA/PackML/;s=PackMLStatusObjectType/StateChangeInProcess', 'Whether a state transition is currently in progress.', 'Boolean', NULL, 'http://opcfoundation.org/UA/PackML/StateChangeInProcess')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('UnitModeChangeInProcess', 'OPC 30050 PackML', 'nsu=http://opcfoundation.org/UA/PackML/;s=PackMLStatusObjectType/UnitModeChangeInProcess', 'Whether a unit mode change is currently in progress.', 'Boolean', NULL, 'http://opcfoundation.org/UA/PackML/UnitModeChangeInProcess')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('StateCurrentTime', 'OPC 30050 PackML', 'nsu=http://opcfoundation.org/UA/PackML/;s=PackMLAdminObjectType/StateCurrentTime', 'Time spent in the current state. With StateCumulativeTime this is the state-time accumulation that lets an OEE figure be arithmetic over reported values rather than an inference -- the reason PackML is worth adopting at all here.', 'Int32', 'SECOND', 'http://opcfoundation.org/UA/PackML/StateCurrentTime')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('StateCumulativeTime', 'OPC 30050 PackML', 'nsu=http://opcfoundation.org/UA/PackML/;s=PackMLAdminObjectType/StateCumulativeTime', 'Accumulated time in each state since the last reset. Monotonic, so it is a counter to difference rather than a value to read.', 'Int32', 'SECOND', 'http://opcfoundation.org/UA/PackML/StateCumulativeTime')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('ModeCurrentTime', 'OPC 30050 PackML', 'nsu=http://opcfoundation.org/UA/PackML/;s=PackMLAdminObjectType/ModeCurrentTime', 'Time spent in the current unit mode.', 'Int32', 'SECOND', 'http://opcfoundation.org/UA/PackML/ModeCurrentTime')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('ModeCumulativeTime', 'OPC 30050 PackML', 'nsu=http://opcfoundation.org/UA/PackML/;s=PackMLAdminObjectType/ModeCumulativeTime', 'Accumulated time in each unit mode since the last reset.', 'Int32', 'SECOND', 'http://opcfoundation.org/UA/PackML/ModeCumulativeTime')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('AccTimeSinceReset', 'OPC 30050 PackML', 'nsu=http://opcfoundation.org/UA/PackML/;s=PackMLAdminObjectType/AccTimeSinceReset', 'Time since the accumulators were last reset. Without it the cumulative counters have no denominator and cannot be turned into a ratio.', 'Int32', 'SECOND', 'http://opcfoundation.org/UA/PackML/AccTimeSinceReset')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('PackMLVersion', 'OPC 30050 PackML', 'nsu=http://opcfoundation.org/UA/PackML/;s=PackMLBaseObjectType/PackMLVersion', 'Which PackML version the unit implements. Worth catalogue space because the state model changed between editions.', 'String', NULL, 'http://opcfoundation.org/UA/PackML/PackMLVersion')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('Pressure', 'OPC 40001-4 Machinery Energy', 'nsu=http://opcfoundation.org/UA/Machinery/Energy/;s=IBaseFlowType/Pressure', 'Pressure of a measured utility flow. Declared on the base flow interface, so it applies to a mass flow and a volume flow alike.', 'Float', 'PASCAL', 'http://opcfoundation.org/UA/Machinery/Energy/Pressure')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('Temperature', 'OPC 40001-4 Machinery Energy', 'nsu=http://opcfoundation.org/UA/Machinery/Energy/;s=IBaseFlowType/Temperature', 'Temperature of a measured utility flow.', 'Float', 'CELSIUS', 'http://opcfoundation.org/UA/Machinery/Energy/Temperature')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('Mass', 'OPC 40001-4 Machinery Energy', 'nsu=http://opcfoundation.org/UA/Machinery/Energy/;s=IMassFlowType/Mass', 'Accumulated mass of a utility that has flowed. OPC 40010 Robotics defines an unrelated `Mass` -- a payload weight -- which is why this vocabulary is keyed on (companion_spec, name).', 'Float', 'KILOGRAM', 'http://opcfoundation.org/UA/Machinery/Energy/Mass')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('MassFlowRate', 'OPC 40001-4 Machinery Energy', 'nsu=http://opcfoundation.org/UA/Machinery/Energy/;s=IMassFlowType/MassFlowRate', 'Instantaneous mass flow rate of a utility. No unit is offered because the MTConnect unit vocabulary this platform draws on has no mass-per-time entry; pick one at metric-creation time and record it in the metric description.', 'Float', NULL, 'http://opcfoundation.org/UA/Machinery/Energy/MassFlowRate')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('Volume', 'OPC 40001-4 Machinery Energy', 'nsu=http://opcfoundation.org/UA/Machinery/Energy/;s=IVolumeFlowType/Volume', 'Accumulated volume of a utility that has flowed. Monotonic, so it is a counter to difference rather than a value to read.', 'Float', 'LITER', 'http://opcfoundation.org/UA/Machinery/Energy/Volume')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
INSERT INTO public.opcua_vocabulary VALUES ('VolumeFlowRate', 'OPC 40001-4 Machinery Energy', 'nsu=http://opcfoundation.org/UA/Machinery/Energy/;s=IVolumeFlowType/VolumeFlowRate', 'Instantaneous volume flow rate of a utility -- compressed air consumption being the usual reason to model this on a shopfloor.', 'Float', 'LITER/SECOND', 'http://opcfoundation.org/UA/Machinery/Energy/VolumeFlowRate')
ON CONFLICT (companion_spec, name) DO UPDATE SET
  node_id     = EXCLUDED.node_id,
  description = EXCLUDED.description,
  datatype    = EXCLUDED.datatype,
  unit        = EXCLUDED.unit,
  semantic_id = EXCLUDED.semantic_id;
-- <<< END GENERATED opcua_vocabulary_companion_extensions

-- -------------------------------------------------------------------------------------------
-- Default schema  (0 rows)
-- -------------------------------------------------------------------------------------------
-- No schema is seeded. The demonstration CNC's schema was the last piece of the demonstration
-- floor; 0073 removes it from databases that already have it, and the demonstrator lives in
-- `tutorial/` as a walkthrough. A fresh install has no cells, no gateways, no devices and no
-- schemas.

-- -------------------------------------------------------------------------------------------
-- Factory cells, edge gateways and devices  (0 rows)
-- -------------------------------------------------------------------------------------------
-- No assets are seeded. `0040_retire_demonstration_seed.sql` removes the demonstration floor
-- from databases that already have it. Cells are never seeded: Unassigned and Site-Wide are
-- derived lanes, not rows. The AAS conformance suite provisions its own subject
-- (tests/aas_fixture.py), so nothing depends on seeded assets.

-- -------------------------------------------------------------------------------------------
-- Service directory  (12 rows)
-- The dashboard itself is not among them; f1111111-...0002 held it and is retired, not reused.
-- -------------------------------------------------------------------------------------------

-- Seeded UNKNOWN with no heartbeat: refresh_directory_liveness() writes ACTIVE or DOWN for the
-- services Prometheus scrapes within a minute of boot and leaves the rest UNKNOWN, so the gap
-- before the first probe says "not yet known" rather than asserting health nobody checked.
INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-000000000001', 'Supabase Studio', 'GRAPHICAL_UI', 'http://127.0.0.1:54323', 'UNKNOWN', NULL, NULL)
ON CONFLICT (service_name) DO NOTHING;
-- ON CONFLICT (id), not (service_name), for this row alone: a database seeded before 0016 holds
-- this id under the OLD name, and a name-targeted clause does not catch a primary-key collision
-- -- the insert would raise on every boot instead of being skipped. 0016 then does the rename.
INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-000000000003', 'Node-RED (Virtual Edge Gateway Simulator)', 'EDGE_NODE', 'http://localhost:1880', 'UNKNOWN', NULL, NULL)
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-000000000004', 'Mosquitto MQTT Broker', 'MQTT_BROKER', 'mqtt://localhost:1883', 'UNKNOWN', NULL, NULL)
ON CONFLICT (service_name) DO NOTHING;
INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-000000000005', 'TimescaleDB Telemetry Store', 'TIME_SERIES_DB', 'postgres://localhost:5433', 'UNKNOWN', NULL, NULL)
ON CONFLICT (service_name) DO NOTHING;
INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-000000000006', 'Grafana Dashboards', 'MONITORING', 'http://localhost:3002', 'UNKNOWN', NULL, NULL)
ON CONFLICT (service_name) DO NOTHING;
INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-000000000007', 'Supabase API Gateway (Kong)', 'API_GATEWAY', 'http://127.0.0.1:54321', 'UNKNOWN', NULL, NULL)
ON CONFLICT (service_name) DO NOTHING;
INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-000000000008', 'Supabase Auth (GoTrue)', 'AUTHENTICATION', 'http://127.0.0.1:54321/auth/v1', 'UNKNOWN', NULL, NULL)
ON CONFLICT (service_name) DO NOTHING;
INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-000000000009', 'Supabase PostgREST API', 'REST_API', 'http://127.0.0.1:54321/rest/v1', 'UNKNOWN', NULL, NULL)
ON CONFLICT (service_name) DO NOTHING;
INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-00000000000a', 'Supabase Edge Functions', 'SERVERLESS', 'http://127.0.0.1:54321/functions/v1', 'UNKNOWN', NULL, NULL)
ON CONFLICT (service_name) DO NOTHING;
INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-00000000000b', 'Supabase PostgreSQL', 'DATABASE', 'postgres://localhost:54322', 'UNKNOWN', NULL, NULL)
ON CONFLICT (service_name) DO NOTHING;
INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-00000000000c', 'Sparkplug B Ingestion Engine', 'INGESTION', 'mqtt://mosquitto:1883/spBv1.0/#', 'UNKNOWN', NULL, NULL)
ON CONFLICT (service_name) DO NOTHING;
INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-00000000000d', 'API Reference (Swagger UI)', 'DOCUMENTATION', 'http://localhost:8088', 'UNKNOWN', NULL, NULL)
ON CONFLICT (service_name) DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- The metrics tier. Prometheus and the ingestion metrics endpoint are published on loopback
-- only, so those two links resolve for a browser on the deployment host and nowhere else;
-- node_exporter has no host port at all. The directory is an inventory of what is deployed,
-- listed at the address each answers on. `METRICS_EXPORTER` groups an exporter with the
-- backend it describes rather than beside Grafana; DirectoryTab's SERVICE_GROUPS decides the
-- section.
-- ---------------------------------------------------------------------------------------------
INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-00000000000e', 'Prometheus Metrics Store', 'MONITORING', 'http://localhost:9090', 'UNKNOWN', NULL, NULL)
ON CONFLICT (service_name) DO NOTHING;
INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-00000000000f', 'Host Metrics Exporter (node_exporter)', 'METRICS_EXPORTER', 'http://node-exporter:9100/metrics', 'UNKNOWN', NULL, NULL)
ON CONFLICT (service_name) DO NOTHING;
INSERT INTO public.directory_services VALUES ('f1111111-0000-0000-0000-000000000010', 'Ingestion Metrics Endpoint', 'INGESTION', 'http://localhost:9108/metrics', 'UNKNOWN', NULL, NULL)
ON CONFLICT (service_name) DO NOTHING;

-- -------------------------------------------------------------------------------------------
-- Outbound webhook targets  (1 row)
-- -------------------------------------------------------------------------------------------
-- Migration-managed and given no write RLS policy: a writable endpoint table is an SSRF
-- primitive. pg_net has no retries, ordering or dead-letter queue: advisory notifications only.

INSERT INTO public.webhook_endpoints VALUES ('3484ec9d-e07f-49ee-8aa3-f95d40d38a54', 'device.quarantined', 'http://node-red:1880/hooks/quarantine', 'nodered_admin_token', true, '2026-08-02 05:44:42.806298+00')
ON CONFLICT (event_key, url) DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- Sequence reconciliation
-- ---------------------------------------------------------------------------------------------
-- `roles` is seeded with explicit ids, which does not advance `roles_id_seq`; without this an
-- INSERT naming no id fails on `roles_pkey`. `GREATEST(..., 1)` because setval rejects a value
-- below the sequence minimum.
SELECT setval('public.roles_id_seq', GREATEST((SELECT COALESCE(max(id), 0) FROM public.roles), 1));

-- ---------------------------------------------------------------------------------------------
-- Scheduled maintenance jobs (pg_cron)
-- ---------------------------------------------------------------------------------------------
-- Janitorial only. No job derives application state: gateway staleness is a view, because a
-- sweep writing STALE would append to the audit table forever. public.ensure_cron_job() (0001)
-- unschedules before scheduling, since cron.schedule() appends and this file replays every boot.

-- 1. Prune pg_net's response log ------------------------------------------------------------
--
-- pg_net never prunes net._http_response. to_regclass() returns NULL for a missing relation, so
-- the job no-ops cleanly on a database where pg_net is not yet installed.
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
-- `auto_delete_at` is set per row by the Archive dialog; NULL means permanent retention, so the
-- NOT NULL test is load-bearing. These DELETEs fire log_digital_thread_event() by design.
-- Children go first: a parent whose child is not yet due fails to delete this run and is
-- retried the next, rather than cascading a child out from under its own timer.
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
-- Vault holds only secrets read from SQL. MQTT_PASSWORD / DB_PASSWORD / POSTGRES_PASSWORD stay
-- in .env: mosquitto-init and supabase-db need them before the database accepts connections.
\if :{?nodered_admin_token}
\else
\set nodered_admin_token ''
\endif

-- psql does NOT substitute :variables inside dollar-quoted strings, so the token cannot be
-- referenced directly from the DO block below -- it would be read as literal text and fail to
-- parse. archived migration 0010 gets away with :'ts_host' because those appear in plain SQL.
-- Stash it in a session GUC out here, where substitution does happen, and read it back inside.
-- Session-local (is_local = false but never committed to a role), so it does not persist.
SELECT set_config('acs_cymru.nodered_admin_token', :'nodered_admin_token', false);

DO $$
DECLARE
  v_token TEXT := current_setting('acs_cymru.nodered_admin_token', true);
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
      'public.dispatch_device_quarantine_webhook() (archived migration 0027).'
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
SELECT set_config('acs_cymru.nodered_admin_token', '', false);

-- ---------------------------------------------------------------------------------------------
-- Grafana OAuth client registration
-- ---------------------------------------------------------------------------------------------
-- `client_secret_hash` is base64url(sha256(secret)) unpadded, not bcrypt, and
-- `token_endpoint_auth_method` must stay `client_secret_basic` to match `auth_style = InHeader`
-- in grafana.ini.
\if :{?grafana_oauth_client_secret}
\else
\set grafana_oauth_client_secret ''
\endif

-- The public origin Grafana is reached on, as a variable: the upsert below is DO UPDATE, so a
-- literal here would be rewritten back on every boot. Grafana needs both `client_uri` (the
-- origin) and `redirect_uris` (origin + /login/generic_oauth), so the origin is passed and the
-- callback derived. It is the address the browser reaches Grafana on. GF_SERVER_ROOT_URL is
-- built from the same GRAFANA_PUBLIC_URL in docker-compose.yml.
\if :{?grafana_public_url}
\else
\set grafana_public_url ''
\endif

-- psql does not substitute :variables inside dollar-quoted blocks (see archived migration 0026), so
-- both values are staged through session GUCs where substitution does happen.
SELECT set_config('acs_cymru.grafana_oauth_client_secret', :'grafana_oauth_client_secret', false);
SELECT set_config('acs_cymru.grafana_public_url',          :'grafana_public_url',          false);

DO $$
DECLARE
  -- Pinned, not generated: grafana.ini carries this as client_id, and a fresh UUID on every
  -- stack rebuild would silently break the integration. Same reasoning as the pinned gateway
  -- UUID in archived migration 0009.
  v_client_id CONSTANT UUID := 'c0ffee00-0000-4000-8000-000000000001';
  v_secret    TEXT := current_setting('acs_cymru.grafana_oauth_client_secret', true);
  -- The trailing slash is trimmed. GRAFANA_PUBLIC_URL is documented without one, but a value
  -- copied from a browser address bar carries it, and `http://host//login/generic_oauth` is not
  -- the string GoTrue compares against -- it fails as `invalid redirect_uri`, which reads as a
  -- Grafana fault rather than as a stray character in .env.
  v_base      TEXT := rtrim(
                        COALESCE(
                          NULLIF(current_setting('acs_cymru.grafana_public_url', true), ''),
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
    'ACS-Cymru Grafana',
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

SELECT set_config('acs_cymru.grafana_oauth_client_secret', '', false);

-- -------------------------------------------------------------------------------------------
-- ASHRAE 223P building-system concepts  (640 rows, and the one metric group they file under)
-- -------------------------------------------------------------------------------------------
-- scripts/generate-ashrae223-vocabulary.mjs writes this block, markers and digest included, and
-- CI verifies it.

-- ---------------------------------------------------------------------------------------------
-- The metric group these concepts file under
-- ---------------------------------------------------------------------------------------------
-- One group, not one per concept: `enforce_metric_group_spelling()` makes the first spelling
-- permanent, and the standard is not yet published. A BMS point is named `Building/<concept>`.

INSERT INTO public.metric_groups (id, name, description, standard)
VALUES ('9d3a4f2e-6b1c-4e58-9a77-2f5c8d1b4e60', 'Building',
        'ASHRAE 223P building system points -- HVAC, electrical and the sensing around them',
        'ASHRAE 223P')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- The concepts
-- ---------------------------------------------------------------------------------------------
-- >>> BEGIN GENERATED ashrae223_vocabulary -- v1.0.0-2026, 640 rows, sha256:f6bddf7e0ec29363
-- GENERATED from the open223 ontology by scripts/generate-ashrae223-vocabulary.mjs.
-- Do not edit these rows by hand: change the script and re-run it.
-- CI verifies the digest above.
INSERT INTO public.ashrae223_vocabulary VALUES ('12V-12V-Neg', 'Class', 'Negative 12 VDC electricity', '12V-Neg', 'DC-12V', 'http://data.ashrae.org/standard223#12V-12V-Neg')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('12V-12V-Pos', 'Class', 'Positive 12 VDC electricity', '12V-Pos', 'DC-12V', 'http://data.ashrae.org/standard223#12V-12V-Pos')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('12V-6V-Neg-6V-Pos', 'Class', 'Negative 6 VDC and positive 6 VDC electricity', '6V-Neg-6V-Pos', 'DC-12V', 'http://data.ashrae.org/standard223#12V-6V-Neg-6V-Pos')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('24V-12V-Neg-12V-Pos', 'Class', 'Negative 12 VDC and positive 12 VDC electricity', '12V-Neg-12V-Pos', 'DC-24V', 'http://data.ashrae.org/standard223#24V-12V-Neg-12V-Pos')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('24V-24V-Neg', 'Class', 'Negative 24 VDC electricity', '24V-Neg', 'DC-24V', 'http://data.ashrae.org/standard223#24V-24V-Neg')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('24V-24V-Pos', 'Class', 'Positive 24 VDC electricity', '24V-Pos', 'DC-24V', 'http://data.ashrae.org/standard223#24V-24V-Pos')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('380V-190V-Neg-190V-Pos', 'Class', 'Negative 190 VDC and positive 190 VDC electricity', '190V-Neg-190V-Pos', 'DC-380V', 'http://data.ashrae.org/standard223#380V-190V-Neg-190V-Pos')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('380V-380V-Neg', 'Class', 'Negative 380 VDC electricity', '380V-Neg', 'DC-380V', 'http://data.ashrae.org/standard223#380V-380V-Neg')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('380V-380V-Pos', 'Class', 'Positive 380 VDC electricity', '380V-Pos', 'DC-380V', 'http://data.ashrae.org/standard223#380V-380V-Pos')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('48V-24V-Neg-24V-Pos', 'Class', 'Negative 24 VDC and positive 24 VDC electricity', '24V-Neg-24V-Pos', 'DC-48V', 'http://data.ashrae.org/standard223#48V-24V-Neg-24V-Pos')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('48V-48V-Neg', 'Class', 'Negative 48 VDC electricity', '48V-Neg', 'DC-48V', 'http://data.ashrae.org/standard223#48V-48V-Neg')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('48V-48V-Pos', 'Class', 'Positive 48 VDC electricity', '48V-Pos', 'DC-48V', 'http://data.ashrae.org/standard223#48V-48V-Pos')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('5V-2.5V-Neg-2.5V-Pos', 'Class', 'Negative 2.5 VDC and positive 2.5 VDC electricity', '2.5V-Neg-2.5V-Pos', 'DC-5V', 'http://data.ashrae.org/standard223#5V-2.5V-Neg-2.5V-Pos')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('5V-5V-Neg', 'Class', 'Negative 5 VDC electricity', '5V-Neg', 'DC-5V', 'http://data.ashrae.org/standard223#5V-5V-Neg')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('5V-5V-Pos', 'Class', 'Positive 5 VDC electricity', '5V-Pos', 'DC-5V', 'http://data.ashrae.org/standard223#5V-5V-Pos')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('6V-3V-Neg-3V-Pos', 'Class', 'Negative 3 VDC and positive 3 VDC electricity', '3V-Neg-3V-Pos', 'DC-6V', 'http://data.ashrae.org/standard223#6V-3V-Neg-3V-Pos')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('6V-6V-Neg', 'Class', 'Negative 6 VDC electricity', '6V-Neg', 'DC-6V', 'http://data.ashrae.org/standard223#6V-6V-Neg')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('6V-6V-Pos', 'Class', 'Positive 6 VDC electricity', '6V-Pos', 'DC-6V', 'http://data.ashrae.org/standard223#6V-6V-Pos')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AbstractClass', 'Class', 'Abstract class', 'This is a modeling construct. Instances of abstract classes cannot be created. All abstract classes in this standard have a more specific subclass.', 'Class', 'http://data.ashrae.org/standard223#AbstractClass')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-10000VLL-1Ph-60Hz', 'Class', 'AC-10000VLL-1Ph-60Hz', '`AC-10000VLL-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-10000VLL-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-10000VLL-3Ph-60Hz', 'Class', 'AC-10000VLL-3Ph-60Hz', '`AC-10000VLL-3Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-10000VLL-3Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-10000VLL-5770VLN-1Ph-60Hz', 'Class', 'AC-10000VLL-5770VLN-1Ph-60Hz', '`AC-10000VLL-5770VLN-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-10000VLL-5770VLN-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-10000VLL-5770VLN-3Ph-60Hz', 'Class', 'AC-10000VLL-5770VLN-3Ph-60Hz', '`AC-10000VLL-5770VLN-3Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-10000VLL-5770VLN-3Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-110VLN-1Ph-50Hz', 'Class', 'AC-110VLN-1Ph-50Hz', '`AC-110VLN-1Ph-50Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-110VLN-1Ph-50Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-120VLN-1Ph-60Hz', 'Class', 'AC-120VLN-1Ph-60Hz', '`AC-120VLN-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-120VLN-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-127VLN-1Ph-50Hz', 'Class', 'AC-127VLN-1Ph-50Hz', '`AC-127VLN-1Ph-50Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-127VLN-1Ph-50Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-139VLN-1Ph-50Hz', 'Class', 'AC-139VLN-1Ph-50Hz', '`AC-139VLN-1Ph-50Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-139VLN-1Ph-50Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-1730VLN-1Ph-60Hz', 'Class', 'AC-1730VLN-1Ph-60Hz', '`AC-1730VLN-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-1730VLN-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-1900VLN-1Ph-60Hz', 'Class', 'AC-1900VLN-1Ph-60Hz', '`AC-1900VLN-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-1900VLN-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-190VLL-110VLN-1Ph-50Hz', 'Class', 'AC-190VLL-110VLN-1Ph-50Hz', '`AC-190VLL-110VLN-1Ph-50Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-190VLL-110VLN-1Ph-50Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-190VLL-110VLN-3Ph-50Hz', 'Class', 'AC-190VLL-110VLN-3Ph-50Hz', '`AC-190VLL-110VLN-3Ph-50Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-190VLL-110VLN-3Ph-50Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-190VLL-1Ph-50Hz', 'Class', 'AC-190VLL-1Ph-50Hz', '`AC-190VLL-1Ph-50Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-190VLL-1Ph-50Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-190VLL-3Ph-50Hz', 'Class', 'AC-190VLL-3Ph-50Hz', '`AC-190VLL-3Ph-50Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-190VLL-3Ph-50Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-208VLL-120VLN-1Ph-60Hz', 'Class', 'AC-208VLL-120VLN-1Ph-60Hz', '`AC-208VLL-120VLN-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-208VLL-120VLN-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-208VLL-120VLN-3Ph-60Hz', 'Class', 'AC-208VLL-120VLN-3Ph-60Hz', '`AC-208VLL-120VLN-3Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-208VLL-120VLN-3Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-208VLL-1Ph-60Hz', 'Class', 'AC-208VLL-1Ph-60Hz', '`AC-208VLL-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-208VLL-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-208VLL-3Ph-60Hz', 'Class', 'AC-208VLL-3Ph-60Hz', '`AC-208VLL-3Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-208VLL-3Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-208VLN-1Ph-60Hz', 'Class', 'AC-208VLN-1Ph-60Hz', '`AC-208VLN-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-208VLN-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-219VLN-1Ph-60Hz', 'Class', 'AC-219VLN-1Ph-60Hz', '`AC-219VLN-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-219VLN-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-220VLL-127VLN-1Ph-50Hz', 'Class', 'AC-220VLL-127VLN-1Ph-50Hz', '`AC-220VLL-127VLN-1Ph-50Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-220VLL-127VLN-1Ph-50Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-220VLL-127VLN-3Ph-50Hz', 'Class', 'AC-220VLL-127VLN-3Ph-50Hz', '`AC-220VLL-127VLN-3Ph-50Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-220VLL-127VLN-3Ph-50Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-220VLL-1Ph-50Hz', 'Class', 'AC-220VLL-1Ph-50Hz', '`AC-220VLL-1Ph-50Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-220VLL-1Ph-50Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-220VLL-3Ph-50Hz', 'Class', 'AC-220VLL-3Ph-50Hz', '`AC-220VLL-3Ph-50Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-220VLL-3Ph-50Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-230VLN-1Ph-50Hz', 'Class', 'AC-230VLN-1Ph-50Hz', '`AC-230VLN-1Ph-50Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-230VLN-1Ph-50Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-2400VLN-1Ph-60Hz', 'Class', 'AC-2400VLN-1Ph-60Hz', '`AC-2400VLN-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-2400VLN-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-240VLL-120VLN-1Ph-60Hz', 'Class', 'AC-240VLL-120VLN-1Ph-60Hz', '`AC-240VLL-120VLN-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-240VLL-120VLN-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-240VLL-139VLN-1Ph-50Hz', 'Class', 'AC-240VLL-139VLN-1Ph-50Hz', '`AC-240VLL-139VLN-1Ph-50Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-240VLL-139VLN-1Ph-50Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-240VLL-139VLN-3Ph-50Hz', 'Class', 'AC-240VLL-139VLN-3Ph-50Hz', '`AC-240VLL-139VLN-3Ph-50Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-240VLL-139VLN-3Ph-50Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-240VLL-1Ph-50Hz', 'Class', 'AC-240VLL-1Ph-50Hz', '`AC-240VLL-1Ph-50Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-240VLL-1Ph-50Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-240VLL-1Ph-60Hz', 'Class', 'AC-240VLL-1Ph-60Hz', '`AC-240VLL-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-240VLL-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-240VLL-208VLN-120VLN-1Ph-60Hz', 'Class', 'AC-240VLL-208VLN-120VLN-1Ph-60Hz', '`AC-240VLL-208VLN-120VLN-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-240VLL-208VLN-120VLN-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-240VLL-208VLN-120VLN-3Ph-60Hz', 'Class', 'AC-240VLL-208VLN-120VLN-3Ph-60Hz', '`AC-240VLL-208VLN-120VLN-3Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-240VLL-208VLN-120VLN-3Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-240VLL-3Ph-50Hz', 'Class', 'AC-240VLL-3Ph-50Hz', '`AC-240VLL-3Ph-50Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-240VLL-3Ph-50Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-240VLL-3Ph-60Hz', 'Class', 'AC-240VLL-3Ph-60Hz', '`AC-240VLL-3Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-240VLL-3Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-240VLN-1Ph-50Hz', 'Class', 'AC-240VLN-1Ph-50Hz', '`AC-240VLN-1Ph-50Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-240VLN-1Ph-50Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-24VLN-1Ph-50Hz', 'Class', 'AC-24VLN-1Ph-50Hz', '`AC-24VLN-1Ph-50Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-24VLN-1Ph-50Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-24VLN-1Ph-60Hz', 'Class', 'AC-24VLN-1Ph-60Hz', '`AC-24VLN-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-24VLN-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-277VLN-1Ph-60Hz', 'Class', 'AC-277VLN-1Ph-60Hz', '`AC-277VLN-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-277VLN-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-3000VLL-1730VLN-1Ph-60Hz', 'Class', 'AC-3000VLL-1730VLN-1Ph-60Hz', '`AC-3000VLL-1730VLN-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-3000VLL-1730VLN-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-3000VLL-1730VLN-3Ph-60Hz', 'Class', 'AC-3000VLL-1730VLN-3Ph-60Hz', '`AC-3000VLL-1730VLN-3Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-3000VLL-1730VLN-3Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-3000VLL-1Ph-60Hz', 'Class', 'AC-3000VLL-1Ph-60Hz', '`AC-3000VLL-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-3000VLL-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-3000VLL-3Ph-60Hz', 'Class', 'AC-3000VLL-3Ph-60Hz', '`AC-3000VLL-3Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-3000VLL-3Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-3300VLL-1900VLN-1Ph-60Hz', 'Class', 'AC-3300VLL-1900VLN-1Ph-60Hz', '`AC-3300VLL-1900VLN-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-3300VLL-1900VLN-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-3300VLL-1900VLN-3Ph-60Hz', 'Class', 'AC-3300VLL-1900VLN-3Ph-60Hz', '`AC-3300VLL-1900VLN-3Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-3300VLL-1900VLN-3Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-3300VLL-1Ph-60Hz', 'Class', 'AC-3300VLL-1Ph-60Hz', '`AC-3300VLL-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-3300VLL-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-3300VLL-3Ph-60Hz', 'Class', 'AC-3300VLL-3Ph-60Hz', '`AC-3300VLL-3Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-3300VLL-3Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-3460VLN-1Ph-60Hz', 'Class', 'AC-3460VLN-1Ph-60Hz', '`AC-3460VLN-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-3460VLN-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-347VLN-1Ph-60Hz', 'Class', 'AC-347VLN-1Ph-60Hz', '`AC-347VLN-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-347VLN-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-380VLL-1Ph-60Hz', 'Class', 'AC-380VLL-1Ph-60Hz', '`AC-380VLL-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-380VLL-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-380VLL-219VLN-1Ph-60Hz', 'Class', 'AC-380VLL-219VLN-1Ph-60Hz', '`AC-380VLL-219VLN-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-380VLL-219VLN-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-380VLL-219VLN-3Ph-60Hz', 'Class', 'AC-380VLL-219VLN-3Ph-60Hz', '`AC-380VLL-219VLN-3Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-380VLL-219VLN-3Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-380VLL-3Ph-60Hz', 'Class', 'AC-380VLL-3Ph-60Hz', '`AC-380VLL-3Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-380VLL-3Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-3810VLN-1Ph-60Hz', 'Class', 'AC-3810VLN-1Ph-60Hz', '`AC-3810VLN-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-3810VLN-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-400VLL-1Ph-50Hz', 'Class', 'AC-400VLL-1Ph-50Hz', '`AC-400VLL-1Ph-50Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-400VLL-1Ph-50Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-400VLL-230VLN-1Ph-50Hz', 'Class', 'AC-400VLL-230VLN-1Ph-50Hz', '`AC-400VLL-230VLN-1Ph-50Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-400VLL-230VLN-1Ph-50Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-400VLL-230VLN-3Ph-50Hz', 'Class', 'AC-400VLL-230VLN-3Ph-50Hz', '`AC-400VLL-230VLN-3Ph-50Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-400VLL-230VLN-3Ph-50Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-400VLL-3Ph-50Hz', 'Class', 'AC-400VLL-3Ph-50Hz', '`AC-400VLL-3Ph-50Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-400VLL-3Ph-50Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-415VLL-1Ph-50Hz', 'Class', 'AC-415VLL-1Ph-50Hz', '`AC-415VLL-1Ph-50Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-415VLL-1Ph-50Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-415VLL-240VLN-1Ph-50Hz', 'Class', 'AC-415VLL-240VLN-1Ph-50Hz', '`AC-415VLL-240VLN-1Ph-50Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-415VLL-240VLN-1Ph-50Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-415VLL-240VLN-3Ph-50Hz', 'Class', 'AC-415VLL-240VLN-3Ph-50Hz', '`AC-415VLL-240VLN-3Ph-50Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-415VLL-240VLN-3Ph-50Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-415VLL-3Ph-50Hz', 'Class', 'AC-415VLL-3Ph-50Hz', '`AC-415VLL-3Ph-50Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-415VLL-3Ph-50Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-4160VLL-1Ph-60Hz', 'Class', 'AC-4160VLL-1Ph-60Hz', '`AC-4160VLL-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-4160VLL-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-4160VLL-2400VLN-1Ph-60Hz', 'Class', 'AC-4160VLL-2400VLN-1Ph-60Hz', '`AC-4160VLL-2400VLN-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-4160VLL-2400VLN-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-4160VLL-2400VLN-3Ph-60Hz', 'Class', 'AC-4160VLL-2400VLN-3Ph-60Hz', '`AC-4160VLL-2400VLN-3Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-4160VLL-2400VLN-3Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-4160VLL-3Ph-60Hz', 'Class', 'AC-4160VLL-3Ph-60Hz', '`AC-4160VLL-3Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-4160VLL-3Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-480VLL-1Ph-60Hz', 'Class', 'AC-480VLL-1Ph-60Hz', '`AC-480VLL-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-480VLL-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-480VLL-277VLN-1Ph-60Hz', 'Class', 'AC-480VLL-277VLN-1Ph-60Hz', '`AC-480VLL-277VLN-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-480VLL-277VLN-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-480VLL-277VLN-3Ph-60Hz', 'Class', 'AC-480VLL-277VLN-3Ph-60Hz', '`AC-480VLL-277VLN-3Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-480VLL-277VLN-3Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-480VLL-3Ph-60Hz', 'Class', 'AC-480VLL-3Ph-60Hz', '`AC-480VLL-3Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-480VLL-3Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-5770VLN-1Ph-60Hz', 'Class', 'AC-5770VLN-1Ph-60Hz', '`AC-5770VLN-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-5770VLN-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-6000VLL-1Ph-60Hz', 'Class', 'AC-6000VLL-1Ph-60Hz', '`AC-6000VLL-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-6000VLL-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-6000VLL-3460VLN-1Ph-60Hz', 'Class', 'AC-6000VLL-3460VLN-1Ph-60Hz', '`AC-6000VLL-3460VLN-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-6000VLL-3460VLN-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-6000VLL-3460VLN-3Ph-60Hz', 'Class', 'AC-6000VLL-3460VLN-3Ph-60Hz', '`AC-6000VLL-3460VLN-3Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-6000VLL-3460VLN-3Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-6000VLL-3Ph-60Hz', 'Class', 'AC-6000VLL-3Ph-60Hz', '`AC-6000VLL-3Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-6000VLL-3Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-600VLL-1Ph-60Hz', 'Class', 'AC-600VLL-1Ph-60Hz', '`AC-600VLL-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-600VLL-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-600VLL-347VLN-1Ph-60Hz', 'Class', 'AC-600VLL-347VLN-1Ph-60Hz', '`AC-600VLL-347VLN-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-600VLL-347VLN-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-600VLL-347VLN-3Ph-60Hz', 'Class', 'AC-600VLL-347VLN-3Ph-60Hz', '`AC-600VLL-347VLN-3Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-600VLL-347VLN-3Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-600VLL-3Ph-60Hz', 'Class', 'AC-600VLL-3Ph-60Hz', '`AC-600VLL-3Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-600VLL-3Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-6600VLL-1Ph-60Hz', 'Class', 'AC-6600VLL-1Ph-60Hz', '`AC-6600VLL-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-6600VLL-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-6600VLL-3810VLN-1Ph-60Hz', 'Class', 'AC-6600VLL-3810VLN-1Ph-60Hz', '`AC-6600VLL-3810VLN-1Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-6600VLL-3810VLN-1Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-6600VLL-3810VLN-3Ph-60Hz', 'Class', 'AC-6600VLL-3810VLN-3Ph-60Hz', '`AC-6600VLL-3810VLN-3Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-6600VLL-3810VLN-3Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AC-6600VLL-3Ph-60Hz', 'Class', 'AC-6600VLL-3Ph-60Hz', '`AC-6600VLL-3Ph-60Hz`', 'Electricity-AC', 'http://data.ashrae.org/standard223#AC-6600VLL-3Ph-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ActuatableProperty', 'Class', 'Actuatable property', 'The term "actuatable" implies that writing to the `ActuatableProperty` value will directly trigger a physical actuation by either an `Actuator` or `Equipment`. In contrast, the term "observable" (see {s223:ObservableProperty}) implies that reading the `ObservableProperty` value will return the result of a physical observation.', 'Property', 'http://data.ashrae.org/standard223#ActuatableProperty')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('actuatedByProperty', 'Relation', 'actuated by property', 'A `Relation` that associates a piece of `Equipment` with the `ActuatableProperty` that it responds to. If the `Equipment` is an `Actuator` (a subclass of `Equipment`), `actuatedByProperty` is a required relation. An `Actuator` may also identify another piece of `Equipment` being actuated (see {s223:actuates}).', NULL, 'http://data.ashrae.org/standard223#actuatedByProperty')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('actuates', 'Relation', 'actuates', 'A `Relation` that associates an `Actuator` with the `Equipment` that it actuates.', NULL, 'http://data.ashrae.org/standard223#actuates')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Actuator', 'Class', 'Actuator', 'A piece of `Equipment` that receives control signals and electrically, pneumatically, or hydraulically makes changes in the physical world, such as the position of a valve or damper.', 'Equipment', 'http://data.ashrae.org/standard223#Actuator')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AirHandlingUnit', 'Class', 'Air handling unit', 'A piece of `Equipment` consisting of a fan or fans and other equipment necessary to perform one or more of the following functions: circulating, filtration, heating, cooling, heat recovery, humidifying, dehumidifying, and mixing of air.', 'Equipment', 'http://data.ashrae.org/standard223#AirHandlingUnit')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AirHeatExchanger', 'Class', 'Air heat exchanger', 'A piece of `Equipment` that transfers heat from one air stream to another while keeping the two media separate.', 'Equipment', 'http://data.ashrae.org/standard223#AirHeatExchanger')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('AirToAirHeatPump', 'Class', 'Air-to-air heat pump', 'A `HeatPump` that transfers thermal energy between two bodies of air.', 'HeatPump', 'http://data.ashrae.org/standard223#AirToAirHeatPump')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Aspect-Alarm', 'Class', 'Alarm', 'The property value indicates whether an alarm condition is active or provides details about an active alarm.', 'EnumerationKind-Aspect', 'http://data.ashrae.org/standard223#Aspect-Alarm')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Aspect-CatalogNumber', 'Class', 'Catalog number', 'The property value is a number or other identifier of a product in a manufacturer’s catalog.', 'EnumerationKind-Aspect', 'http://data.ashrae.org/standard223#Aspect-CatalogNumber')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Aspect-Deadband', 'Class', 'Deadband', 'The property value is a range around a setpoint where no control action is taken to avoid unnecessary corrections.', 'EnumerationKind-Aspect', 'http://data.ashrae.org/standard223#Aspect-Deadband')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Aspect-Delta', 'Class', 'Delta', 'The property value is a differential value (e.g., pressure difference) instead of an absolute value.', 'EnumerationKind-Aspect', 'http://data.ashrae.org/standard223#Aspect-Delta')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Aspect-Fault', 'Class', 'Fault', 'The property value is a fault indicator or code that signals a malfunction or issue with the system or equipment.', 'EnumerationKind-Aspect', 'http://data.ashrae.org/standard223#Aspect-Fault')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Aspect-HighLimit', 'Class', 'High limit', 'The property value is an upper threshold used in a control or alarm detection algorithm.', 'EnumerationKind-Aspect', 'http://data.ashrae.org/standard223#Aspect-HighLimit')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Aspect-LowLimit', 'Class', 'Low limit', 'The property value is a lower threshold used in a control or alarm detection algorithm.', 'EnumerationKind-Aspect', 'http://data.ashrae.org/standard223#Aspect-LowLimit')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Aspect-Manufacturer', 'Class', 'Manufacturer', 'The property value is a name or other identifier of the product’s manufacturer.', 'EnumerationKind-Aspect', 'http://data.ashrae.org/standard223#Aspect-Manufacturer')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Aspect-Maximum', 'Class', 'Maximum', 'The property value is a highest specified or observed value. (Examples: upper limit of the specified operating voltage range; maximum measured temperature.)', 'EnumerationKind-Aspect', 'http://data.ashrae.org/standard223#Aspect-Maximum')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Aspect-Minimum', 'Class', 'Minimum', 'The property value is a lowest specified or observed value. (Examples: lower limit of the specified operating voltage range; minimum measured temperature.)', 'EnumerationKind-Aspect', 'http://data.ashrae.org/standard223#Aspect-Minimum')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Aspect-Model', 'Class', 'Model', 'The property value is a model identifier of the product.', 'EnumerationKind-Aspect', 'http://data.ashrae.org/standard223#Aspect-Model')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Aspect-Nominal', 'Class', 'Nominal', 'The property value is a value that is expected or desired under normal operating conditions, but may not reflect the actual value at all times. (Example: nominal voltage.)', 'EnumerationKind-Aspect', 'http://data.ashrae.org/standard223#Aspect-Nominal')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Aspect-OperatingMode', 'Class', 'Operating mode', 'The property value is the current intended mode of operation, such as ''Automatic'', ''On'', or ''Off''.', 'EnumerationKind-Aspect', 'http://data.ashrae.org/standard223#Aspect-OperatingMode')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Aspect-OperatingStatus', 'Class', 'Operating status', 'The property value is the current operational status of the system or equipment, such as ''Running,'' ''Stopped,'' or ''Maintenance Mode.''', 'EnumerationKind-Aspect', 'http://data.ashrae.org/standard223#Aspect-OperatingStatus')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Aspect-Rated', 'Class', 'Rated', 'The property value indicates a limit for continuous safe operation set by the manufacturer, but may not reflect the actual value at all times. (Example: rated voltage.)', 'EnumerationKind-Aspect', 'http://data.ashrae.org/standard223#Aspect-Rated')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Aspect-SerialNumber', 'Class', 'Serial number', 'The property value is the serial number assigned by the manufacturer to the system or equipment.', 'EnumerationKind-Aspect', 'http://data.ashrae.org/standard223#Aspect-SerialNumber')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Aspect-Setpoint', 'Class', 'Setpoint', 'The property value is a target value for a control algorithm.', 'EnumerationKind-Aspect', 'http://data.ashrae.org/standard223#Aspect-Setpoint')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Aspect-Threshold', 'Class', 'Threshold', 'The property value is a threshold used in a control algorithm.', 'EnumerationKind-Aspect', 'http://data.ashrae.org/standard223#Aspect-Threshold')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('BACnetExternalReference', 'Class', 'BACnet external reference', 'An `ExternalReference` that contains BACnet protocol parameter values necessary to associate a `Property` with a value.', 'ExternalReference', 'http://data.ashrae.org/standard223#BACnetExternalReference')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Bathtub', 'Class', 'Bathtub', 'A piece of `Equipment` for bathing that receives as an input hot or cold water dispensed from one or two `Faucet`s, and is designed to hold a specific volume of water and release the held water through a `Drain`.', 'Equipment', 'http://data.ashrae.org/standard223#Bathtub')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Battery', 'Class', 'Battery', 'A piece of `Equipment` that stores a defined amount of chemical energy that can be converted to electrical energy via a chemical process. This process, typically referred to as discharging, produces a specific electrical voltage and current.', 'Equipment', 'http://data.ashrae.org/standard223#Battery')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('BidirectionalConnectionPoint', 'Class', 'Bidirectional connection point', 'A `BidirectionalConnectionPoint` is a `ConnectionPoint` for which a `Substance-Medium` is expected to flow either into or out of the associated `Connectable`.', 'ConnectionPoint', 'http://data.ashrae.org/standard223#BidirectionalConnectionPoint')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Binary-Logical', 'Class', 'Logical', 'This class and its enumerated subclasses represent the possible values of a logical `Property`, e.g., True or False. : Binary-Logical Enumerations | Enumeration | |:-----------| | `Logical-False` | | `Logical-True` |', 'EnumerationKind-Binary', 'http://data.ashrae.org/standard223#Binary-Logical')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Binary-OnOff', 'Class', 'On/off', 'This class and its enumerated subclasses represent basic operational states, e.g., On or Off. : Binary-OnOff Enumerations | Enumeration | |:-----------| | `OnOff-Off` | | `OnOff-On` |', 'EnumerationKind-Binary', 'http://data.ashrae.org/standard223#Binary-OnOff')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Binary-Position', 'Class', 'Position', 'This class and its enumerated subclasses represent basic positional states, e.g., Open or Closed. : Binary-Position Enumerations | Enumeration | |:-----------| | `Position-Closed` | | `Position-Open` |', 'EnumerationKind-Binary', 'http://data.ashrae.org/standard223#Binary-Position')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Boiler', 'Class', 'Boiler', 'A piece of `Equipment` that uses fuel or electricity to heat water or other fluids and supply steam or hot water for heating, humidification, or other applications.', 'Equipment', 'http://data.ashrae.org/standard223#Boiler')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ChilledBeam', 'Class', 'Chilled beam', 'A piece of `Equipment` with a colder surface temperature where air passes through, and air movement is induced in the room to achieve cooling. Cooling medium is generally water.', 'Equipment', 'http://data.ashrae.org/standard223#ChilledBeam')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Chiller', 'Class', 'Chiller', 'A piece of `Equipment` that removes heat from a liquid coolant via a vapor-compression, adsorption refrigeration, or absorption refrigeration cycles.', 'Equipment', 'http://data.ashrae.org/standard223#Chiller')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Class', 'Concept', 'Class', 'This is a modeling construct. All classes defined in the 223 standard are instances of `Class`.', 'Concept', 'http://data.ashrae.org/standard223#Class')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ClothesWasher', 'Class', 'Clothes washer', 'A piece of `Equipment` that automatically cleans a load of textiles (e.g., clothing, bedding).', 'Equipment', 'http://data.ashrae.org/standard223#ClothesWasher')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('cnx', 'Relation', 'cnx', 'A `Relation` that associates adjacent entities in a connection path, comprised of `Equipment`-`ConnectionPoint`-`Connection`-`ConnectionPoint`-`Equipment` sequences.', NULL, 'http://data.ashrae.org/standard223#cnx')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('CoaxialCable', 'Class', 'Coaxial cable', 'A type of `Waveguide` that consists of a central conductor, surrounded by an insulator, a metallic shield, and an outer jacket, all sharing the same geometric axis - which allows it to efficiently transmit high-frequency signals over long distances with minimal interference - and is used for `Wideband-DOCSIS` and `Wideband-CATV` communication.', 'Waveguide', 'http://data.ashrae.org/standard223#CoaxialCable')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('CoffeeMaker', 'Class', 'Coffee maker', 'A piece of `Equipment` that automatically brews coffee.', 'Equipment', 'http://data.ashrae.org/standard223#CoffeeMaker')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Coil', 'Class', 'Coil', 'A piece of `Equipment` consisting of a pipe or tube that is formed into a helical or serpentine shape, may or may not be finned, and is used in cooling or heating equipment. A `Coil` shall conform to exactly one of the following patterns: - **Pattern 1:** - The `Coil` has exactly two inlet connection points using the medium `Mix-Fluid`, with exactly one being `Fluid-Air`. - The `Coil` has exactly two outlet connection points using the medium `Mix-Fluid`, with exactly one being `Fluid-Air`. - **Pattern 2:** - The Coil has exactly one inlet connection point using the medium `Mix-Fluid`. - The Coil has exactly one outlet connection point using the medium `Mix-Fluid`. - The Coil has one or two bidirectional connection points using the medium `Mix-Fluid` or `Medium-ThermalContact`. - **Pattern 3:** - The Coil has exactly three bidirectional connection points using the medium `Mix-Fluid` or `Medium-ThermalContact`.', 'Equipment', 'http://data.ashrae.org/standard223#Coil')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('composedOf', 'Relation', 'composed of', 'The relation `composedOf` is used to indicate what substances constitute a material. Allowable values are instances of `Property` that in turn identify constituents defined in `Medium-Constituent` (see {s223:Medium-Constituent}) via the relation `ofConstituent`.', NULL, 'http://data.ashrae.org/standard223#composedOf')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Compressor', 'Class', 'Compressor', 'A piece of `Equipment` that mechanically increases the pressure of a gas.', 'Equipment', 'http://data.ashrae.org/standard223#Compressor')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Computer', 'Class', 'Computer', 'A piece of `Equipment` that can be programmed to automatically carry out sequences of arithmetic or logical operations (computation). Modern digital electronic computers can perform generic sets of operations known as programs. These programs enable computers to perform a wide range of tasks.', 'Equipment', 'http://data.ashrae.org/standard223#Computer')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ComputerPrinter', 'Class', 'Computer printer', 'A piece of `Equipment` that processes an input electrical or RF signal, typically from a `Computer`, and outputs a durable representation of information, typically text and/or graphics, typically on paper.', 'Equipment', 'http://data.ashrae.org/standard223#ComputerPrinter')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ConcentrationSensor', 'Class', 'Concentration sensor', 'A `Sensor` that `observes` a `QuantifiableObservableProperty` that represents a concentration of a miscible constituent in a medium, in contrast to a `ParticulateSensor` that `observes` a `QuantifiableObservableProperty` that represents an amount of a particulate in a medium (see {s223:ParticulateSensor}). The 223 standard does not constrain the `Unit` or `QuantityKind` reported by a `ConcentrationSensor`, but possible `QuantityKind`s include `Concentration` (moles per volume), `Density` (mass per volume), `MoleFraction`, and `VolumeFraction`.', 'Sensor', 'http://data.ashrae.org/standard223#ConcentrationSensor')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Concept', 'Class', 'Concept', 'All classes and relations defined in the 223 standard are subclasses of `Concept`.', NULL, 'http://data.ashrae.org/standard223#Concept')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Conductor', 'Class', 'Conductor', 'A `Connection` that represents one or more wires used to convey `Constituent-Electricity`. Each instance of `Conductor` applies to no more than one electrical circuit.', 'Connection', 'http://data.ashrae.org/standard223#Conductor')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Connectable', 'AbstractClass', 'Connectable', '`Connectable` is an abstract class representing a thing such as `Equipment` (see {s223:Equipment}), `DomainSpace` (see {s223:DomainSpace}), or `Junction` (see {s223:Junction}) that can be `connected` to other `Connectable`s via `ConnectionPoint`s and `Connection`s.', 'Concept', 'http://data.ashrae.org/standard223#Connectable')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('connected', 'Relation', 'connected', 'The relation `connected` indicates that two connectable things are `connected` without regard to the direction of flow.', NULL, 'http://data.ashrae.org/standard223#connected')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('connectedFrom', 'Relation', 'connected from', 'The relation `connectedFrom` indicates that connectable things are `connected` with a specific direction of flow. B is `connectedFrom` A, means that the direction of flow is from A to B. The inverse direction is indicated by `connectedTo` (see {s223:connectedTo}).', NULL, 'http://data.ashrae.org/standard223#connectedFrom')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('connectedThrough', 'Relation', 'connected through', 'A `Relation` that associates a `Connectable` thing with a `Connection`, without regard to the direction of flow. It is used to discover what connection links two connectable things.', NULL, 'http://data.ashrae.org/standard223#connectedThrough')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('connectedTo', 'Relation', 'connected to', 'The relation `connectedTo` indicates that connectable things are `connected` with a specific direction of flow. A is `connectedTo` B, means a direction of flow from A to B. The inverse direction is indicated by `connectedFrom` (see {s223:connectedFrom}).', NULL, 'http://data.ashrae.org/standard223#connectedTo')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Connection', 'Class', 'Connection', 'A `Connection` is the modeling construct used to represent the thing (e.g., pipe, duct, conductor, or free space) that is used to convey some Medium (e.g., water, air, electricity, light, Wi-Fi) between two connectable things. All connections have two or more connection points bound to either `Equipment` (see {s223:Equipment}), `DomainSpace` (see {s223:DomainSpace}), or `Junction` (see {s223:Junction}). See Figure 6-2. If the direction of flow is constrained, that constraint is indicated by using one or more `InletConnectionPoint`s (see {s223:InletConnectionPoint}) to represent the inflow points and `OutletConnectionPoint`s (see {s223:OutletConnectionPoint}) to represent the outflow points. A `Connection` may contain branches or intersections. These may be modeled using `Junction`s if it is necessary to identify a specific intersection (see {s223:Junction}). The constraint to maintain compatible mediums among a `Connection` and all of its associated `ConnectionPoint`s gives rise to multiple validation test cases, where the specified medium might be a pure medium, or a mixture with constituents. See {s223:Substance-Medium} for more details. ![Graphical Depiction of Connection.](figures/Figure_5-3_Connection.svg)', 'Concept', 'http://data.ashrae.org/standard223#Connection')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ConnectionPoint', 'AbstractClass', 'Connection point', 'A `ConnectionPoint` is an abstract modeling construct used to represent the fact that one connectable thing can be connected to another connectable thing using a `Connection`. It is the abstract representation of the flange, wire terminal, or other physical feature where a connection is made. `Equipment`, `DomainSpace`s and `Junction`s can have one or more `ConnectionPoint`s (see {s223:Connectable}). A `ConnectionPoint` is constrained to relate to a specific medium such as air, water, or electricity which determines what other things can be connected to it. For example, constraining a `ConnectionPoint` to be for air means it cannot be used for an electrical connection. A `ConnectionPoint` belongs to exactly one connectable thing (see {s223:Connectable}). `ConnectionPoint`s are represented graphically in this standard by a triangle with the point indicating a direction of flow, or a diamond in the case of a bidirectional flow as shown in Figure 6-1. ![Graphical Representation of a ConnectionPoint](figures/Figure_5-2_Graphical_Depiciton_of_Connection_Points.svg)', 'Concept', 'http://data.ashrae.org/standard223#ConnectionPoint')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('connectsAt', 'Relation', 'connects at', 'A `Relation` that associates a `Connection` with a specific `ConnectionPoint`.', NULL, 'http://data.ashrae.org/standard223#connectsAt')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('connectsFrom', 'Relation', 'connects from', 'A `Relation` that associates a `Connectable` thing with a `Connection`, with an implied direction of flow. B `connectsFrom` A indicates a flow from A to B.', NULL, 'http://data.ashrae.org/standard223#connectsFrom')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('connectsThrough', 'Relation', 'connects through', 'A `Relation` that associates a `ConnectionPoint` with a `Connection`, without regard to the direction of flow.', NULL, 'http://data.ashrae.org/standard223#connectsThrough')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('connectsTo', 'Relation', 'connects to', 'A `Relation` that associates a `Connection` with a `Connectable` thing, with an implied direction of flow. A `connectsTo` B indicates a flow from A to B.', NULL, 'http://data.ashrae.org/standard223#connectsTo')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Constituent-Ar', 'Class', 'Ar', 'Argon', 'Medium-Constituent', 'http://data.ashrae.org/standard223#Constituent-Ar')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Constituent-CH4', 'Class', 'CH4', 'Methane', 'Medium-Constituent', 'http://data.ashrae.org/standard223#Constituent-CH4')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Constituent-CO', 'Class', 'CO', 'Carbon monoxide', 'Medium-Constituent', 'http://data.ashrae.org/standard223#Constituent-CO')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Constituent-CO2', 'Class', 'CO2', 'Carbon dioxide', 'Medium-Constituent', 'http://data.ashrae.org/standard223#Constituent-CO2')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Constituent-Electricity', 'Class', 'Electricity', 'This class and its enumerated subclasses represent common forms of electrical energy, including AC, DC, and electrical communication signals. : Constituent-Electricity Enumerations | Enumeration | |:-----------| | `Electricity-AC` (see {s223:Electricity-AC}) | | `Electricity-DC` (see {s223:Electricity-DC}) | | `Electricity-Earth` | | `Electricity-Neutral` | | `Electricity-Signal` (see {s223:Electricity-Signal}) |', 'Medium-Constituent', 'http://data.ashrae.org/standard223#Constituent-Electricity')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Constituent-EM', 'Class', 'EM', 'This class and its enumerated subclasses represent electromagnetic energy at commonly defined frequency ranges. : Constituent-EM Enumerations | Enumeration | |:-----------| | `EM-Light` (see {s223:EM-Light}) | | `EM-Microwave` | | `EM-RF` (see {s223:EM-RF}) |', 'Medium-Constituent', 'http://data.ashrae.org/standard223#Constituent-EM')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Constituent-Glycol', 'Class', 'Glycol', '`Constituent-Glycol`', 'Medium-Constituent', 'http://data.ashrae.org/standard223#Constituent-Glycol')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Constituent-H2O', 'Class', 'H2O', 'Pure water', 'Medium-Constituent', 'http://data.ashrae.org/standard223#Constituent-H2O')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Constituent-H2S', 'Class', 'H2S', 'Hydrogen sulfide', 'Medium-Constituent', 'http://data.ashrae.org/standard223#Constituent-H2S')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Constituent-N2', 'Class', 'N2', 'Nitrogen', 'Medium-Constituent', 'http://data.ashrae.org/standard223#Constituent-N2')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Constituent-NH3', 'Class', 'NH3', 'Ammonia', 'Medium-Constituent', 'http://data.ashrae.org/standard223#Constituent-NH3')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Constituent-NOX', 'Class', 'NOX', 'This class and its enumerated subclasses represent common Nitrogen Oxides (NOx). : Constituent-NOX Enumerations | Enumeration | |:-----------| | `NOX-NO` | | `NOX-NO2` |', 'Medium-Constituent', 'http://data.ashrae.org/standard223#Constituent-NOX')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Constituent-O2', 'Class', 'O2', 'Oxygen', 'Medium-Constituent', 'http://data.ashrae.org/standard223#Constituent-O2')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Constituent-O3', 'Class', 'O3', 'Ozone', 'Medium-Constituent', 'http://data.ashrae.org/standard223#Constituent-O3')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Constituent-Oil', 'Class', 'Oil', 'Oil as an impurity within some `Mix-Fluid`', 'Medium-Constituent', 'http://data.ashrae.org/standard223#Constituent-Oil')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Constituent-Radon', 'Class', 'Radon', 'Radon', 'Medium-Constituent', 'http://data.ashrae.org/standard223#Constituent-Radon')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Constituent-Refrigerant', 'Class', 'Refrigerant', 'This class and its enumerated subclasses represent commonly used refrigerants. The composition of the refrigerants is defined in ASHRAE Standard 34 and ISO 817. : Constituent-Refrigerant Enumerations | Enumeration | |:-----------| | `Refrigerant-R-22` | | `Refrigerant-R-32` | | `Refrigerant-R-123` | | `Refrigerant-R-134A` | | `Refrigerant-R-290` | | `Refrigerant-R-404A` | | `Refrigerant-R-407A` | | `Refrigerant-R-407C` | | `Refrigerant-R-407F` | | `Refrigerant-R-410A` | | `Refrigerant-R-422A` | | `Refrigerant-R-422C` | | `Refrigerant-R-422D` | | `Refrigerant-R-427A` | | `Refrigerant-R-438A` | | `Refrigerant-R-444A` | | `Refrigerant-R-445A` | | `Refrigerant-R-448A` | | `Refrigerant-R-449A` | | `Refrigerant-R-450A` | | `Refrigerant-R-454A` | | `Refrigerant-R-454C` | | `Refrigerant-R-455A` | | `Refrigerant-R-457A` | | `Refrigerant-R-459B` | | `Refrigerant-R-507` | | `Refrigerant-R-513A` | | `Refrigerant-R-516A` | | `Refrigerant-R-600A` | | `Refrigerant-R-717` | | `Refrigerant-R-744` | | `Refrigerant-R-1234yf` | | `Refrigerant-R-1234ze` |', 'Medium-Constituent', 'http://data.ashrae.org/standard223#Constituent-Refrigerant')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Constituent-SO2', 'Class', 'SO2', 'Sulfur dioxide', 'Medium-Constituent', 'http://data.ashrae.org/standard223#Constituent-SO2')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Constituent-VolatileOrganicCompounds', 'Class', 'Volatile organic compounds', '`Constituent-VolatileOrganicCompounds`', 'Medium-Constituent', 'http://data.ashrae.org/standard223#Constituent-VolatileOrganicCompounds')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('contains', 'Relation', 'contains', 'A `Relation` that associates a piece of `Equipment` with its component pieces of `Equipment`, or a `PhysicalSpace` (see {s223:PhysicalSpace}) with its component `PhysicalSpace`s.', NULL, 'http://data.ashrae.org/standard223#contains')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Controller', 'Class', 'Controller', 'A piece of equipment for regulation of a system or component in normal operation, which executes one or more `Function`s.', 'Equipment', 'http://data.ashrae.org/standard223#Controller')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('CoolingCoil', 'Class', 'Cooling coil', 'A `Coil` that is specifically used to cool air.', 'Coil', 'http://data.ashrae.org/standard223#CoolingCoil')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('CoolingTower', 'Class', 'Cooling tower', 'A piece of `Equipment` that uses atmospheric air to cool warm water, generally by direct contact via evaporation.', 'Equipment', 'http://data.ashrae.org/standard223#CoolingTower')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('CopyMachine', 'Class', 'Copy machine', 'A piece of `Equipment` that processes an input of one or more durable representation(s) of information, typically text and/or graphics and typically on paper, and outputs one or more reproductions of the information for each input, typically on paper.', 'Equipment', 'http://data.ashrae.org/standard223#CopyMachine')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('CorrelatedColorTemperatureSensor', 'Class', 'Correlated color temperature sensor', 'A `LightSensor` that `observes` a `QuantifiableObservableProperty` that represents a correlated color temperature (CCT) of a light source, defined as the absolute temperature of a blackbody whose chromaticity most nearly resembles that of the light source.', 'LightSensor', 'http://data.ashrae.org/standard223#CorrelatedColorTemperatureSensor')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Damper', 'Class', 'Damper', 'A piece of `Equipment` inserted into an air distribution system permitting modification of the air resistance of the system and consequently changing the airflow rate or shutting off the airflow.', 'Equipment', 'http://data.ashrae.org/standard223#Damper')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('DayOfWeek-Weekday', 'Class', 'Weekday', 'This class and its enumerated subclasses represent weekdays according to the Gregorian calendar, i.e., Monday, Tuesday, Wednesday, Thursday, and Friday. : DayOfWeek-Weekday Enumerations | Enumeration | |:-----------| | `Weekday-Friday` | | `Weekday-Monday` | | `Weekday-Thursday` | | `Weekday-Tuesday` | | `Weekday-Wednesday` |', 'EnumerationKind-DayOfWeek', 'http://data.ashrae.org/standard223#DayOfWeek-Weekday')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('DayOfWeek-Weekend', 'Class', 'Weekend', 'This class and its enumerated subclasses represent weekend days according to the Gregorian calendar, i.e., Saturday and Sunday. : DayOfWeek-Weekend Enumerations | Enumeration | |:-----------| | `Weekend-Saturday` | | `Weekend-Sunday` |', 'EnumerationKind-DayOfWeek', 'http://data.ashrae.org/standard223#DayOfWeek-Weekend')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('DC-12V', 'Class', '12 VDC electricity', 'This class and its enumerated subclasses represent all polarities of 12 volt DC electricity. : DC-12V Enumerations | Enumeration | |:-----------| | `12V-6V-Neg-6V-Pos` | | `12V-12V-Neg` | | `12V-12V-Pos` |', 'Electricity-DC', 'http://data.ashrae.org/standard223#DC-12V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('DC-24V', 'Class', '24 VDC electricity', 'This class and its enumerated subclasses represent all polarities of 24 volt DC electricity. : DC-24V Enumerations | Enumeration | |:-----------| | `24V-12V-Neg-12V-Pos` | | `24V-24V-Neg` | | `24V-24V-Pos` |', 'Electricity-DC', 'http://data.ashrae.org/standard223#DC-24V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('DC-380V', 'Class', '380 VDC electricity', 'This class and its enumerated subclasses represent all polarities of 380 volt DC electricity. : DC-380V Enumerations | Enumeration | |:-----------| | `380V-190V-Neg-190V-Pos` | | `380V-380V-Neg` | | `380V-380V-Pos` |', 'Electricity-DC', 'http://data.ashrae.org/standard223#DC-380V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('DC-48V', 'Class', '48 VDC electricity', 'This class and its enumerated subclasses represent all polarities of 48 volt DC electricity. : DC-48V Enumerations | Enumeration | |:-----------| | `48V-24V-Neg-24V-Pos` | | `48V-48V-Neg` | | `48V-48V-Pos` |', 'Electricity-DC', 'http://data.ashrae.org/standard223#DC-48V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('DC-5V', 'Class', '5 VDC electricity', 'This class and its enumerated subclasses represent all polarities of 5 volt DC electricity. : DC-5V Enumerations | Enumeration | |:-----------| | `5V-2.5V-Neg-2.5V-Pos` | | `5V-5V-Neg` | | `5V-5V-Pos` |', 'Electricity-DC', 'http://data.ashrae.org/standard223#DC-5V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('DC-6V', 'Class', '6 VDC electricity', 'This class and its enumerated subclasses represent all polarities of 6 volt DC electricity. : DC-6V Enumerations | Enumeration | |:-----------| | `6V-3V-Neg-3V-Pos` | | `6V-6V-Neg` | | `6V-6V-Pos` |', 'Electricity-DC', 'http://data.ashrae.org/standard223#DC-6V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('DC-PoE', 'Class', 'PoE electricity', 'This class and its enumerated subclasses represent standardized types of PoE DC electricity. : DC-PoE Enumerations | Enumeration | |:-----------| | `PoE-802.3af-1` | | `PoE-802.3at-2` | | `PoE-802.3bt-3` | | `PoE-802.3bt-4` |', 'Electricity-DC', 'http://data.ashrae.org/standard223#DC-PoE')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Dishwasher', 'Class', 'Dishwasher', 'A piece of `Equipment` that automatically cleans dishware, cookware, and cutlery.', 'Equipment', 'http://data.ashrae.org/standard223#Dishwasher')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Domain-ConveyanceSystems', 'Class', 'Conveyance systems domain', 'The domain that represents equipment that moves people or things within a building. Example `Domain-ConveyanceSystems` equipment include `Elevator` and `Escalator`.', 'EnumerationKind-Domain', 'http://data.ashrae.org/standard223#Domain-ConveyanceSystems')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Domain-Electrical', 'Class', 'Electrical domain', 'The domain that represents equipment that distributes and monitors electrical power within a building. Example `Domain-Electrical` equipment include `ElectricityBreaker`, `ElectricEnergyConverter`, and `ElectricityMeter`.', 'EnumerationKind-Domain', 'http://data.ashrae.org/standard223#Domain-Electrical')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Domain-FireProtection', 'Class', 'Fire protection domain', 'The domain that represents equipment that detect and mitigate the spread of fire within a building. Example `Domain-FireProtection` equipment include smoke detectors, alarms, and emergency public address systems.', 'EnumerationKind-Domain', 'http://data.ashrae.org/standard223#Domain-FireProtection')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Domain-HVAC', 'Class', 'HVAC domain', 'The domain that represents equipment that condition and ventilate spaces within a building. Example `Domain-HVAC` equipment include `Fan`, `Pump`, and `AirHandlingUnit`.', 'EnumerationKind-Domain', 'http://data.ashrae.org/standard223#Domain-HVAC')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Domain-Lighting', 'Class', 'Lighting domain', 'The domain that represents equipment that illuminate and manage the distribution of light within or outside of a building. Example `Domain-Lighting` equipment include `Luminaire`, `LightSensor`, and `WindowShade`.', 'EnumerationKind-Domain', 'http://data.ashrae.org/standard223#Domain-Lighting')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Domain-Networking', 'Class', 'Networking domain', 'The domain that represents equipment that distributes and manages the flow of communication signals within a building. Example `Domain-Networking` equipment include `EthernetSwitch` and `PowerOverEthernetSwitch`', 'EnumerationKind-Domain', 'http://data.ashrae.org/standard223#Domain-Networking')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Domain-Occupancy', 'Class', 'Occupancy domain', 'The domain that represents equipment that determine whether and how many people are moving or present within a building. Example `Domain-Occupancy` equipment include `OccupantMotionSensor`, `OccupantPresenceSensor` and `OccupantCountSensor`', 'EnumerationKind-Domain', 'http://data.ashrae.org/standard223#Domain-Occupancy')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Domain-PhysicalSecurity', 'Class', 'Physical security domain', 'The domain that represents equipment that control and monitor physical access to spaces within or outside of a building. Example `Domain-PhysicalSecurity` equipment include cameras, keycard sensors, and biometric scanners.', 'EnumerationKind-Domain', 'http://data.ashrae.org/standard223#Domain-PhysicalSecurity')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Domain-Plumbing', 'Class', 'Plumbing domain', 'The domain that represents equipment that distributes, holds, removes and monitors water within or outside of a building. Example `Domain-Plumbing` equipment include `Faucet`, `Sink`, and `FlushToilet`.', 'EnumerationKind-Domain', 'http://data.ashrae.org/standard223#Domain-Plumbing')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Domain-Refrigeration', 'Class', 'Refrigeration domain', 'The domain that represents equipment that maintain internal temperatures below the surrounding ambient temperature with a building. Example `Domain-Refrigeration` equipment include `Refrigerator` and `Freezer`', 'EnumerationKind-Domain', 'http://data.ashrae.org/standard223#Domain-Refrigeration')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('DomainSpace', 'Class', 'Domain space', 'A portion of a `PhysicalSpace` that is affected by a building service associated with a domain. `DomainSpace`s may represent an entire `PhysicalSpace` or any portion of a `PhysicalSpace` (see {s223:PhysicalSpace}). Multiple `DomainSpace`s of the same domain may overlap, and `DomainSpace`s of different domains may also overlap, but `DomainSpace`s can not overlap multiple `PhysicalSpace`s. `DomainSpace`s may be grouped into `Zone`s using the relation `hasDomainSpace` (see {s223:hasDomainSpace}).', 'Connectable', 'http://data.ashrae.org/standard223#DomainSpace')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Door', 'Class', 'Door', 'A piece of `Equipment` consisting of hinged, sliding, or revolving barrier at the entrance to a building or room.', 'Equipment', 'http://data.ashrae.org/standard223#Door')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Drain', 'Class', 'Drain', 'A `Valve` that allows, regulates, or stops the flow of water from a `Sink`, `Shower`, `Bathtub`, or other plumbing service equipment into a plumbing drainage system that typically carries the mixture to a sewer system or septic tank.', 'Valve', 'http://data.ashrae.org/standard223#Drain')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('DualDuctTerminal', 'Class', 'Dual duct terminal', 'A `TerminalUnit` that mixes two independent sources of primary air.', 'TerminalUnit', 'http://data.ashrae.org/standard223#DualDuctTerminal')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Duct', 'Class', 'Duct', 'A `Connection` that is used to transport air such as supply, return, and exhaust in HVAC (Heating, Ventilation, and Air Conditioning) systems.', 'Connection', 'http://data.ashrae.org/standard223#Duct')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('DuvSensor', 'Class', 'Duv sensor', 'A `LightSensor` that `observes` a `QuantifiableObservableProperty` that represents a Duv of a light source, defined as the distance between the chromaticity of the light source and a blackbody radiator of equal correlated color temperature (CCT).', 'LightSensor', 'http://data.ashrae.org/standard223#DuvSensor')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ElectricalPhaseIdentifier-A', 'Class', 'Electrical phase identifier A', 'ElectricalPhaseIdentifier-A', 'EnumerationKind-ElectricalPhaseIdentifier', 'http://data.ashrae.org/standard223#ElectricalPhaseIdentifier-A')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ElectricalPhaseIdentifier-AB', 'Class', 'Electrical phase identifier AB', 'ElectricalPhaseIdentifier-AB', 'EnumerationKind-ElectricalPhaseIdentifier', 'http://data.ashrae.org/standard223#ElectricalPhaseIdentifier-AB')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ElectricalPhaseIdentifier-ABC', 'Class', 'Electrical phase identifier ABC', 'ElectricalPhaseIdentifier-ABC', 'EnumerationKind-ElectricalPhaseIdentifier', 'http://data.ashrae.org/standard223#ElectricalPhaseIdentifier-ABC')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ElectricalPhaseIdentifier-B', 'Class', 'Electrical phase identifier B', 'ElectricalPhaseIdentifier-B', 'EnumerationKind-ElectricalPhaseIdentifier', 'http://data.ashrae.org/standard223#ElectricalPhaseIdentifier-B')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ElectricalPhaseIdentifier-BC', 'Class', 'Electrical phase identifier BC', 'ElectricalPhaseIdentifier-BC', 'EnumerationKind-ElectricalPhaseIdentifier', 'http://data.ashrae.org/standard223#ElectricalPhaseIdentifier-BC')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ElectricalPhaseIdentifier-C', 'Class', 'Electrical phase identifier C', 'ElectricalPhaseIdentifier-C', 'EnumerationKind-ElectricalPhaseIdentifier', 'http://data.ashrae.org/standard223#ElectricalPhaseIdentifier-C')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ElectricalPhaseIdentifier-CA', 'Class', 'Electrical phase identifier CA', 'ElectricalPhaseIdentifier-CA', 'EnumerationKind-ElectricalPhaseIdentifier', 'http://data.ashrae.org/standard223#ElectricalPhaseIdentifier-CA')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ElectricClothesDryer', 'Class', 'Electric clothes dryer', 'A piece of `Equipment` that automatically removes moisture from a load of textiles (e.g., clothing, bedding), typically after they are washed in a `ClothesWasher`.', 'Equipment', 'http://data.ashrae.org/standard223#ElectricClothesDryer')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ElectricCooktop', 'Class', 'Electric cooktop', 'A piece of `Equipment` with a flat surface containing one or more heat sources designed for cooking with pots and pans.', 'Equipment', 'http://data.ashrae.org/standard223#ElectricCooktop')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ElectricCurrentSensor', 'Class', 'Electric current sensor', 'A `Sensor` that `observes` a `QuantifiableObservableProperty` that represents a measure of electric current.', 'Sensor', 'http://data.ashrae.org/standard223#ElectricCurrentSensor')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ElectricEnergyConverter', 'Class', 'Electric energy converter', 'A piece of `Equipment` that converts one form of electric power to another form of electric power.', 'Equipment', 'http://data.ashrae.org/standard223#ElectricEnergyConverter')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ElectricEnergyDCDCConverter', 'Class', 'DC-DC converter', 'An `ElectricEnergyConverter` that transforms direct current (DC) electric power from one voltage to another voltage.', 'ElectricEnergyConverter', 'http://data.ashrae.org/standard223#ElectricEnergyDCDCConverter')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ElectricEnergyInverter', 'Class', 'Electric energy inverter', 'An `ElectricEnergyConverter` that tranforms direct current (DC) electric power to alternating current (AC) electric power, or vice versa.', 'ElectricEnergyConverter', 'http://data.ashrae.org/standard223#ElectricEnergyInverter')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ElectricEnergyTransformer', 'Class', 'Electric energy transformer', 'An `ElectricEnergyConverter` that transforms alternating current (AC) electric power from one voltage to another voltage.', 'ElectricEnergyConverter', 'http://data.ashrae.org/standard223#ElectricEnergyTransformer')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Electricity-AC', 'Class', 'AC electricity', 'This class and its enumerated subclasses represent common AC electricity services. : Electricity-AC Enumerations | Enumeration | |:-----------| | `AC-24VLN-1Ph-50Hz` | | `AC-24VLN-1Ph-60Hz` | | `AC-110VLN-1Ph-50Hz` | | `AC-120VLN-1Ph-60Hz` | | `AC-127VLN-1Ph-50Hz` | | `AC-139VLN-1Ph-50Hz` | | `AC-190VLL-1Ph-50Hz` | | `AC-190VLL-3Ph-50Hz` | | `AC-190VLL-110VLN-1Ph-50Hz` | | `AC-190VLL-110VLN-3Ph-50Hz` | | `AC-208VLL-1Ph-60Hz` | | `AC-208VLL-3Ph-60Hz` | | `AC-208VLL-120VLN-1Ph-60Hz` | | `AC-208VLL-120VLN-3Ph-60Hz` | | `AC-208VLN-1Ph-60Hz` | | `AC-219VLN-1Ph-60Hz` | | `AC-220VLL-1Ph-50Hz` | | `AC-220VLL-3Ph-50Hz` | | `AC-220VLL-127VLN-1Ph-50Hz` | | `AC-220VLL-127VLN-3Ph-50Hz` | | `AC-230VLN-1Ph-50Hz` | | `AC-240VLL-1Ph-50Hz` | | `AC-240VLL-1Ph-60Hz` | | `AC-240VLL-3Ph-50Hz` | | `AC-240VLL-3Ph-60Hz` | | `AC-240VLL-120VLN-1Ph-60Hz` | | `AC-240VLL-139VLN-1Ph-50Hz` | | `AC-240VLL-139VLN-3Ph-50Hz` | | `AC-240VLL-208VLN-120VLN-1Ph-60Hz` | | `AC-240VLL-208VLN-120VLN-3Ph-60Hz` | | `AC-240VLN-1Ph-50Hz` | | `AC-277VLN-1Ph-60Hz` | | `AC-347VLN-1Ph-60Hz` | | `AC-380VLL-1Ph-60Hz` | | `AC-380VLL-3Ph-60Hz` | | `AC-380VLL-219VLN-1Ph-60Hz` | | `AC-380VLL-219VLN-3Ph-60Hz` | | `AC-400VLL-1Ph-50Hz` | | `AC-400VLL-3Ph-50Hz` | | `AC-400VLL-230VLN-1Ph-50Hz` | | `AC-400VLL-230VLN-3Ph-50Hz` | | `AC-415VLL-1Ph-50Hz` | | `AC-415VLL-3Ph-50Hz` | | `AC-415VLL-240VLN-1Ph-50Hz` | | `AC-415VLL-240VLN-3Ph-50Hz` | | `AC-480VLL-1Ph-60Hz` | | `AC-480VLL-3Ph-60Hz` | | `AC-480VLL-277VLN-1Ph-60Hz` | | `AC-480VLL-277VLN-3Ph-60Hz` | | `AC-600VLL-1Ph-60Hz` | | `AC-600VLL-3Ph-60Hz` | | `AC-600VLL-347VLN-1Ph-60Hz` | | `AC-600VLL-347VLN-3Ph-60Hz` | | `AC-1730VLN-1Ph-60Hz` | | `AC-1900VLN-1Ph-60Hz` | | `AC-2400VLN-1Ph-60Hz` | | `AC-3000VLL-1Ph-60Hz` | | `AC-3000VLL-3Ph-60Hz` | | `AC-3000VLL-1730VLN-1Ph-60Hz` | | `AC-3000VLL-1730VLN-3Ph-60Hz` | | `AC-3300VLL-1Ph-60Hz` | | `AC-3300VLL-3Ph-60Hz` | | `AC-3300VLL-1900VLN-1Ph-60Hz` | | `AC-3300VLL-1900VLN-3Ph-60Hz` | | `AC-3460VLN-1Ph-60Hz` | | `AC-3810VLN-1Ph-60Hz` | | `AC-4160VLL-1Ph-60Hz` | | `AC-4160VLL-3Ph-60Hz` | | `AC-4160VLL-2400VLN-1Ph-60Hz` | | `AC-4160VLL-2400VLN-3Ph-60Hz` | | `AC-5770VLN-1Ph-60Hz` | | `AC-6000VLL-1Ph-60Hz` | | `AC-6000VLL-3Ph-60Hz` | | `AC-6000VLL-3460VLN-1Ph-60Hz` | | `AC-6000VLL-3460VLN-3Ph-60Hz` | | `AC-6600VLL-1Ph-60Hz` | | `AC-6600VLL-3Ph-60Hz` | | `AC-6600VLL-3810VLN-1Ph-60Hz` | | `AC-6600VLL-3810VLN-3Ph-60Hz` | | `AC-10000VLL-1Ph-60Hz` | | `AC-10000VLL-3Ph-60Hz` | | `AC-10000VLL-5770VLN-1Ph-60Hz` | | `AC-10000VLL-5770VLN-3Ph-60Hz` |', 'Constituent-Electricity', 'http://data.ashrae.org/standard223#Electricity-AC')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Electricity-DC', 'Class', 'DC electricity', 'This class and its enumerated subclasses represent common DC electricity services. : Electricity-DC Enumerations | Enumeration | |:-----------| | `DC-5V` | | `DC-6V` | | `DC-12V` | | `DC-24V` | | `DC-48V` | | `DC-380V` | | `DC-PoE` |', 'Constituent-Electricity', 'http://data.ashrae.org/standard223#Electricity-DC')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Electricity-Earth', 'Class', 'Earth', '`Electricity-Earth`', 'Constituent-Electricity', 'http://data.ashrae.org/standard223#Electricity-Earth')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Electricity-Neutral', 'Class', 'Neutral', '`Electricity-Neutral`', 'Constituent-Electricity', 'http://data.ashrae.org/standard223#Electricity-Neutral')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Electricity-Signal', 'Class', 'Electrical signal', 'This class and its enumerated subclasses represent the use of electricity for creating communication signals, and common communication protocols. : Electricity-Signal Enumerations | Enumeration | |:-----------| | `Signal-EIA485` | | `Signal-IEC14908` | | `Signal-Modulated` (see {s223:Signal-Modulated}) | | `Signal-USB` | | `Signal-WiredEthernet` (see {s223:Signal-WiredEthernet}) |', 'Constituent-Electricity', 'http://data.ashrae.org/standard223#Electricity-Signal')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ElectricityBreaker', 'Class', 'Electricity breaker', 'A piece of equipment that automatically opens an electric circuit automatically at a predetermined overcurrent, so as to prevent damage to the circuit, the equipment connected to the circuit, and the building containing the circuit.', 'Equipment', 'http://data.ashrae.org/standard223#ElectricityBreaker')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ElectricityMeter', 'Class', 'Electricity meter', 'A piece of `Equipment` that contains at least one `VoltageSensor` and one `ElectricCurrentSensor`, and reports one or more properties of electricity. Example reported properties include the following `QuantityKind`s: `Voltage`, `ElectricCurrent`, `ActiveEnergy`, `ActivePower`, `ReactivePower`, `ApparentPower`, `PowerFactor`, and `Frequency` with unit Hertz. An `ElectricityMeter` may optionally contain a `Function` that represents the mathematical calculations of the reported properties of electricity.', 'Equipment', 'http://data.ashrae.org/standard223#ElectricityMeter')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ElectricityOutlet', 'Class', 'Electricity outlet', 'A piece of `Equipment` that contains one or more receptacles for connecting electrical equipment to electrical power, typically via a plug and cord. Not to be confused with an `OutletConnectionPoint` with the medium `Constituent-Electricity`.', 'Equipment', 'http://data.ashrae.org/standard223#ElectricityOutlet')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ElectricOven', 'Class', 'Electric oven', 'A piece of `Equipment` with an enclosed chamber designed for baking, roasting, and other cooking methods that rely on circulating heat.', 'Equipment', 'http://data.ashrae.org/standard223#ElectricOven')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ElectricResistanceElement', 'Class', 'Electric resistance element', 'A piece of `Equipment` that provides electrical resistance heating, for example an electric heating coil within a Fan Coil Unit. It shall have one electricity `InletConnectionPoint`, and fit one of the following two patterns: - Pattern 1: An `ElectricResistanceElement` shall have exactly one Bidirectional `ConnectionPoint` using the medium `Mix-Fluid`. - Pattern 2: An `ElectricResistanceElement` shall have one inlet and one outlet using the medium `Mix-Fluid`.', 'Equipment', 'http://data.ashrae.org/standard223#ElectricResistanceElement')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ElectricWaterDispenser', 'Class', 'Electric water dispenser', 'A piece of `Equipment` that dispenses water and optionally heats and/or cools the water prior to dispensing.', 'Equipment', 'http://data.ashrae.org/standard223#ElectricWaterDispenser')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ElectronicDisplay', 'Class', 'Electronic display', 'A piece of `Equipment` that receives an input electrical signal and outputs information, typically text and/or graphics, in a visual form.', 'Equipment', 'http://data.ashrae.org/standard223#ElectronicDisplay')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Elevator', 'Class', 'Elevator', 'A piece of `Equipment` that vertically transports people or freight between floors or levels of a building via a vertical shaft commonly referred to as a hoistway. The people or freight are typically situated on a platform, or in a container commonly referred to as a car, cab, cabin, cage, or carriage.', 'Equipment', 'http://data.ashrae.org/standard223#Elevator')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EM', 'Class', 'EM connection', 'A type of `Connection` that represents air, a vacuum, outer space, or a similar environment used to convey electromagnetic energy (i.e., `Constituent-EM`), without the use of a solid materials such as fiber optic cables or other such `Waveguide`s.', 'Connection', 'http://data.ashrae.org/standard223#EM')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EM-Light', 'Class', 'Light', 'This class and its enumerated subclasses represent light at commonly defined frequency or wavelength ranges. : EM-Light Enumerations | Enumeration | |:-----------| | `Light-Infrared` (see {s223:Light-Infrared}) | | `Light-Ultraviolet` | | `Light-Visible` |', 'Constituent-EM', 'http://data.ashrae.org/standard223#EM-Light')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EM-Microwave', 'Class', 'Microwave', '`EM-Microwave`', 'Constituent-EM', 'http://data.ashrae.org/standard223#EM-Microwave')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EM-RF', 'Class', 'RF', 'This class and its enumerated subclasses represent the use electromagnetic energy in the radio frequency range for multiple purposes, including communication signals. : EM-RF Enumerations | Enumeration | |:-----------| | `RF-Signal` (see {s223:RF-Signal}) |', 'Constituent-EM', 'http://data.ashrae.org/standard223#EM-RF')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('encloses', 'Relation', 'encloses', 'A `Relation` that associates a `PhysicalSpace` with one or more `DomainSpace`s.', NULL, 'http://data.ashrae.org/standard223#encloses')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EnumerableProperty', 'Class', 'Enumerable property', 'An `EnumerableProperty` is a `Property` with an enumerated (fixed) set of possible values.', 'Property', 'http://data.ashrae.org/standard223#EnumerableProperty')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EnumeratedActuatableProperty', 'Class', 'Enumerated actuatable property', 'An `EnumeratedActuatableProperty` is a `Property` with an enumerated (fixed) set of possible values that can be changed (actuated).', 'ActuatableProperty', 'http://data.ashrae.org/standard223#EnumeratedActuatableProperty')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EnumeratedObservableProperty', 'Class', 'Enumerated observable property', 'An `EnumeratedObservableProperty` is a `Property` with an enumerated (fixed) set of possible values that cannot be changed (can only be observed).', 'EnumerableProperty', 'http://data.ashrae.org/standard223#EnumeratedObservableProperty')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EnumerationKind', 'Class', 'Enumeration kind', 'This is the encapsulating class for all `EnumerationKind`s. `EnumerationKind`s define the (closed) set of permissible values for a given purpose. For example, `EnumerationKind-DayOfWeek` enumerates the days of the week and allows no other values. `EnumerationKind`s are arranged in a class hierarchy tree, with the root class named `EnumerationKind`. Each subclass is named starting with its immediate superclass, followed by a hyphen and a name that is unique among the sibling classes. Each class is also an instance of itself. This unusual modeling pattern was used to achieve: - The ability to set an `EnumerationKind` value that is more general, or not yet fully specified at the time of modeling, such as `Electricity-AC` without having to state exactly what voltage or frequency it is. - The ability to use the `sh:class` SHACL predicate at any level in the `EnumerationKind` hierarchy to constrain a value in the s223 specification, even if it is a more general one such as `Electricity-AC` in the above example. Certain validation constraints exist in the standard that evaluate compatibility of `EnumerationKind`s. Two values are deemed compatible if they are the same, if one is a direct ancestor (or descendant) of the other, or if they are mixtures sharing at least one constituent.', 'Concept', 'http://data.ashrae.org/standard223#EnumerationKind')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EnumerationKind-Aspect', 'Class', 'Aspect', 'Aspect enumerations provide context to the meaning of a `Property` that would otherwise not be apparent.', 'EnumerationKind', 'http://data.ashrae.org/standard223#EnumerationKind-Aspect')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EnumerationKind-Binary', 'Class', 'Binary', 'This class and its enumerated subclasses represent common binary values. : EnumerationKind-Binary Enumerations | Enumeration | |:-----------| | `Binary-Logical` | | `Binary-OnOff` | | `Binary-Position` |', 'EnumerationKind', 'http://data.ashrae.org/standard223#EnumerationKind-Binary')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EnumerationKind-DayOfWeek', 'Class', 'Day of week', 'This class and its enumerated subclasses represent the days of the week, according to the Gregorian calendar, i.e., Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, and Sunday. The Weekend and Weekday EnumerationKinds define subsets of this `EnumerationKind` for Mon-Fri and Sat, Sun, respectively. : EnumerationKind-DayOfWeek Enumerations | Enumeration | |:-----------| | `DayOfWeek-Weekday` | | `DayOfWeek-Weekend` |', 'EnumerationKind', 'http://data.ashrae.org/standard223#EnumerationKind-DayOfWeek')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EnumerationKind-Domain', 'Class', 'Domain', 'This class and its enumerated subclasses represent building systems and services (e.g., HVAC, Lighting, and Plumbing). : EnumerationKind-Domain Enumerations | Enumeration | |:-----------| | `Domain-ConveyanceSystems` | | `Domain-Electrical` | | `Domain-FireProtection` | | `Domain-HVAC` | | `Domain-Lighting` | | `Domain-Networking` | | `Domain-Occupancy` | | `Domain-PhysicalSecurity` | | `Domain-Plumbing` | | `Domain-Refrigeration` |', 'EnumerationKind', 'http://data.ashrae.org/standard223#EnumerationKind-Domain')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EnumerationKind-ElectricalPhaseIdentifier', 'Class', 'Electrical phase identifier', 'This class and its enumerated subclasses represent all possible electrical phases for AC electricity service. : EnumerationKind-ElectricalPhaseIdentifier Enumerations | Enumeration | |:-----------| | `ElectricalPhaseIdentifier-A` | | `ElectricalPhaseIdentifier-AB` | | `ElectricalPhaseIdentifier-ABC` | | `ElectricalPhaseIdentifier-B` | | `ElectricalPhaseIdentifier-BC` | | `ElectricalPhaseIdentifier-C` | | `ElectricalPhaseIdentifier-CA` |', 'EnumerationKind', 'http://data.ashrae.org/standard223#EnumerationKind-ElectricalPhaseIdentifier')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EnumerationKind-Numerical', 'Class', 'Numerical', 'Numerical enumeration kinds are used to support the definitions of the `Constituent-Electricity`. The enumerations instances in these classes have names that are recognizable by humans but are just a string for a computer application. To avoid the need to parse strings, each of these `EnumerationKind`s have relations with the `EnumerationKind`s that represent electrical phase, voltage, and frequency. The purpose of these properties is to enable a machine to query them and obtain the same information that a person would associate with the string.', 'EnumerationKind', 'http://data.ashrae.org/standard223#EnumerationKind-Numerical')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EnumerationKind-Occupancy', 'Class', 'Occupancy', 'This class and its enumerated subclasses represent the occupancy status of a space within a building, i.e., the state of being occupied by a human being. The `Occupancy-Motion` and `Occupancy-Presence` subclasses are associated with specific characteristics of occupancy and associated means of detection, while the `Occupancy-Occupied` subclass is generic, in that it is not associated with a specific characteristic or occupancy or associated means of detection.', 'EnumerationKind', 'http://data.ashrae.org/standard223#EnumerationKind-Occupancy')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EnumerationKind-Role', 'Class', 'Role', 'This class and its enumerated subclasses represent roles played by entities, such as cooling, generator, relief, and return. These enumeration kinds are intended to indicate the capability of an entity to play a given role, rather than the role being actively played at any given point in time. For example, a reversible piece of equipment might play a role of `Role-Cooling` at one time and `Role-Heating` at another time. Such an entity would be modeled using the `hasRole` relation with both role values. The active role at a particular time can be modeled as a `Property` with an `ExternalReference` to telemetry data. : EnumerationKind-Role Enumerations | Enumeration | |:-----------| | `Role-Condenser` | | `Role-Cooling` | | `Role-Dehumidifying` | | `Role-Discharge` | | `Role-Economizer` | | `Role-Evaporator` | | `Role-Exhaust` | | `Role-Expansion` | | `Role-Generator` | | `Role-Heating` | | `Role-HeatRecovery` | | `Role-HeatTransfer` | | `Role-Load` | | `Role-OutdoorAirIntake` | | `Role-Primary` | | `Role-Recirculating` | | `Role-Relief` | | `Role-Return` | | `Role-Secondary` | | `Role-Supply` | | `Role-Ventilating` |', 'EnumerationKind', 'http://data.ashrae.org/standard223#EnumerationKind-Role')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EnumerationKind-Substance', 'Class', 'Substance', 'This class and its enumerated subclasses represent things that are produced, conveyed, sensed, controlled, or consumed. Its enumerated subclasses differentate between mediums, particulates, and soot. : EnumerationKind-Substance Enumerations | Enumeration | |:-----------| | `Substance-Medium` (see {s223:Substance-Medium}) | | `Substance-Particulate` (see {s223:Substance-Particulate}) | | `Substance-Soot` (see {s223:Substance-Soot}) |', 'EnumerationKind', 'http://data.ashrae.org/standard223#EnumerationKind-Substance')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EnumerationKind-ThermodynamicPhase', 'Class', 'Thermodynamic phase', 'This class and its enumerated subclasses represent thermodynamic phases, also referred to as states of matter. : EnumerationKind-ThermodynamicPhase Enumerations | Enumeration | |:-----------| | `ThermodynamicPhase-Gas` (see {s223:ThermodynamicPhase-Gas}) | | `ThermodynamicPhase-Liquid` (see {s223:ThermodynamicPhase-Liquid}) | | `ThermodynamicPhase-Solid` | | `ThermodynamicPhase-Vapor` |', 'EnumerationKind', 'http://data.ashrae.org/standard223#EnumerationKind-ThermodynamicPhase')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Equipment', 'Class', 'Equipment', '`Equipment` is the modeling construct used to represent a thing designed to accomplish a specific task, or a complex thing that contains component pieces of `Equipment` that are connected to each other and work together to accomplish a task. `Equipment` can have `Connection`s and `ConnectionPoint`s through which one or more kinds of medium (see {s223:Substance-Medium}) might flow. Examples of `Equipment` defined in this ontology include `Pump`, `Fan`, `AirHeatExchanger`, `Luminaire`, and `Sensor`. `Equipment` can be connected to other `Connectable`s such as other `Equipment` or `DomainSpace`s. The graphical depiction of Equipment used in this document is a round-cornered rectangle as shown in Figure 5-1. ![Graphical Depiction of Equipment.](figures/Figure_5-1_Graphical_Depiciton_of_Equipment.svg)', 'Connectable', 'http://data.ashrae.org/standard223#Equipment')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Escalator', 'Class', 'Escalator', 'A piece of `Equipment` that vertically transports people between floors or levels of a building via a moving staircase.', 'Equipment', 'http://data.ashrae.org/standard223#Escalator')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EthernetCable', 'Class', 'Ethernet cable', 'A type of `Conductor` that consists of 1, 2 or 4 pairs of twisted wire and is used for `Signal-WiredEthernet` communication. Subclasses of `EthernetCable` represent common types used in buildings. : EthernetCable Subclasses | Subclass | |:-----------| | `EthernetCable-Cat1` | | `EthernetCable-Cat2` | | `EthernetCable-Cat3` | | `EthernetCable-Cat4` | | `EthernetCable-Cat5` | | `EthernetCable-Cat5e` | | `EthernetCable-Cat6` | | `EthernetCable-Cat6a` | | `EthernetCable-Cat7` | | `EthernetCable-Cat7a` | | `EthernetCable-Cat8` |', 'Conductor', 'http://data.ashrae.org/standard223#EthernetCable')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EthernetCable-Cat1', 'Class', 'Ethernet Cable Cat1', 'EthernetCable-Cat1', 'EthernetCable', 'http://data.ashrae.org/standard223#EthernetCable-Cat1')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EthernetCable-Cat2', 'Class', 'Ethernet Cable Cat2', 'EthernetCable-Cat2', 'EthernetCable', 'http://data.ashrae.org/standard223#EthernetCable-Cat2')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EthernetCable-Cat3', 'Class', 'Ethernet Cable Cat3', 'EthernetCable-Cat3', 'EthernetCable', 'http://data.ashrae.org/standard223#EthernetCable-Cat3')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EthernetCable-Cat4', 'Class', 'Ethernet Cable Cat4', 'EthernetCable-Cat4', 'EthernetCable', 'http://data.ashrae.org/standard223#EthernetCable-Cat4')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EthernetCable-Cat5', 'Class', 'Ethernet Cable Cat5', 'EthernetCable-Cat5', 'EthernetCable', 'http://data.ashrae.org/standard223#EthernetCable-Cat5')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EthernetCable-Cat5e', 'Class', 'Ethernet Cable Cat5e', 'EthernetCable-Cat5e', 'EthernetCable', 'http://data.ashrae.org/standard223#EthernetCable-Cat5e')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EthernetCable-Cat6', 'Class', 'Ethernet Cable Cat6', 'EthernetCable-Cat6', 'EthernetCable', 'http://data.ashrae.org/standard223#EthernetCable-Cat6')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EthernetCable-Cat6a', 'Class', 'Ethernet Cable Cat6a', 'EthernetCable-Cat6a', 'EthernetCable', 'http://data.ashrae.org/standard223#EthernetCable-Cat6a')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EthernetCable-Cat7', 'Class', 'Ethernet Cable Cat7', 'EthernetCable-Cat7', 'EthernetCable', 'http://data.ashrae.org/standard223#EthernetCable-Cat7')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EthernetCable-Cat7a', 'Class', 'Ethernet Cable Cat7a', 'EthernetCable-Cat7a', 'EthernetCable', 'http://data.ashrae.org/standard223#EthernetCable-Cat7a')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EthernetCable-Cat8', 'Class', 'Ethernet Cable Cat8', 'EthernetCable-Cat8', 'EthernetCable', 'http://data.ashrae.org/standard223#EthernetCable-Cat8')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EthernetPort', 'Class', 'Ethernet port', 'A piece of `Equipment` that connects a single instance of electrical equipment, such as `Computer`s and Wi-Fi access points, to an Ethernet network so it can communicate with other equipment and, optionally, with the Internet.', 'Equipment', 'http://data.ashrae.org/standard223#EthernetPort')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('EthernetSwitch', 'Class', 'Ethernet switch', 'A piece of `Equipment` that connects one or more instances of electrical equipment, such as `Computer`s and Wi-Fi access points, to an Ethernet network so they can communicate with each other and, optionally, to the Internet.', 'Equipment', 'http://data.ashrae.org/standard223#EthernetSwitch')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('executes', 'Relation', 'executes', 'A `Relation` that associates a `Controller` (see {s223:Controller}) with the `Function`s (see {s223:Function}) that it executes.', NULL, 'http://data.ashrae.org/standard223#executes')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ExternalReference', 'AbstractClass', 'External reference', '`ExternalReference` is an abstract class that represents a thing that contains API or protocol parameter values necessary to associate a `Property` with a value.', 'Concept', 'http://data.ashrae.org/standard223#ExternalReference')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Fan', 'Class', 'Fan', 'A piece of `Equipment` that causes a gas (e.g., air) to flow.', 'Equipment', 'http://data.ashrae.org/standard223#Fan')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FanCoilUnit', 'Class', 'Fan coil unit', 'A piece of `Equipment` consisting of a `Coil` and a `Fan` that regulates the temperature of one or more spaces.', 'Equipment', 'http://data.ashrae.org/standard223#FanCoilUnit')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FanPoweredTerminal', 'Class', 'Fan-powered terminal', 'A `TerminalUnit` that contains a fan, and optionally has supplemental heating or cooling. Airflow may pass through or be parallel to the fan.', 'TerminalUnit', 'http://data.ashrae.org/standard223#FanPoweredTerminal')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Faucet', 'Class', 'Faucet', 'A `Valve` that allows, regulates, or stops the flow of hot or cold water from a plumbing supply system into a `Sink`, `Shower`, `Bathtub`, or other plumbing service equipment.', 'Valve', 'http://data.ashrae.org/standard223#Faucet')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FiberEthernet-1X9', 'Class', 'Fiber Ethernet 1X9', 'FiberEthernet-1X9', 'Signal-FiberEthernet', 'http://data.ashrae.org/standard223#FiberEthernet-1X9')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FiberEthernet-300PIN', 'Class', 'Fiber Ethernet 300PIN', 'FiberEthernet-300PIN', 'Signal-FiberEthernet', 'http://data.ashrae.org/standard223#FiberEthernet-300PIN')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FiberEthernet-CFP', 'Class', 'Fiber Ethernet CFP', 'FiberEthernet-CFP', 'Signal-FiberEthernet', 'http://data.ashrae.org/standard223#FiberEthernet-CFP')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FiberEthernet-CFP2', 'Class', 'Fiber Ethernet CFP2', 'FiberEthernet-CFP2', 'Signal-FiberEthernet', 'http://data.ashrae.org/standard223#FiberEthernet-CFP2')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FiberEthernet-CFP4', 'Class', 'Fiber Ethernet CFP4', 'FiberEthernet-CFP4', 'Signal-FiberEthernet', 'http://data.ashrae.org/standard223#FiberEthernet-CFP4')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FiberEthernet-CPAK', 'Class', 'Fiber Ethernet CPAK', 'FiberEthernet-CPAK', 'Signal-FiberEthernet', 'http://data.ashrae.org/standard223#FiberEthernet-CPAK')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FiberEthernet-CXP', 'Class', 'Fiber Ethernet CXP', 'FiberEthernet-CXP', 'Signal-FiberEthernet', 'http://data.ashrae.org/standard223#FiberEthernet-CXP')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FiberEthernet-GBIC', 'Class', 'Fiber Ethernet GBIC', 'FiberEthernet-GBIC', 'Signal-FiberEthernet', 'http://data.ashrae.org/standard223#FiberEthernet-GBIC')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FiberEthernet-QSFP', 'Class', 'Fiber Ethernet QSFP', 'FiberEthernet-QSFP', 'Signal-FiberEthernet', 'http://data.ashrae.org/standard223#FiberEthernet-QSFP')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FiberEthernet-QSFP28', 'Class', 'Fiber Ethernet QSFP28', 'FiberEthernet-QSFP28', 'Signal-FiberEthernet', 'http://data.ashrae.org/standard223#FiberEthernet-QSFP28')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FiberEthernet-SFF', 'Class', 'Fiber Ethernet SFF', 'FiberEthernet-SFF', 'Signal-FiberEthernet', 'http://data.ashrae.org/standard223#FiberEthernet-SFF')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FiberEthernet-SFP', 'Class', 'Fiber Ethernet SFP', 'FiberEthernet-SFP', 'Signal-FiberEthernet', 'http://data.ashrae.org/standard223#FiberEthernet-SFP')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FiberEthernet-X2', 'Class', 'Fiber Ethernet X2', 'FiberEthernet-X2', 'Signal-FiberEthernet', 'http://data.ashrae.org/standard223#FiberEthernet-X2')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FiberEthernet-XENPAK', 'Class', 'Fiber Ethernet XENPAK', 'FiberEthernet-XENPAK', 'Signal-FiberEthernet', 'http://data.ashrae.org/standard223#FiberEthernet-XENPAK')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FiberEthernet-XFP', 'Class', 'Fiber Ethernet XFP', 'FiberEthernet-XFP', 'Signal-FiberEthernet', 'http://data.ashrae.org/standard223#FiberEthernet-XFP')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FiberEthernetOutlet', 'Class', 'Fiber Ethernet outlet', 'A piece of `Equipment` that contains one or more receptacles for connecting electrical equipment to a fiber Ethernet communication network, typically via a fiber Ethernet cable.', 'Equipment', 'http://data.ashrae.org/standard223#FiberEthernetOutlet')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FiberOpticCable', 'Class', 'Fiber optic cable', 'A type of `Waveguide` that consists of thin, flexible strands of glass or plastic fibers that transmit data as pulses of light and is used for `Signal-FiberEthernet` or `Wideband-CATV` communication. Subclasses of `FiberOpticCable` represent common types used in buildings. : FiberOpticCable Subclasses | Subclass | |:-----------| | `FiberOpticCable-OM1` | | `FiberOpticCable-OM2` | | `FiberOpticCable-OM3` | | `FiberOpticCable-OM4` | | `FiberOpticCable-OM5` | | `FiberOpticCable-OS1` | | `FiberOpticCable-OS2` |', 'Waveguide', 'http://data.ashrae.org/standard223#FiberOpticCable')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FiberOpticCable-OM1', 'Class', 'Fiber Optic Cable OM1', 'FiberOpticCable-OM1', 'FiberOpticCable', 'http://data.ashrae.org/standard223#FiberOpticCable-OM1')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FiberOpticCable-OM2', 'Class', 'Fiber Optic Cable OM2', 'FiberOpticCable-OM2', 'FiberOpticCable', 'http://data.ashrae.org/standard223#FiberOpticCable-OM2')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FiberOpticCable-OM3', 'Class', 'Fiber Optic Cable OM3', 'FiberOpticCable-OM3', 'FiberOpticCable', 'http://data.ashrae.org/standard223#FiberOpticCable-OM3')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FiberOpticCable-OM4', 'Class', 'Fibe Optic Cable OM4', 'FiberOpticCable-OM4', 'FiberOpticCable', 'http://data.ashrae.org/standard223#FiberOpticCable-OM4')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FiberOpticCable-OM5', 'Class', 'Fiber Optic Cable OM5', 'FiberOpticCable-OM5', 'FiberOpticCable', 'http://data.ashrae.org/standard223#FiberOpticCable-OM5')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FiberOpticCable-OS1', 'Class', 'Fiber Optic Cable OS1', 'FiberOpticCable-OS1', 'FiberOpticCable', 'http://data.ashrae.org/standard223#FiberOpticCable-OS1')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FiberOpticCable-OS2', 'Class', 'Fiber Optic Cable OS2', 'FiberOpticCable-OS2', 'FiberOpticCable', 'http://data.ashrae.org/standard223#FiberOpticCable-OS2')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Filter', 'Class', 'Filter', 'A piece of `Equipment` that removes contaminants from gases or liquids. See {s223:Substance-Medium} for more details on validating compatible mediums upstream and downstream of a `Filter`.', 'Equipment', 'http://data.ashrae.org/standard223#Filter')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FlowSensor', 'Class', 'Flow sensor', 'A `Sensor` that `observes` a `QuantifiableObservableProperty` that represents a measure of flow of fluid, typically with a `QuantityKind` of `VolumeFlowRate`.', 'Sensor', 'http://data.ashrae.org/standard223#FlowSensor')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Fluid-Air', 'Class', 'Air', 'Fluid-Air', 'Mix-Fluid', 'http://data.ashrae.org/standard223#Fluid-Air')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Fluid-NaturalGas', 'Class', 'Natural gas', 'Fluid-NaturalGas', 'Mix-Fluid', 'http://data.ashrae.org/standard223#Fluid-NaturalGas')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Fluid-Oil', 'Class', 'Oil', 'Fluid-Oil', 'Mix-Fluid', 'http://data.ashrae.org/standard223#Fluid-Oil')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Fluid-Water', 'Class', 'Water', 'This class and its enumerated subclasses represent water and aqueous solutions in various states. : Fluid-Water Enumerations | Enumeration | |:-----------| | `Water-ChilledWater` | | `Water-GlycolSolution` (see {s223:Water-GlycolSolution}) | | `Water-HotWater` | | `Water-Steam` |', 'Mix-Fluid', 'http://data.ashrae.org/standard223#Fluid-Water')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FlushToilet', 'Class', 'Flush toilet', 'A piece of `Equipment` that collects human waste (i.e., urine and/or feces, and sometimes toilet paper) in a chamber containing water, and contains an integral manual or automatic actuator that triggers the release of an additional volume of water that flushes everything from the chamber into a drainage system that typically carries the mixture to a sewer system or septic tank.', 'Equipment', 'http://data.ashrae.org/standard223#FlushToilet')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Freezer', 'Class', 'Freezer', 'A piece of `Equipment` that maintains an internal temperature below the freezing point of water.', 'Equipment', 'http://data.ashrae.org/standard223#Freezer')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Frequency-50Hz', 'Class', '50 Hertz', 'Frequency-50Hz', 'Numerical-Frequency', 'http://data.ashrae.org/standard223#Frequency-50Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Frequency-60Hz', 'Class', '60 Hertz', 'Frequency-60Hz', 'Numerical-Frequency', 'http://data.ashrae.org/standard223#Frequency-60Hz')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('FumeHood', 'Class', 'Fume hood', 'A piece of `Equipment` that is typically mounted over a work area (e.g., a space, table, or shelf) and conducts unwanted gases away from the area.', 'Equipment', 'http://data.ashrae.org/standard223#FumeHood')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Function', 'Class', 'Function', 'A `Function` is used to model transfer and/or transformation of information (i.e., `Property`). It has relations to input Properties and output Properties. The actual algorithms that perform the transformations are described in CDL and are out of scope of the 223 standard.', 'Concept', 'http://data.ashrae.org/standard223#Function')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Furnace', 'Class', 'Furnace', 'A piece of `Equipment` that converts fuel or electrical energy into heat.', 'Equipment', 'http://data.ashrae.org/standard223#Furnace')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Gas-Superheated', 'Class', 'Superheated gas', 'Gas-Superheated', 'ThermodynamicPhase-Gas', 'http://data.ashrae.org/standard223#Gas-Superheated')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('GaugePressureSensor', 'Class', 'Gauge pressure sensor', 'A `PressureSensor` that `observes` a `QuantifiableObservableProperty` that represents a measure of pressure relative to atmospheric pressure. Such sensors are commonly used to monitor compressed gas cylinders, for example, where a gauge reading of zero signifies that the measured pressure is equal to the atmospheric pressure, not a vacuum.', 'PressureSensor', 'http://data.ashrae.org/standard223#GaugePressureSensor')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Generator', 'Class', 'Generator', 'A piece of `Equipment` that converts non-electric energy into electric energy.', 'Equipment', 'http://data.ashrae.org/standard223#Generator')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('GlycolSolution-15Percent', 'Class', '15 percent glycol solution', '`GlycolSolution-15Percent`', 'Water-GlycolSolution', 'http://data.ashrae.org/standard223#GlycolSolution-15Percent')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('GlycolSolution-30Percent', 'Class', '30 percent glycol solution', '`GlycolSolution-30Percent`', 'Water-GlycolSolution', 'http://data.ashrae.org/standard223#GlycolSolution-30Percent')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('GroundToAirHeatPump', 'Class', 'Ground-to-air heat pump', 'A `HeatPump` that transfers thermal energy between air and the ground.', 'HeatPump', 'http://data.ashrae.org/standard223#GroundToAirHeatPump')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasACLineLineVoltage', 'Relation', 'has AC line-line voltage', 'A `Relation` that associates a `Constituent-Electricity` with an electrical voltage between two live lines.', NULL, 'http://data.ashrae.org/standard223#hasACLineLineVoltage')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasACLineNeutralVoltage', 'Relation', 'has AC line-neutral voltage', 'A `Relation` that associates an `Electricity-AC` medium with an electrical voltage between a live line and a neutral line.', NULL, 'http://data.ashrae.org/standard223#hasACLineNeutralVoltage')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasAlarmStatus', 'Relation', 'has alarm status', 'A `Relation` that associates an `EnumerableProperty` that describes an Alarm or Status with a `QuantifiableProperty`.', NULL, 'http://data.ashrae.org/standard223#hasAlarmStatus')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasAspect', 'Relation', 'has aspect', '`hasAspect` is used to establish the context of a `Property`. The value must be an instance of `EnumerationKind`. For example, if a `Property` has a temperature value of 45.3, the `hasAspect` relation is used to state what that represents, such as a temperature limit during working hours, etc. A `Property` can have any number of `hasAspect` relations as needed to establish the context.', NULL, 'http://data.ashrae.org/standard223#hasAspect')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasBoundaryConnectionPoint', 'Relation', 'has boundary connection point', 'The `hasBoundaryConnectionPoint` relation means the `ConnectionPoint` represents the boundary of a `System` (see {s223:System}) defined by the modeler, such as a model fragment provided by the vendor of a collection of equipment intended for integration with another model. The presence of this relation is used to indicate that such a "dangling connection point" should not generate a validation error in a non-integrated context but should generate an error in an integrated context.', NULL, 'http://data.ashrae.org/standard223#hasBoundaryConnectionPoint')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasConnectionPoint', 'Relation', 'has connection point', 'One of two `Relation`s that associates `Connectable` thing with a `ConnectionPoint`. It is the inverse of the relation `isConnectionPointOf` (see {s223:isConnectionPointOf}).', NULL, 'http://data.ashrae.org/standard223#hasConnectionPoint')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasDCDifferentialVoltage', 'Relation', 'has DC differential voltage', 'A `Relation` that associates an `Electricity-DC` medium with a differential voltage.', NULL, 'http://data.ashrae.org/standard223#hasDCDifferentialVoltage')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasDCNegativeVoltage', 'Relation', 'has DC negative voltage', 'A `Relation` that associates an `Electricity-DC` medium with a negative polarity voltage.', NULL, 'http://data.ashrae.org/standard223#hasDCNegativeVoltage')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasDCPositiveVoltage', 'Relation', 'has DC positive voltage', 'A `Relation` that associates an `Electricity-DC` medium with a positive polarity voltage.', NULL, 'http://data.ashrae.org/standard223#hasDCPositiveVoltage')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasDCZeroVoltage', 'Relation', 'has DC zero voltage', 'A `Relation` that associates an `Electricity-DC` medium with a zero value voltage.', NULL, 'http://data.ashrae.org/standard223#hasDCZeroVoltage')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasDeadband', 'Relation', 'has deadband', 'This relation binds a control setpoint to the `QuantifiableProperty` indicating the range of values within which a sensed variable can vary without indicating a condition has changed.', NULL, 'http://data.ashrae.org/standard223#hasDeadband')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasDomain', 'Relation', 'has domain', 'A `Relation` that associates a `Zone` or `DomainSpace` with an `EnumerationKind-Domain` (e.g., `Domain-HVAC`, `Domain-Lighting`).', NULL, 'http://data.ashrae.org/standard223#hasDomain')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasDomainSpace', 'Relation', 'has domain space', 'A `Relation` that associates a `Zone` with its component `DomainSpace`s.', NULL, 'http://data.ashrae.org/standard223#hasDomainSpace')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasElectricalPhase', 'Relation', 'has electrical phase', 'A `Relation` that associates a `Conductor` or `ConnectionPoint` with at most one `EnumerationKind-ElectricalPhaseIdentifier`.', NULL, 'http://data.ashrae.org/standard223#hasElectricalPhase')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasEnumerationKind', 'Relation', 'has enumeration kind', 'A `Relation` that associates an `EnumerableProperty` with a class of enumeration values. This is used to, for example, identify what kind of substance is transported along a `Connection` or which day of the week a setpoint is active.', NULL, 'http://data.ashrae.org/standard223#hasEnumerationKind')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasExternalReference', 'Relation', 'has external reference', 'A `Relation` that associates a `Property` with an external telemetry source.', NULL, 'http://data.ashrae.org/standard223#hasExternalReference')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasFreezingPoint', 'Relation', 'has freezing point', 'The relation `hasFreezingPoint` is used to associate a freezing point with a glycol solution, but could be used with other `Substance-Medium`s as appropriate.', NULL, 'http://data.ashrae.org/standard223#hasFreezingPoint')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasFrequency', 'Relation', 'has frequency', 'A `Relation` that associates an `Electricity-AC` with its electrical frequency.', NULL, 'http://data.ashrae.org/standard223#hasFrequency')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasInput', 'Relation', 'has input', 'A `Relation` that associates a `Function` (see {s223:Function}) with a `Property` (see {s223:Property}) that is used as input to the `Function`.', NULL, 'http://data.ashrae.org/standard223#hasInput')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasInternalReference', 'Relation', 'has internal reference', 'A `Relation` that associates a `Property` with another equivalent `Property`. For example, a `Property` that represents a `Zone` temperature could have one or more `hasInternalReference` relations to another `Property` that is a temperature measurement from one room in the zone (see Figure 11-2). ![Zone Internal Reference.](figures/Figure_11-2_Zone_Internal_Reference.svg) Another use of `hasInternalReference` is to make a `Property` of a piece of equipment visible as a `Property` of a piece of containing equipment. This is illustrated in Figure 11-3. ![Equipment Containment.](figures/Figure_11-3_Equipment_Contains_3.svg) Note that the `hasInternalReference` relation is transitive.', NULL, 'http://data.ashrae.org/standard223#hasInternalReference')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasMeasurementResolution', 'Relation', 'has measurement resolution', 'A `Relation` that associates a `Sensor` with the `QuantifiableProperty` whose value indicates the smallest recognizable change in engineering units that the `Sensor` is able to measure.', NULL, 'http://data.ashrae.org/standard223#hasMeasurementResolution')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasMedium', 'Relation', 'has medium', 'The relation `hasMedium` is used to indicate what medium is flowing through the connection (e.g., air, water, electricity). The possible values are defined in `Substance-Medium` (see {s223:Substance-Medium}).', NULL, 'http://data.ashrae.org/standard223#hasMedium')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasMember', 'Relation', 'has member', 'A `Relation` that associates a `System` with its component `Equipment` and/or `System`s.', NULL, 'http://data.ashrae.org/standard223#hasMember')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasNumberOfElectricalPhases', 'Relation', 'has number of electrical phases', 'A `Relation` that associates an AC electricity `Substance-Medium` with its number of electrical phases.', NULL, 'http://data.ashrae.org/standard223#hasNumberOfElectricalPhases')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasObservationLocation', 'Relation', 'has observation location', 'A `Relation` that associates a `Sensor` with the topological location where it is observing a `Property` (see {s223:observes}). The observation location shall be a `Connectable` (see {s223:Connectable}), `Connection` (see {s223:Connection}), or `ConnectionPoint` (see {s223:ConnectionPoint}).', NULL, 'http://data.ashrae.org/standard223#hasObservationLocation')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasOptionalConnectionPoint', 'Relation', 'has optional connection point', 'The `hasOptionalConnectionPoint` relation means that the `ConnectionPoint` is optional and is not required to be connected. The presence of this relation is used to indicate that such a "dangling connection point" should not generate a validation error in an integrated or non-integrated context.', NULL, 'http://data.ashrae.org/standard223#hasOptionalConnectionPoint')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasOutput', 'Relation', 'has output', 'A `Relation` that associates a `Function` (see {s223:Function}) with a `Property` (see {s223:Property}) that is calculated by the `Function`.', NULL, 'http://data.ashrae.org/standard223#hasOutput')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasPhysicalLocation', 'Relation', 'has physical location', 'A `Relation` that associates a piece of `Equipment` with its physical location (i.e., in a `PhysicalSpace`). The physical location of a piece of `Equipment` is not necessarily the same as the location affected by the operation of the `Equipment`. For example, an air handler may physically be located on the roof, but its effect is to provide conditioned air to a `Zone` or `DomainSpace` within the building. By following the path of connections, it can be determined what other equipment or spaces are possibly impacted by the `Equipment`.', NULL, 'http://data.ashrae.org/standard223#hasPhysicalLocation')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasProperty', 'Relation', 'has property', 'A `Relation` that associates a `Concept` with a `Property`.', NULL, 'http://data.ashrae.org/standard223#hasProperty')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasReferenceLocation', 'Relation', 'has reference location', 'A `Relation` that associates a differential sensor with the topological location of the baseline (reference) `Property` (see {s223:observes}).', NULL, 'http://data.ashrae.org/standard223#hasReferenceLocation')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasRole', 'Relation', 'has role', 'A `Relation` that associates a role with of a piece of `Equipment`, a `Connection`, `ConnectionPoint`, or `System` within a building (e.g., a heating coil might be associated with `Role-Heating`). Possible values are defined in `EnumerationKind-Role` (see {s223:EnumerationKind-Role}).', NULL, 'http://data.ashrae.org/standard223#hasRole')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasSetpoint', 'Relation', 'has setpoint', 'A `Relation` that associates a control setpoint with the `QuantifiableProperty` indicating the desired value which the control process is trying to maintain.', NULL, 'http://data.ashrae.org/standard223#hasSetpoint')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasThermodynamicPhase', 'Relation', 'has thermodynamic phase', 'A `Relation` that associates a Medium with its thermodynamic phases.', NULL, 'http://data.ashrae.org/standard223#hasThermodynamicPhase')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasThreshold', 'Relation', 'has threshold', 'A `Relation` that associates a threshold with the `QuantifiableProperty` indicating a specific value at which an action may be taken, distinguished from an offset or a range.', NULL, 'http://data.ashrae.org/standard223#hasThreshold')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasValue', 'Relation', 'has value', 'A `Relation` that associates something with a fixed value, as opposed to a computed, measured, or externally derived value.', NULL, 'http://data.ashrae.org/standard223#hasValue')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('hasZone', 'Relation', 'has zone', 'A `Relation` that associates a `Zone` with component `Zone`s.', NULL, 'http://data.ashrae.org/standard223#hasZone')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('HeatingCoil', 'Class', 'Heating coil', 'A `Coil` that is specifically used to heat air.', 'Coil', 'http://data.ashrae.org/standard223#HeatingCoil')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('HeatPump', 'Class', 'Heat pump', 'A piece of `Equipment` that heats or cools spaces by transferring thermal energy from one thermal environment to another using a reversible refrigeration cycle.', 'Equipment', 'http://data.ashrae.org/standard223#HeatPump')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Humidifier', 'Class', 'Humidifier', 'A piece of equipment that adds moisture to a gas (e.g., air).', 'Equipment', 'http://data.ashrae.org/standard223#Humidifier')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Humidistat', 'Class', 'Humidistat', 'A piece of equipment that measures the relative humidity of the air and then uses this information to automatically adjust the amount of moisture in air.', 'Equipment', 'http://data.ashrae.org/standard223#Humidistat')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('HumiditySensor', 'Class', 'Humidity sensor', 'A `Sensor` that `observes` a `QuantifiableObservableProperty` that represents a measure of relative or absolute humidity.', 'Sensor', 'http://data.ashrae.org/standard223#HumiditySensor')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('HydronicHeatExchanger', 'Class', 'Hydronic heat exchanger', 'A piece of equipment that transfers heat from one liquid stream to another while keeping the two media separate.', 'Equipment', 'http://data.ashrae.org/standard223#HydronicHeatExchanger')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('IceMaker', 'Class', 'Ice maker', 'A piece of `Equipment` that makes ice.', 'Equipment', 'http://data.ashrae.org/standard223#IceMaker')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('IlluminanceSensor', 'Class', 'Illuminance sensor', 'A `LightSensor` that `observes` a `QuantifiableObservableProperty` that represents an illuminance, defined as the areal density of the luminous flux incident at a point on a surface.', 'LightSensor', 'http://data.ashrae.org/standard223#IlluminanceSensor')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Infrared-Signal', 'Class', 'Infrared signal', 'This class and its enumerated subclasses represent common infrared communication protocols. : Infrared-Signal Enumerations | Enumeration | |:-----------| | `Signal-FiberEthernet` (see {s223:Signal-FiberEthernet}) |', 'Light-Infrared', 'http://data.ashrae.org/standard223#Infrared-Signal')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('InletConnectionPoint', 'Class', 'Inlet connection point', 'An `InletConnectionPoint` is a `ConnectionPoint` for which a `Substance-Medium` is expected to flow into the associated `Connectable`.', 'ConnectionPoint', 'http://data.ashrae.org/standard223#InletConnectionPoint')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('inverseOf', 'Relation', 'inverse of', 'A `Relation` that associates `Relation`s that are inverses of one another, such as `connectedTo` and `connectedFrom`.', NULL, 'http://data.ashrae.org/standard223#inverseOf')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('isConnectionPointOf', 'Relation', 'is connection point of', 'One of two `Relation`s that associates a `ConnectionPoint` with a `Connectable` thing. It is the inverse of the relation `hasConnectionPoint` (see {s223:hasConnectionPoint}).', NULL, 'http://data.ashrae.org/standard223#isConnectionPointOf')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('isInternalReferenceOf', 'Relation', 'is internal reference of', 'The inverse of the relation `hasInternalReference` (see {s223:hasInternalReference}).', NULL, 'http://data.ashrae.org/standard223#isInternalReferenceOf')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ISMBand-BluetoothLE', 'Class', 'BluetoothLE', 'The BluetoothLE radio frequency communication protocol', 'UHF-ISMBand', 'http://data.ashrae.org/standard223#ISMBand-BluetoothLE')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ISMBand-IEEE802.11', 'Class', 'IEEE 802.11', 'The IEEE 802.11 radio frequency communication protocol', 'UHF-ISMBand', 'http://data.ashrae.org/standard223#ISMBand-IEEE802.11')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ISMBand-IEEE802.15.4', 'Class', 'IEEE 802.15.4', 'The IEEE 802.15.4 radio frequency communication protocol', 'UHF-ISMBand', 'http://data.ashrae.org/standard223#ISMBand-IEEE802.15.4')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ISMBand-LoRaWAN', 'Class', 'LoRaWAN', 'The LoRaWAN radio frequency communication protocol', 'UHF-ISMBand', 'http://data.ashrae.org/standard223#ISMBand-LoRaWAN')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ISMBand-NFC', 'Class', 'NFC', 'NFC radio frequency communication protocols', 'UHF-ISMBand', 'http://data.ashrae.org/standard223#ISMBand-NFC')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ISMBand-RFID', 'Class', 'RFID', 'RFID radio frequency communication protocols', 'UHF-ISMBand', 'http://data.ashrae.org/standard223#ISMBand-RFID')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Junction', 'Class', 'Junction', 'A `Junction` is a modeling construct used when a branching point within a `Connection` (see {s223:Connection}) is of significance, such as specifying the observation location of a `Sensor`, or when a modeler wants to expose a branch point within a containing piece of `Equipment`. When a `Junction` is used, what might have been modeled as a single, branched `Connection` is separated into three or more separate connections, all tied together with the `Junction` and its associated connection points. `Junction` is a subclass of `Connectable`, which gives it the ability to have connection points, but unlike `Equipment` (and like `Connection`) it is not allowed to change the `Substance-Medium` that passes through it. This is why `Junction` is a sibling class to `Equipment` and not a subclass. This constraint to maintain compatible mediums among a `Junction` and all of its associated `ConnectionPoint`s gives rise to multiple validation test cases, where the specified medium might be a pure medium, or a mixture with constituents (see {s223:Substance-Medium}).', 'Connectable', 'http://data.ashrae.org/standard223#Junction')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Light-Infrared', 'Class', 'Infrared light', 'This class and its enumerated subclasses represent the use of electromagnetic energy in the infrared frequency range for multiple purposes, including communication signals. : Light-Infrared Enumerations | Enumeration | |:-----------| | `Infrared-Signal` (see {s223:Infrared-Signal}) |', 'EM-Light', 'http://data.ashrae.org/standard223#Light-Infrared')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Light-Ultraviolet', 'Class', 'Ultraviolet light', '`Light-Ultraviolet`', 'EM-Light', 'http://data.ashrae.org/standard223#Light-Ultraviolet')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Light-Visible', 'Class', 'Visible light', '`Light-Visible`', 'EM-Light', 'http://data.ashrae.org/standard223#Light-Visible')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('LightSensor', 'Class', 'Light sensor', 'A `Sensor` that `observes` a `QuantifiableObservableProperty` that represents an attribute of light, as specified by the `QuantityKind` of the `Property` being observed, as described below.', 'Sensor', 'http://data.ashrae.org/standard223#LightSensor')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Liquid-Subcooled', 'Class', 'Subcooled liquid', 'Liquid-Subcooled', 'ThermodynamicPhase-Liquid', 'http://data.ashrae.org/standard223#Liquid-Subcooled')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Logical-False', 'Class', 'Logical false', 'Logical-False', 'Binary-Logical', 'http://data.ashrae.org/standard223#Logical-False')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Logical-True', 'Class', 'Logical true', 'Logical-True', 'Binary-Logical', 'http://data.ashrae.org/standard223#Logical-True')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Luminaire', 'Class', 'Luminaire', 'A piece of `Equipment` consisting of a light source(s) and ballast(s) or driver(s) (when applicable), together with the parts designed to distribute the light, to position and protect the light source(s), and to connect the light source(s) to the power supply. Also known as a light fixture.', 'Equipment', 'http://data.ashrae.org/standard223#Luminaire')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('mapsTo', 'Relation', 'maps to', 'A `Relation` that associates a `ConnectionPoint` of a `Connectable` with a corresponding `ConnectionPoint` of the one containing it. The associated `ConnectionPoint`s shall have a compatible medium (see {s223:Substance-Medium}).', NULL, 'http://data.ashrae.org/standard223#mapsTo')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Medium-Constituent', 'Class', 'Constituent', 'This class and its enumerated subclasses represent substances that may be combined to form a `Medium-Mix`. Constituents are distinguished from `Medium-Mix` and its subclasses in that constituents cannot use the `composedOf` relation to reference a concentration of other constituents. : Medium-Constituent Enumerations | Enumeration | |:-----------| | `Constituent-Ar` | | `Constituent-CH4` | | `Constituent-CO` | | `Constituent-CO2` | | `Constituent-Electricity` (see {s223:Constituent-Electricity}) | | `Constituent-EM` (see {s223:Constituent-EM}) | | `Constituent-Glycol` | | `Constituent-H2O` | | `Constituent-H2S` | | `Constituent-N2` | | `Constituent-NH3` | | `Constituent-NOX` (see {s223:Constituent-NOX}) | | `Constituent-O2` | | `Constituent-O3` | | `Constituent-Oil` | | `Constituent-Radon` | | `Constituent-Refrigerant` (see {s223:Constituent-Refrigerant}) | | `Constituent-SO2` | | `Constituent-VolatileOrganicCompounds` |', 'Substance-Medium', 'http://data.ashrae.org/standard223#Medium-Constituent')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Medium-MechanicalLinkage', 'Class', 'Mechanical linkage', 'This class supports the transfer of mechanical power at `ConnectionPoint`s or through `Connection`s.', 'Substance-Medium', 'http://data.ashrae.org/standard223#Medium-MechanicalLinkage')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Medium-Mix', 'Class', 'Mixed medium', 'This class and its subclasses represent substances that are composed of constituents. The components of a `Medium-Mix` can be modeled using the relations `composedOf` and `ofConstituent`. See Figure 10-8a and Figure 10-8b. Figure 10-8a shows `GlycolSolution-30Percent`, itself a subclass of `Water-GlycolSolution`, `Fluid-Water`, and `Mix-Fluid`, with a _Water Concentration_ property referencing 70% `Constituent-H2O` by the relation `ofConstituent` and a _Glycol Concentration_ property referencing 30% `Constituent-Glycol` also by the relation `ofConstituent`. Figure 10-8b shows `PowerAndSignal-PoE`, itself a subclass of `Mix-PowerAndSignal`, composed of a _Power_ `Property` referencing `Electricity-DC` and a _Communications_ `Property` referencing `Signal-WiredEthernet`. ![ ](figures/Figure_10-8_Substance.svg) : Medium-Mix Enumerations | Enumeration | |:-----------| | `Mix-Fluid` (see {s223:Mix-Fluid}) | | `Mix-PowerAndSignal` (see {s223:Mix-PowerAndSignal}) |', 'Substance-Medium', 'http://data.ashrae.org/standard223#Medium-Mix')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Medium-ThermalContact', 'Class', 'Thermal contact', 'This class supports the transfer of thermodynamic energy at `ConnectionPoint`s or through `Connection`s that does not involve electricity or moving a fluid such as air or water.', 'Substance-Medium', 'http://data.ashrae.org/standard223#Medium-ThermalContact')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('MicrowaveOven', 'Class', 'Microwave oven', 'An `ElectricOven` that cooks food by exposing it to electromagnetic radiation in the microwave frequency range.', 'ElectricOven', 'http://data.ashrae.org/standard223#MicrowaveOven')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Mix-Fluid', 'Class', 'Fluid mixture', 'This class and its enumerated subclasses represent substances that are commonly used to convey liquids or gases. : Mix-Fluid Enumerations | Enumeration | |:-----------| | `Fluid-Air` | | `Fluid-NaturalGas` | | `Fluid-Oil` | | `Fluid-Water` (see {s223:Fluid-Water}) |', 'Medium-Mix', 'http://data.ashrae.org/standard223#Mix-Fluid')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Mix-PowerAndSignal', 'Class', 'Power and signal mixture', 'This class and its enumerated subclasses represent substances that are used to convey the combination of electrical power and electrical communication signals. : Mix-PowerAndSignal Enumerations | Enumeration | |:-----------| | `PowerAndSignal-PoE` |', 'Medium-Mix', 'http://data.ashrae.org/standard223#Mix-PowerAndSignal')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Modulated-0-10V', 'Class', 'Modulated 0-10 V', 'Modulated-0-10V', 'Signal-Modulated', 'http://data.ashrae.org/standard223#Modulated-0-10V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Modulated-4-20mA', 'Class', 'Modulated 4-20 mA', 'Modulated-4-20mA', 'Signal-Modulated', 'http://data.ashrae.org/standard223#Modulated-4-20mA')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Modulated-Resistive', 'Class', 'Modulated resistive', 'Modulated-Resistive', 'Signal-Modulated', 'http://data.ashrae.org/standard223#Modulated-Resistive')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Monitor', 'Class', 'Monitor', 'An `ElectronicDisplay` designed primarily for the output of visual information supplied by a `Computer`.', 'ElectronicDisplay', 'http://data.ashrae.org/standard223#Monitor')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Motion-False', 'Class', 'Motion-based false', '`Motion-False`', 'Occupancy-Motion', 'http://data.ashrae.org/standard223#Motion-False')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Motion-True', 'Class', 'Motion-based true', '`Motion-True`', 'Occupancy-Motion', 'http://data.ashrae.org/standard223#Motion-True')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Motor', 'Class', 'Motor', 'A piece of `Equipment` that converts electrical energy into mechanical energy.', 'Equipment', 'http://data.ashrae.org/standard223#Motor')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('NOX-NO', 'Class', 'NO', 'Nitric oxide (NO)', 'Constituent-NOX', 'http://data.ashrae.org/standard223#NOX-NO')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('NOX-NO2', 'Class', 'NO2', 'Nitrogen dioxide (NO2)', 'Constituent-NOX', 'http://data.ashrae.org/standard223#NOX-NO2')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('NumberOfElectricalPhases-SinglePhase', 'Class', 'Single phase', 'Single phase', 'Numerical-NumberOfElectricalPhases', 'http://data.ashrae.org/standard223#NumberOfElectricalPhases-SinglePhase')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('NumberOfElectricalPhases-ThreePhase', 'Class', 'Three phase', 'Three phase', 'Numerical-NumberOfElectricalPhases', 'http://data.ashrae.org/standard223#NumberOfElectricalPhases-ThreePhase')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Numerical-Frequency', 'Class', 'Frequency', 'This class and its enumerated subclasses represent common frequencies for AC electricity service. : Numerical-Frequency Enumerations | Enumeration | |:-----------| | `Frequency-50Hz` | | `Frequency-60Hz` |', 'EnumerationKind-Numerical', 'http://data.ashrae.org/standard223#Numerical-Frequency')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Numerical-NumberOfElectricalPhases', 'Class', 'Number of electrical phases', 'This class and its enumerated subclasses represent all possible service phases for AC electricity service, i.e., single-phase or three-phase. The `hasNumberOfElectricalPhases` relation points to one of the values of this enumeration. : Numerical-NumberOfElectricalPhases Enumerations | Enumeration | |:-----------| | `NumberOfElectricalPhases-SinglePhase` | | `NumberOfElectricalPhases-ThreePhase` |', 'EnumerationKind-Numerical', 'http://data.ashrae.org/standard223#Numerical-NumberOfElectricalPhases')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Numerical-Voltage', 'Class', 'Voltage', 'This class and its enumerated subclasses represent common voltages for electricity service. : Numerical-Voltage Enumerations | Enumeration | |:-----------| | `Voltage-0V` | | `Voltage-2.5V` | | `Voltage-3V` | | `Voltage-5V` | | `Voltage-6V` | | `Voltage-12V` | | `Voltage-24V` | | `Voltage-48V` | | `Voltage-110V` | | `Voltage-120V` | | `Voltage-127V` | | `Voltage-139V` | | `Voltage-190V` | | `Voltage-208V` | | `Voltage-219V` | | `Voltage-220V` | | `Voltage-230V` | | `Voltage-240V` | | `Voltage-277V` | | `Voltage-347V` | | `Voltage-380V` | | `Voltage-400V` | | `Voltage-415V` | | `Voltage-480V` | | `Voltage-600V` | | `Voltage-1730V` | | `Voltage-1900V` | | `Voltage-2400V` | | `Voltage-3000V` | | `Voltage-3300V` | | `Voltage-3460V` | | `Voltage-3810V` | | `Voltage-4160V` | | `Voltage-5770V` | | `Voltage-6000V` | | `Voltage-6600V` | | `Voltage-10000V` | | `Voltage-PoE` (see {s223:Voltage-PoE}) |', 'EnumerationKind-Numerical', 'http://data.ashrae.org/standard223#Numerical-Voltage')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ObservableProperty', 'Class', 'Observable property', 'The term "observable" implies that reading the `ObservableProperty` value will return the result of a physical observation, usually by a `Sensor`. In contrast, the term "actuatable" (see {s223:ActuatableProperty}) implies that writing to the `ActuatableProperty` value will directly trigger a physical actuation.', 'Property', 'http://data.ashrae.org/standard223#ObservableProperty')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('observes', 'Relation', 'observes', 'A `Relation` that associates a `Sensor` with one `ObservableProperty` (see {s223:ObservableProperty}) which is used by the sensor to generate a measurement value (e.g., a temperature) or a simple observation of a stimulus causing a reaction (e.g., a current binary switch that closes a dry contact when a fan is powered on).', NULL, 'http://data.ashrae.org/standard223#observes')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Occupancy-Motion', 'Class', 'Motion-based occupancy', 'This class and its enumerated subclasses represent the detection of human motion in a space. : Occupancy-Motion Enumerations | Enumeration | |:-----------| | `Motion-False` | | `Motion-True` |', 'EnumerationKind-Occupancy', 'http://data.ashrae.org/standard223#Occupancy-Motion')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Occupancy-Occupied', 'Class', 'Generic occupancy', 'This class and its enumerated subclasses represent the generic detection of human occupancy in a space. : Occupancy-Occupied Enumerations | Enumeration | |:-----------| | `Occupied-False` | | `Occupied-True` |', 'EnumerationKind-Occupancy', 'http://data.ashrae.org/standard223#Occupancy-Occupied')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Occupancy-Presence', 'Class', 'Presence-based occupancy', 'This class and its enumerated subclasses represent the detection of human presence in a space. : Occupancy-Presence Enumerations | Enumeration | |:-----------| | `Presence-False` | | `Presence-True` |', 'EnumerationKind-Occupancy', 'http://data.ashrae.org/standard223#Occupancy-Presence')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('OccupancySensor', 'Class', 'Occupancy sensor', 'A `Sensor` that `observes` an `ObservableProperty` that represents an attribute of occupancy in a space.', 'Sensor', 'http://data.ashrae.org/standard223#OccupancySensor')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('OccupantCountSensor', 'Class', 'Occupant count sensor', 'An `OccupancySensor` that `observes` a `QuantifiableObservableProperty` that represents a population, usually of humans, within a sensing region.', 'OccupancySensor', 'http://data.ashrae.org/standard223#OccupantCountSensor')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('OccupantMotionSensor', 'Class', 'Occupant motion sensor', 'An `OccupancySensor` that `observes` an `EnumeratedObservableProperty` that represents motion within a sensing region.', 'OccupancySensor', 'http://data.ashrae.org/standard223#OccupantMotionSensor')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('OccupantPresenceSensor', 'Class', 'Occupant presence sensor', 'An `OccupancySensor` that `observes` an `EnumeratedObservableProperty` that represents presence within a sensing region.', 'OccupancySensor', 'http://data.ashrae.org/standard223#OccupantPresenceSensor')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Occupied-False', 'Class', 'False', '`Occupied-False`', 'Occupancy-Occupied', 'http://data.ashrae.org/standard223#Occupied-False')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Occupied-True', 'Class', 'True', '`Occupied-True`', 'Occupancy-Occupied', 'http://data.ashrae.org/standard223#Occupied-True')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ofConstituent', 'Relation', 'of constituent', 'A `Relation` that associates a `Property` that characterizes a `Medium-Mix` with one of the constituents of that mix (e.g., `Fluid-Water` `composedOf` `Property` `ofConstituent` `Constituent-H2O`).', NULL, 'http://data.ashrae.org/standard223#ofConstituent')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ofMedium', 'Relation', 'of medium', 'A `Relation` that associates a `Property` with the specific Medium it describes. A `Property` corresponding to the temperature of a medium would be associated with this medium using the relation `ofMedium`.', NULL, 'http://data.ashrae.org/standard223#ofMedium')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ofSubstance', 'Relation', 'of substance', 'A `Relation` that associates a `Property` being observed by a `Sensor` with the `EnumerationKind-Substance` it characterizes within a specific `Substance-Medium`. For example, to denote the concentration of a `EnumerationKind-Substance` in a `Substance-Medium`, `ofSubstance` is used. Typically, there is also an `ofMedium` relation between the observed `Property` and the `Substance-Medium` (see Figures 10-9 and 10-10). For example, to represent the concentration of CO2 in air, we use `ofSubstance` to relate to CO2 and `ofMedium` to relate to air. The term `ofSubstance` is broad enough to include situations where a sensor is used to detect constituents that should not be present in a medium, such as ammonia in air. Therefore, `ofSubstance` is used to indicate the substance of interest, while `ofConstituent` would indicate a constituent that is normally present in the composition of the mix.', NULL, 'http://data.ashrae.org/standard223#ofSubstance')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('OnOff-Off', 'Class', 'Off', 'OnOff-Off', 'Binary-OnOff', 'http://data.ashrae.org/standard223#OnOff-Off')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('OnOff-On', 'Class', 'On', 'OnOff-On', 'Binary-OnOff', 'http://data.ashrae.org/standard223#OnOff-On')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('OutdoorPhysicalSpace', 'Class', 'Outdoor physical space', 'A `PhysicalSpace` that is outside of the building where, for example, outdoor ambient properties might be measured, within a suitably defined `DomainSpace`.', 'PhysicalSpace', 'http://data.ashrae.org/standard223#OutdoorPhysicalSpace')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('OutletConnectionPoint', 'Class', 'Outlet connection point', 'An `OutletConnectionPoint` is a `ConnectionPoint` for which a `Substance-Medium` is expected to flow out of the associated `Connectable`.', 'ConnectionPoint', 'http://data.ashrae.org/standard223#OutletConnectionPoint')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('pairedConnectionPoint', 'Relation', 'paired connection point', 'A `Relation` that associates two `ConnectionPoint`s where an `InletConnectionPoint` shares the same `Substance-Medium` with an `OutletConnectionPoint`.', NULL, 'http://data.ashrae.org/standard223#pairedConnectionPoint')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Particulate-PM1.0', 'Class', 'PM 1.0', 'Particulate-PM1.0', 'Substance-Particulate', 'http://data.ashrae.org/standard223#Particulate-PM1.0')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Particulate-PM10.0', 'Class', 'PM 10.0', 'Particulate-PM10.0', 'Substance-Particulate', 'http://data.ashrae.org/standard223#Particulate-PM10.0')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Particulate-PM2.5', 'Class', 'PM 2.5', 'Particulate-PM2.5', 'Substance-Particulate', 'http://data.ashrae.org/standard223#Particulate-PM2.5')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Particulate-Smoke', 'Class', 'Smoke', 'Smoke as a particulate of unspecified size, but formed as a product of combustion', 'Substance-Particulate', 'http://data.ashrae.org/standard223#Particulate-Smoke')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ParticulateSensor', 'Class', 'Particulate sensor', 'A `Sensor` that `observes` a `QuantifiableObservableProperty` that represents an amount of a particulate in a medium, in contrast to a `ConcentrationSensor` that `observes` a `QuantifiableObservableProperty` that represents a concentration of a miscible constituent in a medium (see {s223:ConcentrationSensor}). The 223 standard does not constrain the `Unit` or `QuantityKind` reported by a `ParticulateSensor`, but possible `QuantityKind`s include `Density` (mass per volume), `ParticleNumberDensity` (count per volume), and `DimensionlessRatio` (with units such as `PPM` or `PPB`). Some particulate sensors may claim to report a raw count of particles, for which a `QuantityKind` of `Count` could be used, but the required context for such a measurement should be provided in the sensor''s documentation to specify if it in fact measures a count per volume (e.g., `ParticleNumberDensity`), time (e.g., `CountRate` or `ParticleCurrent`), or some other combination. Explicitly declaring the `QuantityKind` of a sensor''s output is preferable to relying on implicit assumptions.', 'Sensor', 'http://data.ashrae.org/standard223#ParticulateSensor')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('PersonalComputer', 'Class', 'Personal computer', 'A `Computer` designed primarily used by a single person.', 'Computer', 'http://data.ashrae.org/standard223#PersonalComputer')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('PhotovoltaicModule', 'Class', 'Photovoltaic module', 'A piece of equipment that converts sunlight into electricity.', 'Equipment', 'http://data.ashrae.org/standard223#PhotovoltaicModule')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('PhysicalSpace', 'Class', 'Physical space', 'An architectural concept representing a room, a part of a room, a collection of rooms, or any other physical region in a building. PhysicalSpaces may be grouped to define larger `PhysicalSpace`s using the relation `contains` (see {s223:contains}).', 'Concept', 'http://data.ashrae.org/standard223#PhysicalSpace')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Pipe', 'Class', 'Pipe', 'A `Connection` that is used primarily to transport liquids and gases such as water, sewage, natural gas, and compressed air.', 'Connection', 'http://data.ashrae.org/standard223#Pipe')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('PoE-802.3af-1', 'Class', 'PoE 802.3af-1', 'PoE-802.3af-1', 'DC-PoE', 'http://data.ashrae.org/standard223#PoE-802.3af-1')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('PoE-802.3at-2', 'Class', 'PoE 802.3at-2', 'PoE-802.3at-2', 'DC-PoE', 'http://data.ashrae.org/standard223#PoE-802.3at-2')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('PoE-802.3bt-3', 'Class', 'PoE 802.3bt-3', 'PoE-802.3bt-3', 'DC-PoE', 'http://data.ashrae.org/standard223#PoE-802.3bt-3')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('PoE-802.3bt-4', 'Class', 'PoE 802.3bt-4', 'PoE-802.3bt-4', 'DC-PoE', 'http://data.ashrae.org/standard223#PoE-802.3bt-4')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Position-Closed', 'Class', 'Closed', 'Position-Closed', 'Binary-Position', 'http://data.ashrae.org/standard223#Position-Closed')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Position-Open', 'Class', 'Open', 'Position-Open', 'Binary-Position', 'http://data.ashrae.org/standard223#Position-Open')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('PowerAndSignal-PoE', 'Class', 'Power over Ethernet (PoE)', 'PowerAndSignal-PoE', 'Mix-PowerAndSignal', 'http://data.ashrae.org/standard223#PowerAndSignal-PoE')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('PowerOverEthernetPort', 'Class', 'Power over ethernet port', 'A piece of `Equipment` that connects and is capable of powering one instance of electrical equipment, such as computers and Wi-Fi access points, as well as connect it to an Ethernet network so it can communicate with other equipment and, optionally, with the Internet.', 'Equipment', 'http://data.ashrae.org/standard223#PowerOverEthernetPort')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('PowerOverEthernetSwitch', 'Class', 'Power over Ethernet (PoE) switch', 'A piece of `Equipment` that connects and is capable of powering one or more instances of electrical equipment, such as computers and Wi-Fi access points, as well as connect the equipment to an Ethernet network so they can communicate with each other and, optionally, to the Internet.', 'Equipment', 'http://data.ashrae.org/standard223#PowerOverEthernetSwitch')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Presence-False', 'Class', 'Presence-based false', '`Presence-False`', 'Occupancy-Presence', 'http://data.ashrae.org/standard223#Presence-False')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Presence-True', 'Class', 'Presence-based true', '`Presence-True`', 'Occupancy-Presence', 'http://data.ashrae.org/standard223#Presence-True')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('PressureSensor', 'Class', 'Pressure sensor', 'A `Sensor` that `observes` a `QuantifiableObservableProperty` that represents a measure of pressure.', 'Sensor', 'http://data.ashrae.org/standard223#PressureSensor')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Property', 'Class', 'Property', 'An attribute, quality, or characteristic of a feature of interest. The `Property` class is the parent of all variations of a `Property`, which are: - `ActuatableProperty`, a subclass of `Property` that can be modified by user or machine outside of the model (typically command); - `ObservableProperty`, a subclass of `Property` that are observed (typically measures); - `EnumerableProperty`, a subclass of `Property` defined by `EnumerationKind`; and - `QuantifiableProperty`, a subclass of `Property` defined by numerical values. And their subclass combinations: - `QuantifiableActuatableProperty`, - `QuantifiableObservableProperty`, - `EnumeratedObservableProperty`, and - `EnumeratedActuatableProperty`. A `QuantifiableProperty` (or subclass thereof) shall always be associated with a `Unit` and a `QuantityKind`, either explicitly from the `Property`, or through the associated Value. If the `Unit` is defined, the SHACL reasoner (if invoked) will figure out and assert a `QuantityKind` if it is unambiguous. Enumerable properties shall be associated with an `EnumerationKind`. Different flavors of properties are shown in Figure 11-1. ![Different flavors of Properties](figures/Figure_11-1_Flavors_of_Properties.svg) A `Property` instance that is not an instance of one of the subclasses is unconstrained with respect to its value.', 'Concept', 'http://data.ashrae.org/standard223#Property')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Pump', 'Class', 'Pump', 'A piece of `Equipment` that imparts energy to a fluid, drawing a fluid into itself through an inlet port, and forcing the fluid out through an outlet port.', 'Equipment', 'http://data.ashrae.org/standard223#Pump')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('QuantifiableActuatableProperty', 'Class', 'Quantifiable actuatable property', 'This class is for instances of `QuantifiableProperty` for which numerical values are specified to be modifiable by a user or a machine outside of the model, like a setpoint.', 'ActuatableProperty', 'http://data.ashrae.org/standard223#QuantifiableActuatableProperty')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('QuantifiableObservableProperty', 'Class', 'Quantifiable observable property', 'This class is for instances of `QuantifiableProperty` for which numerical values are observed, like a temperature reading or a voltage measure.', 'ObservableProperty', 'http://data.ashrae.org/standard223#QuantifiableObservableProperty')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('QuantifiableProperty', 'Class', 'Quantifiable property', 'This class is for quantifiable values that describe an object (`System`, `Equipment`, etc.) that are typically static (`hasValue`). That is, they are neither measured nor specified in the course of operations.', 'Property', 'http://data.ashrae.org/standard223#QuantifiableProperty')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('RadiantHeater', 'Class', 'Radiant heater', 'A piece of `Equipment` with heating or cooling surface that delivers 50% or more of its heat transfer by radiation. A `RadiantHeater` shall: - Have the role `Role-Heating`. - Have at least one outlet connection point using the medium `Light-Infrared`. - Conform to exactly one of the following patterns: - **Pattern 1:** - Exactly one inlet connection point using the medium `Constituent-Electricity` or `Fluid-NaturalGas`. - **Pattern 2:** - Exactly one inlet connection point using the medium `Fluid-Water`. - Exactly one outlet connection point using the medium `Fluid-Water`.', 'Equipment', 'http://data.ashrae.org/standard223#RadiantHeater')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Radiator', 'Class', 'Radiator', 'A piece of `Equipment` that provides primarily convective heating to a room using electricity, steam, or water (e.g., electric baseboard heaters, heated floors, or traditional radiators).', 'Equipment', 'http://data.ashrae.org/standard223#Radiator')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-123', 'Class', 'Refrigerant R-123', '`Refrigerant-R-123`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-123')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-1234yf', 'Class', 'Refrigerant R-1234yf', '`Refrigerant-R-1234yf`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-1234yf')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-1234ze', 'Class', 'Refrigerant R-1234ze', '`Refrigerant-R-1234ze`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-1234ze')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-134A', 'Class', 'Refrigerant R-134A', '`Refrigerant-R-134A`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-134A')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-22', 'Class', 'Refrigerant R-22', '`Refrigerant-R-22`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-22')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-290', 'Class', 'Refrigerant R-290', '`Refrigerant-R-290` (Propane)', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-290')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-32', 'Class', 'Refrigerant R-32', '`Refrigerant-R-32`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-32')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-404A', 'Class', 'Refrigerant R-404A', '`Refrigerant-R-404A`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-404A')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-407A', 'Class', 'Refrigerant R-407A', '`Refrigerant-R-407A`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-407A')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-407C', 'Class', 'Refrigerant R-407C', '`Refrigerant-R-407C`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-407C')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-407F', 'Class', 'Refrigerant R-407F', '`Refrigerant-R-407F`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-407F')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-410A', 'Class', 'Refrigerant R-410A', '`Refrigerant-R-410A`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-410A')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-422A', 'Class', 'Refrigerant R-422A', '`Refrigerant-R-422A`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-422A')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-422C', 'Class', 'Refrigerant R-422C', '`Refrigerant-R-422C`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-422C')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-422D', 'Class', 'Refrigerant R-422D', '`Refrigerant-R-422D`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-422D')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-427A', 'Class', 'Refrigerant R-427A', '`Refrigerant-R-427A`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-427A')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-438A', 'Class', 'Refrigerant R-438A', '`Refrigerant-R-438A`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-438A')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-444A', 'Class', 'Refrigerant R-444A', '`Refrigerant-R-444A`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-444A')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-445A', 'Class', 'Refrigerant R-445A', '`Refrigerant-R-445A`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-445A')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-448A', 'Class', 'Refrigerant R-448A', '`Refrigerant-R-448A`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-448A')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-449A', 'Class', 'Refrigerant R-449A', '`Refrigerant-R-449A`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-449A')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-450A', 'Class', 'Refrigerant R-450A', '`Refrigerant-R-450A`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-450A')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-454A', 'Class', 'Refrigerant R-454A', '`Refrigerant-R-454A`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-454A')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-454C', 'Class', 'Refrigerant R-454C', '`Refrigerant-R-454C`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-454C')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-455A', 'Class', 'Refrigerant R-455A', '`Refrigerant-R-455A`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-455A')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-457A', 'Class', 'Refrigerant R-457A', '`Refrigerant-R-457A`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-457A')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-459B', 'Class', 'Refrigerant R-459B', '`Refrigerant-R-459B`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-459B')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-507', 'Class', 'Refrigerant R-507', '`Refrigerant-R-507`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-507')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-513A', 'Class', 'Refrigerant R-513A', '`Refrigerant-R-513A`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-513A')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-516A', 'Class', 'Refrigerant R-516A', '`Refrigerant-R-516A`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-516A')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-600A', 'Class', 'Refrigerant R-600A', '`Refrigerant-R-600A`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-600A')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-717', 'Class', 'Refrigerant R-717', '`Refrigerant-R-717`', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-717')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerant-R-744', 'Class', 'Refrigerant R-744', '`Refrigerant-R-744` (Transcritical CO2)', 'Constituent-Refrigerant', 'http://data.ashrae.org/standard223#Refrigerant-R-744')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Refrigerator', 'Class', 'Refrigerator', 'A piece of `Equipment` that maintains an internal temperature below the surrounding ambient temperature but above the freezing point of water.', 'Equipment', 'http://data.ashrae.org/standard223#Refrigerator')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Relation', 'Class', 'Relation', 'A `Relation` associates the subject and the object in an RDF triple, the *predicate* portion of a *(subject, predicate, object)* triple.', 'Concept', 'http://data.ashrae.org/standard223#Relation')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('RelationWithInverse', 'Class', 'Relation with inverse', 'An `RelationWithInverse` is modeling construct used to define symmetric behavior for certain relations in the standard such as `connectedTo` and `connectedFrom`.', 'Relation', 'http://data.ashrae.org/standard223#RelationWithInverse')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('RF-Signal', 'Class', 'Radio frequency signal', 'This class and its enumerated subclasses represent the use of radio frequency for creating communication signals, and common communication protocols. The radio spectrum of frequencies (`RF-Signal`) is divided into bands (i.e., subclasses) with conventional names designated by the International Telecommunication Union (e.g., UHF for Ultra High Frequency). : RF-Signal Enumerations | Enumeration | |:-----------| | `Signal-EHF` | | `Signal-ELF` | | `Signal-HF` | | `Signal-LF` | | `Signal-MF` | | `Signal-SHF` | | `Signal-SLF` | | `Signal-THF` | | `Signal-UHF` (see {s223:Signal-UHF}) | | `Signal-ULF` | | `Signal-VHF` | | `Signal-VLF` | | `Signal-Wideband` (see {s223:Signal-Wideband}) |', 'EM-RF', 'http://data.ashrae.org/standard223#RF-Signal')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('RFOutlet', 'Class', 'Radio frequency outlet', 'A piece of `Equipment` that contains one or more receptacles for connecting electrical equipment to a radio frequency (RF) communication network, via, for example, a coaxial cable.', 'Equipment', 'http://data.ashrae.org/standard223#RFOutlet')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Role-Condenser', 'Class', 'Condenser role', '`Role-Condenser`', 'EnumerationKind-Role', 'http://data.ashrae.org/standard223#Role-Condenser')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Role-Cooling', 'Class', 'Cooling role', '`Role-Cooling`', 'EnumerationKind-Role', 'http://data.ashrae.org/standard223#Role-Cooling')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Role-Dehumidifying', 'Class', 'Dehumidifying role', '`Role-Dehumidifying`', 'EnumerationKind-Role', 'http://data.ashrae.org/standard223#Role-Dehumidifying')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Role-Discharge', 'Class', 'Discharge role', '`Role-Discharge`', 'EnumerationKind-Role', 'http://data.ashrae.org/standard223#Role-Discharge')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Role-Economizer', 'Class', 'Economizer role', '`Role-Economizer`', 'EnumerationKind-Role', 'http://data.ashrae.org/standard223#Role-Economizer')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Role-Evaporator', 'Class', 'Evaporator role', '`Role-Evaporator`', 'EnumerationKind-Role', 'http://data.ashrae.org/standard223#Role-Evaporator')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Role-Exhaust', 'Class', 'Exhaust role', '`Role-Exhaust`', 'EnumerationKind-Role', 'http://data.ashrae.org/standard223#Role-Exhaust')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Role-Expansion', 'Class', 'Expansion role', '`Role-Expansion`', 'EnumerationKind-Role', 'http://data.ashrae.org/standard223#Role-Expansion')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Role-Generator', 'Class', 'Generator role', '`Role-Generator`', 'EnumerationKind-Role', 'http://data.ashrae.org/standard223#Role-Generator')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Role-Heating', 'Class', 'Heating role', '`Role-Heating`', 'EnumerationKind-Role', 'http://data.ashrae.org/standard223#Role-Heating')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Role-HeatRecovery', 'Class', 'Heat recovery role', 'Role-HeatRecovery', 'EnumerationKind-Role', 'http://data.ashrae.org/standard223#Role-HeatRecovery')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Role-HeatTransfer', 'Class', 'Heat transfer role', 'Role-HeatTransfer', 'EnumerationKind-Role', 'http://data.ashrae.org/standard223#Role-HeatTransfer')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Role-Load', 'Class', 'Load role', '`Role-Load`', 'EnumerationKind-Role', 'http://data.ashrae.org/standard223#Role-Load')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Role-OutdoorAirIntake', 'Class', 'Outdoor air intake role', '`Role-OutdoorAirIntake`', 'EnumerationKind-Role', 'http://data.ashrae.org/standard223#Role-OutdoorAirIntake')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Role-Primary', 'Class', 'Primary role', '`Role-Primary`', 'EnumerationKind-Role', 'http://data.ashrae.org/standard223#Role-Primary')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Role-Recirculating', 'Class', 'Recirculating role', '`Role-Recirculating`', 'EnumerationKind-Role', 'http://data.ashrae.org/standard223#Role-Recirculating')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Role-Relief', 'Class', 'Relief role', '`Role-Relief`', 'EnumerationKind-Role', 'http://data.ashrae.org/standard223#Role-Relief')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Role-Return', 'Class', 'Return role', '`Role-Return`', 'EnumerationKind-Role', 'http://data.ashrae.org/standard223#Role-Return')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Role-Secondary', 'Class', 'Secondary role', '`Role-Secondary`', 'EnumerationKind-Role', 'http://data.ashrae.org/standard223#Role-Secondary')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Role-Supply', 'Class', 'Supply role', '`Role-Supply`', 'EnumerationKind-Role', 'http://data.ashrae.org/standard223#Role-Supply')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Role-Ventilating', 'Class', 'Ventilating role', '`Role-Ventilating`', 'EnumerationKind-Role', 'http://data.ashrae.org/standard223#Role-Ventilating')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Sensor', 'Class', 'Sensor', 'A `Sensor` `observes` an `ObservableProperty` (see {s223:ObservableProperty}) which may be quantifiable (see {s223:QuantifiableObservableProperty}), such as a temperature, flow, or concentration, or enumerable (see {s223:EnumeratedObservableProperty}), such as an occupancy state. If a `Sensor` observes a `QuantifiableObservableProperty` relative to an assumed or common reference point, it can be modeled with only an observation location. For example: ```turtle @prefix : <http://example.com/> . :example1 a s223:TemperatureSensor ; s223:hasObservationLocation :location1 ; qudt:hasQuantityKind quantitykind:Temperature . ``` If a `Sensor` observes a `QuantifiableObservableProperty` relative to a unique or specified reference point, it can be modeled with an observation location and a reference location, and indicating the difference between two values by setting `qudt:isDeltaQuantity` to `true`. For example: ```turtle @prefix : <http://example.com/> . :example2 a s223:TemperatureSensor ; s223:hasObservationLocation :location1 ; s223:hasReferenceLocation :location2 ; qudt:hasQuantityKind quantitykind:Temperature ; qudt:isDeltaQuantity true . ```', 'Equipment', 'http://data.ashrae.org/standard223#Sensor')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ServerComputer', 'Class', 'Server computer', 'A `Computer` that is primarily used by multiple people, or for the execution of tasks not directly coupled to human interaction.', 'Computer', 'http://data.ashrae.org/standard223#ServerComputer')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Shower', 'Class', 'Shower', 'A piece of `Equipment` for showering that receives as an input hot or cold water dispensed from one or two `Faucet`s, and is designed to hold a specific volume of water and release the held water through a `Drain`.', 'Equipment', 'http://data.ashrae.org/standard223#Shower')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Signal-EHF', 'Class', 'EHF', 'RF Signal Extremely High Frequency 30 GHz to 300 GHz', 'RF-Signal', 'http://data.ashrae.org/standard223#Signal-EHF')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Signal-EIA485', 'Class', 'EIA485', 'Signal EIA485', 'Electricity-Signal', 'http://data.ashrae.org/standard223#Signal-EIA485')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Signal-ELF', 'Class', 'ELF', 'RF Signal Extremely Low Frequency 3 Hz to 30 Hz', 'RF-Signal', 'http://data.ashrae.org/standard223#Signal-ELF')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Signal-FiberEthernet', 'Class', 'Fiber Ethernet', 'This class and its enumerated subclasses represent common fiber Ethernet communication protocols. : Signal-FiberEthernet Enumerations | Enumeration | |:-----------| | `FiberEthernet-1X9` | | `FiberEthernet-300PIN` | | `FiberEthernet-CFP` | | `FiberEthernet-CFP2` | | `FiberEthernet-CFP4` | | `FiberEthernet-CPAK` | | `FiberEthernet-CXP` | | `FiberEthernet-GBIC` | | `FiberEthernet-QSFP` | | `FiberEthernet-QSFP+` | | `FiberEthernet-QSFP28` | | `FiberEthernet-SFF` | | `FiberEthernet-SFP` | | `FiberEthernet-SFP+` | | `FiberEthernet-X2` | | `FiberEthernet-XENPAK` | | `FiberEthernet-XFP` |', 'Infrared-Signal', 'http://data.ashrae.org/standard223#Signal-FiberEthernet')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Signal-HF', 'Class', 'HF', 'RF Signal High Frequency 3 MHz to 30 MHz', 'RF-Signal', 'http://data.ashrae.org/standard223#Signal-HF')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Signal-IEC14908', 'Class', 'IEC 14908', 'Signal-IEC14908', 'Electricity-Signal', 'http://data.ashrae.org/standard223#Signal-IEC14908')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Signal-LF', 'Class', 'LF', 'RF Signal Low Frequency 30 kHz to 300 kHz', 'RF-Signal', 'http://data.ashrae.org/standard223#Signal-LF')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Signal-MF', 'Class', 'MF', 'RF Signal Medium Frequency 300 kHz to 3 MHz', 'RF-Signal', 'http://data.ashrae.org/standard223#Signal-MF')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Signal-Modulated', 'Class', 'Modulated signal', 'This class and its enumerated subclasses represent common analog communication protocols. : Signal-Modulated Enumerations | Enumeration | |:-----------| | `Modulated-0-10V` | | `Modulated-4-20mA` | | `Modulated-Resistive` |', 'Electricity-Signal', 'http://data.ashrae.org/standard223#Signal-Modulated')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Signal-SHF', 'Class', 'SHF', 'RF Signal Super High Frequency 3 GHz to 30 GHz', 'RF-Signal', 'http://data.ashrae.org/standard223#Signal-SHF')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Signal-SLF', 'Class', 'SLF', 'RF Signal Super Low Frequency 30 Hz to 300 Hz', 'RF-Signal', 'http://data.ashrae.org/standard223#Signal-SLF')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Signal-THF', 'Class', 'THF', 'RF Signal Tremendously High Frequency 300 GHz to 3 THz', 'RF-Signal', 'http://data.ashrae.org/standard223#Signal-THF')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Signal-UHF', 'Class', 'UHF', 'RF Signal Ultra High Frequency 300 MHz to 3 GHz', 'RF-Signal', 'http://data.ashrae.org/standard223#Signal-UHF')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Signal-ULF', 'Class', 'ULF', 'RF Signal Ultra Low Frequency 300 Hz to 3 kHz', 'RF-Signal', 'http://data.ashrae.org/standard223#Signal-ULF')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Signal-USB', 'Class', 'USB', 'Signal-USB', 'Electricity-Signal', 'http://data.ashrae.org/standard223#Signal-USB')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Signal-VHF', 'Class', 'VHF', 'RF Signal Very High Frequency 30 MHz to 300 MHz', 'RF-Signal', 'http://data.ashrae.org/standard223#Signal-VHF')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Signal-VLF', 'Class', 'VLF', 'RF Signal Very Low Frequency 3 kHz to 30 kHz', 'RF-Signal', 'http://data.ashrae.org/standard223#Signal-VLF')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Signal-Wideband', 'Class', 'Wideband', 'Signal-Wideband', 'RF-Signal', 'http://data.ashrae.org/standard223#Signal-Wideband')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Signal-WiredEthernet', 'Class', 'Wired Ethernet', 'This class and its enumerated subclasses represent common wired Ethernet communication protocols. : Signal-WiredEthernet Enumerations | Enumeration | |:-----------| | `WiredEthernet-2.5GBASE-T` | | `WiredEthernet-2.5GBASE-T1` | | `WiredEthernet-5GBASE-T` | | `WiredEthernet-5GBASE-T1` | | `WiredEthernet-10BASE-T` | | `WiredEthernet-10BASE-T1L` | | `WiredEthernet-10BASE-T1S` | | `WiredEthernet-10GBASE-T` | | `WiredEthernet-10GBASE-T1` | | `WiredEthernet-25GBASE-T` | | `WiredEthernet-40GBASE-T` | | `WiredEthernet-100BASE-T1` | | `WiredEthernet-100BASE-TX` | | `WiredEthernet-1000BASE-T` | | `WiredEthernet-1000BASE-T1` |', 'Electricity-Signal', 'http://data.ashrae.org/standard223#Signal-WiredEthernet')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('SingleDuctTerminal', 'Class', 'Single duct terminal', 'A `TerminalUnit` unit that has one ducted air inlet and a damper for regulating the flow of air.', 'TerminalUnit', 'http://data.ashrae.org/standard223#SingleDuctTerminal')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Sink', 'Class', 'Sink', 'A piece of `Equipment` for manually washing hands, dishes, or other items that receives as an input hot or cold water dispensed from one or two `Faucet`s, and is designed to hold a specific volume of water and release the held water through a `Drain`.', 'Equipment', 'http://data.ashrae.org/standard223#Sink')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('SolarThermalCollector', 'Class', 'Solar thermal collector', 'A piece of `Equipment` that converts sunlight into thermal energy.', 'Equipment', 'http://data.ashrae.org/standard223#SolarThermalCollector')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('SteamInjector', 'Class', 'Steam injector', 'A piece of `Equipment` for increasing the humidity of an air stream by injecting steam into the air stream.', 'Equipment', 'http://data.ashrae.org/standard223#SteamInjector')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Substance-Medium', 'Class', 'Medium', 'This class and its enumerated subclasses represent substances that facilitate the conveyance of matter, energy, or information. It is used to qualify `Connection`s and `ConnectionPoint`s with the relation `hasMedium` (see {s223:hasMedium}). `Substance-Medium` is also the root of the medium hierarchy that is used to ensure compatibility of different medium designations. For example, `Fluid-Water` and `Water-ChilledWater` are alternative but compatible ways of identifying what is flowing in a pipe, using different degrees of specificity. `Water-ChilledWater` and `Water-HotWater` are not compatible. Compatibility is determined by testing if one medium is a subclass of the other. This gets a bit more complicated in the case of mixtures, where at least one of the constituents of a mixture must be compatible with at least one of the constituents of the other medium. Testing for medium compatibility is done in the context of entities that have a `hasMedium` relation, such as * `Connection` and its associated `ConnectionPoint`s (see {s223:Connection}); * `Junction` and its associated `ConnectionPoint`s (see {s223:Junction}); * `Filter` and its associated `ConnectionPoint`s (see {s223:Filter}); * any `Concept` that has a `hasMedium` relation, compared with an associated `Property` with an `ofMedium` relation (see {s223:Concept}). These tests are listed in the constraint tables for the respective classes listed above, identified as Case 1, Case 2, etc. : Substance-Medium Enumerations | Enumeration | |:-----------| | `Medium-Constituent` (see {s223:Medium-Constituent}) | | `Medium-MechanicalLinkage` | | `Medium-Mix` (see {s223:Medium-Mix}) | | `Medium-ThermalContact` |', 'EnumerationKind-Substance', 'http://data.ashrae.org/standard223#Substance-Medium')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Substance-Particulate', 'Class', 'Particulate', 'This class and its enumerated subclasses represent common size thresholds of interest for particulate matter that is suspended in a medium in a way that maintains the physical and chemical properties of the medium. ![Particulate Concentration](figures/Figure_x-y_Particulate_Concentration.svg) Figure 10-9 shows an instance of a `Connection` with `hasMedium` referencing `Fluid-Air` that has a `Property` _Particulate Concentration_ of particles with a diameter of 2.5 micrometres (0.0025 mm) or smaller in units of micrograms per cubic meter. ![Carbon Monoxide Concentration](figures/Figure_x-y_Medium_Concentration.svg) Figure 10-10 shows an instance of a `Property` _CO Concentration_ with `ofSubstance` referencing carbon monoxide `Constituent-CO` and `ofMedium` referencing `Fluid-Air` measured in parts-per-million. This figure also shows that the value of this `Property` can be obtained by using the BACnet protocol via the external reference to get the `present-value` of `analog-value,67` in the device with an instance number `12345`. : Substance-Particulate Enumerations | Enumeration | |:-----------| | `Particulate-PM1.0` | | `Particulate-PM2.5` | | `Particulate-PM10.0` | | `Particulate-Smoke` |', 'EnumerationKind-Substance', 'http://data.ashrae.org/standard223#Substance-Particulate')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Substance-Soot', 'Class', 'Soot', 'Carbon particles resulting from the incomplete combustion of hydrocarbons. Soot is considered a hazardous substance with carcinogenic properties.', 'EnumerationKind-Substance', 'http://data.ashrae.org/standard223#Substance-Soot')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('SymmetricRelation', 'Class', 'Symmetric relation', 'A modeling construct used to define symmetric behavior for certain relations in the standard such as `cnx`, `connected`, and `pairedConnectionPoint`.', 'Relation', 'http://data.ashrae.org/standard223#SymmetricRelation')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('System', 'Class', 'System', 'A logical grouping of one or more pieces of `Equipment`, `Junction`s, or other `System`s for some functional purpose.', 'Concept', 'http://data.ashrae.org/standard223#System')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Television', 'Class', 'Television', 'An `ElectronicDisplay` that is designed primarily for the output of visual information supplied by a media broadcaster, and that typically has an integral tuner that is capable of selecting a single channel for display from the available input channel range.', 'ElectronicDisplay', 'http://data.ashrae.org/standard223#Television')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('TemperatureSensor', 'Class', 'Temperature sensor', 'A `Sensor` that `observes` a `QuantifiableObservableProperty` that represents a measure of temperature.', 'Sensor', 'http://data.ashrae.org/standard223#TemperatureSensor')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('TerminalUnit', 'Class', 'Terminal unit', 'A piece of `Equipment` that modulates the volume of air delivered to a space.', 'Equipment', 'http://data.ashrae.org/standard223#TerminalUnit')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ThermalEnergyStorageUnit', 'Class', 'Thermal energy storage unit', 'A device that stores thermal energy.', 'Equipment', 'http://data.ashrae.org/standard223#ThermalEnergyStorageUnit')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ThermodynamicPhase-Gas', 'Class', 'Gas phase', 'This class and its enumerated subclasses represent gas in various thermodynamic states. : ThermodynamicPhase-Gas Enumerations | Enumeration | |:-----------| | `Gas-Superheated` |', 'EnumerationKind-ThermodynamicPhase', 'http://data.ashrae.org/standard223#ThermodynamicPhase-Gas')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ThermodynamicPhase-Liquid', 'Class', 'Liquid phase', 'This class and its enumerated subclasses represent liquid in various thermodynamic states. : ThermodynamicPhase-Liquid Enumerations | Enumeration | |:-----------| | `Liquid-Subcooled` |', 'EnumerationKind-ThermodynamicPhase', 'http://data.ashrae.org/standard223#ThermodynamicPhase-Liquid')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ThermodynamicPhase-Solid', 'Class', 'Solid phase', '`ThermodynamicPhase-Solid`', 'EnumerationKind-ThermodynamicPhase', 'http://data.ashrae.org/standard223#ThermodynamicPhase-Solid')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ThermodynamicPhase-Vapor', 'Class', 'Vapor phase', '`ThermodynamicPhase-Vapor`', 'EnumerationKind-ThermodynamicPhase', 'http://data.ashrae.org/standard223#ThermodynamicPhase-Vapor')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Thermostat', 'Class', 'Thermostat', 'A piece of `Equipment` that maintains temperature at a fixed or adjustable setpoint.', 'Equipment', 'http://data.ashrae.org/standard223#Thermostat')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('ThreeWayValve', 'Class', 'Three-way valve', 'A `Valve` that can divert a fluid in one of three directions.', 'Valve', 'http://data.ashrae.org/standard223#ThreeWayValve')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Turbine', 'Class', 'Turbine', 'A piece of `Equipment` that converts mechanical energy into electric energy.', 'Equipment', 'http://data.ashrae.org/standard223#Turbine')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('TwoWayValve', 'Class', 'Two-way valve', 'A `Valve` that can divert a fluid in one of two directions.', 'Valve', 'http://data.ashrae.org/standard223#TwoWayValve')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('UHF-ISMBand', 'Class', 'ISM band', 'This class and its enumerated subclasses represent communication protocols that use radio frequencies that are reserved internationally for license-free support of Industrial, Scientific, and Medical applications. : UHF-ISMBand Enumerations | Enumeration | |:-----------| | `ISMBand-BluetoothLE` | | `ISMBand-IEEE802.11` | | `ISMBand-IEEE802.15.4` | | `ISMBand-LoRaWAN` | | `ISMBand-NFC` | | `ISMBand-RFID` |', 'Signal-UHF', 'http://data.ashrae.org/standard223#UHF-ISMBand')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('UHF-LicensedBand', 'Class', 'Licensed band', 'This class represents communication protocols that use radio frequencies in licensed bands of the UHF spectrum.', 'Signal-UHF', 'http://data.ashrae.org/standard223#UHF-LicensedBand')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('USBCable', 'Class', 'USB cable', 'A type of `Conductor` that consists of 1 to 5 pairs of twisted wire and is used for `Signal-USB` communication.', 'Conductor', 'http://data.ashrae.org/standard223#USBCable')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('USBOutlet', 'Class', 'USB outlet', 'A piece of `Equipment` that contains one or more receptacles for connecting electrical equipment to a USB communication network, typically via a USB cable.', 'Equipment', 'http://data.ashrae.org/standard223#USBOutlet')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Valve', 'Class', 'Valve', 'A piece of `Equipment` that can be adjusted to allow, regulate, or stop the flow of fluid in a pipe or a duct.', 'Equipment', 'http://data.ashrae.org/standard223#Valve')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('VariableFrequencyDrive', 'Class', 'Variable frequency drive', 'A piece of `Equipment` that varies its output frequency to vary the rotating speed and torque of a motor, given a fixed input frequency. Used with fans or pumps to vary the flow in the system as a function of a maintained pressure.', 'Equipment', 'http://data.ashrae.org/standard223#VariableFrequencyDrive')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-0V', 'Class', '0 V', 'Voltage-0V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-0V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-10000V', 'Class', '10000 V', 'Voltage-10000V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-10000V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-110V', 'Class', '110 V', 'Voltage-110V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-110V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-120V', 'Class', '120 V', 'Voltage-120V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-120V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-127V', 'Class', '127 V', 'Voltage-127V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-127V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-12V', 'Class', '12 V', 'Voltage-12V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-12V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-139V', 'Class', '139 V', 'Voltage-139V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-139V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-1730V', 'Class', '1730 V', 'Voltage-1730V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-1730V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-1900V', 'Class', '1900 V', 'Voltage-1900V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-1900V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-190V', 'Class', '190 V', 'Voltage-190V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-190V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-2.5V', 'Class', '2.5 V', 'Voltage-2.5V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-2.5V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-208V', 'Class', '208 V', 'Voltage-208V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-208V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-219V', 'Class', '219 V', 'Voltage-219V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-219V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-220V', 'Class', '220 V', 'Voltage-220V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-220V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-230V', 'Class', '230 V', 'Voltage-230V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-230V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-2400V', 'Class', '2400 V', 'Voltage-2400V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-2400V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-240V', 'Class', '240 V', 'Voltage-240V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-240V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-24V', 'Class', '24 V', 'Voltage-24V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-24V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-277V', 'Class', '277 V', 'Voltage-277V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-277V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-3000V', 'Class', '3000 V', 'Voltage-3000V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-3000V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-3300V', 'Class', '3300 V', 'Voltage-3300V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-3300V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-3460V', 'Class', '3460 V', 'Voltage-3460V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-3460V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-347V', 'Class', '347 V', 'Voltage-347V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-347V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-380V', 'Class', '380 V', 'Voltage-380V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-380V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-3810V', 'Class', '3810 V', 'Voltage-3810V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-3810V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-3V', 'Class', '3 V', 'Voltage-3V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-3V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-400V', 'Class', '400 V', 'Voltage-400V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-400V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-415V', 'Class', '415 V', 'Voltage-415V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-415V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-4160V', 'Class', '4160 V', 'Voltage-4160V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-4160V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-480V', 'Class', '480 V', 'Voltage-480V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-480V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-48V', 'Class', '48 V', 'Voltage-48V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-48V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-5770V', 'Class', '5770 V', 'Voltage-5770V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-5770V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-5V', 'Class', '5 V', 'Voltage-5V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-5V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-6000V', 'Class', '6000 V', 'Voltage-6000V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-6000V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-600V', 'Class', '600 V', 'Voltage-600V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-600V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-6600V', 'Class', '6600 V', 'Voltage-6600V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-6600V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-6V', 'Class', '6 V', 'Voltage-6V', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-6V')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Voltage-PoE', 'Class', 'PoE voltage', 'This class represents the standardized 44-57VDC range that is produced by PoE Power Sourcing Equipment.', 'Numerical-Voltage', 'http://data.ashrae.org/standard223#Voltage-PoE')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('VoltageSensor', 'Class', 'Voltage sensor', 'A `Sensor` that `observes` a `QuantifiableObservableProperty` that represents a measure of voltage.', 'Sensor', 'http://data.ashrae.org/standard223#VoltageSensor')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Water-ChilledWater', 'Class', 'Chilled water', 'Water-Chilled water', 'Fluid-Water', 'http://data.ashrae.org/standard223#Water-ChilledWater')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Water-GlycolSolution', 'Class', 'Water-Glycol solution', 'This class and its enumerated subclasses represent common concentrations of water-glycol solution. : Water-GlycolSolution Enumerations | Enumeration | |:-----------| | `GlycolSolution-15Percent` | | `GlycolSolution-30Percent` |', 'Fluid-Water', 'http://data.ashrae.org/standard223#Water-GlycolSolution')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Water-HotWater', 'Class', 'Hot water', 'Water-Hot water', 'Fluid-Water', 'http://data.ashrae.org/standard223#Water-HotWater')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Water-Steam', 'Class', 'Steam', 'Water-Steam', 'Fluid-Water', 'http://data.ashrae.org/standard223#Water-Steam')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('WaterOutlet', 'Class', 'Water outlet', 'A piece of `Equipment` that contains one or more pipe fittings for connecting plumbing equipment (e.g., `Faucet`) to a plumbing system.', 'Equipment', 'http://data.ashrae.org/standard223#WaterOutlet')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('WaterToAirHeatPump', 'Class', 'Water-to-air heat pump', 'A `HeatPump` that transfers thermal energy between air and a body of water.', 'HeatPump', 'http://data.ashrae.org/standard223#WaterToAirHeatPump')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('WaterToWaterHeatPump', 'Class', 'Water-to-water heat pump', 'A `HeatPump` that transfers thermal energy between two flows of water.', 'HeatPump', 'http://data.ashrae.org/standard223#WaterToWaterHeatPump')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Waveguide', 'Class', 'Waveguide', 'A type of `Connection` the represents structures, such as fiber optic or coaxial cables, used to convey electromagnetic energy (i.e., `Constituent-EM`) in a specific direction. Without the physical constraint of a waveguide, waves would expand into three-dimensional space and their intensities would decrease according to the inverse square law.', 'Connection', 'http://data.ashrae.org/standard223#Waveguide')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Weekday-Friday', 'Class', 'Friday', 'Weekday-Friday', 'DayOfWeek-Weekday', 'http://data.ashrae.org/standard223#Weekday-Friday')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Weekday-Monday', 'Class', 'Monday', 'Weekday-Monday', 'DayOfWeek-Weekday', 'http://data.ashrae.org/standard223#Weekday-Monday')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Weekday-Thursday', 'Class', 'Thursday', 'Weekday-Thursday', 'DayOfWeek-Weekday', 'http://data.ashrae.org/standard223#Weekday-Thursday')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Weekday-Tuesday', 'Class', 'Tuesday', 'Weekday-Tuesday', 'DayOfWeek-Weekday', 'http://data.ashrae.org/standard223#Weekday-Tuesday')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Weekday-Wednesday', 'Class', 'Wednesday', 'Weekday-Wednesday', 'DayOfWeek-Weekday', 'http://data.ashrae.org/standard223#Weekday-Wednesday')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Weekend-Saturday', 'Class', 'Saturday', 'Weekend-Saturday', 'DayOfWeek-Weekend', 'http://data.ashrae.org/standard223#Weekend-Saturday')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Weekend-Sunday', 'Class', 'Sunday', 'Weekend-Sunday', 'DayOfWeek-Weekend', 'http://data.ashrae.org/standard223#Weekend-Sunday')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Wideband-CATV', 'Class', 'CATV', 'The Community Antenna Television communication protocol that is used to deliver cable TV service over `CoaxialCable` or `FiberOpticCable` communication networks.', 'Signal-Wideband', 'http://data.ashrae.org/standard223#Wideband-CATV')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Wideband-DOCSIS', 'Class', 'DOCSIS', 'The global standard Data Over Cable Service Interface Specification communication protocol that is used to deliver high-speed internet service over `CoaxialCable` communication networks.', 'Signal-Wideband', 'http://data.ashrae.org/standard223#Wideband-DOCSIS')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Window', 'Class', 'Window', 'A piece of `Equipment` that provides a pathway for `EM-Light` or `Fluid-Air` (or both) to flow from a room to another room or the building exterior through a vertical or nearly vertical area of the room envelope.', 'Equipment', 'http://data.ashrae.org/standard223#Window')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('WindowShade', 'Class', 'Window shade', 'A piece of `Equipment` that can be adjusted to allow, regulate, or stop the flow of light through a `Window`.', 'Equipment', 'http://data.ashrae.org/standard223#WindowShade')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('WiredEthernet-1000BASE-T', 'Class', 'Wired Ethernet 1000BASE-T', 'WiredEthernet-1000BASE-T', 'Signal-WiredEthernet', 'http://data.ashrae.org/standard223#WiredEthernet-1000BASE-T')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('WiredEthernet-1000BASE-T1', 'Class', 'Wired Ethernet 1000BASE-T1', 'WiredEthernet-1000BASE-T1', 'Signal-WiredEthernet', 'http://data.ashrae.org/standard223#WiredEthernet-1000BASE-T1')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('WiredEthernet-100BASE-T1', 'Class', 'Wired Ethernet 100BASE-T1', 'WiredEthernet-100BASE-T1', 'Signal-WiredEthernet', 'http://data.ashrae.org/standard223#WiredEthernet-100BASE-T1')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('WiredEthernet-100BASE-TX', 'Class', 'Wired Ethernet 100BASE-TX', 'WiredEthernet-100BASE-TX', 'Signal-WiredEthernet', 'http://data.ashrae.org/standard223#WiredEthernet-100BASE-TX')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('WiredEthernet-10BASE-T', 'Class', 'Wired Ethernet 10BASE-T', 'WiredEthernet-10BASE-T', 'Signal-WiredEthernet', 'http://data.ashrae.org/standard223#WiredEthernet-10BASE-T')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('WiredEthernet-10BASE-T1L', 'Class', 'Wired Ethernet 10BASE-T1L', 'WiredEthernet-10BASE-T1L', 'Signal-WiredEthernet', 'http://data.ashrae.org/standard223#WiredEthernet-10BASE-T1L')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('WiredEthernet-10BASE-T1S', 'Class', 'Wired Ethernet 10BASE-T1S', 'WiredEthernet-10BASE-T1S', 'Signal-WiredEthernet', 'http://data.ashrae.org/standard223#WiredEthernet-10BASE-T1S')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('WiredEthernet-10GBASE-T', 'Class', 'Wired Ethernet 10GBASE-T', 'WiredEthernet-10GBASE-T', 'Signal-WiredEthernet', 'http://data.ashrae.org/standard223#WiredEthernet-10GBASE-T')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('WiredEthernet-10GBASE-T1', 'Class', 'Wired Ethernet 10GBASE-T1', 'WiredEthernet-10GBASE-T1', 'Signal-WiredEthernet', 'http://data.ashrae.org/standard223#WiredEthernet-10GBASE-T1')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('WiredEthernet-2.5GBASE-T', 'Class', 'Wired Ethernet 2.5GBASE-T', 'WiredEthernet-2.5GBASE-T', 'Signal-WiredEthernet', 'http://data.ashrae.org/standard223#WiredEthernet-2.5GBASE-T')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('WiredEthernet-2.5GBASE-T1', 'Class', 'Wired Ethernet 2.5GBASE-T1', 'WiredEthernet-2.5GBASE-T1', 'Signal-WiredEthernet', 'http://data.ashrae.org/standard223#WiredEthernet-2.5GBASE-T1')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('WiredEthernet-25GBASE-T', 'Class', 'Wired Ethernet 25GBASE-T', 'WiredEthernet-25GBASE-T', 'Signal-WiredEthernet', 'http://data.ashrae.org/standard223#WiredEthernet-25GBASE-T')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('WiredEthernet-40GBASE-T', 'Class', 'Wired Ethernet 40GBASE-T', 'WiredEthernet-40GBASE-T', 'Signal-WiredEthernet', 'http://data.ashrae.org/standard223#WiredEthernet-40GBASE-T')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('WiredEthernet-5GBASE-T', 'Class', 'Wired Ethernet 5GBASE-T', 'WiredEthernet-5GBASE-T', 'Signal-WiredEthernet', 'http://data.ashrae.org/standard223#WiredEthernet-5GBASE-T')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('WiredEthernet-5GBASE-T1', 'Class', 'Wired Ethernet 5GBASE-T1', 'WiredEthernet-5GBASE-T1', 'Signal-WiredEthernet', 'http://data.ashrae.org/standard223#WiredEthernet-5GBASE-T1')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('WiredEthernetOutlet', 'Class', 'Wired Ethernet outlet', 'A piece of `Equipment` that contains one or more receptacles for connecting electrical equipment to a wired Ethernet communication network, typically via a wired Ethernet cable.', 'Equipment', 'http://data.ashrae.org/standard223#WiredEthernetOutlet')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
INSERT INTO public.ashrae223_vocabulary VALUES ('Zone', 'Class', 'Zone', 'A logical grouping of one or more `DomainSpace`s or other `Zone`s for some building service or control-related purpose. `Zone`s can have properties that are inputs or outputs to a `Function` (see {s223:Function}), which can be executed by `Controller`s (see {s223:Controller}) or other `Equipment`.', 'Concept', 'http://data.ashrae.org/standard223#Zone')
ON CONFLICT (name) DO UPDATE SET
  concept_kind = EXCLUDED.concept_kind,
  label        = EXCLUDED.label,
  description  = EXCLUDED.description,
  subclass_of  = EXCLUDED.subclass_of,
  semantic_id  = EXCLUDED.semantic_id;
-- <<< END GENERATED ashrae223_vocabulary

-- -------------------------------------------------------------------------------------------
-- IDTA 02006 Digital Nameplate submodel templates  (20 rows)
-- -------------------------------------------------------------------------------------------
-- Folded from 0011_device_nameplate.sql. The table and the per-device nameplate columns are in
-- 0001; these are the template rows the Devices page reads to build a nameplate form.

-- ---------------------------------------------------------------------------------------------
-- Seed: IDTA 02006 Digital Nameplate v3.0, top-level elements
-- ---------------------------------------------------------------------------------------------
-- DO UPDATE on the descriptive columns so a corrected transcription reaches an existing
-- database; the key (template_id, id_short) is never updated. Only the top-level elements are
-- seeded: the SubmodelElementCollections' children are out of scope until something needs them.

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

-- -------------------------------------------------------------------------------------------
-- Metric catalogue -- the standards seed  (32 rows)
-- -------------------------------------------------------------------------------------------
-- The OPC UA companion specifications and one BMS point. ON CONFLICT (name) DO NOTHING: a
-- catalogue entry an operator has edited is not re-seeded over.

-- ---------------------------------------------------------------------------------------------
-- 1. MTConnect 2.x -- machine tool axes, controller and systems
-- ---------------------------------------------------------------------------------------------
-- Joined on kind = 'DATA_ITEM_TYPE': the vocabulary also holds COMPONENT, SUB_TYPE, UNIT and
-- NATIVE_UNIT rows under the same `name` values.
INSERT INTO public.metric_catalog (name, datatype, description, category, units, standard,
                                   semantic_id, semantic_id_type)
SELECT s.name, s.datatype, s.description, v.category, s.units, 'MTConnect', v.semantic_id, 'IRI'
  FROM (VALUES
    ('Axes/X/POSITION',          10, 'Linear position of the X axis',              'POSITION',        'MILLIMETER'),
    ('Axes/Y/POSITION',          10, 'Linear position of the Y axis',              'POSITION',        'MILLIMETER'),
    ('Axes/Z/POSITION',          10, 'Linear position of the Z axis',              'POSITION',        'MILLIMETER'),
    ('Axes/S/ROTARY_VELOCITY',   10, 'Spindle rotational velocity',                'ROTARY_VELOCITY', 'REVOLUTION/MINUTE'),
    ('Axes/S/LOAD',              10, 'Spindle load as a percentage of rated load',  'LOAD',            'PERCENT'),
    ('Controller/PATH_FEEDRATE', 10, 'Commanded feedrate along the tool path',      'PATH_FEEDRATE',   'MILLIMETER/SECOND'),
    ('Controller/CONTROLLER_MODE', 12, 'Controller operating mode',                 'CONTROLLER_MODE', NULL),
    ('Controller/PROGRAM',       12, 'Name of the executing part program',          'PROGRAM',         NULL),
    ('Controller/PART_COUNT',    10, 'Parts completed by this controller',          'PART_COUNT',      'COUNT'),
    ('Systems/AVAILABILITY',     12, 'Whether the device is available to report',   'AVAILABILITY',    NULL)
  ) AS s(name, datatype, description, concept, units)
  JOIN public.mtconnect_vocabulary v
    ON v.name = s.concept AND v.kind = 'DATA_ITEM_TYPE'
ON CONFLICT (name) DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- 2. OPC 40010 Robotics -- the robotic assembly cell
-- ---------------------------------------------------------------------------------------------
-- `companion_spec` is part of the join because `opcua_vocabulary` is keyed (companion_spec,
-- name): `Mass` and `Temperature` appear under more than one specification.
INSERT INTO public.metric_catalog (name, datatype, description, category, units, standard,
                                   semantic_id, semantic_id_type)
SELECT s.name, s.datatype, s.description, s.category, s.units, 'OPC UA', v.semantic_id, 'IRI'
  FROM (VALUES
    ('MotionDevice/ActualPosition',  10, 'Current tool-centre-point position',        'SAMPLE', 'MILLIMETER'),
    ('MotionDevice/ActualSpeed',     10, 'Current tool-centre-point speed',           'SAMPLE', 'MILLIMETER/SECOND'),
    ('MotionDevice/EmergencyStop',   11, 'Emergency stop circuit engaged',            'EVENT',  NULL),
    ('MotionDevice/ProtectiveStop',  11, 'Protective stop engaged',                   'EVENT',  NULL),
    ('MotionDevice/OnPath',          11, 'Whether the device is on its planned path', 'EVENT',  NULL),
    ('MotionDevice/TaskProgramName', 12, 'Name of the executing task program',        'EVENT',  NULL),
    ('Machine/OperationalMode',      12, 'Operational mode of the motion device',     'EVENT',  NULL),
    ('Machine/SpeedOverride',        10, 'Operator speed override',                   'SAMPLE', 'PERCENT')
  ) AS s(name, datatype, description, category, units)
  JOIN public.opcua_vocabulary v
    ON v.companion_spec = 'OPC 40010 Robotics'
   AND v.name = regexp_replace(s.name, '^[^/]+/', '')
ON CONFLICT (name) DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- 3. OPC 40001-4 Machinery Energy -- per-cell energy telemetry
-- ---------------------------------------------------------------------------------------------
INSERT INTO public.metric_catalog (name, datatype, description, category, units, standard,
                                   semantic_id, semantic_id_type)
SELECT s.name, s.datatype, s.description, s.category, s.units, 'OPC UA', v.semantic_id, 'IRI'
  FROM (VALUES
    ('Energy/Pressure',       10, 'Compressed-air supply pressure', 'SAMPLE', 'PASCAL'),
    ('Energy/Temperature',    10, 'Coolant or medium temperature',  'SAMPLE', 'CELSIUS'),
    ('Energy/VolumeFlowRate', 10, 'Medium volumetric flow rate',    'SAMPLE', 'LITER/SECOND'),
    ('Energy/Volume',         10, 'Cumulative medium volume',       'SAMPLE', 'LITER')
  ) AS s(name, datatype, description, category, units)
  JOIN public.opcua_vocabulary v
    ON v.companion_spec = 'OPC 40001-4 Machinery Energy'
   AND v.name = regexp_replace(s.name, '^[^/]+/', '')
ON CONFLICT (name) DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- 4. ASHRAE 223P -- facility / BMS ambient telemetry
-- ---------------------------------------------------------------------------------------------
-- The semantic id names a sensor class, not a quantity: 223P models a measurement as a Property
-- attached to a Sensor, and this catalog has one flat name per series. `Constituent-CO2` carries
-- a hyphen, which a metric name forbids; it is transliterated to `BMS/CO2_CONCENTRATION`.
INSERT INTO public.metric_catalog (name, datatype, description, category, units, standard,
                                   semantic_id, semantic_id_type)
SELECT s.name, s.datatype, s.description, s.category, s.units, 'ASHRAE 223P', v.semantic_id, 'IRI'
  FROM (VALUES
    ('BMS/ZONE_TEMPERATURE',  10, 'Zone air temperature',        'SAMPLE', 'CELSIUS',        'TemperatureSensor'),
    ('BMS/ZONE_HUMIDITY',     10, 'Zone relative humidity',      'SAMPLE', 'PERCENT',        'HumiditySensor'),
    ('BMS/CO2_CONCENTRATION', 10, 'Zone CO2 concentration',      'SAMPLE', 'PARTS/MILLION',  'Constituent-CO2'),
    ('BMS/STATIC_PRESSURE',   10, 'Duct static pressure',        'SAMPLE', 'PASCAL',         'PressureSensor')
  ) AS s(name, datatype, description, category, units, concept)
  JOIN public.ashrae223_vocabulary v ON v.name = s.concept
ON CONFLICT (name) DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- 5. ISO 22400 -- computed KPIs
-- ---------------------------------------------------------------------------------------------
-- Registered, not computed: nothing here derives them (docs/vocabularies.md). An edge device
-- that has the inputs can publish them as ordinary Sparkplug metrics. The four OEE names above
-- are not repeated.
INSERT INTO public.metric_catalog (name, datatype, description, category, units, standard,
                                   semantic_id, semantic_id_type)
SELECT s.name, s.datatype, v.description, 'SAMPLE', v.unit, 'ISO 22400', v.semantic_id, 'IRI'
  FROM (VALUES
    ('OEE/OEE',         10, 'OEE'),
    ('OEE/UTILIZATION', 10, 'UTILIZATION'),
    ('OEE/SCRAP_RATIO', 10, 'SCRAP_RATIO'),
    ('OEE/MTBF',        10, 'MTBF'),
    ('OEE/MTTR',        10, 'MTTR')
  ) AS s(name, datatype, concept)
  JOIN public.iso22400_vocabulary v ON v.name = s.concept
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.metric_catalog (name, datatype, description, category, units, standard,
                                   semantic_id, semantic_id_type)
SELECT s.name, s.datatype, s.description, s.category, s.units, 'ASHRAE 223P', v.semantic_id, 'IRI'
  FROM (VALUES
    ('BMS/SUPPLY_AIR_FLOW', 10, 'Supply air volumetric flow rate', 'SAMPLE', 'LITER/SECOND',
     'FlowSensor')
  ) AS s(name, datatype, description, category, units, concept)
  JOIN public.ashrae223_vocabulary v ON v.name = s.concept
ON CONFLICT (name) DO NOTHING;

-- -------------------------------------------------------------------------------------------
-- Declared settings  (6 rows)
-- -------------------------------------------------------------------------------------------
-- Through seed_setting(), not as INSERTs: the function refreshes label, description and bounds
-- on every replay while leaving the value alone, so an operator's change survives a restart.

-- ---------------------------------------------------------------------------------------------
-- 4. The settings this migration declares
-- ---------------------------------------------------------------------------------------------
-- Few, and every one has a reader; a setting nothing reads is a control that does nothing.
SELECT public.seed_setting(
    'ui.digital_thread_lane_limit',
    to_jsonb(30),
    'number',
    'Digital Thread',
    'Lanes drawn before folding',
    'How many asset lanes the Digital Thread draws before the remainder go behind "Show all '
    'lanes". Raise it on a large estate; lower it if the initial render feels slow.',
    'DEFAULT_LANE_LIMIT in DigitalThreadTab.jsx'
);

SELECT public.seed_setting(
    'ui.digital_thread_poll_seconds',
    to_jsonb(60),
    'number',
    'Digital Thread',
    'Refresh interval (seconds)',
    'How often the Digital Thread re-reads the audit log. The page is an audit trail rather than '
    'a live feed, so this is deliberately not a live-tail interval.',
    'the 60_000 ms interval in DigitalThreadTab.jsx'
);

-- ---------------------------------------------------------------------------------------------
-- 2. The setting
-- ---------------------------------------------------------------------------------------------
SELECT public.seed_setting(
    'alerts.retention_days',
    to_jsonb(7),
    'number',
    'Retention',
    'Alert history kept for (days)',
    'How long a resolved or superseded alert occurrence is kept before the nightly prune removes '
    'it. The telemetry that triggered the alert is retained separately under the historian''s own '
    'policy, so shortening this destroys no measurement -- only the record that a threshold was '
    'crossed. A currently firing alert is never removed however old it is.',
    'the p_retain default in prune_platform_alerts()'
);

-- ---------------------------------------------------------------------------------------------
-- 3. The settings, each with a reader
-- ---------------------------------------------------------------------------------------------
-- Disabled by default: turning this on changes what happens to plant history when it ages out
-- (exported, verified and then dropped, instead of dropped by a retention policy).
SELECT public.seed_setting(
    'archive.enabled',
    to_jsonb(false),
    'boolean',
    'Cold Storage',
    'Archive telemetry before dropping it',
    'When on, telemetry chunks past the threshold below are exported to Parquet on object storage '
    'and verified before the raw rows are dropped. When off, TimescaleDB''s retention policy drops '
    'them outright and they are not recoverable.',
    'off — retention.sql drops chunks with no archive'
);

-- BOUNDED AT THE BOTTOM BY THE ROLLUPS' OWN HORIZON, not by taste. Exporting a chunk younger than
-- the compression window means writing rows that are still being compressed, and a threshold of
-- days rather than months makes the object count grow without making anything more recoverable.
SELECT public.seed_setting(
    'archive.tier_after_days',
    to_jsonb(90),
    'number',
    'Cold Storage',
    'Archive chunks older than (days)',
    'How old a telemetry chunk must be before it is exported. Measured against the END of the '
    'chunk''s range, so a chunk still accepting late-arriving readings is never exported. Should '
    'match the raw retention window: archiving later than retention drops means losing data.',
    'TIMESCALE_RETAIN_FOR in .env (90 days)'
);

SELECT public.seed_setting(
    'archive.bucket',
    to_jsonb('telemetry-archive'::text),
    'string',
    'Cold Storage',
    'Object storage bucket',
    'The private bucket cold telemetry is written to. Created by scripts/storage-init.mjs; its '
    'RLS policies admit the ingestion principal and no browser role.',
    'telemetry-archive'
);

-- -------------------------------------------------------------------------------------------
-- Value domains, and the bounds on the two settings that have them
-- -------------------------------------------------------------------------------------------
-- UPDATEs against rows seeded above: seed_setting() takes no bounds, so adding a bound to one
-- setting does not change the signature every caller uses. Each is guarded on the value it
-- sets, so a replay that finds it applied writes no audit entry.

-- ---------------------------------------------------------------------------------------------
-- Backfill: the two value sets this deployment already documents in prose
-- ---------------------------------------------------------------------------------------------
-- Scoped by `standard` as well as by name so a locally minted metric sharing the name is not
-- given MTConnect's vocabulary.

UPDATE public.metric_catalog
   SET permitted_values = ARRAY['READY', 'ACTIVE', 'INTERRUPTED', 'FEED_HOLD', 'STOPPED']
 WHERE name = 'Controller/EXECUTION'
   AND standard = 'MTConnect';

UPDATE public.metric_catalog
   SET permitted_values = ARRAY['ARMED', 'TRIGGERED']
 WHERE name = 'Controller/EMERGENCY_STOP'
   AND standard = 'MTConnect';

-- MIN 1, NOT 0. Zero would mean "delete every alert on the next run", which is a thing an operator
-- might type meaning "keep none going forward" and would not expect to apply retroactively.
-- Ten years is not a real ceiling, it is a typo guard: 36500 entered instead of 3650 is the
-- difference between a decade and a century, and neither is a number anyone reasons about.
UPDATE public.system_settings
   SET min_value = 1, max_value = 3650
 WHERE key = 'alerts.retention_days'
   AND (min_value IS DISTINCT FROM 1 OR max_value IS DISTINCT FROM 3650);

-- Bounds set by UPDATE, not by extra arguments: adding parameters to seed_setting() creates an
-- overload. MIN 1, not 0: zero would export every chunk the moment it closes. The ceiling is a
-- typo guard (3650 entered as 36500).
UPDATE public.system_settings
   SET min_value = 1, max_value = 3650
 WHERE key = 'archive.tier_after_days'
   AND (min_value IS DISTINCT FROM 1 OR max_value IS DISTINCT FROM 3650);

-- -------------------------------------------------------------------------------------------
-- The three machine principals  (3 auth users)
-- -------------------------------------------------------------------------------------------
-- Each is an auth user that cannot sign in: no email, no password, no identity provider. Seeded
-- by migration rather than by seed.sql because the RLS job applies migrations and never runs the
-- seed. Their grants are on `principal_permissions` (0080), not `user_roles`, whose trigger
-- refuses a machine principal.

-- =============================================================================================
-- The MCP reader
-- =============================================================================================
-- `i3x-mcp` takes a static `I3X_TOKEN` from its host's config file, and a GoTrue token expires
-- within the hour. This creates the identity; `scripts/mint-mcp-token.mjs` signs a long-lived
-- JWT for it with the stack's HS256 secret, so PostgREST validates it as it validates a GoTrue
-- token. Not `service_role`: the i3X server passes the caller's bearer through so that it
-- queries as them. Not a demo persona: a machine credential borrowing a human account conflates
-- two lifecycles. Its grant is `telemetry:read`, never `digital_thread:read`: the MCP client has
-- no surface for the audit trail.
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- 1. The principal
-- ---------------------------------------------------------------------------------------------
-- `id` is the only column on this image's `auth.users` without a default. The row is minimal:
-- this account cannot sign in. It exists so a JWT subject resolves to something real and
-- `digital_thread.changed_by` has a foreign key to satisfy.
INSERT INTO auth.users (id)
VALUES ('b0000000-0000-4000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;

-- No role is assigned here: 0080 grants `telemetry:read` on `principal_permissions`, and its
-- BEFORE INSERT trigger on `user_roles` refuses any machine principal.

-- ---------------------------------------------------------------------------------------------
-- 1. The principal
-- ---------------------------------------------------------------------------------------------
-- `...0002`, continuing the MCP reader's block. Minimal by construction: this account cannot
-- sign in, so it appears in the Service Identities list on the Access Control page.
INSERT INTO auth.users (id)
VALUES ('b0000000-0000-4000-8000-000000000002')
ON CONFLICT (id) DO NOTHING;

-- No role is assigned here (see the MCP reader above). The daemon's authority was never the
-- role: every write goes through an `ingest_*` gate that is SECURITY DEFINER and checks
-- `is_ingestion_caller()`, which names this uuid and nothing else.

-- ---------------------------------------------------------------------------------------------
-- 1. The principal
-- ---------------------------------------------------------------------------------------------
-- Minimal by construction: this account cannot sign in. Seeded here rather than through
-- `create_service_principal()` because a fixed part of the deployment belongs in a migration.
INSERT INTO auth.users (id)
VALUES ('b0000000-0000-4000-8000-000000000003')
ON CONFLICT (id) DO NOTHING;

-- No role is assigned here (see the MCP reader above). `digital_thread:read` is deliberately
-- not among this principal's grants: the worker holds broker publish rights and neither writes
-- nor reads the audit trail.

-- -------------------------------------------------------------------------------------------
-- The playback gateway, and the two singleton rows that track workers
-- -------------------------------------------------------------------------------------------
-- The gateway is an edge node nothing else publishes as: two publishers under one Sparkplug
-- identity interleave their seq counters and the daemon reads that as message loss. Its flags
-- are reconciled on every replay, because the playback gate tests them; its name is not.

-- ---------------------------------------------------------------------------------------------
-- 2. The gateway
-- ---------------------------------------------------------------------------------------------
-- A pinned UUID, because `sparkplug_id` is generated from the primary key and the broker
-- account name must be predictable (`gwy160000000000400080000`). is_virtual, is_simulated and
-- is_shadow are all stated: gateways_shadow_is_simulated requires the middle one. No cell and
-- no site-wide assertion: it is not anywhere.
INSERT INTO public.gateways (id, name, description, is_virtual, is_simulated, is_shadow, location_scope)
VALUES (
    '16000000-0000-4000-8000-000000000001',
    'Playback',
    'Publishes recorded captures. Nothing else publishes as this edge node, which is the point: '
    'two publishers sharing one Sparkplug identity interleave their seq counters and the daemon '
    'reads that as permanent message loss.',
    true, true, true, 'cell'
)
ON CONFLICT (id) DO UPDATE
    -- RECONCILED, NOT LEFT AS FOUND. The flags are what the gate below tests, so a row that lost
    -- one -- an edit, a partial restore -- would silently make every playback impossible with an
    -- error naming the gateway rather than the flag. The NAME is deliberately not reconciled:
    -- renaming a gateway is an operator's to do, and 0059's lane does not read the name.
    SET is_virtual = true, is_simulated = true, is_shadow = true, cell_id = NULL;

INSERT INTO public.playback_worker_status (id, held_edge_nodes, reported_at)
VALUES (true, '{}', 'epoch')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.directory_liveness_probe (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- -------------------------------------------------------------------------------------------
-- Scheduled maintenance  (3 jobs)
-- -------------------------------------------------------------------------------------------
-- Unscheduled before scheduled: `cron.schedule` appends rather than reconciling.

-- ---------------------------------------------------------------------------------------------
-- 2. The schedule
-- ---------------------------------------------------------------------------------------------
-- Daily, and separate from the archive-retention job: that honours a per-row date the user
-- chose, this is a fixed platform policy. 03:15, between `prune_cron_history` (03:00) and
-- `purge_expired_archives` (03:30): `platform_alerts` is REPLICA IDENTITY FULL and published,
-- so every deleted row reaches every dashboard as a delete event. No VACUUM afterwards;
-- `public.storage_footprint` is where to look if the table holds size after a prune.
SELECT public.ensure_cron_job(
  'prune_platform_alerts',
  '15 3 * * *',
  $job$SELECT public.prune_platform_alerts()$job$
);

-- ---------------------------------------------------------------------------------------------
-- 5. The schedule
-- ---------------------------------------------------------------------------------------------
-- UNSCHEDULED BEFORE SCHEDULED. `cron.schedule` APPENDS, so replaying this file on every boot
-- would otherwise accumulate a duplicate job per boot -- which 0032 records having found.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-directory-liveness') THEN
        PERFORM cron.unschedule('refresh-directory-liveness');
    END IF;

    PERFORM cron.schedule(
        'refresh-directory-liveness',
        '* * * * *',
        'SELECT public.refresh_directory_liveness()'
    );
END $$;

SELECT cron.schedule('sweep-gateway-credential-revocations', '*/15 * * * *',
                     'SELECT public.sweep_gateway_credential_revocations()');

-- -------------------------------------------------------------------------------------------
-- Secrets, and the clients that authenticate with them
-- -------------------------------------------------------------------------------------------
-- Every value here is interpolated from psql variables at apply time, which is why these blocks
-- are carried verbatim rather than generated from a dump: a dump holds one stack's secrets.
-- Each is defaulted at its point of use; an absent secret is a skipped registration.

-- =============================================================================================
-- Node-RED authentication
--
-- Closes the Node-RED admin API and webhook receiver on port 1880. The application half lives
-- in node-red/Dockerfile, scripts/node-red-init.mjs and supabase/functions/nodered-userinfo.
-- This provides the two things only the database can: the OAuth client Node-RED authenticates
-- humans with (auth.oauth_clients), and the signing key for the quarantine webhook's token in
-- Vault, plus a dispatch function that mints a short-lived token per event.
--
-- PSQL VARIABLES: `-v nodered_oauth_client_secret`, `-v nodered_webhook_jwt_secret`,
-- `-v nodered_redirect_uri`. An absent secret leaves the corresponding path shut.
-- See tutorial/README.md -> "Node-RED authentication".
-- =============================================================================================

\if :{?nodered_oauth_client_secret} \else \set nodered_oauth_client_secret '' \endif
\if :{?nodered_webhook_jwt_secret}  \else \set nodered_webhook_jwt_secret  '' \endif
\if :{?nodered_redirect_uri}        \else \set nodered_redirect_uri        '' \endif

-- psql does NOT substitute :variables inside dollar-quoted strings, so neither secret can be
-- referenced directly from the DO blocks below -- it would be read as literal text. Stash them
-- in session GUCs out here, where substitution does happen, and read them back inside. Same
-- arrangement 0002_seed_data.sql uses for the Vault token and the Grafana secret.
SELECT set_config('acs_cymru.nodered_oauth_client_secret', :'nodered_oauth_client_secret', false);
SELECT set_config('acs_cymru.nodered_webhook_jwt_secret',  :'nodered_webhook_jwt_secret',  false);
SELECT set_config('acs_cymru.nodered_redirect_uri',        :'nodered_redirect_uri',        false);

-- ---------------------------------------------------------------------------------------------
-- 1. Node-RED OAuth client registration
-- ---------------------------------------------------------------------------------------------
-- `client_secret_hash` is base64url(sha256(secret)) unpadded, not bcrypt.
-- token_endpoint_auth_method is 'client_secret_post' (passport-oauth2's default), unlike the
-- Grafana client's 'client_secret_basic'; GoTrue enforces whichever is registered, exactly.
-- Change this and settings.js has to change with it.
DO $$
DECLARE
  -- Pinned, not generated. settings.js carries this as NODERED_OAUTH_CLIENT_ID (defaulted in
  -- docker-compose.yml), and a fresh UUID on every stack rebuild would silently break the
  -- integration. Same reasoning as the Grafana client id and the pinned virtual gateway.
  -- Deliberately the next value after Grafana's ...0001.
  v_client_id CONSTANT UUID := 'c0ffee00-0000-4000-8000-000000000002';
  v_secret    TEXT := current_setting('acs_cymru.nodered_oauth_client_secret', true);
  -- Derived from NODERED_PUBLIC_URL by docker-compose, so this row and the callbackURL settings.js
  -- hands passport-oauth2 come from one value; they must agree exactly or /oauth/authorize
  -- answers "invalid redirect_uri". /auth/strategy/callback is Node-RED's own fixed route.
  v_redirect  TEXT := COALESCE(
                        NULLIF(current_setting('acs_cymru.nodered_redirect_uri', true), ''),
                        'http://localhost:1880/auth/strategy/callback');
  v_hash      TEXT;
BEGIN
  IF v_secret IS NULL OR v_secret = '' THEN
    RAISE WARNING 'nodered oauth client secret not supplied; skipping client registration. '
                  'Set NODERED_OAUTH_CLIENT_SECRET in .env and re-run. Node-RED will refuse to '
                  'start rather than come up unauthenticated.';
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
    v_redirect,
    'authorization_code,refresh_token',
    'ACS-Cymru Node-RED',
    'http://localhost:1880',
    'confidential',
    'client_secret_post'
  )
  -- DO UPDATE, not DO NOTHING: supabase-db-init replays every migration on every stack start,
  -- so a rotated NODERED_OAUTH_CLIENT_SECRET in .env has to take effect on the next boot.
  ON CONFLICT (id) DO UPDATE SET
    client_secret_hash         = EXCLUDED.client_secret_hash,
    redirect_uris              = EXCLUDED.redirect_uris,
    grant_types                = EXCLUDED.grant_types,
    client_name                = EXCLUDED.client_name,
    client_uri                 = EXCLUDED.client_uri,
    token_endpoint_auth_method = EXCLUDED.token_endpoint_auth_method,
    deleted_at                 = NULL,
    updated_at                 = NOW();
END $$;

SELECT set_config('acs_cymru.nodered_oauth_client_secret', '', false);

-- ---------------------------------------------------------------------------------------------
-- 2. Vault: the quarantine webhook SIGNING KEY
-- ---------------------------------------------------------------------------------------------
-- A signing key, not a bearer credential: a flow author can read msg.req.headers, so sharing
-- the admin token with the webhook would hand every flow the admin API. HS256 because pgjwt
-- implements only the HS family. See tutorial/README.md -> "Node-RED authentication".
DO $$
DECLARE
  v_secret TEXT := current_setting('acs_cymru.nodered_webhook_jwt_secret', true);
  v_id     UUID;
BEGIN
  IF v_secret IS NULL OR v_secret = '' THEN
    -- Unlike the pre-authentication default, an absent key here is NOT normal and does not fail
    -- open: dispatch below sends no Authorization header, and Node-RED's httpNodeAuth answers
    -- 401. The webhook stops working, visibly, rather than the endpoint staying open.
    RAISE WARNING 'vault: nodered_webhook_jwt_secret not supplied; the quarantine webhook will '
                  'be rejected by Node-RED (401). Set NODERED_WEBHOOK_JWT_SECRET in .env.';
    RETURN;
  END IF;

  SELECT id INTO v_id FROM vault.secrets WHERE name = 'nodered_webhook_jwt_secret';

  IF v_id IS NULL THEN
    PERFORM vault.create_secret(
      v_secret,
      'nodered_webhook_jwt_secret',
      'HS256 signing key for the Node-RED quarantine webhook. Read by '
      'public.dispatch_device_quarantine_webhook(), which mints a fresh 60-second token per '
      'event. NOT a bearer credential and NOT the Node-RED admin token -- see archived migration 0006.'
    );
  ELSE
    -- update_secret rather than create: create_secret would fail the UNIQUE on name on the second
    -- replay. Wrapped, because update_secret decrypts the existing row first and that read fails
    -- when the pgsodium root key no longer matches the stored ciphertext (docs/incidents.md -> "The
    -- pgsodium root key lived in the container, not the volume"). Recreating is safe for this
    -- secret because the plaintext comes from .env on every boot; the vault row is a cache.
    BEGIN
      PERFORM vault.update_secret(v_id, v_secret);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'vault: nodered_webhook_jwt_secret could not be updated in place (%). '
                    'Recreating it from the environment -- this is expected if the pgsodium root '
                    'key was regenerated.', SQLERRM;
      DELETE FROM vault.secrets WHERE id = v_id;
      PERFORM vault.create_secret(
        v_secret,
        'nodered_webhook_jwt_secret',
        'HS256 signing key for the Node-RED quarantine webhook. Read by '
        'public.dispatch_device_quarantine_webhook(), which mints a fresh 60-second token per '
        'event. NOT a bearer credential and NOT the Node-RED admin token -- see archived migration 0006.'
      );
    END;
  END IF;
END $$;

SELECT set_config('acs_cymru.nodered_webhook_jwt_secret', '', false);

-- ---------------------------------------------------------------------------------------------
-- 3. Repoint the webhook endpoint at the new secret
-- ---------------------------------------------------------------------------------------------
-- An explicit UPDATE, because the seeded row is `ON CONFLICT DO NOTHING` and an edit there
-- would never reach an existing database. Guarded on the old value so an operator who has
-- deliberately repointed this row is not overwritten.
UPDATE public.webhook_endpoints
   SET secret_name = 'nodered_webhook_jwt_secret'
 WHERE event_key = 'device.quarantined'
   AND secret_name = 'nodered_admin_token';

\if :{?supabase_functions_url}
\else
\set supabase_functions_url 'http://supabase-kong:8000/functions/v1'
\endif
\if :{?supabase_anon_key}
\else
\set supabase_anon_key ''
\endif
\if :{?gateway_revoke_secret}
\else
\set gateway_revoke_secret ''
\endif

SELECT set_config('acs_cymru.fn_url',      :'supabase_functions_url', false);
SELECT set_config('acs_cymru.anon_key',    :'supabase_anon_key', false);
SELECT set_config('acs_cymru.revoke_key',  :'gateway_revoke_secret', false);

-- ---------------------------------------------------------------------------------------------
-- 1. Where the address and the credentials live
-- ---------------------------------------------------------------------------------------------
-- Three values in Vault, this database's store for things that must be read from SQL and must
-- not be readable by `anon` or `authenticated`:
--
--   supabase_functions_url        where the gateway serves /functions/v1 on this target
--   supabase_anon_key             gets past the gateway's key filter and proves nothing else.
--                                 The name is the role, not the format: it holds whichever key
--                                 format the deployment registered (db-init passes the
--                                 publishable key where one exists), and is not renamed because
--                                 nothing in SQL parses it.
--   gateway_revoke_secret         what actually authorises the revocation, checked by the function
DO $vault$
DECLARE
  v_url    text := btrim(coalesce(current_setting('acs_cymru.fn_url', true), ''));
  v_anon   text := btrim(coalesce(current_setting('acs_cymru.anon_key', true), ''));
  v_secret text := btrim(coalesce(current_setting('acs_cymru.revoke_key', true), ''));
  v_id     uuid;
BEGIN
  IF v_secret = '' OR v_anon = '' THEN
    RAISE NOTICE
      '0038: GATEWAY_REVOKE_SECRET or SUPABASE_ANON_KEY is unset; credential revocation is INERT '
      'on this stack. Archiving will not revoke, and the sweep will do nothing.';
  END IF;

  -- REPLACED, NOT MERGED. A rotated value must overwrite the stored one and vault.create_secret
  -- refuses a duplicate name, so the old row goes first. Same shape 0006 uses.
  FOR v_id IN SELECT id FROM vault.secrets
               WHERE name IN ('supabase_functions_url', 'supabase_anon_key', 'gateway_revoke_secret')
  LOOP
    DELETE FROM vault.secrets WHERE id = v_id;
  END LOOP;

  PERFORM vault.create_secret(v_url, 'supabase_functions_url',
    'Base URL of the edge function router on this target, read by revoke_gateway_credential().');
  PERFORM vault.create_secret(v_anon, 'supabase_anon_key',
    'Anon key, used only to pass Kong key-auth on the revocation call. Not authorisation.');
  PERFORM vault.create_secret(v_secret, 'gateway_revoke_secret',
    'Shared secret the revoke-gateway-credential function verifies. This is the authorisation.');
END;
$vault$;

NOTIFY pgrst, 'reload schema';
