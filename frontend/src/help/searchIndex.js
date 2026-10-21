import { HELP_FILES, helpTitle } from './index'
import { plainText } from './syntax'

/**
 * Search over everything in help/: each heading, and each block of prose under one (a paragraph, a
 * list item, a table row), keyed by file and heading id. Built from the bundled trees the first
 * time it is asked for, so the corpus's text ships once. The help panel searches it, and so can
 * anything else that opens the panel at a result (openHelpAt). The shapes are in frontend/README.md,
 * Contextual help.
 */

/** Most results a search returns, unless the caller asks for fewer. */
export const HELP_RESULT_LIMIT = 20

/** One file's entries, in reading order: `{ file, page, id, heading, kind, text }`. */
function entriesOf(file, { title, titleId, tokens }) {
  const page = helpTitle(file)
  const out = []
  let section = { id: titleId || '', heading: title || '' }
  const heading = (id, text) => {
    section = { id, heading: text }
    out.push({ file, page, id, heading: text, kind: 'heading', text })
  }
  const prose = (text) => { if (text) out.push({ file, page, ...section, kind: 'text', text }) }
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.type === 'heading') heading(n.id, plainText(n.children))
      else if (n.type === 'paragraph' || n.type === 'text') prose(plainText(n.children))
      else if (n.type === 'list') n.items.forEach(walk)
      else if (n.type === 'blockquote') walk(n.children)
      else if (n.type === 'table') n.rows.forEach((row) => prose(row.map(plainText).filter(Boolean).join(' · ')))
    }
  }
  if (title) heading(titleId, title)
  walk(tokens)
  return out
}

let built = null

/**
 * Every entry in help/: `{ file, page, id, heading, kind, text }`. `file` is a key of HELP_FILES,
 * `id` the heading the entry sits under ('' before the first), `heading` that heading's text,
 * `page` the file's title, `kind` 'heading' or 'text'.
 */
export function helpIndex() {
  built ??= Object.entries(HELP_FILES).flatMap(([file, parsed]) => entriesOf(file, parsed))
  return built
}

/** A text's search terms: lower case, split on anything that is not a letter or a digit. */
export const helpTerms = (text) => String(text).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)

const wordsCache = new WeakMap()
/** An entry's words. Prose is read under its heading, so a heading's words count for it too. */
const wordsOf = (entry) => {
  if (!wordsCache.has(entry)) {
    wordsCache.set(entry, helpTerms(entry.kind === 'text' ? `${entry.heading} ${entry.text}` : entry.text))
  }
  return wordsCache.get(entry)
}

const isWordChar = (c) => /[\p{L}\p{N}]/u.test(c)

/** About `width` characters of `text` around the first place a term starts a word. */
function snippetOf(text, terms, width = 96) {
  const lower = text.toLowerCase()
  let at = -1
  for (const term of terms) {
    for (let i = lower.indexOf(term); i !== -1; i = lower.indexOf(term, i + 1)) {
      if (i === 0 || !isWordChar(lower[i - 1])) { at = at === -1 ? i : Math.min(at, i); break }
    }
  }
  if (text.length <= width) return text
  let start = Math.max(0, at - Math.floor(width / 3))
  while (start > 0 && isWordChar(text[start - 1])) start -= 1
  let end = Math.min(text.length, start + width)
  while (end < text.length && isWordChar(text[end])) end += 1
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`
}

/**
 * The entries every term of `query` starts a word of (prose with its heading's words), one per
 * heading. A heading match ranks above a match in the prose under a heading, and `currentFile`'s
 * entries above another file's, so the order is current headings, other headings, current prose,
 * other prose, each in reading order.
 * Returns `{ file, id, heading, page, kind, snippet }`; `heading` falls back to the page's title
 * before a file's first heading, and `snippet` is the matching prose, or null for a heading.
 */
export function searchHelp(query, { currentFile = null, limit = HELP_RESULT_LIMIT, index = helpIndex() } = {}) {
  const terms = helpTerms(query)
  if (!terms.length) return []
  const best = new Map()
  index.forEach((entry, order) => {
    const words = wordsOf(entry)
    if (!terms.every((term) => words.some((word) => word.startsWith(term)))) return
    const score = (entry.kind === 'heading' ? 2 : 0) + (entry.file === currentFile ? 1 : 0)
    const key = `${entry.file}#${entry.id}`
    if (!best.has(key) || score > best.get(key).score) best.set(key, { entry, score, order })
  })
  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map(({ entry }) => ({
      file: entry.file,
      id: entry.id,
      heading: entry.heading || entry.page,
      page: entry.page,
      kind: entry.kind,
      snippet: entry.kind === 'text' ? snippetOf(entry.text, terms) : null,
    }))
}
