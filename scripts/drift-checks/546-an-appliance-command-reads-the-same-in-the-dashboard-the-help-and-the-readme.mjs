import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { allFiles, fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 546. A command a person runs on a Remote gateway's appliance reads the same wherever it is given.
// frontend/src/utils/applianceCommands.js holds each one the dashboard shows, and nothing else under
// frontend/src spells an appliance command, so a dialog and the drawer read it from there. Each is one
// whole code block of the help page's *Commands on the appliance*, which holds no other, and of the
// appliance's README. The installer's refusal to enrol twice names the clean-up for what it found, with
// its own variables for the two folders. The dashboard's blocks link to the help section.
// -------------------------------------------------------------------------------------------------

const MODULE = 'frontend/src/utils/applianceCommands.js';
const HELP = 'help/site/remote-gateways.md';
const README = 'forge/gateway-platform/appliance/README.md';
const INSTALLER = 'forge/gateway-platform/install.sh';
const BLOCK = 'frontend/src/components/common/ApplianceCommand.jsx';

/** The commands each document gives, by the module's name for it. `startBundle` is a function of a folder. */
const DOCUMENTED = [
  'CLEAR_INSTALLED_ENROLMENT', 'CLEAR_BUNDLE_ENROLMENT', 'CONVERGE_JOURNAL', 'FLOW_SYNC_LOG',
  'RESET_EDITOR_PASSWORD', 'RESET_BUNDLE_EDITOR_PASSWORD',
];

/** What no file but the module spells: how every command on the appliance starts, and its two folders. */
const SPELLED = ['docker compose ', 'docker logs ', 'journalctl ', '/opt/aber-gateway', '/var/lib/aber-gateway'];

/** The text of each fenced code block, in order. */
const codeBlocks = (markdown) => [...markdown.matchAll(/^```\w*\n([\s\S]*?)\n```$/gm)].map((m) => m[1]);

export default async function check() {
  const commands = await import(pathToFileURL(join(REPO, MODULE)).href);
  const problems546 = [];
  for (const name of DOCUMENTED) {
    if (typeof commands[name] !== 'string' || !commands[name]) problems546.push(`${MODULE} no longer exports ${name}, so this check cannot read it`);
  }
  const named = Object.keys(commands).filter((k) => typeof commands[k] === 'string' && k !== 'APPLIANCE_COMMANDS_HELP');
  for (const extra of named.filter((k) => !DOCUMENTED.includes(k))) {
    problems546.push(`${MODULE} exports ${extra}, which this check does not hold the documents to: add it to DOCUMENTED`);
  }

  // The help's section: each command once, and no block that is not one.
  const help = read(HELP).replace(/\r\n/g, '\n');
  const section = help.match(/\n## Commands on the appliance\n([\s\S]*?)(?=\n## )/)?.[1] ?? '';
  if (!section) problems546.push(`${HELP} has no "## Commands on the appliance" section`);
  const inHelp = codeBlocks(section);
  for (const name of DOCUMENTED) {
    const times = inHelp.filter((b) => b === commands[name]).length;
    if (section && times !== 1) problems546.push(`${HELP}'s Commands on the appliance gives ${name} as a whole code block ${times} times, not once`);
  }
  for (const block of inHelp.filter((b) => !DOCUMENTED.some((name) => commands[name] === b))) {
    problems546.push(`${HELP}'s Commands on the appliance holds a block that is no command of ${MODULE}: "${block.split('\n')[0]}"`);
  }
  if (help.indexOf('\n## Commands on the appliance\n') > help.indexOf('\n## Troubleshooting\n')) {
    problems546.push(`${HELP} puts Commands on the appliance after Troubleshooting`);
  }

  const inReadme = codeBlocks(read(README).replace(/\r\n/g, '\n'));
  for (const name of DOCUMENTED) {
    if (!inReadme.includes(commands[name])) problems546.push(`${README} does not give ${name} as a whole code block`);
  }

  // The refusal prints its folders from its own variables.
  const installer = read(INSTALLER).replace(/\r\n/g, '\n');
  const at = installer.indexOf('refusing to run again');
  const refusal = installer.slice(at, installer.indexOf('\n  fi\n', at)).split('$DATA_DIR').join('/var/lib/aber-gateway/data').split('$COMPOSE_DIR').join('/opt/aber-gateway');
  const given = (commands.CLEAR_INSTALLED_ENROLMENT ?? '').split('\n');
  if (at < 0 || !refusal.includes(given.map((line) => `  ${line}`).join('\n'))) {
    problems546.push(`${INSTALLER}'s refusal on an enrolled appliance does not name the clean-up as ${MODULE} gives it`);
  }

  // One module, and the block that links to the section.
  const sources = allFiles.filter((f) => /^frontend\/src\/.*\.jsx?$/.test(f) && !f.includes('/__tests__/') && f !== MODULE);
  for (const file of sources) {
    const src = read(file);
    for (const text of SPELLED) {
      if (src.includes(text)) problems546.push(`${file} spells an appliance command ("${text.trim()}"): read it from ${MODULE}`);
    }
  }
  if (commands.APPLIANCE_COMMANDS_HELP !== 'site/remote-gateways#commands-on-the-appliance') problems546.push(`${MODULE}'s help link is not to Commands on the appliance`);
  if (!read(BLOCK).includes('to={APPLIANCE_COMMANDS_HELP}')) problems546.push(`${BLOCK} does not link a block's hint to the help's section`);

  if (problems546.length) {
    fail('a command to run on an appliance reads otherwise in one place than another:\n' + problems546.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the ${DOCUMENTED.length} commands to run on an appliance read the same in the dashboard, the help's Commands on the appliance and the appliance's README, the installer's refusal names the clean-up, and no component spells one of its own (${sources.length} files)`);
  }
}
