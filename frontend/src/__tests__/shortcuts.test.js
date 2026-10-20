/**
 * The one check every document-wide shortcut makes (shortcuts.js), and the tab step `[` and `]`
 * take. What would go wrong quietly: AltGr read as Ctrl+Alt, so `[` and `]` never work on a German,
 * French or Nordic layout; a native `<dialog>` missed, so a key reaches the page behind it; and the
 * setting failing to cover one of the four single-key shortcuts.
 */
import { afterEach, describe, expect, it } from 'vitest'

import {
  OPEN_DIALOG_SELECTOR, SINGLE_KEY_SHORTCUTS, commandModifierHeld, dialogIsOpen, isEditableTarget,
  shortcutAllowed, singleKeyShortcutAllowed, stepPageTab,
} from '../shortcuts'

const key = (init = {}, target = document.body) => {
  const e = new KeyboardEvent('keydown', { key: '[', bubbles: true, cancelable: true, ...init })
  Object.defineProperty(e, 'target', { value: target })
  return e
}

afterEach(() => { document.body.innerHTML = '' })

describe('the modifier check', () => {
  it('stands down for Ctrl, Cmd and Alt', () => {
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
      expect(commandModifierHeld(key({ [modifier]: true })), modifier).toBe(true)
    }
    expect(commandModifierHeld(key())).toBe(false)
  })

  it('lets AltGr through, which Windows reports as Ctrl+Alt', () => {
    const altGr = key({ key: ']', ctrlKey: true, altKey: true, modifierAltGraph: true })
    expect(altGr.getModifierState('AltGraph')).toBe(true)
    expect(commandModifierHeld(altGr)).toBe(false)
    expect(shortcutAllowed(altGr)).toBe(true)
  })

  it('does not let Cmd through with AltGr', () => {
    expect(commandModifierHeld(key({ metaKey: true, modifierAltGraph: true }))).toBe(true)
  })

  it('ignores Shift, which a layout may need to type the character', () => {
    expect(shortcutAllowed(key({ key: '?', shiftKey: true }))).toBe(true)
  })
})

describe('the target check', () => {
  it('stands down in a field, a textarea, a select and contenteditable', () => {
    document.body.innerHTML = '<input id="a"><textarea id="b"></textarea><select id="c"></select><div id="d" contenteditable="true"></div>'
    for (const id of ['a', 'b', 'c']) {
      expect(isEditableTarget(document.getElementById(id)), id).toBe(true)
      expect(shortcutAllowed(key({}, document.getElementById(id))), id).toBe(false)
    }
    // jsdom does not compute isContentEditable, so the property is what is read.
    const editable = document.getElementById('d')
    Object.defineProperty(editable, 'isContentEditable', { value: true })
    expect(isEditableTarget(editable)).toBe(true)
  })

  it('acts from the page itself and from a button', () => {
    document.body.innerHTML = '<button id="b">Tab</button>'
    expect(shortcutAllowed(key())).toBe(true)
    expect(shortcutAllowed(key({}, document.getElementById('b')))).toBe(true)
  })
})

describe('the dialog check', () => {
  it("sees the shared frame, a popover and a native <dialog> opened with showModal()", () => {
    expect(OPEN_DIALOG_SELECTOR).toContain('dialog[open]')
    for (const html of ['<div role="dialog"></div>', '<div aria-modal="true"></div>', '<dialog open></dialog>']) {
      document.body.innerHTML = html
      expect(dialogIsOpen(), html).toBe(true)
      expect(shortcutAllowed(key()), html).toBe(false)
    }
  })

  it('does not count a closed <dialog>', () => {
    document.body.innerHTML = '<dialog></dialog>'
    expect(dialogIsOpen()).toBe(false)
  })
})

describe('the single-key setting', () => {
  it('covers ?, /, [ and ] and nothing else', () => {
    expect(SINGLE_KEY_SHORTCUTS).toEqual(['?', '/', '[', ']'])
    for (const k of SINGLE_KEY_SHORTCUTS) {
      expect(singleKeyShortcutAllowed(key({ key: k }), true), k).toBe(true)
      expect(singleKeyShortcutAllowed(key({ key: k }), false), k).toBe(false)
    }
    expect(singleKeyShortcutAllowed(key({ key: 'k' }), true)).toBe(false)
  })

  it('still stands down where every shortcut does', () => {
    document.body.innerHTML = '<div role="dialog"></div>'
    expect(singleKeyShortcutAllowed(key(), true)).toBe(false)
  })
})

describe('stepPageTab', () => {
  const tabBar = (selected, { inMain = true, count = 3 } = {}) => {
    const tabs = Array.from({ length: count }, (_, i) =>
      `<a href="/page/t${i}" id="t${i}"${i === selected ? ' aria-current="page"' : ''}>Tab ${i}</a>`).join('')
    const bar = `<nav class="tab-strip"><div class="tab-strip-tabs">${tabs}</div></nav>`
    document.body.innerHTML = inMain ? `<main>${bar}</main>` : `<header>${bar}</header><main></main>`
    const clicks = []
    // The page's own handler: a plain click stays in the page.
    for (const t of document.querySelectorAll('.tab-strip a')) t.addEventListener('click', (e) => { e.preventDefault(); clicks.push(t.id) })
    return clicks
  }

  it('clicks and focuses the next or previous tab', () => {
    const clicks = tabBar(1)
    expect(stepPageTab(1)).toBe(true)
    expect(clicks).toEqual(['t2'])
    expect(document.activeElement.id).toBe('t2')
    expect(stepPageTab(-1)).toBe(true)
    // The selection has not moved in this stand-in, so back from the second tab is the first.
    expect(clicks).toEqual(['t2', 't0'])
    expect(document.activeElement.id).toBe('t0')
  })

  it('stops at the first and the last tab', () => {
    let clicks = tabBar(0)
    expect(stepPageTab(-1)).toBe(false)
    clicks = tabBar(2)
    expect(stepPageTab(1)).toBe(false)
    expect(clicks).toEqual([])
  })

  it('does nothing without a tab bar in main', () => {
    const clicks = tabBar(0, { inMain: false })
    expect(stepPageTab(1)).toBe(false)
    expect(clicks).toEqual([])
    document.body.innerHTML = '<main><p>No tabs</p></main>'
    expect(stepPageTab(1)).toBe(false)
  })

  it('skips a hidden tab bar for the one shown', () => {
    document.body.innerHTML = '<main><div hidden><nav class="tab-strip"><a href="/a" aria-current="page">A</a><a href="/b" id="hiddenB">B</a></nav></div>'
      + '<nav class="tab-strip"><a href="/c" aria-current="page">C</a><a href="/d" id="shownD">D</a></nav></main>'
    for (const a of document.querySelectorAll('a')) a.addEventListener('click', e => e.preventDefault())
    expect(stepPageTab(1)).toBe(true)
    expect(document.activeElement.id).toBe('shownD')
  })
})
