import { fail, pass, read, readDoc } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 335. The count of readings dropped under a derived name is one series, named as the daemon exports
// it. metrics.py maps the flat counter ingestion.py raises to a series and gives it a help text; the
// ingestion README and the 0267 section name that series. A README naming another is a query that
// returns nothing, and a counter with no help is one a scraper cannot read the meaning of.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const metrics = read('ingestion/metrics.py');
  const flat = 'metrics_dropped_derived_name';
  const series = metrics.match(new RegExp(`"${flat}": \\("([a-z_]+)", \\{\\}\\)`))?.[1];
  const problems335 = [];
  if (!series) problems335.push(`could not read the series of ${flat} out of ingestion/metrics.py`);
  else {
    if (!metrics.includes(`"${series}":\n`)) problems335.push(`ingestion/metrics.py gives ${series} no help text`);
    if (!/count\("metrics_dropped_derived_name"/.test(read('ingestion/ingestion.py'))) problems335.push(`ingestion/ingestion.py never counts ${flat}`);
    for (const file of ['ingestion/README.md', 'supabase/README.md']) {
      if (!readDoc(file).includes(`\`${series}\``)) problems335.push(`${file} does not name \`${series}\``);
    }
  }
  if (problems335.length) {
    fail('the docs and the exporter name the derived-name drop\'s counter otherwise than metrics.py:\n' +
      problems335.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`${series} is mapped, helped, counted and named in the ingestion README and the 0267 section`);
  }
}
