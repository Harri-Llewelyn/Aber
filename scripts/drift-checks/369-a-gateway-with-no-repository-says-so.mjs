import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 369. A gateway with no repository says so in one line, and the reason is in the label's help tip
// within the short-tooltip rule. GatewayRepositoryPanel draws one NoRepository for each of the six
// cases, the Host's reading "None: edit it in Node-RED", and every reason is at most 35 words. The
// help says the Repository row reads None, and the README says so beside the drawer's rules.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const panel = read('frontend/src/components/common/GatewayRepositoryPanel.jsx');
  const help = read('help/pages/gateways.md');
  const readme = read('frontend/README.md');
  const problems369 = [];
  const cases = [...panel.matchAll(/<NoRepository\s+value="([^"]+)"\s+reason="([^"]+)"/g)];
  if (cases.length !== 6) problems369.push(`GatewayRepositoryPanel.jsx draws ${cases.length} NoRepository cases, not the 6 a gateway can be in without a repository`);
  if (!cases.some((m) => m[1] === 'None: edit it in Node-RED')) problems369.push('GatewayRepositoryPanel.jsx has no host-run case reading "None: edit it in Node-RED"');
  for (const [, value, reason] of cases) {
    const words = reason.trim().split(/\s+/).length;
    if (words > 35) problems369.push(`the reason for "${value}" is ${words} words; a tooltip stays within about 35`);
    if (value.length > 40) problems369.push(`"${value}" is too long for one line of a drawer`);
  }
  if (!panel.includes('<HelpTip text={reason} label="What Repository means"')) problems369.push('GatewayRepositoryPanel.jsx does not put the reason in the label\'s help tip');
  if (!help.includes('its **Repository** row reads **None**, and the **?** beside the label gives the reason')) problems369.push('help/pages/gateways.md does not say the Repository row reads None, with the reason under the ?');
  if (!readme.includes('**A missing repository is one line.**')) problems369.push('frontend/README.md does not say a missing repository is one line');
  if (problems369.length) {
    fail('a gateway\'s missing repository is said otherwise than the documents say it:\n' + problems369.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`a gateway with no repository says so in one line in each of ${cases.length} cases, with its reason in the label's help tip within 35 words`);
  }
}
