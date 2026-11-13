import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 372. The help says where Expand all is on each page that has it: at the start of the line above the
// groups (check 371). The Audit Trail, History, Metrics and Vocabulary help pages each say so beside
// the button's name, and none puts it in the toolbar.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems372 = [];
  for (const page of ['audit-trail', 'history', 'metrics', 'vocabulary']) {
    const named = read(`help/pages/${page}.md`).split('\n').filter((l) => /\*\*(Expand|Collapse) all\*\*/.test(l));
    if (!named.some((l) => /at the start of the [^.]*?\b(line|row)\b/.test(l))) {
      problems372.push(`help/pages/${page}.md never says Expand all is at the start of the line or row above the groups`);
    }
    for (const l of named.filter((l) => /toolbar/i.test(l))) {
      problems372.push(`help/pages/${page}.md puts a button in the toolbar that is over the groups: ${l.slice(0, 80)}`);
    }
  }
  if (problems372.length) {
    fail('the help does not say where Expand all is as the code draws it:\n' + problems372.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('the Audit Trail, History, Metrics and Vocabulary help each place Expand all at the start of the line above the groups');
  }
}
