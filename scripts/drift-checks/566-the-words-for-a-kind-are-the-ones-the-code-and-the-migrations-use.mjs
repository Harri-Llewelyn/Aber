import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 566. docs/architecture.md lists the words for a kind that the code and the migrations use, no more and no
// fewer. The Audit Trail's are the `table` of each AUDIT_TRAIL_ENTITY_TYPES entry, and the kinds of the
// last audit_trail_action_kinds(); the two agree or the trail has a kind nobody can filter. The other
// columns' words are in their CHECK constraints, read from the last migration that states each. `links`
// has no CHECK, so its words are what the dashboard opens EntityLinksModal with. A word no
// `CREATE TABLE public.<word>` makes is one a reader would look for, so its row has to say so.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems566 = [];
  const migrations = allFiles.filter((f) => /^supabase\/migrations\/\d{4}_[^/]*\.sql$/.test(f)).sort();
  const sorted = (words) => [...new Set(words)].sort();

  const doc = read('docs/architecture.md');
  const from = doc.indexOf('\n### `entity_type`: the word for a kind\n');
  const rest = from < 0 ? '' : doc.slice(from + 1);
  const end = rest.search(/\n(?:## |### |---\n)/);
  const section = rest.slice(0, end < 0 ? undefined : end);
  // The rows of the two tables, as their cells: the trail's words, then the other columns.
  const rows = section.split('\n').filter((l) => /^\| `/.test(l)).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
  const codes = (cell) => [...cell.matchAll(/`([a-z_.]+)`/g)].map((m) => m[1]);
  const trail = rows.filter(([first]) => !first.includes('.'));
  const columns = rows.filter(([first]) => first.includes('.'));
  if (!trail.length || !columns.length) {
    fail('check 566 read no word for a kind from docs/architecture.md, "`entity_type`: the word for a kind": the section or its tables have changed shape');
    return;
  }
  const documented = sorted(trail.flatMap(([first]) => codes(first)));

  const compare = (what, listed, used) => {
    if (!used.length) {
      problems566.push(`no word was read from ${what}; its shape has changed, so nothing was compared`);
      return;
    }
    const missing = used.filter((w) => !listed.includes(w));
    const extra = listed.filter((w) => !used.includes(w));
    if (missing.length) problems566.push(`docs/architecture.md lacks ${missing.join(', ')}, from ${what}`);
    if (extra.length) problems566.push(`docs/architecture.md lists ${extra.join(', ')}, which ${what} does not hold`);
  };

  const constants = read('frontend/src/constants.js');
  const types = constants.match(/export const AUDIT_TRAIL_ENTITY_TYPES = \[([\s\S]*?)\n\];/)?.[1] ?? '';
  const offered = sorted([...types.matchAll(/\btable: '([a-z_]+)'/g)].map((m) => m[1]));
  compare('AUDIT_TRAIL_ENTITY_TYPES in frontend/src/constants.js', documented, offered);

  const needle = 'CREATE OR REPLACE FUNCTION public.audit_trail_action_kinds(';
  const kindsFile = migrations.findLast((f) => read(f).includes(needle));
  const sql = kindsFile ? read(kindsFile) : '';
  const bodyAt = sql.lastIndexOf(needle);
  const body = bodyAt < 0 ? '' : sql.slice(bodyAt, sql.indexOf('\n$$;', bodyAt));
  const written = sorted([...body.matchAll(/\('[A-Z_]+',\s*ARRAY\[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((w) => w[1])));
  compare(`audit_trail_action_kinds() (${kindsFile ?? 'no migration'})`, documented, written);

  // Each word's table, or a row that says there is none of that name.
  const tables = new Set(migrations.flatMap((f) => [...read(f).matchAll(/^CREATE TABLE IF NOT EXISTS public\.(\w+)/gm)].map((m) => m[1])));
  for (const [first, about = ''] of trail) {
    const without = codes(first).filter((w) => !tables.has(w));
    if (without.length && !/\btable\b|\bNot a row\b/i.test(about)) {
      problems566.push(`docs/architecture.md does not say that ${without.join(', ')} is no table's name`);
    }
  }

  // The last CHECK of a constraint, as the words it admits.
  const CHECKS = {
    'change_proposals.entity_type': 'change_proposals_entity_type_known',
    'retired_entities.entity_type': 'retired_entities_type_known',
    'asset_exports.entity_type': 'asset_exports_type_known',
    'platform_alerts.entity_type': 'platform_alerts_entity_type_valid',
    'captures.subject_kind': 'captures_subject_kind_valid',
    'capture_jobs.subject_kind': 'capture_jobs_subject_kind_valid',
    'capture_uploads.subject_kind': 'capture_uploads_subject_kind_valid',
  };
  const admitted = (name) => {
    const head = `CONSTRAINT ${name} CHECK `;
    const file = migrations.findLast((f) => read(f).includes(head));
    if (!file) return [];
    const text = read(file);
    const at = text.lastIndexOf(head);
    return sorted([...text.slice(at, text.indexOf('\n', at)).matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]));
  };
  const links = sorted(allFiles.filter((f) => f.startsWith('frontend/src/components/') && f.endsWith('.jsx'))
    .flatMap((f) => [...read(f).matchAll(/<EntityLinksModal\b[^>]*?\bentityType="([a-z_]+)"/g)].map((m) => m[1])));
  const listedColumns = new Set();
  for (const [first, words = ''] of columns) {
    const [column] = codes(first);
    listedColumns.add(column);
    if (column === 'links.entity_type') compare('the dashboard\'s EntityLinksModal', sorted(codes(words)), links);
    else if (CHECKS[column]) compare(`${CHECKS[column]} (${column})`, sorted(codes(words)), admitted(CHECKS[column]));
    else problems566.push(`docs/architecture.md lists ${column}, which check 566 has no source for: name its CHECK here`);
  }
  for (const column of [...Object.keys(CHECKS), 'links.entity_type']) {
    if (!listedColumns.has(column)) problems566.push(`docs/architecture.md does not list ${column}`);
  }

  if (problems566.length) {
    fail(`the words for a kind and docs/architecture.md disagree:\n${problems566.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`docs/architecture.md lists the ${documented.length} words audit_trail.entity_type holds, and the words of ${columns.length} other columns, as the code and the migrations use them`);
  }
}
