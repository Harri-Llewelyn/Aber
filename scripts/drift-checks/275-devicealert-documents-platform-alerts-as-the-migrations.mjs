import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 275. DeviceAlert documents platform_alerts as the migrations declare it: each column of the table
// is a property, and a property that is no column says it is on platform_alerts_active only. The
// columns are 0001's CREATE TABLE and any later ADD COLUMN. A column left out is one an API client
// never learns of; one documented after it is dropped is one it asks for and is refused.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const SPEC = 'docs/openapi.yaml';
  const VIEW_ONLY = 'On `platform_alerts_active` only';
  const spec = read(SPEC);
  const problems275 = [];
  const columns = new Set();
  for (const file of readdirSync(join(REPO, 'supabase/migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()) {
    const sql = read(`supabase/migrations/${file}`);
    const table = sql.match(/^CREATE TABLE IF NOT EXISTS public\.platform_alerts \(\n([\s\S]*?)\n\);/m)?.[1] ?? '';
    for (const line of table.split('\n')) {
      // Four spaces, then a column's name (`values` is quoted, a reserved word); a CONSTRAINT is upper case.
      const name = /^ {4}"?([a-z][a-z0-9_]*)"? [a-z]/.exec(line)?.[1];
      if (name) columns.add(name);
    }
    for (const m of sql.matchAll(/ALTER TABLE (?:ONLY )?public\.platform_alerts\s+ADD COLUMN (?:IF NOT EXISTS )?"?([a-z][a-z0-9_]*)/gi)) {
      columns.add(m[1]);
    }
  }
  if (columns.size < 10) problems275.push(`supabase/migrations: found ${columns.size} platform_alerts columns, so the table was not parsed`);
  const schema = spec.match(/^ {4}DeviceAlert:\n([\s\S]*?)(?=^ {4}\S)/m)?.[1] ?? '';
  // Each property with its own lines, up to the next property.
  const properties = new Map();
  let current = null;
  for (const line of schema.split('\n')) {
    const name = /^ {8}(\w+):/.exec(line)?.[1];
    if (name) properties.set((current = name), line);
    else if (current && /^ {9,}\S/.test(line)) properties.set(current, `${properties.get(current)}\n${line}`);
  }
  for (const c of columns) {
    if (!properties.has(c)) problems275.push(`${SPEC}: DeviceAlert does not document platform_alerts.${c}`);
  }
  for (const [name, text] of properties) {
    if (!columns.has(name) && !text.includes(VIEW_ONLY)) {
      problems275.push(`${SPEC}: DeviceAlert documents ${name}, which platform_alerts has no column for, and does not say "${VIEW_ONLY}"`);
    }
  }
  if (problems275.length) {
    fail('DeviceAlert does not document platform_alerts as the migrations declare it:\n' +
      problems275.map((p) => `        ${p}`).join('\n'));
  } else {
    const viewOnly = [...properties.keys()].filter((p) => !columns.has(p)).length;
    pass(`docs/openapi.yaml's DeviceAlert documents all ${columns.size} platform_alerts columns, and says its other ${viewOnly} properties are platform_alerts_active's`);
  }
}
