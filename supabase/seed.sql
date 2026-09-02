-- =============================================================================
-- ACS-Cymru Asset Tracking Local Development Seed Data
-- =============================================================================
-- WARNING: THIS FILE CONTAINS LOCAL DEVELOPMENT SEED DATA ONLY.
-- DO NOT RUN OR EXECUTE THIS FILE AGAINST A PRODUCTION DATABASE OR CLOUD ENVIRONMENT.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- Seed auth.users with the 4 standard demo personas
-- Note: For GoTrue v2.x, we need to set:
-- - EVERY varchar token column to an empty string (not NULL). GoTrue maps these to Go
--   `string` fields, so a NULL aborts the row scan with
--   `converting NULL to string is unsupported` and the login returns a 500.
--   auth.users.email_change in particular is nullable with NO default, so omitting
--   it from this INSERT is enough to break authentication entirely.
-- - email_confirmed_at to NOW() to mark users as confirmed
-- - encrypted_password is stored as bcrypt hash
-- - raw_app_meta_data must include the 'role' key with the user's role name
-- - is_sso_user must be false (default)
-- - aud must be 'authenticated' and must match GOTRUE_JWT_AUD in docker-compose.yml,
--   otherwise GoTrue looks users up under a different audience and finds nothing.
INSERT INTO auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  recovery_sent_at,
  last_sign_in_at,
  confirmation_token,
  recovery_token,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  is_sso_user,
  phone_confirmed_at,
  email_change,
  email_change_token_new,
  email_change_token_current,
  phone_change,
  phone_change_token,
  reauthentication_token
) VALUES
(
  '00000000-0000-0000-0000-000000000000',
  'a0000000-0000-0000-0000-000000000001',
  'authenticated',
  'authenticated',
  'admin@acs-cymru.local',
  extensions.crypt('acscymru123', extensions.gen_salt('bf')),
  NOW(),
  NOW(),
  NOW(),
  '',  -- confirmation_token: empty string instead of NULL
  '',  -- recovery_token: empty string instead of NULL
  '{"provider":"email","providers":["email"],"role":"Administrator"}'::jsonb,
  '{}'::jsonb,
  NOW(),
  NOW(),
  false,
  NOW(),
  '',  -- email_change: nullable with no default; NULL here breaks GoTrue row scans
  '',  -- email_change_token_new
  '',  -- email_change_token_current
  '',  -- phone_change
  '',  -- phone_change_token
  ''   -- reauthentication_token
),
(
  '00000000-0000-0000-0000-000000000000',
  'a0000000-0000-0000-0000-000000000002',
  'authenticated',
  'authenticated',
  'manager@acs-cymru.local',
  extensions.crypt('acscymru123', extensions.gen_salt('bf')),
  NOW(),
  NOW(),
  NOW(),
  '',  -- confirmation_token: empty string instead of NULL
  '',  -- recovery_token: empty string instead of NULL
  '{"provider":"email","providers":["email"],"role":"Shopfloor_Manager"}'::jsonb,
  '{}'::jsonb,
  NOW(),
  NOW(),
  false,
  NOW(),
  '',  -- email_change
  '',  -- email_change_token_new
  '',  -- email_change_token_current
  '',  -- phone_change
  '',  -- phone_change_token
  ''   -- reauthentication_token
),
(
  '00000000-0000-0000-0000-000000000000',
  'a0000000-0000-0000-0000-000000000003',
  'authenticated',
  'authenticated',
  'operator@acs-cymru.local',
  extensions.crypt('acscymru123', extensions.gen_salt('bf')),
  NOW(),
  NOW(),
  NOW(),
  '',  -- confirmation_token: empty string instead of NULL
  '',  -- recovery_token: empty string instead of NULL
  '{"provider":"email","providers":["email"],"role":"Operator"}'::jsonb,
  '{}'::jsonb,
  NOW(),
  NOW(),
  false,
  NOW(),
  '',  -- email_change
  '',  -- email_change_token_new
  '',  -- email_change_token_current
  '',  -- phone_change
  '',  -- phone_change_token
  ''   -- reauthentication_token
),
(
  '00000000-0000-0000-0000-000000000000',
  'a0000000-0000-0000-0000-000000000004',
  'authenticated',
  'authenticated',
  'auditor@acs-cymru.local',
  extensions.crypt('acscymru123', extensions.gen_salt('bf')),
  NOW(),
  NOW(),
  NOW(),
  '',  -- confirmation_token: empty string instead of NULL
  '',  -- recovery_token: empty string instead of NULL
  '{"provider":"email","providers":["email"],"role":"Auditor"}'::jsonb,
  '{}'::jsonb,
  NOW(),
  NOW(),
  false,
  NOW(),
  '',  -- email_change
  '',  -- email_change_token_new
  '',  -- email_change_token_current
  '',  -- phone_change
  '',  -- phone_change_token
  ''   -- reauthentication_token
)
-- DO UPDATE, not DO NOTHING: supabase-db-init re-runs this seed on every start, and
-- the Supabase DB lives on a persistent volume. With DO NOTHING a persona row that
-- was written by an older, broken version of this seed could never be repaired --
-- the seed would silently report "INSERT 0 0" forever.
ON CONFLICT (id) DO UPDATE SET
  aud                        = EXCLUDED.aud,
  role                       = EXCLUDED.role,
  email                      = EXCLUDED.email,
  encrypted_password         = EXCLUDED.encrypted_password,
  email_confirmed_at         = EXCLUDED.email_confirmed_at,
  confirmation_token         = EXCLUDED.confirmation_token,
  recovery_token             = EXCLUDED.recovery_token,
  email_change               = EXCLUDED.email_change,
  email_change_token_new     = EXCLUDED.email_change_token_new,
  email_change_token_current = EXCLUDED.email_change_token_current,
  phone_change               = EXCLUDED.phone_change,
  phone_change_token         = EXCLUDED.phone_change_token,
  reauthentication_token     = EXCLUDED.reauthentication_token,
  raw_app_meta_data          = EXCLUDED.raw_app_meta_data,
  is_sso_user                = EXCLUDED.is_sso_user,
  updated_at                 = NOW();

