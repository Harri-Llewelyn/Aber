import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 614. A line cut short is an OverflowText, so every one ends in an ellipsis and slides to show the
// rest on hover or keyboard focus. `text-overflow: ellipsis` is in the dashboard's stylesheets only in
// `.overflow-text`'s own rule, no component cuts a line with an inline `textOverflow`, and a chip's
// name (`.chip-name`, drawn on every drawer) is an OverflowText wherever it is drawn. frontend/README.md
// states the rule under Words and rules.
// -------------------------------------------------------------------------------------------------
const SRC = 'frontend/src/';
const OWN = '.overflow-text';
const README = 'frontend/README.md';

const blank = (src) => src.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
const lineOf = (src, at) => src.slice(0, at).split('\n').length;

export default function check() {
  const problems614 = [];
  const isSource = (f) => f.startsWith(SRC) && !f.includes('/__tests__/') && !f.startsWith(`${SRC}test/`);

  // The stylesheets: each rule that ends a line in an ellipsis, by its selector.
  let own = 0;
  for (const file of allFiles.filter((f) => isSource(f) && f.endsWith('.css'))) {
    const css = blank(read(file));
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/text-overflow\s*:\s*ellipsis/.test(rule[2])) continue;
      const selector = rule[1].trim().replace(/\s+/g, ' ');
      if (selector === OWN) own += 1;
      else problems614.push(`${file}:${lineOf(css, rule.index + rule[0].indexOf('{'))} cuts \`${selector}\` with an ellipsis of its own: draw the line as an OverflowText`);
    }
  }
  if (own !== 1) problems614.push(`OverflowText's own rule (\`${OWN}\`) ends its line in an ellipsis ${own} times, not once`);

  // The components: no inline ellipsis, and a chip's name only as an OverflowText.
  for (const file of allFiles.filter((f) => isSource(f) && /\.jsx?$/.test(f))) {
    const src = blank(read(file)).replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    for (const m of src.matchAll(/textOverflow\s*:/g)) problems614.push(`${file}:${lineOf(src, m.index)} cuts a line with an inline textOverflow: draw it as an OverflowText`);
    for (const m of src.matchAll(/\bchip-name\b/g)) {
      if (!/<OverflowText className="$/.test(src.slice(Math.max(0, m.index - 40), m.index))) {
        problems614.push(`${file}:${lineOf(src, m.index)} draws a chip's name (\`.chip-name\`) on something other than an OverflowText`);
      }
    }
  }

  const readme = read(README).replace(/\s+/g, ' ');
  const rule = readme.slice(readme.indexOf('- **Cut text.**'), readme.indexOf('- **Archived things are hidden by default**'));
  if (!rule.startsWith('- **Cut text.**') || !rule.includes('`common/OverflowText`') || !rule.includes('drift check 614')) {
    problems614.push(`${README} does not state under Words and rules (\`- **Cut text.**\`) that every cut line is a \`common/OverflowText\`, held by drift check 614`);
  }

  if (problems614.length) {
    fail(`a line cut short is drawn some other way than OverflowText, or the README does not say it is:\n${problems614.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass('only OverflowText ends a line in an ellipsis, in the stylesheets and inline, every chip\'s name is one, and frontend/README.md says so');
  }
}
