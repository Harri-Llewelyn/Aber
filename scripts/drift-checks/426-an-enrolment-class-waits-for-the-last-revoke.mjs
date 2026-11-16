import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 426. A class of the enrol-gateway suite deletes its gateway only through
// delete_gateway_and_wait_for_revoke(). Every class enrols under one gateway id, so a revoke the
// delete queued and the credential service has not answered would disable the account the next
// class makes under the same name. The helper waits for the answer in net._http_response (pg_net
// takes a request off its queue before the answer, so an empty queue proves nothing). The suite
// holds no bare delete of a gateway row, the base class's setUpClass and tearDownClass call the
// helper, and any other tearDownClass goes through the base class's.
// -------------------------------------------------------------------------------------------------
const SUITE = 'supabase/functions/enroll-gateway/test_enroll_gateway.py';

/** The body of each definition whose first line matches `header`: the lines up to the next one indented no further. */
function bodies(src, header) {
  const lines = src.split('\n');
  const out = [];
  lines.forEach((line, i) => {
    if (!header.test(line)) return;
    const indent = line.match(/^\s*/)[0].length;
    const body = [];
    for (const next of lines.slice(i + 1)) {
      if (next.trim() && next.match(/^\s*/)[0].length <= indent) break;
      body.push(next);
    }
    out.push(body.join('\n'));
  });
  return out;
}

export default function check() {
  const src = read(SUITE);
  const problems426 = [];
  if (/rest\([^)]*\/gateways\?[^)]*method="DELETE"/.test(src)) {
    problems426.push(`${SUITE} deletes a gateway row with a bare REST call`);
  }
  const helper = bodies(src, /^def delete_gateway_and_wait_for_revoke\(/);
  if (helper.length !== 1 || !helper[0].includes('FROM net._http_response')) {
    problems426.push('delete_gateway_and_wait_for_revoke() does not wait for the answer in net._http_response');
  }
  const setUps = bodies(src, /^\s+def setUpClass\(cls\):/);
  const tearDowns = bodies(src, /^\s+def tearDownClass\(cls\):/);
  if (!setUps.some((b) => b.includes('delete_gateway_and_wait_for_revoke('))) {
    problems426.push('no setUpClass deletes a leftover gateway through delete_gateway_and_wait_for_revoke()');
  }
  if (!tearDowns.some((b) => b.includes('delete_gateway_and_wait_for_revoke('))) {
    problems426.push('no tearDownClass deletes the gateway through delete_gateway_and_wait_for_revoke()');
  }
  for (const body of tearDowns) {
    if (!body.includes('delete_gateway_and_wait_for_revoke(') && !body.includes('super().tearDownClass()')) {
      problems426.push("a tearDownClass neither waits for the revoke nor calls the base class's");
    }
  }
  if (problems426.length) {
    for (const p of problems426) fail(`an enrol-gateway class must wait for the last revoke: ${p}`);
  } else {
    pass("the enrol-gateway suite deletes its gateway only through delete_gateway_and_wait_for_revoke(), which waits for the revoke's answer in net._http_response");
  }
}