-- Seed auth.identities for password authentication
-- The identity_data must include 'sub' (user_id) and 'email'
INSERT INTO auth.identities (
  id,
  user_id,
  identity_data,
  provider,
  provider_id,
  last_sign_in_at,
  created_at,
  updated_at
) VALUES
(
  'b0000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000001',
  jsonb_build_object('sub', 'a0000000-0000-0000-0000-000000000001', 'email', 'admin@acs-cymru.local'),
  'email',
  'a0000000-0000-0000-0000-000000000001',
  NOW(),
  NOW(),
  NOW()
),
(
  'b0000000-0000-0000-0000-000000000002',
  'a0000000-0000-0000-0000-000000000002',
  jsonb_build_object('sub', 'a0000000-0000-0000-0000-000000000002', 'email', 'manager@acs-cymru.local'),
  'email',
  'a0000000-0000-0000-0000-000000000002',
  NOW(),
  NOW(),
  NOW()
),
(
  'b0000000-0000-0000-0000-000000000003',
  'a0000000-0000-0000-0000-000000000003',
  jsonb_build_object('sub', 'a0000000-0000-0000-0000-000000000003', 'email', 'operator@acs-cymru.local'),
  'email',
  'a0000000-0000-0000-0000-000000000003',
  NOW(),
  NOW(),
  NOW()
),
(
  'b0000000-0000-0000-0000-000000000004',
  'a0000000-0000-0000-0000-000000000004',
  jsonb_build_object('sub', 'a0000000-0000-0000-0000-000000000004', 'email', 'auditor@acs-cymru.local'),
  'email',
  'a0000000-0000-0000-0000-000000000004',
  NOW(),
  NOW(),
  NOW()
)
ON CONFLICT (id) DO UPDATE SET
  user_id       = EXCLUDED.user_id,
  identity_data = EXCLUDED.identity_data,
  provider      = EXCLUDED.provider,
  provider_id   = EXCLUDED.provider_id,
  updated_at    = NOW();

