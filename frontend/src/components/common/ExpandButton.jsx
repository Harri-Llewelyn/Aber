import React from 'react'
import { TipButton } from './TipButton'
import { IconMaximize2 } from './Icons'

/**
 * The button that opens an area's plan or a device's 3D model in a window-sized dialog: one icon
 * wherever it sits, its hover text "Expand plan" or "Expand model". The accessible name adds what
 * it opens, since a page can hold several. The Modal hands focus back to it on close.
 *
 * It sits in the top-right corner of what it enlarges (`.expand-corner`), so put it beside that
 * view inside an `.expand-frame`: never inside a link, which a button cannot sit in.
 */
export function ExpandButton({ kind = 'plan', name, onClick }) {
  const tip = kind === 'model' ? 'Expand model' : 'Expand plan'
  return (
    <TipButton
      label={name ? `${tip}: ${name}` : tip}
      tip={tip}
      className="btn btn-ghost btn-icon expand-corner"
      onClick={onClick}
    >
      <IconMaximize2 size={15} />
    </TipButton>
  )
}
