import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 588. The API reference lists the kinds the database has. AuditTrailEntry.entity_type is the words of
// AUDIT_TRAIL_ENTITY_TYPES, and /rest/v1/audit_trail gives them by lane; links.entity_type, in its three places,
// is the words docs/architecture.md gives that column. Check 566 holds the first list to
// audit_trail_action_kinds() and the second to its CHECK and the dashboard. /rest/v1/machine_principals counts
// the pinned identities as the table's comment does, which check 565 holds to the seed, and names both its
// writers.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems588 = [];
  const spec = read('docs/openapi.yaml');
  // A block of the spec: from its key to the next line at the same indentation or less.
  const block = (key) => {
    const at = spec.indexOf(`\n${key}:\n`);
    if (at < 0) return '';
    const lines = spec.slice(at + 1).split('\n');
    const indent = key.length - key.trimStart().length;
    const end = lines.findIndex((l, i) => i > 0 && l.trim() && l.length - l.trimStart().length <= indent);
    return lines.slice(0, end < 0 ? undefined : end).join('\n');
  };
  const codes = (text) => [...text.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]);
  const words = (list) => list.split(',').map((w) => w.trim()).filter(Boolean);
  const compare = (where, listed, expected) => {
    const missing = expected.filter((w) => !listed.includes(w));
    const extra = listed.filter((w) => !expected.includes(w));
    if (!listed.length) problems588.push(`read no word from ${where}: its shape has changed`);
    else if (missing.length) problems588.push(`${where} lacks ${missing.join(', ')}`);
    if (extra.length) problems588.push(`${where} lists ${extra.join(', ')}, which is no kind of it`);
    if (new Set(listed).size !== listed.length) problems588.push(`${where} lists a word twice`);
  };

  const types = read('frontend/src/constants.js').match(/export const AUDIT_TRAIL_ENTITY_TYPES = \[([\s\S]*?)\n\];/)?.[1] ?? '';
  const kinds = [...types.matchAll(/\btable: '([a-z_]+)',.*?\bdomain: '([a-z]+)'/g)].map(([, table, domain]) => ({ table, domain }));
  const linkWords = codes(read('docs/architecture.md').match(/^\| `links\.entity_type` \|([^|]*)\|/m)?.[1] ?? '');
  if (kinds.length < 10 || linkWords.length < 2) {
    fail(`check 588 read ${kinds.length} kinds from AUDIT_TRAIL_ENTITY_TYPES and ${linkWords.length} from docs/architecture.md's links.entity_type row: their shape has changed, so it is checking nothing`);
    return;
  }

  const entry = block('    AuditTrailEntry').match(/\n {8}entity_type:\n {10}type: string\n {10}enum: \[([^\]]*)\]/)?.[1] ?? '';
  compare('AuditTrailEntry.entity_type', words(entry), kinds.map((k) => k.table));
  const trail = block('  /rest/v1/audit_trail');
  for (const lane of new Set(kinds.map((k) => k.domain))) {
    const bullet = trail.split(`\n        - The ${lane} lane holds `)[1]?.split('.\n')[0] ?? '';
    compare(`/rest/v1/audit_trail's ${lane} lane`, codes(bullet), kinds.filter((k) => k.domain === lane).map((k) => k.table));
  }
  const SECTION = 'docs/architecture.md#entity_type-the-word-for-a-kind';
  for (const [where, text] of [['AuditTrailEntry', block('    AuditTrailEntry')], ['/rest/v1/audit_trail', trail]]) {
    if (!text.includes(SECTION)) problems588.push(`${where} does not link to ${SECTION}, which says what each word is about`);
  }
  if (!read('docs/architecture.md').includes('\n### `entity_type`: the word for a kind\n')) problems588.push(`docs/architecture.md has no heading for ${SECTION}`);

  const links = block('  /rest/v1/links');
  const eq = links.match(/name: entity_type, in: query, schema: \{ type: string \}, description: '([^']*)'/)?.[1] ?? '';
  compare('/rest/v1/links\' entity_type filter', [...eq.matchAll(/`eq\.([a-z_]+)`/g)].map((m) => m[1]), linkWords);
  const ENUM = /\n +entity_type: \{ type: string, enum: \[([^\]]*)\]/;
  compare('the body of POST /rest/v1/links', words(links.match(ENUM)?.[1] ?? ''), linkWords);
  compare('Link.entity_type', words(block('    Link').match(ENUM)?.[1] ?? ''), linkWords);

  // The table's comment as the last migration that states it, with its adjacent literals joined.
  const head = 'COMMENT ON TABLE public.machine_principals IS';
  const sql = allFiles.filter((f) => /^supabase\/migrations\/\d{4}_[^/]*\.sql$/.test(f)).sort().map(read).findLast((text) => text.includes(head)) ?? '';
  const comment = sql.slice(sql.lastIndexOf(head)).split(';\n')[0].replace(/'[ \t]*\n[ \t]*'/g, '');
  const counted = comment.match(/the (\w+) identities a migration pinned/)?.[1];
  const principals = block('  /rest/v1/machine_principals');
  if (!counted) problems588.push('read no count of the pinned identities from the comment on machine_principals');
  else if (!principals.includes(`The ${counted} identities a migration pinned`)) problems588.push(`/rest/v1/machine_principals does not say "The ${counted} identities a migration pinned", as the table's comment does`);
  for (const fn of ['create_machine_principal()', 'describe_machine_principal()']) {
    if (!principals.includes(`\`${fn}\``)) problems588.push(`/rest/v1/machine_principals does not name ${fn}, which writes it`);
  }

  if (problems588.length) {
    fail(`docs/openapi.yaml's lists of kinds and the database disagree:\n${problems588.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`docs/openapi.yaml lists the ${kinds.length} kinds the Audit Trail holds, by lane, the ${linkWords.length} a link is on and the ${counted} pinned identities`);
  }
}
