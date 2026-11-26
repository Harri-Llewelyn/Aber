import React from 'react'
import {
  IDTA_ATTRIBUTION, IDTA_LICENCE_URL, TEMPLATES_LABEL, cardinalityLabel, elementDepth, elementKey, elementName,
  elementTooltip, elementType, templateSections
} from '../../utils/idtaTemplates'
import CopyableId from './CopyableId'
import { ActionButton } from './ActionButton'
import { IconFileCode } from './Icons'
import { RouteLink } from './RouteLink'
import { schemaFromTemplateUrl } from '../../routes'

/**
 * A template's elements, a row each, in the template's order: the name stepped in under the element it is
 * inside, its type, how many its parent holds, its semantic id and the further ones, and under the name what
 * the template says of it and the example it gives. `sr-only` says in words what the step shows.
 */
function TemplateElements({ template, items, onNotify }) {
  return (
    <>
      <p className="template-about">
        Template id <CopyableId value={template.id} label="template id" onNotify={onNotify} truncate="start" />
      </p>
      <ul className="template-elements">
        {items.map(({ id, name, element }) => (
          <li key={id} className="template-element" style={{ '--template-depth': elementDepth(element) }}>
            <div className="template-element-name">
              <span className="mono">{name}</span>
              {element.parent_path && <span className="sr-only">, inside {element.parent_path}</span>}
              {element.definition && <p>{element.definition}</p>}
              {element.example_value && <p>Example: <span className="mono">{element.example_value}</span></p>}
            </div>
            <span className="cell-meta">{elementType(element)}</span>
            <span className="cell-meta">{cardinalityLabel(element)}</span>
            <span className="template-element-id">
              {element.semantic_id
                ? <CopyableId
                    value={element.semantic_id}
                    label={`semantic id (${element.semantic_id_type})`}
                    onNotify={onNotify}
                    truncate="start"
                  />
                : <span className="cell-meta">—</span>}
              {(element.supplemental_semantic_ids || []).map(further => (
                <span key={further} className="template-element-further">
                  <span className="cell-meta">further</span>
                  <CopyableId value={further} label="further semantic id" onNotify={onNotify} truncate="start" />
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}

/**
 * A template's act, at the end of its heading: Build Schema, a link to Build Schema from Template on the
 * Schemas page with the template chosen. A role that may not build a schema sees it greyed, with why.
 */
function BuildSchemaAction({ template, deniedTitle }) {
  const label = <><IconFileCode size={12} /> Build Schema</>
  if (deniedTitle) {
    return <ActionButton className="btn btn-ghost btn-sm vocab-section-action" permitted={false} deniedTitle={deniedTitle}>{label}</ActionButton>
  }
  return (
    <RouteLink
      className="btn btn-ghost btn-sm vocab-section-action"
      to={schemaFromTemplateUrl(template.id)}
      title={`Open Build Schema from Template on the Schemas page, with ${template.name} ${template.version} chosen`}
    >
      {label}
    </RouteLink>
  )
}

/**
 * The Templates tab of the Vocabulary page: the IDTA submodel templates Aber seeds, one section each, with
 * every element under the one it is inside. It is for looking up: nothing here starts a metric or is edited.
 * A template's Build Schema opens Build Schema from Template with it chosen, where Use on another tab starts a
 * catalog metric; `deniedTitle` says why a role may not. A search keeps what a matching element is inside, so
 * it is shown where it belongs. The tab credits IDTA under CC BY 4.0, as the licence asks.
 */
export function idtaTemplateTab({ elements, onNotify, deniedTitle = null }) {
  const sections = templateSections(elements).map(s => ({
    ...s,
    items: s.entries.map(element => ({
      id: elementKey(element.template_id, element.path), name: elementName(element), element
    }))
  }))
  const items = new Map(sections.flatMap(s => s.items).map(item => [item.id, item]))

  return {
    id: TEMPLATES_LABEL,
    label: TEMPLATES_LABEL,
    hint: 'IDTA submodel templates: the elements an Asset Administration Shell submodel of that kind holds, how many of each, and the semantic id each carries.',
    subtitle: 'What each IDTA template asks a submodel to hold, not what a device publishes.',
    searchPlaceholder: 'Search template elements…',
    sections,
    tooltipFor: item => elementTooltip(item.element),
    idFor: item => (item.element.semantic_id ? { label: 'Semantic ID', value: item.element.semantic_id } : null),
    searchTextFor: item => [...(item.element.supplemental_semantic_ids || []), elementType(item.element)].join(' '),
    parentOf: item => items.get(elementKey(item.element.template_id, item.element.parent_path)),
    renderItems: section => <TemplateElements template={section.template} items={section.items} onNotify={onNotify} />,
    actionFor: section => <BuildSchemaAction template={section.template} deniedTitle={deniedTitle} />,
    notice: (
      <>
        {IDTA_ATTRIBUTION}{' '}
        <a href={IDTA_LICENCE_URL} target="_blank" rel="noopener noreferrer">CC BY 4.0</a>.
      </>
    )
  }
}
