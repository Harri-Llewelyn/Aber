import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 405. The example in docs/device-schemas.md uses only keys the JSON Schema has, at the level it has
// them, and shows each required one. An example is what a reader copies: a key the schema dropped, or
// a metric key written on a schema, is a file that is refused the first time it is uploaded.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const DOC = 'docs/device-schemas.md';
  const schema = JSON.parse(read('frontend/public/json-schema/device-schemas.schema.json'));
  const doc = read(DOC);
  const problems405 = [];
  const example = doc.match(/\n## An example\n+```yaml\n([\s\S]*?)\n```/)?.[1];
  if (!example) {
    problems405.push(`${DOC} has no yaml example under "An example"`);
  } else {
    const { deviceSchema, metric } = schema.$defs;
    // Block YAML, as the page writes it: a key at two spaces is a schema's, one inside `metrics:` a metric's.
    const seen = { schema: new Set(), metric: new Set() };
    for (const line of example.split('\n')) {
      const m = line.match(/^( *)(?:- )?([a-z_]+):/);
      if (!m) continue;
      const column = m[1].length + (line.trimStart().startsWith('- ') ? 2 : 0);
      const level = column <= 2 ? 'schema' : 'metric';
      seen[level].add(m[2]);
      const def = level === 'schema' ? deviceSchema : metric;
      if (!(m[2] in def.properties)) problems405.push(`${DOC}: the example writes ${m[2]} on a ${level}, which the schema does not take there`);
    }
    for (const [level, def] of [['schema', deviceSchema], ['metric', metric]]) {
      for (const key of def.required ?? []) {
        if (!seen[level].has(key)) problems405.push(`${DOC}: the example has no ${key} on a ${level}, which the schema requires`);
      }
    }
  }
  if (problems405.length) {
    fail(`the example in docs/device-schemas.md is not a file the schema takes:\n${problems405.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass('the example in docs/device-schemas.md uses only keys the device schemas JSON Schema takes, and shows each required one');
  }
}
