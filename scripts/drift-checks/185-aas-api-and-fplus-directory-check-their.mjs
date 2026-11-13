import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 185. aas-api and fplus-directory check their caller through the probe, never through getUser().
//
// GoTrue's getUser() refuses a token with no `aud`, which is every machine identity's, and consults
// no revocation. Each function must call checkCaller() before it routes, after its own refusal of a
// request with no Authorization header.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const offences = [];
  for (const fn of ['aas-api', 'fplus-directory']) {
    const file = `supabase/functions/${fn}/index.ts`;
    const source = read(file);
    if (/\bauth\.getUser\(/.test(source)) offences.push(`${file} calls auth.getUser(), which refuses every machine identity`);
    if (!source.includes('from "../_shared/callerCheck.ts"')) offences.push(`${file} does not import checkCaller from _shared/callerCheck.ts`);
    const missing = source.indexOf('"Missing Authorization header"');
    const check = source.indexOf('await checkCaller(');
    if (check < 0) offences.push(`${file} never calls checkCaller()`);
    else if (missing < 0 || missing > check) offences.push(`${file} calls checkCaller() before refusing a request with no Authorization header`);
  }
  if (offences.length) {
    fail(`A function that reads as its caller authenticates it some other way:\n  ${offences.join('\n  ')}`);
  } else {
    pass('aas-api and fplus-directory refuse a request with no token, then check the token through the probe');
  }
}
