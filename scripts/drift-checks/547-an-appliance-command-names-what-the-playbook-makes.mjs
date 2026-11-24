import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 547. A command to run on an appliance names what the appliance has. The two folders are the
// playbook's and the installer's, and the Compose project is called after the one it stands in, which
// its file must not rename. The service and container names are the compose file's, the unit is the
// converge role's, and the reset is a flag bootstrap.mjs reads. The clean-up takes the containers down
// before it removes the folders: a container still running keeps the old folder mounted, and the next
// install stops when it starts one. Two lines with sudo are joined, so a password prompt cannot read
// the second.
// -------------------------------------------------------------------------------------------------

const DIR = 'forge/gateway-platform/';

export default async function check() {
  const c = await import(pathToFileURL(join(REPO, 'frontend/src/utils/applianceCommands.js')).href);
  const problems547 = [];
  const want = (found, message) => { if (!found) problems547.push(message); };

  const site = read(`${DIR}site.yml`);
  const variable = (name) => site.split('\n').find((l) => l.startsWith(`    ${name}: `))?.split(': ')[1].trim();
  const composeDir = variable('aber_compose_dir');
  const dataDir = variable('aber_data_dir');
  want(composeDir && dataDir, `${DIR}site.yml no longer states aber_compose_dir and aber_data_dir, so this check cannot read them`);
  const installer = read(`${DIR}install.sh`);
  want(installer.includes(`local COMPOSE_DIR="${composeDir}"`), `install.sh's COMPOSE_DIR is not the playbook's ${composeDir}`);
  want(installer.includes('local STATE_DIR="${ABER_STATE_DIR:-/var/lib/aber-gateway}"') && installer.includes('local DATA_DIR="$STATE_DIR/data"') && dataDir === '/var/lib/aber-gateway/data',
    `install.sh's DATA_DIR is not the playbook's ${dataDir}`);

  const compose = read(`${DIR}appliance/docker-compose.yml`);
  const project = posix.basename(composeDir ?? '');
  want(!/^name:/m.test(compose), 'docker-compose.yml names its project, so the clean-up takes down another one');
  const [down, remove] = c.CLEAR_INSTALLED_ENROLMENT.split('\n');
  want(down === `sudo docker compose -p ${project} down -v &&`, `the clean-up does not take the project "${project}" down first, joined to what follows`);
  want(remove === `sudo rm -rf ${dataDir} ${composeDir}`, `the clean-up does not then remove ${dataDir} and ${composeDir}`);
  want(c.CLEAR_BUNDLE_ENROLMENT === 'docker compose down -v', "the bundle's clean-up is not `docker compose down -v`, which removes the volume /data is");

  const services = new Set([...compose.slice(compose.indexOf('\nservices:')).matchAll(/^ {2}([a-z][a-z-]*):$/gm)].map((m) => m[1]));
  const containers = new Set([...compose.matchAll(/^ {4}container_name: (\S+)$/gm)].map((m) => m[1]));
  want(containers.has(c.FLOW_SYNC_LOG.split(' ').at(-1)), `the flow-sync log names ${c.FLOW_SYNC_LOG.split(' ').at(-1)}, which is no container of docker-compose.yml`);
  const unit = c.CONVERGE_JOURNAL.match(/ -u (\S+)/)?.[1];
  want(read(`${DIR}roles/converge/tasks/main.yml`).includes(`dest: /etc/systemd/system/${unit}.service`), `the converge journal names ${unit}, which the converge role does not install`);

  for (const [name, folder] of [['RESET_EDITOR_PASSWORD', ` --project-directory ${composeDir}`], ['RESET_BUNDLE_EDITOR_PASSWORD', '']]) {
    const [run, restart] = c[name].split('\n');
    want(run.includes(`docker compose${folder} run --rm bootstrap /bundle/bootstrap.mjs --reset-admin-password`), `${name} does not run bootstrap.mjs's reset${folder ? ` in ${composeDir}` : ''}`);
    want(restart?.endsWith(`docker compose${folder} restart node-red`), `${name} does not restart node-red, which reads the new password at its start`);
  }
  for (const service of ['bootstrap', 'node-red']) want(services.has(service), `docker-compose.yml has no ${service} service`);
  want(read(`${DIR}appliance/bootstrap.mjs`).includes("args.includes('--reset-admin-password')"), 'bootstrap.mjs no longer reads --reset-admin-password');

  for (const [name, text] of Object.entries(c).filter(([, v]) => typeof v === 'string')) {
    const lines = text.split('\n');
    lines.slice(0, -1).forEach((line, i) => {
      want(!lines[i + 1].startsWith('sudo ') || line.endsWith(' &&'), `${name} runs sudo on two lines that are not joined with &&`);
    });
  }

  if (problems547.length) {
    fail('a command to run on an appliance does not name what the appliance has:\n' + problems547.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the commands to run on an appliance name the playbook's folders ${dataDir} and ${composeDir}, the project ${project}, the compose file's services and containers and the converge unit, and the clean-up takes the containers down first`);
  }
}
