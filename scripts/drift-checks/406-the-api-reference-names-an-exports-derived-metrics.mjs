import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 406. The API reference describes the `derived` list of an export as the function builds it: each entry
// has the keys export_telemetry() writes (the metric, its kind, its definition in words and its unit),
// and the reference says a derived metric comes at one minute where the resolution is raw, as the
// function's bucket does. A reader building on the reference looks for a key the document does not
// hold, or reads a derived metric's rows as raw readings.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const declaring = allFiles.filter((f) => /^supabase\/migrations\/\d{4}_[^/]*\.sql$/.test(f)
    && read(f).includes('CREATE OR REPLACE FUNCTION public.export_telemetry(')).sort();
  const file = declaring[declaring.length - 1];
  const sql = file ? read(file) : '';
  const spec = read('docs/openapi.yaml');
  const problems406 = [];
  // The keys of one entry, as the function writes them: a key is a quoted word not taken from the catalogue row.
  const built = sql.match(/v_derived_doc := \(SELECT coalesce\(jsonb_agg\(jsonb_build_object\(([\s\S]*?)\)\s+ORDER BY/)?.[1];
  const described = spec.match(/\n {8}derived:\n[\s\S]*?items:\n {12}type: object\n {12}properties:\n([\s\S]*?)\n\n/)?.[1];
  if (!built) problems406.push(`could not read the keys of a derived entry out of ${file ?? 'export_telemetry()'}`);
  if (!described) problems406.push('docs/openapi.yaml has no TelemetryExport.derived with its properties');
  if (built && described) {
    const keys = (text, re) => [...text.matchAll(re)].map((m) => m[1]).sort().join(', ');
    const returned = keys(built, /(?<!->> )'(\w+)',/g);
    const listed = keys(described, /^ {14}(\w+):/gm);
    if (returned !== listed) problems406.push(`docs/openapi.yaml's TelemetryExport.derived has ${listed}; ${file} writes ${returned}`);
  }
  if (sql && !/ELSE interval '1 minute' END;/.test(sql.match(/v_step := CASE v_res[\s\S]*?;/)?.[0] ?? '')) {
    problems406.push(`${file} does not read a derived metric at 1 minute where the resolution is raw (v_step)`);
  }
  if (!/a derived metric[\s\S]{0,400}one minute for `raw`/i.test(spec)) {
    problems406.push('docs/openapi.yaml does not say a derived metric comes at one minute for `raw`');
  }
  if (problems406.length) {
    fail("The API reference describes an export's derived metrics otherwise than export_telemetry() builds them:\n" +
      problems406.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the API reference lists the keys of an export's derived entries and says they come at one minute for raw, as ${file} writes them`);
  }
}
