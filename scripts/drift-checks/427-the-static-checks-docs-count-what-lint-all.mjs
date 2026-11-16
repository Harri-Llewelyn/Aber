import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 427. The pages that count the static checks count what scripts/lint-all.mjs runs, and the pages
// that name the ShellCheck image name the one scripts/lint-sh.mjs pins. docs/static-analysis.md,
// docs/testing.md, CONTRIBUTING.md and the static-analysis job's comment in ci.yml each say how many
// checks there are, written as a word, and CI runs all but the secret scan, which its own job runs.
// `npm run lint:sh` runs lint-sh.mjs. The page names the image tag and the version in its table.
// -------------------------------------------------------------------------------------------------
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen'];

export default function check() {
  const problems427 = [];
  const checks = [...read('scripts/lint-all.mjs').matchAll(/^\s*\['([a-z]+)', '[^']+\.mjs', /gm)].map((m) => m[1]);
  if (!checks.includes('sh') || !checks.includes('secrets')) problems427.push("scripts/lint-all.mjs does not run 'sh' and 'secrets'");
  const all = WORDS[checks.length];
  const others = WORDS[checks.length - 1];

  const claims = [
    ['docs/static-analysis.md', /^(\w+) checks read the source/m, all],
    ['docs/static-analysis.md', /# all (\w+), one after another/, all],
    ['docs/static-analysis.md', /CI runs all (\w+) on a clean/, all],
    ['docs/static-analysis.md', /runs the other (\w+) with `node scripts\/lint-all\.mjs --skip=secrets`/, others],
    ['docs/testing.md', /\| \*\*static-analysis\*\* \| The other (\w+) checks of /, others],
    ['CONTRIBUTING.md', /`npm run lint` runs all (\w+);/, all],
    ['.github/workflows/ci.yml', /# The other (\w+) checks in docs\/static-analysis\.md/, others],
  ];
  for (const [file, pattern, want] of claims) {
    const said = read(file).match(pattern)?.[1]?.toLowerCase();
    if (!said) problems427.push(`${file} does not say how many static checks there are, where this check looks`);
    else if (said !== want) problems427.push(`${file} says ${said} static checks, and scripts/lint-all.mjs runs ${checks.length} (${all}; ${others} without the secret scan)`);
  }
  if (!/--skip=secrets/.test(read('.github/workflows/ci.yml'))) problems427.push('the static-analysis job in ci.yml does not run lint-all.mjs with --skip=secrets');

  const scripts = JSON.parse(read('package.json')).scripts;
  if (scripts['lint:sh'] !== 'node scripts/lint-sh.mjs') problems427.push("package.json's lint:sh does not run scripts/lint-sh.mjs");

  const image = read('scripts/lint-sh.mjs').match(/IMAGE = '(koalaman\/shellcheck:v(\d+\.\d+\.\d+))'/);
  if (!image) problems427.push('scripts/lint-sh.mjs pins no koalaman/shellcheck image tag');
  else {
    const page = read('docs/static-analysis.md');
    if (!page.includes(`\`${image[1]}\``)) problems427.push(`docs/static-analysis.md does not name the pinned image ${image[1]}`);
    if (!page.includes(`| \`lint:sh\` | ShellCheck ${image[2]} |`)) problems427.push(`docs/static-analysis.md's table does not name ShellCheck ${image[2]}`);
    if (!page.includes(`runs ShellCheck ${image[2]} from the pinned image`)) problems427.push(`docs/static-analysis.md's section does not say it runs ShellCheck ${image[2]}`);
  }

  if (problems427.length) {
    for (const p of problems427) fail(`the static checks' pages disagree with the scripts: ${p}`);
  } else {
    pass(`${checks.length} static checks (${others} in CI's job, with the secret scan in its own), counted alike by docs/static-analysis.md, docs/testing.md, CONTRIBUTING.md and ci.yml, and the ShellCheck image ${image[1]} named as lint-sh.mjs pins it`);
  }
}
