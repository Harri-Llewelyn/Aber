import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';
import { PERMISSION_UUIDS } from '../constants';

const DEFAULT_ROLE_PERMISSIONS_MAP = {
  Administrator: Object.values(PERMISSION_UUIDS),
  Shopfloor_Manager: Object.values(PERMISSION_UUIDS),
  Operator: [
    PERMISSION_UUIDS.TELEMETRY_READ,
    PERMISSION_UUIDS.QUARANTINE_VIEW
  ],
  Auditor: [
    PERMISSION_UUIDS.DIGITAL_THREAD_READ
  ]
};

/**
 * Custom hook to fetch user role & permissions from Supabase DB tables & Auth session
 * @param {Object} session - Supabase auth session object
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
        // role_permissions hangs off `roles`, not off `user_roles` -- both reference
        // roles, but there is no FK between them. Embedding it directly under
        // user_roles made PostgREST reject the whole query (PGRST200), so the DB
        // permissions were never read and the static map below always won.
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

      // Fallback for a user whose role is known from the JWT but has no rows in
      // role_permissions. Logged, not toasted: it is not actionable by the operator,
      // and the toast fired on every token refresh.
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
    // Keyed on identity rather than the session object: supabase-js hands back a new
    // session on every token refresh and tab focus, which re-ran this query (and, when
    // it toasted, popped a notification) every hour for no change in permissions.
  }, [session?.user?.id, session?.user?.app_metadata?.role]);

  const hasPermission = useCallback((uuid) => {
    if (loadingPerms || !uuid) return false;
    return userPerms.includes(uuid);
  }, [userPerms, loadingPerms]);

  return {
    userRole,
    userPerms,
    loadingPerms,
    errorPerms: null,
    hasPermission
  };
}
