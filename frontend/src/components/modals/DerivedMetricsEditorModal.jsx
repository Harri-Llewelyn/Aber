import React, { useId, useMemo, useState } from 'react'
import SCHEMA from '../../../public/json-schema/derived-metrics.schema.json'
import { AutomationEditor } from '../common/AutomationEditor'
import { ActionButton } from '../common/ActionButton'
import CopyableId from '../common/CopyableId'
import { DropZone } from '../common/DropZone'
import { Modal } from '../common/Modal'
import { IconPencil, IconPlus, IconUpload } from '../common/Icons'
import { RequiredMark } from '../common/RequiredMark'
import { ApplyDerivedMetricsModal } from './ApplyDerivedMetricsModal'
import { useFormCheck } from '../../hooks/useFormCheck'
import { useYamlFile } from '../../hooks/useYamlFile'
import { buildFacts } from '../../utils/automationEditorHelp'
import { DERIVED_METRICS_FILE_MAX_BYTES, derivedSchemaComment } from '../../utils/derivedMetricsFile'

/**
 * The Derived tab's YAML editor, in a dialog: derived metrics written, or a file read, as the
 * Automations page's editor shows them, with completion and hover from this site's catalogue and the
 * published JSON Schema, and a mark on each line the database refused. **Apply Derived Metrics** checks
 * the text and shows what it would do before anything is written (ApplyDerivedMetricsModal); a refused
 * line is marked here when that dialog is closed. Nothing is saved by closing it.
 *
 * An upload's first step is the file, in a drop zone, and the editor opens on its text. Another file
 * chosen there opens in place of the one before, and of what was typed over it.
 *
 * @param {boolean} [uploads] Asks for a file. Otherwise the editor opens empty, for a new one.
 * @param {Array} catalog The metric catalog as the page reads it, for completion and hover.
 * @param {Function} showToast
 * @param {Function} onApplied Called with the results once the derived metrics are applied; the caller closes the dialog.
 * @param {Function} onClose
 */
export function DerivedMetricsEditorModal({ uploads = false, catalog, showToast, onApplied, onClose }) {
  const uid = useId()
  const upload = useYamlFile({ maxBytes: DERIVED_METRICS_FILE_MAX_BYTES, holds: 'a file of derived metrics' })
  const { file } = upload
  const source = file?.name ?? null
  const editing = !uploads || file !== null
  // What was typed and which lines were refused, of the file they are about: another file opens over both.
  const [edited, setEdited] = useState({ file: null, text: '', refusals: null })
  const { text, refusals } = edited.file === file ? edited : { text: file.text, refusals: null }
  const [checking, setChecking] = useState(false)
  const facts = useMemo(() => buildFacts({ catalog }), [catalog])
  const origin = typeof window === 'undefined' ? '' : window.location.origin

  // The editor draws its text in a shadow root, so its field is named by the problem line alone.
  const check = useFormCheck(editing
    ? { text: { missing: text.trim() === '' && 'Write at least one derived metric' } }
    : { file: { id: `${uid}-file`, missing: upload.missing } })

  // Marks of a refusal are for the text it refused; any edit makes them stale.
  const change = (next) => setEdited({ file, text: next, refusals: null })

  return (
    <>
      <Modal
        title={source ? 'Edit Derived Metrics' : uploads ? 'Upload Derived Metrics' : 'New Derived Metrics in YAML'}
        subject={source}
        icon={source ? <IconPencil size={18} /> : uploads ? <IconUpload size={18} /> : <IconPlus size={18} />}
        size="wide"
        lead={editing
          ? 'Write each derived metric under a dash, with its name, kind and inputs. Nothing is applied until you check the file and confirm what it would do. A definition is fixed once saved, so only a description can change.'
          : 'Opens a file of derived metrics in the editor. Nothing is applied until you check the file and confirm what it would do. A definition is fixed once saved, so only a description can change.'}
        onClose={onClose}
        problem={check.problem}
        dismiss="Cancel"
        footer={(
          <ActionButton
            className="btn btn-primary"
            title="Check the YAML, and see what applying it would do, before anything is written"
            onClick={() => check.press(() => setChecking(true))}
          >
            Apply Derived Metrics
          </ActionButton>
        )}
      >
        {uploads && (
          <div className="form-group">
            <label className="form-label" id={`${uid}-file-label`} htmlFor={`${uid}-file`}>File <RequiredMark /></label>
            <DropZone
              id={`${uid}-file`}
              labelledBy={`${uid}-file-label`}
              required
              prompt="Drop a file of derived metrics here, or click to choose one"
              {...upload.zone}
              error={check.errors.file}
              testId="derived-metrics-file"
            />
          </div>
        )}
        {editing && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <AutomationEditor
              key={file?.turn ?? 'new'}
              value={text}
              onChange={change}
              facts={facts}
              refusals={refusals}
              schema={SCHEMA}
              label="Derived metrics YAML"
            />
            <p className="automation-note">
              A definition is fixed once saved, and the unit comes from the inputs, so a file gives neither a unit nor a datatype.
              The file says what is saved, so leaving out a description clears the one a metric has.
              Press <code>Ctrl Space</code> for completion.
            </p>
            <div className="automation-schema-line">
              <span>In VS Code, start your own file with this line to get the same help:</span>
              <CopyableId value={derivedSchemaComment(origin)} label="schema line" onNotify={showToast} truncate="end" />
            </div>
          </div>
        )}
      </Modal>
      {checking && (
        <ApplyDerivedMetricsModal
          text={text}
          source={source}
          showToast={showToast}
          onChecked={refused => setEdited({ file, text, refusals: refused })}
          onApplied={onApplied}
          onClose={() => setChecking(false)}
        />
      )}
    </>
  )
}
