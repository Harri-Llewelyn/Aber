import { compare, lastDefinition, need, problems, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 178. The figures the Audit Trail reads off a page are the figures audit_trail_page() gives (0339).
// api.js reads each by its wire name (`payload.total_matching`), and a name the function does not
// build reads as undefined, which the page takes for "the server did not say": the foot would drop
// "for 57 entities" without a word. So the top-level keys of the function's answer and the fields
// api.js reads off it are one list.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const sql = lastDefinition('CREATE OR REPLACE FUNCTION public.audit_trail_page(', '$_$;', 'audit_trail_page()');
  const api = read('frontend/src/api.js');
  const branch = need(api, /if \(path\.includes\('\/audit-trail'\)\) \{([\s\S]*?)\n {4}\}\n/, "api.js's /audit-trail branch");
  if (!sql || !branch) return;

  // The answer's own keys stand six spaces in, at the head of a line; those of the rows and the counts
  // stand deeper.
  const fromSql = [...sql.body.matchAll(/^ {6}'([a-z_]+)',/gm)].map((m) => m[1]).sort();
  const fromJs = [...new Set([...branch[1].matchAll(/payload\.([a-z_]+)/g)].map((m) => m[1]))].sort();
  if (fromSql.length < 6) {
    problems.push(`auditTrailPage: ${fromSql.length} keys read from ${sql.file}, so this check is no longer checking anything`);
    return;
  }
  compare('auditTrailPage', `the figures api.js reads off a page and the keys ${sql.file} gives`, fromJs.join(', '), fromSql.join(', '));
}
