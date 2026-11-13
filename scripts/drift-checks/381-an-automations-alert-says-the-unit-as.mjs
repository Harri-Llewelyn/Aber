import { fail, pass, read, supabaseReadme, upgradingGuide } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 381. An automation's alert says its reading's unit as the file holds it. 0292 gives unit_symbol()
// and with_unit() a pure lookup (IMMUTABLE, search_path pinned to nothing), and both words functions
// word a measured metric through with_unit() and keep 0283's other arms. docs/automations.md's
// example carries a symbol unit_symbol() holds, the upgrade guide's section says to read the numbers
// from `values`, and the README's section is the one the file's header cites.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const FILE = 'supabase/migrations/0292_an_automation_s_alert_says_its_reading_s_unit.sql';
  const sql = read(FILE);
  const problems381 = [];
  const fnBody = (name) => sql.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`))?.[0] ?? '';
  for (const name of ['unit_symbol', 'with_unit']) {
    const body = fnBody(name);
    if (!body) problems381.push(`${FILE} does not declare ${name}()`);
    else if (!/LANGUAGE sql IMMUTABLE\n\s+SET search_path TO ''\n/.test(body)) {
      problems381.push(`${name}() is not LANGUAGE sql IMMUTABLE with SET search_path TO ''`);
    }
  }
  for (const name of ['automation_value_words', 'automation_threshold_words']) {
    const body = fnBody(name);
    if (!body) problems381.push(`${FILE} does not declare ${name}()`);
    else {
      if (!body.includes('public.with_unit(')) problems381.push(`${name}() does not word a measured metric through with_unit()`);
      if (!body.includes("'time_in_state'")) problems381.push(`${name}() has lost its time in state arm`);
    }
    if (!new RegExp(`^-- Redefines public\\.${name}: `, 'm').test(sql)) problems381.push(`${FILE} has no "-- Redefines public.${name}" marker`);
  }
  if (!fnBody('automation_value_words').includes("' over the last hour'")) problems381.push('automation_value_words() has lost its derived arm');
  const redeclared = [...sql.matchAll(/^CREATE OR REPLACE FUNCTION public\.(\w+)\(/gm)].map((m) => m[1]).sort();
  const expected = ['automation_threshold_words', 'automation_value_words', 'unit_symbol', 'with_unit'];
  if (redeclared.join() !== expected.join()) {
    problems381.push(`${FILE} declares ${redeclared.join(', ')}, not ${expected.join(', ')}: another function would change what an alert's labels or values hold`);
  }

  const docs = read('docs/automations.md');
  const example = docs.match(/`Lathe 3: Spindle\/BEARING_TEMPERATURE is ([0-9.]+) (\S+), above ([0-9.]+) (\S+) for 5m`/);
  if (!example) {
    problems381.push('docs/automations.md has no summary example that gives the temperature its unit');
  } else {
    if (example[2] !== example[4]) problems381.push(`docs/automations.md's example says ${example[2]} for the value and ${example[4]} for the threshold`);
    if (!sql.includes(`WHEN 'CELSIUS'`) || !new RegExp(`WHEN 'CELSIUS'\\s+THEN '${example[2]}'`).test(sql)) {
      problems381.push(`docs/automations.md's example says ${example[2]}, which unit_symbol() does not give CELSIUS`);
    }
  }

  const guide = upgradingGuide();
  const heading = "From 1.9.0, an automation's alert says the unit of its reading";
  const start = guide.indexOf(`\n### ${heading}\n`);
  if (start < 0) {
    problems381.push(`the upgrade guide has no "${heading}" section`);
  } else {
    const end = [guide.indexOf('\n## ', start), guide.indexOf('\n### ', start + 5)].filter((n) => n > 0).sort((a, b) => a - b)[0];
    const section = guide.slice(start, end);
    for (const word of ['`summary`', '`labels`', '`values.value`', '`values.threshold`']) {
      if (!section.includes(word)) problems381.push(`"${heading}" does not name ${word}`);
    }
  }

  const title = sql.match(/Reasoning: supabase\/README\.md, "([^"]+)"/)?.[1];
  const readme = supabaseReadme();
  const from = title ? readme.indexOf(`\n### ${title}\n`) : -1;
  if (from < 0) {
    problems381.push(`${FILE} cites ${title ? `"${title}"` : 'no section'} in supabase/README.md, which has no such heading`);
  } else {
    const section = readme.slice(from, readme.indexOf('\n### ', from + 5));
    for (const word of ['unit_symbol(', 'with_unit(', 'mirror check 104', 'automation_value_words()']) {
      if (!section.toLowerCase().includes(word.toLowerCase())) problems381.push(`supabase/README.md's "${title}" does not name ${word}`);
    }
  }
  if (problems381.length) {
    fail("0292's wording of an alert's unit is described otherwise than the file holds it:\n" +
      problems381.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`0292 words a measured metric's value and threshold through with_unit(), redeclares only the two words functions beside the two lookups, and the docs, the guide and the README say so`);
  }
}