-- Seed public.user_roles mapping auth user_id to public.roles(id).
-- Clear any pre-existing mappings for the demo personas so each one ends up with exactly one
-- role. usePermissions.js reads data[0] and custom_access_token_hook() uses LIMIT 1, so a persona
-- holding two roles would resolve non-deterministically.
--
-- ONLY THE MAPPINGS THAT ARE WRONG, and the `NOT IN` is what makes this file replayable now that
-- `user_roles` is audited (0070). The unconditional DELETE this replaces removed all four rows and
-- the INSERT below put them straight back, so every boot appended four ROLE_REVOKED rows and four
-- ROLE_GRANTED rows to a table that is append-only and cannot be pruned --
-- `check-migration-idempotency.mjs` reports it, and the audit trail would have read as though
-- somebody re-granted every persona's role nightly.
--
-- The guarantee is unchanged: any mapping for these four that is not the intended pair is removed.
-- What changes is that a settled database matches no rows.
DELETE FROM public.user_roles
WHERE user_id IN (
  'a0000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000002',
  'a0000000-0000-0000-0000-000000000003',
  'a0000000-0000-0000-0000-000000000004'
)
AND (user_id, role_id) NOT IN (
  ('a0000000-0000-0000-0000-000000000001', 1),
  ('a0000000-0000-0000-0000-000000000002', 2),
  ('a0000000-0000-0000-0000-000000000003', 3),
  ('a0000000-0000-0000-0000-000000000004', 4)
);

INSERT INTO public.user_roles (user_id, role_id) VALUES
  ('a0000000-0000-0000-0000-000000000001', 1), -- Administrator
  ('a0000000-0000-0000-0000-000000000002', 2), -- Shopfloor_Manager
  ('a0000000-0000-0000-0000-000000000003', 3), -- Operator
  ('a0000000-0000-0000-0000-000000000004', 4)  -- Auditor
ON CONFLICT (user_id, role_id) DO NOTHING;


