import { allFiles, fail, isDriftCheck, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 19. Nothing outside the historical record describes a second deployment target.
//
// Docker Compose was the second target and was removed in September 2026. The prose describing it
// outlived it by a year in thirty-odd files, and the failure is not cosmetic: the strings reached
// operators. The Gateways page told them to run `npm run setup` against a `.env` that does not
// exist, and the bundle function's 503 named the same file.
//
// IN SCOPE IS THE CLAIM, NOT THE WORD. The gateway appliance genuinely runs Docker Compose, and
// `docker compose up` in the remote-gateway runbook is correct. What cannot be true is a SECOND
// target for the platform, so the phrases below are the ones that assert one.
//
// The three documents that carry the comparison as history are exempt, each opening with a note
// saying so. The drift checks are exempt, because this one has to name the phrases to look for them.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const HISTORY = [
    'docs/incidents.md',
    'docs/roadmap.md',
    'docs/kubernetes-architecture.md',
  ];
  // AN INTERVENING WORD IS THE HOLE THE FIRST PASS LEFT. "both deployment targets" and "one of
  // two targets" say exactly what "both targets" says and matched none of these until they were
  // written to allow it, so the optional group is load-bearing rather than tidy.
  const PHRASES = [
    /\bboth (?:deployment )?targets\b/i,
    /\bneither (?:deployment )?target\b/i,
    /\beither (?:deployment )?target\b/i,
    // NOT a bare "two targets": a playback job has targets, and test_playback_credentials.py
    // says "Two targets, one configured each way" about two gateways. Only the phrasings that
    // can only mean a deployment are listed.
    /\btwo deployment targets\b/i,
    /\bone of two targets\b/i,
    /\bon Compose\b/,
    /\bsecond (?:deployment )?target\b/i,
    // The platform's pods share no compose network. The appliance's does exist, and its files
    // say "this compose network" or "the appliance's".
    /\bthe compose network\b/i,
  ];
  const scanned = allFiles.filter(
    (f) =>
      !HISTORY.includes(f) &&
      !isDriftCheck(f) &&
      !f.startsWith('supabase/migrations/archive/') &&
      !f.startsWith('frontend/dist/') &&
      !f.startsWith('.claude/') &&
      !/\.(png|jpe?g|gif|ico|svg|woff2?|ttf|zip|gz|pdf|glb)$/i.test(f)
  );

  const offences = [];
  for (const file of scanned) {
    let text;
    try { text = read(file); } catch { continue; }
    if (text.includes('\0')) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      for (const p of PHRASES) {
        if (p.test(lines[i])) {
          offences.push(`${file}:${i + 1} ${lines[i].trim().slice(0, 90)}`);
          break;
        }
      }
    }
  }
  if (offences.length) {
    fail(
      'prose describes a second deployment target, which the platform has not had since ' +
        'September 2026:\n' +
        offences.map((o) => `        ${o}`).join('\n') +
        '\n        (the appliance does run Compose; the platform does not)'
    );
  } else {
    pass(`no live file describes a second deployment target (${scanned.length} scanned)`);
  }
}
