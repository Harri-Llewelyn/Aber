import React from 'react'
import { IconAlertTriangle } from './Icons'

/**
 * Why a form cannot go ahead yet, said where the person is looking: the first problem, in the
 * form's warning hint with its icon. The paragraph stays in the document while empty, because it is
 * a live region: a screen reader announces a problem as it appears. Modal draws one above its
 * buttons for `problem`; a form inside a dialog with buttons of its own draws one above them.
 */
export function FormProblem({ problem, className }) {
  return (
    <p className={`form-hint hint-danger${className ? ` ${className}` : ''}`} aria-live="polite">
      {problem ? <><IconAlertTriangle size={12} /> {problem}</> : null}
    </p>
  )
}
