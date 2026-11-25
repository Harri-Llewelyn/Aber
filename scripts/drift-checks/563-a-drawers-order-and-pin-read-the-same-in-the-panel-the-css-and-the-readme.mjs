import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 563. A drawer's order, its warnings and its pinned actions read the same in ContextPanel.jsx, App.css
// and frontend/README.md. The panel draws the warnings, the fields, the facts, the tools and the
// actions in that order; the share of the drawer past which the actions scroll (PIN_MAX_SHARE) and the
// window height under which they do (the media query) are the README's; and only the media query pins
// them. No drawer draws a callout of its own, in its ContextPanel element or in a section component:
// what is wrong is one of the panel's `warnings`, at the top.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const PANEL = 'frontend/src/components/common/ContextPanel.jsx';
  const CSS = 'frontend/src/App.css';
  const README = 'frontend/README.md';
  const panel = read(PANEL);
  const css = read(CSS);
  const readme = read(README);
  const offences = [];

  const ORDER = [
    ['the warnings', '<div className="context-panel-warnings">'],
    ['the fields', '{fieldRuns(orderedFields).map('],
    ['the facts', '<div className="context-panel-facts">'],
    ['the tools', '<div className="context-panel-extras">'],
    ['the actions', 'context-panel-actions context-buttons'],
  ];
  const at = ORDER.map(([, text]) => panel.indexOf(text));
  ORDER.forEach(([name], i) => {
    if (at[i] < 0) offences.push(`${PANEL}: could not find where it draws ${name}`);
    else if (i > 0 && at[i] < at[i - 1]) offences.push(`${PANEL} draws ${name} before ${ORDER[i - 1][0]}`);
  });
  if (!/const orderedFields = \[\s+\.\.\.\(recordId \? [^\n]+\n\s+\.\.\.\(description \? [^\n]+\n\s+\.\.\.fields,\s+\]/.test(panel)) {
    offences.push(`${PANEL} does not put the record's id, then its description, before the other fields`);
  }

  const share = panel.match(/const PIN_MAX_SHARE = 0\.(\d+)\n/)?.[1];
  const percent = share ? Number(share.padEnd(2, '0')) : null;
  if (!percent) offences.push(`could not read PIN_MAX_SHARE out of ${PANEL}`);
  else if (!readme.includes(`would take more than ${percent}% of the`)) offences.push(`${README} does not say the actions scroll past ${percent}% of the drawer`);

  const PINNED = '.context-panel-actions-pinned { position: sticky; bottom: 0;';
  const block = css.match(/\n@media \(min-height: (\d+)px\) \{\n([\s\S]*?)\n\}\n/g)?.find((b) => b.includes(PINNED));
  const height = block?.match(/min-height: (\d+)px/)?.[1];
  if (!height) offences.push(`${CSS} does not pin the actions inside an @media (min-height: ...) block`);
  else if (!readme.includes(`\`@media (min-height: ${height}px)\``) || !readme.includes(`a window under ${height}px high`)) {
    offences.push(`${README} does not say a window under ${height}px high unpins the actions`);
  }
  if (css.split('.context-panel-actions-pinned {').length !== 2) offences.push(`${CSS} styles .context-panel-actions-pinned outside that block`);
  if (block && !block.includes('scroll-margin-bottom: calc(var(--context-actions-height, 0px) + 8px)')) {
    offences.push(`${CSS} does not keep a focused field clear of the pinned actions (scroll-margin-bottom)`);
  }
  if (/\.context-panel-body[^{]*\{[^}]*scroll-padding/.test(css)) offences.push(`${CSS} gives the drawer's body a scroll-padding, which focusing a pinned action scrolls against`);

  for (const phrase of ["A drawer about a record starts with the record's id", 'Everything wrong is at the top, in full', 'The actions stay at the foot while the rest scrolls', '`.context-subtree`', '`recordId={{ label, value }}`']) {
    if (!readme.includes(phrase)) offences.push(`${README} does not say ${phrase}`);
  }

  // A drawer's element, from its tag to the line that closes it at the same indent.
  const drawers = allFiles.filter((f) => /^frontend\/src\/components\/.+\.jsx$/.test(f) && /<ContextPanel\b/.test(read(f)));
  let seen = 0;
  for (const file of drawers) {
    const lines = read(file).split('\n');
    lines.forEach((line, i) => {
      const indent = line.match(/^(\s*)(?:return )?<ContextPanel\b/)?.[1];
      if (indent === undefined) return;
      const end = lines.findIndex((l, j) => j > i && (l === `${indent}/>` || l === `${indent}</ContextPanel>`));
      if (end < 0) {
        offences.push(`${file}:${i + 1}: could not find where this ContextPanel ends`);
        return;
      }
      seen += 1;
      lines.slice(i, end).forEach((l, j) => {
        if (/className="[^"]*\bcallout\b/.test(l)) offences.push(`${file}:${i + j + 1} draws a callout in a drawer: hand it to ContextPanel's warnings`);
      });
    });
  }
  if (seen < 16) offences.push(`read only ${seen} drawers`);
  for (const name of ['SuppressionWindows', 'GatewayRepositoryPanel', 'AreaPlanPanel', 'ApplianceCommand']) {
    const file = `frontend/src/components/common/${name}.jsx`;
    if (/className="[^"]*\bcallout\b/.test(read(file))) offences.push(`${file} draws a callout in a drawer's section: hand it to ContextPanel's warnings`);
  }

  if (offences.length) {
    fail(`A drawer's order and its pinned actions disagree:\n${offences.map((o) => `        ${o}`).join('\n')}`);
  } else {
    pass(`a drawer's order, its warnings and its pinned actions (${percent}% of the drawer, ${height}px of window) read the same in the panel, the stylesheet and the README, and none of the ${seen} drawers draws a callout of its own`);
  }
}
