-- =============================================================================================
-- 0042_list_service_principals.sql
--
-- The read behind the Access Control page's Service Identities section: which NON-HUMAN accounts
-- can reach this stack, and what each of them holds. See Machine Identities in supabase/README.md.
--
-- ---------------------------------------------------------------------------------------------
-- WHY AN RPC AT ALL, WHEN THE PAGE ALREADY READS `gateway_status` DIRECTLY
--
-- Because neither table this needs is reachable from a browser, and both are unreachable ON
-- PURPOSE:
--
--   * `auth.users` is GoTrue's, not ours. PostgREST serves the `public` schema; nothing in `auth`
--     is exposed, and exposing it to answer a page's question would publish the whole user table
--     including every column GoTrue keeps there -- password hashes, recovery tokens, confirmation
--     tokens -- to whatever RLS policy was written that afternoon.
--   * `public.user_roles` is in `check-docs-drift.mjs`'s NOT_PUBLISHED list, with the reason:
--     "RBAC internals -- read server-side by the two userinfo functions, never by a client."
--
-- So the alternative to a narrow function is a broad grant on the two tables that decide who is
-- who. This returns four columns and no secret.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT COUNTS AS A SERVICE PRINCIPAL, AND WHY IT IS INFERRED RATHER THAN FLAGGED
--
-- `0034` describes the one that exists: "The row is deliberately minimal: no email, no password,
-- no identity provider. THIS ACCOUNT CANNOT SIGN IN. It exists so that a subject in a JWT resolves
-- to something real."
--
-- That IS the definition, so it is the predicate: no email and no password means no way to
-- authenticate through GoTrue, which means the only thing that can present this identity is a JWT
-- signed outside it -- `scripts/mint-mcp-token.mjs` and whatever follows it.
--
-- A `is_service` COLUMN WAS CONSIDERED AND REJECTED. `auth.users` belongs to GoTrue: a column added
-- there is a column an image upgrade may drop, and one that a future GoTrue migration has no reason
-- to preserve. Worse, it would be a SECOND source of truth for a fact the row already states --
-- and the failure mode is a human account flagged as a service, or a service account that can
-- suddenly sign in because someone set a password and nobody updated the flag.
--
-- THE PREDICATE IS THEREFORE THE SECURITY-RELEVANT ONE. "Cannot sign in" is what makes an account
-- safe to list here; "is labelled a service" would not be.
--
-- ---------------------------------------------------------------------------------------------
-- WHAT IT DELIBERATELY DOES NOT RETURN
--
--   * No email, because by definition there is none -- and returning the column would invite the
--     page to render an empty cell that looks like missing data rather than like the point.
--   * NO TOKEN, and nothing derived from one. Tokens are signed outside the database with the JWT
--     secret and are never stored; there is nothing here to leak and this function must not become
--     the place that changes.
--   * No `last_sign_in_at`. It is NULL for every row this returns, by construction.
-- =============================================================================================

SET search_path TO public;

CREATE OR REPLACE FUNCTION public.list_service_principals()
RETURNS TABLE (
  principal_id uuid,
  roles        text[],
  created_at   timestamptz,
  can_sign_in  boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- ADMINISTRATOR ONLY, and narrower than the page's other reads on purpose. A gateway's
  -- credential state is operational -- a Shopfloor_Manager acts on it. The list of machine
  -- identities that can reach the stack is an access-control question, and `authz:manage` is
  -- granted to Administrator alone.
  IF NOT public.has_role(ARRAY['Administrator']) THEN
    RAISE EXCEPTION 'insufficient privileges to list service principals'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT u.id,
         coalesce(array_agg(r.name ORDER BY r.name) FILTER (WHERE r.name IS NOT NULL), '{}'::text[]),
         u.created_at,
         -- RETURNED RATHER THAN ASSUMED, even though the WHERE clause makes it false for every row.
         -- It is the property that makes listing these safe, and a page that states it is a page
         -- whose claim can be checked. If this ever comes back true, the predicate below has
         -- stopped meaning what its name says.
         false
    FROM auth.users u
    LEFT JOIN public.user_roles ur ON ur.user_id = u.id::text
    LEFT JOIN public.roles r ON r.id = ur.role_id
   WHERE u.email IS NULL
     AND (u.encrypted_password IS NULL OR u.encrypted_password = '')
   GROUP BY u.id, u.created_at
   ORDER BY u.created_at;
END;
$$;

COMMENT ON FUNCTION public.list_service_principals() IS
  'Machine identities that can reach this stack: auth.users rows with no email and no password, '
  'which cannot sign in through GoTrue and are presented only by a JWT signed outside it. '
  'Administrator only. Returns no email, no token and nothing derived from one.';

REVOKE ALL ON FUNCTION public.list_service_principals() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_service_principals() TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_service_principals() TO service_role;


-- ---------------------------------------------------------------------------------------------
-- Self-check
-- ---------------------------------------------------------------------------------------------
-- THE PROPERTY WORTH ASSERTING IS THAT NO HUMAN ACCOUNT IS IN THE RESULT, which is 0034's own test
-- pointed the other way: that migration asserts what its principal CANNOT do, and this asserts
-- that the list of such principals cannot quietly grow to include somebody's login.
--
-- The failure it guards against is specific and would be silent: a demo persona seeded without an
-- email, or a GoTrue upgrade that stops populating `email` for some sign-in method, would put a
-- real user on a page captioned "these cannot sign in" -- and an Administrator reading it would
-- conclude a person's account was a machine's.
DO $selfcheck$
DECLARE
  v_leaked text;
BEGIN
  SELECT string_agg(u.id::text, ', ') INTO v_leaked
    FROM auth.users u
   WHERE u.email IS NULL
     AND (u.encrypted_password IS NULL OR u.encrypted_password = '')
     -- An identity row is GoTrue's record of a sign-in METHOD -- password, OAuth provider, magic
     -- link. A row with one is reachable by a person however empty its columns look.
     AND EXISTS (SELECT 1 FROM auth.identities i WHERE i.user_id = u.id);

  IF v_leaked IS NOT NULL THEN
    RAISE EXCEPTION
      '0042 self-check: %  would be listed as service principal(s) but hold an auth.identities row, '
      'so they CAN sign in. The predicate no longer means "cannot authenticate".', v_leaked;
  END IF;

  RAISE NOTICE '0042 self-check passed: every account the predicate selects is unreachable by a person.';
END;
$selfcheck$;

NOTIFY pgrst, 'reload schema';
