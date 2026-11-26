import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 620. A chip that opens a record is drawn by common/RecordChip.jsx, as frontend/README.md's *Words and
// rules* says: the link, the kind's icon, the name as an OverflowText (check 614), the dot, the flags and
// the tooltip "Open {name} on the {page} page" are written once. Under frontend/src no other source names
// the chip's class (`chip-link`), which is how one is written by hand; each is named with its file and
// line. RecordChip itself writes the class and its name as an OverflowText. Comments, tests and App.css,
// which styles the class, are not read.
// -------------------------------------------------------------------------------------------------

const SRC = 'frontend/src/';
const COMPONENT = 'components/common/RecordChip.jsx';
const RULE_IN_README = '**A chip that opens a record is a `RecordChip`.**';

/** A source without its comments, each left as blank lines so a line number still holds. */
const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

export default function check() {
  const problems620 = [];
  const sources = new Map(allFiles
    .filter((f) => /^frontend\/src\/.*\.jsx?$/.test(f) && !f.includes('/__tests__/') && !f.startsWith(`${SRC}test/`))
    .map((f) => [f.slice(SRC.length), code(read(f).replace(/\r\n/g, '\n'))]));

  let drawn = 0;
  let files = 0;
  for (const [file, src] of sources) {
    if (file === COMPONENT) continue;
    for (const m of src.matchAll(/\bchip-link\b/g)) {
      const line = src.slice(0, m.index).split('\n').length;
      problems620.push(`${SRC}${file}:${line} writes a record chip's class (chip-link) by hand: draw a <RecordChip>`);
    }
    const here = (src.match(/<RecordChip\b/g) ?? []).length;
    drawn += here;
    if (here) files += 1;
  }

  const component = sources.get(COMPONENT) ?? '';
  if (!component) {
    problems620.push(`${SRC}${COMPONENT} is not there: this check names it as the one place a record chip is drawn`);
  } else {
    if (!/["'`]chip chip-link\b/.test(component)) problems620.push(`${SRC}${COMPONENT} does not write the chip's classes (chip chip-link)`);
    if (!component.includes('<OverflowText className="chip-name">')) problems620.push(`${SRC}${COMPONENT} does not draw the name as an OverflowText (chip-name)`);
    if (!component.includes('<RouteLink')) problems620.push(`${SRC}${COMPONENT} does not draw its link as a RouteLink`);
  }
  if (!drawn) problems620.push('no source draws a <RecordChip>: the component was renamed, so name it here');
  if (!read('frontend/README.md').replace(/\s+/g, ' ').includes(RULE_IN_README)) problems620.push(`frontend/README.md does not say: ${RULE_IN_README}`);

  if (problems620.length) {
    fail('A chip that opens a record is written by hand (frontend/README.md, Words and rules):\n' + problems620.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the ${drawn} record chips in ${files} dashboard sources are each a <RecordChip>, which alone writes the chip's class, its name as an OverflowText and its link`);
  }
}
