import React from 'react'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { IconX } from '../common/Icons'

/**
 * ==================================================================================================
 * WHAT THE KEYBOARD DOES, LISTED IN ONE PLACE.
 * ==================================================================================================
 *
 * EVERY ROW HERE IS A SHORTCUT THAT EXISTS. That is the only rule this file has and it is the one
 * worth stating, because a shortcuts dialog is the easiest document in an application to write
 * optimistically -- it costs nothing to add a row for a binding somebody intends to implement, and
 * the reader has no way to tell an aspiration from a fact until they press the key and nothing
 * happens. A wrong row here is worse than a missing one: it spends the user's trust in the whole
 * list to save its author a search.
 *
 * So the list is short, and its shortness is accurate rather than a first draft. The application
 * binds four things -- the palette, its two movement keys, its opener -- plus Escape, which twenty-
 * five dialogs honour through one hook, and the standard focus keys the browser provides and this
 * app does not override.
 *
 * THE BROWSER'S OWN KEYS ARE INCLUDED DELIBERATELY, and Tab is the reason. It is the only way to
 * reach the navigation rail without a mouse, and it makes the rail expand -- which is behaviour
 * this application added to a key it did not invent. A reader who does not know Tab reaches the
 * rail cannot discover that from anywhere else.
 *
 * PLAIN STRINGS, NOT A KEY-EVENT MODEL. These are rendered, never matched against -- the bindings
 * themselves live with the components that own them, which is where they can be read beside the
 * behaviour they cause. A registry that both described AND dispatched would be the better design in
 * an app with fifty of them; with five it would be indirection charging rent.
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
        { keys: ['↑', '↓'], description: 'Move through the results' },
        { keys: ['Enter'], description: 'Open the highlighted result' },
        { keys: ['Esc'], description: 'Clear the box and dismiss the results' }
      ]
    },
    {
      title: 'Anywhere',
      items: [
        { keys: ['?'], description: 'Open this list' },
        // One hook, twenty-five dialogs. Worth one row rather than one row per dialog.
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
    <div className="modal-overlay" style={{ zIndex: 1100 }}>
      <div className="modal modal-md" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
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
                      {/* `then`, not `+`, between the two movement keys: they are alternatives.
                          Joining them with a plus would read as a chord nobody can press. */}
                      {i > 0 && <span className="shortcut-join">{item.keys.length === 2 && (key === '↓') ? 'or' : '+'}</span>}
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
