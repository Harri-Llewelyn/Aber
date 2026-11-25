import React, { useState, useMemo } from 'react'
import { IconFileCode } from '../common/Icons'
import { ActionButton } from '../common/ActionButton'
import { useFormCheck } from '../../hooks/useFormCheck'
import { usePendingAction } from '../../hooks/usePendingAction'
import { datatypeToJsonSchemaType } from '../../utils/sparkplugDatatype'
import { catalogPropertyEntry, isNumericType } from '../../utils/schemaProperty'
import { Modal } from '../common/Modal'
import { NO_RANGE } from '../common/PropertyRange'
import { SchemaEditor, schemaFields, useSchemaForm } from '../common/SchemaEditor'

/**
 * Build a schema from catalog metrics. Each metric's entry carries its type, and the catalog's
 * description and permitted values (as `enum`); a numeric one takes the range typed beside it. It
 * does this and nothing else: a device is given its schema on the Devices page, where the rest of
 * what a device needs -- its gateway, its cell, its conformance policy -- is also decided.
 */
export function SchemaBuilderModal({ catalog, onSubmit, onCancel }) {
  const [form, change] = useSchemaForm()
  // A refusal of the save, as the database worded it. The builder stays open with what was chosen.
  const [error, setError] = useState(null)
  const [submitting, runSubmit] = usePendingAction()

  // A derived metric is not offered: nothing publishes it, so a schema cannot model it.
  const activeCatalog = useMemo(() => (catalog || []).filter(m => !m.deprecated && !m.derivation), [catalog])
  const numericNames = useMemo(
    () => new Set(activeCatalog.filter(m => isNumericType(datatypeToJsonSchemaType(m.datatype))).map(m => m.name)),
    [activeCatalog]
  )
  const takesRange = (name) => numericNames.has(name)

  const check = useFormCheck(schemaFields('schema-builder', { form, catalog: activeCatalog, takesRange }))

  const buildSchemaPayload = () => {
    const properties = {}
    activeCatalog.filter(m => form.picked.has(m.name)).forEach(m => {
      properties[m.name] = catalogPropertyEntry(m, { range: takesRange(m.name) ? form.ranges[m.name] : undefined })
    })
    return {
      schema_name: form.name,
      description: form.description,
      // No `required`: a DDATA carries only the metrics that changed, so no single payload is the
      // instance JSON Schema's `required` describes. `properties` is what the schema models.
      schema_definition: {
        type: 'object',
        properties
      },
      // The AAS Submodel this schema corresponds to, if it is a known one (an IDTA submodel
      // template id). Optional: most schemas are local compositions.
      semantic_id: form.semanticId.trim(),
      semantic_id_type: form.semanticIdType
    }
  }

  const save = () => runSubmit(async () => {
    setError(null)
    try {
      await onSubmit(buildSchemaPayload())
    } catch (err) {
      setError(err.message)
    }
  })

  return (
    <Modal
      title="Build Schema from Catalog"
      icon={<IconFileCode size={18} />}
      size="wide"
      fill
      busy={submitting}
      onClose={onCancel}
      problem={check.problem}
      error={error}
      dismiss="Cancel"
      footer={
        <ActionButton className="btn btn-primary" pending={submitting} pendingLabel="Saving…" onClick={() => check.press(save)}>
          Save Schema
        </ActionButton>
      }
    >
      <SchemaEditor
        idPrefix="schema-builder"
        form={form}
        onChange={change}
        errors={check.errors}
        catalog={activeCatalog}
        rangeOf={name => (takesRange(name) ? form.ranges[name] || NO_RANGE : null)}
      />
    </Modal>
  )
}
