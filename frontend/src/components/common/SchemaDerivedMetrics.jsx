import React, { useMemo } from 'react'
import { FieldError } from './FieldError'
import { IconCheck, IconTag } from './Icons'
import { MetricPicker } from './MetricPicker'
import { derivationText, isDerived } from '../../utils/derivedMetric'

/** A list longer than this has a search, as the metric list above it has. */
const SEARCHED_OVER = 6

/**
 * The editor's Derived Metrics section, under its metrics: the ones a schema may name as it is, chosen
 * from the same picker, or the ones a read-only version names as text. It is closed until it is asked for,
 * as Version History is, so that it takes nothing from the metric list, and its summary says how many are
 * ticked and how many may be. A ticked one that the metrics no longer cover stays in the list, ticked, so it
 * can be unticked, and the error over the section, open or closed, says what it lacks. The section never
 * opens by itself: the metric list would move under the pointer that is ticking it. Nothing is drawn while
 * the catalog holds no derived metric and the version names none.
 *
 * @param {string} id The summary's, where the press that the error refuses puts the focus.
 * @param {Set<string>} names What is ticked, or what the version names.
 * @param {object[]} catalog Every metric.
 * @param {object[]} offered The derived metrics that may be ticked (schemaDerived()).
 * @param {(name: string) => void} onToggle Called when one is ticked or unticked.
 * @param {React.ReactNode} [counts] Drawn after how many are ticked.
 * @param {string|null} [error] Why a ticked one may not be saved.
 */
export function SchemaDerivedMetrics({ id, readOnly = false, names, catalog = [], offered = [], counts = null, error = null, onToggle }) {
  const byName = useMemo(() => new Map(catalog.filter(isDerived).map(m => [m.name, m])), [catalog])
  const listed = useMemo(() => {
    const shown = new Set(offered.map(m => m.name))
    const kept = [...names].filter(n => !shown.has(n)).map(n => byName.get(n) ?? { metric_uuid: n, name: n })
    return [...offered, ...kept]
  }, [offered, names, byName])

  if (names.size === 0 && byName.size === 0) return null

  return (
    <>
      <FieldError id={`${id}-error`} error={error} className="field-error-above" />
      <details className="schema-derived">
        <summary className="form-label schema-history-summary" id={id} tabIndex={0} aria-describedby={error ? `${id}-error` : undefined}>
          <IconTag size={13} /> Derived Metrics{' '}
          <span className="section-count">{readOnly ? names.size : `${names.size} of ${listed.length} selected`}</span>
          {counts}
        </summary>
        <p className="form-hint schema-derived-hint">
          {readOnly
            ? 'A device bound to this version gets these. Aber computes them, so no device publishes one.'
            : 'A device bound to this schema gets the ones ticked. Aber computes them from the metrics above.'}
        </p>
        <div className="schema-derived-choice" role="group" aria-label="Derived Metrics" aria-describedby={error ? `${id}-error` : undefined}>
          {readOnly && names.size === 0 ? (
            <p className="form-static form-static-none">This schema names no derived metrics.</p>
          ) : readOnly ? (
            <ul className="schema-editor-list schema-derived-list">
              {[...names].sort().map(name => (
                <li key={name}>
                  <IconCheck size={12} />
                  <span className="mono metric-picker-name">{name}</span>
                  {byName.has(name) && <span className="schema-editor-range">{derivationText(byName.get(name).derivation)}</span>}
                </li>
              ))}
            </ul>
          ) : listed.length === 0 ? (
            <p className="form-static form-static-none">No derived metric is computed from the ticked metrics alone.</p>
          ) : (
            <MetricPicker
              metrics={listed}
              isPicked={m => names.has(m.name)}
              onPick={m => onToggle(m.name)}
              renderNote={m => m.derivation && <span className="metric-picker-fact">{derivationText(m.derivation)}</span>}
              searchLabel={listed.length > SEARCHED_OVER ? 'Search derived metrics' : null}
              standards={false}
              listClass="schema-derived-list"
            />
          )}
        </div>
      </details>
    </>
  )
}
