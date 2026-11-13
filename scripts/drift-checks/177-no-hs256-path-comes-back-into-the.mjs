import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 177. No HS256 path comes back into the chart. SUPABASE_JWT_SECRET is read by GoTrue alone, as
// GOTRUE_JWT_SECRET, which it requires and signs nothing with; each per-service secret
// lib/signing-set.mjs mints is rendered from its value and read by its own service alone; and no
// template branches on supabaseAuth.es256Signing but the validator and NOTES.txt's deprecation.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const TEMPLATES = allFiles.filter((f) => f.startsWith('deploy/helm/aber/templates/'));
  const readers = (key) => TEMPLATES.flatMap((f) =>
    [...read(f).matchAll(/"name"\s+"([A-Z0-9_]+)"[^)]*?"key"\s+"([A-Z0-9_]+)"/g)].filter((m) => m[2] === key).map((m) => `${f}:${m[1]}`));
  const problems177 = [];
  const shared = readers('SUPABASE_JWT_SECRET');
  if (shared.join() !== 'deploy/helm/aber/templates/supabase/auth.yaml:GOTRUE_JWT_SECRET') {
    problems177.push(`SUPABASE_JWT_SECRET is read as ${shared.join(', ') || 'nothing'}; GoTrue's GOTRUE_JWT_SECRET alone may read it, or a service accepts tokens signed with it again`);
  }
  const lib = read('scripts/lib/signing-set.mjs');
  const services = [...lib.matchAll(/\{ valuesKey: '(\w+)', env: '([A-Z0-9_]+)', reader: '([\w-]+)' \}/g)];
  const secretYaml = read('deploy/helm/aber/templates/secret.yaml');
  for (const [, valuesKey, env, reader] of services) {
    if (!secretYaml.includes(`\n  ${env}: {{ .Values.secrets.${valuesKey} `)) {
      problems177.push(`templates/secret.yaml does not render ${env} from secrets.${valuesKey}, which lib/signing-set.mjs mints`);
    }
    const read177 = readers(env).map((r) => r.split(':')[0]);
    const base = reader.replace(/^supabase-/, '');
    const own = TEMPLATES.filter((f) => f.endsWith(`/${base}.yaml`) || f.endsWith(`/${base}-deployment.yaml`));
    if (!read177.length || read177.some((f) => !own.includes(f))) {
      problems177.push(`${env} is read in ${read177.join(', ') || 'no template'}; ${reader} alone may read it`);
    }
  }
  if (services.length !== 2) problems177.push(`lib/signing-set.mjs's SERVICE_SECRETS names ${services.length} secrets, where this check expects Realtime's and Storage's`);
  const switches = TEMPLATES.filter((f) => /\.Values\.supabaseAuth\.es256Signing|"es256Signing"/.test(read(f)));
  const allowed = ['deploy/helm/aber/templates/_helpers.tpl', 'deploy/helm/aber/templates/NOTES.txt'];
  for (const f of switches.filter((s) => !allowed.includes(s))) {
    problems177.push(`${f} reads supabaseAuth.es256Signing, which is deprecated and selects nothing: every token is ES256`);
  }
  for (const p of problems177) fail(p);
  if (!problems177.length) {
    pass(`SUPABASE_JWT_SECRET reaches GoTrue alone, and ${services.map((s) => s[2]).join(' and ')} each reach their own service alone`);
  }
}
