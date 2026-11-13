import { compare, lastDefinition, MIGRATION_DIR, problems, read } from './lib.mjs';

// 30. Aber's own apps. 0002 registers each OAuth client the stack uses under a pinned id on every
// boot, and stack_app_ids() is the list remove_app() refuses and the Apps tab marks Part of Aber.
// An id seeded and not listed can be removed, and comes back at the next boot; an id listed and not
// seeded marks an app the stack does not register.
export default function check() {
  const seed = read(`${MIGRATION_DIR}/0002_seed_data.sql`);
  const seeded = [...seed.matchAll(/v_client_id CONSTANT UUID := '([0-9a-f-]{36})'/g)].map((m) => m[1]).sort();
  const ids = lastDefinition('CREATE OR REPLACE FUNCTION public.stack_app_ids()', '$$;', 'stack_app_ids() in the applied chain');
  const listed = ids ? [...ids.body.matchAll(/'([0-9a-f-]{36})'/g)].map((m) => m[1]).sort() : null;
  if (seeded.length === 0) {
    problems.push('stackApps: found no pinned OAuth client id in 0002_seed_data.sql -- the shape changed, so this check is no longer checking anything');
  } else if (listed) {
    compare('stackApps', `the apps 0002 seeds and stack_app_ids() (${ids.file}) lists`, seeded.join(', '), listed.join(', '));
  }
}
