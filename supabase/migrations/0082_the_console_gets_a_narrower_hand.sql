-- 0082: Studio's read paths stop running as the database owner.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- =================================================================================================
-- WHAT THIS IS FOR
--
-- `0081` and the gateway's studio listener decide WHO may open the console. This decides WHAT the
-- console does once opened, and the two are independent: this is worth having whether or not the
-- door exists, and the door is worth having whether or not this does.
--
-- The pinned Studio image builds one connection string per request:
--
--     getConnectionString({readOnly}) ->
--       postgresql://${readOnly ? POSTGRES_USER_READ_ONLY : POSTGRES_USER_READ_WRITE}
--                   :${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DATABASE}
--
-- This stack set only the read-write half (`POSTGRES_USER_READ_WRITE: postgres`), so every path
-- that ASKED for the restricted user was handed the owner instead -- silently, because the fallback
-- is the image's own default and nothing reports having taken it.
--
-- =================================================================================================
-- THIS FILE ASSERTS; IT DOES NOT GRANT, AND CANNOT
--
-- `supabase_read_only_user` is created by the supabase/postgres image, not by this repository, and
-- it is RESERVED: `"supabase_read_only_user" is a reserved role, only superusers can modify it`.
-- db-init connects as `postgres`, which is NOT a superuser on this image, so the ALTER that gives
-- it a password lives in the superuser step -- `supabase-db-roles-init` on Compose,
-- `db-roles-init` on Kubernetes -- beside the three scoped passwords already set there.
--
-- WHY IT NEEDS ONE AT ALL. The role ships with no password, and pg_hba trusts `127.0.0.1` while
-- requiring scram from every container network:
--
--     host  all  all  127.0.0.1/32   trust
--     host  all  all  172.16.0.0/12  scram-sha-256
--
-- So it authenticates fine from inside the database container and not at all from Studio. Setting
-- POSTGRES_USER_READ_ONLY without that ALTER does not narrow those paths -- it turns "runs as the
-- owner" into "cannot connect", which is a worse outcome reached by doing the apparently-correct
-- thing.
--
-- WHAT THE IMAGE ALREADY DECIDED, and this repository deliberately does not re-decide: the role
-- holds `pg_read_all_data` and `pg_monitor`, with `BYPASSRLS` and no write privilege anywhere. It
-- therefore reads THROUGH RLS, which is what makes a console usable, and writes nothing. Creating
-- a same-named role here would silently manufacture a weaker one if the image ever renamed or
-- re-scoped it, so an absent role is a WARNING rather than a CREATE.
--
-- =================================================================================================
-- WHY IT HOLDS THE OWNER'S PASSWORD, WHICH IS NOT A TYPO
--
-- The image substitutes ONE password into both branches of that connection string. There is no
-- POSTGRES_PASSWORD_READ_ONLY to set, so a distinct secret here would authenticate on neither
-- branch. Two consequences, stated rather than absorbed:
--
--   * IT CANNOT BE ROTATED SEPARATELY. Rotating this role's password means rotating the owner's.
--   * IT IS NOT A NEW EXPOSURE. Anything that can read this password can already read
--     POSTGRES_PASSWORD -- the same string, in the same environment, in the same container. The
--     credential is not what narrows here; the ROLE is.
--
-- If a future image gains a separate variable, the roles-init step is where that changes.
-- =================================================================================================

DO $$
DECLARE
  v_has_password BOOLEAN;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    RAISE WARNING '0082: supabase_read_only_user does not exist -- the image no longer ships it. '
                  'Studio''s read-only paths will fall back to POSTGRES_USER_READ_WRITE, which is '
                  'the database owner.';
    RETURN;
  END IF;

  -- THE ROLES-INIT STEP RAN, OR IT DID NOT. This is the only symptom visible from SQL, and the
  -- alternative is discovering it as a Studio page that fails to load with an authentication error
  -- naming a role nobody set up.
  SELECT rolpassword IS NOT NULL INTO v_has_password
    FROM pg_authid WHERE rolname = 'supabase_read_only_user';

  IF NOT v_has_password THEN
    RAISE WARNING '0082: supabase_read_only_user has no password, so Studio cannot authenticate as '
                  'it from any container network (pg_hba requires scram there). Run the roles-init '
                  'step -- supabase-db-roles-init on Compose, db-roles-init on Kubernetes -- or '
                  'leave POSTGRES_USER_READ_ONLY unset.';
  END IF;

  IF NOT pg_has_role('supabase_read_only_user', 'pg_read_all_data', 'MEMBER') THEN
    RAISE WARNING '0082: supabase_read_only_user is not a member of pg_read_all_data; Studio''s '
                  'read-only paths will connect and then see nothing.';
  END IF;
END $$;

-- A WRITE MUST FAIL, and this asserts it rather than trusting the role's name. `pg_read_all_data`
-- grants SELECT and nothing else today, but the role is the IMAGE's and its grants can move under
-- a version bump -- and the failure mode of that is a console which reports itself restricted and
-- is not. An EXCEPTION rather than a WARNING for the same reason 0053's ledger check is one: a
-- privilege that has quietly widened is not a degraded state to run in.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    RETURN;
  END IF;

  IF has_table_privilege('supabase_read_only_user', 'public.devices', 'INSERT')
     OR has_table_privilege('supabase_read_only_user', 'public.devices', 'UPDATE')
     OR has_table_privilege('supabase_read_only_user', 'public.devices', 'DELETE') THEN
    RAISE EXCEPTION '0082 self-check: supabase_read_only_user holds a write privilege on '
                    'public.devices. The read-only branch of Studio''s connection string would '
                    'not be read-only.';
  END IF;

  RAISE NOTICE '0082 self-check: supabase_read_only_user reads public.devices (%) and cannot write it.',
    has_table_privilege('supabase_read_only_user', 'public.devices', 'SELECT');
END $$;
