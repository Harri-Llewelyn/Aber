import React, { useState } from 'react'
import { IconAlertTriangle, IconPlus, IconX } from '../common/Icons'
import { ActionButton } from '../common/ActionButton'
import { MetricPicker } from '../common/MetricPicker'
import { Modal } from '../common/Modal'
import { RequiredMark } from '../common/RequiredMark'
import { Tooltip } from '../common/Tooltip'
import { usePendingAction } from '../../hooks/usePendingAction'
import {
  canonicaliseGroup, composeMetricName, groupOptionsByStandard, knownGroupNames, metricNameError
} from '../../utils/metricGroup'
import {
  DERIVATION_KINDS, DERIVED_MAX_INPUTS, buildDerivation, derivationProblem, derivationText, describeUnit,
  eligibleInputs, nameProblem, stateOptions
} from '../../utils/derivedMetric'

// The "not in the list yet" option of the group picker, as Add Metric has it.
const NEW_GROUP = '__new__'

const BLANK = {
  group: '', newGroup: '', instance: '', leaf: '',
  kind: DERIVATION_KINDS[0].id,
  input: '', states: [], statesText: '',
  inputs: [],
  description: ''
}

/** What the picker's section is called, and what is asked of it, for each kind. */
const INPUT_LABELS = { counter_rate: 'Counter', time_in_state: 'State Metric', sum: 'Inputs' }
const INPUT_ASKS = {
  counter_rate: 'A numeric metric that counts up and resets to a lower value. Choosing another replaces it.',
  time_in_state: 'A string or boolean metric. Choosing another replaces it.',
  sum: `Two to ${DERIVED_MAX_INPUTS} numeric metrics, in the order you choose them. Each is added unless you press − beside it.`
}

/** The states a free-text field holds: comma separated, trimmed, none empty, each once. */
const parseStates = (text) => [...new Set(text.split(',').map(s => s.trim()).filter(Boolean))]

/**
 * Add Derived Metric: a catalog row whose value Aber computes from other metrics, in the layout of
 * Add Metric. The inputs are chosen from the schema builder's metric list (common/MetricPicker), which
 * offers only what the kind can read. The name is composed from a group, an optional instance and a
 * name, and is as fixed as any metric's; so is the definition. The unit and the datatype are not
 * asked for, and are shown as the facts they are: the unit follows the inputs. `onConfirm` receives
 * `{ name, group, isNewGroup, description, derivation }` and throws the database's refusal, which the
 * dialog shows as it was worded. `declared` is the set of names devices declare that no catalog row
 * has, which the name may not be.
 */
