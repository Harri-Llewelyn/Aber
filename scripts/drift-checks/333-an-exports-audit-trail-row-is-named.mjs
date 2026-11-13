import { fail, pass, read, upgradingGuide } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 333. An export's Audit Trail row is named as the dashboard files it: the lane (READINGS in
// constants.js, "Readings"), the action's label ("Readings exported"), and History's help and the
// upgrade guide naming the lane. The lane's name is what a person looks for after the toast's link.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const constants = read('frontend/src/constants.js');
  const lane = constants.match(/\{ kind: 'READINGS',\s+table: 'telemetry',\s+label: '([^']+)'/)?.[1];
  const action = constants.match(/TELEMETRY_EXPORTED:\s+'([^']+)'/)?.[1];
  const problems333 = [];
  if (!lane || !action) {
    problems333.push("could not read the Readings lane or TELEMETRY_EXPORTED's label out of frontend/src/constants.js");
  } else {
    if (!read('help/pages/history.md').includes(`in the **${lane}** lane`)) problems333.push(`help/pages/history.md does not say "in the **${lane}** lane"`);
    if (!upgradingGuide().includes(`in the **${lane}** lane`)) problems333.push(`help/site/upgrading.md does not say "in the **${lane}** lane"`);
    const readme = read('frontend/README.md');
    if (!readme.includes(`**${lane}** lane`) || !readme.includes(`**${action}** (\`TELEMETRY_EXPORTED\`)`)) {
      problems333.push(`frontend/README.md does not name the **${lane}** lane and the action **${action}** (\`TELEMETRY_EXPORTED\`)`);
    }
  }
  if (problems333.length) {
    fail('the docs name an export\'s Audit Trail row otherwise than the dashboard files it:\n' + problems333.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the docs name an export's Audit Trail row as the dashboard files it: the ${lane} lane, the action ${action}`);
  }
}
