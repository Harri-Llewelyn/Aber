import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 554. A gateway repository is out of its maker's hands first, and one branch is approved.
// Gitea makes whoever creates a repository its administrator. Enrolment and the sweep take that away
// before anything else (ensureHeldByTeams), put Aber's branch rules right in place, and only then
// remove any other (finishBranchRules): a rule created on a gateway's repository and missing from
// GATEWAY_BRANCH_RULES would be removed by every pass. A rule's name is whatever a person made it, so it
// goes into a path through rulePath() alone: the forge-api listener refuses an escaped slash, and fetch
// resolves a dot segment, which would make removing a rule named `..` removing the repository. No rule
// covers what a mirror brings, and a push mirror copies a repository out, so the chart lets the forge
// fetch from and push to nowhere. The branch an approval covers is `main`, so nothing hands out, records
// or deploys the repository's default branch.
// -------------------------------------------------------------------------------------------------
const FORGE = 'supabase/functions/_shared/forge.ts';
const SWEEP = 'supabase/functions/forge-sweep/index.ts';
const FLOW_SYNC = 'forge/gateway-platform/appliance/flow-sync.mjs';
const CHART = 'deploy/helm/aber/templates/apps/gitea.yaml';

/** The text of a function, from its declaration to the next line that closes one. */
function body(source, declaration) {
  const start = source.indexOf(declaration);
  if (start < 0) return '';
  const end = source.indexOf('\n}\n', start);
  return source.slice(start, end < 0 ? undefined : end);
}

export default function check() {
  const problems554 = [];
  const forge = read(FORGE).replace(/\r\n/g, '\n');
  const sweep = read(SWEEP).replace(/\r\n/g, '\n');

  const inOrder = (what, text, calls) => {
    let after = -1;
    for (const call of calls) {
      const at = text.indexOf(call);
      if (at < 0) problems554.push(`${what} does not call ${call}`);
      else if (at < after) problems554.push(`${what} calls ${call} out of order: ${calls.join(', then ')}`);
      after = Math.max(after, at);
    }
  };
  inOrder(`${FORGE}: provisionGatewayRepository()`, body(forge, 'export async function provisionGatewayRepository('), [
    'refuseMirror(cfg, name', 'ensureHeldByTeams(cfg, name)', 'ensureProposals(cfg, name', 'ensureTagProtection(cfg, name)', 'ensureBranchProtection(cfg, name)',
    'ensureApplianceProtection(cfg, name)', 'finishBranchRules(cfg, name)', 'ensureDefaultBranch(cfg, name', 'ensureOnlyDeployKey(cfg, name']);
  inOrder(`${SWEEP}: sweepRepositories(), for a gateway in service`,
    body(sweep, 'async function sweepRepositories(').split('setRepositoryArchived(cfg, name, false')[1] ?? '', [
      'sweepHolders(cfg, name, summary)', 'refuseMirror(cfg, name', 'ensureProposals(cfg, name', 'sweepTags(cfg, name, summary)', 'ensureBranchProtection(cfg, name, { gateway: true })',
      'ensureApplianceProtection(cfg, name)', 'finishBranchRules(cfg, name)', 'ensureDefaultBranch(cfg, name', 'sweepDeployKeys(cfg, name']);

  const ours = /const GATEWAY_BRANCH_RULES: string\[\] = \[([^\]]*)\]/.exec(forge)?.[1].split(',').map((n) => n.trim()).filter(Boolean) ?? [];
  const made = [...forge.matchAll(/\b(?:branch|rule)_name: ([A-Z_]+)\b/g), ...forge.matchAll(/^ {6}rule: ([A-Z_]+),$/gm)].map((m) => m[1]);
  for (const name of new Set(made)) {
    if (!ours.includes(name)) problems554.push(`${FORGE} makes the branch rule ${name}, which GATEWAY_BRANCH_RULES does not list: finishBranchRules() would remove it on every pass`);
  }
  for (const name of ['MAIN_BRANCH', 'APPLIANCE_BRANCH', 'CATCH_ALL_RULE']) {
    if (!ours.includes(name)) problems554.push(`${FORGE}: GATEWAY_BRANCH_RULES does not list ${name}`);
  }

  for (const named of ['finishBranchRules', 'ensureDefaultBranch']) {
    const text = body(forge, `export async function ${named}(`);
    if (!text.includes('rulePath(') || /encodeURIComponent\(/.test(text)) problems554.push(`${FORGE}: ${named}() does not take a rule's name into a path through rulePath()`);
  }
  for (const [key, value] of [['EGRESS_MODE', 'strict'], ['ALLOWED_HOST_LIST', '""']]) {
    if (!read(CHART).replace(/\r\n/g, '\n').includes(`- name: GITEA__migrations__${key}\n  value: ${value}\n`)) {
      problems554.push(`${CHART} does not set GITEA__migrations__${key} to ${value}`);
    }
  }
  if (!forge.includes('export const MAIN_BRANCH = "main";')) problems554.push(`${FORGE} does not name main as MAIN_BRANCH`);
  if (!read(FLOW_SYNC).includes("const TRACKED_BRANCH = 'main';")) problems554.push(`${FLOW_SYNC} does not track MAIN_BRANCH as TRACKED_BRANCH`);
  for (const file of allFiles.filter((f) => f.startsWith('supabase/functions/') && f.endsWith('.ts') && !/_test\.ts$|\.generated\.ts$/.test(f))) {
    if (file !== FORGE && file !== SWEEP && read(file).includes('default_branch')) {
      problems554.push(`${file} reads a repository's default branch. The branch an approval covers is MAIN_BRANCH.`);
    }
  }
  // The one thing done with the branch repository.json names is to refuse another than TRACKED_BRANCH.
  const uses = read(FLOW_SYNC).split('\n').filter((l) => l.includes('repository.branch'));
  if (uses.some((l) => !l.includes('repository.branch !== TRACKED_BRANCH') && !l.includes('names the branch'))) {
    problems554.push(`${FLOW_SYNC} follows the branch repository.json names. It deploys from TRACKED_BRANCH and refuses another.`);
  }

  if (problems554.length) {
    fail("a gateway repository can stay in its maker's hands, or an appliance can be told another branch:\n" + problems554.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`a gateway repository is out of its maker's hands before anything else, its ${ours.length} branch rules are Aber's, and main is the one branch approved, recorded and deployed`);
  }
}
