import { allFiles, fail, pass, read, upgradingGuide } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 353. The settings that count whole things are named as 0285 flags them. The upgrade guide's
// section lists each of the nine by the label its seed gives, says how many there are, and names
// the one number setting that takes a fraction; the Settings help names the one that is a count of
// proposals and the one that is a fraction, and says days, hours and seconds. A page naming a
// setting 0285 leaves part tells a person a value will be refused that the database accepts.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const SQL = 'supabase/migrations/0285_a_number_setting_says_whether_it_counts_whole_things.sql';
  const chain = allFiles.filter((f) => /^supabase\/migrations\/\d{4}_[^/]*\.sql$/.test(f)).sort().map(read).join('\n');
  const flagged = [...(read(SQL).match(/v_whole text\[\] := ARRAY\[([^\]]*)\]/)?.[1] || '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const labels = new Map();
  for (const m of chain.matchAll(/seed_setting\(\s*'([a-z_.]+)',\s*to_jsonb\([^)]*\),\s*'number',\s*'[^']*',\s*'((?:[^']|'')*)'/g)) {
    labels.set(m[1], m[2].replace(/''/g, "'"));
  }
  const problems353 = [];
  if (flagged.length === 0) problems353.push(SQL + ': could not read the settings it flags whole_number');
  const parts = [...labels.keys()].filter((k) => !flagged.includes(k));
  for (const key of flagged) if (!labels.has(key)) problems353.push(SQL + ' flags ' + key + ', which no migration seeds as a number');
  if (parts.length === 0) problems353.push('every number setting is flagged whole in ' + SQL + ', so the guide has no fraction to name');
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  const guide = upgradingGuide();
  const at = guide.indexOf('\n### From 1.9.0, a setting that counts days, hours or seconds takes whole numbers\n');
  const section = at < 0 ? '' : guide.slice(at, guide.indexOf('\n## ', at));
  if (!section) {
    problems353.push('help/site/upgrading.md has no "From 1.9.0, a setting that counts days, hours or seconds takes whole numbers" section');
  } else {
    const count = words[flagged.length] ?? String(flagged.length);
    const lead = count[0].toUpperCase() + count.slice(1) + ' number settings now take whole numbers only';
    if (!section.includes('\n' + lead)) problems353.push('the upgrade guide does not say "' + lead + '"');
    for (const key of flagged) {
      const label = labels.get(key);
      if (label && !section.includes('**' + label + '**')) problems353.push('the upgrade guide does not name **' + label + '**, which 0285 flags whole');
      if (!section.includes("'" + key + "'")) problems353.push("the upgrade guide's query does not name '" + key + "'");
    }
    for (const key of parts) {
      const label = labels.get(key);
      if (!section.includes('**' + label + '**')) problems353.push('the upgrade guide does not name **' + label + '**, which stays a fraction');
    }
  }
  const help = read('help/pages/settings.md');
  for (const needle of ['takes a whole number', 'every setting counted in days, hours or seconds']) {
    if (!help.includes(needle)) problems353.push('help/pages/settings.md does not say "' + needle + '"');
  }
  for (const key of ['proposals.max_open_per_person', ...parts]) {
    const label = labels.get(key);
    if (label && !help.includes('**' + label + '**')) problems353.push('help/pages/settings.md does not name **' + label + '**');
  }
  if (problems353.length) {
    fail('the upgrade guide and the Settings help name the whole-number settings otherwise than 0285 flags them:\n' +
      problems353.map((p) => '        ' + p).join('\n'));
  } else {
    pass('the upgrade guide names the ' + flagged.length + ' settings 0285 flags whole and the ' + parts.length + ' that stays a fraction, and the Settings help says what they take');
  }
}
