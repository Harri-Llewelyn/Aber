import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 59. A boot that changes no policy or trigger takes no lock for one. Each DROP POLICY, CREATE
// POLICY and DROP TRIGGER makes supautils lock up to 24 GoTrue, Storage and Realtime tables, so
// every CREATE POLICY and CREATE TRIGGER in an applied migration is the one-line statement of a
// replay_policy() or replay_trigger() call (0001, section 3c), which re-creates it only when the
// live one differs, in one statement with its DROP. No file drops one at the top level. One file
// states each in full: an earlier file passes p_stated_by naming it, or every boot re-creates the
// object twice. A constraint guard compares live_constraint_definition(), never pg_get_constraintdef()
// under db-init's search path, which leaves a key to auth.users unqualified so it never matches. And
// 0001 never drops the historian's server, which would take the telemetry views.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const dir = 'supabase/migrations';
  const files = readdirSync(join(REPO, dir)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const offences = [];
  const unquote = (s) => (/^".*"$/.test(s) ? s.slice(1, -1).replace(/""/g, '"') : s);
  const CALL = /^SELECT public\.replay_(policy|trigger)\('((?:[^']|'')+)', '((?:[^']|'')+)', \$ddl\$$/;
  const CLOSE = /^\$ddl\$(?:, p_stated_by => '([^']+)')?\);$/;
  const CREATE = /^CREATE (?:OR REPLACE )?(?:CONSTRAINT )?(POLICY|TRIGGER)\b/;
  // The object a CREATE names, as the generator reads it: [name, table].
  const named = (kind, stmt) => (kind === 'policy'
    ? /^CREATE POLICY ("(?:[^"]|"")+"|\S+) ON (\S+)/.exec(stmt)
    : /^CREATE (?:CONSTRAINT )?TRIGGER (\S+)[\s\S]*?\bON (\S+)/.exec(stmt));
  const stated = new Map();
  files.forEach((name, order) => {
    const lines = read(`${dir}/${name}`).split('\n');
    lines.forEach((line, i) => {
      const at = `${name}:${i + 1}`;
      if (/\bpg_get_constraintdef\(oid\) <> '/.test(line)) {
        offences.push(`${at} compares pg_get_constraintdef() under db-init's search path, so the guard drops and adds the constraint back on every boot: compare public.live_constraint_definition(conrelid, conname)`);
      }
      if (/^DROP (POLICY|TRIGGER)\b/.test(line)) {
        offences.push(`${at} drops a ${line.split(' ')[1].toLowerCase()} at the top level, which takes supautils' locks on every boot, gone or not: drop it in a DO block guarded on pg_policy or pg_trigger`);
      }
      const create = CREATE.exec(line);
      if (create && !(CALL.test(lines[i - 1] || '') && CLOSE.test(lines[i + 1] || ''))) {
        offences.push(`${at} creates a ${create[1].toLowerCase()} outside a replay_${create[1].toLowerCase()}() call, so every boot re-creates it: state it as 0001 does, one line between the call and its closing $ddl$`);
      }
      const call = CALL.exec(line);
      if (!call) return;
      const [, kind, table, objectName] = call;
      const stmt = lines[i + 1] || '';
      const close = CLOSE.exec(lines[i + 2] || '');
      const object = named(kind, stmt);
      if (!close || !stmt.endsWith(';') || !object) {
        offences.push(`${at} replay_${kind}() is not followed by one CREATE ${kind.toUpperCase()} line ending in ; and the closing $ddl$ line`);
        return;
      }
      if (unquote(object[1]) !== objectName.replace(/''/g, "'") || object[2] !== table.replace(/''/g, "'")) {
        offences.push(`${at} replay_${kind}('${table}', '${objectName}') is passed a statement for ${object[1]} on ${object[2]}`);
        return;
      }
      const key = `${kind} ${objectName} on ${table}`;
      if (!stated.has(key)) stated.set(key, []);
      stated.get(key).push({ at, order, by: close[1] || null });
    });
  });
  for (const [key, entries] of stated) {
    const full = entries.filter((e) => !e.by);
    if (full.length > 1) {
      offences.push(`${key} is stated in full at ${full.map((e) => e.at).join(' and ')}, so every boot re-creates it twice: pass p_stated_by => '${full.at(-1).at.split(':')[0]}' in all but the last (for 0001, STATED_LATER in scripts/generate-baseline-section.mjs)`);
    }
    for (const e of entries.filter((x) => x.by)) {
      const target = files.indexOf(e.by);
      if (target <= e.order || !full.some((f) => f.order === target)) {
        offences.push(`${e.at} passes p_stated_by => '${e.by}', which is not a later applied migration stating ${key} in full: the object would never be brought up to date`);
      }
    }
  }
  const dropsServer = /^\s*DROP SERVER\b/im.test(read(`${dir}/0001_baseline_schema.sql`));
  for (const o of offences) fail(o);
  if (dropsServer) fail('0001 drops the historian\'s foreign server, which takes every telemetry view with it until section 4 rebuilds them; alter it in place');
  if (!stated.size) fail('check 59 found no replay_policy() or replay_trigger() call in the applied migrations');
  if (!offences.length && !dropsServer && stated.size) {
    pass(`all ${stated.size} replayed policies and triggers are re-created only when they differ, each stated in full once, every constraint guard compares live_constraint_definition(), and 0001 alters the historian's server in place`);
  }
}
