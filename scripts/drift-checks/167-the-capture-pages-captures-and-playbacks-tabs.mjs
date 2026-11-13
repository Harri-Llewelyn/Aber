import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 167. The Capture page's Captures and Playbacks tabs load as many rows at a time as its help says:
// the first page of each table and each Show more are HISTORY_PAGE in CaptureHistory.jsx, and the
// help page's section on those tabs states that number twice.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const history = read('frontend/src/components/tabs/CaptureHistory.jsx');
  const size = Number(history.match(/^export const HISTORY_PAGE = (\d+)$/m)?.[1]);
  const section = read('help/pages/capture.md').match(/^## The Captures and Playbacks tabs\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] ?? '';
  const problems167 = [];
  if (!size) problems167.push('CaptureHistory.jsx declares no HISTORY_PAGE');
  if (!section) problems167.push('help/pages/capture.md has no "## The Captures and Playbacks tabs" section');
  for (const piece of [`the newest ${size}`, `the next ${size}`]) {
    if (size && section && !section.includes(piece)) problems167.push(`help/pages/capture.md's Captures and Playbacks section does not say "${piece}"`);
  }
  if (problems167.length) {
    for (const p of problems167) fail(`capture job lists: ${p}`);
  } else {
    pass(`the Capture page's Captures and Playbacks tabs load ${size} rows at a time, as its help says`);
  }
}
