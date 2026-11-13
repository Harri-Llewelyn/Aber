import { SUITES } from '../python-suites.mjs';
import { fail, pass, read, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 360. The bound of the delete's suite is said as the suite holds it. The suite deletes an automation
// with TRIGGERS triggers and FIRING firing alerts and allows BOUND_SECONDS; the README's 0287 section,
// and the suite's own header say the same numbers, so a bound
// loosened in the suite until a return to a call for each row passes it is not left described as
// the old one.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const SUITE = 'supabase/migrations/test_deleting_an_automation_resolves_its_alerts_in_one_pass.py';
  const py = read(SUITE);
  const triggers = Number(py.match(/^TRIGGERS = (\d+)$/m)?.[1]);
  const firing = Number(py.match(/^FIRING = (\d+)$/m)?.[1]);
  const bound = py.match(/^BOUND_SECONDS = ([\d.]+)$/m)?.[1];
  const problems360 = [];
  if (!triggers || !firing || !bound) problems360.push(`could not read TRIGGERS, FIRING and BOUND_SECONDS from ${SUITE}`);
  else {
    const people = `${triggers.toLocaleString('en-US')} triggers and ${firing.toLocaleString('en-US')} firing alerts`;
    const said = {
      'supabase/README.md': supabaseReadme().match(/\n### Deleting an automation resolves its alerts in one pass \(0287\)\n([\s\S]*?)(?=\n### )/)?.[1] ?? '',
      [`the header of ${SUITE}`]: SUITES[SUITE]?.why ?? '',
    };
    for (const [file, text] of Object.entries(said)) {
      const flat = text.replace(/'\s*\+\s*\n\s*(?:'|")/g, '').replace(/\n#\s*/g, ' ').replace(/\s+/g, ' ');
      const around = flat;
      if (!around.includes(people)) problems360.push(`${file} does not say the suite deletes an automation with ${people}`);
      if (!around.includes(`under ${bound} s`)) problems360.push(`${file} does not say the delete must take under ${bound} s`);
    }
  }
  if (problems360.length) {
    fail(`the delete's bound is not said as ${SUITE} holds it:\n${problems360.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`the README and the suite's header say the delete's suite deletes ${triggers.toLocaleString('en-US')} triggers with ${firing.toLocaleString('en-US')} firing alerts in under ${bound} s`);
  }
}
