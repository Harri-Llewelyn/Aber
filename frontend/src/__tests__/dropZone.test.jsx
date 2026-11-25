import React, { useState } from 'react'
import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DROP_HERE, DropZone, useFilePicker } from '../components/common/DropZone'
import { acceptsFile } from '../utils/fileChoice'

/**
 * Where a person gives one file (common/DropZone.jsx): one control that a click, Enter and Space open the
 * picker from, that takes a drop held to the kinds the picker offers, and that says each state in words.
 */

const file = (name = 'kpis.json', type = 'application/json') => new File(['{}'], name, { type })
const dragged = (...files) => ({ dataTransfer: { files, types: ['Files'] } })

const show = (props = {}) => {
  const onFile = vi.fn()
  const view = (more = {}) => (
    <DropZone
      label="The file"
      prompt="Drop a file here, or click to choose one"
      hint="A .json file, up to 8 MiB"
      accept=".json,application/json"
      kinds="a .json file"
      testId="picker"
      onFile={onFile}
      {...props}
      {...more}
    />
  )
  const { rerender } = render(view())
  return { onFile, again: more => rerender(view(more)) }
}
/** The values a picker is given. Its own is '' in jsdom whatever it holds, so one set is what can be seen. */
const holdsValue = (input) => {
  const values = []
  Object.defineProperty(input, 'value', { configurable: true, get: () => values.at(-1) ?? 'held', set: v => values.push(v) })
  return values
}
const zone = () => screen.getByRole('button', { name: 'The file' })
const picker = () => screen.getByTestId('picker')
const refusal = () => screen.queryByRole('alert')

describe('the zone as a control', () => {
  it('is one button, named by its label and described by what to drop, the kinds and the limit', () => {
    show()
    expect(screen.getAllByRole('button')).toEqual([zone()])
    expect(zone()).toHaveAttribute('type', 'button')
    expect(zone()).toHaveAccessibleDescription('Drop a file here, or click to choose one A .json file, up to 8 MiB')
    // The input is the picker, and no stop of its own.
    expect(picker()).toHaveAttribute('hidden')
    expect(picker()).toHaveAttribute('accept', '.json,application/json')
  })

  it('takes its name from a label on the page, and says it is required', () => {
    render(<>
      <label id="l" htmlFor="f">File</label>
      <DropZone id="f" labelledBy="l" required prompt="Drop it" hint="A .json file" accept=".json" kinds="a .json file" onFile={vi.fn()} />
    </>)
    expect(screen.getByLabelText('File')).toBe(screen.getByRole('button', { name: 'File' }))
    expect(screen.getByRole('button', { name: 'File' })).toHaveAccessibleDescription('Drop it Required. A .json file')
  })

  it('opens the picker once for a press, which Enter and Space are on a button', () => {
    show()
    const opened = vi.spyOn(picker(), 'click')
    fireEvent.click(zone())
    expect(opened).toHaveBeenCalledTimes(1)
  })

  it('hands on the file chosen, and clears the picker so the same one can be chosen again', () => {
    const { onFile } = show()
    const chosen = file()
    const values = holdsValue(picker())
    fireEvent.change(picker(), { target: { files: [chosen] } })
    expect(onFile).toHaveBeenCalledExactlyOnceWith(chosen)
    expect(values).toEqual([''])
    fireEvent.change(picker(), { target: { files: [chosen] } })
    expect(onFile).toHaveBeenCalledTimes(2)
  })

  it('does nothing when the picker is cancelled', () => {
    const { onFile } = show()
    fireEvent.change(picker(), { target: { files: [] } })
    expect(onFile).not.toHaveBeenCalled()
    expect(refusal()).toBeNull()
  })
})

describe('a file held over it', () => {
  it('says in words what a drop does, and takes it back when the file leaves', () => {
    show()
    fireEvent.dragEnter(zone(), dragged())
    fireEvent.dragOver(zone(), dragged())
    expect(zone()).toHaveAttribute('data-dragging', 'yes')
    expect(zone()).toHaveTextContent(DROP_HERE)
    expect(zone()).not.toHaveTextContent('or click to choose one')

    // Crossing from one part of the zone to another is not leaving it.
    const leave = (to) => fireEvent(zone(), Object.defineProperty(createEvent.dragLeave(zone()), 'relatedTarget', { value: to }))
    leave(zone().querySelector('svg'))
    expect(zone()).toHaveAttribute('data-dragging', 'yes')
    leave(document.body)
    expect(zone()).not.toHaveAttribute('data-dragging')
    expect(zone()).toHaveTextContent('Drop a file here, or click to choose one')
  })

  it('answers for a file alone, so a row dragged over it is left to the page', () => {
    show()
    const text = createEvent.dragOver(zone(), { dataTransfer: { files: [], types: ['text/plain'] } })
    fireEvent(zone(), text)
    expect(text.defaultPrevented).toBe(false)
    expect(zone()).not.toHaveAttribute('data-dragging')
  })

  it('keeps the browser from opening the file, over it and on the drop', () => {
    show()
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      const event = createEvent[type](zone(), dragged(file()))
      fireEvent(zone(), event)
      expect(event.defaultPrevented, type).toBe(true)
    }
  })
})

