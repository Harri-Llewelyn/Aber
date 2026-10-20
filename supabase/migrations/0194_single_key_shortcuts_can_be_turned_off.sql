-- 0194: Single-key shortcuts can be turned off, per person.
--
-- user_settings gains single_key_shortcuts: whether ?, /, [ and ] act for this person. Each is one
-- character with no modifier, which speech input can type by mistake; WCAG 2.2 SC 2.1.4 asks for a
-- way to turn such shortcuts off. On by default, so nothing changes for anyone until they choose,
-- and a row written before this file reads on. Profile > Appearance writes it. 0188's grants and
-- policies are on the table, not on its columns, so they cover this one as they stand.
--
-- Reasoning: supabase/README.md, "Single-key shortcuts can be turned off (0194)". Idempotent.

ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS single_key_shortcuts boolean DEFAULT true NOT NULL;

COMMENT ON COLUMN public.user_settings.single_key_shortcuts IS
  'true (the default) or false: whether the dashboard''s single-key shortcuts ?, /, [ and ] act for '
  'this person. Ctrl K and the arrow keys are not covered. Profile > Appearance writes it (0194).';

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_privilege text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'user_settings'
                    AND column_name = 'single_key_shortcuts' AND data_type = 'boolean'
                    AND is_nullable = 'NO' AND column_default = 'true') THEN
    RAISE EXCEPTION '0194: user_settings.single_key_shortcuts is missing, nullable or not on by default';
  END IF;
  -- One privilege per call: has_column_privilege() answers true when ANY of a list is held.
  FOREACH v_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] LOOP
    IF has_column_privilege('anon', 'public.user_settings', 'single_key_shortcuts', v_privilege) THEN
      RAISE EXCEPTION '0194: anon holds % on user_settings.single_key_shortcuts', v_privilege;
    END IF;
  END LOOP;
  FOREACH v_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE'] LOOP
    IF NOT has_column_privilege('authenticated', 'public.user_settings', 'single_key_shortcuts', v_privilege) THEN
      RAISE EXCEPTION '0194: authenticated lacks % on user_settings.single_key_shortcuts; Profile cannot save it', v_privilege;
    END IF;
  END LOOP;
END
$check$;

NOTIFY pgrst, 'reload schema';
