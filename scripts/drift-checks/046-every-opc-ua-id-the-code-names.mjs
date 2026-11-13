import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 46. Every OPC UA id the code names is a row the seed holds, under the name the code gives it.
// The AAS exporter's Digital Nameplate join (OPC_MACHINERY in _shared/aas/shell.ts) and the
// dashboard's nameplate form (NAMEPLATE_PUBLISHED_BY in api.js) join a device's published value on
// an OPC 40001 Machinery ExpandedNodeId written into the code. The generator writes the seed's ids
// from the NodeSet, so an id renumbered upstream would leave both joining on nothing, silently.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const seeded = new Map();
  for (const [, name, spec, nodeId] of read('supabase/migrations/0002_seed_data.sql').matchAll(
    /^INSERT INTO public\.opcua_vocabulary VALUES \('((?:[^']|'')*)', '((?:[^']|'')*)', '([^']*)'/gm
  )) seeded.set(nodeId, `${spec}/${name}`);

  const SHELL = 'supabase/functions/_shared/aas/shell.ts';
  const CODE = [SHELL, 'frontend/src/api.js', 'frontend/src/components/common/SemanticIdField.jsx'];
  const named = [...(read(SHELL).match(/export const OPC_MACHINERY = \{([\s\S]*?)\} as const;/)?.[1] ?? '')
    .matchAll(/(\w+): "(nsu=[^"]+)"/g)];
  const offences = [];
  for (const [, name, id] of named) {
    if (seeded.get(id) !== `OPC 40001 Machinery/${name}`) {
      offences.push(`${SHELL}: OPC_MACHINERY.${name} is ${id}, which the seed holds as ${seeded.get(id) ?? 'no row'}`);
    }
  }
  let literals = 0;
  for (const file of CODE) {
    for (const [id] of read(file).matchAll(/nsu=[a-z][\w+.-]*:[^'"`;\s]+;[isgb]=[^'"`\s,)]+/gi)) {
      literals += 1;
      if (!seeded.has(id)) offences.push(`${file}: ${id} is no opcua_vocabulary row in 0002_seed_data.sql`);
    }
  }
  // The form shows a field as published by the device exactly when the exporter would take it.
  const form = (read('frontend/src/api.js').match(/const NAMEPLATE_PUBLISHED_BY = new Map\(\[([\s\S]*?)\]\);/)?.[1] ?? '')
    .match(/nsu=[^']+/g) ?? [];
  if (form.slice().sort().join() !== named.map(([, , id]) => id).sort().join()) {
    offences.push('frontend/src/api.js: NAMEPLATE_PUBLISHED_BY does not name the ids OPC_MACHINERY names');
  }
  if (!seeded.size || named.length !== 6) {
    fail(`check 46 read ${seeded.size} seeded OPC UA ids and ${named.length} OPC_MACHINERY entries (six expected), so it reads nothing`);
  } else if (offences.length) {
    fail(
      'an OPC UA id the code joins on is not the id the seed gives that concept (rerun ' +
        'scripts/generate-opcua-vocabulary.mjs and copy the row\'s semantic_id):\n' +
        offences.map((o) => `        ${o}`).join('\n')
    );
  } else {
    pass(`all ${literals} OPC UA ExpandedNodeId(s) the exporter and the dashboard name are seeded rows, the nameplate's under their own names`);
  }
}
