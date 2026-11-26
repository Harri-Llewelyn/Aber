import { allFiles, fail, HELP_PAGES, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 622. The foot of a long list says what it counts: "30 runs of 57 runs" beside **Show 27 More
// Runs**, and "All 57 runs shown." at the end. Every ListFoot in the dashboard is given its noun, so
// no page says a bare number, and the Audit Trail's adds the entities its events are about. No help
// page quotes the foot's old words, which named no noun and put the button in sentence case.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems622 = [];
  // Its callers; ListFoot.jsx's own example is not one.
  const sources = allFiles.filter((f) => f.startsWith('frontend/src/') && f.endsWith('.jsx') && !f.includes('/__tests__/')
    && f !== 'frontend/src/components/common/ListFoot.jsx');
  let feet = 0;
  for (const file of sources) {
    const text = read(file);
    for (let at = text.indexOf('<ListFoot'); at >= 0; at = text.indexOf('<ListFoot', at + 1)) {
      const element = text.slice(at, text.indexOf('/>', at));
      feet += 1;
      if (!/\snoun=/.test(element)) problems622.push(`${file}:${text.slice(0, at).split('\n').length} draws a ListFoot without a noun`);
    }
  }
  if (feet < 4) problems622.push(`found ${feet} ListFoot elements, fewer than the four lists that use it, so this check is no longer reading them`);

  const trail = read('frontend/src/components/tabs/AuditTrailTab.jsx');
  if (!trail.includes('about={footAbout}') || !trail.includes("countWords(matchingEntities, 'entity', 'entities')")) {
    problems622.push("AuditTrailTab.jsx's foot does not say how many entities its events are about");
  }

  const OLD = [/\*\*Show (?:more|\d+ more)\*\*/, /\*\*All (?:N|\d+) shown\.\*\*/, /"\d+ of \d+"/];
  for (const page of HELP_PAGES) {
    const text = read(page);
    for (const old of OLD) {
      const m = text.match(old);
      if (m) problems622.push(`${page} quotes the foot's old words: ${m[0]}`);
    }
  }

  if (problems622.length) {
    fail(`A list's foot does not say what it counts:\n${problems622.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`each of the ${feet} list feet names what it counts, the Audit Trail's its entities too, and no help page quotes the old words`);
  }
}
