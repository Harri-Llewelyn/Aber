import { fail, pass, read, readDoc, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 337. The finding for a derived name is written up as conformance.py codes it, and the pages that
// said nobody publishes a derived metric say what happens when one does. The code is named in the
// ingestion README and the 0267 section; the Devices and Metrics help each say the reading is
// dropped; and the 0267 section no longer says ingestion is as it was.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const code = read('ingestion/conformance.py').match(/^DERIVED_NAME_CODE = "([a-z_]+)"$/m)?.[1];
  const problems337 = [];
  if (!code) problems337.push('could not read DERIVED_NAME_CODE out of ingestion/conformance.py');
  else {
    for (const file of ['ingestion/README.md', 'supabase/README.md']) {
      if (!readDoc(file).includes(`\`${code}\``)) problems337.push(`${file} does not name the finding's code \`${code}\``);
    }
  }
  const claims = [
    ['help/pages/devices.md', 'a reading published under the name of a derived metric is dropped'],
    ['help/pages/metrics.md', 'A reading a device publishes under its name is dropped'],
    ['supabase/README.md', '**Ingestion enforces the other direction.**'],
  ];
  for (const [file, said] of claims) if (!readDoc(file).replace(/\s+/g, ' ').includes(said)) problems337.push(`${file} does not say "${said}"`);
  if (/The AAS export and ingestion are as they were/.test(supabaseReadme().replace(/\s+/g, ' '))) {
    problems337.push('supabase/README.md still says ingestion is as it was, which the derived-name drop changed');
  }
  if (problems337.length) {
    fail('the docs say what a derived name\'s reading meets otherwise than ingestion does:\n' +
      problems337.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the finding \`${code}\` is named in the ingestion README and the 0267 section, and the Devices and Metrics help say the reading is dropped`);
  }
}
