import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 553. An edge function reads a gateway's repository by object id.
// Both teams write to it, and Gitea's contents, raw, archive and trees calls read a tag named `main`
// for `main` or for no ref, and a branch or a tag NAMED as a commit's id ahead of the commit
// (measured). fileAtCommit() in _shared/forge.ts finds a file through git/trees and git/blobs, and
// branchHead() asks the branches call. The platform organisation's repositories are the machine
// account's alone, so they may be read by name.
// -------------------------------------------------------------------------------------------------
const FORGE = 'supabase/functions/_shared/forge.ts';

export default function check() {
  const problems553 = [];
  const files = allFiles.filter((f) => f.startsWith('supabase/functions/') && f.endsWith('.ts') && !/_test\.ts$|\.generated\.ts$/.test(f));
  let paths = 0;
  for (const file of files) {
    const source = read(file).replace(/\r\n/g, '\n');
    for (const match of source.matchAll(/`\/repos\/\$\{FORGE_ORGANISATION\}[^`]*`/g)) {
      paths += 1;
      const path = match[0];
      const line = source.slice(0, match.index).split('\n').length;
      const reads = source.slice(0, match.index).trimEnd().endsWith('"GET",');
      if (/[?&]ref=|\/raw\/|\/archive\/|\/git\/trees\/|[?&]sha=/.test(path) || (reads && path.includes('/contents/'))) {
        problems553.push(`${file}:${line}: ${path} reads a gateway's repository by a name somebody else can take. Use fileAtCommit().`);
      }
    }
    if (file !== FORGE && /\/(?:raw|contents|archive)\/[^`"']*\?ref=/.test(source)) {
      problems553.push(`${file}: a file is read at a ref by name. Use fileAtCommit().`);
    }
  }
  if (!read(FORGE).includes('export async function fileAtCommit(')) problems553.push(`${FORGE} has no fileAtCommit()`);
  if (paths < 10) problems553.push(`found ${paths} paths under the gateways' organisation, so this check is no longer reading them`);

  if (problems553.length) {
    fail("an edge function reads a gateway's repository by a name a person can take:\n" + problems553.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`every read of a gateway's repository is by object id (${paths} paths under its organisation)`);
  }
}
