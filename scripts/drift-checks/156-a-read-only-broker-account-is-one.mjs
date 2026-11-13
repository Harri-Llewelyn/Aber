import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 156. A read-only broker account is one rule in the four places that hold it: "sub" and 21
// lowercase hex characters, a name of at most 80 characters and a description of at most 500.
// The credential library decides; broker-subscriber refuses first, 0218 records, and the page
// offers Delete. A page wider than the function offers a Delete that is refused; a record
// narrower than the service fails on an account the broker already made.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const SCHEME = '^sub[0-9a-f]{21}$';
  const lib = read('scripts/lib/mosquitto-credentials.mjs');
  const fn = read('supabase/functions/broker-subscriber/subscriber.ts');
  const ui = read('frontend/src/utils/serviceIdentities.js');
  const migration = readdirSync(join(REPO, 'supabase/migrations')).find((f) => /^0218_.*\.sql$/.test(f));
  const sql = migration ? read(`supabase/migrations/${migration}`) : '';
  const grab = (src, re) => src.match(re)?.[1] ?? null;
  const holders = [
    ['scripts/lib/mosquitto-credentials.mjs', grab(lib, /\bSUBSCRIBER_ID_PATTERN = \/(\S+)\/;?$/m),
      Number(grab(lib, /\bSUBSCRIBER_NAME_MAX = (\d+)/)), Number(grab(lib, /\bSUBSCRIBER_DESCRIPTION_MAX = (\d+)/))],
    ['broker-subscriber/subscriber.ts', grab(fn, /\bSUBSCRIBER_USERNAME = \/(\S+)\/;?$/m),
      Number(grab(fn, /\bNAME_MAX = (\d+)/)), Number(grab(fn, /\bDESCRIPTION_MAX = (\d+)/))],
    ['frontend/src/utils/serviceIdentities.js', grab(ui, /\bSUBSCRIBER_USERNAME = \/(\S+)\/;?$/m),
      Number(grab(ui, /\bSUBSCRIBER_NAME_MAX = (\d+)/)), Number(grab(ui, /\bSUBSCRIBER_DESCRIPTION_MAX = (\d+)/))],
  ];
  const problems156 = [];
  for (const [where, pattern, nameMax, descriptionMax] of holders) {
    if (pattern !== SCHEME) problems156.push(`${where} spells the scheme ${pattern === null ? '(not found)' : `/${pattern}/`}`);
    if (nameMax !== 80 || descriptionMax !== 500) {
      problems156.push(`${where} bounds the name at ${nameMax} and the description at ${descriptionMax}`);
    }
  }
  // Each `!~ '<pattern>'` in the file: the two functions' refusals of a username.
  const sqlSchemes = sql.split("!~ '").slice(1).map((rest) => rest.slice(0, rest.indexOf("'")));
  if (!migration) {
    problems156.push('supabase/migrations holds no 0218, which records these accounts');
  } else {
    if (sqlSchemes.length !== 2 || sqlSchemes.some((p) => p !== SCHEME)) {
      problems156.push(`${migration} refuses usernames by ${sqlSchemes.join(', ') || '(no pattern found)'}`);
    }
    if (!sql.includes('char_length(v_name) NOT BETWEEN 1 AND 80 ')
      || !sql.includes('char_length(v_description) NOT BETWEEN 1 AND 500 ')) {
      problems156.push(`${migration} does not bound the name at 80 and the description at 500`);
    }
  }
  if (problems156.length) {
    fail(`a read-only broker account is not one rule: ${problems156.join('; ')}.\n` +
      '      The credential library, broker-subscriber, 0218 and the Access Control page must agree on\n' +
      `      /${SCHEME}/, 80 and 500.`);
  } else {
    pass(`a read-only broker account is /${SCHEME}/ with a name of 80 and a description of 500 in the library, the function, 0218 and the page`);
  }
}
