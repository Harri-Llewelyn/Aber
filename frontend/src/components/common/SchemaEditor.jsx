import React, { useState } from 'react'
import { FieldError, fieldErrorProps } from './FieldError'
import { IconCheck } from './Icons'
import { MetricPicker } from './MetricPicker'
import { PropertyRange } from './PropertyRange'
import { RequiredMark } from './RequiredMark'
import { SchemaDerivedMetrics } from './SchemaDerivedMetrics'
import { SemanticIdField } from './SemanticIdField'
import { StaticEmpty, StaticField } from './StaticField'
import { Tooltip } from './Tooltip'
import { derivedOffered, derivedProblems } from '../../utils/derivedMetric'
import { modelledMetrics } from '../../utils/deviceTags'
import { rangeError } from '../../utils/schemaProperty'

const REQUIRED = 'Required: the schema cannot be saved without it'

const BLANK = { name: '', description: '', changeDescription: '', semanticId: '', semanticIdType: '', ranges: {} }

/**
 * What a schema's editor holds: its fields, the names of the ticked metrics (`picked`, a Set), the range
 * typed beside each (`ranges`, by name) and the names of the ticked derived metrics (`derived`, a Set). A
 * range is kept when its metric is unticked, so ticking it again brings the range back, and a derived
 * metric stays ticked when an input is, so unticking one by mistake loses nothing. `change` takes a patch,
 * or a function of the form that returns one.
 */
export function useSchemaForm(initial) {
  const [form, setForm] = useState(() => ({ ...BLANK, picked: new Set(), derived: new Set(), ...initial?.() }))
  const change = (patch) => setForm(f => ({ ...f, ...(typeof patch === 'function' ? patch(f) : patch) }))
  return [form, change]
}

const rangeId = (idPrefix, metric) => `${idPrefix}-range-${metric.metric_uuid}`

/**
 * What a schema whose definition is this one may name among its derived metrics: the ones `offered`, and
 * why a ticked one may not be saved (`problems`, { name, problem } each). `kept` is what the version, or the
 * one it was made from, names already. The database checks the same on the save, in the same words.
 */
export function schemaDerived({ form, catalog, definition, kept = [] }) {
  const schema = { definition, modelled: modelledMetrics({ schema_definition: definition }) }
  return {
    offered: derivedOffered(schema, catalog, kept),
    problems: derivedProblems(schema, [...form.derived].sort(), catalog, kept)
  }
}

/**
 * What the editor's fields still need, for useFormCheck(), in the order they appear. `takesRange(name)`
 * says whether a range is typed beside a metric; a version's name is not its editor's to give. `derived` is
 * schemaDerived()'s.
 */
export function schemaFields(idPrefix, { form, catalog, takesRange, derived, named = false }) {
  const bad = catalog.filter(m => form.picked.has(m.name) && takesRange(m.name) && rangeError(form.ranges[m.name]))
  return {
    ...(!named && { name: { id: `${idPrefix}-name`, missing: !form.name.trim() && 'Give the schema a name' } }),
    // A schema with no metrics constrains nothing, so the list is required.
    metrics: {
      id: `${idPrefix}-metrics`,
      missing: form.picked.size === 0 && 'Tick at least one metric. A schema with none constrains nothing.',
    },
    ranges: {
      id: bad.length > 0 ? rangeId(idPrefix, bad[0]) : undefined,
      wrong: bad.length > 0 && `Fix the range of ${bad.map(m => `${m.name}: ${rangeError(form.ranges[m.name])}`).join(' ')}`,
    },
    // Said as soon as an input is unticked, not at the save that it would refuse.
    derived: {
      id: `${idPrefix}-derived`,
      wrong: derived?.problems.length > 0 && derived.problems.map(p => p.problem).join(' '),
    },
  }
}

/**
 * The body of the dialogs that build a schema, edit a draft of one and show a published version, so a
 * schema is one form wherever it is met: its name, description and semantic id, then its metrics with
 * their ranges, then the derived metrics its devices get. `readOnly` shows the same fields as text, never as disabled inputs. Use it inside
 * `<Modal size="wide" fill>`: the metric list takes the height the rest leaves, and scrolls inside
 * itself.
 *
 * @param {string} idPrefix Starts every id the body draws.
 * @param {object} form What it holds, and `onChange` its `change` (useSchemaForm).
 * @param {object} [errors] What useFormCheck() says of schemaFields().
 * @param {object[]} catalog The metrics that can be chosen.
 * @param {(name: string) => object|null} rangeOf The range to show beside a ticked metric, as typed, or
 * null where it takes none.
 * @param {{ uuid: string, onCopy: Function }} [version] A version of a schema, whose name is fixed. It
 * adds the UUID and the Change Description.
 * @param {(name: string) => React.ReactNode} [noteOf] Text after a metric's name: the keys a version
 * stores for it.
 * @param {(name: string) => string|null} [rangeTextOf] A metric's range in words, for `readOnly`.
 * @param {React.ReactNode} [counts] Drawn after the count of the ticked metrics.
 * @param {React.ReactNode} [above] Drawn over the metric list, and `below` under it.
 * @param {{ offered: object[], counts?: React.ReactNode }} [derived] The derived metrics on offer
 * (schemaDerived()), and what is drawn after their count.
 * @param {React.ReactNode} [children] Drawn beside the derived metrics: each is a closed `<details>`, so the
 * two share a line until one is opened.
 */
