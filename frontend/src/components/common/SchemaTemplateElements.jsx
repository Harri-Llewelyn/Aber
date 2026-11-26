import React from 'react'
import { IconFileCode } from './Icons'
import { StaticEmpty } from './StaticField'
import { cardinalityLabel } from '../../utils/idtaTemplates'

/**
 * The editor's Template Elements section, under the metrics of a schema built from a submodel template: the
 * elements a metric could fill that no metric here fills, each marked Required where the template requires
 * it. The metrics above say which element each fills. It is closed until it is asked for, as Derived Metrics
 * is, so it takes nothing from the metric list, and its summary says how many elements are filled. What a
 * save would be refused for is said at the Template field, not here.
 *
 * @param {string} id The summary's.
 * @param {object} template What schemaTemplate() says of the form: its title, the elements a metric can fill,
 * those nothing fills and the paths the template requires.
 */
export function SchemaTemplateElements({ id, template }) {
  if (!template?.title) return null
  const { title, fillable, unfilled, required } = template
  return (
    <details className="schema-derived schema-template">
      <summary className="form-label schema-history-summary" id={id} tabIndex={0}>
        <IconFileCode size={13} /> Template Elements{' '}
        <span className="section-count">{`${fillable.length - unfilled.length} of ${fillable.length} filled`}</span>
      </summary>
      <p className="form-hint schema-derived-hint">
        The elements of {title} a metric can fill that no metric here fills. A metric fills one when the
        element&apos;s semantic id is the metric&apos;s own or one of its further ids.
      </p>
      {unfilled.length === 0 ? (
        <StaticEmpty>A metric here fills every element of {title} that a metric can.</StaticEmpty>
      ) : (
        <ul className="schema-editor-list schema-template-list" aria-label={`Elements of ${title} no metric fills`}>
          {unfilled.map(element => (
            <li key={element.path}>
              <span className="mono metric-picker-name">{element.path}</span>
              {required.includes(element.path) && <span className="badge badge-sm badge-warning">Required</span>}
              <span className="schema-editor-range">{cardinalityLabel(element)}</span>
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}
