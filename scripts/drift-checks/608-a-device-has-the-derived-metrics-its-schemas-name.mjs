import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 608. A device has the derived metrics its schemas name (0336), and nothing a person reads says the
// rule before it: that a derived metric is on every device that reports its inputs. Help, the
// references, the dashboard's source and the AAS exporter's are read; a released upgrade note and a
// released migration's section say what that release did, and are not. The four pages that say where a
// derived metric is drawn must say a schema names it. mirror check 173 holds the code.
// -------------------------------------------------------------------------------------------------

/** The old rule, however it is worded: a device or a tab, and reporting all, every or the inputs of it. */
const OLD_RULE = /\breports?\s+(?:all|every\s+one)\s+(?:of\s+)?(?:its|their|the)\s+inputs\b|\breports?\s+every\s+input\b|\bwhose\s+inputs\s+(?:the|a)\s+device\s+reports\b|\bderivedReportedBy\b/i;

/** What says what an earlier release did, or tests that the old rule is gone. */
const HISTORY = new Set(['help/site/upgrading.md', 'supabase/README.md']);

const isRead = (f) => (
  (f.startsWith('help/') && f.endsWith('.md'))
  || (f.startsWith('docs/') && /\.(md|yaml)$/.test(f))
  || f === 'frontend/README.md'
  || (f.startsWith('frontend/src/') && /\.jsx?$/.test(f) && !f.includes('/__tests__/'))
  || (f.startsWith('supabase/functions/') && f.endsWith('.ts') && !f.endsWith('_test.ts'))
);

/** Where a person reads which devices have a derived metric, and how each page says it. */
const SAYS = [
  ['help/pages/history.md', 'on every device whose [schema](schemas.md) names it'],
  ['help/pages/metrics.md', 'every device in service whose schema names it'],
  ['help/pages/schemas.md', '**A device has the derived metrics its schemas name,**'],
  ['help/pages/devices.md', "one of the device's schemas names"],
];

export default function check() {
  const problems608 = [];
  let files = 0;
  for (const f of allFiles.filter((name) => isRead(name) && !HISTORY.has(name))) {
    files += 1;
    const text = read(f);
    const at = text.search(OLD_RULE);
    if (at >= 0) problems608.push(`${f}:${text.slice(0, at).split('\n').length} says the rule before 0336 ("${text.slice(at, at + 60).split('\n')[0]}"): a device has the derived metrics its schemas name`);
  }
  for (const [f, said] of SAYS) {
    if (!read(f).replace(/\s+/g, ' ').includes(said)) problems608.push(`${f} does not say "${said}"`);
  }
  if (files < 100) problems608.push(`only ${files} files read, so this check is no longer checking anything`);
  if (problems608.length) {
    fail(`A page says another rule for which devices have a derived metric:\n${problems608.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`none of ${files} pages and sources says a derived metric is on every device that reports its inputs, and ${SAYS.length} help pages say a schema names it`);
  }
}
