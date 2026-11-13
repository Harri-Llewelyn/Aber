import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 140. A workflow job that listens on a fixed local port inside Linux's ephemeral range reserves
// it first, before its cluster exists: k8s-validation for the dev loop's forwards
// (scripts/dev-cluster.mjs), the restore rehearsal for its tunnels (scripts/rehearse-restore.sh).
// Each RESERVED_PORTS names exactly the in-range ports, so a forward moved into the range is
// reserved and one moved out leaves no stale entry.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const [LOW, HIGH] = [32768, 60999];
  const inRange = (p) => p >= LOW && p <= HIGH;
  const expand = (spec) => spec.split(',').flatMap((part) => {
    const [a, b = a] = part.split('-').map(Number);
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  });
  // The job's block of the workflow, up to the next job; its reserve step's list, and whether that
  // step comes before the cluster is created.
  const reservedIn = (file, job) => {
    const text = read(file);
    const start = text.indexOf(`\n  ${job}:\n`);
    if (start < 0) return { error: `${file} has no job ${job}` };
    const rest = text.slice(start + job.length + 5);
    const end = rest.search(/^ {2}[a-z0-9_-]+:$/m);
    const block = end < 0 ? rest : rest.slice(0, end);
    const spec = /^\s+RESERVED_PORTS:\s*(\d[\d,-]*)\s*$/m.exec(block);
    if (!spec) return { error: `${file}'s ${job} job has no RESERVED_PORTS step` };
    const cluster = block.search(/install-k3d/);
    if (cluster >= 0 && spec.index > cluster) return { error: `${file}'s ${job} job reserves its ports after it sets up k3d; move the step before it` };
    return { ports: new Set(expand(spec[1])) };
  };
  const dev = read('scripts/dev-cluster.mjs');
  const constants = new Map([...dev.matchAll(/^const ([A-Z_]+) = (\d+)$/gm)].map((m) => [m[1], Number(m[2])]));
  const devPorts = [/^const FORWARDS = \[\n([\s\S]*?)\n\]/m, /^const LB_FORWARDS = \[\n([\s\S]*?)\n\]/m]
    .flatMap((list) => [...(list.exec(dev)?.[1] ?? '').matchAll(/\{ local: (\d+|[A-Z_]+),/g)]
      .map((m) => (/^\d+$/.test(m[1]) ? Number(m[1]) : constants.get(m[1]))));
  const tunnelPorts = [...read('scripts/rehearse-restore.sh').matchAll(/^([A-Z_]+_PORT)="\$\{\1:-(\d+)\}"$/gm)].map((m) => Number(m[2]));
  const wrong = [];
  for (const { file, job, source, ports, least } of [
    { file: '.github/workflows/ci.yml', job: 'k8s-validation', source: 'scripts/dev-cluster.mjs (FORWARDS, LB_FORWARDS)', ports: devPorts, least: 15 },
    { file: '.github/workflows/restore-rehearsal.yml', job: 'rehearse', source: 'scripts/rehearse-restore.sh (*_PORT)', ports: tunnelPorts, least: 5 },
  ]) {
    if (ports.length < least || ports.some((p) => !Number.isInteger(p))) {
      wrong.push(`found ${ports.length} fixed ports in ${source}; the extraction no longer matches the file`);
      continue;
    }
    const got = reservedIn(file, job);
    if (got.error) { wrong.push(got.error); continue; }
    const want = new Set(ports.filter(inRange));
    for (const p of want) if (!got.ports.has(p)) wrong.push(`${source} listens on ${p}, inside ${LOW}-${HIGH}, and ${file}'s ${job} job does not reserve it. Add it to RESERVED_PORTS`);
    for (const p of got.ports) if (!want.has(p)) wrong.push(`${file}'s ${job} job reserves ${p}, which ${source} does not listen on inside ${LOW}-${HIGH}. Remove it from RESERVED_PORTS`);
  }
  if (wrong.length) {
    fail(`a fixed forward port in the runner's ephemeral range is not reserved, or a reservation is stale:\n${wrong.map((w) => `        ${w}`).join('\n')}`);
  } else {
    pass(`every fixed forward port inside ${LOW}-${HIGH} is reserved before its cluster exists (${[...devPorts, ...tunnelPorts].filter(inRange).join(', ')})`);
  }
}
