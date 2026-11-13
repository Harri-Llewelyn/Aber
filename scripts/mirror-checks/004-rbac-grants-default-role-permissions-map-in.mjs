import { compare, ok, problems, read, SCHEMA } from './lib.mjs';

// 4. RBAC grants. `DEFAULT_ROLE_PERMISSIONS_MAP` in usePermissions.js is the static fallback the
// dashboard renders from when no `role_permissions` rows resolve, so a divergence offers controls
// the database refuses, or hides a capability. The SQL side is replayed, not read from one file:
// the seed grants and a later migration withdraws.
export default function check() {
  const constants = read('frontend/src/constants.js');
  const hook = read('frontend/src/hooks/usePermissions.js');

  /** A named block's body, bounded by the first `};` after its declaration. */
  const block = (source, declaration, what) => {
    const at = source.indexOf(declaration);
    if (at < 0) {
      problems.push(`rbacGrants: could not find ${what} -- the file's shape changed, so this check is no longer checking anything`);
      return null;
    }
    const stop = source.indexOf('};', at);
    return source.slice(at, stop < 0 ? undefined : stop);
  };

  const permBlock = block(constants, 'export const PERMISSION_UUIDS = {', 'PERMISSION_UUIDS in constants.js');
  const mapBlock = block(hook, 'const DEFAULT_ROLE_PERMISSIONS_MAP = {', 'DEFAULT_ROLE_PERMISSIONS_MAP in usePermissions.js');

  if (permBlock && mapBlock) {
    // KEY -> uuid, so a disagreement can be reported by the name a reader recognises. Bounded to
    // the PERMISSION_UUIDS block: constants.js carries other uuid-shaped literals.
    const uuidByKey = new Map([...permBlock.matchAll(/(\w+):\s*'([0-9a-f-]{36})'/g)].map((m) => [m[1], m[2]]));
    const keyByUuid = new Map([...uuidByKey].map(([k, v]) => [v, k]));
    const everyPermission = [...uuidByKey.values()];

    // Each role's entry is either the whole set or an explicit list. `Object.values(...)` is
    // Administrator's spelling: it holds every permission by definition.
    const jsGrants = new Map();
    for (const m of mapBlock.matchAll(/(\w+):\s*(Object\.values\(PERMISSION_UUIDS\)|\[[^\]]*\])/g)) {
      const [, role, value] = m;
      const uuids = value.startsWith('Object.values')
        ? everyPermission
        : [...value.matchAll(/PERMISSION_UUIDS\.(\w+)/g)].map((p) => uuidByKey.get(p[1]));
      if (uuids.some((u) => u === undefined)) {
        problems.push(`rbacGrants: ${role} names a PERMISSION_UUIDS key that constants.js does not declare`);
        continue;
      }
      jsGrants.set(role, new Set(uuids));
    }

    const roleNameById = new Map(
      [...SCHEMA.matchAll(/INSERT INTO public\.roles VALUES \((\d+), '(\w+)'/g)].map((m) => [m[1], m[2]])
    );

    const sqlGrants = new Map([...roleNameById.values()].map((name) => [name, new Set()]));
    for (const m of SCHEMA.matchAll(/INSERT INTO public\.role_permissions VALUES \((\d+), '([0-9a-f-]{36})'\)/g)) {
      const role = roleNameById.get(m[1]);
      if (role) sqlGrants.get(role).add(m[2]);
    }

    // The withdrawals, and the parser refuses to guess: only the `role_id = N AND permission_id IN
    // (...)` shape is understood, so a DELETE written another way fails rather than being counted
    // and not applied.
    const deleteStatements = [...SCHEMA.matchAll(/DELETE FROM public\.role_permissions/g)].length;
    const parsedDeletes = [...SCHEMA.matchAll(
      /DELETE FROM public\.role_permissions\s+WHERE role_id = (\d+)\s+AND permission_id IN \(([^;]*?)\);/g
    )];
    if (parsedDeletes.length !== deleteStatements) {
      problems.push(
        `rbacGrants: the chain has ${deleteStatements} DELETE(s) from role_permissions and this check ` +
          `understands ${parsedDeletes.length} of them. Teach it the new shape -- an unparsed withdrawal ` +
          `makes the SQL side look more generous than the database is.`
      );
    }
    for (const m of parsedDeletes) {
      const role = roleNameById.get(m[1]);
      if (!role) continue;
      for (const u of m[2].matchAll(/'([0-9a-f-]{36})'/g)) sqlGrants.get(role).delete(u[1]);
    }

    const named = (set) => [...set].map((u) => keyByUuid.get(u) || u).sort().join(',');
    for (const [role, jsSet] of jsGrants) {
      const sqlSet = sqlGrants.get(role);
      if (!sqlSet) {
        problems.push(`rbacGrants: usePermissions.js has a fallback for '${role}', which public.roles does not seed`);
        continue;
      }
      compare('rbacGrants', `${role}'s permissions`, named(jsSet), named(sqlSet));
    }

    // The other direction: a role seeded with grants and missing from the map falls through to no
    // permissions when the embed comes back empty.
    const unmapped = [...sqlGrants].filter(([role, set]) => set.size > 0 && !jsGrants.has(role)).map(([role]) => role);
    if (unmapped.length) {
      problems.push(
        `rbacGrants: ${unmapped.join(', ')} hold(s) seeded permissions with no entry in ` +
          `DEFAULT_ROLE_PERMISSIONS_MAP, so the fallback renders an empty dashboard for that role`
      );
    } else {
      ok.push(`rbacGrants: every seeded role has a fallback entry (${jsGrants.size} roles)`);
    }
  }
}
