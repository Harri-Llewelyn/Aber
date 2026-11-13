import { compare, lastDefinition, need, read } from './lib.mjs';

// 53. Who may schedule, change and end a suppression window (0240). A drawer offers its acts by
// SUPPRESSION_WINDOW_ROLES; each of the three writers decides by has_role(). A role the drawer
// offers and a writer refuses meets an error on every click; one it leaves out never sees them.
export default function check() {
  const jsRoles = need(read('frontend/src/utils/alertSuppression.js'),
    /export const SUPPRESSION_WINDOW_ROLES = \[([^\]]*)\]/, 'SUPPRESSION_WINDOW_ROLES in utils/alertSuppression.js');
  const roles = (list) => [...list.matchAll(/'([A-Za-z_]+)'/g)].map((m) => m[1]).sort().join(', ');
  for (const name of ['schedule_alert_suppression_window', 'change_alert_suppression_window', 'end_alert_suppression_window']) {
    const fn = lastDefinition(`CREATE OR REPLACE FUNCTION public.${name}(`, '$$;', `${name}()`);
    const sql = fn && need(fn.body, /NOT public\.has_role\(ARRAY\[([^\]]*)\]\) THEN/, `${name}()'s roles (${fn.file})`);
    if (jsRoles && sql) compare('suppressionWindowRoles', `the roles ${name}() admits and the drawers offer`, roles(jsRoles[1]), roles(sql[1]));
  }
}
