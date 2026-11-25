import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 590. The line the installer replaces on a second run is the one the .env template writes and
// bootstrap.mjs redeems. A re-issued command's token reaches enrolment through it alone, so a rename in
// one of the three leaves the first command's dead token in place. The replacement stands between the
// playbook's fetch, which the platform answers only for a live token, and its run: the appliance role
// starts the project, and so enrolment, when it finds an .env. The help says a new command can be pasted.
// -------------------------------------------------------------------------------------------------
const INSTALLER = 'forge/gateway-platform/install.sh';
const TEMPLATE = 'supabase/functions/_shared/gatewayEnv.ts';
const BOOTSTRAP = 'forge/gateway-platform/appliance/bootstrap.mjs';
const ROLE = 'forge/gateway-platform/roles/appliance/tasks/main.yml';
const HELP = 'help/site/remote-gateways.md';

export default function check() {
  const problems590 = [];
  const text = (path) => read(path).replace(/\r\n/g, '\n');

  const name = /^([A-Z_]+)=\$\{input\.token\}$/m.exec(text(TEMPLATE))?.[1];
  if (!name) problems590.push(`${TEMPLATE} has no line for the token, so this check reads nothing`);
  const installer = text(INSTALLER);
  for (const held of [`sed -n 's/^${name}=//p'`, `ABER_TOKEN_LINE="${name}=$TOKEN"`, `/^${name}=/`]) {
    if (!installer.includes(held)) problems590.push(`${INSTALLER} does not hold ${held}, so a second run keeps the first command's token`);
  }
  if (!text(BOOTSTRAP).includes(`process.env.${name} `)) problems590.push(`${BOOTSTRAP} does not redeem ${name}`);

  const steps = ['fetch "?file=platform.zip"', 'ABER_TOKEN_LINE=', 'ansible-playbook -i localhost, site.yml'].map((step) => installer.indexOf(step));
  if (steps.some((at) => at < 0) || steps.join() !== [...steps].sort((a, b) => a - b).join()) {
    problems590.push(`${INSTALLER} does not replace the token after the playbook's fetch and before its run`);
  }
  if (!text(ROLE).includes('cmd: docker compose up -d --build')) problems590.push(`${ROLE} no longer starts the project, so the order above has no reason left`);
  if (!text(HELP).replace(/\s+/g, ' ').includes('re-issue the command and paste the new one on the same machine')) {
    problems590.push(`${HELP} does not say that a re-issued command can be pasted on the same machine`);
  }

  if (problems590.length) {
    fail("a re-issued install command does not replace the first one's token:\n" + problems590.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`a second run of the installer replaces the .env's ${name}, the line the template writes and bootstrap redeems, before the playbook can start enrolment`);
  }
}
