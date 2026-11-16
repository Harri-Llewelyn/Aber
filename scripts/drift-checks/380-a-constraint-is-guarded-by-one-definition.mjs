import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 380. A constraint is guarded by one definition. A guard drops a constraint whose definition differs
// from its own and adds its own, and db-init replays every file on every boot, 0001 first. Two files
// that guard one constraint with different definitions drop and add it in turn on every boot: it
// takes an ACCESS EXCLUSIVE lock and a scan each time and never keeps its oid. A change to a
// constraint 0001 declares goes in a second constraint, as 0291 does for an area's and a cell's name.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const dir = 'supabase/migrations';
  const files = readdirSync(join(REPO, dir)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const GUARD = /WHERE conname = '((?:[^']|'')+)'\s+AND conrelid = '((?:[^']|'')+)'::regclass\s+AND public\.live_constraint_definition\(conrelid, conname\) <> '((?:[^']|'')*)'\) THEN/g;
  const guarded = new Map();
  for (const name of files) {
    for (const m of read(`${dir}/${name}`).matchAll(GUARD)) {
      const key = `${m[2]} ${m[1]}`;
      if (!guarded.has(key)) guarded.set(key, new Map());
      guarded.get(key).set(name.slice(0, 4), m[3]);
    }
  }
  const offences = [];
  for (const [key, byFile] of guarded) {
    if (new Set(byFile.values()).size > 1) {
      offences.push(`${key} is guarded with different definitions by ${[...byFile.keys()].join(' and ')}, so every boot puts one back and then the other: change it in a second constraint, or in the one file that declares it`);
    }
  }
  if (guarded.size < 150) offences.push(`only ${guarded.size} constraint guards were read: the pattern no longer matches the chain's guards`);
  if (offences.length) {
    fail('a constraint is guarded by two definitions:\n' + offences.map((o) => `        ${o}`).join('\n'));
  } else {
    pass(`each of ${guarded.size} guarded constraints is guarded by one definition across the applied migrations`);
  }
}
