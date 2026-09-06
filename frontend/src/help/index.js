/**
 * The help corpus, bundled (issue #39).
 *
 * ONE FILE PER PAGE, NAMED BY ITS TAB ID, and that is the whole index -- there is no manifest to
 * keep in step with the directory, because a manifest is a second list and the second list is
 * always the stale one. `scripts/check-docs-drift.mjs` asserts the correspondence in both
 * directions: every navigable page in navigation.jsx has a file here, and every file here names a
 * page that exists. A page added without help fails the build; a help file for a page that was
 * renamed fails it too, which is the half nobody remembers to check by hand.
 *
 * WHY IT IS UNDER `frontend/src` AND NOT `docs/`, which is where the roadmap entry proposed it.
 * frontend/Dockerfile's build context is `./frontend` -- on Compose, in release.yml and in the
 * k3d job alike -- so `docs/` is not present at image build time at all, for the same reason
 * `.git` is not. Bundling from there would work on a developer's machine and fail in every
 * container build. The properties the entry actually wanted from `docs/` are unaffected: these
 * are markdown in the repository, reviewed in the pull request that changes the behaviour they
 * describe, and checked by a guard. They are also still free in CI -- ci.yml classifies a diff by
 * `*.md|docs/*`, and a `case` glob's `*` spans directory separators, so editing the corpus skips
 * the two end-to-end stacks wherever the files live.
 *
 * EAGER, NOT LAZY. The whole corpus is a few tens of kilobytes of text and it is wanted at the
 * moment somebody is already lost; a dynamic import would put a network round trip and a spinner
 * between the click and the answer, and would fail entirely on an air-gapped shopfloor terminal
 * whose bundle is cached but whose chunk was never fetched.
 */
const files = import.meta.glob('./*.md', { query: '?raw', import: 'default', eager: true })

export const HELP_CORPUS = Object.fromEntries(
  Object.entries(files).map(([path, source]) => [path.replace(/^\.\//, '').replace(/\.md$/, ''), source])
)

/** The pages the corpus covers, sorted -- used by the tests and by nothing at runtime. */
export const HELP_PAGES = Object.keys(HELP_CORPUS).sort()
