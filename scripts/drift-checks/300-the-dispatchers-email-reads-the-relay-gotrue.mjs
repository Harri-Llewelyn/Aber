import { CHART_VALUES, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 300. The dispatcher's email reads the relay GoTrue reads, and one place says so. The functions
// Deployment sets SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_ADMIN_EMAIL and SMTP_SENDER_NAME from
// supabaseAuth.smtp's own values, SMTP_PASS from the same optional Secret key GoTrue's GOTRUE_SMTP_PASS
// reads, and SMTP_CA_PEM from supabaseFunctions.smtpCaCert; main/index.ts forwards exactly those to
// notification-dispatch and to no other function (a relay's password is nothing else's); and email.ts
// reads exactly those. A name in one place and not another reads as a relay that is never set, on a
// site that sends password-reset mail and is told that email cannot be sent.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const fnChart = read('deploy/helm/aber/templates/supabase/functions.yaml');
  const authChart = read('deploy/helm/aber/templates/supabase/auth.yaml');
  const registry = read('supabase/functions/main/index.ts');
  const email = read('supabase/functions/notification-dispatch/email.ts');
  const problems300 = [];

  const NAMES = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_ADMIN_EMAIL', 'SMTP_SENDER_NAME', 'SMTP_CA_PEM'];
  const block = registry.match(/const FUNCTION_REGISTRY[^{]*\{([\s\S]*?)\n\};/)?.[1] ?? '';
  const holders = [...block.matchAll(/^\s*"([a-z0-9-]+)"\s*:\s*\[([^\]]*)\]/gm)]
    .filter((m) => NAMES.some((n) => m[2].includes(`"${n}"`))).map((m) => m[1]);
  if (holders.join() !== 'notification-dispatch') {
    problems300.push(`main/index.ts forwards the SMTP_ variables to ${holders.join(', ') || 'no function'}; notification-dispatch alone may hold them`);
  }
  const entry = block.match(/"notification-dispatch":\s*\[([\s\S]*?)\]/)?.[1] ?? '';
  const forwarded = NAMES.filter((n) => entry.includes(`"${n}"`));
  const read_ = new Set([...email.matchAll(/env\("(SMTP_[A-Z_]+)"\)/g)].map((m) => m[1]));
  for (const name of NAMES) {
    if (!forwarded.includes(name)) problems300.push(`main/index.ts does not forward ${name} to notification-dispatch`);
    if (!read_.has(name)) problems300.push(`notification-dispatch/email.ts does not read ${name}`);
    if (!new RegExp(`- name: ${name}\\n|"name" "${name}"`).test(fnChart)) problems300.push(`templates/supabase/functions.yaml does not set ${name}`);
  }
  for (const name of read_) if (!NAMES.includes(name)) problems300.push(`email.ts reads ${name}, which this check does not know and the chart may not set`);
  // One configuration: each from the value or Secret key GoTrue reads, so the two cannot name different relays.
  for (const [name, gotrue] of [['SMTP_HOST', 'host'], ['SMTP_PORT', 'port'], ['SMTP_USER', 'user'], ['SMTP_ADMIN_EMAIL', 'from'], ['SMTP_SENDER_NAME', 'senderName']]) {
    const at = fnChart.match(new RegExp(`- name: ${name}\\n\\s+value: \\{\\{ \\.Values\\.supabaseAuth\\.smtp\\.(\\w+)`))?.[1];
    if (at !== gotrue) problems300.push(`the functions Deployment sets ${name} from supabaseAuth.smtp.${at ?? '(not found)'}, not .${gotrue} as GoTrue reads it`);
  }
  const passKey = fnChart.match(/"name" "SMTP_PASS" "secretName" \$secretName "key" "(\w+)"/)?.[1];
  const gotruePass = authChart.match(/- name: GOTRUE_SMTP_PASS\n\s+valueFrom:\n\s+secretKeyRef:\n\s+name: [^\n]+\n\s+key: (\w+)/)?.[1];
  if (!passKey || passKey !== gotruePass) problems300.push(`SMTP_PASS reads the Secret key ${passKey ?? '(not found)'}, and GOTRUE_SMTP_PASS reads ${gotruePass ?? '(not found)'}`);
  if (!/include "aber\.optionalSecretEnv" \(dict "name" "SMTP_PASS"/.test(fnChart)) {
    problems300.push('SMTP_PASS is not read through aber.optionalSecretEnv, so an external Secret without the key would stop the functions pod');
  }
  if (!/with \.Values\.supabaseFunctions\.smtpCaCert \}\}\s+- name: SMTP_CA_PEM/.test(fnChart)) {
    problems300.push('SMTP_CA_PEM is not set from supabaseFunctions.smtpCaCert, only when it is given');
  }
  if (!/^ {2}smtpCaCert: ""$/m.test(CHART_VALUES)) problems300.push('values.yaml has no supabaseFunctions.smtpCaCert, empty by default');
  if (problems300.length) {
    fail("the dispatcher's email does not read the relay GoTrue reads:\n" + problems300.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`notification-dispatch alone holds the ${NAMES.length} SMTP_ variables, set from supabaseAuth.smtp and GoTrue's own Secret key, and email.ts reads exactly those`);
  }
}
