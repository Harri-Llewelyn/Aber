/**
 * What the help panel's renderer draws, and how a heading id and a link in help/ are worked out.
 * One module for the build-time parse (frontend/helpCorpus.js), the walker
 * (components/common/HelpMarkdown.jsx) and scripts/check-docs-drift.mjs (checks 108 and 109), so
 * the three cannot disagree. It imports nothing: the drift check loads it with plain Node.
 */

/** marked's block token types the walker draws. The parse drops `space`. */
export const HELP_BLOCKS = ['heading', 'paragraph', 'text', 'list', 'list_item', 'code', 'blockquote', 'table', 'hr', 'space']

/** marked's inline token types the walker draws. The parse folds `escape` into the text beside it. */
export const HELP_INLINES = ['text', 'escape', 'strong', 'em', 'codespan', 'link', 'br']

/** A construct outside both lists, in the words of the error a contributor sees. */
export function unsupported(type) {
  return {
    image: 'an image: the help panel draws none, so describe what it shows in words',
    html: 'raw HTML: the walker has no HTML sink, so write it in Markdown (or put it in a code span)',
    checkbox: 'a task-list checkbox',
    del: 'strikethrough',
    def: 'a link reference definition: write the link inline',
  }[type] || `a \`${type}\` token`
}

/** An HTML entity in prose, which GitHub draws as its character and the walker would draw as typed. */
export const entityIn = (text) => /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.exec(text)?.[0] ?? null

/**
 * A heading's id, by GitHub's rule (check 1 uses the same): lower case, keep letters, digits,
 * spaces, `_` and `-`, then each space becomes `-`. The panel's ids are these with a `help-`
 * prefix, so a `#anchor` that works on GitHub works in the panel.
 */
export function slugify(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')
}

/** The text a reader sees in a run of the parse's inline nodes, with whitespace collapsed. */
export function plainText(nodes) {
  return nodes.map((n) => (typeof n === 'string' ? n
    : n.type === 'codespan' ? n.text
      : n.type === 'br' ? ' '
        : plainText(n.children || []))).join('').replace(/\s+/g, ' ').trim()
}

/** Ids for one file's headings, in order: a repeated slug gets `-1`, `-2`, as GitHub numbers it. */
export function headingIds() {
  const seen = new Map()
  return (text) => {
    const slug = slugify(text)
    const n = seen.get(slug) || 0
    seen.set(slug, n + 1)
    return n ? `${slug}-${n}` : slug
  }
}

/**
 * Where a link written in help/<from>.md goes. `from` is the file's key, its path under help/ with
 * no `.md` (`guides/tutorial`). A relative link resolves against that file's folder, as GitHub
 * resolves it:
 *   { kind: 'external', href }          another site (any `scheme:` link)
 *   { kind: 'help', file, anchor }      a page of help/, which opens in the panel
 *   { kind: 'repo', path, anchor }      anything else in the repository, which opens on GitHub
 *   { kind: 'invalid', reason }         a link the panel cannot follow
 * `anchor` is the heading id after `#`, or null.
 */
export function resolveLink(from, href) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { kind: 'external', href }
  const hash = href.indexOf('#')
  const path = hash === -1 ? href : href.slice(0, hash)
  let anchor = null
  if (hash !== -1 && hash < href.length - 1) {
    try {
      anchor = decodeURIComponent(href.slice(hash + 1))
    } catch {
      return { kind: 'invalid', reason: `the anchor in \`${href}\` is not valid percent-encoding` }
    }
  }
  if (path === '') return { kind: 'help', file: from, anchor }
  if (path.startsWith('/')) return { kind: 'invalid', reason: `\`${href}\` is absolute: write it relative to this file` }

  const segments = ['help', ...from.split('/').slice(0, -1)]
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part !== '..') segments.push(part)
    else if (segments.length) segments.pop()
    else return { kind: 'invalid', reason: `\`${href}\` climbs out of the repository` }
  }
  if (segments[0] !== 'help') return { kind: 'repo', path: segments.join('/'), anchor }
  if (segments.length === 1) return { kind: 'help', file: 'README', anchor }
  const inside = segments.slice(1).join('/')
  if (!inside.endsWith('.md')) {
    return { kind: 'invalid', reason: `\`${href}\` names help/${inside}, which is not a page: link to a .md file` }
  }
  return { kind: 'help', file: inside.slice(0, -3), anchor }
}
