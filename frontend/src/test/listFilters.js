/**
 * Queries for the shared list filters (common/FilterChecklist.jsx): a list in a page's Filters
 * panel, a dropdown in its toolbar, and the values each has ticked. A value's name carries its
 * count when the page counts ("Online 4"), so a value is found by its words with or without one.
 */
import { fireEvent, screen, within } from '@testing-library/react'

/**
 * A value's checkbox name, as a matcher: its words, then its count if the list shows counts. A
 * function rather than a pattern, so a label is compared as text.
 */
export const valueName = (words) => (name) =>
  name === words || (name.startsWith(`${words} `) && /^\d+$/.test(name.slice(words.length + 1)))

/** A toolbar list filter's button name, "<label>: <words>", as a matcher. */
const dropdownName = (label) => (name) => name.startsWith(`${label}: `)

/** The Filters panel, opened if it is shut. */
export function openFiltersPanel() {
  if (!screen.queryByRole('dialog', { name: 'Filters' })) {
    fireEvent.click(screen.getByRole('button', { name: /^Filters/ }))
  }
  return screen.getByRole('dialog', { name: 'Filters' })
}

/**
 * The heading of the section `label` in the Filters panel, opening the panel. Its name is the
 * list's, then what is chosen in it ("Entity, 2 chosen"). Null in a panel with one list.
 */
export const sectionHeading = (label) => within(openFiltersPanel())
  .queryByRole('button', { name: (name) => name === label || name.startsWith(`${label}, `) })

/**
 * The list named `label` in the Filters panel, opening the panel and then its section, which
 * closes the section that was open.
 */
export function filterList(label) {
  const heading = sectionHeading(label)
  if (heading?.getAttribute('aria-expanded') === 'false') fireEvent.click(heading)
  return within(openFiltersPanel()).getByRole('group', { name: label })
}

/** Ticks or unticks `words` in the Filters panel's list `label`. */
export function toggleInList(label, words) {
  fireEvent.click(within(filterList(label)).getByRole('checkbox', { name: valueName(words) }))
}

/** The dropdown button for the toolbar list filter `label`: its name is "<label>: <words>". */
export const dropdownButton = (label) =>
  screen.getByRole('button', { name: dropdownName(label) })

/** The panel of the toolbar list filter `label`, opened if it is shut. */
export function openDropdown(label) {
  if (!screen.queryByRole('dialog', { name: label })) fireEvent.click(dropdownButton(label))
  return screen.getByRole('dialog', { name: label })
}

/** Ticks or unticks `words` in the toolbar list filter `label`. */
export function toggleInDropdown(label, words) {
  fireEvent.click(within(openDropdown(label)).getByRole('checkbox', { name: valueName(words) }))
}

/** The words of every ticked value in `group` (a list or a dropdown's panel), counts left off. */
export const ticked = (group) => within(group).getAllByRole('checkbox')
  .filter(box => box.checked && box.closest('.filter-checklist-option'))
  .map(box => box.closest('label').querySelector('.filter-checklist-label').textContent)

/** The words of every value `group` offers, in order, counts left off. */
export const offered = (group) => [...group.querySelectorAll('.filter-checklist-option .filter-checklist-label')]
  .map(el => el.textContent)

/** Closes whichever panel is open, as Escape does. */
export const closePanel = () => fireEvent.keyDown(document, { key: 'Escape' })

/**
 * Chooses exactly `values` in the list filter `label`, by the values the page keeps (each
 * checkbox's `value`), as a select's change event once chose one: a toolbar dropdown when there is
 * one by that name, which is shut again by its button, otherwise the Filters panel's list, which is
 * left open. No values chooses nothing.
 */
export function pick(label, ...values) {
  const isDropdown = screen.queryAllByRole('button', { name: dropdownName(label) }).length > 0
  const group = isDropdown
    ? within(openDropdown(label)).getByRole('group', { name: label })
    : filterList(label)
  const boxes = [...group.querySelectorAll('.filter-checklist-option input[type="checkbox"]')]
  for (const want of values) {
    if (!boxes.some(box => box.value === want)) throw new Error(`${label} offers no value ${want}`)
  }
  for (const box of boxes) {
    if (box.checked !== values.includes(box.value)) fireEvent.click(box)
  }
  if (isDropdown) fireEvent.click(dropdownButton(label))
}

/** Each value the list filter `label` offers, as it reads with its count ("Online 4"), in order. */
export function valuesShown(label) {
  const isDropdown = screen.queryAllByRole('button', { name: dropdownName(label) }).length > 0
  const group = isDropdown
    ? within(openDropdown(label)).getByRole('group', { name: label })
    : filterList(label)
  const texts = [...group.querySelectorAll('.filter-checklist-option')].map(o => o.textContent)
  if (isDropdown) fireEvent.click(dropdownButton(label))
  return texts
}

/** The values the list filter `label` has chosen, by the values the page keeps. */
export function picked(label) {
  const isDropdown = screen.queryAllByRole('button', { name: dropdownName(label) }).length > 0
  const group = isDropdown
    ? within(openDropdown(label)).getByRole('group', { name: label })
    : filterList(label)
  const values = [...group.querySelectorAll('.filter-checklist-option input[type="checkbox"]')]
    .filter(box => box.checked).map(box => box.value)
  if (isDropdown) fireEvent.click(dropdownButton(label))
  return values
}
