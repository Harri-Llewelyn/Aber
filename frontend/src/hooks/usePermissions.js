import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';
import { PERMISSION_UUIDS } from '../constants';

/**
 * The static fallback, used when a session carries a role claim but no `role_permissions` rows
 * resolve. It mirrors the grants seeded in `0002_seed_data.sql`; `scripts/check-mirror-drift.mjs`
 * compares the two. Shopfloor_Manager is enumerated because it does not hold the platform
 * permissions (AUTHZ_MANAGE, SCHEMA_MANAGE); Administrator holds every permission by
 * definition. This map decides what is offered, and each permission is enforced server-side.
 */
export const DEFAULT_ROLE_PERMISSIONS_MAP = {
  Administrator: Object.values(PERMISSION_UUIDS),
  Shopfloor_Manager: [
    PERMISSION_UUIDS.QUARANTINE_VIEW,
    PERMISSION_UUIDS.QUARANTINE_APPROVE,
    PERMISSION_UUIDS.QUARANTINE_REJECT,
    PERMISSION_UUIDS.DEVICE_MANAGE,
    PERMISSION_UUIDS.CELL_MANAGE,
    PERMISSION_UUIDS.GATEWAY_MANAGE,
    PERMISSION_UUIDS.TELEMETRY_READ,
    PERMISSION_UUIDS.ARCHIVE_MANAGE,
    PERMISSION_UUIDS.LINK_MANAGE,
    PERMISSION_UUIDS.AUDIT_TRAIL_READ,
    PERMISSION_UUIDS.PROPOSAL_CREATE
  ],
  Operator: [
    PERMISSION_UUIDS.TELEMETRY_READ,
    PERMISSION_UUIDS.QUARANTINE_VIEW,
    PERMISSION_UUIDS.PROPOSAL_CREATE
  ],
  Auditor: [
    PERMISSION_UUIDS.AUDIT_TRAIL_READ
  ]
};

/** The roles, in the map's order, whose seeded grants include `permission`, as people read them. */
export function rolesHolding(permission) {
  return Object.entries(DEFAULT_ROLE_PERMISSIONS_MAP)
    .filter(([, perms]) => perms.includes(permission))
    .map(([role]) => role.replace(/_/g, ' '))
}

/**
 * The hover text of a control this session may not use: "Requires Administrator or Shopfloor
 * Manager". Pass the PERMISSION_UUIDS value the control is gated on; the roles come from the
 * seeded grants above, so the text cannot drift from who can actually do it.
 */
export function requiresRolesTitle(permission) {
  const roles = rolesHolding(permission)
  if (roles.length === 0) return 'Your role cannot do this'
  const list = roles.length === 1
    ? roles[0]
    : `${roles.slice(0, -1).join(', ')} or ${roles[roles.length - 1]}`
  return `Requires ${list}`
}

/**
 * Fetch the user's role and permissions from the database and the auth session.
 *
 * @param {Object} session Supabase auth session object
 */
export function usePermissions(session) {
  const [userRole, setUserRole] = useState(null);
  const [userPerms, setUserPerms] = useState([]);
  const [loadingPerms, setLoadingPerms] = useState(!!session?.user);

  useEffect(() => {
    let isMounted = true;

    async function fetchPermissions() {
      if (!session?.user) {
        if (isMounted) {
          setUserRole(null);
          setUserPerms([]);
          setLoadingPerms(false);
        }
        return;
      }

      setLoadingPerms(true);
      const appRole = session.user.app_metadata?.role || null;
      let resolvedRole = appRole;
      let permUuids = [];

      try {
        // role_permissions hangs off `roles`, not `user_roles`: there is no FK between them, and
        // embedding it under user_roles makes PostgREST reject the query (PGRST200).
        const { data, error } = await supabase
          .from('user_roles')
          .select('role_id, roles(name, role_permissions(permission_id, permissions(id, name)))')
          .eq('user_id', session.user.id);

        if (error) {
          console.warn(
            '[usePermissions] user_roles query failed (%s %s): %s',
            error.code || 'no-code', error.hint || '', error.message
          );
        } else if (data && data.length > 0) {
          const userRoleRecord = data[0];
          if (userRoleRecord.roles?.name) {
            resolvedRole = userRoleRecord.roles.name;
          }
          const rolePermissions = userRoleRecord.roles?.role_permissions;
          if (Array.isArray(rolePermissions)) {
            permUuids = rolePermissions
              .map(rp => rp.permission_id || rp.permissions?.id)
              .filter(Boolean);
          }
        }
      } catch (err) {
        console.warn('[usePermissions] user_roles query exception:', err.message);
      }

      // Fallback for a user whose role is known from the JWT but has no rows in role_permissions.
      // Logged, not toasted: it is not actionable by the operator.
      if (permUuids.length === 0 && appRole && DEFAULT_ROLE_PERMISSIONS_MAP[appRole]) {
        console.warn(
          `[usePermissions] No role_permissions rows resolved for user ${session.user.id}; ` +
          `falling back to the built-in permission map for role '${appRole}'.`
        );
        permUuids = DEFAULT_ROLE_PERMISSIONS_MAP[appRole];
      }

      if (isMounted) {
        setUserRole(resolvedRole);
        setUserPerms(permUuids);
        setLoadingPerms(false);
      }
    }

    fetchPermissions();

    return () => {
      isMounted = false;
    };
    // Keyed on identity rather than the session object, which supabase-js replaces on every token
    // refresh and tab focus.
  }, [session?.user?.id, session?.user?.app_metadata?.role]);

  const hasPermission = useCallback((uuid) => {
    if (loadingPerms || !uuid) return false;
    return userPerms.includes(uuid);
  }, [userPerms, loadingPerms]);

  return {
    userRole,
    loadingPerms,
    hasPermission
  };
}
