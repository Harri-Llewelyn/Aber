import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 433. The example in docs/derived-metrics.md uses only keys the JSON Schema has, at the level it has
// them, and shows each required one. An example is what a reader copies: a key the schema dropped, or
// an input's key written on a metric, is a file that is refused the first time it is uploaded. It shows
// each kind, so a reader finds the keys of the one they want.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const DOC = 'docs/derived-metrics.md';
  const schema = JSON.parse(read('frontend/public/json-schema/derived-metrics.schema.json'));
  const doc = read(DOC);
  const problems433 = [];
  const example = doc.match(/\n## An example\n+```yaml\n([\s\S]*?)\n```/)?.[1];
  if (!example) {
    problems433.push(`${DOC} has no yaml example under "An example"`);
  } else {
    const { derivedMetric, input } = schema.$defs;
    // Block YAML, as the page writes it: a key at column 2 (after a dash or two spaces) is a metric's, one
    // at column 6, inside `inputs:`, an input's.
    const seen = { metric: new Set(), input: new Set() };
    const kinds = new Set();
    for (const line of example.split('\n')) {
      const m = line.match(/^( *)(?:- )?([a-z_]+):(?: (.*))?$/);
      if (!m) continue;
      const column = m[1].length + (line.trimStart().startsWith('- ') ? 2 : 0);
      const level = column <= 2 ? 'metric' : 'input';
      seen[level].add(m[2]);
      if (level === 'metric' && m[2] === 'kind') kinds.add(m[3]);
      const def = level === 'metric' ? derivedMetric : input;
      if (!(m[2] in def.properties)) problems433.push(`${DOC}: the example writes ${m[2]} on ${level === 'metric' ? 'a derived metric' : 'an input'}, which the schema does not take there`);
    }
    for (const [level, def] of [['metric', derivedMetric], ['input', input]]) {
      for (const key of def.required ?? []) {
        if (!seen[level].has(key)) problems433.push(`${DOC}: the example has no ${key} on ${level === 'metric' ? 'a derived metric' : 'an input'}, which the schema requires`);
      }
    }
    for (const kind of derivedMetric.properties.kind.enum) {
      if (!kinds.has(kind)) problems433.push(`${DOC}: the example shows no ${kind}`);
    }
    // The keys a kind takes are in the example for that kind.
    for (const key of ['input', 'states', 'inputs']) {
      if (!seen.metric.has(key)) problems433.push(`${DOC}: the example never writes ${key}`);
    }
  }
  if (problems433.length) {
    fail(`the example in docs/derived-metrics.md is not a file the schema takes:\n${problems433.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass('the example in docs/derived-metrics.md uses only keys the derived metrics JSON Schema takes, shows each required one and each kind');
  }
}
