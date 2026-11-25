import React, { useMemo, useState } from 'react'
import SCHEMA from '../../../public/json-schema/derived-metrics.schema.json'
import { AutomationEditor } from '../common/AutomationEditor'
import { ActionButton } from '../common/ActionButton'
import CopyableId from '../common/CopyableId'
import { Modal } from '../common/Modal'
import { IconTag } from '../common/Icons'
import { ApplyDerivedMetricsModal } from './ApplyDerivedMetricsModal'
import { useFormCheck } from '../../hooks/useFormCheck'
import { buildFacts } from '../../utils/automationEditorHelp'
import { derivedSchemaComment } from '../../utils/derivedMetricsFile'

/**
 * The Derived tab's YAML editor, in a dialog: derived metrics written, or a file read, as the
 * Automations page's editor shows them, with completion and hover from this site's catalogue and the
 * published JSON Schema, and a mark on each line the database refused. **Apply Derived Metrics** checks
 * the text and shows what it would do before anything is written (ApplyDerivedMetricsModal); a refused
 * line is marked here when that dialog is closed. Nothing is saved by closing it. The text starts as
 * `text`: a file's, or empty for a new file.
 *
 * @param {string} text What the editor opens with.
 * @param {string} [source] The uploaded file's name, which the preview and the toast repeat; none for a new file.
 * @param {Array} catalog The metric catalog as the page reads it, for completion and hover.
 * @param {Function} showToast
 * @param {Function} onApplied Called with the results once the derived metrics are applied; the caller closes the dialog.
 * @param {Function} onClose
 */
export function DerivedMetricsEditorModal({ text: initial, source = null, catalog, showToast, onApplied, onClose }) {
  const [text, setText] = useState(initial)
  const [refusals, setRefusals] = useState(null)
  const [checking, setChecking] = useState(false)
  const facts = useMemo(() => buildFacts({ catalog }), [catalog])
  const origin = typeof window === 'undefined' ? '' : window.location.origin

  // The editor draws its text in a shadow root, so the one field is named by the problem line alone.
  const check = useFormCheck({ text: { missing: text.trim() === '' && 'Write at least one derived metric' } })

  const change = (next) => {
    setText(next)
    // Marks of a refusal are for the text it refused; any edit makes them stale.
    setRefusals(null)
  }

  return (
    <>
      <Modal
        title={source ? `Edit ${source}` : 'New Derived Metrics in YAML'}
        icon={<IconTag size={18} />}
        size="wide"
        lead="Write each derived metric under a dash, with its name, kind and inputs. Nothing is applied until you check the file and confirm what it would do. A definition is fixed once saved, so only a description can change."
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <AutomationEditor
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
      </Modal>
      {checking && (
        <ApplyDerivedMetricsModal
          text={text}
          source={source}
          showToast={showToast}
          onChecked={setRefusals}
          onApplied={onApplied}
          onClose={() => setChecking(false)}
        />
      )}
    </>
  )
}
