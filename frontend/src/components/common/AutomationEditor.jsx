/*!
 * The automation editor is CodeMirror 6 and Lezer (https://codemirror.net, https://lezer.codemirror.net),
 * by Marijn Haverbeke and others, under the MIT licence below. The packages it uses, with the
 * copyright each states, and what they bring with them (NOTICE.md lists them):
 *
 *   @codemirror/state, view, language, commands, autocomplete, lint, streamparser:
 *     Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others
 *   @codemirror/lang-yaml:
 *     Copyright (C) 2024 by Marijn Haverbeke <marijn@haverbeke.berlin> and others
 *   @lezer/common, highlight, lr:
 *     Copyright (C) 2018 by Marijn Haverbeke <marijn@haverbeke.berlin> and others
 *   @lezer/yaml:
 *     Copyright (C) 2024 by Marijn Haverbeke <marijnh@gmail.com> and others
 *   style-mod:
 *     Copyright (C) 2018 by Marijn Haverbeke <marijn@haverbeke.berlin> and others
 *   w3c-keyname:
 *     Copyright (C) 2016 by Marijn Haverbeke <marijn@haverbeke.berlin> and others
 *   crelt:
 *     Copyright (C) 2020 by Marijn Haverbeke <marijn@haverbeke.berlin>
 *   @marijn/find-cluster-break:
 *     Copyright (C) 2024 by Marijn Haverbeke <marijn@haverbeke.berlin>
 *
 * MIT License
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import React, { useEffect, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import {
  EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, hoverTooltip, keymap, lineNumbers,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { forceLinting, linter, lintGutter, lintKeymap } from '@codemirror/lint'
import { yaml } from '@codemirror/lang-yaml'
import { HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { completionsAt, hoverAt, marksFor } from '../../utils/automationEditorHelp'
import { SINGLE_KEY_SHORTCUTS } from '../../shortcuts'

/*
 * The YAML editor of the Automations page: CodeMirror 6 with YAML highlighting, line numbers,
 * completion and hover from the automations JSON Schema and this site's devices and metrics
 * (utils/automationEditorHelp.js), and lint marks for syntax errors, thresholds outside a metric's
 * valid range and the database's refusals. Loaded only with the page.
 *
 * It lives in a shadow root. CodeMirror styles itself with <style> elements, which the dashboard's
 * Content-Security-Policy refuses (style-src names no inline style); in a shadow root it adopts a
 * stylesheet instead, as the 3D viewer's components do. The page's theme variables are inherited
 * into it, so one theme block paints both themes. A page's single-key shortcuts (`?`, `/`, `[`, `]`)
 * must not fire while someone types in it: the document sees a key from inside a shadow root as the
 * host's, which is no text field, so the host stops those four keys itself.
 */

/** The syntax colours, each a theme token that holds its contrast on the card in both themes. */
const highlight = HighlightStyle.define([
  { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--accent-text)' },
  { tag: [t.content, t.string], color: 'var(--text-primary)' },
  { tag: [t.number, t.bool, t.null, t.keyword], color: 'var(--warning-text)' },
  { tag: t.lineComment, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: [t.meta, t.separator, t.punctuation, t.squareBracket, t.brace, t.labelName, t.typeName], color: 'var(--text-muted)' },
])

const theme = EditorView.theme({
  '&': {
    color: 'var(--text-primary)',
    backgroundColor: 'var(--bg-card)',
    fontSize: '13px',
    maxHeight: '60vh',
  },
  '&.cm-focused': { outline: '2px solid var(--accent)', outlineOffset: '-2px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--text-primary)', minHeight: '240px', padding: '8px 0' },
  '.cm-gutters': { backgroundColor: 'var(--bg-base)', color: 'var(--text-muted)', border: 'none', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'var(--bg-glass)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--bg-glass)', color: 'var(--text-primary)' },
  '.cm-cursor': { borderLeftColor: 'var(--text-primary)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--accent-dim)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--bg-card)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-xs)',
    boxShadow: 'var(--shadow-popover)',
    fontFamily: 'var(--font-display)',
  },
  '.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent-dim)', color: 'var(--text-primary)' },
  '.cm-completionDetail': { color: 'var(--text-muted)', fontStyle: 'normal', marginLeft: '0.8em' },
  '.cm-completionInfo': { maxWidth: '320px', whiteSpace: 'normal', color: 'var(--text-primary)' },
  '.cm-aber-hover': { padding: '6px 10px', maxWidth: '360px', lineHeight: 1.45, fontSize: '12px' },
  '.cm-aber-hover-title': { fontWeight: 600, marginBottom: '2px', wordBreak: 'break-word' },
  '.cm-aber-hover-line': { color: 'var(--text-muted)', wordBreak: 'break-word' },
  // A mark is a wavy line and a gutter icon and its message: never its colour alone.
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--danger-text)', textDecorationSkipInk: 'none' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--warning-text)', textDecorationSkipInk: 'none' },
  '.cm-diagnostic': { color: 'var(--text-primary)' },
  '.cm-diagnostic-error': { borderLeft: '4px solid var(--danger)' },
  '.cm-diagnostic-warning': { borderLeft: '4px solid var(--warning)' },
  '.cm-lint-marker': { width: '1em', height: '1em' },
})

