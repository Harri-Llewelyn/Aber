import { posix } from 'node:path';
import { allFiles, fail, gitignored, isDriftCheck, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 106. Every build of the dashboard image hands it help/ as the `help` named context, and
// frontend/Dockerfile copies that context to where src/help/index.js's glob looks. The build
// context is ./frontend, which holds no help/. A build without the named context stops at
// `COPY --from=help`; a copy put anywhere else bundles a help panel with no pages.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const DOCKERFILE = 'frontend/Dockerfile';
  const INDEX = 'frontend/src/help/index.js';
  const NAMED = /\bhelp=(?:\.\/)?help\/?(?![\w./-])/;
  const wrong = [];

  // The build stage: the source is copied into WORKDIR, so the glob resolves from WORKDIR/src/help.
  const builder = read(DOCKERFILE).split(/^(?=FROM\s)/m).find((s) => s.startsWith('FROM')) || '';
  const workdir = [...builder.matchAll(/^WORKDIR\s+(\S+)/gm)].pop()?.[1];
  const copied = /^COPY\s+--from=help\s+\.\s+(\S+?)\/?\s*$/m.exec(builder)?.[1];
  const glob = /import\.meta\.glob\(\s*['"]([^'"]+)['"]/.exec(read(INDEX))?.[1];
  if (!copied) wrong.push(`${DOCKERFILE}'s build stage has no \`COPY --from=help . <dir>\``);
  else if (!workdir || !glob) wrong.push(`${DOCKERFILE} sets no WORKDIR in its build stage, or ${INDEX} has no glob`);
  else {
    const inImage = posix.normalize(posix.join(workdir, 'src/help', glob));
    if (!inImage.startsWith(`${copied}/`)) wrong.push(`${INDEX}'s glob reads ${inImage} in the image, and ${DOCKERFILE} copies help/ to ${copied}`);
  }

  // The workflows: a build-push-action step names the context itself, or passes its matrix entry's.
  let steps = 0;
  for (const wf of allFiles.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f))) {
    const text = read(wf);
    const chunks = text.split(/\n(?=\s*- name: )/);
    const entry = chunks.find((c) => /^\s*- name: [\w-]+\n\s+dockerfile: frontend\/Dockerfile\s*$/m.test(c));
    if (entry && !/^\s*build_contexts:.*$/m.test(entry)) wrong.push(`${wf}'s matrix entry for ${DOCKERFILE} has no build_contexts`);
    else if (entry && !NAMED.test(/^\s*build_contexts:(.*)$/m.exec(entry)[1])) wrong.push(`${wf}'s matrix entry for ${DOCKERFILE} passes no help=./help in build_contexts`);
    for (const step of chunks.filter((c) => /uses: docker\/build-push-action@/.test(c))) {
      const file = /^\s*file:\s*(.+?)\s*$/m.exec(step)?.[1];
      const contexts = /^\s*build-contexts:\s*(.+?)\s*$/m.exec(step)?.[1] || '';
      if (file === DOCKERFILE || (file === '${{ matrix.dockerfile }}' && entry)) {
        steps += 1;
        if (!(file === DOCKERFILE ? NAMED.test(contexts) : contexts === '${{ matrix.build_contexts }}')) {
          wrong.push(`${wf}: the build-push-action step "${/- name: (.*)/.exec(step)?.[1]}" builds ${DOCKERFILE} without the help context`);
        }
      }
    }
  }
  if (!steps) wrong.push(`no workflow builds ${DOCKERFILE} with docker/build-push-action; the extraction no longer matches release.yml`);

  // The dev loop and the rehearsals: one IMAGES entry, and buildImages() passes what it names.
  const dev = read('scripts/dev-cluster.mjs');
  const devEntry = /^\s*\{[^\n]*file: 'frontend\/Dockerfile'[^\n]*\}/m.exec(dev)?.[0] || '';
  if (!NAMED.test(/contexts: \[([^\]]*)\]/.exec(devEntry)?.[1] || '')) wrong.push(`scripts/dev-cluster.mjs's IMAGES entry for ${DOCKERFILE} names no 'help=./help' in contexts`);
  if (!/for \(const (\w+) of img\.contexts \|\| \[\]\) args\.push\('--build-context', \1\)/.test(dev)) {
    wrong.push('scripts/dev-cluster.mjs buildImages() does not pass an image\'s contexts as --build-context');
  }

  // Every documented command, with `\` continuations joined and a comment's `#` dropped.
  const commands = [];
  for (const file of allFiles.filter((f) => !gitignored(f) && !isDriftCheck(f) && /\.(?:md|ya?ml|tpl|txt|sh|mjs|js|hcl)$/.test(f))) {
    const lines = read(file).split('\n');
    lines.forEach((line, i) => {
      if (!/\bdocker (?:buildx )?build\b/.test(line)) return;
      let command = line;
      for (let j = i; j + 1 < lines.length && /\\\s*$/.test(lines[j]); j += 1) command += ` ${lines[j + 1].replace(/^\s*(?:#\s*)?/, '')}`;
      if (command.includes(DOCKERFILE)) commands.push({ at: `${file}:${i + 1}`, command });
    });
  }
  for (const c of commands.filter((x) => !/--build-context[ =]help=/.test(x.command) || !NAMED.test(x.command))) {
    wrong.push(`${c.at} builds ${DOCKERFILE} without --build-context help=./help`);
  }
  if (!commands.some((c) => c.at.startsWith('deploy/k8s/README.md'))) {
    wrong.push(`deploy/k8s/README.md has no \`docker build -f ${DOCKERFILE}\`; the extraction no longer matches`);
  }
  const bake = read('docker-bake.hcl');
  if (bake.includes(DOCKERFILE) && !/contexts\s*=\s*\{[^}]*"help"\s*=/.test(bake)) wrong.push(`docker-bake.hcl builds ${DOCKERFILE} with no "help" context`);

  if (wrong.length) {
    fail('a build of the dashboard image is not handed help/, or the image puts it where the glob does not look:\n' +
      wrong.map((w) => `        ${w}`).join('\n'));
  } else {
    pass(`${steps} workflow step(s), the dev loop and ${commands.length} documented docker build(s) hand the dashboard image help/, and ${DOCKERFILE} copies it to ${copied}`);
  }
}
