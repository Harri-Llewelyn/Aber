import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 101. The capture caps are stated where they are enforced and where they are read. The schema's
// CHECK `capture_jobs_caps_are_bounded` bounds a job; the recorder's defaults are those bounds; the
// Start Capture dialog, the help page and ingestion/README.md's cap table state them; no duration
// offered exceeds the CHECK; the bucket admits a file larger than the size cap; and the playback
// pod's /tmp, where a capture is replayed from, is sized from the bucket's limit.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems101 = [];
  const dir = 'supabase/migrations';
  const checkSql = readdirSync(join(REPO, dir)).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()
    .map((n) => read(`${dir}/${n}`).match(/capture_jobs_caps_are_bounded CHECK \((.*)\)\)?;?$/m))
    .filter(Boolean).pop();
  const upper = Object.fromEntries([...((checkSql && checkSql[1]) || '')
    .matchAll(/(\w+) BETWEEN \d+ AND (\d+)/g)].map((m) => [m[1], Number(m[2])]));
  const seconds = upper.max_seconds;
  const messages = upper.max_messages;
  const bytes = upper.max_bytes;
  if (!seconds || !messages || !bytes) problems101.push('the capture_jobs_caps_are_bounded CHECK was not found');
  const mib = bytes / 1048576;
  const count = messages.toLocaleString('en-GB');

  const defaults = Object.fromEntries([...read('ingestion/capture_worker.py')
    .matchAll(/job\.get\("(max_\w+)"\) or (\d+)/g)].map((m) => [m[1], Number(m[2])]));
  for (const [column, value] of [['max_seconds', seconds], ['max_messages', messages], ['max_bytes', bytes]]) {
    if (defaults[column] !== value) problems101.push(`capture_worker.py defaults ${column} to ${defaults[column]}, the CHECK to ${value}`);
  }
  const modal = read('frontend/src/components/modals/StartCaptureModal.jsx');
  const help = read('help/pages/capture.md');
  const readme = read('ingestion/README.md');
  for (const [file, text, pieces] of [
    ['StartCaptureModal.jsx', modal.replace(/&nbsp;/g, ' '), [`${count} messages`, `${mib} MiB`]],
    ['help/pages/capture.md', help, [`${count} messages`, `${mib} MiB`]],
    ['ingestion/README.md', readme, [`| duration | ${seconds / 3600} hours |`, `| messages | ${count} |`, `| size | ${mib} MiB |`]],
  ]) {
    for (const piece of pieces) if (!text.includes(piece)) problems101.push(`${file} does not say "${piece}"`);
  }
  const offered = [...modal.matchAll(/\{ seconds: (\d+), label:/g)].map((m) => Number(m[1]));
  if (!offered.length || Math.max(...offered) > seconds) problems101.push(`StartCaptureModal.jsx offers ${Math.max(...offered)} s, over the CHECK's ${seconds}`);
  const limit = Number((read('deploy/helm/aber/values.yaml').match(/^ {2}captureFileSizeLimit: (\d+)/m) || [])[1]);
  if (!(limit > bytes)) problems101.push(`supabaseStorage.captureFileSizeLimit (${limit}) does not exceed the size cap (${bytes})`);
  if (!/sizeLimit: \{\{ add \(\.Values\.supabaseStorage\.captureFileSizeLimit \| int64\)/.test(read('deploy/helm/aber/templates/apps/playback.yaml'))) {
    problems101.push("the playback pod's /tmp is not sized from supabaseStorage.captureFileSizeLimit");
  }
  if (problems101.length) {
    for (const p of problems101) fail(`capture caps: ${p}`);
  } else {
    pass(`the capture caps (${seconds / 3600} hours, ${count} messages, ${mib} MiB) agree in the CHECK, the recorder, the dialog, the help and the README; the bucket and the playback pod's /tmp hold a larger file`);
  }
}
