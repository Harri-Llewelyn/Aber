import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 416. The Digital Nameplate's platform properties are the ones the export's test names. The exporter
// (_shared/aas/shell.ts) writes AssetSparkplugId and the edge gateway's name and id beside the IDTA
// elements, with no semanticId because IDTA defines none for them. test_aas_export.py lists those
// properties to prove none carries an invented identifier, and skips one that is absent: so a
// property that leaves the shell, or joins it, is a list nobody notices has gone stale.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const SHELL = 'supabase/functions/_shared/aas/shell.ts';
  const TEST = 'supabase/functions/aas-export/test_aas_export.py';
  const elements = read(SHELL).match(/const nameplateProps = \[([\s\S]*?)\]\.filter\(/)?.[1] ?? '';
  // `property(` writes a platform property; the IDTA elements go through `nameplateProperty(`.
  const emitted = [...elements.matchAll(/^\s*property\("(\w+)"/gm)].map((m) => m[1]).sort();
  const listed = (read(TEST).match(/def test_aber_nameplate_properties_are_not_given_invented_identifiers[\s\S]*?for id_short in \(([^)]*)\):/)?.[1] ?? '')
    .match(/"\w+"/g)?.map((s) => s.slice(1, -1)).sort() ?? [];
  if (!emitted.length || !listed.length) {
    fail(`check 416 read ${emitted.length} platform properties from ${SHELL} and ${listed.length} from ${TEST}, so it reads nothing`);
  } else if (emitted.join() !== listed.join()) {
    fail(
      `The nameplate's platform properties are not the ones ${TEST} names:\n` +
        `        ${SHELL} writes ${emitted.join(', ')}\n` +
        `        ${TEST} names ${listed.join(', ')}`
    );
  } else {
    pass(`the nameplate's ${emitted.length} platform properties are the ones the export's test names (${emitted.join(', ')})`);
  }
}
