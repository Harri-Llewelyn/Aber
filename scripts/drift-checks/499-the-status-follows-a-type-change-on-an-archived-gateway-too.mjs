import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 499. The status follows a change of type on an archived gateway as it does on one that is not.
// clean_up_after_a_gateway_type_change() skips the setup tokens and the credential for an archived
// gateway, since archiving ended both, and sets the status for every gateway: one that becomes Remote
// or leaves it mid-enrolment reads OFFLINE. The status step must sit outside the skip, or an archived
// Remote gateway changed to Host keeps PENDING_ENROLLMENT and reads Awaiting setup when it is
// restored. The last migration to declare the function is the one read, and the lifecycle page's row
// for an archived gateway says OFFLINE.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const files = allFiles.filter((f) => /^supabase\/migrations\/\d{4}_[^/]*\.sql$/.test(f)).sort();
  const needle = 'CREATE OR REPLACE FUNCTION public.clean_up_after_a_gateway_type_change(';
  const file = files.findLast((f) => read(f).includes(needle));

  const problems499 = [];
  if (!file) {
    problems499.push('no migration declares clean_up_after_a_gateway_type_change(), so this check is no longer checking anything');
  } else {
    const sql = read(file);
    const at = sql.lastIndexOf(needle);
    const body = sql.slice(at, sql.indexOf('$$;', sql.indexOf('AS $$', at)));
    const skip = body.search(/IF OLD\.is_archived IS NOT TRUE THEN/);
    const status = body.search(/NEW\.status := 'OFFLINE'/);
    const copy = body.search(/DELETE FROM vault\.secrets/);
    // 0311 owes the revocation through owe_gateway_revocation(), which asks revoke_gateway_credential().
    const revoke = body.search(/(?:owe_gateway_revocation|revoke_gateway_credential)\(/);
    const burn = body.search(/UPDATE public\.gateway_enrollment_tokens/);
    if (skip < 0 || status < 0 || copy < 0 || revoke < 0 || burn < 0) {
      problems499.push(`${file} declares clean_up_after_a_gateway_type_change() last, in a shape this check cannot read: it needs the archived skip, the token burn, the revocation, the kept copy and the status`);
    } else {
      if (burn < skip || revoke < skip || copy < skip) {
        problems499.push(`${file}: the token burn, the revocation or the kept copy comes before the archived gateway's skip, so an archived gateway would have them ended again`);
      }
      if (status < copy) {
        problems499.push(`${file}: the status step comes inside the archived gateway's skip, so an archived gateway changed to or from Remote keeps the status of the old type`);
      }
    }
  }

  const row = read('docs/gateway-lifecycle.md').split('\n').find((line) => line.startsWith('| **An archived gateway**, to another type |'));
  if (!row) problems499.push('docs/gateway-lifecycle.md has no row for an archived gateway changed to another type, so this check cannot read it');
  else if (!row.split('|')[2].includes('OFFLINE')) problems499.push("docs/gateway-lifecycle.md's row for an archived gateway changed to another type does not say its status reads OFFLINE");

  if (problems499.length) {
    fail('the status of an archived gateway whose type changes is not the same everywhere it is said:\n' + problems499.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`${file.match(/\/(\d{4})_/)[1]}'s clean-up skips an archived gateway's tokens and credential and sets its status, and the lifecycle page says its status reads OFFLINE`);
  }
}
