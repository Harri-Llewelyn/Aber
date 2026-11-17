import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 457. The documents count the VDA 5050 fields the seed holds, list them, and name the 3.0.0 fields
// rather than 2.x's: the vocabulary document's AGV paragraph used to name `batteryCharge`, which
// 3.0.0 renamed `powerSupply.stateOfCharge`. The count is in the vocabulary document (twice), the API
// reference and the architecture table. The vocabulary document's section lists every field, a
// nested one's later siblings by their last segment (`.vy`), and each one listed is a row.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems457 = [];
  const file = readdirSync(join(REPO, 'supabase/migrations')).find((f) => /^\d{4}_.*\.sql$/.test(f) && read(`supabase/migrations/${f}`).includes('CREATE TABLE IF NOT EXISTS public.vda5050_vocabulary'));
  const rows = file
    ? [...read(`supabase/migrations/${file}`).matchAll(/^INSERT INTO public\.vda5050_vocabulary VALUES \('([^']+)',/gm)].map((m) => m[1])
    : [];
  if (rows.length === 0) {
    fail('no migration seeds vda5050_vocabulary -- the file\'s shape changed, so check 457 is no longer checking anything');
    return;
  }
  const n = rows.length;

  const doc = read('docs/vocabularies.md');
  const section = doc.slice(doc.indexOf('## VDA 5050 (AGVs)'), doc.indexOf('## Definition of done'));
  if (!section.startsWith('## VDA 5050 (AGVs)')) problems457.push('docs/vocabularies.md has no "VDA 5050 (AGVs)" section');
  for (const [where, text, claim] of [
    ['the section of docs/vocabularies.md', section, new RegExp(`\\*\\*${n} fields\\*\\*`)],
    ['the scope boundaries of docs/vocabularies.md', doc, new RegExp(`fields that are readings: ${n} of them`)],
    ['docs/openapi.yaml', read('docs/openapi.yaml'), new RegExp(`${n} fields of the VDA 5050 \`state\` message`)],
    ['docs/architecture.md', read('docs/architecture.md'), new RegExp(`the ${n} scalar fields of the \`state\` message`)],
  ]) {
    if (!claim.test(text)) problems457.push(`${where} does not say the vocabulary holds ${n} fields`);
  }

  const list = section.match(/keyed by its path in the message\*\*[^:]*:([\s\S]*?)Each has the schema's type/)?.[1] ?? '';
  const named = [];
  let object = '';
  for (const [, token] of list.matchAll(/`([^`]+)`/g)) {
    if (token.startsWith('.')) {
      named.push(`${object}${token}`);
    } else {
      named.push(token);
      object = token.includes('.') ? token.slice(0, token.indexOf('.')) : '';
    }
  }
  if (named.length === 0) problems457.push('the VDA 5050 section lists no field: its list changed shape, so this read nothing');
  const missing = rows.filter((name) => !named.includes(name));
  const extra = named.filter((name) => !rows.includes(name));
  if (missing.length) problems457.push(`the VDA 5050 section does not list ${missing.join(', ')}, which the seed holds`);
  if (extra.length) problems457.push(`the VDA 5050 section lists ${extra.join(', ')}, which the seed does not hold`);
  if (!section.includes('`AGV`')) problems457.push('the VDA 5050 section does not name the group AGV');

  const boundaries = doc.slice(doc.indexOf('### Scope boundaries'), doc.indexOf('## Extension points'));
  for (const field of ['powerSupply.stateOfCharge', 'mobileRobotPosition', 'safetyState.activeEmergencyStop']) {
    if (!boundaries.includes(field)) problems457.push(`the scope boundaries' AGV paragraph does not name the 3.0.0 field ${field}`);
  }
  if (boundaries.replace('(it was `batteryCharge`)', '').includes('batteryCharge')) {
    problems457.push('the scope boundaries\' AGV paragraph names the 2.x field batteryCharge as if it were a name in use');
  }

  if (problems457.length) {
    fail('the documents and the VDA 5050 seed disagree:\n' + problems457.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the vocabulary document, the API reference and the architecture table count the ${n} VDA 5050 fields the seed holds, the section lists each one, and the AGV paragraph uses the 3.0.0 names`);
  }
}
