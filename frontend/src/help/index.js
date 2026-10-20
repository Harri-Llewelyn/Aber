import { TABS } from '../navigation'

/**
 * The help corpus, bundled: every Markdown file in the repository's top-level help/, as the token
 * tree frontend/helpCorpus.js parses it to when the bundle is built (the `?help` query). A file's
 * key is its path under help/ without `.md`: `README` (the contents), `guides/tutorial`,
 * `pages/<tab id>`, `site/install`. `scripts/check-docs-drift.mjs` holds the page files to the
 * pages, and the contents to the folder. The image build reaches help/ through a named build
 * context, so this path holds in both trees (see frontend/README.md, Contextual help). Eager, not
 * lazy: the corpus must work on an air-gapped terminal whose chunk was never fetched.
 */
const files = import.meta.glob('../../../help/**/*.md', { query: '?help', import: 'default', eager: true })

/** A glob key's file key: the part after `help/`, without `.md`. */
const keyOf = (path) => path.slice(path.lastIndexOf('/help/') + '/help/'.length, -'.md'.length)

/** `{ [file]: { title, titleId, tokens } }`. */
export const HELP_FILES = Object.fromEntries(Object.entries(files).map(([path, parsed]) => [keyOf(path), parsed]))

/** The file the contents view draws. */
export const CONTENTS_FILE = 'README'

/** The help file for a page of the dashboard. */
export const pageHelpFile = (tabId) => `pages/${tabId}`

/**
 * What a file is called: its leading `# ` heading, or for a page file the page's own name, as the
 * sidebar shows it. A page file has no title of its own because the drawer already names the page.
 */
export function helpTitle(file) {
  const parsed = HELP_FILES[file]
  if (parsed?.title) return parsed.title
  const tab = file.startsWith('pages/') ? TABS.find((t) => t.id === file.slice('pages/'.length)) : null
  return tab ? tab.label : file
}
