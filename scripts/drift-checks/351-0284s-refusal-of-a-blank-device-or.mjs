import { fail, pass, read, supabaseReadme, upgradingGuide } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 351. 0284's refusal of a blank device or gateway name is described as the file holds it. Each table
// gets one CHECK, `btrim(name) <> ''`. The error that stops an upgrade on a blank row names a heading
// of the upgrade guide (check 152 reads no .sql file), and that section's query finds the rows by the
// negation of the CHECK, over both tables, so a site that finds none is a site the migration passes.
// The README's section is the one the file's header cites.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const FILE = 'supabase/migrations/0284_a_device_or_gateway_name_cannot_be_blank.sql';
  const sql = read(FILE);
  const guide = upgradingGuide();
  const problems351 = [];
  for (const table of ['devices', 'gateways']) {
    const add = sql.match(new RegExp(`ADD CONSTRAINT ${table}_name_not_blank CHECK \\(\\(btrim\\(name\\) <> ''::text\\)\\);`, 'g')) || [];
    if (add.length !== 1) problems351.push(`${FILE} declares ${table}_name_not_blank ${add.length} times as btrim(name) <> '', not once`);
  }
  if (!sql.includes("<> 'CHECK ((btrim(name) <> ''''::text))'")) {
    problems351.push(`${FILE}'s guard does not compare each constraint with CHECK ((btrim(name) <> ''::text))`);
  }
  const heading = sql.match(/help\/site\/upgrading\.md, "([^"]+)"/)?.[1];
  const start = heading ? guide.indexOf(`\n### ${heading}\n`) : -1;
  if (!heading) {
    problems351.push(`${FILE} names no heading of help/site/upgrading.md in its error`);
  } else if (start < 0) {
    problems351.push(`${FILE} names "${heading}" in help/site/upgrading.md, which has no such heading`);
  } else {
    if (!heading.startsWith('From 1.9.0, ')) problems351.push(`the upgrade guide's section "${heading}" is not a "From 1.9.0, ..." section`);
    const end = guide.indexOf('\n## ', start);
    const nextSection = guide.indexOf('\n### ', start + 5);
    const section = guide.slice(start, [end, nextSection].filter((n) => n > 0).sort((a, b) => a - b)[0]);
    for (const table of ['devices', 'gateways']) {
      if (!section.includes(`FROM public.${table} WHERE btrim(name) = ''`)) {
        problems351.push(`"${heading}" does not find blank rows with FROM public.${table} WHERE btrim(name) = '', the negation of the CHECK`);
      }
    }
    if (!section.includes('migration `0284`')) problems351.push(`"${heading}" does not name migration \`0284\``);
    if (!/Sparkplug id/.test(sql) || !section.includes('sparkplug_id')) {
      problems351.push(`"${heading}" and the error do not both name the Sparkplug id of each blank row`);
    }
  }
  const title = sql.match(/Reasoning: supabase\/README\.md, "([^"]+)"/)?.[1];
  if (!title || !supabaseReadme().includes(`\n### ${title}\n`)) {
    problems351.push(`${FILE} cites ${title ? `"${title}"` : 'no section'} in supabase/README.md, which has no such heading`);
  }
  if (problems351.length) {
    fail('0284\'s blank-name refusal is described otherwise than the file holds it:\n' +
      problems351.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`0284 declares one btrim(name) <> '' CHECK on devices and on gateways, and "${heading}" finds the rows it stops on`);
  }
}
