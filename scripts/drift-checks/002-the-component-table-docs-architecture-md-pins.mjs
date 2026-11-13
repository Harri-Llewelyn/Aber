import { chartPins, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 2. The component table (docs/architecture.md) pins the same image tags the chart does. The chart's values are
// parsed by shape: a `repository:` line followed by its `tag:` line, comments between allowed.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const readme = read('docs/architecture.md');
  let checked = 0;
  for (const [, repo, tag] of readme.matchAll(/\|\s*`([a-z0-9][a-z0-9./_-]*):([^`|]+)`\s*\|/g)) {
    if (!chartPins.has(repo)) continue;
    checked += 1;
    if (chartPins.get(repo) !== tag) {
      fail(`docs/architecture.md image tag drift: ${repo} documented as :${tag}, values.yaml pins :${chartPins.get(repo)}`);
    }
  }
  // An image in the table with NO tag is drift too -- it reads as "unpinned" when it is pinned.
  for (const repo of chartPins.keys()) {
    if (readme.includes(`\`${repo}\``) && !readme.includes(`\`${repo}:`)) {
      fail(`docs/architecture.md lists \`${repo}\` with no tag, but values.yaml pins :${chartPins.get(repo)}`);
    }
  }
  if (checked) pass(`component table image tags agree with the chart (${checked} checked)`);
  else fail('docs/architecture.md names none of the images the chart pins; the component table is missing');
}
