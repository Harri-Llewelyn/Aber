import { allFiles, fail, pass, read, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 502. A page of readings is read through telemetry_page() or telemetry_rollup_page() (0315), as the
// historian's README, i3X's README, the AAS bundle and the API reference say. A read of the view sends
// the historian no LIMIT at the estimate a read naming a device gets, so every row in its bounds
// crosses: each reader's page must call the function, not read the relation. The bins the API
// reference names are the ones the last migration to declare telemetry_page_start() counts in, and no
// text states the 6,338-row threshold the page reads replaced.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems502 = [];
  const slice = (path, start, end) => {
    const text = read(path);
    const from = text.indexOf(start);
    if (from < 0) {
      problems502.push(`${path} has no ${start.trim()}, so this check cannot read the reader`);
      return '';
    }
    const to = text.indexOf(end, from + start.length);
    return text.slice(from, to < 0 ? undefined : to);
  };

  // Each reader's page, and the calls that read it.
  const readers = [
    ['frontend/src/api.js', 'async function queryTelemetry(', '\n}\n', ["supabase.rpc('telemetry_page'", "supabase.rpc('telemetry_rollup_page'"], /\.from\(/],
    ['i3x/i3x_service.py', 'def _read_rows(', '\ndef ', ['"rpc/telemetry_page"', '"rpc/telemetry_rollup_page"'], /pg\.get\(relation\b/],
    ['supabase/functions/_shared/aas/bundle.ts', 'export async function loadTelemetry(', '\n}\n', ['client.rpc("telemetry_page"', 'client.rpc("telemetry_rollup_page"'], /\.from\(/],
  ];
  for (const [path, start, end, calls, viewRead] of readers) {
    const body = slice(path, start, end);
    if (!body) continue;
    for (const call of calls) {
      if (!body.includes(call)) problems502.push(`${path}: ${start.trim()} does not read through ${call.match(/telemetry_\w+/)[0]}()`);
    }
    if (viewRead.test(body)) problems502.push(`${path}: ${start.trim()} reads a relation itself, so the historian sends its whole window`);
  }

  // The texts that say so.
  const told = [
    ['timescaledb/README.md', '`telemetry_page()`'],
    ['i3x/README.md', '`telemetry_page()`'],
    ['supabase/functions/_shared/aas/bundle.ts', 'telemetry_page()'],
    ['docs/openapi.yaml', '/rest/v1/rpc/telemetry_page:'],
    ['docs/openapi.yaml', '/rest/v1/rpc/telemetry_rollup_page:'],
  ];
  for (const [path, phrase] of told) {
    if (!read(path).includes(phrase)) problems502.push(`${path} no longer names ${phrase}`);
  }
  if (!supabaseReadme().includes('### A page of readings brings across only the rows it returns (0315)')) {
    problems502.push("supabase/README.md has no section \"A page of readings brings across only the rows it returns (0315)\", which the readers cite");
  }

  // The bins: an hour for raw and telemetry_1m, 5 hours for telemetry_5m, 60 hours for telemetry_1h.
  const needle = 'CREATE OR REPLACE FUNCTION public.telemetry_page_start(';
  const file = allFiles.filter((f) => /^supabase\/migrations\/\d{4}_[^/]*\.sql$/.test(f)).sort().findLast((f) => read(f).includes(needle));
  if (!file) {
    problems502.push('no migration declares telemetry_page_start(), so the bins cannot be read');
  } else {
    const sql = read(file);
    const body = sql.slice(sql.lastIndexOf(needle), sql.indexOf('$fn$;', sql.lastIndexOf(needle)));
    const bins = Object.fromEntries([...body.matchAll(/WHEN '(telemetry\w*)'\s+THEN v_col := '\w+';\s+v_bin := interval '([^']+)'/g)].map((m) => [m[1], m[2]]));
    const want = { telemetry: '1 hour', telemetry_1m: '1 hour', telemetry_5m: '5 hours', telemetry_1h: '60 hours' };
    for (const [relation, bin] of Object.entries(want)) {
      if (bins[relation] !== bin) problems502.push(`${file}: telemetry_page_start() counts ${relation} in bins of ${bins[relation] ?? 'nothing it names'}, and the API reference says ${bin}`);
    }
    const reference = slice('docs/openapi.yaml', '/rest/v1/rpc/telemetry_rollup_page:', '\n  /rest/v1/').replace(/\s+/g, ' ');
    if (!reference.includes('an hour, 5 hours or 60 hours')) {
      problems502.push('docs/openapi.yaml: /rest/v1/rpc/telemetry_rollup_page no longer names its bins as an hour, 5 hours or 60 hours');
    }
  }

  // The threshold the page reads replaced.
  const stated = allFiles.filter((f) => /\.(md|py|ts|js|jsx|mjs|ya?ml)$/.test(f) && !f.startsWith('scripts/drift-checks/'))
    .filter((f) => /\b6,?338\b|\babout 6,?300\b/.test(read(f)));
  for (const path of stated) problems502.push(`${path} states a 6,338-row LIMIT threshold; postgres_fdw sends a LIMIT only when its row estimate says it cuts`);

  if (problems502.length) {
    fail('a page of readings is not read the way the texts say:\n' + problems502.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the dashboard's route, i3X's history and the AAS bundle read a page through telemetry_page() and telemetry_rollup_page(), which ${file.match(/\/(\d{4})_/)[1]} counts in the bins the API reference names`);
  }
}
