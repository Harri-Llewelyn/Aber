import React, { useEffect, useRef, useState } from 'react'
import { IconCheck, IconCopy } from './Icons'
import { copyText } from './CopyableId'
import { HelpLink, OnlineLink, RepoLink } from './HelpLink'

/**
 * Draws one file of help/ from the token tree frontend/helpCorpus.js parsed it to when the bundle
 * was built. The parser is not in the bundle: this walks plain objects, and every branch builds
 * React elements, never `dangerouslySetInnerHTML`. The types it draws are the ones
 * src/help/syntax.js lists; the build and drift check 108 refuse any other, so the default branches
 * below are unreachable from a bundle built past a green check.
 *
 * Headings carry `id="help-<slug>"` (GitHub's slug, so an anchor that works there works here) and
 * `data-heading="<slug>"`, which the panel scrolls to. A `##` is an h3, one level under the drawer's
 * title. A link to another help file opens it in the panel (HelpLink); a link to the repository or
 * another site opens in a new tab, marked as needing the internet unless it is a local address.
 */

/**
 * An address on the reader's own machine (`http://app.localhost`, the laptop's dashboard), which
 * needs no internet: a new tab, without the online mark.
 */
function isLocal(href) {
  try {
    const host = new URL(href).hostname
    return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]'
  } catch {
    return false
  }
}

const COPIED_MS = 1600
const ALIGN = { left: 'help-align-left', center: 'help-align-center', right: 'help-align-right' }

function CodeBlock({ lang, text }) {
  const [state, setState] = useState(null) // 'copied' | 'failed'
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = async () => {
    const ok = await copyText(text)
    setState(ok ? 'copied' : 'failed')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState(null), COPIED_MS)
  }

  return (
    <div className="help-code">
      <div className="help-code-bar">
        <span className="help-code-lang">{lang}</span>
        <button type="button" className="btn btn-ghost btn-sm help-code-copy" onClick={copy}>
          {state === 'copied' ? <IconCheck size={12} /> : <IconCopy size={12} />}
          {state === 'copied' ? 'Copied' : 'Copy'}
        </button>
        {/* Said, not only shown: the next move is to select the text by hand. */}
        {state === 'failed' && <span className="help-code-error" role="status">Copy was blocked: select the text and copy it.</span>}
      </div>
      {/* Focusable so a keyboard can scroll a long line sideways. */}
      <pre tabIndex={0}><code>{text}</code></pre>
    </div>
  )
}

function inline(nodes, key) {
  return nodes.map((n, i) => {
    const k = `${key}.${i}`
    if (typeof n === 'string') return <React.Fragment key={k}>{n}</React.Fragment>
    switch (n.type) {
      case 'strong': return <strong key={k}>{inline(n.children, k)}</strong>
      case 'em': return <em key={k}>{inline(n.children, k)}</em>
      case 'codespan': return <code key={k}>{n.text}</code>
      case 'br': return <br key={k} />
      case 'link':
        if (n.help) return <HelpLink key={k} to={n.anchor ? `${n.help}#${n.anchor}` : n.help}>{inline(n.children, k)}</HelpLink>
        if (n.repo) return <RepoLink key={k} path={n.repo} anchor={n.anchor}>{inline(n.children, k)}</RepoLink>
        if (isLocal(n.href)) return <a key={k} href={n.href} target="_blank" rel="noopener noreferrer">{inline(n.children, k)}</a>
        return <OnlineLink key={k} href={n.href}>{inline(n.children, k)}</OnlineLink>
      default: return null
    }
  })
}

function blocks(nodes, key) {
  return nodes.map((n, i) => {
    const k = `${key}.${i}`
    switch (n.type) {
      case 'heading': {
        const Tag = `h${Math.min(n.depth + 1, 6)}`
        return <Tag key={k} id={`help-${n.id}`} data-heading={n.id}>{inline(n.children, k)}</Tag>
      }
      case 'paragraph': return <p key={k}>{inline(n.children, k)}</p>
      // A tight list item's text: no paragraph, so the item does not gain a paragraph's margin.
      case 'text': return <React.Fragment key={k}>{inline(n.children, k)}</React.Fragment>
      case 'list': {
        const Tag = n.ordered ? 'ol' : 'ul'
        return <Tag key={k} start={n.start}>{n.items.map((item, j) => <li key={j}>{blocks(item, `${k}.${j}`)}</li>)}</Tag>
      }
      case 'code': return <CodeBlock key={k} lang={n.lang} text={n.text} />
      case 'blockquote': return <blockquote key={k}>{blocks(n.children, k)}</blockquote>
      case 'table':
        return (
          // Focusable so a keyboard can scroll a wide table sideways.
          <div key={k} className="help-table-wrap" tabIndex={0}>
            <table>
              <thead>
                <tr>{n.header.map((cell, j) => <th key={j} className={ALIGN[n.align[j]]}>{inline(cell, `${k}.h${j}`)}</th>)}</tr>
              </thead>
              <tbody>
                {n.rows.map((row, r) => (
                  <tr key={r}>{row.map((cell, j) => <td key={j} className={ALIGN[n.align[j]]}>{inline(cell, `${k}.${r}.${j}`)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      case 'hr': return <hr key={k} />
      default: return null
    }
  })
}

/** One help file's `tokens`, as HELP_FILES carries them. */
export function HelpMarkdown({ tokens }) {
  return <div className="help-prose">{blocks(tokens || [], 'b')}</div>
}
