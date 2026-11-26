import React, { useCallback, useMemo, useState } from 'react'
import { api } from '../../api'
import { REALTIME_ENABLED, grafanaAlertUrl, refreshInterval } from '../../constants'
import { useUrlState } from '../../hooks/useUrlState'
import { usePolling } from '../../hooks/usePolling'
import { useRealtimeTable } from '../../hooks/useRealtimeTable'
import { useSortableRows } from '../../hooks/useTableSort'
import { Badge } from '../common/Badge'
import { BuiltInStateBadge } from '../common/BuiltInStateBadge'
import { Callout } from '../common/Callout'
import { ClearFilters } from '../common/ClearFilters'
import { rowSelectHandler } from '../common/ContextPanel'
import { EmptyState } from '../common/EmptyState'
import { IconExternalLink, IconZap } from '../common/Icons'
import { OverflowText } from '../common/OverflowText'
import { SearchInput } from '../common/SearchInput'
import { ColumnHeader, SortHeader } from '../common/SortHeader'
import { Tooltip } from '../common/Tooltip'
import { BuiltInAlertDrawer } from './BuiltInAlertDrawer'
import { severityOf } from '../../utils/alertHistory'
import { holdSeconds } from '../../utils/automations'
import {
  BUILT_IN_RULES, EVALUATOR_WORDS, SEVERITY_RANK, SUBJECT_WORDS, builtInRule, builtInSearchText, builtInStates, grafanaEvaluatesBuiltIns,
  holdWords,
} from '../../utils/builtInAlerts'

/** The sortable columns; with none chosen, the rules are in the file's order, group by group. */
const COLUMNS = {
  title: { type: 'text', value: r => r.title },
  group: { type: 'text', value: r => r.group },
  severity: { type: 'number', value: r => SEVERITY_RANK[r.severity] ?? 0 },
  subject: { type: 'text', value: r => SUBJECT_WORDS[r.subject] ?? r.subject },
  hold: { type: 'number', value: r => holdSeconds(r.hold) ?? 0 },
  state: { type: 'number', value: r => (r.state ? (r.state.firing > 0 ? 2 : 0) + (r.state.notEvaluated > 0 ? 1 : 0) : 0) },
}

/**
 * The Built-in tab of the Automations page: every alert Aber raises about itself, read from the file
 * that provisions the rules (builtInAlerts.generated.json), never from Grafana. Read-only, and every
 * role reads it. Each row says what the rule is about, how long it holds, what fires it and what
 * evaluates it, and its state: how many instances are firing, whether a rule could not be evaluated,
 * or "Not firing", never "OK". A row opens the rule's drawer, `?rule=<uid>`, which is where every
 * surface that shows a platform alert leads.
 *
 * @param {node} head The page's heading and tab strip, which the Automations tab owns.
 */
