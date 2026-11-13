import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 11a. Every public column is reachable from something that reads or writes it.
//
// A static question (is there a write path or a read path anywhere), because occupancy cannot
// tell "unused" from "empty on this stack": `devices.quarantine_reason` is NULL on every row of a
// fresh install and is evidence the platform keeps. The declaring statement is stripped, not the
// declaring file: a column consumed entirely inside its own migration's functions is reachable.
//
// Limits: a substring search over the tree, so a short or common column name is unfalsifiable,
// and `SELECT *` / `to_jsonb(NEW)` reach every column without naming one (that direction only
// makes the check more willing to call something reachable).
// -------------------------------------------------------------------------------------------------
export default function check() {
  const migFiles = readdirSync(join(REPO, 'supabase/migrations'))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  const migSrc = migFiles.map((f) => [f, read(`supabase/migrations/${f}`)]);

  const CREATE_TABLE = /CREATE TABLE (?:IF NOT EXISTS )?public\.([a-z0-9_]+)\s*\(([\s\S]*?)\n\);/gi;
  const ADD_COLUMN =
    /ALTER TABLE (?:ONLY )?public\.([a-z0-9_]+)\s+ADD COLUMN (?:IF NOT EXISTS )?([a-z][a-z0-9_]*)/gi;

  const columns = new Map();
  for (const [, sql] of migSrc) {
    for (const m of sql.matchAll(CREATE_TABLE)) {
      for (const line of m[2].split('\n')) {
        // Four-space indent is how this schema writes a column; a constraint continuation or a
        // CASE arm inside a generated-column expression is not one.
        const cm = /^\s{4}([a-z][a-z0-9_]*)\s+[a-z]/i.exec(line);
        if (!cm) continue;
        if (/^(constraint|primary|unique|foreign|check|else|when|then)$/i.test(cm[1])) continue;
        if (!columns.has(`${m[1]}.${cm[1]}`)) columns.set(`${m[1]}.${cm[1]}`, cm[1]);
      }
    }
    for (const m of sql.matchAll(ADD_COLUMN)) {
      if (!columns.has(`${m[1]}.${m[2]}`)) columns.set(`${m[1]}.${m[2]}`, m[2]);
    }
  }

  // Everything that could name a column, minus the statements that declare one.
  let searchable = '';
  for (const [, sql] of migSrc) {
    searchable +=
      sql
        .replace(CREATE_TABLE, '')
        .replace(
          /ALTER TABLE (?:ONLY )?public\.[a-z0-9_]+\s+ADD COLUMN (?:IF NOT EXISTS )?[a-z][a-z0-9_]*[^;]*;/gi,
          ''
        ) + '\n';
  }
  const walkInto = (dir) => {
    let entries;
    try {
      entries = readdirSync(join(REPO, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (!/^(node_modules|__pycache__|dist|\.git)$/.test(e.name)) walkInto(rel);
      } else if (/\.(js|jsx|ts|tsx|py|sql|mjs|json|ya?ml)$/.test(e.name)) {
        searchable += read(rel) + '\n';
      }
    }
  };
  for (const d of [
    'frontend/src', 'supabase/functions', 'ingestion', 'i3x', 'timescaledb',
    'scripts', 'grafana', 'node-red', 'test-harness', 'docs',
  ]) {
    walkInto(d);
  }

  // Stated exceptions, the same arrangement NOT_PUBLISHED uses for relations: a column that is
  // deliberately write-only or reserved goes here WITH ITS REASON, so the next reader meets an
  // argument rather than an empty allow-list.
  const UNREACHABLE_BY_DESIGN = new Map([]);

  const orphans = [...columns]
    .filter(([key, col]) => !UNREACHABLE_BY_DESIGN.has(key) && !new RegExp(`\\b${col}\\b`).test(searchable))
    .map(([key]) => key)
    .sort();

  if (orphans.length) {
    fail(
      `${orphans.length} public column(s) are named by nothing that reads or writes them: ` +
        `${orphans.join(', ')}.\n` +
        '      Either wire the column up, drop it in a migration, or -- if it is deliberately\n' +
        '      write-only or reserved -- add it to UNREACHABLE_BY_DESIGN in this script WITH the\n' +
        '      reason. Do not assume it is dead because it is empty: several columns here are NULL\n' +
        '      for every row on a fresh stack and are load-bearing when they are not.'
    );
  } else {
    pass(`all ${columns.size} public columns are reachable from a read or write path`);
  }
}
