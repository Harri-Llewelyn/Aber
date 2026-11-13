import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 57. The connection strip says what its docs quote.
//
// The Site Map help names the strip under the top bar by its opening words, its button and its
// threshold, and frontend/README.md gives the threshold, the Realtime window, the reconcile poll it
// sits above and the tab title's prefix. The words live in ConnectionStrip.jsx, the threshold and
// the window in lib/connectionState.js, the poll in constants.js and the prefix in
// useDocumentTitle.js, and any of them can change without the prose noticing. The window must also
// stay above the poll, or a Realtime outage with REST up shows the strip between polls.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const STRIP = 'frontend/src/components/common/ConnectionStrip.jsx';
  const STATE = 'frontend/src/lib/connectionState.js';
  const TITLE = 'frontend/src/hooks/useDocumentTitle.js';
  const CONSTANTS = 'frontend/src/constants.js';
  const HELP = 'help/pages/site-map.md';
  const README = 'frontend/README.md';

  const threshold = /export const STALE_AFTER_MS = (\d+)\b/.exec(read(STATE));
  const realtimeWindow = /export const REALTIME_RECONCILE_WINDOW_MS = (\d+)\b/.exec(read(STATE));
  const reconcile = /const RECONCILE_INTERVAL_MS = (\d+)\b/.exec(read(CONSTANTS));
  const prefix = /export const NOT_UPDATING_PREFIX = '([^']+)'/.exec(read(TITLE));

  if (!threshold || !realtimeWindow || !reconcile || !prefix) {
    fail(
      `check-docs-drift: could not find STALE_AFTER_MS or REALTIME_RECONCILE_WINDOW_MS in ${STATE}, ` +
        `RECONCILE_INTERVAL_MS in ${CONSTANTS}, or NOT_UPDATING_PREFIX in ${TITLE}.`
    );
  } else {
    const seconds = Number(threshold[1]) / 1000;
    const windowSeconds = Number(realtimeWindow[1]) / 1000;
    const reconcileSeconds = Number(reconcile[1]) / 1000;
    // Substring matches: the prefix carries a middle dot, and an escaping slip would fail open.
    const claims = [
      { file: STRIP, needle: 'Not updating since', what: 'the strip\'s opening words' },
      { file: STRIP, needle: 'Sign In Again', what: 'the button a rejected session shows' },
      { file: HELP, needle: '**Not updating since**', what: 'the strip\'s opening words, quoted' },
      { file: HELP, needle: '**Sign In Again**', what: 'the button, quoted' },
      { file: HELP, needle: `about ${seconds} seconds`, what: `the threshold (STALE_AFTER_MS is ${threshold[1]})` },
      { file: README, needle: `\`STALE_AFTER_MS\` (${seconds} seconds)`, what: `the threshold (STALE_AFTER_MS is ${threshold[1]})` },
      { file: README, needle: `\`REALTIME_RECONCILE_WINDOW_MS\` (${windowSeconds} seconds)`, what: `the Realtime window (REALTIME_RECONCILE_WINDOW_MS is ${realtimeWindow[1]})` },
      { file: README, needle: `${reconcileSeconds}-second reconcile poll`, what: `the reconcile poll (RECONCILE_INTERVAL_MS is ${reconcile[1]})` },
      { file: README, needle: `"${prefix[1]}"`, what: 'the tab title\'s prefix (NOT_UPDATING_PREFIX)' },
    ];
    const stale = claims.filter(({ file, needle }) => !read(file).includes(needle));

    for (const { file, needle, what } of stale) {
      fail(
        `connection strip: ${file} no longer contains ${JSON.stringify(needle)}, ${what}.\n` +
          '      The strip, its timings and the title prefix are quoted in the Site Map help and\n' +
          '      frontend/README.md; change the code and the quotes together.'
      );
    }
    if (Number(realtimeWindow[1]) <= Number(reconcile[1])) {
      fail(
        `connection strip: REALTIME_RECONCILE_WINDOW_MS (${realtimeWindow[1]}) is not above RECONCILE_INTERVAL_MS ` +
          `(${reconcile[1]}).\n` +
          '      While Realtime is down and REST is up, the strip would show between reconcile polls\n' +
          '      that are still bringing data.'
      );
    }
    if (!stale.length && Number(realtimeWindow[1]) > Number(reconcile[1])) {
      pass(
        `the connection strip's words, its ${seconds}-second threshold, its ${windowSeconds}-second ` +
          `Realtime window (above the ${reconcileSeconds}-second reconcile poll) and the title prefix ` +
          'match the Site Map help and frontend/README.md'
      );
    }
  }
}
