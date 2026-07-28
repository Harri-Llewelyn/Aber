-- Migration: 20260101000003_add_rbac_permissions.sql
-- Description: Port roles, permissions, role_permissions, and user_roles tables to Supabase with RLS and seeds.
--
-- TODO: Future Architecture Enhancement:
-- A stronger authorization design would have RLS policies call a `has_permission(uuid, text)` SQL function
-- that joins `user_roles` -> `role_permissions` -> `permissions`, making the DB permission schema the active
-- server-side enforcement mechanism instead of relying strictly on `auth.jwt() -> 'app_metadata' ->> 'role'`.

CREATE TABLE IF NOT EXISTS public.roles (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    description TEXT
);

CREATE TABLE IF NOT EXISTS public.permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    description TEXT
);

CREATE TABLE IF NOT EXISTS public.role_permissions (
    role_id INT REFERENCES public.roles(id) ON DELETE CASCADE,
    permission_id UUID REFERENCES public.permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS public.user_roles (
    user_id TEXT NOT NULL,
    role_id INT REFERENCES public.roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);

-- Seed Roles
INSERT INTO public.roles (id, name, description) VALUES
  (1, 'Administrator', 'Full unrestricted access to shopfloor configuration, archives, and onboarding approval'),
  (2, 'Shopfloor_Manager', 'Can manage devices, cells, gateways, and approve quarantined onboarding'),
  (3, 'Operator', 'Operational dashboard view, live telemetry streaming, and document viewing'),
  (4, 'Auditor', 'Read-only audit trace and digital thread access')
ON CONFLICT (id) DO NOTHING;

-- Seed Fine-Grained Permissions
INSERT INTO public.permissions (id, name, description) VALUES
  ('cb46a943-42e1-4c1d-8706-933e08544e30', 'quarantine:view', 'View zero-touch onboarding quarantine queue in read-only mode'),
  ('cb46a943-42e1-4c1d-8706-933e08544e31', 'quarantine:approve', 'Approve discovered quarantined edge devices'),
  ('a123b456-7890-4c1d-8706-933e08544e32', 'quarantine:reject', 'Reject quarantined edge device discovery'),
  ('d987c654-3210-4c1d-8706-933e08544e33', 'device:manage', 'Create, edit, and reassign manufacturing devices'),
  ('c456d789-0123-4c1d-8706-933e08544e34', 'cell:manage', 'Create, update, and delete shopfloor cells'),
  ('e789a012-3456-4c1d-8706-933e08544e35', 'gateway:manage', 'Register and manage edge gateways'),
  ('f012a345-6789-4c1d-8706-933e08544e36', 'telemetry:read', 'View live telemetry streams and historical data'),
  ('b345c678-9012-4c1d-8706-933e08544e37', 'archive:manage', 'Archive, restore, and set retention auto-delete timers'),
  ('a012b345-6789-4c1d-8706-933e08544e38', 'document:manage', 'Add, edit, and remove external document links attached to assets'),
  ('e012c345-6789-4c1d-8706-933e08544e39', 'authz:manage', 'Manage roles, user permissions, and access checks'),
  ('f123d456-7890-4c1d-8706-933e08544e40', 'schema:manage', 'Register and validate industrial schemas'),
  ('c234e567-8901-4c1d-8706-933e08544e41', 'gitops:manage', 'Deploy flows and manage GitOps edge configurations'),
  ('d345e678-9012-4c1d-8706-933e08544e42', 'digital_thread:read', 'View continuous Digital Thread audit log entries')
ON CONFLICT (id) DO NOTHING;

-- Assign Permissions to Roles
INSERT INTO public.role_permissions (role_id, permission_id) VALUES
  (1, 'cb46a943-42e1-4c1d-8706-933e08544e30'),
  (1, 'cb46a943-42e1-4c1d-8706-933e08544e31'),
  (1, 'a123b456-7890-4c1d-8706-933e08544e32'),
  (1, 'd987c654-3210-4c1d-8706-933e08544e33'),
  (1, 'c456d789-0123-4c1d-8706-933e08544e34'),
  (1, 'e789a012-3456-4c1d-8706-933e08544e35'),
  (1, 'f012a345-6789-4c1d-8706-933e08544e36'),
  (1, 'b345c678-9012-4c1d-8706-933e08544e37'),
  (1, 'a012b345-6789-4c1d-8706-933e08544e38'),
  (1, 'e012c345-6789-4c1d-8706-933e08544e39'),
  (1, 'f123d456-7890-4c1d-8706-933e08544e40'),
  (1, 'c234e567-8901-4c1d-8706-933e08544e41'),
  (1, 'd345e678-9012-4c1d-8706-933e08544e42'),

  (2, 'cb46a943-42e1-4c1d-8706-933e08544e30'),
  (2, 'cb46a943-42e1-4c1d-8706-933e08544e31'),
  (2, 'a123b456-7890-4c1d-8706-933e08544e32'),
  (2, 'd987c654-3210-4c1d-8706-933e08544e33'),
  (2, 'c456d789-0123-4c1d-8706-933e08544e34'),
  (2, 'e789a012-3456-4c1d-8706-933e08544e35'),
  (2, 'f012a345-6789-4c1d-8706-933e08544e36'),
  (2, 'b345c678-9012-4c1d-8706-933e08544e37'),
  (2, 'a012b345-6789-4c1d-8706-933e08544e38'),
  (2, 'e012c345-6789-4c1d-8706-933e08544e39'),
  (2, 'f123d456-7890-4c1d-8706-933e08544e40'),
  (2, 'c234e567-8901-4c1d-8706-933e08544e41'),
  (2, 'd345e678-9012-4c1d-8706-933e08544e42'),

  (3, 'f012a345-6789-4c1d-8706-933e08544e36'),
  (3, 'cb46a943-42e1-4c1d-8706-933e08544e30'),

  (4, 'd345e678-9012-4c1d-8706-933e08544e42')
ON CONFLICT DO NOTHING;

-- Enable RLS
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "roles_select_authenticated" ON public.roles;
CREATE POLICY "roles_select_authenticated" ON public.roles FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "permissions_select_authenticated" ON public.permissions;
CREATE POLICY "permissions_select_authenticated" ON public.permissions FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "role_permissions_select_authenticated" ON public.role_permissions;
CREATE POLICY "role_permissions_select_authenticated" ON public.role_permissions FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "user_roles_select_authenticated" ON public.user_roles;
CREATE POLICY "user_roles_select_authenticated" ON public.user_roles FOR SELECT TO authenticated USING (true);
