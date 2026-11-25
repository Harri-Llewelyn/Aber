import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 551. Every Git command an appliance runs names its ref in full.
// Git takes a short name for a tag before a branch, on a remote and in a checkout, and an appliance
// deploys what it fetches and runs its custom.yml as root. So under forge/gateway-platform/ a fetch
// and a push name refs/heads/, what is read afterwards is HEAD, FETCH_HEAD or a commit's id, and
// `clone`, `pull` and Ansible's git module, which take short names, are not used. ansible-pull's
// --checkout is the platform release's tag, in a repository only the machine account writes.
// -------------------------------------------------------------------------------------------------
const ROOT = 'forge/gateway-platform/';
const FLOW_SYNC = `${ROOT}appliance/flow-sync.mjs`;
const BRANCH_REF = 'const branchRef = (branch) => `refs/heads/${branch}`;';
/** Commands that take a short name and choose what they bring in from it. */
const TAKES_SHORT_NAMES = ['clone', 'pull', 'ls-remote', 'switch', 'worktree'];
/** What a command that reads the checkout may name: these, an id held in one of these, or an option. */
const READS = ['show', 'log', 'rev-parse', 'rev-list', 'merge-base', 'checkout', 'reset'];
const NAMED = ["'HEAD'", "'FETCH_HEAD'", "'--'", 'local', 'remote', 'remoteHead', 'root'];

/** The subcommand and what follows it, past Git's own options. */
function parse(words) {
  let i = 0;
  while (i < words.length && /^['"]?-/.test(words[i])) i += /^['"]?-[cC]['"]?$/.test(words[i]) ? 2 : 1;
  return { sub: (words[i] ?? '').replace(/['"]/g, ''), rest: words.slice(i + 1) };
}

export default function check() {
  const problems551 = [];
  let commands = 0;

  const source = read(FLOW_SYNC);
  if (!source.includes(BRANCH_REF)) problems551.push(`${FLOW_SYNC}: no \`${BRANCH_REF}\`, so this check no longer knows what a full name looks like`);
  if (source.split("execFileSync('git'").length !== 2) problems551.push(`${FLOW_SYNC}: Git is run in more than one place; git() is the one this check reads`);
  const calls = [...source.matchAll(/\bgit\(\[([^\]]*)\]/g)].map((m) => m[1].split(',').map((w) => w.trim()).filter(Boolean));
  for (const words of calls) {
    commands += 1;
    const { sub, rest } = parse(words);
    const said = `${FLOW_SYNC}: git ${sub} ${rest.join(' ')}`;
    if (TAKES_SHORT_NAMES.includes(sub)) problems551.push(`${said}: it takes a short name; fetch a full one instead`);
    if (sub === 'fetch' || sub === 'push') {
      const refs = rest.slice(rest.indexOf("'origin'") + 1);
      const full = sub === 'fetch'
        ? (r) => /^branchRef\([A-Za-z_]+\)$/.test(r)
        : (r) => /^`\$\{branchRef\([A-Za-z_]+\)\}:\$\{branchRef\([A-Za-z_]+\)\}`$/.test(r);
      if (!rest.includes("'origin'") || refs.length === 0 || !refs.every(full)) problems551.push(`${said}: name the ref in full, with branchRef()`);
      if (sub === 'fetch' && !rest.includes("'--no-tags'")) problems551.push(`${said}: without --no-tags a fetch can bring tags into the checkout`);
    }
    if (READS.includes(sub)) {
      rest.forEach((word, n) => {
        const branchMade = rest[n - 1] === "'-B'" && word === 'REPORT_BRANCH';
        if (!branchMade && !/^'-/.test(word) && !NAMED.includes(word)) problems551.push(`${said}: ${word} may be a short name; read HEAD, FETCH_HEAD or an id`);
      });
    }
  }
  if (calls.length < 10) problems551.push(`${FLOW_SYNC}: found ${calls.length} Git commands, so this check is no longer reading them`);

  for (const file of allFiles.filter((f) => f.startsWith(ROOT) && !/\.(md|mjs|json)$/.test(f))) {
    const text = read(file).replace(/\r\n/g, '\n').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n').replace(/\\\n\s*/g, ' ');
    if (/^\s*(?:ansible\.builtin\.)?git:\s*$/m.test(text)) problems551.push(`${file}: Ansible's git module takes a short name`);
    for (const [, command] of text.matchAll(/(?:^|[\s;&|({!])git((?:\s+[^\s;&|)}]+)+)/gm)) {
      const words = command.trim().split(/\s+/);
      const { sub, rest } = parse(words);
      if (![...TAKES_SHORT_NAMES, ...READS, 'fetch', 'push'].includes(sub)) continue;
      commands += 1;
      const said = `${file}: git ${words.join(' ')}`;
      if (TAKES_SHORT_NAMES.includes(sub)) problems551.push(`${said}: it takes a short name; fetch a full one instead`);
      if ((sub === 'fetch' || sub === 'push') && !rest.some((w) => /^\+?refs\//.test(w))) problems551.push(`${said}: name the ref in full`);
      if (sub === 'fetch' && !rest.includes('--no-tags')) problems551.push(`${said}: without --no-tags a fetch can bring tags in`);
      if (READS.includes(sub)) {
        for (const word of rest.filter((w) => !/^-/.test(w) && !/^[0-9]*[<>]/.test(w))) {
          if (/^["']?(?:HEAD|FETCH_HEAD|refs\/)/.test(word) || word.includes('/dev/null') || word === '"$bundle"') continue;
          problems551.push(`${said}: ${word} may be a short name; read HEAD, FETCH_HEAD or a full ref`);
        }
      }
    }
  }

  if (problems551.length) {
    fail('a Git command an appliance runs can be answered by a tag:\n' + problems551.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`every Git command an appliance runs names its ref in full (${commands} commands)`);
  }
}
