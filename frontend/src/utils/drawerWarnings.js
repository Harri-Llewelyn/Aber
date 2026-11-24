/**
 * The warnings a drawer draws at its top (ContextPanel `warnings`), where more than one drawer is
 * about the same thing: a cell's and an area's, on their own pages and on the Site Map.
 */

import { isPlaced } from './areaPlans'

const MAX_NAMES = 6

/** A list of names for a sentence: "A, B and C", cut to the first few with how many are left out. */
export function namesListed(names, max = MAX_NAMES) {
  if (names.length > max) return `${names.slice(0, max).join(', ')} and ${names.length - max} more`
  if (names.length < 2) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** A cell that is in no area, or that has no place on its area's plan. None for an archived cell. */
export function cellWarnings(cell) {
  if (!cell || cell.is_archived) return []
  if (!cell.area_id) {
    return [{ id: 'unfiled', tone: 'warning', text: 'Unfiled: this cell is in no area, so no plan shows it. Choose its area in Edit Details, on the Cells page.' }]
  }
  if (!isPlaced(cell)) {
    return [{ id: 'not-placed', tone: 'warning', text: 'Not placed: this cell has no place on its area’s plan. Set one in Edit Details, on the Cells page.' }]
  }
  return []
}

/** An area with cells in service that have no place on its plan. None for an archived area. */
export function areaWarnings(area, cells = []) {
  if (!area || area.is_archived) return []
  const unplaced = cells.filter(c => !c.is_archived && !isPlaced(c))
  if (unplaced.length === 0) return []
  return [{
    id: 'not-placed',
    tone: 'warning',
    text: `Not placed: ${namesListed(unplaced.map(c => c.cell_name))} ${unplaced.length === 1 ? 'has' : 'have'} no place on the plan. Set one in Edit Details, on the Cells page.`,
  }]
}
