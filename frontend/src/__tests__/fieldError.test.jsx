/**
 * FieldError (common/FieldError.jsx): what is wrong with one field, beneath it. Drawn in
 * FormProblem's look, named by its control beside the field's hint, and announced once: as it
 * appears, and again only when a message that changed has stood still.
 */
import React, { useState } from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ANNOUNCE_AFTER_MS, FieldError, fieldErrorProps } from '../components/common/FieldError'
import { FormProblem } from '../components/common/FormProblem'
import { RegisterAppModal } from '../components/modals/RegisterAppModal'
import { declaration } from '../test/themeColours'

/**
 * What a screen reader is told by the alerts under `root`: one that is inserted, and a change to the
 * text of one that is there, unless its live region is off. Each call answers everything said so
 * far, reading what has changed since the last, so it is called after every step.
 */
function listen(root = document.body) {
  const said = []
  const observer = new MutationObserver(() => {})
  observer.observe(root, { childList: true, subtree: true, characterData: true })
  const live = (el) => el && el.getAttribute('aria-live') !== 'off'
  return () => {
    const told = new Set()
    for (const { target, addedNodes } of observer.takeRecords()) {
      const around = (target.nodeType === Node.TEXT_NODE ? target.parentElement : target)?.closest('[role="alert"]')
      if (live(around)) told.add(around)
      for (const node of addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue
        for (const el of node.matches('[role="alert"]') ? [node] : node.querySelectorAll('[role="alert"]')) {
          if (live(el)) told.add(el)
        }
      }
    }
    for (const el of told) if (el.isConnected) said.push(el.textContent.trim())
    return said
  }
}

/** A field whose error quotes what is typed. */
function Quoting({ Line = FieldError }) {
  const [value, setValue] = useState('')
  const error = value === '' || value === 'good' ? null : `"${value}" is not good.`
  return (
    <>
      <input aria-label="Value" value={value} onChange={e => setValue(e.target.value)} {...fieldErrorProps(error, 'value-error', 'value-hint')} />
      <div id="value-hint" className="form-hint">Type good.</div>
      <Line id="value-error" error={error} />
    </>
  )
}
const typed = (value, label = 'Value') => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const settle = () => act(() => { vi.advanceTimersByTime(ANNOUNCE_AFTER_MS) })

describe('what is drawn', () => {
  it('is nothing without an error', () => {
    for (const error of [null, undefined, false, '']) {
      const { container, unmount } = render(<FieldError id="x" error={error} />)
      expect(container).toBeEmptyDOMElement()
      unmount()
    }
  })

  it('is FormProblem’s look: the warning hint with its icon', () => {
    render(<><FormProblem problem="Give the area a name" /><FieldError id="x" error="Too long." className="field-error-above" /></>)
    const error = screen.getByRole('alert')
    const problem = document.querySelector('p.hint-danger')
    expect(error).toHaveTextContent('Too long.')
    expect(error).toHaveClass('form-hint', 'hint-danger', 'field-error-above')
    expect(error.querySelector('svg').outerHTML).toBe(problem.querySelector('svg').outerHTML)
  })

  it('takes a message that is not a string', () => {
    render(<FieldError id="x" error={<>Start with <span className="mono">https://</span></>} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Start with https://')
  })
})

describe('what ties it to its control', () => {
  it('is aria-invalid, and an aria-describedby that names the hint and then the error', () => {
    expect(fieldErrorProps('Too long.', 'x-error', 'x-hint')).toEqual({ 'aria-invalid': true, 'aria-describedby': 'x-hint x-error' })
    expect(fieldErrorProps('Too long.', 'x-error')).toEqual({ 'aria-invalid': true, 'aria-describedby': 'x-error' })
    expect(fieldErrorProps(null, 'x-error', 'x-hint')).toEqual({ 'aria-invalid': undefined, 'aria-describedby': 'x-hint' })
    expect(fieldErrorProps(null, 'x-error')).toEqual({ 'aria-invalid': undefined, 'aria-describedby': undefined })
  })

  it('names elements that are there, and follows the error as it goes', () => {
    render(<Quoting />)
    const input = screen.getByLabelText('Value')
    expect(input).toHaveAccessibleDescription('Type good.')
    expect(input).not.toHaveAttribute('aria-invalid')

    typed('bad')
    expect(input).toHaveAccessibleDescription('Type good. "bad" is not good.')
    expect(input).toHaveAttribute('aria-invalid', 'true')

    typed('good')
    expect(input).toHaveAccessibleDescription('Type good.')
    expect(input).not.toHaveAttribute('aria-invalid')
  })

  it('draws the danger border on the control, in App.css and in both themes', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')
    expect(declaration(css, '.form-control[aria-invalid="true"]', 'border-color')).toBe('var(--danger)')
    // After :focus, which has the same weight, so the border stays while the field is typed into.
    expect(css.indexOf('.form-control[aria-invalid="true"] {')).toBeGreaterThan(css.indexOf('.form-control:focus {'))
  })
})

describe('what is announced', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('is an error as it appears, once', () => {
    const heard = listen()
    render(<Quoting />)
    expect(heard()).toEqual([])
    typed('bad')
    expect(heard()).toEqual(['"bad" is not good.'])
    settle()
    expect(heard()).toEqual(['"bad" is not good.'])
  })

  it('is not a message that changes with each key, until it has stood still', () => {
    const heard = listen()
    render(<Quoting />)
    for (const value of ['b', 'ba', 'bad', 'badl', 'badly']) {
      typed(value)
      // Drawn at once, whatever is announced.
      expect(screen.getByRole('alert')).toHaveTextContent(`"${value}" is not good.`)
      act(() => { vi.advanceTimersByTime(ANNOUNCE_AFTER_MS - 1) })
      expect(heard()).toEqual(['"b" is not good.'])
    }
    settle()
    expect(heard()).toEqual(['"b" is not good.', '"badly" is not good.'])
    settle()
    expect(heard()).toEqual(['"b" is not good.', '"badly" is not good.'])
  })

  it('is a later change too, once each has stood still', () => {
    const heard = listen()
    render(<Quoting />)
    for (const value of ['one', 'two', 'three']) {
      typed(value)
      heard()
      settle()
      heard()
    }
    expect(heard()).toEqual(['"one" is not good.', '"two" is not good.', '"three" is not good.'])
  })

  it('is the error again when it went and came back', () => {
    const heard = listen()
    render(<Quoting />)
    typed('bad')
    heard()
    typed('good')
    expect(screen.queryByRole('alert')).toBeNull()
    heard()
    typed('bad')
    expect(heard()).toEqual(['"bad" is not good.', '"bad" is not good.'])
  })

  it('is heard by this test on every key where a line is a plain alert', () => {
    const Plain = ({ id, error }) => (error ? <div id={id} role="alert">{error}</div> : null)
    const heard = listen()
    render(<Quoting Line={Plain} />)
    for (const value of ['b', 'ba', 'bad']) { typed(value); heard() }
    expect(heard()).toEqual(['"b" is not good.', '"ba" is not good.', '"bad" is not good.'])
  })

  it('is nothing more while an address is typed into Register App, whose error quotes it', () => {
    render(<RegisterAppModal onClose={vi.fn()} />)
    const heard = listen()
    for (const value of ['f', 'ft', 'ftp', 'ftp:', 'ftp://files.example']) {
      typed(value, /^Addresses/)
      expect(heard()).toEqual([expect.stringMatching(/^f must start with https/)])
    }
    settle()
    expect(heard()).toEqual([expect.stringMatching(/^f must start/), expect.stringMatching(/^ftp:\/\/files\.example must start/)])
  })
})
