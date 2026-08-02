-- Migration: 20260101000001_add_archival_columns.sql
-- Description: Add is_archived, archived_at, and auto_delete_at columns to cells, gateways, and devices for archival lifecycle management.

ALTER TABLE public.cells
    ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS auto_delete_at TIMESTAMPTZ;

ALTER TABLE public.gateways
    ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS auto_delete_at TIMESTAMPTZ;

ALTER TABLE public.devices
    ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS auto_delete_at TIMESTAMPTZ;
