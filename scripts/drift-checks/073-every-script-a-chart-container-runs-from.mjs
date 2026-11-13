import { existsSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 73. Every script a chart container runs from /opt/aber/ is copied there by the Dockerfile of the
// image that container runs, with every relative import it makes. A missing COPY renders, lints and
// builds, and the pod then crash-loops on ERR_MODULE_NOT_FOUND.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const T = 'deploy/helm/aber/templates/';
  // The values key an image is named by, to the Dockerfile that builds it.
  const DOCKERFILES = {
    nodeRed: 'node-red/Dockerfile',
    gatewayCredential: 'gateway-credential/Dockerfile',
    backupService: 'backup-service/Dockerfile',
  };
  // Each Dockerfile's build context, where its COPY sources resolve, from scripts/dev-cluster.mjs.
  const CONTEXTS = Object.fromEntries([...read('scripts/dev-cluster.mjs').matchAll(/file: '([^']+)', context: '([^']+)'/g)]
    .map((m) => [m[1], m[2] === '.' ? '' : `${m[2]}/`]));
  const shipped = {};
  const wrong = [];
  for (const file of Object.values(DOCKERFILES)) {
    shipped[file] = new Map();
    if (!(file in CONTEXTS)) wrong.push(`scripts/dev-cluster.mjs's IMAGES names no build context for ${file}`);
    for (const line of read(file).replace(/\\\r?\n/g, ' ').split(/\r?\n/)) {
      if (!/^COPY\s/.test(line)) continue;
      const args = line.trim().split(/\s+/).slice(1).filter((a) => !a.startsWith('--'));
      const dest = args.pop();
      if (!dest.startsWith('/opt/aber/')) continue;
      for (const src of args) {
        const from = (CONTEXTS[file] || '') + src;
        if (!existsSync(join(REPO, from))) wrong.push(`${file} copies ${src}, which does not exist`);
        shipped[file].set(dest.endsWith('/') ? dest + posix.basename(src) : dest, from);
      }
    }
    for (const [at, from] of shipped[file]) {
      if (!existsSync(join(REPO, from))) continue;
      for (const m of read(from).matchAll(/^import\s[^;]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/gm)) {
        const target = posix.join(posix.dirname(at), m[1]);
        if (!shipped[file].has(target)) wrong.push(`${from} imports ${m[1]}, and ${file} does not copy it to ${target}`);
      }
    }
  }
  let runs = 0;
  for (const name of readdirSync(join(REPO, T), { recursive: true }).map((n) => n.replace(/\\/g, '/')).filter((n) => n.endsWith('.yaml'))) {
    const template = read(T + name);
    for (const m of template.matchAll(/\/opt\/aber\/[\w./-]+\.mjs/g)) {
      const image = [...template.slice(0, m.index).matchAll(/image: .*\.Values\.(\w+)\.image\b/g)].pop()?.[1];
      const file = DOCKERFILES[image];
      runs += 1;
      if (!file) wrong.push(`${T}${name} runs ${m[0]} on .Values.${image}.image, which check 73 maps to no Dockerfile`);
      else if (!shipped[file].has(m[0])) wrong.push(`${T}${name} runs ${m[0]}, which ${file} does not copy there`);
    }
  }
  if (!runs) wrong.push('check 73 found no template running a script from /opt/aber/, so it checks nothing');
  if (wrong.length) {
    fail('a container runs a script its image does not carry:\n' + wrong.map((w) => `        ${w}`).join('\n'));
  } else {
    pass(`the chart's ${runs} script command(s) under /opt/aber/ are each copied there by their image, with their imports`);
  }
}
