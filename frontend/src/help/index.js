/**
 * The help corpus, bundled. One file per page, named by its tab id; `scripts/check-docs-drift.mjs`
 * asserts the correspondence in both directions. Under `frontend/src` rather than `docs/` because
 * the image build context is `./frontend`. Eager, not lazy: the corpus is tens of kilobytes and
 * must work on an air-gapped terminal whose chunk was never fetched.
 */
const files = import.meta.glob('./*.md', { query: '?raw', import: 'default', eager: true })

export const HELP_CORPUS = Object.fromEntries(
  Object.entries(files).map(([path, source]) => [path.replace(/^\.\//, '').replace(/\.md$/, ''), source])
)
