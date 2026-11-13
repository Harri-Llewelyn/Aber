import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 63b. The machine account's token carries the scopes forge/README.md lists, and no others.
//
// gitea-init.sh mints the token with TOKEN_SCOPES; the README's table says what each scope is for
// and what is refused without it. A scope added to one and not the other is a token wider than
// anyone reviewing the README believes, or a README promising a refusal that no longer happens.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const script = read('scripts/gitea-init.sh');
  const readme = read('forge/README.md');
  const minted = /^TOKEN_SCOPES="([a-z:,]+)"$/m.exec(script)?.[1];
  const said = /^`([a-z:,]+)`, in the order Gitea normalises them to\.$/m.exec(readme)?.[1];
  const section = /^### The scopes\n([\s\S]*?)^### /m.exec(readme)?.[1] ?? '';
  const rows = [...section.matchAll(/^\| `([a-z]+:[a-z]+)` \|/gm)].map((m) => m[1]);
  if (!minted || !said) {
    fail(`check 63b found no TOKEN_SCOPES in scripts/gitea-init.sh (${minted}) or no scope list in forge/README.md (${said})`);
  } else if (minted !== said || [...rows].sort().join(',') !== minted.split(',').sort().join(',')) {
    fail(`the forge token's scopes disagree: gitea-init.sh mints "${minted}", forge/README.md lists ` +
      `"${said}" and its table has rows for ${rows.join(', ') || 'none'}`);
  } else {
    pass(`the forge token is minted with the ${rows.length} scopes forge/README.md lists and explains`);
  }
}
