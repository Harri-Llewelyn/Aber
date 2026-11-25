import React from 'react'
import { FieldError, fieldErrorProps } from './FieldError'
import { Tooltip } from './Tooltip'
import { SCOPE_GATEWAY, SCOPE_CELL, SCOPE_AREA_WIDE, SCOPE_SITE_WIDE, normaliseScope } from '../../utils/cellResolution'

/**
 * True while the form's location cannot be written: Area-Wide with no area named, or, where
 * `cellRequired`, In a cell with no cell. `*_area_wide_names_its_area` and
 * `devices_cell_scope_names_a_cell` would refuse the row, so the form's check reads this. A gateway
 * may be in no cell, so its form leaves `cellRequired` off.
 */
export function locationIncomplete(form, { cellRequired = false } = {}) {
  const scope = normaliseScope(form.location_scope)
  return (scope === SCOPE_AREA_WIDE && !form.area_id) || (cellRequired && scope === SCOPE_CELL && !form.cell_id)
}

/**
 * The form fields for a scope choice. The scopes are exclusive
 * (`*_site_wide_has_no_cell`, `*_area_wide_has_no_cell`, `*_area_wide_names_its_area`,
 * `devices_follow_gateway_has_no_place`), so choosing one clears what the others store. The only
 * area is chosen for Area-Wide without asking; several leave `area_id` empty for the dropdown.
 */
function locationFieldsFor(scope, form, areas = []) {
  if (scope === SCOPE_GATEWAY) return { location_scope: SCOPE_GATEWAY, cell_id: '', area_id: '' }
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
 * Where an asset is: following its gateway, in a cell, Area-Wide in one area, or Site-Wide. One
 * exclusive choice, then a dropdown only where the choice leaves more than one answer -- which
 * cell, or which area when there are several. Shared by the device forms and the gateway form.
 * `followGateway` offers Follow Gateway first, for a device: a gateway has no gateway to follow, and
 * its form leaves the choice out and lets the cell stay empty (`cellEmptyLabel`).
 *
 * `disabled` withholds the whole control and shows its first choice, which is how a synthetic
 * gateway's stored scope reads everywhere else (`device_locations` resolves `simulated` ahead of
 * it). The caller's hint beneath says why. `error` is what is missing of the place chosen, said under
 * the dropdown that asks for it.
 */
export function LocationPicker({
  idPrefix, form, onChange, cells = [], areas: allAreas = [], disabled = false,
  followGateway = false, cellEmptyLabel = '— No cell assigned —', error = null
}) {
  // The database refuses making anything Area-Wide in an archived area.
  const areas = allAreas.filter(a => !a.is_archived)
  const scope = disabled ? (followGateway ? SCOPE_GATEWAY : SCOPE_CELL) : normaliseScope(form.location_scope)
  const chosenCell = cells.find(c => c.cell_id === form.cell_id)
  const choose = (next) => { if (!disabled) onChange(locationFieldsFor(next, form, areas)) }

  const choices = [
    ...(followGateway ? [{
      scope: SCOPE_GATEWAY, label: 'Follow Gateway',
      title: 'Takes the place its gateway has, and moves when the gateway does'
    }] : []),
    { scope: SCOPE_CELL, label: 'In a cell' },
    {
      scope: SCOPE_AREA_WIDE, label: 'Area-Wide', off: areas.length === 0,
      title: areas.length === 0
        ? 'Add an area on the Areas page first — Area-Wide needs an area to name'
        : 'Serves one whole area rather than any cell in it, such as a building management system'
    },
    { scope: SCOPE_SITE_WIDE, label: 'Site-Wide', title: 'Serves the whole campus rather than any cell or area' }
  ]

  return (
    <div className="location-picker">
      <div className="location-picker-choices" role="radiogroup" aria-label="Location">
        {/* The tooltip is on the label, so it shows for the pointer on the words and for the
            keyboard's focus on the radio inside. */}
        {choices.map(c => (
          <Tooltip key={c.scope} text={c.title}>
            <label className={`location-choice${disabled || c.off ? ' is-disabled' : ''}`}>
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
          </Tooltip>
        ))}
      </div>

      {scope === SCOPE_CELL && (
        <select
          id={`${idPrefix}-cell`}
          className="form-control"
          value={disabled ? '' : (form.cell_id || '')}
          disabled={disabled}
          onChange={e => onChange({ location_scope: SCOPE_CELL, cell_id: e.target.value, area_id: '' })}
          aria-label="Cell"
          {...fieldErrorProps(error, `${idPrefix}-location-error`)}
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
            aria-label="Area"
            {...fieldErrorProps(error, `${idPrefix}-location-error`)}
          >
            <option value="">— Choose an area —</option>
            {areas.map(ar => <option key={ar.area_id} value={ar.area_id}>{ar.area_name}</option>)}
          </select>
        ) : (
          /* One area on the plant: named, not asked. */
          <Tooltip text="The only area on the plant, so it is chosen for you">
            <div className="location-picker-fixed">{areas[0]?.area_name}</div>
          </Tooltip>
        )
      )}
      <FieldError id={`${idPrefix}-location-error`} error={error} />
    </div>
  )
}
