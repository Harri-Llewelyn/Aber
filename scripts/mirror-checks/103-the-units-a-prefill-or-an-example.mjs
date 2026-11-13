import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXAMPLES, ok, problems, ROOT, SCHEMA } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 103. The units a prefill or an example brings have a symbol too, and the map holds no other. The
// ISO 22400 and OPC UA vocabularies carry a unit each, which the dialog prefills (HOUR and
// MILLISECOND are in no MTConnect list); the example metrics db-init loads carry units of their own
// (PARTS/MILLION is QUDT's, not MTConnect's). Every entry of UNIT_SYMBOLS is offered by one of the
// four places, so the map cannot hold a code nothing can produce.
// -------------------------------------------------------------------------------------------------
export default async function check() {
  const { UNIT_SYMBOLS } = await import(pathToFileURL(join(ROOT, 'frontend/src/utils/units.js')).href);
  const literal = "(?:'(?:[^']|'')*'|NULL)";
  const unit = (m) => (m === 'NULL' ? null : m.slice(1, -1));
  const iso = [...SCHEMA.matchAll(new RegExp(`^INSERT INTO public\\.iso22400_vocabulary VALUES \\((?:${literal}, ){4}(${literal}),`, 'gm'))]
    .map((m) => unit(m[1]));
  const opcua = [...SCHEMA.matchAll(new RegExp(`^INSERT INTO public\\.opcua_vocabulary VALUES \\((?:${literal}, ){5}(${literal}),`, 'gm'))]
    .map((m) => unit(m[1]));
  // A catalogue row of the example metrics: name, datatype, description, a fourth literal, then the unit.
  const examples = [...EXAMPLES.matchAll(/\(\s*'[^']+',\s*\d+,\s*'(?:[^']|'')*',\s*'[^']*',\s*'([^']+)'/g)].map((m) => m[1]);
  const mtconnect = [...SCHEMA.matchAll(/^INSERT INTO public\.mtconnect_vocabulary VALUES \('(?:UNIT|NATIVE_UNIT)', '([^']+)'/gm)].map((m) => m[1]);
  const brought = new Set([...iso, ...opcua, ...examples].filter(Boolean));
  if (iso.length === 0 || opcua.length === 0 || examples.length === 0 || brought.size === 0) {
    problems.push('unitSymbols: found no ISO 22400, OPC UA or example unit -- the file\'s shape changed, so this check is no longer checking anything');
  } else {
    const missing = [...brought].filter((code) => !Object.hasOwn(UNIT_SYMBOLS, code));
    const offered = new Set([...mtconnect, ...brought]);
    const stray = Object.keys(UNIT_SYMBOLS).filter((code) => !offered.has(code));
    if (missing.length) problems.push(`unitSymbols: a prefill or an example carries ${missing.join(', ')}, which UNIT_SYMBOLS gives no symbol`);
    if (stray.length) problems.push(`unitSymbols: UNIT_SYMBOLS names ${stray.join(', ')}, which no vocabulary or example offers`);
    if (!missing.length && !stray.length) {
      ok.push(`unitSymbols: the ${brought.size} units the ISO 22400, OPC UA and example rows bring have a symbol, and the map holds only the ${offered.size} codes offered`);
    }
  }
}
