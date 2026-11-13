import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 374. The documents name a unit's symbol as utils/units.js holds it. A pair is written "**°C** for
// CELSIUS", or "**°C (CELSIUS)**" where the Metrics page says both; each must be the pair UNIT_SYMBOLS
// has. History's help says the symbol is the title's, the Metrics help says both, the README states
// both, and the Devices help's "count/h" is what a rate of COUNT reads as.
// -------------------------------------------------------------------------------------------------
export default async function check() {
  const { UNIT_SYMBOLS, unitSymbol } = await import(pathToFileURL(join(REPO, 'frontend/src/utils/units.js')).href);
  const problems374 = [];
  const CODE = '[A-Z][A-Z0-9_]*(?:[/^][A-Z0-9_]+)*';
  const FOR = new RegExp(`(?:\\*\\*|\`)([^*\`\\n]{1,12})(?:\\*\\*|\`) for \`?(${CODE})\`?`, 'g');
  const BOTH = new RegExp(`(?:\\*\\*|\`)([^*\`()\\n]{1,12}) \\((${CODE})\\)(?:\\*\\*|\`)`, 'g');
  const DOCS = {
    'help/pages/history.md': 'for',
    'help/pages/metrics.md': 'both',
    'help/pages/vocabulary.md': 'both',
    'frontend/README.md': 'for',
  };
  let pairs = 0;
  for (const [file, form] of Object.entries(DOCS)) {
    const text = read(file);
    const found = [...text.matchAll(FOR), ...text.matchAll(BOTH)];
    if (!found.some((m) => (form === 'for' ? / for /.test(m[0]) : m[0].includes('('))) ) {
      problems374.push(`${file} names no unit pair as "${form === 'for' ? '**°C** for CELSIUS' : '**°C (CELSIUS)**'}"`);
    }
    for (const [, symbol, code] of found) {
      pairs += 1;
      if (UNIT_SYMBOLS[code] !== symbol) problems374.push(`${file} gives ${code} the symbol ${symbol}; UNIT_SYMBOLS has ${UNIT_SYMBOLS[code]}`);
    }
  }
  const rate = unitSymbol('COUNT/HOUR');
  if (!read('help/pages/devices.md').includes(`**12 ${rate}**`)) {
    problems374.push(`help/pages/devices.md does not show a derived rate of COUNT as "12 ${rate}", as the dashboard says it`);
  }
  if (problems374.length) {
    fail('the documents name a unit\'s symbol otherwise than utils/units.js holds it:\n' + problems374.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the ${pairs} unit pairs the help and the README name are the symbols UNIT_SYMBOLS holds, and the Devices help's rate reads "${rate}"`);
  }
}
