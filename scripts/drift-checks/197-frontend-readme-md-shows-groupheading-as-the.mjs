import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 197. frontend/README.md shows GroupHeading as the component takes it, and names the key the Audit
// Trail keeps its closed sections under. A prop the example passes and the component ignores, or a
// key the page no longer writes, sends the next page that copies them wrong.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const COMPONENT = 'frontend/src/components/common/GroupHeading.jsx';
  const props = (read(COMPONENT).match(/export function GroupHeading\(\{([^}]*)\}\)/)?.[1] ?? '')
    .split(',').map((p) => p.trim().split(/\s*=/)[0]).filter(Boolean);
  const readme = read('frontend/README.md');
  const from = readme.indexOf('### A group of rows opens and closes under one heading');
  const section = from < 0 ? '' : readme.slice(from, readme.indexOf('\n### ', from + 1));
  const fence = '`'.repeat(3);
  const opened = section.indexOf(`${fence}jsx\n`);
  const closed = opened < 0 ? -1 : section.indexOf(fence, opened + fence.length + 4);
  const example = closed < 0 ? '' : section.slice(opened + fence.length + 4, closed);
  // The props on GroupHeading itself, not those of an element passed as one of them (an icon).
  const passed = [...example.replace(/<(?!GroupHeading)[A-Z]\w*[^>]*\/>/g, '').matchAll(/(\w+)=\{/g)].map((m) => m[1]);
  const key = read('frontend/src/components/tabs/AuditTrailTab.jsx')
    .match(/^export const CLOSED_SECTIONS_KEY = '([^']+)'$/m)?.[1];
  const problems197 = [];
  if (!props.length) problems197.push(`could not read GroupHeading's props out of ${COMPONENT}`);
  if (!section) problems197.push('frontend/README.md has no section "A group of rows opens and closes under one heading"');
  else if (!passed.length) problems197.push('that section has no GroupHeading example to check');
  for (const p of passed.filter((p) => !props.includes(p))) {
    problems197.push(`the README's example passes ${p}, which GroupHeading does not take`);
  }
  if (!key) problems197.push('could not read CLOSED_SECTIONS_KEY out of AuditTrailTab.jsx');
  else if (section && !section.includes(`\`${key}\``)) problems197.push(`the section does not name the key ${key}`);
  if (problems197.length) {
    fail('frontend/README.md describes GroupHeading otherwise than the code has it:\n' +
      problems197.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`frontend/README.md's GroupHeading example passes ${passed.length} of its props and names ${key}`);
  }
}
