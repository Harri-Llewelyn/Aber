import { allFiles, fail, pass, read, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 408. An export reads a derived metric in chunks that stay inside derived_series()'s limits: the
// export's two constants (c_series_rows and c_series_minutes) are the function's own (c_max_rows and
// c_max_minutes, 0282), and the migration's note says the numbers. A chunk over a limit is a refusal
// in the middle of an export that the first chunk's success did not warn of.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const series = read('supabase/migrations/0282_history_draws_a_derived_metric_from_the_minutes.sql');
  const declaring = allFiles.filter((f) => /^supabase\/migrations\/\d{4}_[^/]*\.sql$/.test(f)
    && read(f).includes('CREATE OR REPLACE FUNCTION public.export_telemetry(')).sort();
  const file = declaring[declaring.length - 1];
  const exported = file ? read(file) : '';
  const rows = series.match(/c_max_rows\s+CONSTANT bigint := (\d+);/)?.[1];
  const minutes = series.match(/c_max_minutes CONSTANT bigint := (\d+);/)?.[1];
  const exportRows = exported.match(/c_series_rows\s+CONSTANT integer := (\d+);/)?.[1];
  const exportMinutes = exported.match(/c_series_minutes\s+CONSTANT integer := (\d+);/)?.[1];
  const problems408 = [];
  if (!rows || !minutes) problems408.push('could not read the limits of derived_series() out of 0282');
  if (!exportRows || !exportMinutes) problems408.push(`could not read c_series_rows and c_series_minutes out of ${file ?? 'export_telemetry()'}`);
  if (!problems408.length) {
    if (rows !== exportRows) problems408.push(`${file} chunks a derived read at ${exportRows} rows; derived_series() takes ${rows}`);
    if (minutes !== exportMinutes) problems408.push(`${file} chunks a derived read at ${exportMinutes} minutes of input; derived_series() takes ${minutes}`);
    const grouped = (n) => Number(n).toLocaleString('en-US');
    const note = supabaseReadme().match(/\n### An export saves a derived metric's values \(0296\)\n([\s\S]*?)(?=\n### )/)?.[1]?.replace(/\s+/g, ' ');
    if (!note) problems408.push('supabase/README.md has no "An export saves a derived metric\'s values (0296)" section');
    else {
      for (const phrase of [`${grouped(rows)} rows`, `${grouped(minutes)} minutes of input`]) {
        if (!note.includes(phrase)) problems408.push(`the 0296 section does not say ${phrase}, which the export's chunks stay inside`);
      }
    }
  }
  if (problems408.length) {
    fail("An export's derived chunks are not derived_series()'s limits:\n" + problems408.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`an export chunks a derived read inside derived_series()'s limits (${Number(rows).toLocaleString('en-US')} rows, ${Number(minutes).toLocaleString('en-US')} minutes of input), and the 0296 section says so`);
  }
}
