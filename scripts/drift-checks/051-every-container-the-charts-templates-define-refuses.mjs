import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 51. Every container the chart's templates define refuses privilege escalation and drops every
// capability, and every pod runs the RuntimeDefault seccomp profile. A capability a container adds
// back is in the Pod Security "baseline" set, and the runbook's *Security contexts* table names it
// with the same list; the table names nothing the templates do not add. Read from the template
// text: a `- name:` item with an `image:` key is a container, in a workload or in a helper.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const TEMPLATES = 'deploy/helm/aber/templates/';
  const RUNBOOK = 'deploy/k8s/README.md';
  const BASELINE = new Set(['AUDIT_WRITE', 'CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'KILL', 'MKNOD',
    'NET_BIND_SERVICE', 'SETFCAP', 'SETGID', 'SETPCAP', 'SETUID', 'SYS_CHROOT']);
  const indent = (l) => l.match(/^ */)[0].length;
  // Blank lines, YAML comments and lines holding only a template action sit at any indent, so they
  // neither end a block nor belong to one.
  const skip = (l) => !l.trim() || /^\s*#/.test(l) || /^\s*\{\{.*\}\}\s*$/.test(l);
  // The indices of the lines nested under line i.
  const under = (lines, i) => {
    const out = [];
    for (let j = i + 1; j < lines.length && (skip(lines[j]) || indent(lines[j]) > indent(lines[i])); j++) {
      if (!skip(lines[j])) out.push(j);
    }
    return out;
  };
  const files = allFiles.filter((f) => f.startsWith(TEMPLATES) && /\.(ya?ml|tpl)$/.test(f));
  const bad = [];
  const adds = new Map();
  let containers = 0;
  let pods = 0;
  for (const f of files) {
    // Template comments are blanked with their line breaks kept, so the line numbers stay true.
    const lines = read(f).replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, (c) => c.replace(/[^\n]/g, '')).split('\n');
    const faults = [];
    lines.forEach((line, i) => {
      const item = line.match(/^( *)- name:\s*(.+?)\s*$/);
      if (item) {
        const body = under(lines, i);
        const key = (k) => body.find((j) => indent(lines[j]) === item[1].length + 2 && lines[j].trimStart().startsWith(`${k}:`));
        if (key('image') === undefined) return;
        containers += 1;
        const sc = key('securityContext');
        const text = sc === undefined ? '' : under(lines, sc).map((j) => lines[j]).join('\n');
        if (!/allowPrivilegeEscalation: false/.test(text) || !/drop: \["ALL"\]/.test(text)) {
          faults.push(`${f}:${i + 1}: container ${item[2]} lacks allowPrivilegeEscalation: false or capabilities.drop: ["ALL"]`);
        }
        const add = text.match(/add: \[([^\]]*)\]/);
        if (add) {
          const caps = add[1].split(',').map((c) => c.trim().replace(/^"|"$/g, '')).filter(Boolean).sort();
          for (const c of caps) if (!BASELINE.has(c)) faults.push(`${f}:${i + 1}: container ${item[2]} adds ${c}, outside the baseline set`);
          const seen = adds.get(item[2]);
          if (seen && seen.caps.join() !== caps.join()) {
            faults.push(`${f}:${i + 1}: container ${item[2]} adds [${caps}] and ${seen.where} adds [${seen.caps}] under the same name`);
          }
          adds.set(item[2], { caps, where: `${f}:${i + 1}` });
        }
        return;
      }
      if (!/^ *containers:\s*$/.test(line)) return;
      pods += 1;
      // The pod spec is every line around `containers:` at its indent or deeper.
      let s = i;
      while (s > 0 && (skip(lines[s - 1]) || indent(lines[s - 1]) >= indent(line))) s -= 1;
      let e = i;
      while (e + 1 < lines.length && (skip(lines[e + 1]) || indent(lines[e + 1]) >= indent(line))) e += 1;
      const sc = lines.findIndex((l, j) => j >= s && j <= e && indent(l) === indent(line) && /^ *securityContext:\s*$/.test(l));
      // Read raw, template actions included: the helper that builds a pod context from values is one.
      let text = '';
      for (let j = sc + 1; sc >= 0 && j < lines.length && (!lines[j].trim() || indent(lines[j]) > indent(line)); j++) text += `${lines[j]}\n`;
      if (!/seccompProfile:\s*\n\s*type: RuntimeDefault/.test(text) && !text.includes('include "aber.podSecurityContext"')) {
        faults.push(`${f}:${i + 1}: the pod sets no seccompProfile of type RuntimeDefault`);
      }
    });
    bad.push(...faults);
  }

  // The runbook's table: container names in backticks before any parenthesis, capabilities in backticks.
  const runbook = read(RUNBOOK);
  const section = runbook.match(/\n### Security contexts\n([\s\S]*?)(?=\n### )/);
  const table = new Map();
  for (const row of (section ? section[1] : '').split('\n').filter((l) => /^\| `/.test(l))) {
    const [, who, what] = row.split('|');
    const caps = [...what.matchAll(/`([A-Z_]+)`/g)].map((m) => m[1]).sort();
    for (const m of who.split('(')[0].matchAll(/`([^`]+)`/g)) table.set(m[1], caps);
  }
  if (!section || !table.size) bad.push(`${RUNBOOK} has no *Security contexts* table naming a container's added capabilities`);
  for (const [name, { caps, where }] of adds) {
    const listed = table.get(name);
    if (!listed) bad.push(`${where}: container ${name} adds [${caps}], which ${RUNBOOK}'s Security contexts table does not name`);
    else if (listed.join() !== caps.join()) bad.push(`${RUNBOOK}'s Security contexts table gives ${name} [${listed}]; ${where} adds [${caps}]`);
  }
  for (const name of table.keys()) {
    if (!adds.has(name)) bad.push(`${RUNBOOK}'s Security contexts table names ${name}, which adds no capability in the templates`);
  }

  if (!containers || !pods) {
    fail(`check 51 found ${containers} container(s) and ${pods} pod spec(s) under ${TEMPLATES}, so it reads nothing`);
  } else if (bad.length) {
    fail(`a container or pod in the chart lacks its security context, or the runbook disagrees:\n${bad.map((x) => `        ${x}`).join('\n')}`);
  } else {
    pass(`the chart's ${containers} container definitions drop every capability and refuse escalation, its ${pods} pod specs run RuntimeDefault, and the runbook names the ${adds.size} that add capabilities back`);
  }
}
