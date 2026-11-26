import React, { useState, useMemo } from 'react'
import { IconFileCode } from '../common/Icons'
import { ActionButton } from '../common/ActionButton'
import { useFormCheck } from '../../hooks/useFormCheck'
import { usePendingAction } from '../../hooks/usePendingAction'
import { datatypeToJsonSchemaType } from '../../utils/sparkplugDatatype'
import { catalogPropertyEntry, isNumericType } from '../../utils/schemaProperty'
import { Modal } from '../common/Modal'
import { NO_RANGE } from '../common/PropertyRange'
import { SchemaEditor, schemaDerived, schemaFields, schemaTemplate, useSchemaForm } from '../common/SchemaEditor'
import { inferSemanticIdType } from '../../utils/standards'
import { templateElementFill, templateList } from '../../utils/idtaTemplates'

/**
 * Build a schema from catalog metrics. Each metric's entry carries its type, and the catalog's
 * description and permitted values (as `enum`); a numeric one takes the range typed beside it. The
 * schema may name derived metrics computed from those. It
 * does this and nothing else: a device is given its schema on the Devices page, where the rest of
 * what a device needs -- its gateway, its cell, its conformance policy -- is also decided.
 *
 * `fromTemplate` makes it Build Schema from Template: a template, from `templates` (the rows of
 * idta_template_elements), is chosen first, or arrives chosen as `initialTemplate`. Choosing one makes its id
 * the semantic id and ticks the metrics that fill its elements, in place of those the last one ticked.
 */
export function SchemaBuilderModal({ catalog, templates = [], fromTemplate = false, initialTemplate = '', onSubmit, onCancel }) {
  // A refusal of the save, as the database worded it. The builder stays open with what was chosen.
  const [error, setError] = useState(null)
  const [submitting, runSubmit] = usePendingAction()

  // A derived metric is not offered among the metrics: nothing publishes it, so a schema does not model it.
  const activeCatalog = useMemo(() => (catalog || []).filter(m => !m.deprecated && !m.derivation), [catalog])

  // The metrics a template's elements tick, and the form with one chosen: its id is the semantic id.
  const tickedBy = (templateId) => Object.keys(templateId ? templateElementFill(templates, templateId, activeCatalog) : {})
  const withTemplate = (f, templateId) => {
    const before = new Set(tickedBy(f.templateId))
    const picked = new Set([...f.picked].filter(n => !before.has(n)))
    for (const name of tickedBy(templateId)) picked.add(name)
    return { templateId, picked, semanticId: templateId, semanticIdType: inferSemanticIdType(templateId) }
  }
  // A template the rows do not hold arrives as none chosen.
  const [form, change] = useSchemaForm(() => (fromTemplate && templates.some(e => e.template_id === initialTemplate)
    ? withTemplate({ picked: new Set(), templateId: '' }, initialTemplate)
    : {}))
  const options = useMemo(() => (fromTemplate ? templateList(templates) : null), [fromTemplate, templates])
  const numericNames = useMemo(
    () => new Set(activeCatalog.filter(m => isNumericType(datatypeToJsonSchemaType(m.datatype))).map(m => m.name)),
    [activeCatalog]
  )
  const takesRange = (name) => numericNames.has(name)

  // No `required`: a DDATA carries only the metrics that changed, so no single payload is the instance
  // JSON Schema's `required` describes. `properties` is what the schema models.
  const buildDefinition = () => {
    const properties = {}
    activeCatalog.filter(m => form.picked.has(m.name)).forEach(m => {
      properties[m.name] = catalogPropertyEntry(m, { range: takesRange(m.name) ? form.ranges[m.name] : undefined })
    })
    return { type: 'object', properties }
  }

  const derived = schemaDerived({ form, catalog, definition: buildDefinition() })
  const template = fromTemplate ? schemaTemplate({ form, elements: templates, catalog }) : null
  const check = useFormCheck(schemaFields('schema-builder', { form, catalog: activeCatalog, takesRange, derived, fromTemplate, template }))

  const buildSchemaPayload = () => {
    return {
      schema_name: form.name,
      description: form.description,
      schema_definition: buildDefinition(),
      ...(form.derived.size > 0 && { derived_metrics: [...form.derived].sort() }),
      // The AAS Submodel this schema corresponds to, if it is a known one (an IDTA submodel
      // template id). Optional: most schemas are local compositions.
      semantic_id: form.semanticId.trim(),
      semantic_id_type: form.semanticIdType,
      ...(fromTemplate && form.templateId && { template_id: form.templateId })
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
      title={fromTemplate ? 'Build Schema from Template' : 'Build Schema from Catalog'}
      icon={<IconFileCode size={18} />}
      size="wide"
      fill
      busy={submitting}
      onClose={onCancel}
      lead={fromTemplate
        ? 'Makes a schema of metrics from the catalog that implements an IDTA submodel template, as version 1 and in force.'
        : 'Makes a schema of metrics from the catalog, as version 1 and in force.'}
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
        derived={{ catalog, offered: derived.offered }}
        template={fromTemplate ? { options, chosen: template, onChoose: id => change(f => withTemplate(f, id)) } : null}
      />
    </Modal>
  )
}
