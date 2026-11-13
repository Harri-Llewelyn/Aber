import { compare, lastDefinition, need, problems, read } from './lib.mjs';

// 16. A pinned machine identity's name and renewal, JavaScript to SQL. The Access Control page names
// the pinned identities from KNOWN_PRINCIPALS; service_token_health_rows() names them for the
// Service Token Expiring alert, and says which renew with `npm run keys:rotate`, the identities whose
// mintCommand is that. Apart, the alert names an identity the page does not list under that name,
// or tells an Administrator to issue a token the page does not offer.
export default function check() {
  const js = read('frontend/src/utils/serviceIdentities.js');
  const block = need(js, /export const KNOWN_PRINCIPALS = \{([\s\S]*?)\n\}/, 'KNOWN_PRINCIPALS in serviceIdentities.js');
  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.service_token_health_rows()', '$$;',
    'public.service_token_health_rows()');
  if (block && fn) {
    const jsRows = [...block[1].matchAll(/'([0-9a-f-]{36})': \{\s*name: '([^']+)'[\s\S]*?mintCommand: '([^']+)'/g)]
      .map((m) => `${m[1]} ${m[2]} ${m[3] === 'npm run keys:rotate' ? 'keys_rotate' : 'access_control'}`);
    const sqlRows = [...fn.body.matchAll(/\('([0-9a-f-]{36})'::uuid, '([^']+)', '(\w+)'\)/g)]
      .map((m) => `${m[1]} ${m[2]} ${m[3]}`);
    if (jsRows.length === 0 || sqlRows.length === 0) {
      problems.push(`pinnedIdentities: found no pinned identity in ${jsRows.length ? fn.file : 'KNOWN_PRINCIPALS'} -- the shape changed, so this check is no longer checking anything`);
    } else {
      compare('pinnedIdentities', `name and renewal of each pinned identity, from ${fn.file}`,
        jsRows.sort().join('; '), sqlRows.sort().join('; '));
    }
  }
}
