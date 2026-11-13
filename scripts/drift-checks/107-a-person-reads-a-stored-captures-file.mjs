import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 107. A person reads a stored capture's file only through the audited download (0195). In
// storage-policies.sql every arm of broker_captures_read_privileged that names a role is ANDed with
// a predicate, and the arm naming Auditor with is_open_capture_download() alone: an arm of bare
// has_role() hands every file to the Storage API with no CAPTURE_DOWNLOAD_ISSUED row. The latest
// issue_capture_download() opens that grant, and is_open_capture_download() is plpgsql. No migration
// states a policy on storage.objects, so no replayed file brings the old arm back.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const policies = read('supabase/storage-policies.sql');
  const at = policies.indexOf('CREATE POLICY "broker_captures_read_privileged"');
  // The text inside the parenthesis that opens at `open`.
  const inside = (text, open) => {
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')' && (depth -= 1) === 0) return text.slice(open + 1, i);
    }
    return '';
  };
  // Not named `using`: Semgrep's parser, not Node, refuses that name where an expression reads it.
  const usingClause = at < 0 ? '' : inside(policies, policies.indexOf('USING (', at) + 'USING '.length);
  const roles = usingClause.indexOf('AND (') < 0 ? '' : inside(usingClause, usingClause.indexOf('AND (') + 'AND '.length);
  const arms = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < roles.length; i += 1) {
    if (roles[i] === '(') depth += 1;
    else if (roles[i] === ')') depth -= 1;
    else if (depth === 0 && /^\sOR\s/.test(roles.slice(i - 1, i + 3))) { arms.push(roles.slice(from, i)); from = i + 2; }
  }
  arms.push(roles.slice(from));
  const PREDICATE = /\bAND\s+\(?\s*public\.is_(open_capture_download|unclaimed_capture_object|open_capture_upload)\(/;
  const bare = arms.filter((a) => a.includes('has_role(') && !PREDICATE.test(a));
  const auditor = arms.filter((a) => a.includes("'Auditor'"));
  const auditorWide = auditor.some((a) => !a.includes('is_open_capture_download(') || /is_unclaimed_capture_object|is_open_capture_upload/.test(a));

  const dir = 'supabase/migrations';
  const files = readdirSync(join(REPO, dir)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const last = (fn) => files.filter((f) => read(`${dir}/${f}`).includes(`CREATE OR REPLACE FUNCTION public.${fn}(`)).pop();
  const body = (file, fn) => {
    const text = file ? read(`${dir}/${file}`) : '';
    const start = text.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}(`);
    return start < 0 ? '' : text.slice(start, text.indexOf('\n$$;', start));
  };
  const issuer = last('issue_capture_download');
  const opens = body(issuer, 'issue_capture_download').includes('INSERT INTO public.capture_downloads');
  const predicate = last('is_open_capture_download');
  const plpgsql = /LANGUAGE plpgsql\b/.test(body(predicate, 'is_open_capture_download'));
  const storagePolicies = files.filter((f) => /(CREATE|ALTER)\s+POLICY[^;]*?\bON\s+storage\.objects\b/i.test(read(`${dir}/${f}`)));

  if (arms.length < 2 || bare.length || !auditor.length || auditorWide) {
    fail(`broker_captures_read_privileged admits a person to a capture file without a recorded download (${arms.length} arm(s); ${bare.length} role arm(s) with no predicate; Auditor's arm ${auditor.length ? (auditorWide ? 'not the download grant alone' : 'fine') : 'missing'}): read a stored capture only through issue_capture_download() (0195)`);
  } else if (!opens || !plpgsql) {
    fail(`issue_capture_download() (${issuer || 'no migration'}) ${opens ? '' : 'opens no grant in capture_downloads'}${!opens && !plpgsql ? ' and ' : ''}${plpgsql ? '' : `is_open_capture_download() (${predicate || 'no migration'}) is not plpgsql`}: the bucket's read policy then admits nobody, or admits by a folded answer (0195)`);
  } else if (storagePolicies.length) {
    fail(`${storagePolicies.join(', ')} state(s) a policy on storage.objects: storage-policies.sql is that table's access control, applied after the migrations, and a migration's arm would come back on every boot (0195)`);
  } else {
    pass(`a person reads a stored capture only through the grant issue_capture_download() (${issuer}) opens: ${arms.length} read arms, each role arm confined, Auditor's to the grant; no migration states a storage.objects policy`);
  }
}
