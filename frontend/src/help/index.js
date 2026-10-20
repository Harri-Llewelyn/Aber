/**
 * The help corpus, bundled. One file per page in the repository's top-level help/pages/, named by
 * its tab id; `scripts/check-docs-drift.mjs` asserts the correspondence in both directions. The
 * image build reaches help/ through a named build context, so this path holds in both trees (see
 * frontend/README.md, Contextual help). Eager, not lazy: the corpus is tens of kilobytes and must
 * work on an air-gapped terminal whose chunk was never fetched.
 */
const files = import.meta.glob('../../../help/pages/*.md', { query: '?raw', import: 'default', eager: true })

/** The tab id a glob key names: its file name without `.md`. */
const tabIdOf = (path) => /([^/]+)\.md$/.exec(path)[1]

export const HELP_CORPUS = Object.fromEntries(
  Object.entries(files).map(([path, source]) => [tabIdOf(path), source])
)
