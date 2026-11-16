import { fail, pass, read, supabaseReadme, upgradingGuide } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 379. 0291's refusal of a blank area or cell name is described as the file holds it. Each table
// gets one CHECK, `btrim(name) <> ''`, beside 0001's topic CHECK, which the file leaves alone. The
// error that stops an upgrade on a blank row names a heading of the upgrade guide (check 152 reads no
// .sql file), and that section's query finds the rows by the negation of the CHECK, over both
// tables, so a site that finds none is a site the migration passes. The README's section is the one
// the file's header cites, and it names both constraints.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const FILE = 'supabase/migrations/0291_an_area_or_a_cell_cannot_have_a_blank_name.sql';
  const sql = read(FILE);
  const guide = upgradingGuide();
  const problems379 = [];
  for (const table of ['areas', 'cells']) {
    const add = sql.match(new RegExp(`ADD CONSTRAINT ${table}_name_not_blank CHECK \\(\\(btrim\\(name\\) <> ''::text\\)\\);`, 'g')) || [];
    if (add.length !== 1) problems379.push(`${FILE} declares ${table}_name_not_blank ${add.length} times as btrim(name) <> '', not once`);
    if (new RegExp(`ADD CONSTRAINT ${table}_name_topic_safe\\b`).test(sql)) {
      problems379.push(`${FILE} declares ${table}_name_topic_safe, which 0001 declares and puts back on every boot`);
    }
  }
  if (!sql.includes("<> 'CHECK ((btrim(name) <> ''''::text))'")) {
    problems379.push(`${FILE}'s guard does not compare each constraint with CHECK ((btrim(name) <> ''::text))`);
  }
  const heading = sql.match(/help\/site\/upgrading\.md, "([^"]+)"/)?.[1];
  const start = heading ? guide.indexOf(`\n### ${heading}\n`) : -1;
  let section = '';
  if (!heading) {
    problems379.push(`${FILE} names no heading of help/site/upgrading.md in its error`);
  } else if (start < 0) {
    problems379.push(`${FILE} names "${heading}" in help/site/upgrading.md, which has no such heading`);
  } else {
    if (!heading.startsWith('From 1.9.0, ')) problems379.push(`the upgrade guide's section "${heading}" is not a "From 1.9.0, ..." section`);
    const end = guide.indexOf('\n## ', start);
    const nextSection = guide.indexOf('\n### ', start + 5);
    section = guide.slice(start, [end, nextSection].filter((n) => n > 0).sort((a, b) => a - b)[0]);
    for (const table of ['areas', 'cells']) {
      if (!section.includes(`FROM public.${table} WHERE btrim(name) = ''`)) {
        problems379.push(`"${heading}" does not find blank rows with FROM public.${table} WHERE btrim(name) = '', the negation of the CHECK`);
      }
      if (!section.includes(`\`${table}_name_not_blank\``)) {
        problems379.push(`"${heading}" does not name ${table}_name_not_blank`);
      }
    }
    if (!section.includes('migration `0291`')) problems379.push(`"${heading}" does not name migration \`0291\``);
  }
  const title = sql.match(/Reasoning: supabase\/README\.md, "([^"]+)"/)?.[1];
  const readme = supabaseReadme();
  const from = title ? readme.indexOf(`\n### ${title}\n`) : -1;
  if (from < 0) {
    problems379.push(`${FILE} cites ${title ? `"${title}"` : 'no section'} in supabase/README.md, which has no such heading`);
  } else {
    const readmeSection = readme.slice(from, readme.indexOf('\n### ', from + 5));
    for (const name of ['areas_name_not_blank', 'cells_name_not_blank', 'areas_name_topic_safe', 'cells_name_topic_safe']) {
      if (!readmeSection.includes(`\`${name}\``)) problems379.push(`supabase/README.md's "${title}" does not name ${name}`);
    }
  }
  if (problems379.length) {
    fail('0291\'s blank-name refusal is described otherwise than the file holds it:\n' +
      problems379.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`0291 declares one btrim(name) <> '' CHECK on areas and on cells, leaves 0001's topic CHECKs alone, and "${heading}" finds the rows it stops on`);
  }
}
