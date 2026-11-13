import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 376. The Captures and Playbacks search is stated as CaptureHistory.jsx holds it. The search reads
// on through the older jobs, SEARCH_ROWS at most, and the help page's section on those tabs says that
// number; it names each thing the search matches, as jobSearchText() lists them, and says the search
// lives in the address and that `/` reaches it.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const history = read('frontend/src/components/tabs/CaptureHistory.jsx');
  const limit = Number(history.match(/^export const SEARCH_ROWS = (\d+)$/m)?.[1]);
  const section = read('help/pages/capture.md').match(/^## The Captures and Playbacks tabs\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] ?? '';
  const problems376 = [];
  if (!limit) problems376.push('CaptureHistory.jsx declares no SEARCH_ROWS');
  if (!section) problems376.push('help/pages/capture.md has no "## The Captures and Playbacks tabs" section');
  const flat = section.replace(/\s+/g, ' ');
  if (limit && !flat.includes(`up to the newest ${limit.toLocaleString('en-GB')}`)) {
    problems376.push(`help/pages/capture.md's Captures and Playbacks section does not say "up to the newest ${limit.toLocaleString('en-GB')}"`);
  }
  for (const piece of ['the note or the file name', "the subject's name and Sparkplug ID", 'who started the job', 'why it failed', "the job's ID", 'The address keeps the search', 'Press **/**']) {
    if (section && !flat.includes(piece)) problems376.push(`help/pages/capture.md's Captures and Playbacks section does not say "${piece}"`);
  }
  // What jobSearchText() reads, field by field: the help's list is that list.
  const text = history.match(/export function jobSearchText[\s\S]*?\n}\n/)?.[0] ?? '';
  for (const field of ['note', 'storage_path', 'subject_sparkplug_id', 'requested_by', 'status', 'error', 'job.id']) {
    if (text && !text.includes(field)) problems376.push(`jobSearchText() no longer reads ${field}, which the help says the search matches`);
  }
  if (!text) problems376.push('CaptureHistory.jsx declares no jobSearchText()');
  if (problems376.length) {
    for (const p of problems376) fail(`capture job search: ${p}`);
  } else {
    pass(`the Captures and Playbacks search reads on through the newest ${limit.toLocaleString('en-GB')} jobs and matches the fields its help names`);
  }
}
