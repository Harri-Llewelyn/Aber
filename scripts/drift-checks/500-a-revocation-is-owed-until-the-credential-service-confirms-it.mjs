import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 500. A revocation is owed until the credential service confirms it (0311). Every step that ends a
// gateway's broker credential owes the revocation through owe_gateway_revocation(), which records the
// debt before it asks, so a call that cannot be made is still owed: the archive, the change of type
// and the setup for an enrolled appliance. The delete keeps what is owed in
// deleted_gateway_revocations, since the cascade would take the gateway's own row. The sweep asks
// again for every debt, never gated on gateway_has_broker_credential(), which reads the gateway's type
// now and would drop the debt of a type it no longer has, and it keeps 0288's check for a newer
// credential. The last migration to declare each function is the one read, and the lifecycle page's
// delete rows say a debt outlives the row.
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

  const problems500 = [];
  const found = {};
  for (const name of ['sweep_gateway_credential_revocations', 'revoke_credential_on_decommission',
    'clean_up_after_a_gateway_type_change', 'issue_gateway_enrollment_token']) {
    found[name] = lastBody(name);
    if (!found[name]) problems500.push(`no migration declares ${name}(), so this check is no longer checking anything`);
  }

  const sweep = found.sweep_gateway_credential_revocations;
  if (sweep) {
    if (!sweep.body.includes('deleted_gateway_revocations')) {
      problems500.push(`${sweep.file}: the sweep does not ask for a deleted gateway's revocation`);
    }
    if (sweep.body.includes('gateway_has_broker_credential(')) {
      problems500.push(`${sweep.file}: the sweep asks gateway_has_broker_credential() whether a revocation is owed, which drops the debt of a type the gateway no longer has`);
    }
    if (!sweep.body.includes('NOT public.gateway_credential_was_replaced(g)')) {
      problems500.push(`${sweep.file}: the sweep no longer checks for a credential issued or enrolled after the stamp before it asks again`);
    }
  }

  const decommission = found.revoke_credential_on_decommission;
  if (decommission) {
    const [onDelete = '', onArchive = ''] = decommission.body.split(/RETURN OLD;/);
    if (!onDelete.includes('INSERT INTO public.deleted_gateway_revocations')) {
      problems500.push(`${decommission.file}: a delete does not keep what the gateway owes in deleted_gateway_revocations`);
    }
    if (!onArchive.includes('owe_gateway_revocation(')) {
      problems500.push(`${decommission.file}: an archive asks without owing, so a call that cannot be made is lost`);
    }
  }
  for (const name of ['clean_up_after_a_gateway_type_change', 'issue_gateway_enrollment_token']) {
    const fn = found[name];
    if (fn && !fn.body.includes('owe_gateway_revocation(')) {
      problems500.push(`${fn.file}: ${name}() does not owe the revocation it asks for`);
    }
    if (fn && /PERFORM public\.revoke_gateway_credential\(|IF public\.revoke_gateway_credential\(/.test(fn.body)) {
      problems500.push(`${fn.file}: ${name}() asks revoke_gateway_credential() directly, which records nothing when it cannot ask`);
    }
  }

  const doc = read('docs/gateway-lifecycle.md').split('\n');
  for (const step of ['Auto-delete', 'Delete']) {
    const row = doc.find((line) => line.startsWith(`| **${step}**, any type but Playback |`));
    if (!row) problems500.push(`docs/gateway-lifecycle.md has no ${step} row, so this check cannot read it`);
    else if (!row.includes('A revocation still owed')) problems500.push(`docs/gateway-lifecycle.md's ${step} row does not say a revocation still owed outlives the row`);
  }

  if (problems500.length) {
    fail('a revocation is not owed until it is confirmed everywhere it should be:\n' + problems500.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`${sweep.file.match(/\/(\d{4})_/)[1]}'s sweep asks for every owed revocation, deleted gateways' too, the archive, the change of type and the setup owe what they ask, and the lifecycle page says a debt outlives a delete`);
  }
}
