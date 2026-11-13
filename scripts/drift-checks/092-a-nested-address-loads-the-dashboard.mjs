import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 92. A nested address loads the dashboard.
//
// A page's tab is the second path segment (`/devices/quarantine`, frontend/README.md Routing), so a
// reload or a pasted link asks the server for a path no file has. That works only while nginx
// answers any path with index.html and every URL index.html loads is absolute: a relative one
// resolves under `/devices/` and fetches the page's HTML in place of the script.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const NGINX = 'frontend/nginx.conf';
  const INDEX = 'frontend/index.html';
  const VITE = 'frontend/vite.config.js';
  const fallback = /location \/ \{[^}]*try_files \$uri \$uri\/ \/index\.html;/.test(read(NGINX));
  // Comments are blanked, as check 49 does, not removed: what is left cannot close up into a new one.
  // <!-{2} and -{2}>, not the markers: Semgrep's parser, not Node, reads a regex opening with one as a comment.
  const uncommented = read(INDEX).replace(/<!-{2}[\s\S]*?-{2}>/g, (c) => c.replace(/[^\n]/g, ' '));
  const relative = [...uncommented.matchAll(/\s(?:src|href)="([^"]*)"/g)]
    .map((m) => m[1])
    .filter((url) => !url.startsWith('/') && !/^[a-z]+:/i.test(url));
  const base = /^\s*base:\s*['"]([^'"]*)['"]/m.exec(read(VITE));

  if (!fallback) {
    fail(
      `${NGINX}: \`location /\` no longer answers an unknown path with index.html (try_files).\n` +
        '      A reload of /devices/quarantine, or any shared link to a tab, would be a 404.'
    );
  }
  if (relative.length) {
    fail(
      `${INDEX} loads ${relative.join(', ')} by a relative URL.\n` +
        '      Under /devices/quarantine it resolves to /devices/..., which nginx answers with\n' +
        '      index.html. Make it absolute (start it with /).'
    );
  }
  if (base && base[1] !== '/') {
    fail(
      `${VITE} sets base to ${JSON.stringify(base[1])}; the bundle's asset URLs must stay absolute (\`/\`)\n` +
        '      for a nested address such as /devices/quarantine to load.'
    );
  }
  if (fallback && !relative.length && (!base || base[1] === '/')) {
    pass('a nested address loads: nginx answers any path with index.html, and index.html and the bundle load by absolute URLs');
  }
}
