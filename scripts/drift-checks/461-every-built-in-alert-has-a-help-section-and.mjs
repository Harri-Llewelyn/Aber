import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 461. Every built-in alert has a section in help/pages/built-in-alerts.md, and every section there
// names a rule that exists. The rules are the uids of grafana/provisioning/alerting/alert-rules.yaml.
// A section is a `###` heading, titled as the rule is (the drawer's View Help opens it by the slug of
// the title), whose first line reads "Rule UID: `<uid>`." A rule with no section sends the reader of
// its drawer to a page that says nothing of it; a section for a retired rule is advice about an
// alert that no longer fires.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const RULES = 'grafana/provisioning/alerting/alert-rules.yaml';
  const HELP = 'help/pages/built-in-alerts.md';
  const rules = [...read(RULES).matchAll(/^ {6}- uid: (\S+)\n {8}title: (.+)$/gm)]
    .map((m) => ({ uid: m[1], title: m[2].trim().replace(/^(['"])(.*)\1$/, '$2') }));
  const sections = read(HELP).split(/^### /m).slice(1).map((block) => {
    const [title, ...body] = block.split('\n');
    return { title: title.trim(), uid: /^Rule UID: `([A-Za-z0-9_-]+)`\.$/m.exec(body.join('\n'))?.[1] ?? null };
  });

  const problems461 = [];
  if (rules.length === 0) problems461.push(`could not read a rule's uid and title from ${RULES}: its shape changed, so this check checks nothing`);
  for (const { uid, title } of rules) {
    const section = sections.find((s) => s.uid === uid);
    if (!section) problems461.push(`${HELP} has no section for ${uid} (${title})`);
    else if (section.title !== title) problems461.push(`${HELP}: the section for ${uid} is titled "${section.title}" and the rule's title is "${title}", which is how the drawer finds the section`);
  }
  const known = new Set(rules.map((r) => r.uid));
  for (const s of sections) {
    if (!s.uid) problems461.push(`${HELP}: the section "${s.title}" names no rule: its first line must read "Rule UID: \`<uid>\`."`);
    else if (!known.has(s.uid)) problems461.push(`${HELP}: the section "${s.title}" names ${s.uid}, which ${RULES} does not hold`);
  }
  const seen = new Set();
  for (const s of sections) {
    if (s.uid && seen.has(s.uid)) problems461.push(`${HELP} has two sections for ${s.uid}`);
    seen.add(s.uid);
  }

  if (problems461.length) {
    fail(`the built-in alerts and their help disagree:\n${problems461.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`all ${rules.length} built-in alert(s) have a section in ${HELP}, titled as the rule is, and every section names one`);
  }
}