export function AddDerivedMetricModal({ catalog, groups, declared, onConfirm, onCancel }) {
  const [form, setForm] = useState(BLANK)
  const [error, setError] = useState(null)
  const [adding, runAdd] = usePendingAction()
  const set = (patch) => setForm(f => ({ ...f, ...patch }))

  const known = knownGroupNames(groups, catalog)
  const buckets = groupOptionsByStandard(groups, catalog)
  const group = form.group === NEW_GROUP ? canonicaliseGroup(form.newGroup, known) : form.group
  const name = composeMetricName(group, form.instance, form.leaf)
  const caseCollision = form.group === NEW_GROUP && form.newGroup.trim() !== '' && group !== form.newGroup.trim()

  const byName = new Map(catalog.map(m => [m.name, m]))
  const isSum = form.kind === 'sum'
  const inputOptions = eligibleInputs(catalog, form.kind)
  const chosenNames = isSum ? form.inputs.map(i => i.metric) : (form.input ? [form.input] : [])
  const chosenInput = byName.get(form.input)
  const options = form.kind === 'time_in_state' ? stateOptions(chosenInput) : null
  const states = options ? form.states : parseStates(form.statesText)
  const definition = buildDerivation({ ...form, states })
  const inputRows = chosenNames.map(n => byName.get(n)).filter(Boolean)

  const nameError = form.leaf.trim() !== '' ? metricNameError(name) : null
  const nameHeld = nameError ? null : nameProblem(name, catalog, declared)
  const definitionProblem = derivationProblem({ ...form, states }, catalog)
  const problem = form.leaf.trim() === '' ? 'Give the metric a name'
    : form.group === NEW_GROUP && form.newGroup.trim() === '' ? 'Name the new group'
      : definitionProblem
  const blocked = !!(problem || nameError || nameHeld)

  const add = () => runAdd(async () => {
    setError(null)
    try {
      await onConfirm({
        name, group, isNewGroup: !!group && !known.includes(group), description: form.description,
        derivation: definition
      })
    } catch (err) {
      setError(err.message)
    }
  })

  // What each kind has chosen differs in kind, so a new kind starts with nothing chosen.
  const changeKind = (kind) => set({ kind, input: '', states: [], statesText: '', inputs: [] })

  // One input replaces the last; a sum's are added in the order chosen, each starting as a plus.
  const pick = (m) => {
    if (!isSum) {
      if (form.input !== m.name) set({ input: m.name, states: [], statesText: '' })
      return
    }
    set({
      inputs: chosenNames.includes(m.name)
        ? form.inputs.filter(i => i.metric !== m.name)
        : [...form.inputs, { metric: m.name, sign: 1 }]
    })
  }
  const drop = (metric) => {
    if (isSum) set({ inputs: form.inputs.filter(i => i.metric !== metric) })
    else set({ input: '', states: [], statesText: '' })
  }
  const setSign = (metric, sign) =>
    set({ inputs: form.inputs.map(i => (i.metric === metric ? { ...i, sign } : i)) })

  const atLimit = isSum && form.inputs.length >= DERIVED_MAX_INPUTS

  return (
    <Modal
      title="Add Derived Metric"
      icon={<IconPlus size={18} />}
      size="wide"
      onClose={adding ? () => {} : onCancel}
      problem={problem}
      error={error}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onCancel} disabled={adding}>Cancel</button>
          <ActionButton
            className="btn btn-primary"
            pending={adding}
            pendingLabel="Adding…"
            disabled={blocked}
            title={problem ?? nameError ?? nameHeld ?? undefined}
            onClick={add}
          >
            Add Derived Metric
          </ActionButton>
        </>
      }
    >
      <div className="metric-form">
        <div className="form-group" style={{ flex: '0 1 170px' }}>
          <label className="form-label" htmlFor="derived-group">Group</label>
          <Tooltip text="The component the metric belongs to. It is the first segment of its name.">
            <select
              id="derived-group"
              className="form-control"
              value={form.group}
              onChange={e => set({ group: e.target.value })}
            >
              <option value="">— No group —</option>
              {buckets.map(bucket => (
                <optgroup key={bucket.label} label={`${bucket.label} (${bucket.names.length})`}>
                  {bucket.names.map(g => <option key={g} value={g}>{g}</option>)}
                </optgroup>
              ))}
              <option value={NEW_GROUP}>+ New group…</option>
            </select>
          </Tooltip>
        </div>

        {form.group === NEW_GROUP && (
          <div className="form-group" style={{ flex: '0 1 170px' }}>
            <label className="form-label" htmlFor="derived-new-group">New Group Name <RequiredMark /></label>
            <Tooltip text="One segment of the name, so it cannot contain a slash.">
              <input
                id="derived-new-group"
                aria-required="true"
                className="form-control"
                value={form.newGroup}
                onChange={e => set({ newGroup: e.target.value.replace(/\//g, '') })}
                placeholder="e.g. Controller"
              />
            </Tooltip>
          </div>
        )}

        <div className="form-group" style={{ flex: '0 1 110px' }}>
          <label className="form-label" htmlFor="derived-instance">Instance</label>
          <Tooltip text="Which one, when the component occurs more than once: the axis name, the spindle number. Blank if only one.">
            <input
              id="derived-instance"
              className="form-control"
              value={form.instance}
              onChange={e => set({ instance: e.target.value.replace(/\//g, '') })}
              placeholder="e.g. C"
            />
          </Tooltip>
        </div>

        <div className="form-group" style={{ flex: '1 1 200px' }}>
          <label className="form-label" htmlFor="derived-name">Metric Name <RequiredMark /></label>
          <Tooltip text="What the value is called, such as PARTS_PER_HOUR. No device publishes it, and it cannot change once the metric exists.">
            <input
              id="derived-name"
              aria-required="true"
              className="form-control"
              value={form.leaf}
              onChange={e => set({ leaf: e.target.value.replace(/\//g, '') })}
              placeholder="e.g. PARTS_PER_HOUR"
              aria-invalid={nameHeld ? true : undefined}
            />
          </Tooltip>
          {nameHeld && <p className="form-hint hint-danger" role="alert">{nameHeld}</p>}
        </div>

        <div className="form-group" style={{ flex: '1 1 180px' }}>
          <label className="form-label" htmlFor="derived-kind">Kind <RequiredMark /></label>
          <Tooltip text={DERIVATION_KINDS.find(k => k.id === form.kind)?.hint}>
            <select
              id="derived-kind"
              aria-required="true"
              className="form-control"
              value={form.kind}
              onChange={e => changeKind(e.target.value)}
            >
              {DERIVATION_KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}
            </select>
          </Tooltip>
        </div>
      </div>

      {/* The schema builder's metric list, offering only what this kind can read: measured metrics,
          not derived and not deprecated, of the right datatype. The search and the filter narrow
          what is listed, never what is chosen. */}
      <div className="form-group" role="group" aria-labelledby="derived-inputs-label">
        <span className="form-label" id="derived-inputs-label">
          {INPUT_LABELS[form.kind]} <RequiredMark />
          <span className="section-count">{chosenNames.length} selected</span>
        </span>
        <p className="form-hint" style={{ marginTop: 0 }}>{INPUT_ASKS[form.kind]}</p>
        <MetricPicker
          key={form.kind}
          metrics={inputOptions}
          single={!isSum}
          isPicked={m => chosenNames.includes(m.name)}
          isDisabled={() => atLimit}
          onPick={pick}
          showUnits
          listStyle={{ flex: 'none', height: '220px' }}
          emptyText="No measured metric in the catalog can be an input of this kind."
        />
        {atLimit && <p className="form-hint">A sum takes at most {DERIVED_MAX_INPUTS} inputs.</p>}
      </div>

      <div className="form-group">
        <span className="form-label" id="derived-chosen-label">Chosen{isSum ? ', in the order picked' : ''}</span>
        {chosenNames.length === 0 ? (
          <p className="form-hint" style={{ marginTop: 0 }}>Nothing chosen yet.</p>
        ) : (
          <div role="list" aria-labelledby="derived-chosen-label" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
            {chosenNames.map(metric => {
              const row = byName.get(metric)
              const sign = isSum ? form.inputs.find(i => i.metric === metric)?.sign : null
              return (
                <div
                  key={metric}
                  role="listitem"
                  style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px', borderBottom: '1px solid var(--border)' }}
                >
                  {isSum && (
                    <span role="group" aria-label={`Sign of ${metric}`} style={{ display: 'inline-flex', gap: '2px' }}>
                      <Tooltip text="Add its value to the total">
                        <button
                          type="button"
                          className={`btn btn-sm ${sign === 1 ? 'btn-primary' : 'btn-ghost'}`}
                          aria-pressed={sign === 1}
                          aria-label={`Add ${metric}`}
                          onClick={() => setSign(metric, 1)}
                        >
                          +
                        </button>
                      </Tooltip>
                      <Tooltip text="Subtract its value from the total">
                        <button
                          type="button"
                          className={`btn btn-sm ${sign === -1 ? 'btn-primary' : 'btn-ghost'}`}
                          aria-pressed={sign === -1}
                          aria-label={`Subtract ${metric}`}
                          onClick={() => setSign(metric, -1)}
                        >
                          {'−'}
                        </button>
                      </Tooltip>
                    </span>
                  )}
                  <span className="mono" style={{ fontSize: '12px' }}>{metric}</span>
                  {row?.units && <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{row.units}</span>}
                  <Tooltip text="Remove it from the choice">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ marginLeft: 'auto' }}
                      aria-label={`Remove ${metric}`}
                      onClick={() => drop(metric)}
                    >
                      <IconX size={12} />
                    </button>
                  </Tooltip>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {form.kind === 'time_in_state' && form.input && (
        <div className="form-group">
          <span className="form-label" id="derived-states-label">States That Count <RequiredMark /></span>
          {options ? (
            <div role="group" aria-labelledby="derived-states-label" style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
              {options.map(state => (
                <label key={state} style={{ display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px' }}>
                  <input
                    type="checkbox"
                    checked={form.states.includes(state)}
                    onChange={e => set({
                      states: e.target.checked ? [...form.states, state] : form.states.filter(s => s !== state)
                    })}
                  />
                  <span className="mono">{state}</span>
                </label>
              ))}
            </div>
          ) : (
            <Tooltip text="The values that count as being in the state, separated by commas. This metric lists no permitted values, so a misspelling is not caught.">
              <input
                id="derived-states"
                aria-labelledby="derived-states-label"
                aria-required="true"
                className="form-control"
                value={form.statesText}
                onChange={e => set({ statesText: e.target.value })}
                placeholder="e.g. ACTIVE, READY"
              />
            </Tooltip>
          )}
        </div>
      )}

      {/* Facts nobody chooses, as Edit Metric shows a name and a datatype it cannot change: the
          unit follows the inputs, and a derived value is a Double. */}
      <div className="form-group metric-edit-facts">
        <div>
          <div className="form-label">Units</div>
          <div>{describeUnit(form.kind, inputRows)}</div>
        </div>
        <div>
          <div className="form-label">Sparkplug Datatype</div>
          <div>Double</div>
        </div>
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="derived-description">Description</label>
        <input
          id="derived-description"
          className="form-control"
          value={form.description}
          onChange={e => set({ description: e.target.value })}
          placeholder="What this metric represents"
        />
      </div>

      {/* The name is as fixed as any metric's, and so is the definition: a change is a new metric. */}
      <div className="form-hint">
        Aber will compute <span className="mono">{name || '…'}</span> as{' '}
        <strong>{definitionProblem ? '…' : derivationText(definition)}</strong>. No device publishes it, it carries no
        semantic id, and neither its name nor its definition can be changed once it exists: a changed
        definition is a new derived metric, and this one is deprecated.
      </div>

      {nameError && (
        <div className="callout callout-danger">
          <IconAlertTriangle size={13} className="callout-icon" />
          <span>{nameError}</span>
        </div>
      )}

      {caseCollision && (
        <div className="callout callout-warning">
          <IconAlertTriangle size={13} className="callout-icon" />
          <span>
            Group <span className="mono">{form.newGroup.trim()}</span> already exists as{' '}
            <span className="mono">{group}</span> — that spelling will be used, so the two do not fork.
          </span>
        </div>
      )}
    </Modal>
  )
}
