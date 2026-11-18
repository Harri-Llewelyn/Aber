import { allFiles, fail, pass, read, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 450. Every reader of metric_catalog.semantic_id says which of a metric's ids it reads (0299). A metric
// has its own id and may carry further ones (metric_semantic_ids). A reader that answers "which metric
// carries this concept?" has to answer across both, or a concept the metric carries as a further id is
// not found; a reader that asks what the metric's own id is must go on reading it alone, or i3X would
// name a type by an id another namespace owns. The migrations' README lists each reader with which it
// is. A new reader that the list lacks is a decision nobody made, and a listed one that reads the other
// list than it says is a claim the code contradicts.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const HEADING = "#### Who reads a metric's semantic id";
  const problems450 = [];
  // The runtime code that names the catalogue as a table and reads its semantic_id: not the tests, the
  // migrations, the tooling or the docs. A string literal, so a comment that mentions the table is not one.
  const ROOTS = ['frontend/src/', 'i3x/', 'ingestion/', 'supabase/functions/', 'gateway-credential/', 'backup-service/', 'node-red/'];
  const isTest = (f) => /(^|\/)(__tests__|test-harness)\//.test(f) || /\.test\.[mc]?[jt]sx?$/.test(f) || /(^|\/)test_[^/]*\.py$/.test(f) || /_test\.ts$/.test(f);
  const readers = allFiles.filter((f) => ROOTS.some((r) => f.startsWith(r)) && /\.(py|ts|jsx?|mjs)$/.test(f) && !isTest(f))
    .filter((f) => {
      const text = read(f);
      return /["']metric_catalog["']/.test(text) && /\bsemantic_id\b/.test(text);
    }).sort();

  const readme = supabaseReadme();
  const at = readme.indexOf(HEADING);
  const end = at < 0 ? -1 : readme.slice(at + HEADING.length).search(/\n#{3,4} /);
  const section = at < 0 ? '' : readme.slice(at, end < 0 ? undefined : at + HEADING.length + end);
  const listed = new Map([...section.matchAll(/^\| `([^`]+)` \| (\*\*both\*\*|own id) \|/gm)].map((m) => [m[1], m[2] === '**both**']));
  if (!section || listed.size === 0) {
    problems450.push(`supabase/README.md has no "${HEADING.slice(5)}" section with its table, so the readers are not checked`);
  } else {
    for (const f of readers) {
      if (!listed.has(f)) problems450.push(`${f} reads metric_catalog.semantic_id and the migrations' README does not say whether it reads the further ids too`);
    }
    for (const [f, both] of listed) {
      if (!allFiles.includes(f)) {
        problems450.push(`the README lists ${f}, which does not exist`);
        continue;
      }
      if (!readers.includes(f)) problems450.push(`the README lists ${f} as a reader of metric_catalog.semantic_id, and it is not one`);
      // Reading the further ids is naming their table or the view that joins them.
      const readsFurther = /metric_semantic_id_crosswalk|metric_semantic_ids|further_semantic_ids|supplementalByMetric/.test(read(f));
      if (both && !readsFurther) problems450.push(`the README says ${f} reads both lists, and it reads only the metric's own id`);
      if (!both && readsFurther) problems450.push(`the README says ${f} reads the own id alone, and it reads the further ids too`);
    }
  }
  if (problems450.length) {
    fail(`a reader of a metric's semantic id and the migrations' README disagree about which ids it reads:\n${problems450.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`the migrations' README says which ids each of the ${readers.length} readers of metric_catalog.semantic_id reads, ${[...listed.values()].filter(Boolean).length} of them both lists and the rest the own id alone`);
  }
}