export function SchemaEditor({
  idPrefix, readOnly = false, form, onChange, errors = {}, catalog, rangeOf, version = null,
  noteOf, rangeTextOf, counts = null, above = null, below = null, derived, children
}) {
  const id = (part) => `${idPrefix}-${part}`
  const names = [...form.picked]

  const toggle = (name) => onChange(f => {
    const picked = new Set(f.picked)
    if (picked.has(name)) picked.delete(name); else picked.add(name)
    return { picked }
  })

  return (
    <>
      <div className="schema-editor-fields">
        {version ? (
          <StaticField
            label="Schema Name"
            value={form.name}
            reason={readOnly ? null : 'Follows the first version’s name, so it cannot be changed.'}
          />
        ) : (
          <div className="form-group">
            <label className="form-label" htmlFor={id('name')}>Schema Name <RequiredMark title={REQUIRED} /></label>
            <input
              id={id('name')}
              className="form-control"
              aria-required="true"
              value={form.name}
              onChange={e => onChange({ name: e.target.value })}
              placeholder="e.g. Six-Axis-Robot-Arm-Standard"
              {...fieldErrorProps(errors.name, id('name-error'))}
            />
            <FieldError id={id('name-error')} error={errors.name} />
          </div>
        )}

        {version && (
          <StaticField label="Schema UUID" value={version.uuid} mono copyable copyLabel="schema UUID" onCopy={version.onCopy} />
        )}

        {readOnly ? (
          <StaticField label="Description" value={form.description} />
        ) : (
          <div className="form-group">
            <label className="form-label" htmlFor={id('description')}>Description</label>
            <input
              id={id('description')}
              className="form-control"
              value={form.description}
              onChange={e => onChange({ description: e.target.value })}
              placeholder="What this schema is for"
            />
          </div>
        )}

        {version && (readOnly ? (
          <StaticField label="Change Description" value={form.changeDescription} />
        ) : (
          <div className="form-group">
            <label className="form-label" htmlFor={id('change-description')}>Change Description</label>
            <Tooltip text="Why this version exists. Frozen once the version is published.">
              <textarea
                id={id('change-description')}
                className="form-control"
                rows={2}
                value={form.changeDescription}
                onChange={e => onChange({ changeDescription: e.target.value })}
                placeholder="e.g. Added spindle temperature threshold"
              />
            </Tooltip>
          </div>
        ))}
      </div>

      <SemanticIdField
        idPrefix={idPrefix}
        subject="schema"
        readOnly={readOnly}
        semanticId={form.semanticId}
        semanticIdType={form.semanticIdType}
        onChange={onChange}
      />

      <div className="form-label" id={id('metrics-label')}>
        Metrics {!readOnly && <RequiredMark title={REQUIRED} />}
        <span className="section-count">{readOnly ? names.length : `${names.length} selected`}</span>
        {counts}
      </div>
      {above}
      <FieldError id={id('metrics-error')} error={errors.metrics} className="field-error-above" />
      <FieldError id={id('ranges-error')} error={errors.ranges} className="field-error-above" />

      <div
        id={id('metrics')}
        className={`modal-fill schema-editor-metrics${readOnly ? ' schema-editor-metrics-static' : ''}`}
        style={readOnly ? { '--schema-metrics': names.length } : undefined}
        role="group"
        aria-labelledby={id('metrics-label')}
        aria-describedby={errors.metrics ? id('metrics-error') : undefined}
      >
        {readOnly ? (
          names.length === 0 ? (
            <StaticEmpty>This schema models no metrics.</StaticEmpty>
          ) : (
            <ul className="schema-editor-list">
              {names.map(name => (
                <li key={name}>
                  <IconCheck size={12} />
                  <span className="mono metric-picker-name">{name}</span>
                  {noteOf?.(name)}
                  {rangeTextOf?.(name) && <span className="schema-editor-range">{rangeTextOf(name)}</span>}
                </li>
              ))}
            </ul>
          )
        ) : (
          // The search and the standard filter narrow what is listed, never what is ticked. A range sits
          // outside its row's label, so typing in it never toggles the tick.
          <MetricPicker
            metrics={catalog}
            isPicked={m => form.picked.has(m.name)}
            onPick={m => toggle(m.name)}
            renderNote={noteOf && (m => noteOf(m.name))}
            renderExtra={(m, ticked) => {
              const range = ticked ? rangeOf(m.name) : null
              return range && (
                <PropertyRange
                  id={rangeId(idPrefix, m)}
                  name={m.name}
                  range={range}
                  onChange={next => onChange(f => ({ ranges: { ...f.ranges, [m.name]: next } }))}
                  errorId={errors.ranges ? id('ranges-error') : undefined}
                />
              )
            }}
          />
        )}
      </div>

      {below}
      <div className="schema-asides">
        <SchemaDerivedMetrics
          id={id('derived')}
          readOnly={readOnly}
          names={form.derived}
          catalog={derived?.catalog}
          offered={derived?.offered}
          counts={derived?.counts}
          error={errors.derived}
          onToggle={name => onChange(f => {
            const next = new Set(f.derived)
            if (next.has(name)) next.delete(name); else next.add(name)
            return { derived: next }
          })}
        />
        {children}
      </div>
    </>
  )
}
