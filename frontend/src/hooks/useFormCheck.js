import { useState } from 'react'

/** What a press says when the form holds what it opened with. */
export const NOTHING_CHANGED = 'Nothing has changed.'

const sameValue = (a, b) => (Array.isArray(a) && Array.isArray(b)
  ? a.length === b.length && a.every(x => b.includes(x))
  : a === b || String(a ?? '') === String(b ?? ''))

/** Whether two forms hold the same: a field one leaves out is empty, and a list is its members. */
export const sameForm = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].every(k => sameValue(a[k], b[k]))

const FOCUSABLE = 'input, select, textarea, button, [tabindex], [contenteditable="true"]'

/** Puts the focus on the field: the element, or the first control in it when it is a group. */
function focusField(id) {
  const field = id && document.getElementById(id)
  if (!field) return
  const control = field.matches(FOCUSABLE) ? field
    : [...field.querySelectorAll(FOCUSABLE)].find(el => !el.disabled && el.tabIndex >= 0)
  control?.focus()
}

/**
 * What a form still needs, shown on the press that asks for it. Its primary is never disabled for
 * missing input: a disabled button cannot be pressed, so it cannot say what is missing.
 *
 *   const check = useFormCheck({
 *     name: { id: 'area-name', missing: !name.trim() && 'Give the area a name', wrong: tooLong(name) },
 *   }, { unchanged: name === area.name })
 *
 *   <Modal problem={check.problem} footer={<ActionButton onClick={() => check.press(save)}>…
 *   <input id="area-name" {...fieldErrorProps(check.errors.name, 'area-name-error')} />
 *   <FieldError id="area-name-error" error={check.errors.name} />
 *
 * `press(act)` runs `act` when nothing is in the way. Otherwise no request is sent: every field shows
 * its error at once, `problem` names the first, and the focus moves to that field. Fixing a field
 * clears its error as it is fixed. A press that goes ahead starts again, so a refusal that empties a
 * field is not joined by a prompt to fill it.
 *
 * @param {Object} fields The fields in the order they appear, by name. `id` is the control's, or its
 *   group's; a problem no one field holds has none. `missing` is what the field still needs, shown from
 *   the first press. `wrong` is what is wrong with it as typed, shown as it is typed.
 * @param {Object} [options]
 * @param {boolean} [options.unchanged] The form holds what it opened with, so there is nothing to send.
 * @returns {{ problem: string|null, errors: Object, press: Function, reset: Function }} `problem` and
 *   `errors` are what to show now. `reset` is for a form whose state outlives its dialog: call it as the
 *   dialog opens.
 */
export function useFormCheck(fields, { unchanged = false } = {}) {
  const [asked, setAsked] = useState(false)
  const held = Object.values(fields).find(f => f.wrong || f.missing)
  const first = held ? held.wrong || held.missing : unchanged ? NOTHING_CHANGED : null
  const errors = Object.fromEntries(Object.entries(fields)
    .map(([name, f]) => [name, f.wrong || (asked && f.missing) || null]))

  const press = (act) => {
    setAsked(first !== null)
    if (first === null) return act()
    focusField(held?.id)
    return undefined
  }

  return { problem: asked ? first : null, errors, press, reset: () => setAsked(false) }
}
