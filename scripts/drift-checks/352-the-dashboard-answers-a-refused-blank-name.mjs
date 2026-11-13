import { fail, pass, read, supabaseReadme, upgradingGuide } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 352. The dashboard answers a refused blank name with the rule, as the guide and the README say it.
// api.js maps devices_name_not_blank and gateways_name_not_blank, the constraints 0284 declares, to
// "Give the device a name" and "Give the gateway a name", on the create and the update of each. The
// upgrade guide and supabase/README.md quote both sentences and name both constraints.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const api = read('frontend/src/api.js');
  const sql = read('supabase/migrations/0284_a_device_or_gateway_name_cannot_be_blank.sql');
  const problems352 = [];
  const sentences = [];
  for (const [kind, table] of [['device', 'devices'], ['gateway', 'gateways']]) {
    const mapped = api.match(new RegExp(`${kind}: \\{ constraint: /(\\w+)/, sentence: '([^']+)' \\}`));
    if (!mapped) {
      problems352.push(`frontend/src/api.js has no BLANK_NAME entry for a ${kind}`);
      continue;
    }
    const [, constraint, sentence] = mapped;
    sentences.push([constraint, sentence]);
    if (constraint !== `${table}_name_not_blank` || !sql.includes(`ADD CONSTRAINT ${constraint} CHECK`)) {
      problems352.push(`api.js answers ${constraint} for a ${kind}, which 0284 does not declare as ${table}_name_not_blank`);
    }
    if (sentence !== `Give the ${kind} a name`) problems352.push(`api.js says "${sentence}" for a blank ${kind} name, not "Give the ${kind} a name"`);
    const uses = (api.match(new RegExp(`nameRefusal\\(error, '${kind}'\\)`, 'g')) || []).length;
    if (uses !== 2) problems352.push(`api.js uses nameRefusal for a ${kind} on ${uses} writes, not the create and the update`);
  }
  const guide = upgradingGuide();
  const readme = supabaseReadme();
  const from = readme.indexOf("\n### A device's name and a gateway's name cannot be blank (0284)\n");
  const readmeSection = from < 0 ? '' : readme.slice(from, readme.indexOf('\n### ', from + 5));
  const guideFrom = guide.indexOf('\n### From 1.9.0, a device or a gateway cannot have a blank name\n');
  const guideSection = guideFrom < 0 ? '' : guide.slice(guideFrom, guide.indexOf('\n## ', guideFrom));
  if (!readmeSection) problems352.push("supabase/README.md has no \"A device's name and a gateway's name cannot be blank (0284)\" section");
  if (!guideSection) problems352.push('help/site/upgrading.md has no "From 1.9.0, a device or a gateway cannot have a blank name" section');
  for (const [constraint, sentence] of sentences) {
    if (guideSection && !guideSection.includes(`\`${constraint}\``)) problems352.push(`the upgrade guide's blank-name section does not name ${constraint}`);
    if (guideSection && !guideSection.includes(`"${sentence}"`)) problems352.push(`the upgrade guide's blank-name section does not say "${sentence}"`);
    if (readmeSection && !readmeSection.includes(`\`${constraint}\``)) problems352.push(`supabase/README.md's 0284 section does not name ${constraint}`);
    if (readmeSection && !readmeSection.includes(`"${sentence}"`)) problems352.push(`supabase/README.md's 0284 section does not say "${sentence}"`);
  }
  if (problems352.length) {
    fail('the dashboard, the upgrade guide and the README say a blank name\'s refusal differently:\n' +
      problems352.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`api.js, the upgrade guide and supabase/README.md say "${sentences[0][1]}" and "${sentences[1][1]}" for the two constraints 0284 declares`);
  }
}