export function BuiltInAlerts({ head, showToast }) {
  const [search, setSearch] = useUrlState('search', '')
  const [ruleUid, setRuleUid] = useUrlState('rule', '')
  // The alerts firing now: null until the first read, and again whenever a read has failed.
  const [active, setActive] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async (signal) => {
    try {
      setActive(await api.readBuiltInAlerts({ signal }))
      setError(null)
    } catch (e) {
      // An old answer is not kept: a rule is not said to be quiet on what was true before the failure.
      setActive(null)
      setError(e.message || 'The alerts that are firing could not be read.')
      throw e
    }
  }, [])
  usePolling(load, refreshInterval())
  // An alert firing or resolving changes a row's state; the polling is the reconciliation.
  useRealtimeTable('platform_alerts', load, { enabled: REALTIME_ENABLED })

  const states = useMemo(() => (active ? builtInStates(active) : null), [active])
  const entries = useMemo(() => BUILT_IN_RULES.map(rule => ({
    ...rule,
    // undefined while the first read is out, null once a read has failed.
    state: states ? states.get(rule.uid) ?? { firing: 0, notEvaluated: 0 } : error ? null : undefined,
    searchText: builtInSearchText(rule),
  })), [states, error])
  const needle = search.trim().toLowerCase()
  const shown = useMemo(() => entries.filter(e => !needle || e.searchText.includes(needle)), [entries, needle])
  const [rows, sort] = useSortableRows(shown, COLUMNS)

  const selected = ruleUid ? entries.find(e => e.uid === ruleUid) ?? null : null
  // A uid no built-in rule has: a rule a site wrote for itself, or one a release retired.
  const unlisted = ruleUid !== '' && !builtInRule(ruleUid)
  const firingIds = useMemo(() => (active ? new Set(active.map(a => a.id)) : null), [active])
  // With the drawer open, the columns it repeats are dropped so the table fits beside it.
  const compact = Boolean(selected)

  const selectRow = (e) => setRuleUid(current => (current === e.uid ? '' : e.uid))
  const rowProps = (e) => ({
    className: `row-selectable${ruleUid === e.uid ? ' row-selected' : ''}`,
    tabIndex: 0,
    onClick: rowSelectHandler(() => selectRow(e)),
    onKeyDown: (ev) => {
      if (ev.target !== ev.currentTarget || (ev.key !== 'Enter' && ev.key !== ' ')) return
      ev.preventDefault()
      selectRow(e)
    },
  })

  const clear = () => setSearch('')
  const filterCount = needle ? 1 : 0

  return (
    <div className="page-layout page-fill">
      <div className="page-main">
        <div className="card card-fill">
          {head}
          <div className="filter-bar">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search built-in alerts…"
              ariaLabel="Search the built-in alerts by name, uid, group or what fires them"
            />
            <div className="filter-bar-actions">
              <ClearFilters count={filterCount} onClear={clear} />
            </div>
          </div>

          {error && (
            <Callout tone="warning" role="status">
              Which alerts are firing could not be read, so no rule says it is not firing: {error}
            </Callout>
          )}
          {unlisted && (
            <Callout tone="info" role="status">
              This release has no built-in alert with the uid <span className="mono">{ruleUid}</span>. A rule
              written on this site, or one a release has retired, is not listed here.
              {grafanaEvaluatesBuiltIns && (
                <>
                  {' '}
                  {/* A real anchor, as the drawer's action is: where a site's own rules live. */}
                  <a href={grafanaAlertUrl({ rule_uid: ruleUid })} target="_blank" rel="noopener noreferrer">
                    View in Grafana <IconExternalLink size={11} aria-hidden="true" />
                  </a>
                  , where a site's own rules live.
                </>
              )}
            </Callout>
          )}

          {rows.length === 0 ? (
            <EmptyState
              icon={<IconZap size={36} />}
              filtered={entries.length > 0}
              message="This release ships no built-in alerts."
              filteredMessage={<>No built-in alert matches <strong>{search.trim()}</strong>.</>}
            />
          ) : (
            <div className="table-wrap">
              <table>
                <caption className="sr-only">Built-in alerts, with what each is about, what fires it and whether it is firing</caption>
                <thead>
                  <tr>
                    <SortHeader sort={sort} column="title" title="The alert's name, with its rule's uid under it">Alert</SortHeader>
                    {!compact && <SortHeader sort={sort} column="group" title="The group of rules it belongs to">Group</SortHeader>}
                    <SortHeader sort={sort} column="severity" title="How urgent it is, as the rule sets it">Severity</SortHeader>
                    {!compact && <SortHeader sort={sort} column="subject" title="What the alert is about: a gateway, a machine identity's token, or the platform as a whole">Subject</SortHeader>}
                    {!compact && <SortHeader sort={sort} column="hold" title="How long the condition must hold before the alert fires. None fires at the first check.">Hold</SortHeader>}
                    {!compact && <ColumnHeader title="What fires it, in words. Open the alert to read its query and threshold.">Fires when</ColumnHeader>}
                    {!compact && <ColumnHeader title="What checks the rule">Evaluated by</ColumnHeader>}
                    <SortHeader sort={sort} column="state" title="How many instances are firing now. Not firing is not a promise: Aber cannot see that the rule was checked.">State</SortHeader>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(e => (
                    <tr key={e.uid} {...rowProps(e)}>
                      <td>
                        <strong>{e.title}</strong>
                        <div className="cell-meta mono">{e.uid}</div>
                      </td>
                      {!compact && <td className="cell-meta">{e.group}</td>}
                      <td><Badge size="sm" tone={severityOf(e.severity).tone}>{severityOf(e.severity).label}</Badge></td>
                      {!compact && <td className="cell-meta">{SUBJECT_WORDS[e.subject] ?? e.subject}</td>}
                      {!compact && <td className="cell-meta">{holdWords(e.hold)}</td>}
                      {!compact && (
                        <td className="automation-summary">
                          <Tooltip text={e.fires} describe={false}>
                            <span tabIndex={0} className="automation-summary-text"><OverflowText>{e.fires}</OverflowText></span>
                          </Tooltip>
                        </td>
                      )}
                      {!compact && <td className="cell-meta">{EVALUATOR_WORDS[e.evaluator] ?? e.evaluator}</td>}
                      <td><BuiltInStateBadge rule={e} state={e.state} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <BuiltInAlertDrawer
        rule={selected}
        state={selected?.state}
        firingIds={firingIds}
        onClose={() => setRuleUid('')}
        onCopy={showToast}
      />
    </div>
  )
}
