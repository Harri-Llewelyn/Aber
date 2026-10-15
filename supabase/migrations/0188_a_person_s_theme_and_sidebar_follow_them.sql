-- 0188: A person's theme and sidebar layout follow them, not the browser.
--
-- user_settings holds one row per person: the choices on the dashboard's Profile page. Each choice
-- is a typed column with a CHECK and a default, so the database refuses a value the dashboard does
-- not know; a new preference is a column added by the migration beside the code that reads it.
-- A person reads and writes their own row and nobody else's, Administrators included. Nothing
-- here is platform state, so no audit trigger. The browser keeps a copy in localStorage
-- (aber_theme, aber_sidebar_mode) so a page paints before the row arrives; the row wins.
--
-- Reasoning: supabase/README.md, "A person's own preferences (0188)". Idempotent.

-- ---------------------------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------------------------
-- The values are useTheme.js's and useSidebarMode.js's, and the defaults are theirs too.
CREATE TABLE IF NOT EXISTS public.user_settings (
    user_id uuid NOT NULL,
    theme text DEFAULT 'dark'::text NOT NULL,
    sidebar_mode text DEFAULT 'hover'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_settings_pkey PRIMARY KEY (user_id),
    CONSTRAINT user_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
    CONSTRAINT user_settings_theme_check CHECK (theme = ANY (ARRAY['dark'::text, 'light'::text])),
    CONSTRAINT user_settings_sidebar_mode_check CHECK (sidebar_mode = ANY (ARRAY['hover'::text, 'expanded'::text, 'collapsed'::text]))
);

ALTER TABLE public.user_settings OWNER TO postgres;
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.user_settings IS
  'One row per person: the display choices on the dashboard''s Profile page, so they follow the '
  'account rather than the browser. Each person reads and writes their own row only; an '
  'Administrator reads nobody else''s. Not audited: a display choice is not platform state. '
  'Deleting the account deletes the row (0188).';
COMMENT ON COLUMN public.user_settings.theme IS
  'dark (the default) or light. The account menu''s Theme toggle and Profile > Appearance write it.';
COMMENT ON COLUMN public.user_settings.sidebar_mode IS
  'hover (the default), expanded or collapsed: how the sidebar behaves (useSidebarMode.js).';
COMMENT ON COLUMN public.user_settings.updated_at IS
  'When the row last changed. Stamped by user_settings_stamp(), not by the caller.';

-- ---------------------------------------------------------------------------------------------
-- 2. updated_at is the database's
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.user_settings_stamp() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_catalog'
    AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

ALTER FUNCTION public.user_settings_stamp() OWNER TO postgres;

COMMENT ON FUNCTION public.user_settings_stamp() IS
  'Stamps user_settings.updated_at on every insert and update, so the caller cannot supply it (0188).';

REVOKE ALL ON FUNCTION public.user_settings_stamp() FROM PUBLIC, anon, authenticated, service_role;

SELECT public.replay_trigger('public.user_settings', 'user_settings_stamp_trg', $ddl$
CREATE TRIGGER user_settings_stamp_trg BEFORE INSERT OR UPDATE ON public.user_settings FOR EACH ROW EXECUTE FUNCTION public.user_settings_stamp();
$ddl$);

-- ---------------------------------------------------------------------------------------------
-- 3. Who reaches it
-- ---------------------------------------------------------------------------------------------
-- A signed-in person reads, creates and changes their own row. No DELETE: the row goes with the
-- account. anon and service_role hold nothing; nothing but a person's own session has a reason to.
REVOKE ALL ON TABLE public.user_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.user_settings TO authenticated;

SELECT public.replay_policy('public.user_settings', 'user_settings_select_own', $ddl$
CREATE POLICY user_settings_select_own ON public.user_settings FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));
$ddl$);
SELECT public.replay_policy('public.user_settings', 'user_settings_insert_own', $ddl$
CREATE POLICY user_settings_insert_own ON public.user_settings FOR INSERT TO authenticated WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
$ddl$);
SELECT public.replay_policy('public.user_settings', 'user_settings_update_own', $ddl$
CREATE POLICY user_settings_update_own ON public.user_settings FOR UPDATE TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid))) WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
$ddl$);

-- ---------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- ---------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_role text;
  v_privilege text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.user_settings'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION '0188: user_settings does not have row-level security on';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'service_role'] LOOP
    IF has_table_privilege(v_role, 'public.user_settings', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') THEN
      RAISE EXCEPTION '0188: % holds a privilege on user_settings', v_role;
    END IF;
  END LOOP;
  -- One privilege per call: has_table_privilege() answers true when ANY of a list is held.
  FOREACH v_privilege IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE'] LOOP
    IF NOT has_table_privilege('authenticated', 'public.user_settings', v_privilege) THEN
      RAISE EXCEPTION '0188: authenticated lacks % on user_settings', v_privilege;
    END IF;
  END LOOP;
  IF has_table_privilege('authenticated', 'public.user_settings', 'DELETE, TRUNCATE') THEN
    RAISE EXCEPTION '0188: authenticated may delete from user_settings; the row goes with the account';
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.user_settings'::regclass
        AND polname IN ('user_settings_select_own', 'user_settings_insert_own', 'user_settings_update_own')) <> 3 THEN
    RAISE EXCEPTION '0188: a user_settings policy is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.user_settings'::regclass
               AND NOT tgisinternal AND tgname <> 'user_settings_stamp_trg') THEN
    RAISE EXCEPTION '0188: user_settings carries a trigger other than its stamp, and it is not audited';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
