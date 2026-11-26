import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 611. Every callout is drawn by common/Callout.jsx, as frontend/README.md's *Words and rules* says: the
// tone picks the icon, at one size, so two callouts of one tone look alike. Under frontend/src no other
// source writes a callout's classes (`callout`, `callout-warning`, `callout-page`, `callout-icon` and the
// rest) in a string or a template, which is how one is written by hand; each is named with its file and
// line. Comments, tests and App.css, which styles the classes, are not read.
// -------------------------------------------------------------------------------------------------

const SRC = 'frontend/src/';
const COMPONENT = 'components/common/Callout.jsx';
const TONES = ['info', 'warning', 'danger', 'success'];
const RULE_IN_README = '**A callout is a `Callout`.**';

/** A string or template that is a class list naming a callout class: words and `${…}` from its quote. */
const HAND_WRITTEN = /["'`](?:[\w-]+\s+|\$\{[^}\n]*\}\s*)*callout(?:-[a-z]+)*(?=[\s"'`])/g;

/** A source without its comments, each left as blank lines so a line number still holds. */
const code = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
  .replace(/(^|\s)\/\/[^\n]*/g, '$1');

export default function check() {
  const problems611 = [];
  const sources = new Map(allFiles
    .filter((f) => /^frontend\/src\/.*\.jsx?$/.test(f) && !f.includes('/__tests__/') && !f.startsWith(`${SRC}test/`))
    .map((f) => [f.slice(SRC.length), code(read(f).replace(/\r\n/g, '\n'))]));

  let drawn = 0;
  let files = 0;
  for (const [file, src] of sources) {
    if (file === COMPONENT) continue;
    for (const m of src.matchAll(HAND_WRITTEN)) {
      const line = src.slice(0, m.index).split('\n').length;
      problems611.push(`${SRC}${file}:${line} writes the callout's classes by hand (${m[0].slice(1)}): draw a <Callout tone=…>`);
    }
    const here = (src.match(/<Callout\b/g) ?? []).length;
    drawn += here;
    if (here) files += 1;
  }

  const component = sources.get(COMPONENT) ?? '';
  if (!component) problems611.push(`${SRC}${COMPONENT} is not there: this check names it as the one place a callout is drawn`);
  for (const tone of TONES) {
    if (!new RegExp(`\\b${tone}: Icon\\w+`).test(component)) problems611.push(`${SRC}${COMPONENT} gives the tone ${tone} no icon`);
  }
  if (!drawn) problems611.push('no source draws a <Callout>: the component was renamed, so name it here');
  if (!read('frontend/README.md').replace(/\s+/g, ' ').includes(RULE_IN_README)) problems611.push(`frontend/README.md does not say: ${RULE_IN_README}`);

  if (problems611.length) {
    fail('A callout is written by hand (frontend/README.md, Words and rules):\n' + problems611.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the ${drawn} callouts in ${files} dashboard sources are each a <Callout>, which gives each of the ${TONES.length} tones its icon; no other source writes the callout's classes`);
  }
}
