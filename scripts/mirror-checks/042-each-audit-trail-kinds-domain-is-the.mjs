import { compare, lastDefinition, need, problems, read } from './lib.mjs';

// 42. Each Audit Trail kind's domain is the one audit_domain_for() files its rows under. The
// Entity filter's Security group is AUDIT_TRAIL_ENTITY_TYPES' security domain, offered only to the
// roles audit_trail_select_security admits. A kind filed asset in the database and security here is
// hidden from a Shopfloor Manager who can read its rows; one filed security there and asset here is
// offered to a role that only ever reads "no events". audit_domain_for() names the asset tables and
// files everything else under security, its fail-closed default.
export default function check() {
  const def = lastDefinition('CREATE OR REPLACE FUNCTION public.audit_domain_for(', '$$;', 'audit_domain_for()');
  const js = need(read('frontend/src/constants.js'), /export const AUDIT_TRAIL_ENTITY_TYPES = \[([\s\S]*?)\n\];/,
    'AUDIT_TRAIL_ENTITY_TYPES in frontend/src/constants.js');
  if (def && js) {
    const asset = need(def.body, /WHEN p_entity_type IN \(([^)]*)\)\s*THEN 'asset'/,
      `the asset tables audit_domain_for() names (${def.file})`);
    const kinds = [...js[1].matchAll(/table: '([a-z_]+)',[^}]*domain: '(asset|security)'/g)].map((m) => [m[1], m[2]]);
    if (asset && kinds.length === 0) {
      problems.push('auditTrailDomains: found no kind in AUDIT_TRAIL_ENTITY_TYPES -- its shape changed, so this check is no longer checking anything');
    } else if (asset) {
      const assetTables = new Set([...asset[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
      const sqlDomain = (table) => (assetTables.has(table) ? 'asset' : 'security');
      compare('auditTrailDomains', `the domain of each of the ${kinds.length} kinds the Audit Trail filters by`,
        kinds.map(([table, domain]) => `${table}:${domain}`).join(', '),
        kinds.map(([table]) => `${table}:${sqlDomain(table)}`).join(', '));
    }
  }
}
