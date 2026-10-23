import React, { useState } from 'react'
import { api } from '../../api'
import { IconCheck } from '../common/Icons'
import { Modal } from '../common/Modal'
import { Badge } from '../common/Badge'
import { samplePayload } from '../../utils/payloadConformance'
import { plural } from '../../utils/format'

/** The version's own modelled metrics, each with a value of its type, as the textarea shows it. */
const sampleText = (schemas, uuid) =>
  JSON.stringify(samplePayload(schemas.find(s => s.schema_uuid === uuid)?.schema_definition), null, 2)

// What ingestion does with the reading behind one finding.
const STATUS = {
  dropped: { tone: 'danger', label: 'Not Stored', title: 'Ingestion skips this metric under either policy' },
  enforced: { tone: 'warning', label: 'Dropped Under Enforce', title: 'Recorded under Audit. A device set to Enforce drops this reading.' },
  recorded: { tone: 'neutral', label: 'Recorded', title: 'Recorded in the Audit Trail. The reading is still stored.' }
}
const statusOf = (finding) => STATUS[finding.dropped ? 'dropped' : finding.enforced ? 'enforced' : 'recorded']

const metricsWhere = (findings, test) => new Set(findings.filter(test).map(f => f.metric)).size

function Summary({ result }) {
  if (result.error) {
    return (
      <div className="callout callout-danger" role="status">
        <span><strong>Not Validated:</strong> {result.error}</span>
      </div>
    )
  }
  const { findings } = result
  if (findings.length === 0) {
    return (
      <div className="callout callout-success" role="status">
        <span><strong>No Findings:</strong> ingestion would store every metric in this payload and record nothing.</span>
      </div>
    )
  }
  const drops = metricsWhere(findings, f => f.enforced)
  const lost = metricsWhere(findings, f => f.dropped)
  return (
    <div className={`callout ${drops || lost ? 'callout-danger' : 'callout-warning'}`} role="status">
      <span>
        <strong>{plural(findings.length, 'Finding')}:</strong> ingestion records each one in the Audit Trail.
        {drops > 0 && <> A device set to Enforce drops {plural(drops, 'reading')}.</>}
        {lost > 0 && <> {plural(lost, 'metric')} with no value {lost === 1 ? 'is' : 'are'} never stored.</>}
        {!drops && !lost && <> The readings are stored under either policy.</>}
      </span>
    </div>
  )
}

/**
 * `initialSchemaUuid` is the schema the caller already had in hand. The select stays even then:
 * "does this payload match v1 or v2?" is the question this modal answers best, and it is the only
 * place two versions can be tested against the same payload.
 */
export function ValidatePayloadModal({ schemas, initialSchemaUuid, onClose }) {
  // Falls back to the first schema rather than to nothing: opened without a target -- which no
  // call site does today -- an empty select would submit a validation against no schema at all.
  const [selectedSchemaUuid, setSelectedSchemaUuid] = useState(
    initialSchemaUuid || schemas[0]?.schema_uuid || ''
  )
  const [payloadText, setPayloadText] = useState(() => sampleText(schemas, selectedSchemaUuid))
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)

  // The sample follows the version only while it is untouched, so an edited payload can still be
  // tested against two versions.
  const handleSchemaChange = (uuid) => {
    if (payloadText === sampleText(schemas, selectedSchemaUuid)) setPayloadText(sampleText(schemas, uuid))
    setSelectedSchemaUuid(uuid)
    setResult(null)
  }

  const handleValidate = async () => {
    let parsed
    try {
      parsed = JSON.parse(payloadText)
    } catch (e) {
      setResult({ error: `The payload is not valid JSON: ${e.message}` })
      return
    }
    setLoading(true)
    setResult(null)
    try {
      setResult(await api.post('/api/v1/schemas/validate', {
        schema_uuid: selectedSchemaUuid,
        payload: parsed
      }))
    } catch (e) {
      setResult({ error: e.message })
    } finally {
      setLoading(false)
    }
  }

  const findings = result?.findings || []
  const notChecked = result?.notChecked || []
  const absent = result?.absent || []

  return (
    <Modal
      title="Validate Payload"
      icon={<IconCheck size={18} />}
      size="md"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          <button className="btn btn-primary" onClick={handleValidate} disabled={loading}>
            {loading ? 'Validating…' : 'Validate Payload'}
          </button>
        </>
      }
    >
      <div className="form-group">
        <label className="form-label" htmlFor="validate-schema">Select Target Schema Definition</label>
        <select id="validate-schema" className="form-control" value={selectedSchemaUuid} onChange={e => handleSchemaChange(e.target.value)}>
          {schemas.map(s => <option key={s.schema_uuid} value={s.schema_uuid}>{s.schema_name}</option>)}
        </select>
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="validate-payload">Candidate Telemetry JSON Payload</label>
        <textarea
          id="validate-payload"
          className="form-control mono validate-payload-input"
          value={payloadText}
          onChange={e => setPayloadText(e.target.value)}
        />
        <div className="form-hint">
          One DDATA payload: metric names and their values. It opens with every metric this version models.
        </div>
      </div>

      {result && <Summary result={result} />}

      {findings.length > 0 && (
        <ul className="validate-findings">
          {findings.map((f, i) => (
            <li key={`${f.metric}-${f.code}-${i}`}>
              <div className="validate-finding-head">
                <span className="mono validate-finding-metric">{f.metric}</span>
                <Badge tone={statusOf(f).tone} size="sm" title={statusOf(f).title}>{statusOf(f).label}</Badge>
              </div>
              <div><span className="mono">{f.code}</span>: {f.detail}</div>
            </li>
          ))}
        </ul>
      )}

      {findings.some(f => f.code === 'unmodelled_metric') && (
        <div className="form-hint">
          Judged against this version alone. A device with several schemas is judged against all of them,
          so another of its schemas may model a metric listed as unmodelled here.
        </div>
      )}

      {notChecked.length > 0 && (
        <div className="form-hint validate-payload-hint">
          Not checked here: the pattern for{' '}
          {notChecked.map((f, i) => (
            <React.Fragment key={`${f.metric}-${i}`}>
              {i > 0 && ', '}<span className="mono">{f.metric}</span> (<span className="mono">{f.pattern}</span>)
            </React.Fragment>
          ))}
          . Ingestion checks a pattern with Python&apos;s regular expressions, and this dialog cannot
          read {notChecked.length === 1 ? 'this one' : 'these'} the same way.
        </div>
      )}

      {absent.length > 0 && (
        <div className="form-hint validate-payload-hint">
          Not in this payload: {absent.map((name, i) => (
            <React.Fragment key={name}>{i > 0 && ', '}<span className="mono">{name}</span></React.Fragment>
          ))}. That is normal: a device reports by exception, so a DDATA carries only the metrics that changed.
        </div>
      )}
    </Modal>
  )
}
