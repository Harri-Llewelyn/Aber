import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 299. The author's guide is where an app's author is sent, and it names no product (0260). The
// security model and the Access Control help page link to it, and it links back to the security
// model. It names no identity provider, sign-in library or tool: an author reads a guide that
// belongs to Aber, whichever they build with.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const guide = read('docs/sign-in-with-aber.md');
  const problems299 = [];
  for (const [file, link] of [
    ['docs/security-model.md', /\]\(sign-in-with-aber\.md\)/],
    ['help/pages/access-control.md', /\]\([./]*docs\/sign-in-with-aber\.md\)/],
  ]) {
    if (!link.test(read(file))) problems299.push(`${file} does not link to the author's guide`);
  }
  if (!guide.includes('(security-model.md#an-apps-token-reaches-only-its-own-routes)')) problems299.push('the guide does not link to the security model section on an app\'s token');
  const PRODUCTS = ['Keycloak', 'Okta', 'Auth0', 'Entra', 'Azure', 'Google', 'GitHub', 'Passport', 'NextAuth', 'Authlib', 'curl', 'Postman', 'Supabase', 'GoTrue', 'Grafana', 'Node-RED', 'Gitea'];
  const words = guide.toLowerCase().match(/[a-z0-9-]+/g) ?? [];
  const named = PRODUCTS.filter((p) => words.includes(p.toLowerCase()));
  if (named.length) problems299.push(`the guide names ${named.join(', ')}; it names no product`);
  if (problems299.length) {
    for (const p of problems299) fail(`the app author's guide: ${p}`);
  } else {
    pass("the app author's guide is linked from the security model and the Access Control help, links back to the security model, and names no product");
  }
}
