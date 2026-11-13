import { compare, lastDefinition, need, read } from './lib.mjs';

// 85. Who may write automations, in the dashboard and in the three writers (0256). The page greys
// Save, Upload, New Automation, Delete and the switch for any other role; a list the writers do not
// share is a button that offers an act the database refuses, or withholds one it would allow.
export default function check() {
  const roles = need(read('frontend/src/utils/automations.js'), /export const AUTOMATION_WRITE_ROLES = \[([^\]]*)\]/,
    'AUTOMATION_WRITE_ROLES in utils/automations.js');
  const words = (list) => [...list.matchAll(/'([A-Za-z_]+)'/g)].map((m) => m[1]).join(', ');
  for (const name of ['apply_automations', 'set_automation_enabled', 'delete_automation']) {
    const fn = lastDefinition(`CREATE OR REPLACE FUNCTION public.${name}(`, '$$;', `${name}()`);
    const sql = fn && need(fn.body, /has_role\(ARRAY\[([^\]]*)\]\)/, `${name}()'s has_role() list (${fn.file})`);
    if (roles && sql) {
      compare('automationsWriters', `the roles the page offers its write controls to and ${name}() admits (${fn.file})`,
        words(roles[1]), words(sql[1]));
    }
  }
}
