import React from 'react'
import { SCOPE_CELL, SCOPE_AREA_WIDE, SCOPE_SITE_WIDE, normaliseScope } from '../../utils/cellResolution'

/**
 * True while the form's location cannot be written: Area-Wide with no area named.
 * `*_area_wide_names_its_area` would refuse the row, so the Save button reads this.
 */
export function locationIncomplete(form) {
  return normaliseScope(form.location_scope) === SCOPE_AREA_WIDE && !form.area_id
}

/**
 * The form fields for a scope choice. The three scopes are exclusive
 * (`*_site_wide_has_no_cell`, `*_area_wide_has_no_cell`, `*_area_wide_names_its_area`), so
 * choosing one clears what the others store. The only area is chosen for Area-Wide without
 * asking; several leave `area_id` empty for the dropdown.
 */
export function locationFieldsFor(scope, form, areas = []) {
  if (scope === SCOPE_SITE_WIDE) return { location_scope: SCOPE_SITE_WIDE, cell_id: '', area_id: '' }
  if (scope === SCOPE_AREA_WIDE) {
    const areaId = areas.some(a => a.area_id === form.area_id)
      ? form.area_id
      : areas.length === 1 ? areas[0].area_id : ''
    return { location_scope: SCOPE_AREA_WIDE, cell_id: '', area_id: areaId }
  }
  return { location_scope: SCOPE_CELL, area_id: '' }
}

/**
 * Where an asset is: in a cell, Area-Wide in one area, or Site-Wide. One exclusive choice,
 * then a dropdown only where the choice leaves more than one answer -- which cell, or which
 * area when there are several. Shared by the device and gateway forms; the callers differ
 * only in what the empty cell means (Inherit from the gateway, or No cell).
 *
 * `disabled` withholds the whole control and shows it as In a cell with nothing chosen, which is
 * how a synthetic gateway's stored scope reads everywhere else (`device_locations` resolves
 * `simulated` ahead of it).
 */
export function LocationPicker({
  idPrefix, form, onChange, cells = [], areas = [], disabled = false, title,
  cellEmptyLabel = '— No cell assigned —', cellTitle
}) {
  const scope = disabled ? SCOPE_CELL : normaliseScope(form.location_scope)
  const chosenCell = cells.find(c => c.cell_id === form.cell_id)
  const choose = (next) => { if (!disabled) onChange(locationFieldsFor(next, form, areas)) }

  const choices = [
    { scope: SCOPE_CELL, label: 'In a cell', title: 'The device sits in one work center' },
    {
      scope: SCOPE_AREA_WIDE, label: 'Area-Wide', off: areas.length === 0,
      title: areas.length === 0
        ? 'Add an area on the Areas page first — Area-Wide needs an area to name'
        : 'Serves one whole area rather than any cell in it, such as a building management system'
    },
    { scope: SCOPE_SITE_WIDE, label: 'Site-Wide', title: 'Serves the whole campus rather than any cell or area' }
  ]

  return (
    <div className="location-picker" title={title}>
      <div className="location-picker-choices" role="radiogroup" aria-label="Location">
        {choices.map(c => (
          <label key={c.scope} className={`location-choice${disabled || c.off ? ' is-disabled' : ''}`} title={c.title}>
            <input
              type="radio"
              name={`${idPrefix}-location-scope`}
              value={c.scope}
              checked={scope === c.scope}
              disabled={disabled || c.off}
              onChange={() => choose(c.scope)}
            />
            {c.label}
          </label>
        ))}
      </div>

      {scope === SCOPE_CELL && (
        <select
          id={`${idPrefix}-cell-zone`}
          className="form-control"
          value={disabled ? '' : (form.cell_id || '')}
          disabled={disabled}
          onChange={e => onChange({ location_scope: SCOPE_CELL, cell_id: e.target.value, area_id: '' })}
          title={cellTitle}
        >
          <option value="">{cellEmptyLabel}</option>
          {cells.filter(c => !c.is_archived).map(c => (
            <option key={c.cell_id} value={c.cell_id}>{c.cell_name}</option>
          ))}
          {/* An archived cell is not offered, but one already stored stays visible: silently
              dropping it would relocate the asset on the next save. */}
          {chosenCell?.is_archived && (
            <option value={chosenCell.cell_id}>{chosenCell.cell_name} (archived)</option>
          )}
        </select>
      )}

      {scope === SCOPE_AREA_WIDE && (
        areas.length > 1 ? (
          <select
            id={`${idPrefix}-area`}
            className="form-control"
            value={form.area_id || ''}
            onChange={e => onChange({ location_scope: SCOPE_AREA_WIDE, cell_id: '', area_id: e.target.value })}
            title="Which area this asset serves"
          >
            <option value="">— Choose an area —</option>
            {areas.map(ar => <option key={ar.area_id} value={ar.area_id}>{ar.area_name}</option>)}
          </select>
        ) : (
          /* One area on the plant: named, not asked. */
          <div className="location-picker-fixed" title="The only area on the plant, so it is chosen for you">
            {areas[0]?.area_name}
          </div>
        )
      )}
    </div>
  )
}
