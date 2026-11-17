import { fail, pass, read, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 438. The docs name the identifiers a shell lists, and the semantic ids they give are the seed's.
// shell.ts writes assetInformation.specificAssetIds under three names, which AAS Discovery will
// match on, so a rename is a break. The API reference and the README name each of them. The README
// and both suites give the IRDIs of the two Nameplate elements the serial number and the product
// URI take their semantic ids from, and 0002 seeds those rows: the shell reads its semantic ids
// from them, so a changed row is a changed identifier.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const SHELL = 'supabase/functions/_shared/aas/shell.ts';
  const problems438 = [];
  const block = read(SHELL).match(/export const SPECIFIC_ASSET_ID_NAMES = \{([\s\S]*?)\} as const;/)?.[1] ?? '';
  const names = Object.fromEntries([...block.matchAll(/^\s*(\w+): "(\w+)",$/gm)].map((m) => [m[1], m[2]]));
  const keys = Object.keys(names);
  if (keys.join() !== 'serialNumber,productUri,sparkplugId') {
    fail(`check 438 read ${keys.length ? keys.join(', ') : 'no names'} from SPECIFIC_ASSET_ID_NAMES in ${SHELL}, not serialNumber, productUri and sparkplugId`);
    return;
  }

  const readme = supabaseReadme();
  for (const [file, text] of [['supabase/README.md', readme], ['docs/openapi.yaml', read('docs/openapi.yaml')]]) {
    for (const name of Object.values(names)) {
      if (!text.includes(`\`${name}\``)) problems438.push(`${file} does not name \`${name}\`, which ${SHELL} writes in specificAssetIds`);
    }
  }

  // The seed's row for an element: its id after the template's own columns.
  const seed = read('supabase/migrations/0002_seed_data.sql');
  const irdi = (idShort) => seed.split(`'Digital Nameplate', '3.0', '${idShort}', '`)[1]?.split("'")[0];
  const irdis = [irdi('SerialNumber'), irdi('URIOfTheProduct')];
  if (irdis.some((id) => !id)) {
    problems438.push('0002_seed_data.sql has no Nameplate row for SerialNumber or URIOfTheProduct');
  } else {
    for (const file of ['supabase/README.md', 'supabase/functions/_shared/aas/specific_asset_ids_test.ts', 'supabase/functions/aas-export/test_specific_asset_ids.py']) {
      const text = file === 'supabase/README.md' ? readme : read(file);
      for (const id of irdis) {
        if (!text.includes(id)) problems438.push(`${file} does not give ${id}, the semantic id 0002 seeds for the Nameplate element`);
      }
    }
  }

  if (problems438.length) {
    fail(`the identifiers a shell lists and the docs disagree:\n${problems438.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`the README and the API reference name the ${keys.length} identifiers a shell lists (${Object.values(names).join(', ')}), and the semantic ids given for two of them are the seed's`);
  }
}
