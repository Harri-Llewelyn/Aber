import { compare, lastDefinition, need, read } from './lib.mjs';

// 90. Who may export readings (0279). Export CSV is on or greyed by TELEMETRY_EXPORT_ROLES;
// export_telemetry() decides by has_role(). A role the dashboard offers and the function refuses
// meets an error on every click; one it leaves out never sees a button the function would allow.
export default function check() {
  const jsRoles = need(read('frontend/src/utils/telemetryExport.js'),
    /export const TELEMETRY_EXPORT_ROLES = \[([^\]]*)\]/, 'TELEMETRY_EXPORT_ROLES in utils/telemetryExport.js');
  const roles = (list) => [...list.matchAll(/'([A-Za-z_]+)'/g)].map((m) => m[1]).sort().join(', ');
  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.export_telemetry(', '$fn$;', 'export_telemetry()');
  const sql = fn && need(fn.body, /NOT public\.has_role\(ARRAY\[([^\]]*)\]\) THEN/, `export_telemetry()'s roles (${fn.file})`);
  if (jsRoles && sql) compare('exportRoles', `the roles export_telemetry() (${fn.file}) admits and the dashboard offers Export CSV to`, roles(jsRoles[1]), roles(sql[1]));
}
