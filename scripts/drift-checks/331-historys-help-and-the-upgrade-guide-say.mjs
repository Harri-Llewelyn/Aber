import { fail, pass, read, upgradingGuide } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 331. History's help and the upgrade guide say who may export as the dashboard holds it:
// TELEMETRY_EXPORT_ROLES' two roles in words (utils/telemetryExport.js), and the greyed button's
// title, EXPORT_DENIED_TITLE. A help page naming another role sends a person to someone who cannot
// export, or tells them they cannot when they can.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const code = read('frontend/src/utils/telemetryExport.js');
  const roles = code.match(/export const TELEMETRY_EXPORT_ROLES = \[([^\]]*)\]/)?.[1];
  const problems331 = [];
  if (!roles) {
    problems331.push('could not read TELEMETRY_EXPORT_ROLES out of frontend/src/utils/telemetryExport.js');
  } else {
    const words = [...roles.matchAll(/'([A-Za-z_]+)'/g)].map((m) => m[1].replace(/_/g, ' '));
    if (words.length !== 2) problems331.push(`TELEMETRY_EXPORT_ROLES names ${words.length} roles, and the help says two`);
    else {
      const [first, second] = words;
      const history = read('help/pages/history.md');
      if (!history.includes(`Only an **${first}** or a **${second}** can export.`)) problems331.push(`help/pages/history.md does not say "Only an **${first}** or a **${second}** can export."`);
      if (!history.includes(`**Requires ${first} or ${second}**`)) problems331.push(`help/pages/history.md does not say "**Requires ${first} or ${second}**"`);
      const upgrading = upgradingGuide();
      if (!upgrading.includes(`only an **${first}** or a **${second}** can export readings`)) problems331.push(`help/site/upgrading.md does not say "only an **${first}** or a **${second}** can export readings"`);
      const readme = read('frontend/README.md');
      if (!readme.includes(`"Requires ${first} or ${second}"`)) problems331.push(`frontend/README.md does not say "Requires ${first} or ${second}"`);
    }
  }
  if (problems331.length) {
    fail('the help states who may export otherwise than the dashboard holds it:\n' + problems331.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('History\'s help, the upgrade guide and frontend/README.md name the roles that may export, and the greyed button\'s title, as the dashboard holds them');
  }
}
