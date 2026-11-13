import { compare, lastDefinition, need, read, SCHEMA } from './lib.mjs';

// 44. The Audit Trail's classes, by name. audit_event_class() (0228) answers one of them, each has
// its partial index, the dashboard lists them in AUDIT_TRAIL_CLASSES (the address's `?class=` words
// and the legend's order) and draws one marker per class (MARKERS). A class the function answers
// and the dashboard lacks draws no marker of its own; one with no index is read row by row.
export default function check() {
  const def = lastDefinition('CREATE OR REPLACE FUNCTION public.audit_event_class(', '$$;', 'audit_event_class()');
  const constants = need(read('frontend/src/constants.js'), /export const AUDIT_TRAIL_CLASSES = \[([^\]]*)\]/,
    'AUDIT_TRAIL_CLASSES in frontend/src/constants.js');
  const tab = need(read('frontend/src/components/tabs/AuditTrailTab.jsx'), /export const MARKERS = \{([\s\S]*?)\n\}/,
    'MARKERS in frontend/src/components/tabs/AuditTrailTab.jsx');
  if (def && constants && tab) {
    const answered = [...new Set([...def.body.matchAll(/THEN '([a-z]+)'|ELSE '([a-z]+)'/g)].map((m) => m[1] || m[2]))].sort();
    const indexed = [...SCHEMA.matchAll(/CREATE INDEX IF NOT EXISTS idx_audit_trail_class_([a-z]+) ON public\.audit_trail[^;]*= '([a-z]+)';/g)]
      .filter((m) => m[1] === m[2]).map((m) => m[1]).sort();
    const listed = [...constants[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    compare('auditTrailClasses', `the classes audit_event_class() answers (${def.file}) and AUDIT_TRAIL_CLASSES`,
      [...listed].sort().join(', '), answered.join(', '));
    compare('auditTrailClasses', 'the classes with an index of their own and AUDIT_TRAIL_CLASSES',
      [...listed].sort().join(', '), indexed.join(', '));
    const drawn = [...tab[1].matchAll(/^ {2}([a-z]+):/gm)].map((m) => m[1]);
    compare('auditTrailClasses', "MARKERS' classes, in order, and AUDIT_TRAIL_CLASSES",
      drawn.join(', '), listed.join(', '));
  }
}