/** What completion and lint read when the page has none: nothing about the site, the schema's own words still. */
const NO_FACTS = { metrics: new Map(), devices: [], deviceById: new Map(), modelledOf: () => new Set(), rangeOf: () => null }

/** A completion result of the pure help as CodeMirror's: its options apply their own text. */
function toCompletions(result) {
  return {
    from: result.from,
    to: result.to,
    filter: false,
    options: result.options.map(o => ({
      label: o.label,
      type: o.type,
      detail: o.detail,
      info: o.info,
      boost: o.boost,
      apply: (view, _completion, from) => {
        const insert = o.apply ?? o.label
        const caret = o.caret ? insert.indexOf(`${o.caret}: `) + o.caret.length + 2 : insert.length
        view.dispatch({
          changes: { from, to: result.to, insert },
          selection: { anchor: from + caret },
          userEvent: 'input.complete',
        })
      },
    })),
  }
}

/** The hover of the pure help as a CodeMirror tooltip. */
function toTooltip(hover) {
  return {
    pos: hover.from,
    end: hover.to,
    above: true,
    create() {
      const dom = document.createElement('div')
      dom.className = 'cm-aber-hover'
      const title = document.createElement('div')
      title.className = 'cm-aber-hover-title'
      title.textContent = hover.title
      dom.appendChild(title)
      for (const line of hover.lines) {
        const row = document.createElement('div')
        row.className = 'cm-aber-hover-line'
        row.textContent = line
        dom.appendChild(row)
      }
      return { dom }
    },
  }
}

/**
 * The editor. `value` is the YAML, and `onChange` hears each edit's whole text. `facts` is what
 * buildFacts() gives (this site's devices, metrics and ranges), `refusals` the `{ path, message }` list
 * the database gave for this text, drawn on their lines until the next edit (the page clears them).
 * `readOnly` still lets the text be read, selected and copied, and reached by keyboard.
 */
export function AutomationEditor({ value, onChange, facts = null, refusals = null, readOnly = false, label = 'Automation YAML' }) {
  const hostRef = useRef(null)
  const viewRef = useRef(null)
  // Read by the callbacks below as they run, so the editor is made once and still sees the latest.
  const latest = useRef({})
  latest.current = { onChange, facts, refusals }
  const modeRef = useRef(new Compartment())

  useEffect(() => {
    const host = hostRef.current
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    const parent = document.createElement('div')
    shadow.appendChild(parent)

    const view = new EditorView({
      parent,
      root: shadow,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          history(),
          indentOnInput(),
          EditorView.lineWrapping,
          yaml(),
          syntaxHighlighting(highlight),
          autocompletion({
            override: [(context) => {
              const result = completionsAt(context.state.doc.toString(), context.pos, latest.current.facts ?? NO_FACTS)
              return result ? toCompletions(result) : null
            }],
          }),
          hoverTooltip((view, pos) => {
            const hover = hoverAt(view.state.doc.toString(), pos, latest.current.facts ?? NO_FACTS)
            return hover ? toTooltip(hover) : null
          }, { hoverTime: 250 }),
          linter((view) => marksFor(view.state.doc.toString(), latest.current.facts, latest.current.refusals), { delay: 300 }),
          lintGutter(),
          keymap.of([...defaultKeymap, ...historyKeymap, ...completionKeymap, ...lintKeymap]),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          EditorView.updateListener.of(update => {
            if (update.docChanged) latest.current.onChange?.(update.state.doc.toString())
          }),
          theme,
          modeRef.current.of(EditorState.readOnly.of(readOnly)),
        ],
      }),
    })
    viewRef.current = view

    const stopShortcuts = (e) => { if (SINGLE_KEY_SHORTCUTS.includes(e.key)) e.stopPropagation() }
    host.addEventListener('keydown', stopShortcuts)
    return () => {
      host.removeEventListener('keydown', stopShortcuts)
      view.destroy()
      parent.remove()
      viewRef.current = null
    }
    // Made once: the props the editor follows are read through `latest` and the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A text that changes from outside (a save, a discard, another automation) replaces the document.
  useEffect(() => {
    const view = viewRef.current
    if (view && view.state.doc.toString() !== value) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
    }
  }, [value])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: modeRef.current.reconfigure(EditorState.readOnly.of(readOnly)) })
  }, [readOnly])

  // The refusals and the site's facts feed the lint marks, which read them as they run.
  useEffect(() => {
    if (viewRef.current) forceLinting(viewRef.current)
  }, [refusals, facts])

  return <div className="automation-editor" ref={hostRef} />
}
