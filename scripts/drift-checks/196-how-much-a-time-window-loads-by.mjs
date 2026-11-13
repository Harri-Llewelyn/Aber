import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 196. How much a time window loads by itself is stated as AuditTrailTab.jsx holds it. A bounded
// window pages on, PAGE_SIZE at a time, until WINDOW_EVENT_CAP events are loaded, and the hatch
// then quotes the cap. The help page and frontend/README.md give the numbers and the hatch's words;
// a cap stated wrong reads as the page hiding events.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const TAB = 'frontend/src/components/tabs/AuditTrailTab.jsx';
  const tab = read(TAB);
  const pageSize = Number(tab.match(/^const PAGE_SIZE = (\d+)$/m)?.[1]);
  const cap = Number(tab.match(/^export const WINDOW_EVENT_CAP = (\d+)$/m)?.[1]);
  const problems196 = [];
  if (!Number.isFinite(pageSize) || !Number.isFinite(cap)) {
    problems196.push(`could not read PAGE_SIZE and WINDOW_EVENT_CAP out of ${TAB}; its shape changed`);
  } else {
    const words = cap.toLocaleString('en-GB');
    for (const hatch of ["const capWords = WINDOW_EVENT_CAP.toLocaleString('en-GB')",
      'Older events not loaded: more than ${capWords} in this window', 'Not loaded: over ${capWords}']) {
      if (!tab.includes(hatch)) problems196.push(`${TAB} no longer words the hatch with "${hatch}"`);
    }
    const help = read('help/pages/audit-trail.md');
    for (const phrase of [`loads the next ${pageSize} events`, `${pageSize} at a time, up to ${words} events`,
      `loads the newest ${words}`, `Older events not loaded: more than ${words} in this window`,
      `Not loaded: over ${words}`]) {
      if (!help.includes(phrase)) problems196.push(`help/pages/audit-trail.md does not say "${phrase}"`);
    }
    const readme = read('frontend/README.md').replace(/\s+/g, ' ');
    if (!readme.includes(`\`WINDOW_EVENT_CAP\` (${words})`)) {
      problems196.push(`frontend/README.md does not give WINDOW_EVENT_CAP as (${words})`);
    }
  }
  if (problems196.length) {
    fail('the Audit Trail\'s window loading is stated otherwise than AuditTrailTab.jsx holds it:\n' +
      problems196.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the help and frontend/README.md state the Audit Trail's window loading: ${pageSize} a page, up to ${cap} events`);
  }
}