-- =============================================================================================
-- Digital Thread causation demonstration -- ONE act, four audit rows, two entity types
-- =============================================================================================
--
-- WHAT THIS IS FOR. `digital_thread.causation_id` (migration 0026) stamps every audit row with the
-- transaction that wrote it, so the several rows one operator action produces can be read back as
-- one act rather than reassembled from timestamps. The dashboard renders that as the "Same
-- transaction" control in the Digital Thread drawer.
--
-- THE FEATURE IS INVISIBLE ON A FRESH STACK WITHOUT THIS BLOCK, and that is the problem it solves.
-- Almost every audit row a fresh boot produces comes from a single-row write -- provisioning a
-- device, a gateway registering -- so its causation group has exactly one member and the control
-- correctly renders nothing at all. `npm run stack:reset -- --yes` drops every volume, so a
-- demonstration created by hand does not survive one. This is a seeded act that does.
--
-- WHY A GATEWAY AND ITS DEVICES RATHER THAN TWO DEVICES. Causation crosses entity types, and that
-- is exactly the axis the drawer's Previous/Next buttons cannot reach -- those step through ONE
-- asset over time and never leave its lane. A group spanning a GATEWAY and three DEVICEs shows the
-- thing the control exists for; a group of two devices in the same lane section barely does.
-- (`cells` carries no `description` column, so the third entity type cannot join in without
-- inventing a schema change for a demo, which is not a trade worth making.)
--
-- Commissioning a cell is also a REAL act of this shape: an engineer describing the edge gateway
-- and the machines behind it, in one edit, is one intent -- which is what causation is for.
--
-- ---------------------------------------------------------------------------------------------
-- IT IS ATTRIBUTED TO THE SEEDED ADMINISTRATOR, AND THAT IS A DELIBERATE FICTION.
--
-- `SET LOCAL acs_cymru.actor_id` is the mechanism migration 0003 built so a SECURITY DEFINER RPC
-- acting on a user's behalf records the operator rather than the machine credential the request
-- travelled on. Used here it makes the demo rows read `actor_source = 'user'` with the admin
-- persona's id, instead of `migration`.
--
-- That is a claim that a person did something no person did, and it is acceptable HERE and ONLY
-- here for the reason stated at the top of this file: this is local development seed data, in the
-- same file that fabricates four personas with published passwords. It must never be copied into a
-- migration. Without it the demonstration would be of a migration editing rows, which is not the
-- case anybody needs to understand.
--
-- ---------------------------------------------------------------------------------------------
-- IDEMPOTENT IN TWO INDEPENDENT WAYS, because db-init replays this file on EVERY boot and
-- `digital_thread` is append-only -- a block that appended four rows per restart would grow the
-- audit table forever and bury the demonstration in copies of itself.
--
--   1. `IS DISTINCT FROM` in each WHERE clause. On a second boot the descriptions already hold
--      these values, so the statements match no rows and write nothing at all -- no UPDATE, no WAL,
--      and no Realtime broadcast to every connected dashboard.
--
--   2. Migration 0005's suppression guard would catch it anyway: an UPDATE whose row is unchanged
--      writes no audit row. Belt and braces on purpose -- (1) is the cheap one and (2) is the one
--      that still holds if someone edits (1) carelessly.
--
-- ROWS ARE ADDRESSED BY THEIR PINNED UUIDs, not by name, matching how
-- `scripts/provision-gateways.mjs` creates them. A name is a mutable display label; addressing by
-- it would make this block silently do nothing the first time somebody renames a machine in the
-- dashboard.
--
-- ---------------------------------------------------------------------------------------------
-- ITS SUBJECT IS NOT GUARANTEED TO EXIST, BECAUSE THE SIMULATED FLOOR IS OPT-IN.
--
-- These ids used to be seeded by `0002_seed_data.sql` on every boot, so the demonstration always
-- had something to demonstrate on. `0040_retire_demonstration_seed.sql` retires that seed: a
-- fresh install has no assets at all, and the four-cell floor arrives only when a reader runs
-- `npm run provision:gateways`.
--
-- THE UPDATEs BELOW ALREADY COPE -- they match no rows and write nothing, which is the same
-- no-op as the second boot of a seeded stack. THE SELF-CHECK DID NOT: it RAISEd when no causation
-- group existed, which db-init reports as a failed seed and a failed boot. On a fresh install
-- that is not a broken demonstration, it is an empty shopfloor working exactly as intended.
--
-- So the check now distinguishes the two cases by asking whether the SUBJECT is present, and the
-- demonstration reappears on the first boot after provisioning -- this file is replayed every
-- time, so the pair of UPDATEs lands in one transaction then, with the same result it always had.
-- ==============================================================================================

BEGIN;

-- The transaction the whole demonstration rests on. Every audit row written between here and
-- COMMIT shares one `txid_current()`, which is what `causationSiblings()` groups by in the browser.
SET LOCAL acs_cymru.actor_id = 'a0000000-0000-0000-0000-000000000001';

-- Cell 1's edge gateway.
UPDATE public.gateways
   SET description = 'Edge gateway for Cell 1 - Precision Machining. Commissioned with the cell.'
 WHERE id = '12000000-0000-4000-8000-000000000001'
   AND description IS DISTINCT FROM
       'Edge gateway for Cell 1 - Precision Machining. Commissioned with the cell.';

