import { compare, lastDefinition, MIGRATION_DIR, need, read } from './lib.mjs';

// 27. A device's place in the Unified Namespace. device_uns_paths gives each skipped device one
// reason; the bridge counts it under that label on aber_ingestion_uns_skipped_total, and the
// dashboard says it in words. A reason the view gives and the bridge does not label is counted as
// location_unknown, and one the dashboard has no sentence for reads as unexplained. The bridge's
// two run-time reasons are its own. And the bridge selects the view's columns by name.
export default function check() {
  const view = lastDefinition('CREATE OR REPLACE VIEW public.device_uns_paths', ';', 'public.device_uns_paths');
  const py = read('ingestion/uns_publish.py');
  const js = read('frontend/src/utils/unsPath.js');
  const pyReasons = need(py, /^SKIP_REASONS = \(([\s\S]*?)^\)/m, 'SKIP_REASONS in uns_publish.py');
  const jsSentences = need(js, /^const SKIP_SENTENCES = \{([\s\S]*?)^\}/m, 'SKIP_SENTENCES in unsPath.js');
  const pySelect = need(py, /\.table\(PATH_VIEW\)\s*\.select\("([^"]+)"\)/, "uns_publish.py's select on PATH_VIEW");
  const pyView = need(py, /^PATH_VIEW = "([a-z_]+)"/m, 'PATH_VIEW in uns_publish.py');
  if (view && pyReasons && jsSentences && pySelect && pyView) {
    const sqlReasons = [...new Set([...view.body.matchAll(/THEN '([a-z_]+)'::text/g)].map((m) => m[1]))].sort();
    const python = [...pyReasons[1].matchAll(/^\s*"([a-z_]+)",/gm)].map((m) => m[1]);
    const runtime = python.filter((r) => !sqlReasons.includes(r)).sort();
    const sentences = [...jsSentences[1].matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]).sort();
    compare('unsPath', `reasons the bridge labels beyond the view's (${view.file})`, 'location_unknown,publish_error', runtime.join(','));
    compare('unsPath', 'reasons the view gives that the bridge labels', sqlReasons.filter((r) => python.includes(r)).join(','), sqlReasons.join(','));
    compare('unsPath', "reasons the dashboard words, and the view's", sentences.join(','), sqlReasons.join(','));
    compare('unsPath', 'the view the bridge reads', pyView[1], 'device_uns_paths');
    const viewColumns = need(read(`${MIGRATION_DIR}/${view.file}`), /IS DISTINCT FROM '([a-z_,]+)'/,
      `the column list ${view.file}'s self-check asserts`);
    if (viewColumns) {
      const missing = pySelect[1].split(',').filter((col) => !viewColumns[1].split(',').includes(col));
      compare('unsPath', "columns the bridge selects that the view's self-check does not hold", '', missing.join(','));
    }
  }
}
