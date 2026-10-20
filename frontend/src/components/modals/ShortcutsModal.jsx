import React from 'react'
import { Modal } from '../common/Modal'
import { IconKeyboard } from '../common/Icons'

/**
 * What the keyboard does, in one place. Every row is a shortcut that exists; the application binds
 * the palette, its two movement keys and its opener, `/` for the page's own search box, `[` and `]`
 * for the page's tabs, the Audit Trail drawer's two stepping keys, plus Escape through one hook. The browser's own keys are included because Tab is the only way to
 * reach the navigation rail without a mouse, and it makes the rail expand. Plain strings, never
 * matched against: the bindings live with the components that own them.
 *
 * A row's keys are a chord unless it says `join: 'or'`, in which case they are alternatives. A row
 * with `singleKey` is one the person's Single-key shortcuts setting turns off (shortcuts.js); while
 * it is off, the list says so beside each.
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
        { keys: ['Esc'], description: 'Clear the box and dismiss the results' },
        // Bound in App beside `?`; reaches the SearchInput in the open page's toolbar.
        { keys: ['/'], singleKey: true, description: "Focus this page's search box" }
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
        { keys: ['?'], singleKey: true, description: 'Open this list' },
        // Bound in App beside `?`; reaches the tab bar in the open page (stepPageTab).
        { keys: ['[', ']'], join: 'or', singleKey: true, description: 'Move to the previous or next tab on this page' },
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

/** `singleKeyShortcuts` is the person's setting: false marks the rows it turns off, and says why. */
export function ShortcutsModal({ onClose, singleKeyShortcuts = true }) {
  const groups = shortcutGroups({ mac: isMac() })

  return (
    // Closes on a click outside it: this dialog holds no input, so a stray click discards nothing.
    <Modal
      title="Keyboard shortcuts"
      icon={<IconKeyboard size={18} />}
      size="md"
      layer="confirm"
      closeOnOverlay
      onClose={onClose}
      lead={singleKeyShortcuts ? null : 'Single-key shortcuts are turned off, so the keys marked Off do nothing. Profile › Appearance turns them back on.'}
    >
      {groups.map(group => (
        <div className="shortcut-group" key={group.title}>
          <div className="shortcut-group-title">{group.title}</div>
          {group.items.map(item => (
            <div
              className={`shortcut-row${item.singleKey && !singleKeyShortcuts ? ' shortcut-row-off' : ''}`}
              key={`${group.title}-${item.description}`}
            >
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
              <div className="shortcut-description">
                {item.description}
                {item.singleKey && !singleKeyShortcuts && <span className="badge badge-sm badge-neutral shortcut-off">Off</span>}
              </div>
            </div>
          ))}
        </div>
      ))}
    </Modal>
  )
}
