import { allFiles, fail, pass, read, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 354. supabase/README.md's table of the number settings says what 0285 does: a row for every number
// setting the chain seeds, "whole" for each key 0285 flags and "part" for the others, and the counts
// in its sentence. A table that calls a setting part which the file flags whole sends a reader to
// a reader that no longer decides it.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const SQL = 'supabase/migrations/0285_a_number_setting_says_whether_it_counts_whole_things.sql';
  const chain = allFiles.filter((f) => /^supabase\/migrations\/\d{4}_[^/]*\.sql$/.test(f)).sort().map(read).join('\n');
  const flagged = [...(read(SQL).match(/v_whole text\[\] := ARRAY\[([^\]]*)\]/)?.[1] || '').matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
  const seeded = [...new Set([...chain.matchAll(/seed_setting\(\s*'([a-z_.]+)',\s*to_jsonb\([^)]*\),\s*'number'/g)].map((m) => m[1]))].sort();
  const readme = supabaseReadme();
  const from = readme.indexOf('\n### A number setting says whether it counts whole things (0285)\n');
  const section = from < 0 ? '' : readme.slice(from, readme.indexOf('\n### ', from + 5));
  const rows = new Map([...section.matchAll(/^\s*\| `([a-z_.]+)` \| (whole|part) \|/gm)].map((m) => [m[1], m[2]]));
  const problems354 = [];
  if (!section) problems354.push('supabase/README.md has no "A number setting says whether it counts whole things (0285)" section');
  if (flagged.length === 0) problems354.push(SQL + ': could not read the settings it flags whole_number');
  for (const key of seeded) {
    const want = flagged.includes(key) ? 'whole' : 'part';
    if (section && rows.get(key) !== want) problems354.push('the 0285 table says ' + key + ' is ' + (rows.get(key) ?? 'missing') + ', and 0285 makes it ' + want);
  }
  for (const key of rows.keys()) if (!seeded.includes(key)) problems354.push('the 0285 table lists ' + key + ', which no migration seeds as a number');
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  const parts = seeded.length - flagged.length;
  const lead = (words[flagged.length] ?? String(flagged.length)).replace(/^./, (c) => c.toUpperCase());
  const says = '**' + lead + ' settings are whole, and ' + (words[parts] ?? parts) + (parts === 1 ? ' is not' : ' are not') + '.**';
  if (section && !section.replace(/\s+/g, ' ').includes(says)) problems354.push('the 0285 section does not say ' + says);
  if (problems354.length) {
    fail("supabase/README.md's table of whole-number settings says otherwise than 0285 does:\n" +
      problems354.map((p) => '        ' + p).join('\n'));
  } else {
    pass('supabase/README.md lists each of the ' + seeded.length + ' number settings as 0285 leaves it: ' + flagged.length + ' whole, ' + parts + ' part');
  }
}
