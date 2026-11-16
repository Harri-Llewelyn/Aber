import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 401. docs/device-schemas.md documents the device schemas JSON Schema as it is: every key of a
// schema and of a metric, with whether it is required, and no other; the limits the schema states;
// and the path the dashboard serves it at.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const DOC = 'docs/device-schemas.md';
  const SCHEMA_FILE = 'frontend/public/json-schema/device-schemas.schema.json';
  const schema = JSON.parse(read(SCHEMA_FILE));
  const doc = read(DOC);
  const problems401 = [];
  const { deviceSchema, metric } = schema.$defs;
  const sections = [
    ['### A schema', deviceSchema],
    ['### A metric', metric],
  ];
  let keys = 0;
  for (const [heading, def] of sections) {
    const at = doc.indexOf(`\n${heading}\n`);
    if (at < 0) {
      problems401.push(`${DOC} has no "${heading}" section`);
      continue;
    }
    const rest = doc.slice(at + heading.length + 2);
    const end = rest.search(/\n#{2,3} /);
    const body = end < 0 ? rest : rest.slice(0, end);
    const rows = [...body.matchAll(/^\| `([a-z_]+)` \| ([^|]+) \|/gm)].map((m) => [m[1], m[2].trim()]);
    const documented = rows.map(([key]) => key).sort().join(', ');
    const declared = Object.keys(def.properties).sort().join(', ');
    if (documented !== declared) {
      problems401.push(`${DOC}: "${heading}" documents the keys ${documented}, the schema has ${declared}`);
    }
    for (const [key, says] of rows) {
      const expected = (def.required ?? []).includes(key) ? 'Yes' : 'No';
      if (says !== expected) problems401.push(`${DOC}: "${heading}" says ${key} is "${says}", the schema makes it "${expected}"`);
    }
    keys += rows.length;
  }
  // The limits a reader plans a file by.
  const comma = (n) => n.toLocaleString('en-US');
  const props = deviceSchema.properties;
  const claims = [
    [`1 to ${props.name.maxLength} characters`, "the length of a name"],
    [`up to ${comma(props.description.maxLength)} characters`, "a description's length"],
    [`1 to ${comma(props.semantic_id.maxLength)} characters`, "a semantic id's length"],
    [`up to ${comma(props.change_description.maxLength)} characters`, "a change description's length"],
    [`a list of ${props.metrics.minItems} to ${comma(props.metrics.maxItems)}`, 'the metrics in a schema'],
    [`at most ${schema.maxItems} schemas`, 'the schemas in a file'],
    [`at most ${comma(props.metrics.maxItems)} metrics`, 'the metrics a schema holds'],
    [`${props.semantic_id_type.enum.map((t) => `\`${t}\``).join(', ').replace(/, ([^,]*)$/, ' or $1')}`, 'the types of a semantic id'],
  ];
  for (const [text, what] of claims) {
    if (!doc.includes(text)) problems401.push(`${DOC} does not say ${what} as the schema holds it: "${text}"`);
  }
  if (!doc.includes('`/json-schema/device-schemas.schema.json`')) problems401.push(`${DOC} does not name the path the dashboard serves the schema at`);
  if (problems401.length) {
    fail(`docs/device-schemas.md does not document the JSON Schema as it is:\n${problems401.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`docs/device-schemas.md documents the ${keys} keys of the device schemas JSON Schema, with whether each is required, and its limits`);
  }
}
