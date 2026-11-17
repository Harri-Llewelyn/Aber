import React, { useEffect, useState } from 'react'
import { api } from '../../api'
import { grafanaAlertUrl } from '../../constants'
import { ContextPanel } from '../common/ContextPanel'
import { Badge } from '../common/Badge'
import { BuiltInStateBadge } from '../common/BuiltInStateBadge'
import { RouteLink } from '../common/RouteLink'
import { Tooltip } from '../common/Tooltip'
import { IconBell, IconExternalLink, IconHelp } from '../common/Icons'
import { openHelpAt } from '../../help/openHelp'
import { AUTOMATIONS_TABS } from '../../navigation'
import { slugify } from '../../help/syntax'
import { ALERTS_PATH, severityOf } from '../../utils/alertHistory'
import { formatDateTime, formatDuration, formatRelative } from '../../utils/format'
import {
  EVALUATOR_WORDS, QUERY_SOURCE_WORDS, evaluatedByGrafana, holdWords, isNotEvaluated, labelsText, occurrenceSubject,
} from '../../utils/builtInAlerts'

/** The help page with a section for each built-in alert, by the rule's title: the Built-in tab's own. */
export const BUILT_IN_HELP_FILE = `pages/${AUTOMATIONS_TABS.find(t => t.id === 'built-in').help}`

/** A rule's query or queries, as the file writes them, each under what runs it. */
function Queries({ queries }) {
  return (
    <div className="built-in-queries">
      {queries.map(q => (
        <div key={q.ref} className="built-in-query">
          <div className="built-in-query-label">{q.ref} · {QUERY_SOURCE_WORDS[q.datasource] ?? q.datasource}</div>
          {/* Scrolls inside the drawer rather than widen it, so it takes focus for a keyboard. */}
          <pre className="built-in-pre mono" tabIndex={0}>{q.text}</pre>
        </div>
      ))}
    </div>
  )
}

/**
 * A rule's newest occurrences, read when the drawer opens and again when the rule's count of firing
 * instances changes. `firingIds` is the ids of the rows firing now, or null when they could not be
 * read: a row is then firing by its own status.
 */
function Occurrences({ uid, version, firingIds }) {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    const controller = new AbortController()
    api.readBuiltInOccurrences(uid, { signal: controller.signal }).then(
      found => { setRows(found); setError(null) },
      e => { if (!controller.signal.aborted) setError(e.message || 'They could not be read.') }
    )
    return () => controller.abort()
  }, [uid, version])

  return (
    <section className="built-in-occurrences" aria-label="Recent occurrences">
      <div className="context-panel-section-label">Recent occurrences</div>
      {error && rows === null ? <div className="context-field-empty">{`They could not be read: ${error}`}</div>
        : rows === null ? <div className="context-field-empty">Reading…</div>
          : rows.length === 0 ? <div className="context-field-empty">No alert from this rule is on record</div>
            : (
              <ul className="built-in-occurrence-list">
                {rows.map(row => {
                  const firing = row.status === 'firing' && (!firingIds || firingIds.has(row.id))
                  const subject = occurrenceSubject(row)
                  const length = row.ends_at ? formatDuration((Date.parse(row.ends_at) - Date.parse(row.starts_at)) / 1000) : null
                  return (
                    <li key={row.id} className="built-in-occurrence">
                      <div className="built-in-occurrence-head">
                        <Badge size="sm" tone={firing ? severityOf(row.severity).tone : 'neutral'}>{firing ? 'Firing' : 'Resolved'}</Badge>
                        {isNotEvaluated(row) && <Badge size="sm" tone="warning">Could not be evaluated</Badge>}
                        {subject && <span className="built-in-occurrence-subject mono">{subject}</span>}
                      </div>
                      <div className="built-in-occurrence-meta">
                        Started <Tooltip text={formatDateTime(row.starts_at)}><span tabIndex={0}>{formatRelative(row.starts_at)}</span></Tooltip>
                        {firing ? ', still firing' : length ? `, lasted ${length}` : ''}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
      <RouteLink to={ALERTS_PATH} className="built-in-occurrences-link" title="Every alert that fired in the last 24 hours, from every rule">Alert history</RouteLink>
    </section>
  )
}

/**
 * One built-in rule's drawer, beside the Built-in tab's table: the rule as its file writes it, then
 * its recent occurrences, a link to its help entry, and View in Grafana while Grafana evaluates it.
 * That action is the one place in the dashboard that builds a Grafana address for a platform alert;
 * every other surface opens this drawer instead.
 *
 * @param {object} rule One entry of BUILT_IN_RULES, or null when the drawer is closed.
 *
 * @param {object} state The rule's entry of builtInStates(), or null when the open alerts are unread.
 *
 * @param {Set} firingIds The ids of the firing rows, or null when unread.
 */
export function BuiltInAlertDrawer({ rule, state, firingIds, onClose, onCopy }) {
  const fields = rule ? [
    { label: 'Rule UID', value: rule.uid, mono: true, copyable: true },
    { label: 'Description', value: rule.description, full: true },
    {
      label: 'Query',
      value: <Queries queries={rule.queries} />,
      full: true,
      help: 'Read-only: the query as the rule file writes it. Grafana runs it every minute.',
    },
    {
      label: 'Threshold',
      value: rule.threshold,
      mono: true,
      full: true,
      help: 'last(A) is the newest value the query named A returns. The alert fires when this holds for the hold below.',
    },
    { label: 'Hold', value: holdWords(rule.hold), help: 'How long the condition must stay true before the alert fires. None fires at the first check.' },
    {
      label: 'Labels',
      value: <div className="built-in-labels mono">{labelsText(rule.labels).split('\n').map(line => <div key={line}>{line}</div>)}</div>,
      full: true,
      help: 'Each alert instance carries these. The entity_type says what it is about, and severity how urgent it is.',
    },
    {
      label: 'Summary',
      value: rule.summary,
      full: true,
      help: 'The sentence the alert carries. Where it holds {{ }}, Grafana fills in a value when it fires.',
    },
    { label: 'Group', value: rule.group },
    { label: 'Evaluated by', value: EVALUATOR_WORDS[rule.evaluator] ?? rule.evaluator },
  ] : []

  const actions = rule ? [
    {
      label: 'View Help',
      icon: <IconHelp size={13} />,
      primary: true,
      title: 'What this alert means and what to check first',
      onClick: () => openHelpAt(BUILT_IN_HELP_FILE, slugify(rule.title)),
    },
    evaluatedByGrafana(rule) && {
      label: 'View in Grafana',
      icon: <IconExternalLink size={13} />,
      href: grafanaAlertUrl({ rule_uid: rule.uid }),
      title: 'Open this rule in Grafana, in a new tab. Its state history is there.',
    },
  ].filter(Boolean) : []

  return (
    <ContextPanel
      open={Boolean(rule)}
      onClose={onClose}
      type="ALERT"
      subject="rule"
      onCopy={onCopy}
      title={rule?.title || ''}
      icon={<IconBell size={16} />}
      subtitle={rule && (
        <span className="built-in-subtitle">
          <Badge tone={severityOf(rule.severity).tone} size="sm">{severityOf(rule.severity).label}</Badge>
          <BuiltInStateBadge rule={rule} state={state} />
        </span>
      )}
      fields={fields}
      beforeActions={rule && <Occurrences key={rule.uid} uid={rule.uid} version={`${state?.firing}:${state?.notEvaluated}`} firingIds={firingIds} />}
      actions={actions}
    />
  )
}
