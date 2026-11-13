import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 154. k8s-validation sets its kubelet's sync period in the variable scripts/dev-cluster.mjs reads,
// and docs/testing.md names the same period. A renamed variable fails silently: the cluster keeps
// the kubelet's minute, and the stack lane is only slower.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const WORKFLOW = '.github/workflows/ci.yml';
  const JOB = '\n  k8s-validation:\n';
  const text = read(WORKFLOW);
  const start = text.indexOf(JOB);
  const rest = start < 0 ? '' : text.slice(start + JOB.length);
  const end = rest.search(/^ {2}[a-z0-9_-]+:$/m);
  const block = end < 0 ? rest : rest.slice(0, end);
  const set = /^\s+ABER_KUBELET_SYNC_FREQUENCY:\s*(\d+)s\s*$/m.exec(block)?.[1];
  const reads = read('scripts/dev-cluster.mjs').includes('process.env.ABER_KUBELET_SYNC_FREQUENCY');
  const said = /kubelet syncs its pods every (\d+) seconds/.exec(read('docs/testing.md'))?.[1];
  const wrong = [];
  if (start < 0) wrong.push(`${WORKFLOW} has no job k8s-validation`);
  else if (!set) wrong.push(`${WORKFLOW}'s k8s-validation job no longer sets ABER_KUBELET_SYNC_FREQUENCY to whole seconds; the extraction no longer matches`);
  if (!reads) wrong.push('scripts/dev-cluster.mjs no longer reads process.env.ABER_KUBELET_SYNC_FREQUENCY, so the job\'s setting reaches no cluster');
  if (!said) wrong.push('docs/testing.md no longer says "kubelet syncs its pods every <n> seconds"; the extraction no longer matches');
  else if (set && said !== set) wrong.push(`${WORKFLOW} sets ABER_KUBELET_SYNC_FREQUENCY to ${set}s and docs/testing.md says every ${said} seconds. Make them agree`);
  if (wrong.length) {
    fail(`k8s-validation's kubelet sync period and what reads and describes it disagree:\n${wrong.map((w) => `        ${w}`).join('\n')}`);
  } else {
    pass(`k8s-validation's kubelet syncs every ${set}s, set in the variable scripts/dev-cluster.mjs reads, as docs/testing.md says`);
  }
}
