import { fail, pass, read, readDoc } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 297. What an outside app's token reaches (0260). The gateway's outside-apps-sign-in policy admits a
// list of method and path pairs; the author's guide's table names each in full, and docs/gateway.md,
// docs/security-model.md and the 0260 section count them in words. A request the gateway admits that
// no page says, or one a page says it does not, is an app author told something false.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const envoy = read('supabase/envoy.yaml');
  const at = envoy.indexOf('outside-apps-sign-in:');
  const policy = at < 0 ? '' : envoy.slice(at, envoy.indexOf('principals:', at));
  const admitted = [...policy.matchAll(/exact: (GET|POST) \} \} \}, \{ (?:url_path: \{ path: \{ exact: "([^"]+)" \} \}|header: \{ name: ":path", string_match: \{ exact: "([^"]+)" \} \})/g)]
    .map((m) => `${m[1]} ${m[2] ?? m[3]}`);
  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
  const problems297 = [];
  if (!admitted.length) problems297.push('supabase/envoy.yaml has no outside-apps-sign-in policy this check can read');
  const guide = read('docs/sign-in-with-aber.md');
  const table = guide.slice(guide.indexOf('## What the app\'s token can reach'));
  const listed = [...table.matchAll(/^\| `((?:GET|POST) \/auth\/v1\/[^`]+)` \|/gm)].map((m) => m[1]);
  for (const r of admitted.filter((x) => !listed.includes(x))) problems297.push(`docs/sign-in-with-aber.md's table does not list ${r}, which the gateway admits`);
  for (const r of listed.filter((x) => !admitted.includes(x))) problems297.push(`docs/sign-in-with-aber.md's table lists ${r}, which the gateway does not admit`);
  const count = WORDS[admitted.length];
  for (const [file, needle] of [
    ['docs/gateway.md', `passes on ${count} sign-in requests alone`],
    ['docs/security-model.md', `reaches ${count} sign-in\nrequests`],
    ['supabase/README.md', `any other app's on ${count} requests`],
  ]) {
    if (admitted.length && !readDoc(file).includes(needle)) problems297.push(`${file} does not say "${needle.split('\n').join(' ')}", the ${admitted.length} requests the gateway admits`);
  }
  if (problems297.length) {
    for (const p of problems297) fail(`an outside app's token: ${p}`);
  } else {
    pass(`an outside app's token reaches ${admitted.length} requests (${admitted.map((r) => r.replace('/auth/v1', '')).join(', ')}), each in the author's guide's table, counted in words in the gateway page, the security model and the 0260 section`);
  }
}
