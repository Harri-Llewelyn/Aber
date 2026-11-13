import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 69. A pod that may start a container as root is one the runbook's *Users* section lists, after
// "These pods still start a container as root", and that list names no other pod. A container is
// non-root when it or its pod states runAsNonRoot: true (values.yaml's podSecurityContext included)
// and neither states runAsUser: 0 in any branch; a helper's container, such as a wait-for, takes its
// pod's. Pod Security "restricted" refuses every pod on that list, so it is the dry run's list too.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const TEMPLATES = 'deploy/helm/aber/templates/';
  const RUNBOOK = 'deploy/k8s/README.md';
  const WORKLOAD = /^kind:\s*(Deployment|StatefulSet|DaemonSet|Job|CronJob)\s*$/;
  const indent = (l) => l.match(/^ */)[0].length;
  const skip = (l) => !l.trim() || /^\s*#/.test(l) || /^\s*\{\{.*\}\}\s*$/.test(l);
  const blockText = (lines, i) => {
    let t = '';
    for (let j = i + 1; j < lines.length && (!lines[j].trim() || indent(lines[j]) > indent(lines[i])); j++) t += `${lines[j]}\n`;
    return t;
  };
  const files = allFiles.filter((p) => p.startsWith(TEMPLATES) && /\.(ya?ml|tpl)$/.test(p));
  const blank = (f) => read(f).replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, (c) => c.replace(/[^\n]/g, '')).split('\n');

  // Helpers that render a container: a define whose body is a `- name:` item with an `image:`.
  const containerHelpers = new Set();
  for (const f of files.filter((p) => p.endsWith('.tpl'))) {
    for (const m of read(f).matchAll(/\{\{-? define "([^"]+)" -?\}\}([\s\S]*?)\{\{-? end -?\}\}\n(?=\n|\{\{\/\*|\{\{-? define|$)/g)) {
      if (/^- name:[^\n]*\n {2}image:/m.test(m[2])) containerHelpers.add(m[1]);
    }
  }
  // values.yaml's <key>.podSecurityContext, for a pod that takes it through aber.podSecurityContext.
  const VALUES = read('deploy/helm/aber/values.yaml').split('\n');
  const podValues = (key) => {
    const s = VALUES.findIndex((l) => l === `${key}:`);
    const p = s === -1 ? -1 : VALUES.findIndex((l, j) => j > s && l === '  podSecurityContext:');
    if (p === -1 || VALUES.slice(s + 1, p).some((l) => /^\S/.test(l))) return '';
    let t = '';
    for (let j = p + 1; j < VALUES.length && (/^ {4}/.test(VALUES[j]) || /^\s*#/.test(VALUES[j])); j++) t += `${VALUES[j]}\n`;
    return t;
  };

  const rootPods = new Map();
  let pods = 0;
  for (const f of files) {
    const lines = blank(f);
    lines.forEach((line, i) => {
      if (!/^ *containers:\s*$/.test(line)) return;
      pods += 1;
      const podIndent = indent(line);
      let s = i;
      while (s > 0 && (skip(lines[s - 1]) || indent(lines[s - 1]) >= podIndent)) s -= 1;
      let e = i;
      while (e + 1 < lines.length && (skip(lines[e + 1]) || indent(lines[e + 1]) >= podIndent)) e += 1;
      const podSc = lines.findIndex((l, j) => j >= s && j <= e && indent(l) === podIndent && /^\s*securityContext:\s*$/.test(l));
      let pod = podSc === -1 ? '' : blockText(lines, podSc);
      const viaValues = pod.match(/include "aber\.podSecurityContext" \.Values\.(\w+)\.podSecurityContext/);
      if (viaValues) pod += podValues(viaValues[1]);
      // The pod's containers: its own items with an image, and the helpers that render one.
      const why = [];
      for (let j = s; j <= e; j++) {
        const helper = lines[j].match(/include "([^"]+)"/);
        if (helper && containerHelpers.has(helper[1]) && !/runAsNonRoot: true/.test(pod)) why.push(`${helper[1]} (a helper's container, in a pod that does not set runAsNonRoot)`);
        const item = lines[j].match(/^( *)- name:\s*(.+?)\s*$/);
        if (!item) continue;
        let image = false;
        let sc = '';
        for (let k = j + 1; k < lines.length && (skip(lines[k]) || indent(lines[k]) > item[1].length); k++) {
          if (indent(lines[k]) !== item[1].length + 2) continue;
          if (/^\s*image:/.test(lines[k])) image = true;
          if (/^\s*securityContext:\s*$/.test(lines[k])) sc = blockText(lines, k);
        }
        if (!image) continue;
        if (/runAsUser:\s*0\b|runAsNonRoot:\s*false/.test(sc + pod)) why.push(`${item[2]} (runAsUser 0 or runAsNonRoot false, in some branch)`);
        else if (!/runAsNonRoot: true/.test(sc + pod)) why.push(`${item[2]} (no runAsNonRoot: true)`);
      }
      if (!why.length) return;
      // The workload: the nearest `kind:` above, its metadata name, and the file's $component.
      let k = i;
      while (k > 0 && !WORKLOAD.test(lines[k])) k -= 1;
      const name = (lines.slice(k).find((l) => /^ {2}name:/.test(l)) || '').replace(/^ {2}name:\s*/, '').trim();
      const component = (lines.join('\n').match(/\$component := "([^"]+)"/) || [])[1];
      rootPods.set(`${f}:${i + 1}`, { names: [name, component].filter(Boolean), why });
    });
  }

  // The runbook's list: the bullets after "These pods still start a container as root".
  const section = (read(RUNBOOK).match(/\n### Users\n([\s\S]*?)(?=\n### )/) || [])[1] || '';
  const after = section.split(/still start a container as root[^\n]*\n/)[1] || '';
  const listed = [];
  for (const l of after.replace(/^\n+/, '').split('\n')) {
    if (!/^(- | {2}\S)/.test(l)) break;
    const bold = l.match(/^- \*\*(.+?)\*\*/);
    if (bold) listed.push(...[...bold[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]));
  }

  const bad = [];
  if (!listed.length) bad.push(`${RUNBOOK}'s *Users* section has no list after "These pods still start a container as root"`);
  for (const [where, { names, why }] of rootPods) {
    if (!names.some((n) => listed.includes(n))) bad.push(`${where} (${names.join(', ')}) may start ${why.join('; ')}, and ${RUNBOOK}'s Users list does not name it`);
  }
  for (const n of listed) {
    if (![...rootPods.values()].some(({ names }) => names.includes(n))) bad.push(`${RUNBOOK}'s Users list names ${n}, whose pod starts every container as non-root`);
  }
  if (!pods) {
    fail(`check 69 found no pod spec under ${TEMPLATES}, so it reads nothing`);
  } else if (bad.length) {
    fail(`a pod may start a container as root and the runbook does not say so, or the runbook lists a pod that does not:\n${bad.map((x) => `        ${x}`).join('\n')}`);
  } else {
    pass(`of the chart's ${pods} pod specs, the ${rootPods.size} that may start a container as root are the runbook's Users list (${listed.join(', ')})`);
  }
}
