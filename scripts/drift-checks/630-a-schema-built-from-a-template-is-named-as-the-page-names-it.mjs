import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 630. Build Schema from Template is named alike on the Schemas page, in its dialog, on the Templates
// tab and in the help that says how to use it (0342). The help is written to be followed, so a control
// it names must be on the page under that name. The format's reference and the JSON Schema both know
// `template` (0343), and the export rule is the one 0342's note names.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems630 = [];
  const flat = (text) => text.replace(/\s+/g, ' ');
  const schemasHelp = flat(read('help/pages/schemas.md'));
  const vocabularyHelp = flat(read('help/pages/vocabulary.md'));

  const controls = [
    ['Build Schema from Template', 'frontend/src/components/tabs/SchemasTab.jsx', schemasHelp, 'help/pages/schemas.md'],
    ['Build Schema from Template', 'frontend/src/components/modals/SchemaBuilderModal.jsx', schemasHelp, 'help/pages/schemas.md'],
    ['Template Elements', 'frontend/src/components/common/SchemaTemplateElements.jsx', schemasHelp, 'help/pages/schemas.md'],
    ['Required', 'frontend/src/components/common/SchemaTemplateElements.jsx', schemasHelp, 'help/pages/schemas.md'],
    ['Build Schema', 'frontend/src/components/common/IDTATemplatePanel.jsx', vocabularyHelp, 'help/pages/vocabulary.md'],
  ];
  for (const [label, file, help, helpFile] of controls) {
    if (!read(file).includes(label)) problems630.push(`${file} no longer says ${label}, which ${helpFile} names`);
    if (!help.includes(`**${label}**`)) problems630.push(`${helpFile} does not name **${label}**`);
  }
  if (!read('frontend/src/components/common/SchemaEditor.jsx').includes('>Template <RequiredMark')) {
    problems630.push('the schema editor has no field labelled Template, which help/pages/schemas.md names');
  }
  if (!schemasHelp.includes('**Template**')) problems630.push('help/pages/schemas.md does not name the **Template** field');

  const schema = JSON.parse(read('frontend/public/json-schema/device-schemas.schema.json')).$defs.deviceSchema.properties;
  if (!schema.template) problems630.push('device-schemas.schema.json has no `template`');
  if (!read('docs/device-schemas.md').includes('| `template` | No |')) problems630.push('docs/device-schemas.md has no row for `template`');
  if (!schemasHelp.includes('`template`')) problems630.push('help/pages/schemas.md does not say what `template` in a file does');
  if (!read('unreleased/migrations/0342.md').includes('supabase/functions/_shared/schemaTemplate.ts')
      && !read('supabase/README.md').includes('supabase/functions/_shared/schemaTemplate.ts')) {
    problems630.push("neither 0342's note nor supabase/README.md names the export rule, _shared/schemaTemplate.ts");
  }

  if (problems630.length) {
    fail(`Build Schema from Template is not named alike where it is used and explained:\n${problems630.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`Build Schema from Template, its Template field, Template Elements, Required and the Templates tab's Build Schema are named alike on the page and in the help, and the file format knows \`template\``);
  }
}
