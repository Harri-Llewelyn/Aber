import { fail, pass, read, readDoc } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 336. How soon a derived metric added on the Metrics page is dropped under. Ingestion reads the
// names through the UNS bridge's cache, so the answer is that cache's freshness: UNS_CONTEXT_TTL_SECONDS,
// which uns_publish.py defaults and the chart sets (ingestion.unsContextTtlSeconds). The ingestion
// README and the 0267 section say the figure, and the README's variable table too; a page naming
// another tells an operator how long readings under a new name are still stored, wrongly.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const inCode = read('ingestion/uns_publish.py').match(/^UNS_CONTEXT_TTL_SECONDS = int\(os\.getenv\("UNS_CONTEXT_TTL_SECONDS", "(\d+)"\)\)$/m)?.[1];
  const inChart = read('deploy/helm/aber/values.yaml').match(/^ {2}unsContextTtlSeconds: (\d+)$/m)?.[1];
  const problems336 = [];
  if (!inCode || !inChart) problems336.push('could not read the default out of ingestion/uns_publish.py and the chart\'s unsContextTtlSeconds');
  else {
    if (inCode !== inChart) problems336.push(`uns_publish.py defaults UNS_CONTEXT_TTL_SECONDS to ${inCode} and the chart to ${inChart}`);
    const claims = [
      ['ingestion/README.md', `**within \`UNS_CONTEXT_TTL_SECONDS\`**, ${inCode} seconds by default`],
      ['ingestion/README.md', `| \`UNS_CONTEXT_TTL_SECONDS\` | \`${inCode}\` |`],
      ['supabase/README.md', `within \`UNS_CONTEXT_TTL_SECONDS\`, ${inCode} seconds by default`],
    ];
    for (const [file, said] of claims) if (!readDoc(file).replace(/\s+/g, ' ').includes(said)) problems336.push(`${file} does not say "${said}"`);
  }
  if (problems336.length) {
    fail('the docs say how soon a new derived metric is dropped under otherwise than the cache\'s freshness:\n' +
      problems336.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the ingestion README and the 0267 section say a new derived metric is dropped under within ${inCode} seconds, as UNS_CONTEXT_TTL_SECONDS defaults`);
  }
}
