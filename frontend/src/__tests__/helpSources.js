/**
 * The page help files as raw Markdown, keyed by tab id, for suites that assert on what a page's help
 * says in its source. Test-only: the bundle carries the parsed trees (src/help/index.js), never the
 * source text.
 */
const files = import.meta.glob('../../../help/pages/*.md', { query: '?raw', import: 'default', eager: true })

export const HELP_SOURCES = Object.fromEntries(
  Object.entries(files).map(([path, source]) => [path.slice(path.lastIndexOf('/') + 1, -'.md'.length), source])
)
