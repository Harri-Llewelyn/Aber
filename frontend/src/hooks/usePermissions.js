import { useState, useEffect, useCallback } from 'react';
import { PERMISSION_UUIDS } from '../constants';

const ROLE_PERMISSIONS_MAP = {
  Administrator: Object.values(PERMISSION_UUIDS),
  Shopfloor_Manager: Object.values(PERMISSION_UUIDS),
  Operator: [
    PERMISSION_UUIDS.TELEMETRY_READ,
    PERMISSION_UUIDS.QUARANTINE_VIEW
  ],
  Auditor: [
    PERMISSION_UUIDS.TELEMETRY_READ,
    PERMISSION_UUIDS.QUARANTINE_VIEW
  ]
};

/**
 * Custom hook to fetch user role & permissions from Supabase Auth session
 * @param {Object} session - Supabase auth session object
 * @param {Function} showToast - Toast notification function
 */
export function usePermissions(session, showToast) {
  const [userRole, setUserRole] = useState(null);
  const [userPerms, setUserPerms] = useState([]);
  const [loadingPerms, setLoadingPerms] = useState(false);

  useEffect(() => {
    if (session?.user) {
      const role = session.user.app_metadata?.role || session.user.user_metadata?.role || null;
      setUserRole(role);
      if (role && ROLE_PERMISSIONS_MAP[role]) {
        setUserPerms(ROLE_PERMISSIONS_MAP[role]);
      } else {
        setUserPerms([]);
      }
    } else {
      setUserRole(null);
      setUserPerms([]);
    }
  }, [session]);

  const hasPermission = useCallback((uuid) => {
    if (!uuid) return false;
    return userPerms.includes(uuid);
  }, [userPerms]);

  return {
    userRole,
    userPerms,
    loadingPerms,
    errorPerms: null,
    hasPermission
  };
}
