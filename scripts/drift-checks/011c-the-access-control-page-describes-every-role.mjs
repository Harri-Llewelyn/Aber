import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 11c. The Access Control page describes every role mosquitto/dynsec-roles.json declares.
//
// The page reads the broker live (broker-inventory) for its accounts and each role's rules; what a
// role is FOR is declared in frontend/src/utils/serviceIdentities.js. A role in the policy with no
// purpose on the page is broker access nobody can explain; a purpose for a role the policy does
// not declare is a description of nothing. The policy's default is checked here too: the plugin's
// own `init` writes `publishClientReceive: true`, and that one grant lets every client read topics
// its role never mentions.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const policy = JSON.parse(read('mosquitto/dynsec-roles.json'));
  const ui = read('frontend/src/utils/serviceIdentities.js');

  const policyRoles = new Set((policy.roles || []).map((r) => r.rolename));
  // The platform roles and the gateway role, each declared on the page as `role: '<name>'`.
  const uiRoles = new Set([...ui.matchAll(/^\s*role:\s*'([^']+)'/gm)].map((m) => m[1]));

  if (policyRoles.size === 0 || uiRoles.size === 0) {
    fail(
      'could not read the broker roles out of ' +
        (policyRoles.size === 0 ? 'mosquitto/dynsec-roles.json' : 'frontend/src/utils/serviceIdentities.js') +
        ` (found ${policyRoles.size} in the policy, ${uiRoles.size} on the page).\n` +
        '      One of them changed shape, so the Access Control page is no longer being checked\n' +
        '      against the policy at all.'
    );
  } else {
    const problems = [];
    for (const r of policyRoles) {
      if (!uiRoles.has(r)) problems.push(`${r} is declared in dynsec-roles.json and has no purpose on the Access Control page`);
    }
    for (const r of uiRoles) {
      if (!policyRoles.has(r)) problems.push(`${r} is described on the Access Control page and dynsec-roles.json does not declare it`);
    }
    const d = policy.defaultACLAccess || {};
    if (d.publishClientSend !== false || d.publishClientReceive !== false || d.subscribe !== false) {
      problems.push('defaultACLAccess must deny publishClientSend, publishClientReceive and subscribe');
    }
    for (const role of policy.roles || []) {
      for (const acl of role.acls || []) {
        // The plugin substitutes %u and %c in every ACL type but the two literal ones (2.1;
        // mosquitto/README.md); there a % is a literal that grants nothing and fails nothing. %c
        // is refused as well: a client id is whatever the client chooses.
        const topic = String(acl.topic);
        if (/%(?!u)/.test(topic)) {
          problems.push(`role ${role.rolename} uses '${topic}': %u is the only pattern this policy relies on`);
        } else if (topic.includes('%u') && /Literal$/.test(acl.acltype)) {
          problems.push(`role ${role.rolename} uses %u in ${acl.acltype}, where the plugin does not substitute it`);
        }
      }
    }

    if (problems.length) {
      fail(
        `the Access Control page and dynsec-roles.json disagree: ${problems.join('; ')}.\n` +
          '      A role in the policy and not on the page is broker access nobody can explain; one\n' +
          '      on the page and not in the policy is a description of nothing.'
      );
    } else {
      pass(
        `the Access Control page describes all ${policyRoles.size} broker roles dynsec-roles.json ` +
          'declares, and the policy denies by default'
      );
    }
  }
}
