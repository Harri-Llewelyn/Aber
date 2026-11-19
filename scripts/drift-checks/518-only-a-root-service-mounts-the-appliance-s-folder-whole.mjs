import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 518. Only a service that runs as root mounts the appliance's compose folder whole.
// The platform playbook makes /opt/aber-gateway root's and 0750, so a service running as any other
// user cannot enter a mount of the whole folder, and Node reports the script it cannot reach as a
// missing module. Such a service mounts each file it reads instead. Every /bundle path a service's
// command names must be inside one of its mounts, or it starts with nothing to run.
// -------------------------------------------------------------------------------------------------
const FILE = 'forge/gateway-platform/appliance/docker-compose.yml';

export default function check() {
  const lines = read(FILE).split('\n');
  const services = [];
  let inServices = false;
  for (const line of lines) {
    if (/^services:\s*$/.test(line)) { inServices = true; continue; }
    if (/^\S/.test(line)) { inServices = false; continue; }
    if (!inServices) continue;
    const name = line.match(/^ {2}([a-z][a-z0-9-]*):\s*$/);
    if (name) { services.push({ name: name[1], user: null, mounts: [], command: '', inVolumes: false }); continue; }
    const svc = services.at(-1);
    if (!svc) continue;
    const user = line.match(/^ {4}user:\s*"?([^"\s#]+)"?/);
    if (user) svc.user = user[1];
    if (/^ {4}volumes:\s*$/.test(line)) { svc.inVolumes = true; continue; }
    if (/^ {4}\S/.test(line)) svc.inVolumes = false;
    const mount = svc.inVolumes && line.match(/^ {6}- "?([^"#\s]+)"?/);
    if (mount) svc.mounts.push(mount[1]);
    const command = line.match(/^ {4}command:\s*(.*)$/);
    if (command) svc.command = command[1];
  }

  const problems518 = [];
  if (!services.some((s) => s.name === 'flow-sync')) problems518.push(`${FILE} has no flow-sync service, so this check is no longer checking what it was written for`);
  for (const svc of services) {
    const root = svc.user === '0' || svc.user === 'root';
    const targets = svc.mounts.map((m) => m.split(':')).filter((p) => p.length >= 2);
    for (const [source, target] of targets) {
      if (!root && (source === '.' || source === './')) {
        problems518.push(`${svc.name} runs as ${svc.user ?? "its image's user"} and mounts the whole folder at ${target}: the playbook makes that folder 0750 and root's, so it cannot enter it. Mount each file it reads instead.`);
      }
    }
    for (const path of svc.command.match(/\/bundle\/[A-Za-z0-9._/-]+/g) ?? []) {
      const reached = targets.some(([, target]) => path === target || path.startsWith(target.replace(/\/?$/, '/')));
      if (!reached) problems518.push(`${svc.name}'s command names ${path}, which none of its mounts puts in the container`);
    }
  }

  if (problems518.length) {
    fail("a service on the appliance cannot reach what its command runs:\n" + problems518.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`only a root service mounts the appliance's folder whole, and every /bundle path a command names is mounted (${services.length} services)`);
  }
}
