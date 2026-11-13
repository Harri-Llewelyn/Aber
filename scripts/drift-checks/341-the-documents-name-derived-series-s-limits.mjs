import { fail, pass, read, readDoc } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 341. The documents name derived_series()'s limits as it declares them: the rows (the dashboard's row
// cap), the minutes of input and the widest bucket. A reader choosing a window reads the number, and a
// number that is not the function's is a read refused or a window left unasked.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const def = read('supabase/migrations/0282_history_draws_a_derived_metric_from_the_minutes.sql');
  const rows = def.match(/c_max_rows\s+CONSTANT bigint := (\d+);/)?.[1];
  const minutes = def.match(/c_max_minutes CONSTANT bigint := (\d+);/)?.[1];
  const bucket = def.match(/c_max_bucket\s+CONSTANT integer := (\d+);/)?.[1];
  const problems341 = [];
  if (!rows || !minutes || !bucket) problems341.push('could not read the limits of derived_series() out of 0282');
  if (!problems341.length) {
    const grouped = (n) => Number(n).toLocaleString('en-US');
    const days = Number(bucket) / 1440;
    const says = [
      ['supabase/README.md', [`${grouped(rows)} devices times metrics times buckets`, `${grouped(minutes)} minutes of input`, `${days} days`]],
      ['docs/openapi.yaml', [grouped(rows), grouped(minutes), `${days} days`]],
    ];
    for (const [file, phrases] of says) {
      const text = readDoc(file).replace(/\s+/g, ' ');
      for (const phrase of phrases) if (!text.includes(phrase)) problems341.push(`${file} does not say ${phrase}, which derived_series() declares`);
    }
  }
  if (problems341.length) {
    fail("The documents name derived_series()'s limits otherwise than 0282 declares them:\n" +
      problems341.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the README and the API reference name derived_series()'s limits as 0282 declares them: ${Number(rows).toLocaleString('en-US')} rows, ${Number(minutes).toLocaleString('en-US')} minutes of input, a bucket of ${Number(bucket) / 1440} days`);
  }
}
