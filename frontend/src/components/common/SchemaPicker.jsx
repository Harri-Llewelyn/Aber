import React, { useId, useMemo, useState } from 'react'
import { ListPicker } from './ListPicker'
import { OverflowText } from './OverflowText'
import { modelledMetrics } from '../../utils/deviceTags'
import { plural } from '../../utils/format'
import { schemaHit } from '../../utils/schemaSearch'
import { isInForce, schemaStatus, schemaVersion, schemaVersionLabel, statusBadgeClass, statusLabel } from '../../utils/schemaVersion'

const keyOf = row => row.schema.schema_uuid
const matches = (row, needle) => schemaHit(row.schema, row.metrics, needle) !== null

/** What the search found a schema by, in place of its description. */
function FoundBy({ metrics: [first, ...rest] }) {
  return <>models <span className="mono">{first}</span>{rest.length > 0 && `, and ${rest.length} more that match`}</>
}

/** A row: its name and version, and its status while it is not in force, over its metric count and description. */
function SchemaRow({ schema, metrics, needle, id }) {
  const found = schemaHit(schema, metrics, needle)?.metrics ?? []
  return (
    <span className="schema-picker-row">
      <span className="schema-picker-head">
        <OverflowText className="schema-picker-name">{schema.schema_name}</OverflowText>
        {isInForce(schema)
          ? <span className="schema-picker-version" id={`${id}-version`}>v{schemaVersion(schema)}</span>
          : <span className={`badge badge-sm ${statusBadgeClass(schemaStatus(schema))}`} id={`${id}-version`}>{schemaVersionLabel(schema)}</span>}
      </span>
      <span className="schema-picker-detail" id={`${id}-detail`}>
        <span className="schema-picker-count">{metrics.length === 0 ? 'No metrics' : plural(metrics.length, 'metric')}</span>
        {(found.length > 0 || schema.description) && (
          <OverflowText>· {found.length > 0 ? <FoundBy metrics={found} /> : schema.description}</OverflowText>
        )}
      </span>
    </span>
  )
}

/**
 * Schemas to choose from, as a fieldset named by `legend`: a ListPicker whose search finds a schema
 * by its name, its description or the name of a metric it models, and says which metric when that is
 * what found it. The list has one height whatever it holds, so a dialog does not grow with the site.
 *
 * The schemas chosen as it opens are listed first, so they are found without a search. Choosing
 * moves no row.
 *
 * @param {object[]} schemas The schemas that can be chosen, as assignableSchemas() gives them.
 * @param {string[]} value The chosen schemas' ids. The caller holds them, so one the search hides
 * stays chosen.
 * @param {(schemaId: string) => void} onToggle Called to choose a schema or take it out.
 * @param {boolean} [disabled] Nothing can be chosen or taken out. The search still works.
 * @param {string} legend The fieldset's name.
 * @param {React.ReactNode} [note] Drawn under the legend, above the search box.
 * @param {React.ReactNode} [children] Drawn under the list.
 */
export function SchemaPicker({ schemas, value, onToggle, disabled = false, legend, note, children }) {
  const baseId = useId()
  const idOf = schema => `${baseId}-${schema.schema_uuid}`
  const [first] = useState(() => new Set(value))
  const rows = useMemo(() => {
    const all = schemas.map(schema => ({ schema, metrics: [...(modelledMetrics(schema) ?? [])] }))
    return [...all.filter(row => first.has(keyOf(row))), ...all.filter(row => !first.has(keyOf(row)))]
  }, [schemas, first])

  return (
    <ListPicker
      legend={legend}
      note={note}
      items={rows}
      keyOf={keyOf}
      isPicked={row => value.includes(keyOf(row))}
      onPick={row => onToggle(keyOf(row))}
      disabled={disabled}
      searchLabel={rows.length > 0 ? 'Search name, description or metric' : undefined}
      matches={matches}
      // The control is named by the schema, and described by the rest of its row.
      inputProps={({ schema }) => ({
        'aria-label': isInForce(schema) ? schema.schema_name : `${schema.schema_name} · ${statusLabel(schemaStatus(schema))}`,
        'aria-describedby': `${idOf(schema)}-version ${idOf(schema)}-detail`
      })}
      renderItem={(row, { needle }) => <SchemaRow {...row} needle={needle} id={idOf(row.schema)} />}
      listClass={rows.length > 0 ? 'schema-picker-list' : 'schema-picker-list-none'}
      emptyText="No schemas yet. Create one on the Schemas page."
      noMatchText="No matching schemas."
    >
      {children}
    </ListPicker>
  )
}
