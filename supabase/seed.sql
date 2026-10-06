-- Local development seed data: the four demo personas. NOT FOR A PRODUCTION DATABASE. Applied by
-- db-init only with supabaseAuth.demoAccounts on (values-dev.yaml), on every install and upgrade
-- against a persistent volume, so every statement here is repeatable on a database that already
-- holds these rows. A site's own first administrator is 0163's. Reasoning: ./README.md, "The
-- development seed".
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- GoTrue maps every varchar token column to a Go string, so each must be '' and not NULL:
-- email_change is nullable with no default, and omitting it breaks every login with a 500. aud must
-- equal GOTRUE_JWT_AUD or GoTrue finds nobody; raw_app_meta_data carries the role.
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
  'admin@aber.local',
  extensions.crypt('aber123', extensions.gen_salt('bf')),
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
  'manager@aber.local',
  extensions.crypt('aber123', extensions.gen_salt('bf')),
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
  'operator@aber.local',
  extensions.crypt('aber123', extensions.gen_salt('bf')),
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
  'auditor@aber.local',
  extensions.crypt('aber123', extensions.gen_salt('bf')),
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
-- DO UPDATE, not DO NOTHING: a persona row written by an older, broken seed must be repairable,
-- or the seed would report INSERT 0 0 forever.
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

-- identity_data must carry sub and email.
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
  jsonb_build_object('sub', 'a0000000-0000-0000-0000-000000000001', 'email', 'admin@aber.local'),
  'email',
  'a0000000-0000-0000-0000-000000000001',
  NOW(),
  NOW(),
  NOW()
),
(
  'b0000000-0000-0000-0000-000000000002',
  'a0000000-0000-0000-0000-000000000002',
  jsonb_build_object('sub', 'a0000000-0000-0000-0000-000000000002', 'email', 'manager@aber.local'),
  'email',
  'a0000000-0000-0000-0000-000000000002',
  NOW(),
  NOW(),
  NOW()
),
(
  'b0000000-0000-0000-0000-000000000003',
  'a0000000-0000-0000-0000-000000000003',
  jsonb_build_object('sub', 'a0000000-0000-0000-0000-000000000003', 'email', 'operator@aber.local'),
  'email',
  'a0000000-0000-0000-0000-000000000003',
  NOW(),
  NOW(),
  NOW()
),
(
  'b0000000-0000-0000-0000-000000000004',
  'a0000000-0000-0000-0000-000000000004',
  jsonb_build_object('sub', 'a0000000-0000-0000-0000-000000000004', 'email', 'auditor@aber.local'),
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

-- Only the mappings that are wrong. user_roles is audited and append-only, so the unconditional
-- DELETE plus re-INSERT this replaces appended eight audit rows per boot; a settled database now
-- matches no rows. Each persona holds exactly one role, because usePermissions.js reads data[0]
-- and custom_access_token_hook() uses LIMIT 1.
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
