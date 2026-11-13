import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ok, problems, ROOT, SCHEMA } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 102. The units the Add Metric dialog's Units list offers each have a symbol (utils/units.js). The
// list is the MTConnect vocabulary's UNIT and NATIVE_UNIT rows, which unitNames() reads, seeded by
// 0002. A reader sees `°C` where the catalogue says `CELSIUS`; a code with no entry shows as the
// code, which is what this check is here to prevent. A vocabulary regenerated with a new unit fails
// here until the map names it.
// -------------------------------------------------------------------------------------------------
export default async function check() {
  const { UNIT_SYMBOLS } = await import(pathToFileURL(join(ROOT, 'frontend/src/utils/units.js')).href);
  const offered = [...SCHEMA.matchAll(/^INSERT INTO public\.mtconnect_vocabulary VALUES \('(?:UNIT|NATIVE_UNIT)', '([^']+)'/gm)]
    .map((m) => m[1]);
  if (offered.length === 0) {
    problems.push('unitSymbols: found no seeded UNIT or NATIVE_UNIT -- the file\'s shape changed, so this check is no longer checking anything');
  } else {
    const missing = [...new Set(offered)].filter((code) => !Object.hasOwn(UNIT_SYMBOLS, code) || !String(UNIT_SYMBOLS[code]).trim());
    if (missing.length) problems.push(`unitSymbols: the Add Metric dialog offers ${missing.join(', ')}, which UNIT_SYMBOLS gives no symbol`);
    else ok.push(`unitSymbols: all ${new Set(offered).size} units the Add Metric dialog's list offers have a symbol`);
  }
}
