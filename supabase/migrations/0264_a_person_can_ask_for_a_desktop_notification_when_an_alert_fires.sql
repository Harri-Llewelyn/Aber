-- 0264: A person can ask for a desktop notification when an alert starts firing.
--
-- user_settings gains desktop_notifications: whether a dashboard tab this person has open raises a
-- browser notification as an alert starts firing. Off by default, so nothing changes for anyone
-- until they choose, and a row written before this file reads off. It is the person's own choice and
-- follows them to any PC; the browser's permission to show one is granted per browser and is not
-- stored. Profile > Notifications writes it. 0188's grants and policies are on the table, not on its
-- columns, so they cover this one as they stand, and a person still reads and writes only their own
-- row. No site-wide switch: a site that wants them blocked does it through browser policy.
--
-- Reasoning: supabase/README.md, "A person can ask for a desktop notification when an alert starts
-- firing (0264)". Idempotent.

ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS desktop_notifications boolean DEFAULT false NOT NULL;

COMMENT ON COLUMN public.user_settings.desktop_notifications IS
  'false (the default) or true: whether a dashboard tab this person has open raises a browser '
  'notification when an alert starts firing. Whether the browser lets it is the browser''s to say '
  'and is not stored. Profile > Notifications writes it (0264).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_privilege text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'user_settings'
                    AND column_name = 'desktop_notifications' AND data_type = 'boolean'
                    AND is_nullable = 'NO' AND column_default = 'false') THEN
    RAISE EXCEPTION '0264: user_settings.desktop_notifications is missing, nullable or not off by default';
  END IF;
  -- One privilege per call: has_column_privilege() answers true when ANY of a list is held.
  FOREACH v_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
    IF has_column_privilege('anon', 'public.user_settings', 'desktop_notifications', v_privilege) THEN
      RAISE EXCEPTION '0264: anon holds % on user_settings.desktop_notifications', v_privilege;
    END IF;
  END LOOP;
  FOREACH v_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE'] LOOP
    IF NOT has_column_privilege('authenticated', 'public.user_settings', 'desktop_notifications', v_privilege) THEN
      RAISE EXCEPTION '0264: authenticated lacks % on user_settings.desktop_notifications; Profile cannot save it', v_privilege;
    END IF;
  END LOOP;
END
$check$;

NOTIFY pgrst, 'reload schema';
