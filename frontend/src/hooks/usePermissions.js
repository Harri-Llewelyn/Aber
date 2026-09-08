import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';
import { PERMISSION_UUIDS } from '../constants';

/**
 * The static fallback, used when a session carries a role claim but no `role_permissions` rows
 * resolve. It MIRRORS the grants seeded in `0002_seed_data.sql`, and
 * `scripts/check-mirror-drift.mjs` compares the two -- a divergence here renders controls the
 * database then refuses, which reads as a bug in the control rather than in this map.
 *
 * SHOPFLOOR_MANAGER IS ENUMERATED RATHER THAN `Object.values(...)`, and that is the whole of the
 * change 0069 made on this side. Both privileged roles used to be spelled as every permission
 * there is, so the two names were decoration: a Manager could publish schemas, deploy to the edge
 * and manage access. The three it no longer holds are the platform half --
 *
 *     AUTHZ_MANAGE     who has access
 *     SCHEMA_MANAGE    what contract ingestion validates against
 *     GITOPS_MANAGE    what gets deployed to the edge
 *
 * -- and each is enforced somewhere real rather than here: SCHEMA_MANAGE by the write policies on
 * `schemas`, `metric_catalog` and `metric_groups` (0069), GITOPS_MANAGE by `ALLOWED_ROLES` in
 * `supabase/functions/deploy-nodered/index.ts`. This map decides what is OFFERED. Hiding a control
 * has never been an access control in this repository and is not one now.
 *
 * Administrator stays `Object.values(...)` deliberately: it holds every permission by definition,
 * so spelling it out would create a second list to forget when a permission is added.
 */
const DEFAULT_ROLE_PERMISSIONS_MAP = {
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
    PERMISSION_UUIDS.DIGITAL_THREAD_READ,
    PERMISSION_UUIDS.PROPOSAL_CREATE
  ],
  Operator: [
    PERMISSION_UUIDS.TELEMETRY_READ,
    PERMISSION_UUIDS.QUARANTINE_VIEW,
    PERMISSION_UUIDS.PROPOSAL_CREATE
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
