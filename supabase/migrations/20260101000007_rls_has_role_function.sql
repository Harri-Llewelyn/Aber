-- Migration: 20260101000007_rls_has_role_function.sql
-- Description: Centralize RLS role checks via public.has_role() backed by user_roles,
-- and add a custom access token hook to sync app_metadata.role from the DB on token issue.

CREATE OR REPLACE FUNCTION public.has_role(allowed_roles text[])
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.roles r ON r.id = ur.role_id
    WHERE ur.user_id = auth.uid()::text
      AND r.name = ANY (allowed_roles)
  );
$$;

REVOKE ALL ON FUNCTION public.has_role(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_role(text[]) TO authenticated;

-- Sync JWT app_metadata.role from user_roles on every token issue/refresh.
CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claims jsonb;
  role_name text;
BEGIN
  SELECT r.name INTO role_name
  FROM public.user_roles ur
  JOIN public.roles r ON r.id = ur.role_id
  WHERE ur.user_id = (event->>'user_id')
  LIMIT 1;

  claims := event->'claims';

  IF role_name IS NOT NULL THEN
    claims := jsonb_set(
      COALESCE(claims, '{}'::jsonb),
      '{app_metadata,role}',
      to_jsonb(role_name),
      true
    );
  END IF;

  RETURN jsonb_set(event, '{claims}', claims, true);
END;
$$;

REVOKE ALL ON FUNCTION public.custom_access_token_hook(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.custom_access_token_hook(jsonb) TO supabase_auth_admin;

-- Asset tables (cells, gateways, devices)
DROP POLICY IF EXISTS "cells_insert_privileged" ON public.cells;
DROP POLICY IF EXISTS "cells_update_privileged" ON public.cells;
DROP POLICY IF EXISTS "cells_delete_privileged" ON public.cells;

CREATE POLICY "cells_insert_privileged" ON public.cells
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

CREATE POLICY "cells_update_privileged" ON public.cells
  FOR UPDATE TO authenticated
  USING (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']))
  WITH CHECK (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

CREATE POLICY "cells_delete_privileged" ON public.cells
  FOR DELETE TO authenticated
  USING (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

DROP POLICY IF EXISTS "gateways_insert_privileged" ON public.gateways;
DROP POLICY IF EXISTS "gateways_update_privileged" ON public.gateways;
DROP POLICY IF EXISTS "gateways_delete_privileged" ON public.gateways;

CREATE POLICY "gateways_insert_privileged" ON public.gateways
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

CREATE POLICY "gateways_update_privileged" ON public.gateways
  FOR UPDATE TO authenticated
  USING (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']))
  WITH CHECK (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

CREATE POLICY "gateways_delete_privileged" ON public.gateways
  FOR DELETE TO authenticated
  USING (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

DROP POLICY IF EXISTS "devices_insert_privileged" ON public.devices;
DROP POLICY IF EXISTS "devices_update_privileged" ON public.devices;
DROP POLICY IF EXISTS "devices_delete_privileged" ON public.devices;

CREATE POLICY "devices_insert_privileged" ON public.devices
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

CREATE POLICY "devices_update_privileged" ON public.devices
  FOR UPDATE TO authenticated
  USING (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']))
  WITH CHECK (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

CREATE POLICY "devices_delete_privileged" ON public.devices
  FOR DELETE TO authenticated
  USING (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

-- Digital thread SELECT (insert/update/delete removed in 00006)
DROP POLICY IF EXISTS "digital_thread_select_privileged_or_auditor" ON public.digital_thread;

CREATE POLICY "digital_thread_select_privileged_or_auditor" ON public.digital_thread
  FOR SELECT TO authenticated
  USING (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager', 'Auditor']));

-- Documents, asset_config, schemas, directory_services
DROP POLICY IF EXISTS "documents_insert_privileged" ON public.documents;
DROP POLICY IF EXISTS "documents_update_privileged" ON public.documents;
DROP POLICY IF EXISTS "documents_delete_privileged" ON public.documents;

CREATE POLICY "documents_insert_privileged" ON public.documents
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

CREATE POLICY "documents_update_privileged" ON public.documents
  FOR UPDATE TO authenticated
  USING (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']))
  WITH CHECK (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

CREATE POLICY "documents_delete_privileged" ON public.documents
  FOR DELETE TO authenticated
  USING (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

DROP POLICY IF EXISTS "asset_config_insert_privileged" ON public.asset_config;
DROP POLICY IF EXISTS "asset_config_update_privileged" ON public.asset_config;
DROP POLICY IF EXISTS "asset_config_delete_privileged" ON public.asset_config;

CREATE POLICY "asset_config_insert_privileged" ON public.asset_config
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

CREATE POLICY "asset_config_update_privileged" ON public.asset_config
  FOR UPDATE TO authenticated
  USING (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']))
  WITH CHECK (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

CREATE POLICY "asset_config_delete_privileged" ON public.asset_config
  FOR DELETE TO authenticated
  USING (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

DROP POLICY IF EXISTS "schemas_insert_privileged" ON public.schemas;
DROP POLICY IF EXISTS "schemas_update_privileged" ON public.schemas;
DROP POLICY IF EXISTS "schemas_delete_privileged" ON public.schemas;

CREATE POLICY "schemas_insert_privileged" ON public.schemas
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

CREATE POLICY "schemas_update_privileged" ON public.schemas
  FOR UPDATE TO authenticated
  USING (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']))
  WITH CHECK (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

CREATE POLICY "schemas_delete_privileged" ON public.schemas
  FOR DELETE TO authenticated
  USING (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

DROP POLICY IF EXISTS "directory_services_insert_privileged" ON public.directory_services;
DROP POLICY IF EXISTS "directory_services_update_privileged" ON public.directory_services;
DROP POLICY IF EXISTS "directory_services_delete_privileged" ON public.directory_services;

CREATE POLICY "directory_services_insert_privileged" ON public.directory_services
  FOR INSERT TO authenticated
  WITH CHECK (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

CREATE POLICY "directory_services_update_privileged" ON public.directory_services
  FOR UPDATE TO authenticated
  USING (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']))
  WITH CHECK (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

CREATE POLICY "directory_services_delete_privileged" ON public.directory_services
  FOR DELETE TO authenticated
  USING (public.has_role(ARRAY['Administrator', 'Shopfloor_Manager']));

-- user_roles visibility
DROP POLICY IF EXISTS "user_roles_select_own_or_privileged" ON public.user_roles;

CREATE POLICY "user_roles_select_own_or_privileged" ON public.user_roles
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()::text
    OR public.has_role(ARRAY['Administrator', 'Shopfloor_Manager'])
  );
