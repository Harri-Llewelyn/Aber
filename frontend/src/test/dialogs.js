/**
 * What a dialog's primary does when its form is not ready: it is pressable, and the press says what is
 * missing above the buttons (hooks/useFormCheck.js). The caller asserts that nothing was sent.
 */
import { expect } from 'vitest'
import { fireEvent, within } from '@testing-library/react'

/** Presses `name` in `dialog`, and expects the dialog to say `why` above its buttons. Returns the button. */
export function pressHeld(dialog, name, why) {
  const button = within(dialog).getByRole('button', { name })
  expect(button).toBeEnabled()
  fireEvent.click(button)
  expect(dialog.querySelector('.modal-problem')).toHaveTextContent(why)
  return button
}

/** The text of every message in the dialog that says a thing is wrong: each field's and the problem line's. */
export const wrongIn = (dialog) => [...dialog.querySelectorAll('.hint-danger')].map(el => el.textContent.trim()).filter(Boolean)
