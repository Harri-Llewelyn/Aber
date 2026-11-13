import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 2b. The component table names every chart component, and only real ones. Both directions:
// check 2 matches rows one way and cannot see a row for a retired component or a live one with
// no row. Components are the `$component := "name"` declarations the templates open with.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const components = new Set();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.yaml')) {
        for (const m of readFileSync(f, 'utf8').matchAll(/\$component\s*:=\s*"([a-z0-9-]+)"/g)) components.add(m[1]);
      }
    }
  };
  walk(join(REPO, 'deploy/helm/aber/templates'));

  const readme = read('docs/architecture.md');
  const section = readme.slice(readme.indexOf('## Components'));
  const table = section.slice(0, section.indexOf('\n---'));
  const listed = new Set();
  for (const [, name] of table.matchAll(/^\|\s*`([a-z0-9][a-z0-9._-]*)`\s*\|/gm)) listed.add(name);

  if (components.size === 0 || listed.size === 0) {
    fail('component table check could not parse the chart templates or the docs/architecture.md table');
  } else {
    const ghosts = [...listed].filter((n) => !components.has(n));
    const missing = [...components].filter((n) => !listed.has(n));
    if (ghosts.length) {
      fail(
        `docs/architecture.md's component table names ${ghosts.length} component(s) the chart does not ` +
        `declare: ${ghosts.join(', ')}. A row naming a dead component still passes the image-tag ` +
        `check whenever the image survives it.`
      );
    }
    if (missing.length) {
      fail(
        `the chart declares ${missing.length} component(s) docs/architecture.md's component table ` +
        `omits: ${missing.join(', ')}. The table is the answer to "what runs here", so an absent ` +
        `row is a component nobody reading the docs knows about.`
      );
    }
    if (!ghosts.length && !missing.length) {
      pass(`the component table matches the chart in both directions (${components.size} components)`);
    }
  }
}
