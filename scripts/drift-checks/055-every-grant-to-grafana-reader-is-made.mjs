import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 55. Every grant to grafana_reader is made in 0001's last block, after its sweep and in the same
// transaction, so Grafana keeps reading through a replay. A grant made only elsewhere is swept on
// every boot and refused until its own statement runs again.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const dir = 'supabase/migrations';
  const baseline = read(`${dir}/0001_baseline_schema.sql`);
  const block = baseline.match(/^DO \$grafana_reader\$\n[\s\S]*?^\$grafana_reader\$;/m);
  const grantRe = /\bGRANT\s[^;']*?\bON\s+(?:TABLE\s+|FUNCTION\s+)?(public\.[a-z_0-9]+)[^;']*?\bTO\s+(?:[a-z_]+\s*,\s*)*grafana_reader\b/gi;
  const sweepRe = /\bREVOKE\s+ALL\s+ON\s+ALL\s+(TABLES|SEQUENCES|FUNCTIONS)\s+IN\s+SCHEMA\s+public\s+FROM\s+grafana_reader\b/gi;
  if (!block) {
    fail('0001_baseline_schema.sql has no `DO $grafana_reader$` block: the sweep and the grants of grafana_reader must be one statement at the end of the file');
  } else {
    const inside = new Set([...block[0].matchAll(grantRe)].map((m) => m[1].toLowerCase()));
    const swept = new Set([...block[0].matchAll(sweepRe)].map((m) => m[1].toUpperCase()));
    const unswept = ['TABLES', 'SEQUENCES', 'FUNCTIONS'].filter((k) => !swept.has(k));
    const elsewhere = [];
    const sweptElsewhere = [];
    const files = readdirSync(join(REPO, dir)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    for (const name of files) {
      let text = read(`${dir}/${name}`);
      if (name === '0001_baseline_schema.sql') text = text.replace(block[0], '');
      for (const m of text.matchAll(grantRe)) if (!inside.has(m[1].toLowerCase())) elsewhere.push(`${name}: ${m[1]}`);
      if (sweepRe.test(text)) sweptElsewhere.push(name);
      sweepRe.lastIndex = 0;
    }
    if (unswept.length) fail(`0001's grafana_reader block does not sweep ${unswept.join(', ')}, so a grant removed from it would survive an upgrade`);
    for (const e of elsewhere) {
      fail(`${e} is granted to grafana_reader outside 0001's last block and not in it: the block's sweep takes it away on every boot until that grant runs again. Add it to the block (guarded by to_regclass if a later file creates it)`);
    }
    for (const f of sweptElsewhere) fail(`${f} sweeps grafana_reader's privileges outside 0001's last block, which leaves Grafana refused until the block runs`);
    if (!unswept.length && !elsewhere.length && !sweptElsewhere.length) {
      pass(`grafana_reader's ${inside.size} grants are made in 0001's last block, after its sweep, and no migration grants it anything the block does not`);
    }
  }
}
