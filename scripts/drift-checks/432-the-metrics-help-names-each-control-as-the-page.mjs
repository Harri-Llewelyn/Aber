import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 432. The Metrics help names each control of an export and an upload on the Derived tab as the page
// labels it, and each status the preview draws. The help is written to be followed: "choose **Upload**"
// on a page whose button says Load sends a reader looking for a control that is not there. The file is
// derived-metrics.yaml, in the help and in the code, and the help links to the format's reference.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const HELP = 'help/pages/metrics.md';
  const help = read(HELP);
  const PAGE = 'frontend/src/components/tabs/MetricsTab.jsx';
  const EDITOR = 'frontend/src/components/modals/DerivedMetricsEditorModal.jsx';
  const MODAL = 'frontend/src/components/modals/ApplyDerivedMetricsModal.jsx';
  const problems432 = [];
  const labels = [
    ['Upload', PAGE], ['Export', PAGE], ['Export (', PAGE], ['New in YAML', PAGE], ['Add Derived Metric', PAGE],
    ['Add Derived Metrics', EDITOR], ['Add 2 Derived Metrics', MODAL],
  ];
  for (const [label, file] of labels) {
    const named = label.endsWith('(') ? 'Export (2)' : label;
    if (!help.includes(`**${named}**`)) problems432.push(`${HELP} does not name **${named}**`);
    // The page spells a count as `Add ${plural(...)}`, so "Add 2 Derived Metrics" is its template.
    const code = label === 'Add 2 Derived Metrics' ? "Add ${plural(written, 'Derived Metric')}" : label;
    if (!read(file).includes(code)) problems432.push(`${file} no longer has a control called ${label}, which ${HELP} names`);
  }
  for (const status of ['New', 'Unchanged', 'Refused']) {
    if (!help.includes(`**${status}**`)) problems432.push(`${HELP} does not name the preview's **${status}**`);
  }
  if (!help.includes('derived-metrics.yaml') || !read('frontend/src/utils/derivedMetricsFile.js').includes("'derived-metrics.yaml'")) {
    problems432.push(`${HELP} and utils/derivedMetricsFile.js do not both say the file is derived-metrics.yaml`);
  }
  if (!/\]\((\.\.\/)+docs\/derived-metrics\.md\)/.test(help)) problems432.push(`${HELP} does not link to docs/derived-metrics.md, the format's reference`);
  if (problems432.length) {
    fail(`the Metrics help does not name the Derived tab's controls as the code does:\n${problems432.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`the Metrics help names ${labels.length} controls of the Derived tab and the 3 preview statuses as the page labels them`);
  }
}