describe('a file dropped on it', () => {
  it('is handed on as a chosen one is', () => {
    const { onFile } = show()
    const dropped = file()
    fireEvent.dragOver(zone(), dragged())
    fireEvent.drop(zone(), dragged(dropped))
    expect(onFile).toHaveBeenCalledExactlyOnceWith(dropped)
    expect(zone()).not.toHaveAttribute('data-dragging')
    expect(refusal()).toBeNull()
  })

  it('is held to the kinds the picker offers, and refused in words at the zone, which stays', () => {
    const { onFile } = show()
    fireEvent.drop(zone(), dragged(file('plan.png', 'image/png')))
    expect(onFile).not.toHaveBeenCalled()
    expect(refusal()).toHaveTextContent('"plan.png" is not a .json file.')
    expect(zone()).toHaveAccessibleDescription(/"plan\.png" is not a \.json file\.$/)
    expect(zone()).toHaveAttribute('aria-invalid', 'true')

    fireEvent.drop(zone(), dragged(file()))
    expect(onFile).toHaveBeenCalledTimes(1)
    expect(refusal()).toBeNull()
    expect(zone()).not.toHaveAttribute('aria-invalid')
  })

  it('is refused with a second one, in words', () => {
    const { onFile } = show()
    fireEvent.drop(zone(), dragged(file('a.json'), file('b.json')))
    expect(onFile).not.toHaveBeenCalled()
    expect(refusal()).toHaveTextContent('Drop one file at a time: 2 were dropped.')
  })

  it('does nothing when it holds no file, as a picture dragged from a page may', () => {
    const { onFile } = show()
    fireEvent.drop(zone(), dragged())
    expect(onFile).not.toHaveBeenCalled()
    expect(refusal()).toBeNull()
  })
})

describe("the caller's own check", () => {
  const refuse = (f) => (f.size > 5 ? `${f.name} is too large` : f.name.endsWith('.json') ? null : `${f.name} is no capture`)
  const large = (name) => Object.defineProperty(file(name), 'size', { value: 9 })

  it('is made of a chosen file and of a dropped one, in the same words, which the caller hears', () => {
    const onRefuse = vi.fn()
    const { onFile } = show({ refuse, onRefuse })
    fireEvent.change(picker(), { target: { files: [large('a.json')] } })
    expect(refusal()).toHaveTextContent('a.json is too large')
    fireEvent.drop(zone(), dragged(large('b.json')))
    expect(refusal()).toHaveTextContent('b.json is too large')
    expect(onRefuse.mock.calls).toEqual([['a.json is too large'], ['b.json is too large']])
    expect(onFile).not.toHaveBeenCalled()
  })

  it("comes before the zone's, so a page keeps its own words for a kind it does not take", () => {
    show({ refuse })
    fireEvent.drop(zone(), dragged(file('plan.png', 'image/png')))
    expect(refusal()).toHaveTextContent('plan.png is no capture')
  })

  it('stands aside for a picked file it has nothing against, past the picker’s filter', () => {
    const { onFile } = show()
    fireEvent.change(picker(), { target: { files: [file('kpis.txt', 'text/plain')] } })
    expect(onFile).toHaveBeenCalledTimes(1)
  })
})

