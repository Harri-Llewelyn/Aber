import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 56. Every image this repository builds runs as a stated, non-root user. Each Dockerfile's final
// stage ends with a USER that is not root, or config-allowlist.json carries a DS-0002 line saying
// why. The runbook's *Users* table gives each image the chart runs a uid:gid; that image's
// Dockerfile names the same one, and every container the templates run it in states it, with
// runAsNonRoot, itself or through its pod (values.yaml's podSecurityContext included). A `root`
// row is an allow-listed image; ROOT_ALSO names an image the chart may also run as root.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const TEMPLATES = 'deploy/helm/aber/templates/';
  const RUNBOOK = 'deploy/k8s/README.md';
  const ROOT_ALSO = new Map([['backup-service', 'backup.includeForge, backup.includeBroker or backup.includeGrafana']]);
  const bad = [];
  const allow = JSON.parse(read('scripts/lint/config-allowlist.json'));

  // The final stage's last USER, per Dockerfile.
  const users = new Map();
  for (const f of allFiles.filter((p) => p.endsWith('Dockerfile') && !p.startsWith('frontend/dist/'))) {
    const text = read(f);
    const stage = text.slice(Math.max(0, text.search(/^FROM\s[^\n]*$(?![\s\S]*^FROM\s)/m)));
    const user = [...stage.matchAll(/^USER\s+(\S+)\s*$/gm)].map((m) => m[1]).pop() || null;
    users.set(f, user);
    const rootish = !user || /^(root|0)(:|$)/.test(user);
    if (rootish && !allow[`DS-0002 ${f}`]) bad.push(`${f} ends ${user ? `as ${user}` : 'with no USER'}, and config-allowlist.json states no DS-0002 reason`);
    if (!rootish && allow[`DS-0002 ${f}`]) bad.push(`${f} ends as ${user}, but config-allowlist.json still allow-lists its DS-0002`);
  }

  // The images the chart builds (scripts/dev-cluster.mjs), and the runbook's table of their users.
  const dockerfileOf = new Map([...read('scripts/dev-cluster.mjs').matchAll(/name: '([^']+)', file: '([^']+)'/g)].map((m) => [m[1], m[2]]));
  const section = read(RUNBOOK).match(/\n### Users\n([\s\S]*?)(?=\n### )/);
  const table = new Map();
  for (const row of (section ? section[1] : '').split('\n').filter((l) => /^\| [a-z0-9-]+ \|/.test(l))) {
    const [, image, runs, where] = row.split('|').map((c) => c.trim());
    table.set(image, { runs, where });
  }
  if (!table.size) bad.push(`${RUNBOOK} has no *Users* table`);
  for (const name of dockerfileOf.keys()) if (!table.has(name)) bad.push(`${RUNBOOK}'s Users table has no row for ${name}, which the chart runs`);
  for (const [name, { runs, where }] of table) {
    const file = dockerfileOf.get(name);
    if (!file) { bad.push(`${RUNBOOK}'s Users table names ${name}, which scripts/dev-cluster.mjs does not build`); continue; }
    const user = users.get(file);
    if (runs === 'root') {
      if (user) bad.push(`${RUNBOOK} says ${name} runs as root, but ${file} ends as ${user}`);
    } else if (!/^[1-9]\d*:\d+$/.test(runs)) {
      bad.push(`${RUNBOOK}'s Users table gives ${name} "${runs}", not a non-root uid:gid`);
    } else if (/^\d+(:\d+)?$/.test(user || '') && user !== runs && user !== runs.split(':')[0]) {
      // A USER with no group takes its passwd entry's; the table's gid is held against the chart.
      bad.push(`${file} ends as ${user}; ${RUNBOOK}'s Users table says ${name} runs as ${runs}`);
    }
    if (ROOT_ALSO.has(name) && !/as root/.test(where)) bad.push(`${RUNBOOK}'s Users table does not say when ${name} runs as root (${ROOT_ALSO.get(name)})`);
  }

  // values.yaml: <key>.<image|serverImage>.repository, and <key>.podSecurityContext's text.
  const VALUES = read('deploy/helm/aber/values.yaml').split('\n');
  const blockOf = (key) => {
    const s = VALUES.findIndex((l) => l === `${key}:`);
    if (s === -1) return [];
    let e = s + 1;
    while (e < VALUES.length && (VALUES[e] === '' || /^[ #]/.test(VALUES[e]))) e += 1;
    return VALUES.slice(s + 1, e);
  };
  const subBlock = (lines, sub) => {
    const s = lines.findIndex((l) => l === `  ${sub}:`);
    if (s === -1) return [];
    let e = s + 1;
    while (e < lines.length && (lines[e] === '' || /^ {4}/.test(lines[e]) || /^\s*#/.test(lines[e]))) e += 1;
    return lines.slice(s + 1, e);
  };
  const imageName = (key, sub) => {
    const repo = subBlock(blockOf(key), sub).map((l) => l.match(/^ {4}repository:\s*(\S+)/)).find(Boolean);
    return repo && repo[1].startsWith('ghcr.io/harri-llewelyn/aber/') ? repo[1].slice('ghcr.io/harri-llewelyn/aber/'.length) : null;
  };

  // Every container in the templates running one of them: the runAs settings it states, or failing
  // that its pod's. Read as check 51 reads them.
  const indent = (l) => l.match(/^ */)[0].length;
  const skip = (l) => !l.trim() || /^\s*#/.test(l) || /^\s*\{\{.*\}\}\s*$/.test(l);
  const blockText = (lines, i) => {
    let t = '';
    for (let j = i + 1; j < lines.length && (!lines[j].trim() || indent(lines[j]) > indent(lines[i])); j++) t += `${lines[j]}\n`;
    return t;
  };
  const seen = new Map();
  for (const f of allFiles.filter((p) => p.startsWith(TEMPLATES) && /\.(ya?ml|tpl)$/.test(p))) {
    const lines = read(f).replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, (c) => c.replace(/[^\n]/g, '')).split('\n');
    lines.forEach((line, i) => {
      const item = line.match(/^( *)- name:\s*(.+?)\s*$/);
      if (!item) return;
      let imageLine = null;
      let sc = null;
      for (let j = i + 1; j < lines.length && (skip(lines[j]) || indent(lines[j]) > item[1].length); j++) {
        if (indent(lines[j]) !== item[1].length + 2) continue;
        if (/^\s*image:/.test(lines[j])) imageLine = lines[j];
        if (/^\s*securityContext:\s*$/.test(lines[j])) sc = j;
      }
      const ref = imageLine && imageLine.match(/\.Values\.(\w+)\.(image|serverImage)\b/);
      const name = ref && imageName(ref[1], ref[2]);
      if (!name || !table.has(name) || table.get(name).runs === 'root') return;
      const own = sc === null ? '' : blockText(lines, sc);
      // The pod: the `containers:` or `initContainers:` key above this item, and the
      // `securityContext:` at that key's indent in the same pod spec.
      let k = i;
      while (k > 0 && !(indent(lines[k]) === item[1].length - 2 && /^\s*(initContainers|containers):\s*$/.test(lines[k]))) k -= 1;
      const podIndent = indent(lines[k]);
      let s = k;
      while (s > 0 && (skip(lines[s - 1]) || indent(lines[s - 1]) >= podIndent)) s -= 1;
      let e = k;
      while (e + 1 < lines.length && (skip(lines[e + 1]) || indent(lines[e + 1]) >= podIndent)) e += 1;
      const podSc = lines.findIndex((l, j) => j >= s && j <= e && indent(l) === podIndent && /^\s*securityContext:\s*$/.test(l));
      let pod = podSc === -1 ? '' : blockText(lines, podSc);
      const viaValues = pod.match(/include "aber\.podSecurityContext" \.Values\.(\w+)\.podSecurityContext/);
      if (viaValues) pod = subBlock(blockOf(viaValues[1]), 'podSecurityContext').join('\n');
      const stated = (re) => {
        const mine = [...own.matchAll(re)].map((m) => m[1]);
        return mine.length ? mine : [...pod.matchAll(re)].map((m) => m[1]);
      };
      const where = `${f}:${i + 1} (${item[2]}, ${name})`;
      const [uid, gid] = table.get(name).runs.split(':');
      const uids = stated(/runAsUser:\s*(\d+)/g);
      const gids = stated(/runAsGroup:\s*(\d+)/g);
      const allowed = ROOT_ALSO.has(name) ? [uid, '0'] : [uid];
      if (!uids.includes(uid) || uids.some((u) => !allowed.includes(u))) bad.push(`${where} runs as ${uids.join(' or ') || 'its image\'s user, unstated'}; the Users table says ${uid}`);
      if (!gids.includes(gid) || gids.some((g) => g !== gid)) bad.push(`${where} states runAsGroup ${gids.join(' or ') || 'nowhere'}; the Users table says ${gid}`);
      if (!/runAsNonRoot: true/.test(own + pod)) bad.push(`${where} does not set runAsNonRoot: true`);
      seen.set(name, (seen.get(name) || 0) + 1);
    });
  }
  for (const [name, { runs }] of table) {
    if (runs !== 'root' && !seen.has(name)) bad.push(`no container in ${TEMPLATES} runs ${name}, so its row in the Users table is unchecked`);
  }

  const named = [...table.keys()].filter((n) => dockerfileOf.has(n) && !/^\d/.test(users.get(dockerfileOf.get(n)) || '0') && table.get(n).runs !== 'root');
  if (bad.length) {
    fail(`an image runs as root, or its Dockerfile, the chart and the runbook's Users table disagree:\n${bad.map((x) => `        ${x}`).join('\n')}`);
  } else {
    pass(`all ${users.size} Dockerfiles end as a non-root user or say why not; the chart runs ${seen.size} images in ${[...seen.values()].reduce((a, b) => a + b, 0)} containers as the Users table's uid:gid` +
      (named.length ? ` (${named.join(', ')} names its user in its Dockerfile; the chart states the uid)` : ''));
  }
}
