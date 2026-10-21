import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ContextPanel } from './ContextPanel'
import { HelpBrowser, PAGE_VIEW, plainClick, useHelpHistory, viewTitle } from './HelpBrowser'
import { Modal, topDialog } from './Modal'
import { IconHelp } from './Icons'
import { helpTarget, onHelpRequest } from '../../help/openHelp'

/**
 * Help, in the same ContextPanel drawer the pages use. It sits in `.app-body` as a sibling of
 * `.content`, not inside the page, so a tab switch cannot unmount it and it works on pages with no
 * drawer of their own. From 1440px wide it opens beside a page's drawer. Narrower, it replaces it:
 * the page's drawer is hidden, not closed, until help closes, and a page's drawer that opens or
 * changes subject closes help (`ONE_DRAWER_QUERY` in ContextPanel.jsx).
 *
 * It opens on the current page's help (the top bar's ?) or wherever it is sent: `openHelpAt()`, or
 * a plain click on any `a[data-help]` outside it. While a dialog is open the page behind it is
 * inert, so then the help opens in a dialog of its own over that one. `onOpen` asks the App to open
 * the drawer. Closing forgets the history, so the ? always starts on the page's help.
 */
export function HelpPanel({ open, tabId, onClose, onOpen }) {
  const history = useHelpHistory()
  const { go, reset } = history
  const [dialog, setDialog] = useState(null)
  const shown = useRef({ open, onOpen })
  shown.current = { open, onOpen }

  useEffect(() => { if (!open) reset(PAGE_VIEW) }, [open, reset])

  useEffect(() => {
    let opened = 0
    const show = (target) => {
      if (topDialog()) {
        opened += 1
        setDialog({ ...target, key: opened })
        return
      }
      const view = { kind: 'file', ...target }
      if (shown.current.open) go(view)
      else reset(view)
      shown.current.onOpen?.()
    }
    const onClick = (e) => {
      if (!plainClick(e)) return
      const link = e.target.closest?.('a[data-help]')
      const target = link && helpTarget(link.getAttribute('data-help'))
      // A file this bundle does not carry: the link's href, on GitHub, is the fallback.
      if (!target) return
      e.preventDefault()
      show(target)
    }
    document.addEventListener('click', onClick)
    const unsubscribe = onHelpRequest(show)
    return () => {
      document.removeEventListener('click', onClick)
      unsubscribe()
    }
  }, [go, reset])

  /* The drawer stays mounted (ContextPanel needs the width transition) but its contents do not: the
     title is a <div> holding the page name, and left mounted while closed the prose would put a
     second copy of it into the document for find-in-page and for tests. */
  return (
    <>
      <ContextPanel
        open={open}
        title={open ? viewTitle(history.view, tabId) : ''}
        /* The subtitle says what kind of thing the panel is showing; the title is what it shows. */
        subtitle="Documentation and Guide"
        subject="help"
        className="context-panel-app"
        onClose={onClose}
      >
        {open ? <HelpBrowser history={history} tabId={tabId} /> : null}
      </ContextPanel>
      {dialog && createPortal(
        <HelpDialog key={dialog.key} target={dialog} tabId={tabId} onClose={() => setDialog(null)} />,
        document.body
      )}
    </>
  )
}

/** Help over an open dialog: the panel's browser in a dialog of its own, on top of the other. */
function HelpDialog({ target, tabId, onClose }) {
  const history = useHelpHistory({ kind: 'file', file: target.file, anchor: target.anchor })
  return (
    <Modal title={viewTitle(history.view, tabId)} icon={<IconHelp size={18} />} size="lg" onClose={onClose} closeOnOverlay>
      <HelpBrowser history={history} tabId={tabId} />
    </Modal>
  )
}
