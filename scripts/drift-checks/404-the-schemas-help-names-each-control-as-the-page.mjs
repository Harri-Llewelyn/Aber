import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 404. The Schemas help names each control of an export and an upload as the page labels it, and each
// status the preview draws. The help is written to be followed: "choose **Upload**" in a page whose
// button says Load sends a reader looking for a control that is not there. A schema has one export,
// so the drawer says Export YAML, and neither it nor the detail dialog offers Download JSON.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const HELP = 'help/pages/schemas.md';
  const help = read(HELP);
  const PAGE = 'frontend/src/components/tabs/SchemasTab.jsx';
  const page = read(PAGE);
  const MODAL = 'frontend/src/components/modals/ApplySchemasModal.jsx';
  const problems404 = [];
  const labels = ['Upload', 'Export', 'Export (', 'Export YAML', 'Build Schema from Catalog', 'Edit Draft', 'Create Version', 'Apply'];
  for (const label of labels) {
    const named = label.endsWith('(') ? 'Export (2)' : label;
    if (!help.includes(`**${named}**`) && !help.includes(`**${named} vN**`)) problems404.push(`${HELP} does not name **${named}**`);
    const where = label === 'Apply' ? read(MODAL) : page;
    if (!where.includes(label)) problems404.push(`${label === 'Apply' ? MODAL : PAGE} no longer has a control called ${label}, which ${HELP} names`);
  }
  for (const status of ['New', 'Changed', 'Unchanged', 'Refused']) {
    if (!help.includes(`**${status}**`)) problems404.push(`${HELP} does not name the preview's **${status}**`);
  }
  if (!page.includes("label: 'Export YAML'")) problems404.push(`${PAGE} has no drawer action Export YAML`);
  if (page.includes("label: 'Download JSON'")) problems404.push(`${PAGE} still offers Download JSON in the drawer, where a schema has one export, Export YAML`);
  const DETAIL = 'frontend/src/components/modals/SchemaDetailModal.jsx';
  if (read(DETAIL).includes('Download JSON')) problems404.push(`${DETAIL} still offers Download JSON, where a schema has one export, Export YAML`);
  if (!help.includes('device-schemas.yaml') || !read('frontend/src/utils/deviceSchemas.js').includes("'device-schemas.yaml'")) {
    problems404.push(`${HELP} and utils/deviceSchemas.js do not both say the file is device-schemas.yaml`);
  }
  if (!/\]\((\.\.\/)+docs\/device-schemas\.md\)/.test(help)) problems404.push(`${HELP} does not link to docs/device-schemas.md, the format's reference`);
  if (problems404.length) {
    fail(`the Schemas help does not name the page's controls as the code does:\n${problems404.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`the Schemas help names ${labels.length} controls and the 4 preview statuses as the page labels them, and says the drawer's one export is Export YAML`);
  }
}
