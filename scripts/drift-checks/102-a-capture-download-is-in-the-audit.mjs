import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { allFiles, fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 102. A capture download is in the Audit Trail, and a gateway's replay history never aborts the
// nightly purge (0193). The page signs a broker-captures link only in api.js's captureUrl(), and only for
// the path issue_capture_download() answered, which writes CAPTURE_DOWNLOAD_ISSUED: a second signer
// would hand out links the trail never sees. trg_gateways_keep_playback_history refuses deleting a
// gateway playback_jobs name, and purge_expired_archives is one transaction, so the purge's latest
// statement skips such a gateway or one refusal would keep every expired archive.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const api = read('frontend/src/api.js');
  const signers = allFiles
    .filter((f) => /^frontend\/src\/.*\.(js|jsx)$/.test(f) && !f.includes('__tests__'))
    .flatMap((f) => [...read(f).matchAll(/from\(CAPTURE_BUCKET\)\s*\.createSignedUrl\(/g)].map(() => f));
  const fnAt = api.indexOf('captureUrl: async');
  const body = fnAt < 0 ? '' : api.slice(fnAt, api.indexOf('\n  },', fnAt));
  const issued = body.indexOf("rpc('issue_capture_download'");
  const signed = body.indexOf('.createSignedUrl(path,');

  const dir = 'supabase/migrations';
  const files = readdirSync(join(REPO, dir)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const lastPurge = files.filter((f) => /ensure_cron_job\(\s*'purge_expired_archives'/.test(read(`${dir}/${f}`))).pop();
  const purge = lastPurge ? read(`${dir}/${lastPurge}`) : '';
  const purgeAt = purge.search(/ensure_cron_job\(\s*'purge_expired_archives'/);
  const command = purgeAt < 0 ? '' : purge.slice(purgeAt, purge.indexOf('$job$', purge.indexOf('$job$', purgeAt) + 5));
  const guarded = files.some((f) => read(`${dir}/${f}`).includes("replay_trigger('public.gateways', 'trg_gateways_keep_playback_history'"));

  if (signers.length !== 1 || signers[0] !== 'frontend/src/api.js' || issued < 0 || signed < issued) {
    fail(`a broker-captures link is signed outside captureUrl() or before issue_capture_download() records it (signers: ${signers.join(', ') || 'none'}); every download must be in the Audit Trail (0193)`);
  } else if (guarded && !/DELETE FROM public\.gateways[\s\S]*?playback_jobs[\s\S]*?;/.test(command)) {
    fail(`purge_expired_archives, as ${lastPurge || 'no migration'} last states it, deletes a gateway a playback names; trg_gateways_keep_playback_history refuses that and the whole purge aborts (0193)`);
  } else {
    pass(`capture download links are signed only after issue_capture_download() records them; purge_expired_archives (${lastPurge}) skips a gateway with replay history`);
  }
}
