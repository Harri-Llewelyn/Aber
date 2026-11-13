import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 98. The playback worker waits for the primary host the ingestion daemon announces. Every replayed
// NBIRTH waits for spBv1.0/STATE/<PRIMARY_HOST_ID>, and a worker given no id does not wait, so a
// playback pod without the variable would replay into a stopped historian again and report success,
// with nothing failing. Both pods take it from the one helper.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const T = 'deploy/helm/aber/templates/apps/';
  const PASSED = /- name: PRIMARY_HOST_ID\n\s+value: \{\{ include "aber\.primaryHostId" \. \| quote \}\}/;
  const missing = ['playback.yaml', 'ingestion.yaml'].filter((f) => !PASSED.test(read(T + f)));
  const workerReads = /^PRIMARY_HOST_ID = os\.getenv\("PRIMARY_HOST_ID"/m.test(read('ingestion/playback_worker.py'));
  for (const f of missing) {
    fail(`${T}${f} does not pass PRIMARY_HOST_ID from aber.primaryHostId, so that pod does not know the primary host the other waits for or announces`);
  }
  if (!workerReads) {
    fail('ingestion/playback_worker.py does not read PRIMARY_HOST_ID from its environment, so no replayed NBIRTH waits for the primary host');
  }
  if (!missing.length && workerReads) {
    pass('the playback worker and the ingestion daemon take the same primary host id from aber.primaryHostId');
  }
}
