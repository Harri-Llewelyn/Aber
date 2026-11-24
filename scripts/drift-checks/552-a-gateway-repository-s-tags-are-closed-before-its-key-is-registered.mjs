import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 552. A gateway repository's tags are closed before its key is registered.
// A deploy key is read-write, and branch rules do not cover tags. ensureTagProtection() (forge.ts)
// closes them, so enrolment and the sweep both call it, and before anything else there reads the
// repository or gives a key to it: a repository made by hand can arrive with a tag named as a branch.
// -------------------------------------------------------------------------------------------------
const FORGE = 'supabase/functions/_shared/forge.ts';
const SWEEP = 'supabase/functions/forge-sweep/index.ts';

/** The text of a function, from its declaration to the next line that closes one. */
function body(source, declaration) {
  const start = source.indexOf(declaration);
  if (start < 0) return '';
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end < 0 ? undefined : end);
}

export default function check() {
  const problems552 = [];
  const forge = read(FORGE).replace(/\r\n/g, '\n');
  const sweep = read(SWEEP).replace(/\r\n/g, '\n');

  const inOrder = (what, text, calls) => {
    const at = calls.map((call) => text.indexOf(call));
    calls.forEach((call, i) => {
      if (at[i] < 0) problems552.push(`${what} does not call ${call}`);
      else if (i > 0 && at[i] < at[0]) problems552.push(`${what} calls ${call} before ${calls[0]}`);
    });
  };
  inOrder(`${FORGE}: provisionGatewayRepository()`, body(forge, 'export async function provisionGatewayRepository('),
    ['ensureTagProtection(cfg, name)', 'ensureBranchProtection(cfg, name)', 'ensureApplianceProtection(cfg, name)', 'ensureOnlyDeployKey(cfg, name']);
  if (!body(sweep, 'async function sweepTags(').includes('ensureTagProtection(cfg, name)')) problems552.push(`${SWEEP}: sweepTags() does not call ensureTagProtection(cfg, name)`);
  inOrder(`${SWEEP}: sweepRepositories(), for a gateway in service`, body(sweep, 'async function sweepRepositories(').split('setRepositoryArchived(cfg, name, false')[1] ?? '',
    ['sweepTags(cfg, name, summary)', 'ensureBranchProtection(cfg, name, { seedTemplate: true })', 'ensureApplianceProtection(cfg, name)', 'sweepDeployKeys(cfg, name']);

  if (problems552.length) {
    fail('a gateway repository can be given a key before its tags are closed:\n' + problems552.map((p) => `        ${p}`).join('\n'));
  } else {
    pass("enrolment and the sweep close a gateway repository's tags before anything reads it or a key can write it");
  }
}
