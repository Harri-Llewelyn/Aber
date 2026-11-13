import { allFiles, fail, gitignored, pass, readDoc, upgradingGuide } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 152. A reference to the upgrade guide outside markdown (its path, a comma, then a heading in double
// quotes) names one of its headings exactly. NOTES.txt prints such a reference on every upgrade,
// and the chart's values and the key scripts carry it, where check 1 cannot see a renamed heading.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const GUIDE = 'help/site/upgrading.md';
  const headings = new Set(upgradingGuide().split('\n').map((l) => l.match(/^#{1,6}\s+(.*?)\s*$/)?.[1]).filter(Boolean));
  const refs = [];
  for (const file of allFiles.filter((f) => !f.endsWith('.md') && !gitignored(f) && /\.(mjs|js|ts|ya?ml|txt|tpl|example)$/.test(f))) {
    for (const m of readDoc(file).matchAll(/help\/site\/upgrading\.md,\s*"([^"\n]+)"/g)) refs.push({ file, heading: m[1] });
  }
  const missing = refs.filter((r) => !headings.has(r.heading));
  for (const r of missing) fail(`${r.file} names "${r.heading}" in ${GUIDE}, which has no such heading`);
  if (!refs.length) fail(`check 152 found no reference to a heading of ${GUIDE}, so it compares nothing`);
  else if (!missing.length) pass(`the ${refs.length} references to a heading of ${GUIDE} outside markdown name one`);
}
