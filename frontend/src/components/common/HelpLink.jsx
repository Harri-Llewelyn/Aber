import React from 'react'
import { IconGlobe } from './Icons'
import { helpFileUrl, repoUrl } from '../../help/links'

/** The text a link's children read as, for the accessible name an online link is given. */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

/**
 * A link that opens the help panel at a file of help/: `to` is its key, with an optional heading,
 * as `guides/tutorial` or `guides/glossary#quarantine`. The panel takes a plain click on any
 * `a[data-help]` (HelpPanel.jsx); the href is the file on GitHub at this release, which a new tab
 * opens and which a bundle without the file falls back to.
 */
export function HelpLink({ to, className, children }) {
  const hash = to.indexOf('#')
  const file = hash === -1 ? to : to.slice(0, hash)
  const anchor = hash === -1 ? null : to.slice(hash + 1)
  return (
    <a className={className} href={helpFileUrl(file, anchor)} data-help={to} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

/**
 * A link out of the dashboard, opened in a new tab. Aber runs on networks with no internet, so it
 * is marked as needing it: a globe and a word a reader can see, and the same in its accessible name.
 */
export function OnlineLink({ href, className, children }) {
  return (
    <a
      className={`online-link${className ? ` ${className}` : ''}`}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${textOf(children)} (online: opens in a new tab and needs the internet)`}
    >
      {children}
      <span className="online-link-mark" aria-hidden="true"><IconGlobe size={10} />online</span>
    </a>
  )
}

/** A repository file on GitHub at the release this bundle was built from, marked as online. */
export function RepoLink({ path, anchor = null, className, children }) {
  return <OnlineLink href={repoUrl(path, anchor)} className={className}>{children}</OnlineLink>
}
