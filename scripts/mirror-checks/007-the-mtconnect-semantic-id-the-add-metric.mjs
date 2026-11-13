import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXAMPLES, ok, problems, ROOT, SCHEMA } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 7. The MTConnect semantic id the Add Metric form derives is the id `mtconnect_vocabulary` seeds
// for that data item type, and the id every MTConnect row of the example metrics carries (#457):
// each SELECTs the id of the concept it names, so that concept must be the name's last segment.
// The form's own function is run, so a change to the namespace or the kind segment on either side
// fails here rather than as a form-created metric naming no concept.
// -------------------------------------------------------------------------------------------------
export default async function check() {
  const { mtconnectSemanticId } = await import(pathToFileURL(join(ROOT, 'frontend/src/utils/standards.js')).href);
  const vocabulary = [...SCHEMA.matchAll(
    /^INSERT INTO public\.mtconnect_vocabulary VALUES \('DATA_ITEM_TYPE', '([^']+)', (?:'[^']*'|NULL), '([^']+)'\)/gm
  )];
  // (name, concept) per row of the MTConnect insert: the first and fourth literals of each tuple.
  const mtconnectInsert = EXAMPLES.match(/SELECT[^;]*?'MTConnect'[^;]*?FROM \(VALUES([\s\S]*?)\) AS /);
  const catalog = mtconnectInsert
    ? [...mtconnectInsert[1].matchAll(/\(\s*'([^']+)',\s*\d+,\s*'(?:[^']|'')*',\s*'([^']+)',/g)]
    : [];
  const vocabularyId = new Map(vocabulary.map(([, type, id]) => [type, id]));
  if (vocabulary.length === 0 || catalog.length === 0) {
    problems.push('mtconnectSemanticId: found no seeded DATA_ITEM_TYPE or example MTConnect metric -- the file\'s shape changed, so this check is no longer checking anything');
  } else {
    const derived = (name) => mtconnectSemanticId(name.split('/').pop());
    const strays = [
      ...vocabulary.filter(([, type, id]) => mtconnectSemanticId(type) !== id)
        .map(([, type, id]) => `vocabulary ${type}: seeded ${id}, form derives ${mtconnectSemanticId(type)}`),
      ...catalog.filter(([, name, concept]) => derived(name) !== vocabularyId.get(concept))
        .map(([, name, concept]) => `example ${name}: carries ${concept}'s id ${vocabularyId.get(concept)}, form derives ${derived(name)}`),
    ];
    if (strays.length) problems.push(`mtconnectSemanticId: ${strays.slice(0, 5).join('; ')}`);
    else ok.push(`mtconnectSemanticId: ${vocabulary.length} data item types and ${catalog.length} example metrics agree`);
  }
}
