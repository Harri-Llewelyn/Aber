-- =============================================================================
-- Factory+ Asset Tracking Local Development Seed Data
-- =============================================================================
-- WARNING: THIS FILE CONTAINS LOCAL DEVELOPMENT SEED DATA ONLY.
-- DO NOT RUN OR EXECUTE THIS FILE AGAINST A PRODUCTION DATABASE OR CLOUD ENVIRONMENT.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- Seed auth.users with the 4 standard demo personas
-- Note: For GoTrue v2.x, we need to set:
-- - confirmation_token and recovery_token to empty strings (not NULL) to avoid scan errors
-- - email_confirmed_at to NOW() to mark users as confirmed
-- - encrypted_password is stored as bcrypt hash
-- - raw_app_meta_data must include the 'role' key with the user's role name
-- - is_sso_user must be false (default)
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
  email_change_token_new,
  email_change_token_current,
  reauthentication_token
) VALUES
(
  '00000000-0000-0000-0000-000000000000',
  'a0000000-0000-0000-0000-000000000001',
  'authenticated',
  'authenticated',
  'admin@factoryplus.local',
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
  '',  -- email_change_token_new
  '',  -- email_change_token_current
  ''   -- reauthentication_token
),
(
  '00000000-0000-0000-0000-000000000000',
  'a0000000-0000-0000-0000-000000000002',
  'authenticated',
  'authenticated',
  'manager@factoryplus.local',
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
  '',  -- email_change_token_new
  '',  -- email_change_token_current
  ''   -- reauthentication_token
),
(
  '00000000-0000-0000-0000-000000000000',
  'a0000000-0000-0000-0000-000000000003',
  'authenticated',
  'authenticated',
  'operator@factoryplus.local',
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
  '',  -- email_change_token_new
  '',  -- email_change_token_current
  ''   -- reauthentication_token
),
(
  '00000000-0000-0000-0000-000000000000',
  'a0000000-0000-0000-0000-000000000004',
  'authenticated',
  'authenticated',
  'auditor@factoryplus.local',
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
  '',  -- email_change_token_new
  '',  -- email_change_token_current
  ''   -- reauthentication_token
)
ON CONFLICT (id) DO NOTHING;

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
  jsonb_build_object('sub', 'a0000000-0000-0000-0000-000000000001', 'email', 'admin@factoryplus.local'),
  'email',
  'a0000000-0000-0000-0000-000000000001',
  NOW(),
  NOW(),
  NOW()
),
(
  'b0000000-0000-0000-0000-000000000002',
  'a0000000-0000-0000-0000-000000000002',
  jsonb_build_object('sub', 'a0000000-0000-0000-0000-000000000002', 'email', 'manager@factoryplus.local'),
  'email',
  'a0000000-0000-0000-0000-000000000002',
  NOW(),
  NOW(),
  NOW()
),
(
  'b0000000-0000-0000-0000-000000000003',
  'a0000000-0000-0000-0000-000000000003',
  jsonb_build_object('sub', 'a0000000-0000-0000-0000-000000000003', 'email', 'operator@factoryplus.local'),
  'email',
  'a0000000-0000-0000-0000-000000000003',
  NOW(),
  NOW(),
  NOW()
),
(
  'b0000000-0000-0000-0000-000000000004',
  'a0000000-0000-0000-0000-000000000004',
  jsonb_build_object('sub', 'a0000000-0000-0000-0000-000000000004', 'email', 'auditor@factoryplus.local'),
  'email',
  'a0000000-0000-0000-0000-000000000004',
  NOW(),
  NOW(),
  NOW()
)
ON CONFLICT (id) DO NOTHING;

-- Seed public.user_roles mapping auth user_id to public.roles(id)
INSERT INTO public.user_roles (user_id, role_id) VALUES
  ('a0000000-0000-0000-0000-000000000001', 1), -- Administrator
  ('a0000000-0000-0000-0000-000000000002', 2), -- Shopfloor_Manager
  ('a0000000-0000-0000-0000-000000000003', 3), -- Operator
  ('a0000000-0000-0000-0000-000000000004', 4)  -- Auditor
ON CONFLICT (user_id, role_id) DO NOTHING;
