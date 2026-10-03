import React from 'react'
import { IconChevronDown, IconChevronUp } from './Icons'

/**
 * One button that opens or closes every collapsible section or group of a list. It reads
 * "Collapse all" while any of them is open and "Expand all" otherwise, so a click always does what
 * the label says. It sits in the tab's `.filter-bar`, after the search.
 *
 * Collapsing has to win over a search: a list that opens the sections a search matched must close
 * them when `onCollapseAll` runs, so record each one as closed rather than clearing the state.
 *
 * @param {boolean} anyOpen Whether at least one of the sections shown is open.
 * @param {Function} onExpandAll Opens every section.
 * @param {Function} onCollapseAll Closes every section, those a search opened included.
 * @param {string} [noun] What the list calls its sections, plural, for the tooltip.
 * @param {boolean} [disabled] True when there is nothing to open, such as an empty search.
 *
 *   <ExpandAllToggle anyOpen={groups.some(g => isOpen(g.key))} noun="groups"
 *     onExpandAll={() => setOpen(groups, true)} onCollapseAll={() => setOpen(groups, false)} />
 */
export function ExpandAllToggle({ anyOpen, onExpandAll, onCollapseAll, noun = 'sections', disabled = false }) {
  return (
    <button
      type="button"
      className={`btn btn-ghost btn-sm${disabled ? ' btn-disabled' : ''}`}
      onClick={anyOpen ? onCollapseAll : onExpandAll}
      disabled={disabled}
      title={anyOpen ? `Close every ${noun}` : `Open every ${noun}`}
    >
      {anyOpen ? <IconChevronUp size={13} /> : <IconChevronDown size={13} />}
      {anyOpen ? 'Collapse all' : 'Expand all'}
    </button>
  )
}
