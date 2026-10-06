-- The GoTrue-shaped fixture a stackless Postgres needs before the migrations will apply.
--
-- =================================================================================================
-- RUN THIS AS supabase_admin, NOT postgres
--
-- The `auth` schema is owned by supabase_admin and `postgres` is NOT a superuser in
-- supabase/postgres:17.6.1.160, so CREATE FUNCTION in that schema fails with "permission denied for
-- schema auth". That is new at 17.6.1.160 -- the 15.x image allowed it -- and it is the same shape
-- as the storage.objects ownership problem the PG17 bump hit: `postgres` is an ordinary role here
-- and only supabase_admin is super.
--
-- Only the BOOTSTRAP needs the elevated role. The migrations still apply as `postgres`, which was
-- verified against 17.6.1.160 rather than assumed.
--
-- =================================================================================================
-- WHY IT EXISTS AT ALL
--
-- GoTrue is not running, so the auth helpers the migrations rely on are either missing or stale in
-- the base image:
--
--   * auth.jwt()  does not exist at all -> 4 of 9 migrations fail to apply.
--   * auth.uid()  ships a legacy definition reading the singular GUC 'request.jwt.claim.sub', while
--                 the RLS tests set the modern 'request.jwt.claims' JSON -> auth.uid() returns NULL
--                 and every policy denies, silently failing the tests.
--
-- These are the definitions GoTrue installs in a real deployment.
--
-- =================================================================================================
-- ONE COPY, READ BY TWO CALLERS
--
-- .github/workflows/ci.yml (edge-function-auth-test) and scripts/test-db.mjs both apply this file.
-- It used to live inline in the workflow, where the local runner could not reach it -- and a fixture
-- that drifts from the one CI uses is worse than no local runner at all, because a suite would pass
-- here and fail there for a reason neither copy names.

CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

-- `auth.email()` has the SAME legacy shape as `auth.uid()` above -- it reads the singular
-- `request.jwt.claim.email` GUC and returns NULL for a session that set the modern claims JSON.
-- Hosted Supabase defines it as `auth.jwt() ->> 'email'`, which is what this restores.
--
-- Nothing in the schema calls it today: 0089 reads the claim through `auth.jwt()` precisely so a
-- stamp it depends on cannot vary with the image. It is fixed here anyway, because the next suite
-- to reach for the obvious helper would meet a NULL and have no reason to suspect the fixture.
CREATE OR REPLACE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )
$$;

-- `auth.identities` is GoTrue's, and there is no GoTrue here. The base image ships auth.users and
-- not this table, so the chain aborted at archived migration 0042 with `relation "auth.identities"
-- does not exist` -- taking every migration after it, and every suite, with it.
--
-- NOT AN OPTIONAL DETAIL OF THE FIXTURE. An identity row is GoTrue's record of a SIGN-IN METHOD,
-- and this schema uses "has no identity row" as its definition of a machine principal: 0042 refuses
-- to list a would-be service principal holding one, and 0048 builds is_machine_principal() on the
-- same test. A stand-in omitting it makes both assertions vacuous rather than absent, which is
-- worse -- they would go on reporting success.
--
-- Empty is the correct state: the suites seed their own auth.users rows and none of them is meant
-- to be a person. Columns are the subset the chain reads, plus a primary key, because a table
-- without one invites a fixture that inserts the same identity twice and still passes.
CREATE TABLE IF NOT EXISTS auth.identities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL,
  provider      text NOT NULL DEFAULT 'email',
  provider_id   text NOT NULL DEFAULT '',
  identity_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

-- The migrations apply as postgres, which is an ordinary role in this image and holds nothing on a
-- table supabase_admin has just created. 0042's and 0048's self-checks read it, so without SELECT
-- the chain fails one error later than it used to.
--
-- INSERT AS WELL, because this table stands in for GoTrue and the suites have to be able to do
-- GoTrue's job. `test_audit_trail_guard.py` seeds a person -- email, password AND an identity
-- row, which is 0048's three-part definition of not-a-machine -- so a read-only grant fails it with
-- `permission denied for table identities`, one step past where the missing table used to stop it.
GRANT SELECT, INSERT ON auth.identities TO postgres;

-- The base image's auth.users predates columns GoTrue has, and ensure_first_administrator() (0163)
-- writes them, as seed.sql does. Added with GoTrue's types; IF NOT EXISTS leaves an image that
-- already has them untouched.
ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS email_confirmed_at         timestamptz,
  ADD COLUMN IF NOT EXISTS is_sso_user                boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS email_change               varchar(255),
  ADD COLUMN IF NOT EXISTS email_change_token_new     varchar(255),
  ADD COLUMN IF NOT EXISTS email_change_token_current varchar(255) DEFAULT '',
  ADD COLUMN IF NOT EXISTS phone_change               text DEFAULT '',
  ADD COLUMN IF NOT EXISTS phone_change_token         varchar(255) DEFAULT '',
  ADD COLUMN IF NOT EXISTS reauthentication_token     varchar(255) DEFAULT '';
