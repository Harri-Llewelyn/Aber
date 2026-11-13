import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { allFiles, fail, gitignored, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 97. A stored capture's file leaves the bucket through the Storage API, and the capture page agrees
// with the database and the recorder about what it shows. A DELETE of storage.objects in SQL removes
// the row and leaves the bytes in the storage backend, unlisted and in every backup, so no SQL this
// repository runs deletes from it: the ingestion daemon deletes what nothing claims through the
// API (0190). The Stop that ends a stale recording outright and the page's warning share a
// threshold, and the page's Captured Metrics leave out the plumbing and identity metrics the
// recorder leaves out.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const sqlFiles = allFiles.filter((p) => /\.(sql)$/.test(p) && !gitignored(p) && !p.startsWith('deploy/helm/aber/files/'));
  const deleting = sqlFiles.filter((p) => /DELETE\s+FROM\s+storage\.objects/i.test(read(p)));
  const dir = 'supabase/migrations';
  const lastStop = readdirSync(join(REPO, dir)).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()
    .filter((n) => /CREATE OR REPLACE FUNCTION public\.request_capture_stop\(/.test(read(`${dir}/${n}`))).pop();
  const sqlStale = Number((read(`${dir}/${lastStop}`).match(/c_stale_seconds CONSTANT integer := (\d+)/) || [])[1]);
  const pageStale = Number((read('frontend/src/components/tabs/CaptureTab.jsx').match(/STALE_RECORDING_SECONDS = (\d+)/) || [])[1]);
  const listOf = (text, pattern) => ((text.match(pattern) || [])[1] || '').match(/[A-Za-z_]+/g) || [];
  const workerText = read('ingestion/capture_worker.py');
  const apiText = read('frontend/src/api.js');
  const workerIdentity = listOf(workerText, /_IDENTITY_METRICS = \(([^)]*)\)/).sort().join();
  const pageIdentity = listOf(apiText, /\[('Asset_ID'[^\]]*)\]\.includes\(name\)/).sort().join();
  const prefixes = ['bdSeq', 'Node Control/', 'Device Control/'];
  const plumbing = prefixes.every((p) => workerText.includes(`"${p}"`) && apiText.includes(`'${p}'`));
  if (deleting.length) {
    fail(`${deleting.join(', ')} delete(s) from storage.objects in SQL, which leaves the file's bytes in the storage backend: delete through the Storage API (0190)`);
  } else if (!sqlStale || sqlStale !== pageStale) {
    fail(`request_capture_stop() (${lastStop}) ends a recording silent for ${sqlStale}s, and CaptureTab.jsx warns after ${pageStale}s: the page would offer the wrong Stop`);
  } else if (!workerIdentity || workerIdentity !== pageIdentity || !plumbing) {
    fail(`capture_worker.py and api.js leave out different metrics from Captured Metrics (identity: ${workerIdentity} vs ${pageIdentity}; plumbing named in both: ${plumbing})`);
  } else {
    pass(`no SQL deletes from storage.objects (${sqlFiles.length} files); the stale-recording Stop is ${sqlStale}s in ${lastStop} and on the page; Captured Metrics leave out the same metrics in the recorder and the page`);
  }
}
