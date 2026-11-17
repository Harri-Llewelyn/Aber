import { fail, pass, read, upgradingGuide } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 451. What the docs say a metric's further semantic ids are limited to is what 0299 holds: the most a
// metric carries, in the Metrics help, the API reference and the upgrade note, and the longest id and
// source in the API reference. A reader told "up to 8" who is refused at 10, or told 2,000 characters
// who is refused at 1,000, trusts the page over the dialog's own message.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const FILE = 'supabase/migrations/0299_a_metric_can_carry_more_than_one_semantic_id.sql';
  const sql = read(FILE);
  const problems451 = [];
  const max = sql.match(/c_max CONSTANT integer := (\d+);/)?.[1];
  const idMax = sql.match(/char_length\(semantic_id\) <= (\d+)/)?.[1];
  const sourceMax = sql.match(/char_length\(source\) <= (\d+)/)?.[1];
  if (!max || !idMax || !sourceMax) {
    problems451.push(`${FILE}: could not read the limits -- its shape changed, so this check is no longer checking anything`);
  } else {
    const say = (n) => Number(n).toLocaleString('en-US');
    const stated = [
      ['help/pages/metrics.md', read('help/pages/metrics.md'), /carries\s+up\s+to\s+(\d+)\s+further\s+ids/, max],
      ['docs/openapi.yaml', read('docs/openapi.yaml'), /A\s+metric\s+carries\s+at\s+most\s+\*\*(\d+)\*\*,\s+none\s+equal\s+to\s+its\s+own\s+id/, max],
      ['docs/openapi.yaml', read('docs/openapi.yaml'), /longer\s+than\s+([\d,]+)\s+and\s+([\d,]+)\s+characters/, `${say(idMax)},${say(sourceMax)}`],
      ['the upgrade guide', upgradingGuide(), /A\s+metric\s+carries\s+at\s+most\s+(\d+),\s+none\s+equal\s+to\s+its\s+own\s+id/, max],
    ];
    for (const [where, text, pattern, expected] of stated) {
      const found = text.match(pattern);
      if (!found) problems451.push(`${where} no longer states a limit as ${pattern}, so it is not checked against ${FILE}`);
      else if (found.slice(1).join(',') !== expected) problems451.push(`${where} says ${found.slice(1).join(' and ')}, ${FILE} holds ${expected.replace(',', ' and ')}`);
    }
  }
  if (problems451.length) {
    fail(`the docs state a limit on further semantic ids that 0299 does not hold:\n${problems451.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`the Metrics help, the API reference and the upgrade guide state the ${max} further ids a metric carries, and the reference the ${idMax} and ${sourceMax} characters of an id and a source, as 0299 holds them`);
  }
}
