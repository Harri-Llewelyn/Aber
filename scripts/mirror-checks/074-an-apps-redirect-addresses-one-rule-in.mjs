import { ok, problems, read } from './lib.mjs';

// 74. An app's redirect addresses, one rule in two places (0260). app_redirect_problem() decides in
// the database and redirectAddressProblem() says it before the dialog asks. Both are held to
// test-harness/fixtures/app-redirect-addresses.json by their own tests, which must still read it, and
// the file must keep a case for each way an address is allowed and each way it is refused: a case
// removed leaves a rule only one side was ever tested on.
export default function check() {
  const FIXTURE = 'test-harness/fixtures/app-redirect-addresses.json';
  const readers = [
    ['the database suite', 'supabase/migrations/test_an_administrator_registers_an_app_that_signs_people_in.py'],
    ["the dashboard's tests", 'frontend/src/__tests__/registerApp.test.jsx'],
  ];
  const cases = JSON.parse(read(FIXTURE)).cases ?? [];
  const rules = new Set(cases.map((c) => c.rule));
  const ALLOWED = [
    'https goes anywhere', 'http: localhost', 'http: .localhost names', 'http: loopback', 'http: private addresses',
    "http: the site's domain",
  ];
  const REFUSED = [
    'http elsewhere is refused', "the site's domain is a whole name", 'localhost is a whole name',
    'an address that is not one', 'no fragment', 'no wildcard', 'no comma', 'no user name', 'no space', 'no backslash',
    'https and http alone', 'not empty',
  ];
  const before74 = problems.length;
  for (const [who, file] of readers) {
    if (!read(file).includes('app-redirect-addresses.json')) problems.push(`redirectAddresses: ${who} (${file}) no longer reads ${FIXTURE}, so one side of the rule is untested against it`);
  }
  for (const rule of ALLOWED) {
    if (!cases.some((c) => c.rule === rule && c.ok === true)) problems.push(`redirectAddresses: ${FIXTURE} has no allowed case for "${rule}"`);
  }
  for (const rule of REFUSED) {
    if (!cases.some((c) => c.rule === rule && c.ok === false)) problems.push(`redirectAddresses: ${FIXTURE} has no refused case for "${rule}"`);
  }
  if (problems.length === before74) ok.push(`redirectAddresses: ${cases.length} cases across ${rules.size} rules, read by the database suite and the dashboard's tests`);
}
