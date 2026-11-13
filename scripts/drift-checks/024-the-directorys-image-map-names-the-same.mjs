import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 24. The Directory's image map names the same components in the migration and the chart.
//
// `record_directory_images()`'s `served_by` rows say which component serves each chart-managed
// Directory row, and the chart's `aber.directoryImages` says which image each component runs. A
// component named on one side only leaves its row reading "not recorded", with nothing failing. Each must also be a
// component some template declares, or a rename in the chart has the same effect.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const MIGRATION = 'supabase/migrations/0001_baseline_schema.sql';
  const HELPERS = 'deploy/helm/aber/templates/_helpers.tpl';
  const baseline = read(MIGRATION);
  const fnAt = baseline.indexOf('FUNCTION public.record_directory_images(');
  const sql = fnAt === -1 ? '' : baseline.slice(fnAt, baseline.indexOf('$$;', fnAt));
  const tpl = read(HELPERS);

  const servedBy = new Set(
    [...sql.matchAll(/\('f1111111-[0-9a-f-]+'::uuid,\s*'([a-z0-9-]+)'\)/g)].map((m) => m[1])
  );
  const start = tpl.indexOf('define "aber.directoryImages"');
  const body = start === -1 ? '' : tpl.slice(start, tpl.indexOf('toJson $out', start));
  const mapped = new Set([...body.matchAll(/\(list "([a-z0-9-]+)" /g)].map((m) => m[1]));
  const declared = new Set(
    allFiles
      .filter((f) => f.startsWith('deploy/helm/aber/templates/') && f.endsWith('.yaml'))
      .flatMap((f) => [...read(f).matchAll(/\$component := "([a-z0-9-]+)"/g)].map((m) => m[1]))
  );

  if (!servedBy.size || !mapped.size) {
    fail(
      `check 24 read ${servedBy.size} component(s) from ${MIGRATION} and ${mapped.size} from ` +
        `${HELPERS}'s aber.directoryImages; the extraction no longer matches one of them`
    );
  } else {
    const offences = [
      ...[...servedBy].filter((c) => !mapped.has(c)).map((c) => `${c} serves a Directory row and has no image in aber.directoryImages`),
      ...[...mapped].filter((c) => !servedBy.has(c)).map((c) => `${c} has an image in aber.directoryImages and serves no Directory row`),
      ...[...mapped].filter((c) => !declared.has(c)).map((c) => `${c} is not a component any template declares`),
    ];
    if (offences.length) {
      fail(
        'the Directory image map disagrees with itself:\n' + offences.map((o) => `        ${o}`).join('\n')
      );
    } else {
      pass(`the Directory image map names the same ${mapped.size} chart component(s) in the baseline and the chart`);
    }
  }
}
