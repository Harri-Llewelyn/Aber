import React, { useState } from 'react'
import { IconAlertTriangle, IconPlus, IconX } from '../common/Icons'
import { ActionButton } from '../common/ActionButton'
import { Modal } from '../common/Modal'
import { RequiredMark } from '../common/RequiredMark'
import { Tooltip } from '../common/Tooltip'
import { usePendingAction } from '../../hooks/usePendingAction'
import {
  canonicaliseGroup, composeMetricName, groupOptionsByStandard, knownGroupNames, metricNameError
} from '../../utils/metricGroup'
import {
  DERIVATION_KINDS, DERIVED_MAX_INPUTS, buildDerivation, derivationProblem, derivationText, derivedUnit,
  eligibleInputs, nameProblem, stateOptions
} from '../../utils/derivedMetric'

// The "not in the list yet" option of the group picker, as Add Metric has it.
const NEW_GROUP = '__new__'

const BLANK = {
  group: '', newGroup: '', instance: '', leaf: '',
  kind: DERIVATION_KINDS[0].id,
  input: '', states: [], statesText: '',
  inputs: [{ metric: '', sign: 1 }, { metric: '', sign: 1 }],
  description: ''
}

/** The states a free-text field holds: comma separated, trimmed, none empty, each once. */
const parseStates = (text) => [...new Set(text.split(',').map(s => s.trim()).filter(Boolean))]

/**
 * Add Derived Metric: a catalog row whose value Aber computes from other metrics, in the layout of
 * Add Metric. The name is composed from a group, an optional instance and a name, and is as fixed as
 * any metric's; so is the definition. The unit is not asked for: it follows the inputs. `onConfirm`
 * receives `{ name, group, isNewGroup, description, derivation }` and throws the database's refusal,
 * which the dialog shows as it was worded. `declared` is the set of names devices declare that no
 * catalog row has, which the name may not be.
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
  const inputOptions = eligibleInputs(catalog, form.kind)
  const chosenInput = byName.get(form.input)
  const options = form.kind === 'time_in_state' ? stateOptions(chosenInput) : null
  const states = options ? form.states : parseStates(form.statesText)
  const definition = buildDerivation({ ...form, states })
  const inputRows = (form.kind === 'sum' ? form.inputs.map(i => i.metric) : [form.input])
    .map(n => byName.get(n)).filter(Boolean)
  const unit = inputRows.length > 0 && (form.kind !== 'sum' || inputRows.length === form.inputs.length)
    ? derivedUnit(form.kind, inputRows) : { units: null, problem: null }

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

  const changeKind = (kind) => set({ kind, input: '', states: [], statesText: '' })
  const setInputRow = (index, patch) =>
    set({ inputs: form.inputs.map((row, i) => (i === index ? { ...row, ...patch } : row)) })
  const optionLabel = (m) => (m.units ? `${m.name} (${m.units})` : m.name)

  return (
    <Modal
      title="Add Derived Metric"
      icon={<IconPlus size={18} />}
      size="xl"
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

        {form.kind !== 'sum' && (
          <div className="form-group" style={{ flex: '1 1 260px' }}>
            <label className="form-label" htmlFor="derived-input">
              {form.kind === 'counter_rate' ? 'Counter' : 'State Metric'} <RequiredMark />
            </label>
            <Tooltip text={form.kind === 'counter_rate'
              ? 'A numeric metric that counts up and resets to a lower value. Only measured metrics are offered: a derived one cannot be an input.'
              : 'A string or boolean metric. Only measured metrics are offered: a derived one cannot be an input.'}>
              <select
                id="derived-input"
                aria-required="true"
                className="form-control"
                value={form.input}
                onChange={e => set({ input: e.target.value, states: [], statesText: '' })}
              >
                <option value="">— Choose a metric —</option>
                {inputOptions.map(m => <option key={m.metric_uuid} value={m.name}>{optionLabel(m)}</option>)}
              </select>
            </Tooltip>
          </div>
        )}

        {form.kind === 'time_in_state' && form.input && (
          <div className="form-group" style={{ flex: '1 1 100%' }}>
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

        {form.kind === 'sum' && (
          <div className="form-group" style={{ flex: '1 1 100%' }}>
            <span className="form-label" id="derived-inputs-label">Inputs <RequiredMark /></span>
            {form.inputs.map((row, i) => (
              <div key={i} style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px' }}>
                <select
                  aria-label={`Sign of input ${i + 1}`}
                  className="form-control"
                  style={{ flex: '0 0 64px' }}
                  value={row.sign}
                  onChange={e => setInputRow(i, { sign: Number(e.target.value) })}
                >
                  <option value={1}>+</option>
                  <option value={-1}>{'−'}</option>
                </select>
                <select
                  aria-label={`Metric of input ${i + 1}`}
                  aria-required="true"
                  className="form-control"
                  style={{ flex: '1 1 auto' }}
                  value={row.metric}
                  onChange={e => setInputRow(i, { metric: e.target.value })}
                >
                  <option value="">— Choose a metric —</option>
                  {inputOptions.map(m => <option key={m.metric_uuid} value={m.name}>{optionLabel(m)}</option>)}
                </select>
                <Tooltip text="Remove this input">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    aria-label={`Remove input ${i + 1}`}
                    disabled={form.inputs.length <= 2}
                    onClick={() => set({ inputs: form.inputs.filter((_, j) => j !== i) })}
                  >
                    <IconX size={12} />
                  </button>
                </Tooltip>
              </div>
            ))}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={form.inputs.length >= DERIVED_MAX_INPUTS}
              onClick={() => set({ inputs: [...form.inputs, { metric: '', sign: 1 }] })}
            >
              <IconPlus size={12} /> Add input
            </button>
          </div>
        )}

        <div className="form-group" style={{ flex: '0 1 170px' }}>
          <label className="form-label" htmlFor="derived-units">Units</label>
          <Tooltip text="Not chosen: a rate is its counter's unit per hour, a ratio has none, and a sum takes the unit its inputs share.">
            <input id="derived-units" className="form-control" readOnly value={unit.units || 'None'} />
          </Tooltip>
        </div>

        <div className="form-group" style={{ flex: '0 1 140px' }}>
          <label className="form-label" htmlFor="derived-datatype">Sparkplug Datatype</label>
          <Tooltip text="A derived value is computed as a number. Nothing publishes it, so no device encodes it.">
            <input id="derived-datatype" className="form-control" readOnly value="Double" />
          </Tooltip>
        </div>

        <div className="form-group" style={{ flex: '2 1 200px' }}>
          <label className="form-label" htmlFor="derived-description">Description</label>
          <input
            id="derived-description"
            className="form-control"
            value={form.description}
            onChange={e => set({ description: e.target.value })}
            placeholder="What this metric represents"
          />
        </div>
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
