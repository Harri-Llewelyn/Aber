import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 194. The Audit Trail's help names its filters' groups as constants.js holds them. The kind
// filter's groups are AUDIT_TRAIL_ENTITY_GROUPS, each named on the page; the action groups the
// page gives as examples are AUDIT_TRAIL_ACTION_GROUPS labels. A group renamed in the code and not
// in the help sends a reader looking for a heading that is not there.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const constants = read('frontend/src/constants.js');
  const block = (name) => {
    const at = constants.indexOf(`export const ${name} = [`);
    return at < 0 ? '' : constants.slice(at, constants.indexOf('];', at));
  };
  const entityGroups = [...block('AUDIT_TRAIL_ENTITY_GROUPS').matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
  const actionGroups = [...block('AUDIT_TRAIL_ACTION_GROUPS').matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
  const help = read('help/pages/audit-trail.md');
  const kindLine = help.split('\n').find((l) => l.startsWith('- **The kind filter**')) || '';
  const actionLine = help.split('\n').find((l) => l.startsWith('- **The action filter**')) || '';
  const problems194 = [];
  if (!entityGroups.length || !actionGroups.length) {
    problems194.push('could not read AUDIT_TRAIL_ENTITY_GROUPS or AUDIT_TRAIL_ACTION_GROUPS out of frontend/src/constants.js');
  }
  if (!kindLine || !actionLine) {
    problems194.push('help/pages/audit-trail.md has no "The kind filter" or "The action filter" bullet');
  }
  for (const g of entityGroups) {
    if (kindLine && !kindLine.toLowerCase().includes(g.toLowerCase())) {
      problems194.push(`help/pages/audit-trail.md's kind filter bullet does not name the group "${g}"`);
    }
  }
  // The examples after "such as", lower-cased as the prose writes them.
  const examples = (actionLine.match(/grouped by what the act is about, such as ([^.]+)\./)?.[1] ?? '')
    .split(/, (?:or |and )?| or /).map((e) => e.trim()).filter(Boolean);
  if (actionLine && examples.length === 0) problems194.push('help/pages/audit-trail.md\'s action filter bullet gives no group "such as" an example');
  for (const e of examples) {
    if (!actionGroups.some((g) => g.toLowerCase() === e.toLowerCase())) {
      problems194.push(`help/pages/audit-trail.md names an action group "${e}" that AUDIT_TRAIL_ACTION_GROUPS does not hold`);
    }
  }
  if (problems194.length) {
    fail('the Audit Trail help names its filter groups otherwise than constants.js:\n'
      + problems194.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the Audit Trail help names the ${entityGroups.length} kind groups and gives ${examples.length} real action groups as examples`);
  }
}
