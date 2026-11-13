import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 214. The Site Map's help names each state its legend draws, and neither alert state names what
// raised the alert. STATUS_WORD in SiteMapTab.jsx is the legend's words; the help's "What the states
// mean" gives each a bullet in bold and says how many the legend names. More than one thing writes
// platform_alerts, so STATUS_LABEL's two alert entries, the help's two bullets and the counter's
// footer name no evaluator.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const TAB = 'frontend/src/components/tabs/SiteMapTab.jsx';
  const PILL = 'frontend/src/components/common/AlertPill.jsx';
  const HELP = 'help/pages/site-map.md';
  const NUMBER = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
  const tab = read(TAB);
  const help = read(HELP);
  const problems214 = [];
  // One literal pattern per object: a RegExp built from a name is a Semgrep finding (detect-non-literal-regexp).
  const pairs = (body) => Object.fromEntries([...(body ?? '').matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[1], m[2]]));
  const words = pairs(tab.match(/const STATUS_WORD = \{([\s\S]*?)\n\s*\}/)?.[1]);
  const labels = pairs(tab.match(/const STATUS_LABEL = \{([\s\S]*?)\n\s*\}/)?.[1]);
  if (!words.alert || !words.acknowledged) problems214.push(`${TAB}: STATUS_WORD has no alert or acknowledged entry`);
  const states = help.slice(help.indexOf('## What the states mean'), help.indexOf('\n## ', help.indexOf('## What the states mean') + 1));
  for (const word of Object.values(words)) {
    if (!states.includes(`- **${word}**`)) problems214.push(`${HELP}: "What the states mean" has no bullet for **${word}**`);
  }
  const count = Object.keys(words).length;
  if (!help.includes(`names the ${NUMBER[count] ?? count} states below`)) {
    problems214.push(`${HELP}: the legend's bullet does not say it names the ${NUMBER[count] ?? count} states`);
  }
  const named = (text) => /Grafana|evaluat/i.test(text);
  for (const key of ['alert', 'acknowledged']) {
    if (named(labels[key] ?? '')) problems214.push(`${TAB}: STATUS_LABEL.${key} names what raised the alert`);
    const bullet = states.split('\n').find((l) => l.startsWith(`- **${words[key]}**`)) ?? '';
    if (named(bullet)) problems214.push(`${HELP}: the **${words[key]}** bullet names what raised the alert`);
  }
  const pill = read(PILL);
  const foot = pill.slice(pill.indexOf('<div className="alert-pill-foot">'), pill.indexOf('className="alert-pill-history"'));
  if (!foot || /Evaluated by|silences/i.test(foot.replace(/\{\/\*[\s\S]*?\*\/\}/g, ''))) {
    problems214.push(`${PILL}: the counter's footer names an evaluator or says where silences live`);
  }
  if (problems214.length) {
    fail('the Site Map help and the alert states disagree:\n' + problems214.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the Site Map help names the ${count} states its legend draws, and no alert state or the counter's footer names an evaluator`);
  }
}
