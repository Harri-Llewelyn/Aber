import { fail, pass, read, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 629. aas-api's Registry and Discovery answer from the shells it builds, and the README states what
// IDTA's test engine measured. registry.ts and discovery.ts build no shell of their own; Discovery
// leaves replay lanes out of its index; its candidates are read from where buildEnvironment() takes a
// serial number and a product URI, so a new source in shell.ts that Discovery lacks is a shell it
// cannot find. The README's version and pass counts are the conformance script's, and CI installs
// that version and runs that script.
// -------------------------------------------------------------------------------------------------
const SERIAL = 'partInstanceId';
const PRODUCT = 'uriOfTheProduct';

/** The arguments of buildEnvironment()'s nameplateElement() call for one element, or null. */
function nameplateCall(shell, element) {
  const at = shell.search(new RegExp(`nameplateElement\\(\\s*"${element}",`));
  if (at < 0) return null;
  let depth = 0;
  for (let i = shell.indexOf('(', at); i < shell.length; i++) {
    if (shell[i] === '(') depth++;
    else if (shell[i] === ')' && --depth === 0) return shell.slice(at, i + 1);
  }
  return null;
}

/** One `{ [SPECIFIC_ASSET_ID_NAMES.x]: ... }` table of discovery.ts, as { name: text }. */
function table(discovery, constant) {
  const body = discovery.match(new RegExp(`const ${constant}[^=]*= \\{([\\s\\S]*?)\\n\\};`))?.[1] ?? '';
  const names = { serialNumber: SERIAL, productUri: PRODUCT };
  return Object.fromEntries([...body.matchAll(/\[SPECIFIC_ASSET_ID_NAMES\.(\w+)\]:\s*([^\n]*?),?$/gm)]
    .map((m) => [names[m[1]] ?? m[1], m[2].trim()]));
}

export default function check() {
  const problems629 = [];
  const registry = read('supabase/functions/aas-api/registry.ts');
  const discovery = read('supabase/functions/aas-api/discovery.ts');
  const shells = read('supabase/functions/aas-api/shells.ts');
  const shell = read('supabase/functions/_shared/aas/shell.ts');
  const index = read('supabase/functions/aas-api/index.ts');

  for (const [file, text] of [['registry.ts', registry], ['discovery.ts', discovery]]) {
    if (/modelType:\s*"AssetAdministrationShell"|loadDeviceRecord\(|buildEnvironment\(/.test(text.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, ''))) {
      problems629.push(`aas-api/${file} builds a shell of its own rather than through shells.ts`);
    }
    if (!/from "\.\/shells\.ts"/.test(text)) problems629.push(`aas-api/${file} does not read its shells through shells.ts`);
  }
  if (!/buildEnvironment\(record\)/.test(shells)) problems629.push('aas-api/shells.ts does not build shells with buildEnvironment()');

  // The index leaves out lanes in both of its reads, and one shell's links come only from an indexed shell.
  const indexed = discovery.match(/async function indexedDevices\([\s\S]*?\n\}/)?.[0] ?? '';
  if (!/\.is\("shadow_of", null\)/.test(indexed)) problems629.push('Discovery\'s candidates are not read with shadow_of IS NULL, so a replay lane is indexed');
  if (!/devicePage\(client, limit, rawCursor, \{ lanes: false \}\)/.test(discovery)) problems629.push('Discovery\'s unfiltered listing includes replay lanes');
  if (!/shellById\(client, identifier, \{ lanes: false \}\)/.test(discovery)) problems629.push('Discovery lists a replay lane\'s links');

  // Where buildEnvironment() takes each value, and where Discovery looks for it.
  const columns = table(discovery, 'NAMEPLATE_COLUMNS');
  const fallbacks = table(discovery, 'FALLBACK_METRICS');
  const published = table(discovery, 'PUBLISHED_AS');
  for (const [name, element] of [[SERIAL, 'SerialNumber'], [PRODUCT, 'URIOfTheProduct']]) {
    const call = nameplateCall(shell, element);
    if (!call) {
      problems629.push(`shell.ts has no nameplateElement("${element}", ...) call, which Discovery reads ${name} from`);
      continue;
    }
    const recorded = [...call.matchAll(/nameplate\?\.(\w+)/g)].map((m) => m[1]);
    const birth = [...call.matchAll(/valueFor\("([^"]+)"\)/g)].map((m) => m[1]);
    const concept = call.match(/OPC_MACHINERY\.(\w+)/)?.[1];
    if (recorded.join() !== (columns[name] ?? '').replace(/"/g, '')) {
      problems629.push(`${name}: shell.ts reads device_nameplate.${recorded.join(', ')}, and Discovery looks in ${columns[name] ?? 'nothing'}`);
    }
    const listed = [...(fallbacks[name] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (birth.join() !== listed.join()) problems629.push(`${name}: shell.ts falls back to the metrics ${birth.join(', ') || 'none'}, and Discovery to ${listed.join(', ') || 'none'}`);
    if (`OPC_MACHINERY.${concept}` !== published[name]) problems629.push(`${name}: shell.ts reads the concept OPC_MACHINERY.${concept}, and Discovery ${published[name] ?? 'none'}`);
  }

  // The profiles: the Registry's read profile is declared, Discovery's full one is not.
  if (!index.includes('"https://admin-shell.io/aas/API/3/0/AssetAdministrationShellRegistryServiceSpecification/SSP-002"')) {
    problems629.push('aas-api does not declare the AAS Registry\'s read profile');
  }
  if (/DiscoveryServiceSpecification\/SSP-00\d"/.test(index)) problems629.push('aas-api declares a Discovery profile, whose only one includes the writes');

  // The statement, the script and CI.
  const script = read('test-harness/aas_conformance.py');
  const pinned = script.match(/^PINNED = "([^"]+)"$/m)?.[1];
  const passing = (profile) => (script.match(new RegExp(`"${profile}": \\[([\\s\\S]*?)\\]`))?.[1].match(/"[^"]+"/g) ?? []).length;
  const readme = supabaseReadme();
  const statement = readme.match(/- \*\*IDTA's own test engine, `aas-test-engines` ([\d.]+): ([^*]+)\.\*\*([\s\S]*?)\n- /);
  if (!pinned) problems629.push('test-harness/aas_conformance.py has no PINNED version');
  if (!statement) {
    problems629.push('supabase/README.md has no "IDTA\'s own test engine, `aas-test-engines` <version>" statement');
  } else {
    if (statement[1] !== pinned) problems629.push(`the README states aas-test-engines ${statement[1]}, and the script pins ${pinned}`);
    const counts = statement[3].replace(/\s+/g, ' ').match(/(\d+) of the first's (\d+) operations pass, and (\d+) of the second's (\d+)/);
    if (!counts) problems629.push('the README\'s statement does not say how many of each profile\'s operations pass');
    else {
      if (Number(counts[1]) !== passing('aas-repository')) problems629.push(`the README says ${counts[1]} AAS Repository operations pass, and the script records ${passing('aas-repository')}`);
      if (Number(counts[3]) !== passing('submodel-repository')) problems629.push(`the README says ${counts[3]} Submodel Repository operations pass, and the script records ${passing('submodel-repository')}`);
      const compliant = Number(counts[1]) === Number(counts[2]) && Number(counts[3]) === Number(counts[4]);
      if (compliant !== (statement[2] === 'compliant')) problems629.push(`the README calls the result "${statement[2]}", and ${counts[0]}`);
    }
  }
  const ci = read('.github/workflows/ci.yml');
  if (!/aas_conformance\.PINNED/.test(ci) || !/"aas_test_engines==\$PINNED"/.test(ci)) problems629.push('CI does not install the version the script pins');
  if (!/python test-harness\/aas_conformance\.py/.test(ci)) problems629.push('CI does not run test-harness/aas_conformance.py');

  if (problems629.length) {
    fail('aas-api\'s Registry and Discovery, the shells they answer from, and the stated conformance disagree:\n' + problems629.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`aas-api's Registry and Discovery answer from the shells shells.ts builds, Discovery indexes no lane and looks where the shell takes each id, and the README states aas-test-engines ${pinned}'s measured passes, which CI installs and holds`);
  }
}