describe('while it is read', () => {
  it('says so, is still a stop for Tab, and takes nothing', () => {
    const { onFile } = show({ busy: 'Reading the file…' })
    expect(zone()).toHaveTextContent('Reading the file…')
    expect(zone()).toBeEnabled()
    expect(zone()).toHaveAttribute('aria-busy', 'true')
    expect(zone()).toHaveAttribute('aria-disabled', 'true')
    // Said to a screen reader too, outside the button, whose own content is not read as it changes.
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('Reading the file…')
    expect(zone().querySelector('[aria-live]')).toBeNull()

    const opened = vi.spyOn(picker(), 'click')
    fireEvent.click(zone())
    expect(opened).not.toHaveBeenCalled()
    fireEvent.dragOver(zone(), dragged())
    expect(zone()).not.toHaveAttribute('data-dragging')
    const dropped = createEvent.drop(zone(), dragged(file()))
    fireEvent(zone(), dropped)
    expect(onFile).not.toHaveBeenCalled()
    expect(dropped.defaultPrevented).toBe(true)
  })
})

describe('a file it holds', () => {
  it('is named, with Choose Another, in the one control', () => {
    show({ fileName: 'group-kpis.json' })
    expect(zone()).toHaveTextContent('group-kpis.json')
    expect(zone()).toHaveTextContent('Choose Another')
    expect(screen.getAllByRole('button')).toEqual([zone()])
    expect(zone()).toHaveAccessibleDescription('group-kpis.json A .json file, up to 8 MiB')
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('group-kpis.json chosen')
    const opened = vi.spyOn(picker(), 'click')
    fireEvent.click(screen.getByText('Choose Another'))
    expect(opened).toHaveBeenCalledTimes(1)
  })

  it('stays, and stays right, when another is refused', () => {
    const { onFile } = show({ fileName: 'group-kpis.json' })
    fireEvent.drop(zone(), dragged(file('plan.png', 'image/png')))
    expect(onFile).not.toHaveBeenCalled()
    expect(zone()).toHaveTextContent('group-kpis.json')
    expect(zone()).toHaveAccessibleDescription(/"plan\.png" is not a \.json file\.$/)
    expect(zone()).not.toHaveAttribute('aria-invalid')
  })

  it('is said to be wrong by the caller, until another is given', () => {
    const { again } = show({ fileName: 'group-kpis.json', error: 'It holds nothing to import.' })
    expect(refusal()).toHaveTextContent('It holds nothing to import.')
    expect(zone()).toHaveAttribute('aria-invalid', 'true')
    fireEvent.drop(zone(), dragged(file('a.json'), file('b.json')))
    expect(refusal()).toHaveTextContent('Drop one file at a time')
    fireEvent.drop(zone(), dragged(file('b.json')))
    again({ fileName: 'b.json', error: null })
    expect(refusal()).toBeNull()
  })
})

describe('a zone the person may not use', () => {
  it('opens nothing, takes nothing, and does not let the browser open what is dropped on it', () => {
    const { onFile } = show({ disabled: true, fileName: 'group-kpis.json' })
    expect(zone()).toBeDisabled()
    expect(zone()).not.toHaveTextContent('Choose Another')
    const dropped = createEvent.drop(zone(), dragged(file()))
    fireEvent(zone(), dropped)
    expect(dropped.defaultPrevented).toBe(true)
    expect(onFile).not.toHaveBeenCalled()
  })
})

describe('useFilePicker', () => {
  function Replace({ onFile }) {
    const [label] = useState('Replace')
    const { picker: input, open } = useFilePicker({ id: 'replace', accept: '.svg', onFile, testId: 'picker' })
    return <><label htmlFor="replace">Plan</label>{input}<button onClick={open}>{label}</button></>
  }

  it('is the same picker for a button, which a label can open too', () => {
    const onFile = vi.fn()
    render(<Replace onFile={onFile} />)
    const opened = vi.spyOn(picker(), 'click')
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    expect(opened).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Plan').control).toBe(picker())
    const svg = file('plan.svg', 'image/svg+xml')
    const values = holdsValue(picker())
    fireEvent.change(picker(), { target: { files: [svg] } })
    expect(onFile).toHaveBeenCalledExactlyOnceWith(svg)
    expect(values).toEqual([''])
  })
})

describe('acceptsFile', () => {
  it.each([
    ['.svg,image/svg+xml', 'PLAN.SVG', '', true],
    ['.svg,image/svg+xml', 'plan', 'image/svg+xml', true],
    ['.svg,image/svg+xml', 'plan.png', 'image/png', false],
    ['.yaml, .yml', 'schemas.yml', '', true],
    ['image/*', 'photo', 'image/webp', true],
    ['image/*', 'photo.txt', 'text/plain', false],
    ['.json', 'json', '', false],
    ['', 'anything', '', true],
  ])('%s and %s (%s): %s', (accept, name, type, taken) => {
    expect(acceptsFile(accept, { name, type })).toBe(taken)
  })
})
