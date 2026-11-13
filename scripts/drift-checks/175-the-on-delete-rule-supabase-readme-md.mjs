import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 175. The ON DELETE rule supabase/README.md states for each person column is the one the applied
// migrations declare. Every foreign key to auth.users is listed under its rule, CASCADE, NO ACTION
// or SET NULL, and nothing listed there or under "No foreign key" disagrees. A column with no key
// cannot be found this way, so that list is kept by hand.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const README = 'supabase/README.md';
  const dir = 'supabase/migrations';
  const offences = [];
  const declared = new Map();
  const files = readdirSync(join(REPO, dir)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  for (const file of files) {
    const sql = read(`${dir}/${file}`);
    // `[ADD] CONSTRAINT x FOREIGN KEY (col) REFERENCES auth.users(id)`, or an inline column
    // `col uuid ... REFERENCES auth.users (id)`, each under the nearest CREATE or ALTER TABLE.
    const keys = /(?:FOREIGN KEY \((\w+)\)|^\s+(\w+)\s+uuid\b[^,\n]*?)\s*REFERENCES auth\.users\s*\(id\)(?: ON DELETE (CASCADE|SET NULL))?/gm;
    for (const m of sql.matchAll(keys)) {
      // A guard's quoted comparison is not a declaration.
      const line = sql.slice(sql.lastIndexOf('\n', m.index) + 1, m.index);
      if (line.includes("'")) continue;
      const tables = [...sql.slice(0, m.index).matchAll(/(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE(?: ONLY)?)\s+public\.(\w+)/g)];
      if (!tables.length) continue;
      const column = `${tables[tables.length - 1][1]}.${m[1] || m[2]}`;
      const rule = m[3] || 'NO ACTION';
      if (declared.has(column) && declared.get(column) !== rule) {
        offences.push(`${column} is declared ON DELETE ${declared.get(column)} and ON DELETE ${rule}`);
      }
      declared.set(column, rule);
    }
  }

  const readme = supabaseReadme();
  const listed = new Map();
  for (const [rule, label] of [['CASCADE', '`CASCADE`'], ['NO ACTION', '`NO ACTION`'], ['SET NULL', '`SET NULL`'], ['none', 'No foreign key']]) {
    const item = new RegExp(`^- \\*\\*${label.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')}[^*]*\\((\\d+)\\):\\*\\*([\\s\\S]*?)(?=\\n- |\\n\\n)`, 'm').exec(readme);
    if (!item) {
      offences.push(`${README} has no "- **${label} ... (n):**" item under "What deleting an account would do to the rows that name it"`);
      continue;
    }
    const columns = [...item[2].matchAll(/`(\w+\.\w+)`/g)].map((c) => c[1]);
    if (columns.length !== Number(item[1])) offences.push(`${README}'s ${label} item says ${item[1]} and lists ${columns.length}`);
    for (const column of columns) listed.set(column, rule);
  }
  for (const [column, rule] of declared) {
    if (!listed.has(column)) offences.push(`${column} references auth.users ON DELETE ${rule}, and ${README} does not list it`);
    else if (listed.get(column) !== rule) offences.push(`${column} references auth.users ON DELETE ${rule}, and ${README} lists it under ${listed.get(column)}`);
  }
  for (const [column, rule] of listed) {
    if (rule !== 'none' && !declared.has(column)) offences.push(`${README} lists ${column} under ${rule}, and no applied migration gives it a foreign key to auth.users`);
  }

  if (offences.length) {
    fail(`The person columns' ON DELETE rules are stated as the migrations declare them:\n  ${offences.join('\n  ')}`);
  } else {
    pass(`supabase/README.md lists each of the ${declared.size} foreign keys to auth.users under the ON DELETE rule the migrations declare`);
  }
}
