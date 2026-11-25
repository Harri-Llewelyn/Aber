import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 535. A drawer section's buttons sit in the Actions grid. App.css declares the grid's columns once,
// as `.context-buttons`, and ContextPanel's Actions section is one. A component that draws a
// drawer section gives every `btn` the class `context-action`, which fills its cell, holds them in
// a `.context-buttons` grid, and hands SaveDiscard `context-action` too. A `btn` without it is a
// button at its own width. Read: every file in components/common that labels a section with
// context-panel-section-label or context-field-label, and the section functions a page's file
// declares (SECTIONS_IN_PAGES). The rest of a page's file is not read: it holds the page's toolbar,
// whose buttons are rightly their own width.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const CSS = 'frontend/src/App.css';
  const PANEL = 'frontend/src/components/common/ContextPanel.jsx';
  const README = 'frontend/README.md';
  const COLUMNS = 'grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));';
  const MUST_READ = ['SuppressionWindows.jsx', 'GatewayRepositoryPanel.jsx', 'AreaPlanPanel.jsx'];
  // A drawer section drawn by a function in a page's file: [file, function name].
  const SECTIONS_IN_PAGES = [['frontend/src/components/tabs/AuditTrailTab.jsx', 'CausationGroup']];
  const offences = [];

  const css = read(CSS);
  const grid = css.match(/\n\.context-buttons \{([^}]*)\}/);
  if (!grid || !grid[1].includes(COLUMNS)) offences.push(`${CSS} does not declare the drawer's grid of buttons as .context-buttons`);
  const copies = css.split(COLUMNS).length - 1;
  if (copies > 1) offences.push(`${CSS} declares the drawer's button columns ${copies} times: a section uses .context-buttons, not a grid of its own`);
  if (!read(PANEL).includes('context-panel-actions context-buttons')) offences.push(`${PANEL}'s Actions section is not a .context-buttons grid`);

  // Each source read: its name, its text, and the line its text starts on.
  const sources = allFiles
    .filter((f) => /^frontend\/src\/components\/common\/[^/]+\.jsx$/.test(f))
    .filter((f) => /context-panel-section-label|context-field-label/.test(read(f)))
    .map((f) => ({ name: f, file: f, src: read(f), first: 1 }));
  for (const name of MUST_READ) {
    if (!sources.some((s) => s.file.endsWith(`/${name}`))) offences.push(`${name} is no longer read as a drawer section: it labels no section, or it moved`);
  }
  for (const [file, fn] of SECTIONS_IN_PAGES) {
    const text = read(file);
    // A top-level function runs from its declaration to the first `}` at the start of a line.
    const start = text.indexOf(`\nfunction ${fn}(`);
    const end = start < 0 ? -1 : text.indexOf('\n}\n', start);
    if (end < 0) {
      offences.push(`${file} declares no top-level function ${fn}: the drawer section it drew moved, so name where it is now`);
      continue;
    }
    sources.push({ name: `${file} (${fn})`, file, src: text.slice(start + 1, end + 2), first: text.slice(0, start + 1).split('\n').length });
  }

  for (const { name, file, src, first } of sources) {
    src.split('\n').forEach((line, i) => {
      if (/(?<![\w-])btn(?![\w-])/.test(line) && !line.includes('btn-icon') && !line.includes('context-action')) {
        offences.push(`${file}:${first + i} draws a button at its own width: give it context-action, in a context-buttons grid`);
      }
    });
    if (/<SaveDiscard\b/.test(src) && !/<SaveDiscard\b[^>]*\bbuttonClassName="context-action"/.test(src)) {
      offences.push(`${name} draws SaveDiscard without buttonClassName="context-action", so its pair keeps its own width`);
    }
    if (src.includes('context-action') && !src.includes('context-buttons')) {
      offences.push(`${name} has context-action buttons that no context-buttons grid holds`);
    }
  }

  if (!read(README).includes("A drawer section's buttons use the Actions grid.")) {
    offences.push(`${README} does not say a drawer section's buttons use the Actions grid`);
  }

  if (offences.length) {
    fail(`A drawer section's buttons sit in the Actions grid:\n  ${offences.join('\n  ')}`);
  } else {
    pass(`A drawer section's buttons sit in the Actions grid: App.css declares it once as .context-buttons, the ${sources.length} components that draw a drawer section use it, and the README says so`);
  }
}
