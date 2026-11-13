import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 2c. Every Prometheus job the Directory maps is one the collector produces. Alloy labels each
// scraped pod's job with its component, and the host series `node`; a job named in
// `directory_liveness_job_map()` that no pod carries makes the System page report "not observed"
// for a healthy service.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const jobs = new Set(['node']);
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.yaml')) {
        const text = readFileSync(f, 'utf8');
        if (!text.includes('aber.scrapeAnnotations')) continue;
        for (const m of text.matchAll(/\$component\s*:=\s*"([a-z0-9-]+)"/g)) jobs.add(m[1]);
      }
    }
  };
  walk(join(REPO, 'deploy/helm/aber/templates'));

  // The map is declared by 0001 and redeclared by 0103; the LAST declaration in the chain wins.
  const mapped = [];
  for (const name of readdirSync(join(REPO, 'supabase/migrations')).filter((n) => n.endsWith('.sql')).sort()) {
    const sql = read(`supabase/migrations/${name}`);
    const start = sql.lastIndexOf('CREATE OR REPLACE FUNCTION public.directory_liveness_job_map()');
    if (start < 0) continue;
    const end = sql.indexOf('$$;', start);
    mapped.length = 0;
    for (const m of sql.slice(start, end).matchAll(/\(\s*'([a-z0-9._-]+)'\s*,/g)) mapped.push(m[1]);
  }

  if (!jobs.size || !mapped.length) {
    fail("could not parse the chart's scrape targets or the Directory's liveness map");
  } else {
    const orphaned = mapped.filter((j) => !jobs.has(j));
    if (orphaned.length) {
      fail(
        `directory_liveness_job_map() names Prometheus job(s) no scraped pod carries: ` +
        `${orphaned.join(', ')}. The join matches nothing, so those services report as ` +
        `UNKNOWN on the System page -- which reads as a missing exporter, not a stale mapping.`
      );
    } else {
      pass(`all ${mapped.length} Directory liveness job(s) are jobs the collector produces`);
    }
  }
}
