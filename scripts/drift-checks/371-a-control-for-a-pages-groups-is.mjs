import { allFiles, fail, MARKDOWN, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 371. A control for a page's groups is over them, not in the toolbar, as frontend/README.md says.
// Every ExpandAllToggle is the first child of the row `.groups-header` and in no `.filter-bar`; the
// row is one rule in App.css, and the two names it replaced (`.trail-header`, `.history-header`)
// are in no document and no stylesheet. The README states the rule where it states the toolbar's.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems371 = [];
  const ROW = '<div className="groups-header">';
  const files = allFiles.filter((f) => /^frontend\/src\/components\/(tabs|common)\/[^/]+\.jsx$/.test(f));
  const users = [];
  let toggles = 0;
  for (const file of files) {
    const src = read(file);
    // A JSX tag starts its line; the same words in a comment's example start with a `*`.
    const tags = [...src.matchAll(/^[ \t]*<ExpandAllToggle\b/gm)];
    if (!tags.length) continue;
    users.push(file.replace(/^.*\//, ''));
    for (const tag of tags) {
      toggles += 1;
      const row = src.lastIndexOf(ROW, tag.index);
      if (row < 0 || src.slice(row + ROW.length, tag.index).trim() !== '') {
        problems371.push(`${file}:${src.slice(0, tag.index).split('\n').length + 1} draws Expand all anywhere but first in a ${ROW}`);
      }
    }
    for (const bar of src.matchAll(/<div className="filter-bar"[\s>]/g)) {
      const body = src.slice(bar.index, bar.index + 20000);
      const end = body.search(/\n\s*<\/div>\n\s*\n/);
      if (/^[ \t]*<ExpandAllToggle\b/m.test(end < 0 ? body : body.slice(0, end))) {
        problems371.push(`${file}:${src.slice(0, bar.index).split('\n').length} has Expand all in its toolbar`);
      }
    }
  }
  for (const page of ['AuditTrailTab.jsx', 'HistoryDevice.jsx', 'MetricsTab.jsx', 'VocabularyPanel.jsx']) {
    if (!users.includes(page)) problems371.push(`${page} no longer draws ExpandAllToggle, so this check is checking less than it says`);
  }
  if ((read('frontend/src/App.css').match(/\n\.groups-header \{/g) || []).length !== 1) {
    problems371.push('frontend/src/App.css does not have exactly one `.groups-header` rule');
  }
  for (const f of [...MARKDOWN, 'frontend/src/App.css']) {
    if (/\.(trail|history)-header\b/.test(read(f))) problems371.push(`${f} names \`.trail-header\` or \`.history-header\`, which \`.groups-header\` replaced`);
  }
  const readme = read('frontend/README.md').replace(/\s+/g, ' ');
  for (const phrase of ["A control for a page's groups sits over them, not in the toolbar", '`.groups-header`']) {
    if (!readme.includes(phrase)) problems371.push(`frontend/README.md does not say "${phrase}"`);
  }
  if (problems371.length) {
    fail('a control for a page\'s groups is not over them, or the README states it otherwise:\n'
      + problems371.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`all ${toggles} Expand all buttons, in ${users.length} files, start a .groups-header and none is in a toolbar, and the README states the rule`);
  }
}
