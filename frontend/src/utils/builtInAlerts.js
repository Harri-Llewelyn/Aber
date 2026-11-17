import data from './builtInAlerts.generated.json'

/*
 * The alerts Aber raises about itself, as the Automations page's Built-in tab lists them. The list is
 * the alert rules file, read when the bundle is built (scripts/generate-built-in-alerts.mjs): the
 * dashboard never asks Grafana for its rules. What is firing is read from platform_alerts by each
 * row's `rule_uid`. Pure, so each rule here is unit-tested.
 */

/** Every rule the release ships, in the file's order: grouped, each group in its own order. */
export const BUILT_IN_RULES = data.rules

/** The groups, in the file's order. */
export const BUILT_IN_GROUPS = data.groups.map(g => g.name)

const byUid = new Map(BUILT_IN_RULES.map(rule => [rule.uid, rule]))

/** One rule by its uid, or null: a rule a site wrote itself, or one a release has retired, is not listed. */
export const builtInRule = (uid) => byUid.get(uid) ?? null

/** What the `entity_type` label says a rule is about, in the words the alert counter uses. */
export const SUBJECT_WORDS = {
  gateway: 'Gateway',
  platform: 'Platform',
  service_identity: 'Machine identity',
  device: 'Device',
}

/** What evaluates a rule. Today Grafana does, for every rule. */
export const EVALUATOR_WORDS = { grafana: 'Grafana' }

/** What a query is written in, by the datasource it reads. */
export const QUERY_SOURCE_WORDS = {
  supabase: 'Platform database, SQL',
  prometheus: 'Prometheus, PromQL',
}

/** Whether the rule is evaluated by Grafana, which is what the drawer's View in Grafana needs. */
export const evaluatedByGrafana = (rule) => rule?.evaluator === 'grafana'

/**
 * The `alertname` label Grafana puts on an instance of a rule it could not evaluate (a datasource
 * that is down, a query that fails). grafana-alert-webhook records one as an alert named "<rule>
 * could not be evaluated" and keeps the labels as sent, so this is how the row is told from the
 * rule's own alert. Mirror check 120 holds the list to the webhook's.
 */
export const NOT_EVALUATED_NAMES = ['DatasourceError', 'DatasourceNoData']

/** Whether a `platform_alerts` row records a rule that could not be evaluated, not the rule's condition. */
export const isNotEvaluated = (row) => NOT_EVALUATED_NAMES.includes(row?.labels?.alertname)

/**
 * What the open rows say of each rule: `Map<uid, { firing, notEvaluated }>`, the instances that are
 * firing and the instances that record an evaluation error. A rule with neither is not in the map,
 * and is not firing: the tab never says OK, because Aber cannot see that Grafana evaluated it.
 */
export function builtInStates(active = []) {
  const states = new Map()
  for (const row of active) {
    if (!row?.rule_uid) continue
    const state = states.get(row.rule_uid) ?? { firing: 0, notEvaluated: 0 }
    if (isNotEvaluated(row)) state.notEvaluated += 1
    else state.firing += 1
    states.set(row.rule_uid, state)
  }
  return states
}

/** Critical first, for sorting by severity. */
export const SEVERITY_RANK = { critical: 3, warning: 2, info: 1 }

/** A hold, `for:` in the file, in words: "5 min", "1 h", or "None" for 0s. */
export function holdWords(hold) {
  const m = /^(\d+)([smh])$/.exec(String(hold ?? ''))
  if (!m) return String(hold ?? '')
  if (Number(m[1]) === 0) return 'None'
  return `${m[1]} ${{ s: 's', m: 'min', h: 'h' }[m[2]]}`
}

/** What a search matches in one rule: its title, uid, group, what it fires on and its subject. */
export const builtInSearchText = (rule) =>
  [rule.title, rule.uid, rule.group, rule.description, SUBJECT_WORDS[rule.subject], rule.severity].join(' ').toLowerCase()

/** A rule's labels as `name=value` pairs, one to a line, as the drawer shows them. */
export const labelsText = (labels = {}) => Object.entries(labels).map(([k, v]) => `${k}=${v}`).join('\n')

/** What an occurrence is about, as the alert counter's row says it: the wire id, or the scope. */
export const occurrenceSubject = (row) =>
  row?.sparkplug_id || (row?.entity_type === 'platform' ? 'Platform-wide' : row?.entity_type === 'service_identity' ? 'Machine identity' : '')
