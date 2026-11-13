import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { allFiles, fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 9b. Every inline `migration NNNN` citation names a migration that exists and executes.
//
// The pre-beta chain was squashed into 0001/0002 and archived under `20260101000029_*.sql`
// names, so a bare four-digit citation above the applied range points at nothing today and at
// something else once that number is issued. The rule: a bare `migration NNNN` must name an
// applied migration; anything in the archive must say `archived migration NNNN`. Markdown is
// scanned too. (The examples here avoid the literal shape, since this check scans its own source.)
// -------------------------------------------------------------------------------------------------
export default function check() {
  const dir = 'supabase/migrations';
  const applied = new Set(
    readdirSync(join(REPO, dir), { withFileTypes: true })
      .filter((e) => e.isFile() && /^\d+_.*\.sql$/.test(e.name))
      .map((e) => e.name.match(/^(\d+)_/)[1])
  );

  // Everything this repository authors. The chart's files/ and the platform playbook's module
  // are generated mirrors (their sources are scanned in their own right), the archive is the
  // thing being cited, and node_modules is not ours.
  const scanned = allFiles.filter(
    (f) =>
      /\.(js|jsx|ts|mjs|py|sql|md|ya?ml)$/.test(f) &&
      !f.startsWith('supabase/migrations/archive/') &&
      !f.startsWith('deploy/helm/aber/files/') &&
      f !== 'supabase/functions/_shared/gatewayPlatform.generated.ts' &&
      !f.startsWith('.claude/') &&
      !f.startsWith('frontend/dist/')
  );

  const dangling = [];
  for (const file of scanned) {
    const body = read(file);
    for (const m of body.matchAll(/(archived\s+)?\bmigration (\d{4})\b/gi)) {
      if (m[1]) continue;            // explicitly archived; the number is the archive's
      if (applied.has(m[2])) continue;
      const line = body.slice(0, m.index).split('\n').length;
      dangling.push(`${file}:${line} cites "migration ${m[2]}", which is not in ${dir}/`);
    }
  }

  if (dangling.length) {
    for (const d of dangling.slice(0, 12)) fail(d);
    if (dangling.length > 12) fail(`...and ${dangling.length - 12} more dangling migration citation(s)`);
    fail(
      'A citation must name an APPLIED migration, or say "archived migration NNNN" for one in\n' +
        '      supabase/migrations/archive/, which never executes. A bare number that is not\n' +
        '      applied points a reader at nothing; check 9d keeps it from ever naming a live one.'
    );
  } else {
    pass(`every inline migration citation across ${scanned.length} files names an applied migration or is marked archived`);
  }
}
