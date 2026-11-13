import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 10f. The API reference and the Audit Trail filter name every action the trail records, and
// no other. `audit_trail.action` has no CHECK, so the set is read from what the applied
// migrations INSERT: each action is a literal, `TG_OP` (the audit trigger's INSERT, UPDATE and
// DELETE), or a variable its function assigns only literals. Any other shape fails rather than
// passing with an action unread.
// -------------------------------------------------------------------------------------------------
export default function check() {
  // `--` comments out, quote-aware per line, so an apostrophe in prose cannot open a string.
  const uncommented = (sql) => sql.split('\n').map((line) => {
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === "'") quoted = !quoted;
      else if (!quoted && line.startsWith('--', i)) return line.slice(0, i);
    }
    return line;
  }).join('\n');
  // The index of the parenthesis closing the one at `open`, skipping quoted text.
  const closing = (s, open) => {
    let depth = 0;
    let quoted = false;
    for (let i = open; i < s.length; i += 1) {
      if (s[i] === "'") quoted = !quoted;
      else if (!quoted && s[i] === '(') depth += 1;
      else if (!quoted && s[i] === ')' && --depth === 0) return i;
    }
    return -1;
  };
  const topLevel = (s) => {
    const parts = [];
    let depth = 0;
    let quoted = false;
    let start = 0;
    for (let i = 0; i < s.length; i += 1) {
      if (s[i] === "'") quoted = !quoted;
      else if (!quoted && s[i] === '(') depth += 1;
      else if (!quoted && s[i] === ')') depth -= 1;
      else if (!quoted && depth === 0 && s[i] === ',') {
        parts.push(s.slice(start, i).trim());
        start = i + 1;
      }
    }
    return [...parts, s.slice(start).trim()];
  };

  const written = new Map();
  const unread = [];
  let sites = 0;
  const files = readdirSync(join(REPO, 'supabase/migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  for (const file of files) {
    const sql = uncommented(read(`supabase/migrations/${file}`));
    for (const m of sql.matchAll(/INSERT\s+INTO\s+(?:public\.)?audit_trail\b/gi)) {
      sites += 1;
      const at = `${file}:${sql.slice(0, m.index).split('\n').length}`;
      const open = sql.indexOf('(', m.index + m[0].length);
      const columns = /^\s*\(/.test(sql.slice(m.index + m[0].length))
        ? topLevel(sql.slice(open + 1, closing(sql, open))).map((c) => c.toLowerCase())
        : [];
      const rest = sql.slice(closing(sql, open) + 1);
      const values = /^\s*VALUES\s*\(/i.exec(rest);
      if (!columns.includes('action') || !values) {
        unread.push(`${at}: not \`INSERT INTO audit_trail (..., action, ...) VALUES (...)\``);
        continue;
      }
      const tupleAt = closing(sql, open) + 1 + values[0].length - 1;
      const expr = topLevel(sql.slice(tupleAt + 1, closing(sql, tupleAt)))[columns.indexOf('action')];
      const record = (action) => written.set(action, [...(written.get(action) || []), at]);
      if (/^'[A-Z_]+'$/.test(expr)) {
        record(expr.slice(1, -1));
      } else if (expr === 'TG_OP') {
        ['INSERT', 'UPDATE', 'DELETE'].forEach(record);
      } else if (/^[a-z_][a-z0-9_]*$/.test(expr)) {
        // The function around the INSERT: from its CREATE to the end of its body.
        const begin = sql.lastIndexOf('CREATE OR REPLACE FUNCTION', m.index);
        const end = sql.indexOf('$$;', m.index);
        const body = sql.slice(begin, end < 0 ? undefined : end);
        const assigned = [...body.matchAll(new RegExp(`\\b${expr}\\s*:=\\s*([^;]+);`, 'g'))].map((a) => a[1].trim());
        if (begin < 0 || !assigned.length || assigned.some((a) => !/^'[A-Z_]+'$/.test(a))) {
          unread.push(`${at}: \`${expr}\` is not assigned only literals in its function`);
        } else {
          assigned.forEach((a) => record(a.slice(1, -1)));
        }
      } else {
        unread.push(`${at}: the action is \`${expr}\``);
      }
    }
  }

  // The schema's own block: from its key to the next key at the same indentation.
  const spec = read('docs/openapi.yaml');
  const entryAt = spec.indexOf('\n    AuditTrailEntry:\n');
  const entry = entryAt < 0 ? '' : spec.slice(entryAt + 1).split(/\n(?= {4}\S)/)[0];
  const specEnum = entry.match(/\n {8}action:\n {10}type: string\n {10}enum: \[([^\]]*)\]/);
  const constants = read('frontend/src/constants.js');
  const blockAt = constants.indexOf('export const AUDIT_TRAIL_ACTIONS = {');
  const block = blockAt < 0 ? '' : constants.slice(blockAt, constants.indexOf('};', blockAt));
  const offered = [...block.matchAll(/^\s+([A-Z][A-Z_]*):/gm)].map((k) => k[1]);

  const drift = (name, listed) => {
    const missing = [...written.keys()].filter((a) => !listed.includes(a)).sort();
    const extra = listed.filter((a) => !written.has(a)).sort();
    return [
      ...missing.map((a) => `${name} lacks ${a}, which ${written.get(a)[0]} writes`),
      ...extra.map((a) => `${name} lists ${a}, which no applied migration writes`),
    ];
  };

  if (!sites) {
    fail('found no `INSERT INTO public.audit_trail` in the applied migrations; the shape this check '
      + 'reads has changed, so it is checking nothing.');
  } else if (unread.length) {
    fail(`could not read the action of ${unread.length} audit_trail INSERT(s):\n`
      + unread.map((u) => `        ${u}`).join('\n')
      + '\n      Write the action as a literal, or teach check 10f the new shape.');
  } else if (!specEnum || !offered.length) {
    fail(`could not read ${specEnum ? 'AUDIT_TRAIL_ACTIONS in frontend/src/constants.js'
      : 'the enum of AuditTrailEntry.action in docs/openapi.yaml'}, so the actions were not compared.`);
  } else {
    const problems10f = [
      ...drift('AuditTrailEntry.action in docs/openapi.yaml', specEnum[1].split(',').map((s) => s.trim()).filter(Boolean)),
      ...drift('AUDIT_TRAIL_ACTIONS in frontend/src/constants.js', offered),
    ];
    if (problems10f.length) {
      fail(`the Audit Trail's actions disagree with what the migrations write:\n`
        + problems10f.map((p) => `        ${p}`).join('\n'));
    } else {
      pass(`the API reference and the dashboard name the ${written.size} actions ${sites} trail INSERTs write`);
    }
  }
}
