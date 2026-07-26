import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';

/**
 * Custom hook to fetch user role & permissions from Supabase Auth session
 * @param {Object} session - Supabase auth session object
 * @param {Function} showToast - Toast notification function
 */
export function usePermissions(session, showToast) {
  const [userRole, setUserRole] = useState(null);
  const [loadingPerms, setLoadingPerms] = useState(false);

  useEffect(() => {
    if (session?.user) {
      const role = session.user.app_metadata?.role || session.user.user_metadata?.role || null;
      setUserRole(role);
    } else {
      setUserRole(null);
    }
  }, [session]);

  const hasPermission = useCallback((uuid) => {
    // In Supabase RLS mode, Administrator and Shopfloor_Manager have write permissions.
    // Allow management permissions for Administrator and Shopfloor_Manager.
    if (['Administrator', 'Shopfloor_Manager'].includes(userRole)) {
      return true;
    }
    return false;
  }, [userRole]);

  return {
    userRole,
    userPerms: [],
    loadingPerms,
    errorPerms: null,
    hasPermission
  };
}
