import { existsSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { marked } from 'marked'
import { HELP_BLOCKS, HELP_INLINES, entityIn, headingIds, plainText, resolveLink, unsupported } from './src/help/syntax.js'

/**
 * The help corpus, parsed when the bundle is built. src/help/index.js globs help/ with the `?help`
 * query, and this plugin answers each such import with the file as a token tree that the walker
 * (src/components/common/HelpMarkdown.jsx) draws. marked runs here, in Node, and never reaches the
 * bundle. A construct the walker cannot draw, or a link the panel cannot follow, fails the build
 * (and `npm run dev`, and vitest) with the file and line.
 *
 * help/ is beside this package in a checkout and in the image (frontend/Dockerfile copies the named
 * context to /app/help), so the one path holds in both.
 */
export const HELP_ROOT = resolve(import.meta.dirname, '../help')

/**
 * One file of help/:
 *   title    the text of a leading `# ` heading, or null (the page files have none)
 *   titleId  that heading's id: a link to it opens the file at the top
 *   tokens   block nodes, pruned to what the walker needs (shapes: frontend/README.md, Contextual help)
 *   ids      every heading id, for the link check
 *   links    every link, resolved, for the link check
 * `file` is the key the app uses: the path under help/ without `.md`. Only the first three ship.
 */
export function parseHelp(source, file) {
  const nextId = headingIds()
  const ids = []
  const links = []
  let title = null
  let titleId = null

  const lineOf = (raw) => {
    const at = raw ? source.indexOf(raw) : -1
    return at < 0 ? '' : `:${source.slice(0, at).split('\n').length}`
  }
  const refuse = (token, what) => {
    throw new Error(`help/${file}.md${lineOf(token.raw)}: ${what}. The help panel draws only what `
      + 'frontend/src/help/syntax.js lists (frontend/README.md, Contextual help).')
  }

  const inline = (tokens = []) => {
    const out = []
    for (const t of tokens) {
      if (!HELP_INLINES.includes(t.type)) refuse(t, unsupported(t.type))
      if (t.type === 'text' || t.type === 'escape') {
        const entity = entityIn(t.text)
        if (entity) refuse(t, `an HTML entity, ${entity}: type the character itself`)
        // A line break inside a paragraph is a space: the source wraps where the panel need not.
        const text = t.text.replace(/\n/g, ' ')
        if (typeof out[out.length - 1] === 'string') out[out.length - 1] += text
        else out.push(text)
      } else if (t.type === 'strong' || t.type === 'em') {
        out.push({ type: t.type, children: inline(t.tokens) })
      } else if (t.type === 'codespan') {
        out.push({ type: 'codespan', text: t.text })
      } else if (t.type === 'br') {
        out.push({ type: 'br' })
      } else {
        const target = resolveLink(file, t.href)
        if (target.kind === 'invalid') refuse(t, `a link the panel cannot follow: ${target.reason}`)
        links.push({ ...target, raw: t.raw })
        const to = target.kind === 'external' ? { href: target.href }
          : target.kind === 'help' ? { help: target.file, anchor: target.anchor }
            : { repo: target.path, anchor: target.anchor }
        out.push({ type: 'link', ...to, children: inline(t.tokens) })
      }
    }
    return out
  }

  const blocks = (tokens = [], top = false) => {
    const out = []
    let leading = top
    for (const t of tokens) {
      if (!HELP_BLOCKS.includes(t.type) || t.type === 'list_item') refuse(t, unsupported(t.type))
      if (t.type === 'space') continue
      const first = leading
      leading = false
      if (t.type === 'heading') {
        const children = inline(t.tokens)
        const id = nextId(plainText(children))
        ids.push(id)
        // The drawer's own title shows a leading `# `, so the tree does not repeat it.
        if (first && t.depth === 1) {
          title = plainText(children)
          titleId = id
        } else {
          out.push({ type: 'heading', depth: t.depth, id, children })
        }
      } else if (t.type === 'paragraph' || t.type === 'text') {
        out.push({ type: t.type, children: inline(t.tokens || [{ type: 'text', text: t.text, raw: t.raw }]) })
      } else if (t.type === 'list') {
        out.push({
          type: 'list',
          ordered: t.ordered,
          start: t.ordered && t.start !== 1 ? t.start : undefined,
          items: t.items.map((item) => {
            if (item.task) refuse(item, unsupported('checkbox'))
            return blocks(item.tokens)
          }),
        })
      } else if (t.type === 'code') {
        out.push({ type: 'code', lang: t.lang || '', text: t.text })
      } else if (t.type === 'blockquote') {
        out.push({ type: 'blockquote', children: blocks(t.tokens) })
      } else if (t.type === 'table') {
        out.push({
          type: 'table',
          align: t.align,
          header: t.header.map((cell) => inline(cell.tokens)),
          rows: t.rows.map((row) => row.map((cell) => inline(cell.tokens))),
        })
      } else {
        out.push({ type: 'hr' })
      }
    }
    return out
  }

  const tokens = blocks(marked.lexer(source), true)
  return { title, titleId, tokens, ids, links }
}

/**
 * Vite plugin: answers `help/**.md?help` with `export default { title, titleId, tokens }`, after
 * checking that every link into help/ names a file and a heading that exist.
 */
export function helpCorpus() {
  const parsed = new Map()
  const parseAt = (path) => {
    const { mtimeMs } = statSync(path)
    const hit = parsed.get(path)
    if (hit?.mtimeMs === mtimeMs) return hit.result
    const file = relative(HELP_ROOT, path).split(sep).join('/').slice(0, -'.md'.length)
    const result = parseHelp(readFileSync(path, 'utf8'), file)
    parsed.set(path, { mtimeMs, result })
    return result
  }

  return {
    name: 'help-corpus',
    enforce: 'pre',
    load(id) {
      const [path, query = ''] = id.split('?')
      if (!new URLSearchParams(query).has('help')) return null
      const file = relative(HELP_ROOT, path).split(sep).join('/')
      if (file.startsWith('../') || !file.endsWith('.md')) throw new Error(`?help imports a page of help/ only, not ${path}`)
      this.addWatchFile(path)
      const result = parseAt(path)
      for (const link of result.links.filter((l) => l.kind === 'help')) {
        const target = resolve(HELP_ROOT, `${link.file}.md`)
        if (!existsSync(target)) throw new Error(`help/${file}: ${link.raw} names help/${link.file}.md, which does not exist`)
        this.addWatchFile(target)
        if (link.anchor && !parseAt(target).ids.includes(link.anchor)) {
          throw new Error(`help/${file}: ${link.raw} names no heading in help/${link.file}.md`)
        }
      }
      const { title, titleId, tokens } = result
      return { code: `export default ${JSON.stringify({ title, titleId, tokens })}`, moduleType: 'js', map: null }
    },
  }
}
