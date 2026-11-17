import { fail, pass, read, walk } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 453. Each companion specification the seed holds is named where a person meets it: the hint above
// its section on the Vocabulary page (frontend/src/utils/opcua.js), the Vocabulary help's OPC UA
// paragraph, and the architecture document's table of vocabularies. A section with no hint shows as a
// bare number, and a paragraph that lists six specifications beside a seventh is a count nobody can
// tell is stale. OPC 40540's hint says a printer is a machine tool, so the sections that apply to it
// are the ones its reader looks in.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const specs = new Set();
  for (const file of walk('supabase/migrations').filter((f) => /^supabase\/migrations\/[^/]+\.sql$/.test(f))) {
    for (const [, spec] of read(file).matchAll(/^INSERT INTO public\.opcua_vocabulary VALUES \('(?:[^']|'')*', '((?:[^']|'')*)'/gm)) specs.add(spec);
  }
  const number = (spec) => spec.match(/^OPC (\d+(?:-\d+)?)/)?.[1];

  const source = read('frontend/src/utils/opcua.js');
  const hints = new Map([...(source.match(/const hints = \{([\s\S]*?)\n {2}\}/)?.[1] ?? '').matchAll(/^ {4}'([^']+)': '((?:[^'\\]|\\.)*)',?$/gm)].map((m) => [m[1], m[2]]));
  const help = read('help/pages/vocabulary.md').match(/\n### OPC UA\n([\s\S]*?)\n### /)?.[1] ?? '';
  const helpIntro = help.split('\n').find((line) => line.startsWith('Data points from the OPC UA companion specifications')) ?? '';
  const architecture = read('docs/architecture.md').split('\n').find((line) => line.startsWith('| **OPC UA** (')) ?? '';
  const listed = architecture.match(/^\| \*\*OPC UA\*\* \(([^)]*)\)/)?.[1].split(',').map((s) => s.trim()) ?? [];

  const offences = [];
  for (const spec of specs) {
    if (!hints.get(spec)) offences.push(`frontend/src/utils/opcua.js: the hints have none for ${spec}, which the seed holds`);
    if (!helpIntro.includes(`\`OPC ${number(spec)}\``)) offences.push(`help/pages/vocabulary.md: the OPC UA paragraph does not name OPC ${number(spec)}, which the seed holds`);
    if (!listed.includes(number(spec))) offences.push(`docs/architecture.md: the OPC UA row of the vocabulary table does not list ${number(spec)}, which the seed holds`);
  }
  for (const spec of hints.keys()) {
    if (!specs.has(spec)) offences.push(`frontend/src/utils/opcua.js: a hint for ${spec}, which no migration seeds`);
  }
  for (const entry of listed) {
    if (![...specs].some((spec) => number(spec) === entry)) offences.push(`docs/architecture.md: the OPC UA row lists ${entry}, which no migration seeds`);
  }
  if (!/printer is a machine tool/.test(hints.get('OPC 40540 Additive Manufacturing') ?? '')) {
    offences.push('frontend/src/utils/opcua.js: the OPC 40540 hint does not say a printer is a machine tool');
  }

  if (!specs.size || !hints.size || !listed.length || !helpIntro) {
    fail(`check 453 read ${specs.size} specifications, ${hints.size} hints and ${listed.length} architecture entries, so it reads nothing`);
  } else if (offences.length) {
    fail('an OPC UA companion specification is missing from where a person meets it:\n' + offences.map((o) => `        ${o}`).join('\n'));
  } else {
    pass(`each of the ${specs.size} OPC UA specifications the seed holds has a section hint, is named in the Vocabulary help and the architecture table, and the OPC 40540 hint says a printer is a machine tool`);
  }
}
