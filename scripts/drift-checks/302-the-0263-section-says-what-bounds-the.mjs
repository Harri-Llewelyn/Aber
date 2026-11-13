import { fail, pass, read, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 302. The 0263 section says what bounds the SMTP client as the code holds it: a step's time, the
// whole exchange's, and the longest reply it reads. A reader sizing a relay's timeout, or a reviewer
// checking the pass's budget, would act on a number that is not the code's.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const smtp = read('supabase/functions/notification-dispatch/smtp.ts');
  const section = supabaseReadme().match(/### An email goes to the people who hold the roles it names \(0263\)([\s\S]*?)\n### /)?.[1] ?? '';
  const dispatch = read('supabase/functions/notification-dispatch/index.ts');
  const email = read('supabase/functions/notification-dispatch/email.ts');
  const problems302 = [];
  const grab = (src, re, what) => {
    const m = src.match(re);
    if (!m) problems302.push(`could not read ${what}`);
    return m ? m[1] : null;
  };
  const num = (v) => (v === null ? null : Number(v.replace(/_/g, '')));
  const step = num(grab(email, /timeoutMs: ([\d_]+),/, "the step limit in email.ts's send"));
  const total = num(grab(email, /totalMs: ([\d_]+),/, "the whole-exchange limit in email.ts's send"));
  const line = num(grab(smtp, /const MAX_REPLY_LINE = ([\d_]+);/, 'MAX_REPLY_LINE in smtp.ts'));
  const lines = num(grab(smtp, /const MAX_REPLY_LINES = ([\d_]+);/, 'MAX_REPLY_LINES in smtp.ts'));
  const budget = num(grab(dispatch, /const PASS_BUDGET_MS = ([\d_]+);/, "the pass's budget in index.ts"));
  const flat = section.replace(/\s+/g, ' ');
  if (!section) problems302.push("supabase/README.md has no '### An email goes to the people who hold the roles it names (0263)' section");
  else {
    for (const [value, said] of [
      [step, `A step has ${step === null ? '?' : step / 1000} seconds and the whole exchange ${total === null ? '?' : total / 1000}`],
      [line, `A reply of more than ${line === null ? '?' : line.toLocaleString('en-US')} characters on a line`],
      [lines, `or of more than ${lines} lines`],
    ]) {
      if (value !== null && !flat.includes(said)) problems302.push(`the 0263 section does not say "${said}"`);
    }
  }
  if (step !== null && total !== null && budget !== null && (budget + total > 60_000 || total < step)) {
    problems302.push(`the pass starts a row up to ${budget} ms in and a send takes up to ${total} ms, over the runtime's 60 s, or the whole is shorter than a step`);
  }
  if (problems302.length) {
    fail("the 0263 section's bounds are not the SMTP client's:\n" + problems302.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the 0263 section holds the SMTP client's bounds: ${step / 1000} s a step, ${total / 1000} s in all, ${line.toLocaleString('en-US')}-character and ${lines}-line replies, inside the pass's ${budget / 1000} s budget`);
  }
}
