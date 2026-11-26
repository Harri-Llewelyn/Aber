import { compare, need, problems, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 180. The nameplate i3X carries is the one the shell exports. buildEnvironment() (_shared/aas/shell.ts)
// writes a device's Digital Nameplate from device_nameplate's columns, each under the template's idShort,
// and i3x/address_space.py gives a device's Nameplate component the same fields from the same columns.
// A field one adds and the other lacks is a nameplate the two views of one device disagree about. The
// template the component's type names, and its namespace, are the shell's too.
// -------------------------------------------------------------------------------------------------
const pairs = (text, re) => [...text.matchAll(re)].map((m) => `${m[1]} <- ${m[2]}`).sort();

export default function check() {
  const shell = read('supabase/functions/_shared/aas/shell.ts');
  const python = read('i3x/address_space.py');

  const exported = pairs(shell, /nameplateElement\(\s*"(\w+)",\s*nameplate\?\.(\w+)/g);
  const exportedAddress = pairs(shell, /addressElement\("(\w+)", nameplate\?\.(\w+)\)/g);
  const fields = need(python, /\nNAMEPLATE_FIELDS = \(([\s\S]*?)\n\)/, 'NAMEPLATE_FIELDS in i3x/address_space.py');
  const address = need(python, /\nNAMEPLATE_ADDRESS_FIELDS = \(([\s\S]*?)\n\)/, 'NAMEPLATE_ADDRESS_FIELDS in i3x/address_space.py');
  if (!fields || !address) return;
  if (exported.length < 10 || exportedAddress.length < 4) {
    problems.push(`nameplateInI3x: ${exported.length} nameplate and ${exportedAddress.length} address fields read out of shell.ts, so this check is no longer checking anything`);
    return;
  }
  const carried = pairs(fields[1], /\("(\w+)", "(\w+)"\)/g);
  const carriedAddress = pairs(address[1], /\("(\w+)", "(\w+)"\)/g);
  compare('nameplateInI3x', 'the nameplate fields the shell exports and i3X carries, each from its column', carried.join('; '), exported.join('; '));
  compare('nameplateInI3x', "the AddressInformation fields the shell exports and i3X carries", carriedAddress.join('; '), exportedAddress.join('; '));

  const shellTemplate = need(shell, /export const NAMEPLATE_TEMPLATE_ID = "([^"]+)";/, 'NAMEPLATE_TEMPLATE_ID in shell.ts');
  const i3xTemplate = need(python, /^NAMEPLATE_TEMPLATE_ID = "([^"]+)"$/m, 'NAMEPLATE_TEMPLATE_ID in i3x/address_space.py');
  const namespace = need(python, /^NS_NAMEPLATE = "([^"]+)" \+ PROJECTION_SUFFIX$/m, 'NS_NAMEPLATE in i3x/address_space.py');
  if (!shellTemplate || !i3xTemplate || !namespace) return;
  compare('nameplateInI3x', 'the nameplate template the shell claims and the i3X type names', i3xTemplate[1], shellTemplate[1]);
  compare('nameplateInI3x', "the i3X type's namespace and the template's", namespace[1], shellTemplate[1].slice(0, shellTemplate[1].lastIndexOf('/')));
}
