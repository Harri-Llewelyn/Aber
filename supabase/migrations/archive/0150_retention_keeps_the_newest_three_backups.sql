-- =============================================================================================
-- Migration: 0017_retention_keeps_the_newest_three_backups.sql
-- The retention prune never removes any of the newest three backups
-- =============================================================================================
--
-- backup_prunable() selected by age alone, and the backup service prunes after every job it
-- claims, a failed one included. Two weeks of failed backups therefore deleted the last good
-- scheduled one on the day it aged past the window. The newest three backups are now never
-- returned, pinned or not, whatever their age (supabase/README.md, "Backups from the dashboard").
--
-- The same signature and return type, so the ACL 0001 gave the function is kept.
--
-- Idempotent.
-- =============================================================================================

SET search_path TO public;

CREATE OR REPLACE FUNCTION public.backup_prunable(p_retention_days integer) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
BEGIN
    PERFORM public.require_backup_service_caller('backup_prunable');

    -- Zero or less disables pruning, as BACKUP_RETENTION_DAYS=0 does in backup-databases.sh.
    IF coalesce(p_retention_days, 0) <= 0 THEN
        RETURN '[]'::jsonb;
    END IF;

    -- The floor: the newest three rows are never returned. Every row is a successful backup, so
    -- while backups are failing these are the last three good ones. The Backups page holds the
    -- same number (BACKUP_RETENTION_FLOOR), and check-docs-drift.mjs couples the two.
    RETURN coalesce((
        SELECT jsonb_agg(jsonb_build_object('id', b.id, 'stamp', b.stamp, 'location', b.location) ORDER BY b.taken_at)
          FROM public.backups b
         WHERE NOT b.pinned
           AND b.taken_at < now() - make_interval(days => p_retention_days)
           AND b.id NOT IN (
               SELECT n.id FROM public.backups n ORDER BY n.taken_at DESC, n.stamp DESC LIMIT 3
           )
    ), '[]'::jsonb);
END;
$$;

COMMENT ON FUNCTION public.backup_prunable(integer) IS
  'The backups the retention window has expired and nobody has pinned, oldest first, never any of '
  'the newest three. The service deletes each one''s files and then calls backup_forget().';

DO $check$
DECLARE
    v_src text := (SELECT prosrc FROM pg_proc WHERE oid = 'public.backup_prunable(integer)'::regprocedure);
BEGIN
    IF position('LIMIT 3' in v_src) = 0 THEN
        RAISE EXCEPTION '0017: backup_prunable() has no floor; retention can delete the last good backup';
    END IF;
    IF has_function_privilege('anon', 'public.backup_prunable(integer)', 'EXECUTE')
       OR has_function_privilege('authenticated', 'public.backup_prunable(integer)', 'EXECUTE') THEN
        RAISE EXCEPTION '0017: backup_prunable() is executable by a PostgREST role';
    END IF;
END $check$;
