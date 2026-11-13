import { fail, pass, read, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 267. The longest suppression window is named as 0002 declares it: its label, its tab, its default
// and its range, in devices.md's Suppression windows section and the Settings page's help, and its
// default and range in supabase/README.md's 0240 section.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const SEED = 'supabase/migrations/0002_seed_data.sql';
  const seed = read(SEED);
  const declared = seed.match(/seed_setting\(\s*'alerts\.suppression_max_days',\s*to_jsonb\((\d+)\),\s*'number',\s*'([^']+)',\s*'([^']+)'/);
  const bounds = seed.match(/SET min_value = (\d+), max_value = (\d+)\s+WHERE key = 'alerts\.suppression_max_days'/);
  const problems267 = [];
  if (!declared || !bounds) {
    problems267.push(`${SEED}: could not read alerts.suppression_max_days' seed_setting() call or its bounds`);
  } else {
    const [, days, category, label] = declared;
    const [, min, max] = bounds;
    const devices = read('help/pages/devices.md');
    const section = devices.slice(devices.indexOf('## Suppression windows'));
    for (const needle of [`at most ${days} days after the start`, `**A window lasts at most ${days} days**`, `**${category}** tab`,
      `**${label}**, from ${min} to ${max}`]) {
      if (!section.includes(needle)) problems267.push(`help/pages/devices.md: the Suppression windows section does not say "${needle}"`);
    }
    const settings = read('help/pages/settings.md');
    for (const needle of [`**${category}** holds`, `**${label}**`, `${days} unless you change it, from ${min} to ${max}`]) {
      if (!settings.includes(needle)) problems267.push(`help/pages/settings.md does not say "${needle}"`);
    }
    const readme = supabaseReadme();
    const zone = readme.slice(readme.indexOf('### An alert stays quiet during planned work (0240)'), readme.indexOf('### The Audit Trail files a suppression window'));
    if (!zone.includes(`in the ${category} category: ${days} days, from ${min} to ${max}`)) {
      problems267.push(`supabase/README.md's 0240 section does not say "in the ${category} category: ${days} days, from ${min} to ${max}"`);
    }
  }
  if (problems267.length) {
    fail('the help and the README name the longest suppression window otherwise than 0002 declares it:\n' +
      problems267.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the help and supabase/README.md name ${declared[3]} as 0002 declares it: ${declared[1]} days, ${bounds[1]} to ${bounds[2]}, on ${declared[2]}`);
  }
}
