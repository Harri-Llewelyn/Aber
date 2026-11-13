import { fail, pass, read, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 361. The revocation retry's numbers are said as the migrations hold them. 0288's sweep waits five
// minutes for a reply and asks for 200 a run, and pg_cron (0002) runs it every 15 minutes; the README's
// 0288 section and the Gateways help say the same, so a reader waiting on a retry waits as long as
// the sweep does.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const SWEEP = 'supabase/migrations/0288_a_failed_type_change_revocation_is_retried.sql';
  const sql = read(SWEEP);
  const seed = read('supabase/migrations/0002_seed_data.sql');
  const section = supabaseReadme().match(/\n### A failed revocation after a change of type is asked again \(0288\)\n([\s\S]*?)(?=\n### )/)?.[1];
  const help = read('help/pages/gateways.md').split('\n').find((l) => l.startsWith('- **Changing a gateway\'s type**'));
  const problems361 = [];
  const waits = [...new Set([...sql.matchAll(/interval '(\d+) minutes'/g)].map((m) => Number(m[1])))];
  const limits = [...new Set([...sql.matchAll(/LIMIT (\d+)/g)].map((m) => Number(m[1])))];
  const every = seed.match(/cron\.schedule\('sweep-gateway-credential-revocations', '\*\/(\d+) \* \* \* \*'/)?.[1];
  const words = { 5: 'five', 15: '15' };
  if (waits.length !== 1 || limits.length !== 1 || !every) {
    problems361.push(`could not read the sweep's wait (${waits.join(', ')}), its limit (${limits.join(', ')}) and its schedule (${every}) from ${SWEEP} and 0002`);
  } else {
    if (!section) problems361.push('supabase/README.md has no 0288 section');
    else {
      const flat = section.replace(/\s+/g, ' ');
      if (!flat.includes(`${words[waits[0]] ?? waits[0]} minutes`)) problems361.push(`the 0288 section does not say a reply is waited for ${waits[0]} minutes`);
      if (!flat.includes(`${limits[0]} a run`)) problems361.push(`the 0288 section does not say ${limits[0]} a run`);
      if (!flat.includes(`every ${every} minutes`)) problems361.push(`the 0288 section does not say the sweep runs every ${every} minutes`);
    }
    if (!help) problems361.push("help/pages/gateways.md has no 'Changing a gateway's type' paragraph");
    else if (!help.includes(`every ${every} minutes`)) problems361.push(`the Gateways help does not say Aber asks again every ${every} minutes`);
  }
  if (problems361.length) {
    fail(`the revocation retry's numbers are not said as the migrations hold them:\n${problems361.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`the 0288 section and the Gateways help say the sweep waits ${waits[0]} minutes, asks for ${limits[0]} a run and runs every ${every} minutes, as 0288 and 0002 hold`);
  }
}
