import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 498. An archived gateway is refused a setup token as it is refused a broker credential. The two
// issuers are mirrors: issue_gateway_enrollment_token() is for the appliance, and
// authorize_host_gateway_credential() for the other types. Each raises invalid_parameter_value for an
// archived gateway, so nothing is written for a row that cannot use it, and gateway-bundle says so
// before it mints. One that stopped refusing would move an archived gateway to Awaiting setup, and a
// restore would bring it back holding a live token. The last migration to declare each function is
// the one read, since a later declaration replaces an earlier one on every boot.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const files = allFiles.filter((f) => /^supabase\/migrations\/\d{4}_[^/]*\.sql$/.test(f)).sort();
  const lastBody = (name) => {
    const needle = `CREATE OR REPLACE FUNCTION public.${name}(`;
    const file = files.findLast((f) => read(f).includes(needle));
    if (!file) return null;
    const sql = read(file);
    const at = sql.lastIndexOf(needle);
    return { file, body: sql.slice(at, sql.indexOf('$$;', sql.indexOf('AS $$', at))) };
  };

  const problems498 = [];
  for (const name of ['issue_gateway_enrollment_token', 'authorize_host_gateway_credential']) {
    const found = lastBody(name);
    if (!found) {
      problems498.push(`no migration declares ${name}(), so this check is no longer checking anything`);
      continue;
    }
    const refusal = found.body.match(/IF v_gateway\.is_archived THEN\s+RAISE EXCEPTION '[^']*archived[^']*'[^;]*?USING ERRCODE = 'invalid_parameter_value';/);
    if (!refusal) {
      problems498.push(`${found.file} declares ${name}() last, and it does not raise invalid_parameter_value for an archived gateway`);
    }
  }

  const bundle = read('supabase/functions/gateway-bundle/index.ts');
  const refused = bundle.indexOf('if (gateway.is_archived)');
  const minted = bundle.indexOf('.rpc("issue_gateway_enrollment_token"');
  if (refused < 0) problems498.push('gateway-bundle does not refuse an archived gateway before it mints');
  else if (minted < 0) problems498.push('gateway-bundle no longer calls issue_gateway_enrollment_token(), so this check cannot tell where it refuses');
  else if (refused > minted) problems498.push('gateway-bundle refuses an archived gateway after it has called issue_gateway_enrollment_token()');
  if (!/\.select\("[^"]*\bis_archived\b[^"]*"\)/.test(bundle)) problems498.push('gateway-bundle does not select is_archived, so it cannot refuse an archived gateway');

  if (problems498.length) {
    fail('an archived gateway is not refused a setup token everywhere it should be:\n' + problems498.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('issue_gateway_enrollment_token() and authorize_host_gateway_credential() refuse an archived gateway with invalid_parameter_value, and gateway-bundle refuses it before it mints');
  }
}
