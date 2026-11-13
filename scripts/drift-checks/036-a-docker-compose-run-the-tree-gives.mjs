import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { allFiles, fail, gitignored, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 36. A `docker compose run` the tree gives for an appliance service passes the entrypoint its
// arguments, and does not name the entrypoint's program again.
//
// `run` replaces a service's `command` and keeps its `entrypoint`. `bootstrap` has
// `entrypoint: ["node"]`, so `run --rm bootstrap node /bundle/bootstrap.mjs` runs `node node ...`
// and fails with "Cannot find module". Every such command in the tree is read, and a script it
// names under the service's `./` mount must exist in the compose project's directory.
// -------------------------------------------------------------------------------------------------
export default function check() {
  // Services with an `entrypoint:`, from every compose file under forge/, by a narrow read: a
  // two-space service key under `services:`, a one-line JSON array, and the `./:<mount>` volume.
  const services = new Map();
  const unreadable = [];
  for (const file of allFiles.filter((f) => f.startsWith('forge/') && f.endsWith('/docker-compose.yml'))) {
    let inServices = false;
    let current = null;
    for (const line of read(file).split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      if (/^\S/.test(line)) { inServices = /^services:\s*$/.test(line); current = null; continue; }
      if (!inServices) continue;
      const key = line.match(/^ {2}([\w.-]+):\s*$/);
      if (key) {
        current = { name: key[1], file, dir: posix.dirname(file), entrypoint: null, mount: null };
        services.set(key[1], current);
        continue;
      }
      if (!current) continue;
      const entrypoint = line.match(/^ {4}entrypoint:\s*(.*?)\s*$/);
      if (entrypoint) {
        try { current.entrypoint = JSON.parse(entrypoint[1]); } catch { unreadable.push(`${file}: ${current.name}`); }
      }
      const mount = line.match(/^\s+-\s+\.\/?:(\/[^:\s]+)/);
      if (mount) current.mount = mount[1];
    }
  }
  for (const [name, service] of services) if (!Array.isArray(service.entrypoint)) services.delete(name);

  // Options of `docker compose run` that take a value, so the service name is found after them.
  const VALUED = new Set([
    '-e', '--env', '-v', '--volume', '-u', '--user', '-w', '--workdir', '--name', '-p', '--publish',
    '-l', '--label', '--env-from-file', '--cap-add', '--cap-drop', '--entrypoint',
  ]);
  const RUN = /docker compose run((?:[ \t]+[^\s`'"|;&)]+)+)/g;
  const scanned = allFiles.filter(
    (f) =>
      !gitignored(f) &&
      !f.includes('.generated.') &&
      !f.startsWith('supabase/migrations/archive/') &&
      !f.startsWith('frontend/dist/') &&
      !f.startsWith('.claude/') &&
      !f.startsWith('backups/') &&
      !/\.(png|jpe?g|gif|ico|svg|woff2?|ttf|zip|gz|pdf|glb)$/i.test(f)
  );

  const wrong = [];
  let commands = 0;
  for (const file of scanned) {
    let text;
    try { text = read(file); } catch { continue; }
    if (text.includes('\0')) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      for (const [, rest] of lines[i].matchAll(RUN)) {
        const tokens = rest.trim().split(/\s+/);
        let t = 0;
        let overridden = false;
        while (t < tokens.length && tokens[t].startsWith('-')) {
          if (/^--entrypoint\b/.test(tokens[t])) overridden = true;
          t += VALUED.has(tokens[t]) ? 2 : 1;
        }
        const service = services.get(tokens[t]);
        const first = tokens[t + 1];
        if (overridden || !service || !first) continue;
        commands += 1;
        const at = `${file}:${i + 1}`;
        const program = posix.basename(service.entrypoint[0]);
        if (posix.basename(first) === program) {
          wrong.push(
            `${at}: runs \`${[...service.entrypoint, ...tokens.slice(t + 1)].join(' ')}\`; ` +
              `${service.name}'s entrypoint in ${service.file} is already ${JSON.stringify(service.entrypoint)}`
          );
        } else if (service.mount && first.startsWith(`${service.mount}/`)) {
          const script = posix.join(service.dir, first.slice(service.mount.length + 1).replace(/[.,:;]+$/, ''));
          if (!existsSync(join(REPO, script))) wrong.push(`${at}: runs ${first}, and ${script} does not exist`);
        }
      }
    }
  }

  if (unreadable.length) {
    fail(`check 36 cannot read the entrypoint of ${unreadable.join(', ')}: it is not a one-line JSON array`);
  } else if (!services.size) {
    fail('check 36 found no compose service under forge/ with an `entrypoint:`; the extraction no longer matches');
  } else if (!commands) {
    fail(
      `check 36 found no \`docker compose run\` of ${[...services.keys()].join(', ')} in the tree; ` +
        'the extraction no longer matches'
    );
  } else if (wrong.length) {
    fail(
      'a `docker compose run` given for an appliance service would not run:\n' +
        wrong.map((w) => `        ${w}`).join('\n')
    );
  } else {
    pass(
      `all ${commands} \`docker compose run\` command(s) for ${[...services.keys()].join(', ')} ` +
        'pass their entrypoint a script that exists'
    );
  }
}
