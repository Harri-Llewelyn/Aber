import { fail, pass, read, readDoc, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 330. The longest export is named as 0278 declares it: its label, its tab, its default and its
// range, in History's help, the Settings page's help, the upgrade guide and supabase/README.md's
// 0278 section. A page naming another default sends a reader looking for a limit that is not there,
// or trusting an export to cover a window the database refuses.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const SEED = 'supabase/migrations/0278_the_longest_export_is_a_setting.sql';
  const seed = read(SEED);
  const declared = seed.match(/seed_setting\(\s*'history\.export_max_days',\s*to_jsonb\((\d+)\),\s*'number',\s*'([^']+)',\s*'([^']+)'/);
  const bounds = seed.match(/SET min_value = (\d+), max_value = (\d+)\s+WHERE key = 'history\.export_max_days'/);
  const problems330 = [];
  if (!declared || !bounds) {
    problems330.push(`${SEED}: could not read history.export_max_days' seed_setting() call or its bounds`);
  } else {
    const [, days, category, label] = declared;
    const [, min, max] = bounds;
    const says = (file, needles) => {
      const text = readDoc(file);
      for (const needle of needles) if (!text.includes(needle)) problems330.push(`${file} does not say "${needle}"`);
    };
    says('help/pages/history.md', [`**A window of at most ${days} days.**`, `**over the ${days}-day export limit**`, `on the **${category}** tab`]);
    says('help/pages/settings.md', [`**${category}** holds **${label}**`, `${days} unless you change it, from ${min} to ${max}`]);
    says('help/site/upgrading.md', [`**${label}**`, `is ${days} unless you change it, from ${min} to ${max}`, `covers at most ${days} days`]);
    const readme = supabaseReadme();
    const zone = readme.slice(readme.indexOf('### The longest export is a setting (0278)'), readme.indexOf('### An export of readings is checked, bounded and recorded (0279)'));
    if (!zone.includes(`in the ${category} category: ${days} days, from ${min} to ${max}`)) {
      problems330.push(`supabase/README.md's 0278 section does not say "in the ${category} category: ${days} days, from ${min} to ${max}"`);
    }
  }
  if (problems330.length) {
    fail('the help and the README name the longest export otherwise than 0278 declares it:\n' +
      problems330.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the help and supabase/README.md name ${declared[3]} as 0278 declares it: ${declared[1]} days, ${bounds[1]} to ${bounds[2]}, on ${declared[2]}`);
  }
}
