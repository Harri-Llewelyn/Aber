-- 0082: Studio's read paths stop running as the database owner.
--
-- Idempotent: db-init replays every /migrations/*.sql on every boot.
--
-- The Studio image builds one connection string per request, choosing POSTGRES_USER_READ_ONLY or
-- POSTGRES_USER_READ_WRITE; with only the read-write half set, every path that asked for the
-- restricted user was handed the owner, silently.
--
-- This file asserts; it does not grant. `supabase_read_only_user` is created by the image and
-- is reserved (only superusers may modify it), and db-init's `postgres` is not a superuser, so
-- the ALTER that gives it a password lives in the superuser step (`supabase-db-roles-init` on
-- Compose, `db-roles-init` on Kubernetes). It needs one because pg_hba trusts 127.0.0.1 and
-- requires scram from the container networks. The role holds `pg_read_all_data` and `pg_monitor`
-- with BYPASSRLS and no write; an absent role is a WARNING rather than a CREATE, so a renamed
-- image role cannot be replaced by a weaker same-named one.
--
-- It holds the owner's password because the image substitutes one password into both branches.
-- It cannot be rotated separately, and it is not a new exposure: the credential is not what
-- narrows here; the role is.

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

-- A write must fail, asserted rather than trusted from the role's name: the role is the image's
-- and its grants can move under a version bump. An EXCEPTION, because a privilege that has
-- quietly widened is not a degraded state to run in.
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
