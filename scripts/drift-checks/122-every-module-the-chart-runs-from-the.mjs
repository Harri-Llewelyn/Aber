import { allFiles, fail, gitignored, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 122. Every module the chart runs from the ingestion image is in it. ingestion/Dockerfile copies
// its modules by name, so a workload that runs `python -m <module>` or `python <module>.py` from
// ingestion.image, or a sibling module that one imports, can be left out. A CronJob then fails on
// every run, seen only as a failed Job an hour or a day later (the area-plan sweep, 0199).
// -------------------------------------------------------------------------------------------------
export default function check() {
  const docker = read('ingestion/Dockerfile');
  const copied = new Set([...docker.matchAll(/^COPY ingestion\/(\w+)\.py \.$/gm)].map((m) => m[1]));
  const tracked = (mod) => allFiles.includes(`ingestion/${mod}.py`) && !gitignored(`ingestion/${mod}.py`);
  const started = new Map();
  const cmd = docker.match(/^CMD \["python", "(\w+)\.py"\]/m)?.[1];
  if (cmd) started.set(cmd, 'the image\'s CMD');
  const templates = allFiles.filter((f) => f.startsWith('deploy/helm/aber/templates/') && f.endsWith('.yaml')
    && read(f).includes('.Values.ingestion.image'));
  for (const f of templates) {
    for (const m of read(f).matchAll(/"python",\s*"-m",\s*"(\w+)"|- python\s*\n\s*- -m\s*\n\s*- (\w+)|"python",\s*"(\w+)\.py"/g)) {
      started.set(m[1] || m[2] || m[3], f);
    }
  }
  const missing = [];
  const seen = new Set();
  const visit = (mod, via) => {
    if (seen.has(mod)) return;
    seen.add(mod);
    if (!tracked(mod)) {
      missing.push(`${mod}, run by ${via}, is not a module in ingestion/`);
      return;
    }
    if (!copied.has(mod)) missing.push(`ingestion/${mod}.py (${via})`);
    for (const m of read(`ingestion/${mod}.py`).matchAll(/^\s*(?:from|import)\s+(\w+)/gm)) {
      if (tracked(m[1])) visit(m[1], `imported by ${mod}.py`);
    }
  };
  for (const [mod, where] of started) visit(mod, where);

  if (!started.has('area_plan_sweep') || !started.has('cold_archive')) {
    fail(`check 122 found ${[...started.keys()].join(', ') || 'no module'} run from the ingestion image; it reads the chart's commands wrongly, since cold-archive and area-plan-sweep both run one`);
  } else if (missing.length) {
    fail(`ingestion/Dockerfile does not copy what the chart runs from its image: ${missing.join('; ')}. The workload fails on every start (0199)`);
  } else {
    pass(`every module the chart runs from the ingestion image is in it: ${[...started.keys()].join(', ')}, and the ${seen.size - started.size} sibling(s) they import`);
  }
}
