import { fail, pass, read, upgradingGuide } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 609. Where a schema names its derived metrics, and what an old file of schemas does to them, are
// said as they are. The section the editor draws, the drawer's field, the file's key and the help's
// name for each are one; and the help, the format's reference, the upgrade note and the upload's own
// warning all say that a file exported before 1.10 names none, and so takes them away. A person who
// applies one without reading that loses every derived metric the file's schemas had.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems609 = [];
  const flat = (text) => text.replace(/\s+/g, ' ');
  const help = flat(read('help/pages/schemas.md'));
  const section = read('frontend/src/components/common/SchemaDerivedMetrics.jsx');
  const drawer = read('frontend/src/components/tabs/SchemasTab.jsx');
  const schema = JSON.parse(read('frontend/public/json-schema/device-schemas.schema.json')).$defs.deviceSchema.properties;

  // The section and the field by one name, and the key the file has.
  const named = section.match(/<IconTag size=\{13\} \/> ([A-Z][A-Za-z ]+?)\{' '\}/)?.[1];
  if (!named) problems609.push('could not read the name of the section out of SchemaDerivedMetrics.jsx');
  else {
    if (!drawer.includes(`label: '${named}'`)) problems609.push(`SchemasTab.jsx's drawer has no field called ${named}, as the editor's section is`);
    if (!help.includes(`- **${named}**, below the metrics, is where a schema names`)) problems609.push(`help/pages/schemas.md does not say the editor's section is called **${named}**`);
  }
  const key = Object.keys(schema).find((k) => k.startsWith('derived'));
  if (!key || !help.includes(`\`${key}\``) || !read('frontend/src/utils/deviceSchemaYaml.js').includes(`'${key}'`)) {
    problems609.push(`the JSON Schema, an export and help/pages/schemas.md do not all name the file's key (${key})`);
  }
  // The editor draws it once, for every dialog a schema is met in.
  if (!read('frontend/src/components/common/SchemaEditor.jsx').includes('<SchemaDerivedMetrics')) problems609.push('SchemaEditor.jsx does not draw SchemaDerivedMetrics, so a dialog has its own or none');

  // What an old file does.
  const note = upgradingGuide().match(/\n### From 1\.10\.0, a schema names the derived metrics its devices get\n([\s\S]*?)(?=\n### |\n## |$)/)?.[1];
  if (!note) problems609.push('the upgrade guide has no "From 1.10.0, a schema names the derived metrics its devices get" section');
  const claims = [
    ['help/pages/schemas.md', help, 'A file exported before Aber 1.10 has no such list'],
    ['docs/device-schemas.md', flat(read('docs/device-schemas.md')), 'A file exported before Aber 1.10 has no such key'],
    ['the upgrade note', flat(note ?? ''), '**Such a file takes the derived metrics away when you apply it.**'],
    ['ApplySchemasModal.jsx', flat(read('frontend/src/components/modals/ApplySchemasModal.jsx')), 'a file exported before Aber 1.10 names none'],
  ];
  for (const [where, text, said] of claims) if (!text.includes(said)) problems609.push(`${where} does not say "${said}"`);
  // What the fill cannot carry is found in db-init's log by the words the note gives.
  if (note && !flat(note).includes('lines that start `0336:`')) problems609.push('the upgrade note does not say which lines of the db-init log name the devices it cannot carry');

  if (problems609.length) {
    fail(`Where a schema names its derived metrics is not said as it is:\n${problems609.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`the editor's section, the drawer and the help call it ${named}, and ${claims.length} places say a file exported before 1.10 names none`);
  }
}
