import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 429. docs/derived-metrics.md documents the derived metrics JSON Schema as it is: every key of a
// derived metric and of an input of a sum, with whether it is required, and no other; the limits and the
// kinds the schema states; and the path the dashboard serves it at.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const DOC = 'docs/derived-metrics.md';
  const SCHEMA_FILE = 'frontend/public/json-schema/derived-metrics.schema.json';
  const schema = JSON.parse(read(SCHEMA_FILE));
  const doc = read(DOC);
  const problems429 = [];
  const { derivedMetric, input } = schema.$defs;
  const sections = [
    ['### A derived metric', derivedMetric],
    ['### An input of a sum', input],
  ];
  let keys = 0;
  for (const [heading, def] of sections) {
    const at = doc.indexOf(`\n${heading}\n`);
    if (at < 0) {
      problems429.push(`${DOC} has no "${heading}" section`);
      continue;
    }
    const rest = doc.slice(at + heading.length + 2);
    const end = rest.search(/\n#{2,3} /);
    const body = end < 0 ? rest : rest.slice(0, end);
    const rows = [...body.matchAll(/^\| `([a-z_]+)` \| ([^|]+) \|/gm)].map((m) => [m[1], m[2].trim()]);
    const documented = rows.map(([key]) => key).sort().join(', ');
    const declared = Object.keys(def.properties).sort().join(', ');
    if (documented !== declared) {
      problems429.push(`${DOC}: "${heading}" documents the keys ${documented}, the schema has ${declared}`);
    }
    for (const [key, says] of rows) {
      const expected = (def.required ?? []).includes(key) ? 'Yes' : 'No';
      if (says !== expected) problems429.push(`${DOC}: "${heading}" says ${key} is "${says}", the schema makes it "${expected}"`);
    }
    keys += rows.length;
  }
  // The limits and the words a reader plans a file by.
  const comma = (n) => n.toLocaleString('en-US');
  const props = derivedMetric.properties;
  const claims = [
    [`up to ${comma(props.description.maxLength)} characters`, "a description's length"],
    [`at most ${comma(schema.maxItems)} derived metrics`, 'the derived metrics in a file'],
    [`a list of at least ${props.states.minItems}`, 'the states of a time in state'],
    [`a list of ${props.inputs.minItems} to ${props.inputs.maxItems}`, 'the inputs of a sum'],
    [`${props.kind.enum.map((k) => `\`${k}\``).join(', ').replace(/, ([^,]*)$/, ' or $1')}`, 'the kinds'],
    [`\`${input.properties.sign.enum[0]}\` to add`, 'the sign that adds'],
    [`\`${input.properties.sign.enum[1]}\` to take`, 'the sign that takes away'],
  ];
  for (const [text, what] of claims) {
    if (!doc.includes(text)) problems429.push(`${DOC} does not say ${what} as the schema holds it: "${text}"`);
  }
  if (!doc.includes('`/json-schema/derived-metrics.schema.json`')) problems429.push(`${DOC} does not name the path the dashboard serves the schema at`);
  if (problems429.length) {
    fail(`docs/derived-metrics.md does not document the JSON Schema as it is:\n${problems429.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`docs/derived-metrics.md documents the ${keys} keys of the derived metrics JSON Schema, with whether each is required, and its limits and kinds`);
  }
}
