import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 448. The Metrics help names each control of a metric's further semantic ids as the page labels it,
// and the page labels what the help names. The help is written to be followed: "choose **Add Further
// ID**" on a dialog whose button says Add Id sends a reader looking for a control that is not there.
// The drawer's row and the dialog's section carry the same name, so the help's one phrase finds both.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const HELP = 'help/pages/metrics.md';
  const help = read(HELP);
  const EDITOR = 'frontend/src/components/common/FurtherSemanticIds.jsx';
  const PAGE = 'frontend/src/components/tabs/MetricsTab.jsx';
  const FIELD = 'frontend/src/components/common/SemanticIdField.jsx';
  const MODAL = 'frontend/src/components/modals/EditMetricSemanticIdModal.jsx';
  const problems448 = [];
  // Each control the help names, with the line of source that draws it. A button is a line of its own, so
  // a name in a comment does not stand for the control.
  const controls = [
    ['Further Semantic IDs', EDITOR, /Further Semantic IDs <span/],
    ['Further Semantic IDs', PAGE, /label: 'Further Semantic IDs'/],
    ['Add Further ID', EDITOR, /^\s+Add Further ID$/m],
    ['Add', EDITOR, /^\s+Add$/m],
    ['Remove', EDITOR, /^\s+Remove$/m],
    ['Source', EDITOR, /Source <span/],
    ['Search vocabularies', FIELD, /\? 'Close search' : 'Search vocabularies'/],
    ['Save Metric', MODAL, /^\s+Save Metric$/m],
  ];
  for (const [label, file, shape] of controls) {
    if (!help.includes(`**${label}**`)) problems448.push(`${HELP} does not name **${label}**`);
    if (!shape.test(read(file))) problems448.push(`${file} no longer draws a control called ${label}, which ${HELP} names`);
  }
  if (problems448.length) {
    fail(`the Metrics help does not name the further semantic ids' controls as the code does:\n${problems448.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`the Metrics help names ${new Set(controls.map((c) => c[0])).size} controls of a metric's further semantic ids as the Edit dialog and the drawer label them`);
  }
}