-- The three machines behind it. ONE STATEMENT for all three, which is what a batch commissioning
-- actually is -- and it demonstrates that a causation group is not one row per statement.
UPDATE public.devices
   SET description = 'Commissioned with Cell 1 - Precision Machining.'
 WHERE id IN (
         '22000000-0000-4000-8000-000000000001',  -- Sim_CNC_Mill_01
         '23000000-0000-4000-8000-000000000001',  -- Sim_CNC_Mill_02
         '27000000-0000-4000-8000-000000000001'   -- Sim_Tool_Changer_01
       )
   AND description IS DISTINCT FROM 'Commissioned with Cell 1 - Precision Machining.';

COMMIT;


-- ---------------------------------------------------------------------------------------------
-- Self-check: the demonstration is actually there
-- ---------------------------------------------------------------------------------------------
-- WHAT THIS CATCHES that nothing else would. The block above is idempotent by design, so on every
-- boot after the first it legitimately writes nothing -- which makes "it ran without error"
-- worthless as evidence. If a future edit broke the grouping (a stray COMMIT between the two
-- statements, a renamed persona breaking the actor foreign key, a device id changed in 0002), a
-- fresh `stack:reset` would come up with the Digital Thread drawer quietly showing no related
-- changes, and the only symptom would be a demo that does not demonstrate anything.
--
-- WHICH IS WHY THE ABSENT-SUBJECT ARM IS A NOTICE AND NOT A QUIETLY RELAXED CHECK. "The floor is
-- not provisioned" and "the floor is provisioned and the grouping broke" look identical from the
-- outside -- an empty drawer -- and only one of them is a bug. Weakening the check to `IF v_group
-- IS NOT NULL THEN assert` would have covered the second case with the first and thrown away the
-- entire value of the assertion.
--
-- ASSERTED AS A PROPERTY OF THE TABLE, NOT OF THIS BOOT: "some transaction grouped a gateway with
-- more than one device". That holds on a fresh volume and on the hundredth restart alike, and it
-- does not break if an operator later edits one of these rows by hand.
DO $causation_demo$
DECLARE
  v_group BIGINT;
  v_rows  INTEGER;
BEGIN
  SELECT causation_id INTO v_group
    FROM public.digital_thread
   WHERE causation_id IS NOT NULL
   GROUP BY causation_id
  HAVING count(*) FILTER (WHERE entity_type = 'gateways') > 0
     AND count(*) FILTER (WHERE entity_type = 'devices')  > 1
   ORDER BY causation_id DESC
   LIMIT 1;

  IF v_group IS NULL THEN
    -- NO GROUP AND NO SUBJECT is the fresh-install steady state: the demonstration floor is
    -- opt-in, so there is no gateway to commission and nothing was expected to be written.
    IF NOT EXISTS (
      SELECT 1 FROM public.gateways WHERE id = '12000000-0000-4000-8000-000000000001'
    ) THEN
      RAISE NOTICE
        'seed: no causation demonstration, because the demonstration floor is not provisioned on '
        'this stack. Run `npm run provision:gateways` and restart to seed it.';
      RETURN;
    END IF;

    -- NO GROUP BUT THE SUBJECT IS THERE is a real regression, and the same one this check was
    -- written to catch: the rows exist, so the UPDATEs above should have grouped them.
    RAISE EXCEPTION
      'seed: the Digital Thread causation demonstration is missing even though its gateway is '
      'registered. No transaction in digital_thread groups a gateway with more than one device, '
      'so the "Same transaction" control in the drawer will render nothing on this stack. Check '
      'that the BEGIN/COMMIT block above still commits ONCE, and that the ids it names still '
      'match scripts/provision-gateways.mjs.';
  END IF;

  SELECT count(*) INTO v_rows
    FROM public.digital_thread WHERE causation_id = v_group;

  RAISE NOTICE
    'seed: causation demonstration ready -- transaction % groups % audit rows across a gateway '
    'and its devices.', v_group, v_rows;
END;
$causation_demo$;
