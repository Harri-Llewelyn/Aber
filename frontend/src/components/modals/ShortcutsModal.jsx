import React from 'react'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { IconX } from '../common/Icons'

/**
 * What the keyboard does, in one place. Every row is a shortcut that exists; the application binds
 * the palette, its two movement keys and its opener, the Audit Trail drawer's two stepping keys,
 * plus Escape through one hook. The browser's own keys are included because Tab is the only way to
 * reach the navigation rail without a mouse, and it makes the rail expand. Plain strings, never
 * matched against: the bindings live with the components that own them.
 *
 * A row's keys are a chord unless it says `join: 'or'`, in which case they are alternatives.
 */

/** Windows and Linux say Ctrl, macOS says Cmd, and a shortcuts list that says the wrong one is worse than none. */
const isMac = () =>
  typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || '')

export function shortcutGroups({ mac = false } = {}) {
  const mod = mac ? 'Cmd' : 'Ctrl'
  return [
    {
      title: 'Search',
      items: [
        { keys: [mod, 'K'], description: 'Focus the search box from anywhere' },
        { keys: ['↑', '↓'], join: 'or', description: 'Move through the results' },
        { keys: ['Enter'], description: 'Open the highlighted result' },
        { keys: ['Esc'], description: 'Clear the box and dismiss the results' }
      ]
    },
    {
      title: 'Audit Trail',
      items: [
        // Bound by AuditTrailTab, and only while its drawer has a selected event.
        { keys: ['←', '→'], join: 'or', description: 'Step to the previous or next change to the selected asset' }
      ]
    },
    {
      title: 'Anywhere',
      items: [
        { keys: ['?'], description: 'Open this list' },
        // One hook serves every dialog. Worth one row rather than one row per dialog.
        { keys: ['Esc'], description: 'Close the open dialog, drawer or menu' }
      ]
    },
    {
      title: 'Moving without a mouse',
      items: [
        // Not bound by this application -- but the rail's response to it is, and that is the part
        // a reader cannot find out any other way.
        { keys: ['Tab'], description: 'Move to the next control. Reaching the navigation rail expands it' },
        { keys: ['Shift', 'Tab'], description: 'Move to the previous control' },
        { keys: ['Enter'], description: 'Activate the focused control' },
        { keys: ['Space'], description: 'Activate a focused drop zone or chip' }
      ]
    }
  ]
}

export function ShortcutsModal({ onClose }) {
  useEscapeKey(onClose, true)

  const groups = shortcutGroups({ mac: isMac() })

  return (
    /* Closes on a click outside it, which most dialogs here deliberately do not: this one holds no
       input, so there is nothing a stray click could discard. The same pair TelemetryModal uses --
       the overlay closes and the dialog stops the click reaching it. */
    <div className="modal-overlay" style={{ zIndex: 1100 }} onClick={onClose}>
      <div
        className="modal modal-md"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick={e => e.stopPropagation()}
      >
        <div className="modal-header-row">
          <div className="modal-title">Keyboard shortcuts</div>
          <button
            className="alert-pill-close"
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
            title="Close (Esc)"
          >
            <IconX size={13} />
          </button>
        </div>

        {groups.map(group => (
          <div className="shortcut-group" key={group.title}>
            <div className="shortcut-group-title">{group.title}</div>
            {group.items.map(item => (
              <div className="shortcut-row" key={`${group.title}-${item.description}`}>
                <div className="shortcut-keys">
                  {item.keys.map((key, i) => (
                    <React.Fragment key={key}>
                      {/* `or` between alternatives: joining ↑ ↓ or ← → with a plus would read as
                          a chord nobody can press. */}
                      {i > 0 && <span className="shortcut-join">{item.join === 'or' ? 'or' : '+'}</span>}
                      <kbd className="shortcut-key">{key}</kbd>
                    </React.Fragment>
                  ))}
                </div>
                <div className="shortcut-description">{item.description}</div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
