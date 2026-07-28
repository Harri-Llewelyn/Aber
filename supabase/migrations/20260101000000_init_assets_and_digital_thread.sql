-- Migration: 20260101000000_init_assets_and_digital_thread.sql
-- Description: Initialize cells, gateways, devices, and digital_thread audit logging with RLS and triggers.

-- 1. Create Tables
CREATE TABLE IF NOT EXISTS public.cells (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    grafana_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.gateways (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    cell_id UUID REFERENCES public.cells(id) ON DELETE CASCADE,
    access_url TEXT,
    status TEXT DEFAULT 'OFFLINE',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.devices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT UNIQUE NOT NULL,
    gateway_id UUID REFERENCES public.gateways(id) ON DELETE SET NULL,
    status TEXT DEFAULT 'OFFLINE',
    is_quarantined BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.digital_thread (
    id BIGSERIAL PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id UUID NOT NULL,
    action TEXT NOT NULL,
    old_data JSONB,
    new_data JSONB,
    changed_by UUID REFERENCES auth.users(id),
    recorded_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Digital Thread Trigger Function & Triggers
CREATE OR REPLACE FUNCTION public.log_digital_thread_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_old_data JSONB := NULL;
    v_new_data JSONB := NULL;
    v_entity_id UUID;
BEGIN
    IF (TG_OP = 'DELETE') THEN
        v_old_data := to_jsonb(OLD);
        v_entity_id := OLD.id;
    ELSIF (TG_OP = 'UPDATE') THEN
        v_old_data := to_jsonb(OLD);
        v_new_data := to_jsonb(NEW);
        v_entity_id := NEW.id;
    ELSIF (TG_OP = 'INSERT') THEN
        v_new_data := to_jsonb(NEW);
        v_entity_id := NEW.id;
    END IF;

    INSERT INTO public.digital_thread (
        entity_type,
        entity_id,
        action,
        old_data,
        new_data,
        changed_by,
        recorded_at
    ) VALUES (
        TG_TABLE_NAME,
        v_entity_id,
        TG_OP,
        v_old_data,
        v_new_data,
        auth.uid(),
        NOW()
    );

    RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_cells_digital_thread ON public.cells;
CREATE TRIGGER trg_cells_digital_thread
AFTER INSERT OR UPDATE OR DELETE ON public.cells
FOR EACH ROW EXECUTE FUNCTION public.log_digital_thread_event();

DROP TRIGGER IF EXISTS trg_gateways_digital_thread ON public.gateways;
CREATE TRIGGER trg_gateways_digital_thread
AFTER INSERT OR UPDATE OR DELETE ON public.gateways
FOR EACH ROW EXECUTE FUNCTION public.log_digital_thread_event();

DROP TRIGGER IF EXISTS trg_devices_digital_thread ON public.devices;
CREATE TRIGGER trg_devices_digital_thread
AFTER INSERT OR UPDATE OR DELETE ON public.devices
FOR EACH ROW EXECUTE FUNCTION public.log_digital_thread_event();

-- 3. Row Level Security (RLS) & Policies
ALTER TABLE public.cells ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gateways ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.digital_thread ENABLE ROW LEVEL SECURITY;

-- Cells Policies
DROP POLICY IF EXISTS "cells_select_authenticated" ON public.cells;
CREATE POLICY "cells_select_authenticated"
ON public.cells FOR SELECT TO authenticated
USING (true);

DROP POLICY IF EXISTS "cells_insert_privileged" ON public.cells;
CREATE POLICY "cells_insert_privileged"
ON public.cells FOR INSERT TO authenticated
WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'));

DROP POLICY IF EXISTS "cells_update_privileged" ON public.cells;
CREATE POLICY "cells_update_privileged"
ON public.cells FOR UPDATE TO authenticated
USING ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'))
WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'));

DROP POLICY IF EXISTS "cells_delete_privileged" ON public.cells;
CREATE POLICY "cells_delete_privileged"
ON public.cells FOR DELETE TO authenticated
USING ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'));

-- Gateways Policies
DROP POLICY IF EXISTS "gateways_select_authenticated" ON public.gateways;
CREATE POLICY "gateways_select_authenticated"
ON public.gateways FOR SELECT TO authenticated
USING (true);

DROP POLICY IF EXISTS "gateways_insert_privileged" ON public.gateways;
CREATE POLICY "gateways_insert_privileged"
ON public.gateways FOR INSERT TO authenticated
WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'));

DROP POLICY IF EXISTS "gateways_update_privileged" ON public.gateways;
CREATE POLICY "gateways_update_privileged"
ON public.gateways FOR UPDATE TO authenticated
USING ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'))
WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'));

DROP POLICY IF EXISTS "gateways_delete_privileged" ON public.gateways;
CREATE POLICY "gateways_delete_privileged"
ON public.gateways FOR DELETE TO authenticated
USING ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'));

-- Devices Policies
DROP POLICY IF EXISTS "devices_select_authenticated" ON public.devices;
CREATE POLICY "devices_select_authenticated"
ON public.devices FOR SELECT TO authenticated
USING (true);

DROP POLICY IF EXISTS "devices_insert_privileged" ON public.devices;
CREATE POLICY "devices_insert_privileged"
ON public.devices FOR INSERT TO authenticated
WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'));

DROP POLICY IF EXISTS "devices_update_privileged" ON public.devices;
CREATE POLICY "devices_update_privileged"
ON public.devices FOR UPDATE TO authenticated
USING ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'))
WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'));

DROP POLICY IF EXISTS "devices_delete_privileged" ON public.devices;
CREATE POLICY "devices_delete_privileged"
ON public.devices FOR DELETE TO authenticated
USING ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'));

-- Digital Thread Policies
DROP POLICY IF EXISTS "digital_thread_select_authenticated" ON public.digital_thread;
CREATE POLICY "digital_thread_select_authenticated"
ON public.digital_thread FOR SELECT TO authenticated
USING (true);

DROP POLICY IF EXISTS "digital_thread_insert_privileged" ON public.digital_thread;
CREATE POLICY "digital_thread_insert_privileged"
ON public.digital_thread FOR INSERT TO authenticated
WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'));

DROP POLICY IF EXISTS "digital_thread_update_privileged" ON public.digital_thread;
CREATE POLICY "digital_thread_update_privileged"
ON public.digital_thread FOR UPDATE TO authenticated
USING ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'))
WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'));

DROP POLICY IF EXISTS "digital_thread_delete_privileged" ON public.digital_thread;
CREATE POLICY "digital_thread_delete_privileged"
ON public.digital_thread FOR DELETE TO authenticated
USING ((auth.jwt() -> 'app_metadata' ->> 'role') IN ('Administrator', 'Shopfloor_Manager'));
