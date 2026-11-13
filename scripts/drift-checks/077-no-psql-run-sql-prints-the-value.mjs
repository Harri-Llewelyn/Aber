import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 77. No psql-run SQL prints the value it hands a session setting. `SELECT set_config(name, :'var',
// false);` returns the value as a one-row result and psql prints it, into db-init's and the
// historian maintenance Job's logs and from there into Loki, and several of these values are role
// passwords and secrets. Each such statement ends `\g /dev/null` (or `\gset`) instead of `;`.
// Every one, not only those whose variable is named like a secret, because a name proves nothing.
// Read from every .sql the stack runs (the archived migrations never run) and from the chart's
// templates, where SQL can be written inline.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const files = allFiles.filter((f) => (/\.sql$/.test(f) && !f.startsWith('supabase/migrations/archive/'))
    || /^deploy\/helm\/aber\/templates\/.*\.(ya?ml|tpl)$/.test(f));
  const offenders = [];
  let discarded = 0;
  for (const f of files) {
    const text = read(f);
    // From SELECT set_config( to the statement's end: a `;`, or the backslash command that sends it.
    for (const m of text.matchAll(/^[ \t]*SELECT\s+(?:pg_catalog\.)?set_config\s*\(([^;\\]*)(;|\\[A-Za-z]+(?:[ \t]+[^\s;]+)?)/gim)) {
      if (!/:(?:'[A-Za-z_]\w*'|"[A-Za-z_]\w*"|[A-Za-z_]\w*)/.test(m[1].replace(/::\w+/g, ''))) continue;
      if (/^\\gset\b/.test(m[2]) || /^\\g[ \t]+\/dev\/null$/.test(m[2])) { discarded += 1; continue; }
      offenders.push(`${f}:${text.slice(0, m.index).split('\n').length}`);
    }
  }
  if (offenders.length) {
    fail(`psql prints the value these set_config() calls are given, which can be a password or a `
       + `secret, into the Job's log: end each with \\g /dev/null instead of ;: ${offenders.join(', ')}`);
  } else {
    pass(`all ${discarded} set_config() call(s) that take a psql variable discard the value rather than print it`);
  }
}
