-- Migration: 20260101000008_handle_new_user.sql
-- Description: Give self-registered users (Portal "Sign Up") a working default role.
--
-- Without this, a user created through GoTrue signup has no public.user_roles row and
-- no app_metadata.role, so usePermissions.js resolves no role and no permission UUIDs
-- and the account lands on an empty dashboard. Seeded personas are unaffected: the
-- trigger only fires for rows it did not already find a role mapping for.
--
-- Both writes are required by the frontend:
--   * public.user_roles          -> drives resolvedRole via the roles(name) join
--   * raw_app_meta_data.role     -> drives the DEFAULT_ROLE_PERMISSIONS_MAP fallback,
--                                   which is what actually supplies permission UUIDs
-- public.custom_access_token_hook (migration 000007) then mirrors the role into the JWT
-- on every token issue and refresh.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  default_role_id   INT;
  default_role_name CONSTANT TEXT := 'Operator';
BEGIN
  -- Respect a role the caller already declared. GoTrue signup supplies only
  -- {"provider":"email","providers":["email"]}, whereas seed.sql personas and
  -- admin-provisioned users carry an explicit role. Without this guard the trigger
  -- fires while seed.sql is inserting auth.users -- before its user_roles INSERT has
  -- run -- and every persona ends up with a spurious second 'Operator' mapping.
  IF COALESCE(NEW.raw_app_meta_data, '{}'::jsonb) ->> 'role' IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT id INTO default_role_id
  FROM public.roles
  WHERE name = default_role_name;

  -- RBAC roles are seeded by 20260101000003. If they are missing the database is
  -- half-provisioned; leave the user alone rather than aborting GoTrue's signup.
  IF default_role_id IS NULL THEN
    RAISE WARNING 'handle_new_user: role % not found; leaving user % unassigned',
      default_role_name, NEW.id;
    RETURN NEW;
  END IF;

  -- Never override an explicit mapping (e.g. the seeded personas).
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = NEW.id::text) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.user_roles (user_id, role_id)
  VALUES (NEW.id::text, default_role_id)
  ON CONFLICT (user_id, role_id) DO NOTHING;

  UPDATE auth.users
  SET raw_app_meta_data =
        jsonb_set(
          COALESCE(raw_app_meta_data, '{}'::jsonb),
          '{role}',
          to_jsonb(default_role_name),
          true
        )
  WHERE id = NEW.id;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;

-- AFTER INSERT so the auth.users row is already visible to the UPDATE above.
DROP TRIGGER IF EXISTS trg_handle_new_user ON auth.users;
CREATE TRIGGER trg_handle_new_user
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
