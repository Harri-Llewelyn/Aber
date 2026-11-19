/**
 * Verify the crosswalk from MTConnect's unit names to QUDT's units against the two files it is
 * between. It fails when an MTConnect unit name is missing from the crosswalk, when the crosswalk
 * names one the vocabulary does not hold, when a unit IRI is not in the QUDT file kept in
 * scripts/vocabularies/ or is deprecated there, and when a name maps to nothing without a reason.
 * No network is needed: the MTConnect names are the seed's (0002) and the QUDT units are the
 * vendored file's, which the generator pins by SHA-256.
 *
 * Usage: node scripts/check-qudt-crosswalk.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { crosswalkProblems, mtconnectUnitNames, units } from './lib/qudt-vocabulary.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

const crosswalk = JSON.parse(read('scripts/vocabularies/mtconnect-units-to-qudt.json'));
const names = mtconnectUnitNames(read('supabase/migrations/0002_seed_data.sql'));
if (names.length < 100) {
  console.error(`QUDT crosswalk check FAILED: found ${names.length} MTConnect unit names in 0002, where 100 existed.`);
  console.error('  The seed\'s form changed, so this check would read nothing.');
  process.exit(1);
}

const problems = crosswalkProblems(crosswalk, names, units(read('scripts/vocabularies/qudt-3.5.2-units.ttl')));
if (problems.length > 0) {
  console.error('QUDT crosswalk check FAILED:');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error('  Edit scripts/vocabularies/mtconnect-units-to-qudt.json, then run: node scripts/generate-qudt-vocabulary.mjs');
  process.exit(1);
}

const mapped = Object.values(crosswalk.units).filter((entry) => entry.unit).length;
console.log(`QUDT crosswalk sound: ${names.length} MTConnect unit names, ${mapped} mapped to a QUDT unit, ${names.length - mapped} to none with a reason.`);
