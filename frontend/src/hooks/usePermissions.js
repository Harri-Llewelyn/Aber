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
 * @param {Function} showToast - Toast notification function
 */
export function usePermissions(session, showToast) {
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
        const { data, error } = await supabase
          .from('user_roles')
          .select('role_id, roles(name), role_permissions(permission_id, permissions(id, name))')
          .eq('user_id', session.user.id);

        if (!error && data && data.length > 0) {
          const userRoleRecord = data[0];
          if (userRoleRecord.roles?.name) {
            resolvedRole = userRoleRecord.roles.name;
          }
          if (Array.isArray(userRoleRecord.role_permissions)) {
            permUuids = userRoleRecord.role_permissions
              .map(rp => rp.permission_id || rp.permissions?.id)
              .filter(Boolean);
          }
        } else if (error) {
          console.warn('[usePermissions] DB user_roles query error:', error.message);
        }
      } catch (err) {
        console.warn('[usePermissions] DB user_roles query exception:', err.message);
      }

      // Fallback: If DB permissions query returned no rows but appRole is known
      if (permUuids.length === 0 && appRole && DEFAULT_ROLE_PERMISSIONS_MAP[appRole]) {
        console.warn(`[usePermissions] DB user_roles query returned zero rows for user ${session.user.id}; static permission fallback in use for role '${appRole}'.`);
        if (typeof showToast === 'function') {
          showToast('warning', `DB user_roles query empty; static permission fallback in use for role '${appRole}'`);
        }
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
  }, [session]);

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
