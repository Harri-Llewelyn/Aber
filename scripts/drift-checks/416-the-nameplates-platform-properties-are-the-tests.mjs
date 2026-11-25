import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 416. The platform's own properties are the ones the export's test names, and none is in the Digital
// Nameplate. The exporter (_shared/aas/shell.ts) writes AssetSparkplugId and the edge gateway's name and id
// in the PlatformConnection submodel, with no semanticId because IDTA defines none for them.
// test_aas_export.py lists those properties to prove none carries an invented identifier. A property that
// joins the submodel and not the list is one nobody checks. One in the nameplate is an element its
// template does not have, which a nameplate that claims the template must not hold.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const SHELL = 'supabase/functions/_shared/aas/shell.ts';
  const TEST = 'supabase/functions/aas-export/test_aas_export.py';
  const shell = read(SHELL);
  const elements = shell.match(/idShort: "PlatformConnection",[\s\S]*?submodelElements: \[([\s\S]*?)\n {4}\],/)?.[1] ?? '';
  // `property(` writes a platform property; the IDTA elements go through `nameplateElement(`.
  const emitted = [...elements.matchAll(/^\s*property\("(\w+)"/gm)].map((m) => m[1]).sort();
  const nameplate = shell.match(/const nameplateElementsHeld = \[([\s\S]*?)\]\.filter\(\(element\) => element !== null\);/)?.[1] ?? '';
  const inNameplate = [...nameplate.matchAll(/^\s*property\("(\w+)"/gm)].map((m) => m[1]);
  const listed = (read(TEST).match(/def test_aber_platform_properties_are_not_given_invented_identifiers[\s\S]*?for id_short in \(([^)]*)\):/)?.[1] ?? '')
    .match(/"\w+"/g)?.map((s) => s.slice(1, -1)).sort() ?? [];
  if (!emitted.length || !listed.length || !nameplate.includes('nameplateElement("YearOfConstruction"')) {
    fail(`check 416 read ${emitted.length} platform properties from ${SHELL} and ${listed.length} from ${TEST}, or not the nameplate's elements, so it reads nothing`);
  } else if (inNameplate.length) {
    fail(`${SHELL} writes ${inNameplate.join(', ')} in the Digital Nameplate, which its template has no element for`);
  } else if (emitted.join() !== listed.join()) {
    fail(
      `The shell's platform properties are not the ones ${TEST} names:\n` +
        `        ${SHELL} writes ${emitted.join(', ')}\n` +
        `        ${TEST} names ${listed.join(', ')}`
    );
  } else {
    pass(`the shell's ${emitted.length} platform properties are in PlatformConnection, and are the ones the export's test names (${emitted.join(', ')})`);
  }
}
