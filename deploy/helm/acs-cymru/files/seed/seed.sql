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
  extensions.crypt('factoryplus123', extensions.gen_salt('bf')),
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
  extensions.crypt('factoryplus123', extensions.gen_salt('bf')),
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
  extensions.crypt('factoryplus123', extensions.gen_salt('bf')),
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
  extensions.crypt('factoryplus123', extensions.gen_salt('bf')),
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
-- Clear any pre-existing mappings for the demo personas first so each one ends up with
-- exactly one role. usePermissions.js reads data[0] and custom_access_token_hook() uses
-- LIMIT 1, so a persona holding two roles would resolve non-deterministically.
DELETE FROM public.user_roles
WHERE user_id IN (
  'a0000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000002',
  'a0000000-0000-0000-0000-000000000003',
  'a0000000-0000-0000-0000-000000000004'
);

INSERT INTO public.user_roles (user_id, role_id) VALUES
  ('a0000000-0000-0000-0000-000000000001', 1), -- Administrator
  ('a0000000-0000-0000-0000-000000000002', 2), -- Shopfloor_Manager
  ('a0000000-0000-0000-0000-000000000003', 3), -- Operator
  ('a0000000-0000-0000-0000-000000000004', 4)  -- Auditor
ON CONFLICT (user_id, role_id) DO NOTHING;
