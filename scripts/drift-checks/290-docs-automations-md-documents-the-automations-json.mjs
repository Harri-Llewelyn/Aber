import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 290. docs/automations.md documents the automations JSON Schema as it is: every key of an
// automation, of the threshold trigger and of the alert action, with whether it is required, and
// no other; the limits the schema states; and the path the dashboard serves it at.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const DOC = 'docs/automations.md';
  const SCHEMA_FILE = 'frontend/public/json-schema/automations.schema.json';
  const schema = JSON.parse(read(SCHEMA_FILE));
  const doc = read(DOC);
  const problems290 = [];
  const { automation, thresholdTrigger, alertAction } = schema.$defs;
  const sections = [
    ['### An automation', automation],
    ['### The `threshold` trigger', thresholdTrigger],
    ['### The `alert` action', alertAction],
  ];
  let keys = 0;
  for (const [heading, def] of sections) {
    const at = doc.indexOf(`\n${heading}\n`);
    if (at < 0) {
      problems290.push(`${DOC} has no "${heading}" section`);
      continue;
    }
    const rest = doc.slice(at + heading.length + 2);
    const end = rest.search(/\n#{2,3} /);
    const body = end < 0 ? rest : rest.slice(0, end);
    const rows = [...body.matchAll(/^\| `([a-z]+)` \| ([^|]+) \|/gm)].map((m) => [m[1], m[2].trim()]);
    const documented = rows.map(([key]) => key).sort().join(', ');
    const declared = Object.keys(def.properties).sort().join(', ');
    if (documented !== declared) {
      problems290.push(`${DOC}: "${heading}" documents the keys ${documented}, the schema has ${declared}`);
    }
    const oneOf = new Set((def.oneOf ?? []).flatMap((branch) => branch.required ?? []));
    for (const [key, says] of rows) {
      const expected = (def.required ?? []).includes(key) ? 'Yes' : oneOf.has(key) ? 'One of the two' : 'No';
      if (says !== expected) problems290.push(`${DOC}: "${heading}" says ${key} is "${says}", the schema makes it "${expected}"`);
    }
    keys += rows.length;
  }
  // The limits a reader plans a file by.
  const comma = (n) => n.toLocaleString('en-US');
  const props = automation.properties;
  const hold = Number(thresholdTrigger.properties.for.pattern.match(/\{0,(\d)\}/)?.[1]) + 1;
  const claims = [
    [`1 to ${Number(props.id.pattern.match(/\{0,(\d+)\}/)?.[1]) + 1} lowercase letters`, 'the length of an id'],
    [`1 to ${props.alias.maxLength} characters`, "an alias's length"],
    [`up to ${comma(props.description.maxLength)} characters`, "a description's length"],
    [`at most ${props.triggers.maxItems} triggers`, 'the triggers in an automation'],
    [`a list of 1 to ${thresholdTrigger.properties.device.oneOf[1].maxItems}`, 'the devices in a trigger'],
    [`up to ${10 ** hold - 1} of one unit`, 'the digits of a hold'],
  ];
  for (const [text, what] of claims) {
    if (!doc.includes(text)) problems290.push(`${DOC} does not say ${what} as the schema holds it: "${text}"`);
  }
  if (!doc.includes('`/json-schema/automations.schema.json`')) problems290.push(`${DOC} does not name the path the dashboard serves the schema at`);
  if (problems290.length) {
    fail(`docs/automations.md does not document the JSON Schema as it is:\n${problems290.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`docs/automations.md documents the ${keys} keys of the automations JSON Schema, with whether each is required, and its limits`);
  }
}
