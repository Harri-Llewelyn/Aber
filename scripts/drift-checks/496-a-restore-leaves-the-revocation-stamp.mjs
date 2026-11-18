import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 496. A restore leaves credential_revoked_at as the archive wrote it. Archiving disables a gateway's
// broker account and stamps the column, and restoring does not enable the account, so the stamp is
// the record that it is disabled. Three places say what a restore does to it: the function behind
// trg_gateways_clear_credential_revoked (0001 cleared it, 0308 leaves it), the column's comment (the
// last migration to state it), and the lifecycle page's rows for a restore. A later migration that
// cleared the stamp again would make the record read Issued beside a disabled account, and a restored
// Remote gateway would be offered no setup.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const files = allFiles.filter((f) => /^supabase\/migrations\/\d{4}_[^/]*\.sql$/.test(f)).sort();
  const lastWith = (needle) => files.findLast((f) => read(f).includes(needle));

  const problems496 = [];
  const fnFile = lastWith('CREATE OR REPLACE FUNCTION public.clear_credential_revoked_on_enrolment(');
  if (!fnFile) {
    problems496.push('no migration declares clear_credential_revoked_on_enrolment(), so this check is no longer checking anything');
  } else {
    const sql = read(fnFile);
    const at = sql.indexOf('CREATE OR REPLACE FUNCTION public.clear_credential_revoked_on_enrolment(');
    const body = sql.slice(at, sql.indexOf('$$;', sql.indexOf('AS $$', at)));
    if (body.includes('credential_revoked_at')) {
      problems496.push(`${fnFile} declares clear_credential_revoked_on_enrolment() last, and it writes credential_revoked_at: a restore would clear the stamp`);
    }
  }

  const commentFile = lastWith('COMMENT ON COLUMN public.gateways.credential_revoked_at IS');
  if (!commentFile) {
    problems496.push('no migration comments gateways.credential_revoked_at, so this check is no longer checking anything');
  } else {
    const sql = read(commentFile);
    const at = sql.lastIndexOf('COMMENT ON COLUMN public.gateways.credential_revoked_at IS');
    const comment = sql.slice(at, sql.indexOf(";\n", at));
    if (/restor\w+ the gateway clears/i.test(comment)) {
      problems496.push(`${commentFile} comments credential_revoked_at last, and says restoring the gateway clears it`);
    }
    if (!/restor\w+ the gateway leaves it/i.test(comment)) {
      problems496.push(`${commentFile} comments credential_revoked_at last, and does not say restoring the gateway leaves it`);
    }
  }

  // The Restore rows for a gateway that was revoked: not the ones for a gateway that never enrolled or held none.
  const rows = read('docs/gateway-lifecycle.md').split('\n')
    .filter((line) => line.startsWith('| **Restore**,') && !/never enrolled|no credential/.test(line.split('|')[1]));
  if (rows.length < 2) problems496.push('docs/gateway-lifecycle.md has fewer than two Restore rows for a gateway that was revoked, so this check cannot read them');
  for (const row of rows) {
    if (!row.includes('The stamp stays')) problems496.push(`docs/gateway-lifecycle.md: a Restore row for a gateway that holds a credential does not say the stamp stays: ${row.slice(0, 60)}`);
  }

  if (problems496.length) {
    fail('what a restore does to credential_revoked_at is not the same everywhere it is said:\n' + problems496.map((p) => `        ${p}`).join('\n'));
  } else {
    const number = (file) => file.match(/\/(\d{4})_/)[1];
    pass(`a restore leaves credential_revoked_at: ${number(fnFile)} writes nothing, ${number(commentFile)} says so, and the lifecycle page's ${rows.length} Restore rows say the stamp stays`);
  }
}
