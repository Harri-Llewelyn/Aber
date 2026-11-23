import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 495. Every difference docs/gateway-lifecycle.md names is held by a test, and every test that holds
// one is named there. A row of the page's tables that says "today the code does something else"
// carries a key, [D1] and so on, and the section "Where the code differs" says what, by the title of
// the bug. The suites mark the same row `@known_bug("<the title>")`: unittest's expectedFailure, so
// a bug that is fixed fails the run until the mark is removed, and this check fails until the text
// is too. Without it the page goes on describing a defect that no longer exists, or a suite goes on
// expecting one the page does not mention.
// -------------------------------------------------------------------------------------------------
const SUITES = [
  'supabase/migrations/test_gateway_lifecycle.py',
  'supabase/functions/enroll-gateway/test_gateway_lifecycle_broker.py',
];

const plain = (text) => text.replaceAll('`', '').trim();

export default function check() {
  const doc = read('docs/gateway-lifecycle.md');
  const [before, after = ''] = doc.split(/^## Where the code differs$/m);
  const section = after.split(/^## /m)[0];
  const elsewhere = before + after.slice(section.length);

  const rows = [...section.matchAll(/^\| \*\*\[(D\d+)\]\*\* \| \*([^*]+?)\.\* .*\| ([^|]+) \|$/gm)]
    .map((m) => ({ key: m[1], title: plain(m[2]), confirmed: m[3] }));
  const used = new Set([...elsewhere.matchAll(/\*\*\[(D\d+)\]\*\*/g)].map((m) => m[1]));
  const held = new Map();
  for (const suite of SUITES) {
    for (const m of read(suite).matchAll(/@known_bug\("([^"]+)"\)/g)) held.set(plain(m[1]), suite);
  }

  // With every difference fixed the section says so in this sentence instead of a table, so a table
  // this check can no longer read still fails.
  const NONE = 'Today the code does what every row above says.';
  const saysNone = section.includes(NONE);
  const problems495 = [];
  if (!rows.length && !saysNone) problems495.push(`docs/gateway-lifecycle.md has no differences in a table this check can read under "Where the code differs", and does not say "${NONE}"`);
  if (rows.length && saysNone) problems495.push(`"Where the code differs" says "${NONE}" and still lists ${rows.length}`);
  const defined = new Set(rows.map((r) => r.key));
  for (const key of used) {
    if (!defined.has(key)) problems495.push(`a table row cites [${key}], which "Where the code differs" does not define`);
  }
  for (const key of defined) {
    if (!used.has(key)) problems495.push(`[${key}] is defined under "Where the code differs" and no table row cites it`);
  }
  for (const { key, title, confirmed } of rows) {
    if (confirmed.includes('expected to fail') && !held.has(title)) {
      problems495.push(`[${key}] says a suite holds it, and no suite marks @known_bug("${title}")`);
    }
  }
  const titles = new Set(rows.map((r) => r.title));
  for (const [title, suite] of held) {
    if (!titles.has(title)) problems495.push(`${suite} marks @known_bug("${title}"), which docs/gateway-lifecycle.md does not name under "Where the code differs"`);
  }

  if (problems495.length) {
    fail('docs/gateway-lifecycle.md and the lifecycle suites disagree about what the code gets wrong:\n' + problems495.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(rows.length
      ? `the ${rows.length} differences docs/gateway-lifecycle.md names are cited by its tables, and each the suites mark as a known bug is named there`
      : 'docs/gateway-lifecycle.md says the code does what every row says, and no suite marks a known bug');
  }
}
