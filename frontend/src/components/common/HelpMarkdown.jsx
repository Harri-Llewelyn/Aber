import React from 'react'

/**
 * The smallest Markdown renderer that carries the help corpus: the corpus is written in this
 * repository, so no dependency and no CommonMark. Every branch builds React elements, never
 * `dangerouslySetInnerHTML`, so raw HTML in a help file is text. `scripts/check-docs-drift.mjs`
 * fails the build on any construct outside this subset.
 *
 * Supported: `## Heading` (h3), `### Heading` (h4), `- item`, `1. item`,
 * paragraphs from consecutive lines, **bold**, `code`, and [label](https://...).
 *
 * Links must be absolute http(s): a relative link resolves against the dashboard's routes and 404s,
 * so a non-absolute link renders as its label and the drift check rejects it.
 */

// One pass, one alternation: code first so `**` inside a code span stays literal, then bold, then
// links. Anything that matches nothing is text.
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g

function inline(text, keyPrefix) {
  const out = []
  let last = 0
  let m
  let i = 0
  INLINE.lastIndex = 0
  while ((m = INLINE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const token = m[0]
    const key = `${keyPrefix}-${i++}`
    if (token.startsWith('`')) {
      out.push(<code key={key}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    } else {
      const split = token.indexOf('](')
      const label = token.slice(1, split)
      const href = token.slice(split + 2, -1)
      // Absolute only -- see the header. The label survives either way, so a link that cannot be
      // followed still reads as a sentence rather than leaving a hole in it.
      out.push(
        /^https?:\/\//.test(href)
          ? <a key={key} href={href} target="_blank" rel="noopener noreferrer">{label}</a>
          : <React.Fragment key={key}>{label}</React.Fragment>
      )
    }
    last = m.index + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** Group lines into blocks. Blank lines separate; a list runs until a line that is not an item. */
function blocks(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') { i++; continue }

    const heading = /^(#{2,4})\s+(.*)$/.exec(line)
    if (heading) {
      out.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() })
      i++
      continue
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line)
    const numbered = /^\d+\.\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      const ordered = !bullet
      const items = []
      while (i < lines.length) {
        const item = ordered ? /^\d+\.\s+(.*)$/.exec(lines[i]) : /^[-*]\s+(.*)$/.exec(lines[i])
        if (!item) break
        items.push(item[1].trim())
        i++
      }
      out.push({ kind: 'list', ordered, items })
      continue
    }

    // A paragraph is every line up to the next blank one, joined -- so the source can be wrapped
    // at a readable width without the panel inheriting the wrap points.
    const para = []
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{2,4})\s|^[-*]\s|^\d+\.\s/.test(lines[i])) {
      para.push(lines[i].trim())
      i++
    }
    out.push({ kind: 'para', text: para.join(' ') })
  }
  return out
}

export function HelpMarkdown({ source }) {
  const parsed = blocks(source || '')
  return (
    <div className="help-prose">
      {parsed.map((b, i) => {
        if (b.kind === 'heading') {
          // The drawer title is a <div>, not a heading; `##` renders as h3 and `###` as h4.
          const Tag = b.level === 2 ? 'h3' : 'h4'
          return <Tag key={i}>{inline(b.text, i)}</Tag>
        }
        if (b.kind === 'list') {
          const Tag = b.ordered ? 'ol' : 'ul'
          return (
            <Tag key={i}>
              {b.items.map((item, j) => <li key={j}>{inline(item, `${i}-${j}`)}</li>)}
            </Tag>
          )
        }
        return <p key={i}>{inline(b.text, i)}</p>
      })}
    </div>
  )
}
