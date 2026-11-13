import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 345. A dialog's title wraps beside its close button, as frontend/README.md's *A dialog keeps its
// buttons in view* says. App.css gives `.modal-header-row .modal-title` the rest of the row
// (`flex: 1 1 <N>ch`), `overflow-wrap: anywhere` and no ellipsis, and `.modal-header-controls`
// `flex: none`; the section names that N in "<N> characters", the room the title keeps before
// controls too wide for it wrap below. A title cut with an ellipsis hides the end of a file name,
// and controls that shrink let a long title push the close button onto a line of its own.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const css = read('frontend/src/App.css').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
  // The body of the rule that starts a line with `selector`, found as text, not as a built pattern.
  const ruleBody = (selector) => {
    const head = `\n${selector} {`;
    const at = css.indexOf(head);
    if (at === -1) return undefined;
    const end = css.indexOf('}', at + head.length);
    return end === -1 ? undefined : css.slice(at + head.length, end);
  };
  const problems345 = [];
  const title = ruleBody('.modal-header-row .modal-title');
  const controls = ruleBody('.modal-header-controls');
  const room = Number(title?.match(/flex:\s*1 1 (\d+)ch\b/)?.[1]);
  if (title === undefined) problems345.push('frontend/src/App.css has no ".modal-header-row .modal-title" rule');
  else {
    if (!Number.isInteger(room)) problems345.push('".modal-header-row .modal-title" in frontend/src/App.css is not "flex: 1 1 <N>ch"');
    if (!/overflow-wrap:\s*anywhere/.test(title)) problems345.push('".modal-header-row .modal-title" does not wrap a long unbroken word (overflow-wrap: anywhere)');
    if (/text-overflow|white-space:\s*nowrap/.test(title)) problems345.push('".modal-header-row .modal-title" cuts or holds its text on one line; a dialog title wraps');
  }
  if (controls === undefined) problems345.push('frontend/src/App.css has no ".modal-header-controls" rule');
  else if (!/(?:^|[;\s])flex:\s*none\b/.test(controls)) problems345.push('".modal-header-controls" is not "flex: none", so a long title can shrink the close button');
  const section = read('frontend/README.md').match(/\n### A dialog keeps its buttons in view\n([\s\S]*?)\n### /)?.[1]?.replace(/\s+/g, ' ');
  if (!section) problems345.push('frontend/README.md has no "A dialog keeps its buttons in view" section');
  else {
    if (Number.isInteger(room) && !section.includes(`leave the title ${room} characters`)) problems345.push(`frontend/README.md's A dialog keeps its buttons in view does not say "leave the title ${room} characters", as App.css keeps for the title`);
    if (!/never cut with an ellipsis/.test(section)) problems345.push('frontend/README.md\'s A dialog keeps its buttons in view does not say the title is "never cut with an ellipsis"');
  }
  if (problems345.length) {
    fail('A dialog\'s title and its close button are laid out otherwise than frontend/README.md says:\n' + problems345.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`a dialog's title wraps and is never cut, the controls keep their size, and a title keeps ${room} characters before wide controls wrap below it`);
  }
}
