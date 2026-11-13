import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 347. The help says the playback dialog names the Playback gateway, as StartPlaybackModal draws
// it. A site has one, so the dialog states it in a fixed "Plays back as" line and uses it; only a
// site with two (a replacement being swapped in) gets the "Choose the Playback gateway…" select. A
// help page that tells the reader to choose the gateway sends them looking for a control the dialog
// does not draw.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems347 = [];
  const modal = read('frontend/src/components/modals/StartPlaybackModal.jsx');
  const help = read('help/pages/capture.md');
  for (const [piece, what] of [
    ['targets?.length === 1', 'names the gateway when the site has one'],
    ['Plays back as', 'draws the fixed "Plays back as" line'],
    ['targets.length > 1', 'draws the select only when the site has more than one'],
    ['Choose the Playback gateway…', 'keeps the select\'s "Choose the Playback gateway…" option'],
  ]) {
    if (!modal.includes(piece)) problems347.push(`StartPlaybackModal.jsx no longer ${what} (${piece})`);
  }
  if (!help.includes('The playback dialog names the Playback gateway')) problems347.push('help/pages/capture.md does not say "The playback dialog names the Playback gateway"');
  const asks = help.match(/\b(?:asks for|choose|pick|select)s? (?:the|a) (?:Playback )?gateway/i);
  if (asks) problems347.push(`help/pages/capture.md says "${asks[0]}", and the dialog asks for no gateway`);
  if (problems347.length) {
    fail('The playback dialog and the help disagree on how the Playback gateway is named:\n' + problems347.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('the playback dialog names the one Playback gateway in a fixed line, offers a select only for two, and the help says it names the gateway');
  }
}
