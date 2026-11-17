import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import data from '../utils/builtInAlerts.generated.json'

/**
 * The Built-in tab's list is the alert rules file, read when the bundle is built. This reads the file
 * again here, with the parser and no help from the generator, and holds the committed JSON to it, rule
 * by rule and in order; and it runs the generator's own --check, which CI runs. A rule added to the
 * file without running scripts/generate-built-in-alerts.mjs fails both.
 */

const ROOT = path.resolve(__dirname, '../../..')
const SOURCE = path.join(ROOT, 'grafana/provisioning/alerting/alert-rules.yaml')
const file = YAML.parse(fs.readFileSync(SOURCE, 'utf8'))
const fileRules = file.groups.flatMap(g => g.rules.map(r => ({ ...r, group: g.name })))

describe('the generated list of built-in alerts', () => {
  it('holds the rules of the file, no more and no fewer, in its order', () => {
    expect(data.rules.map(r => r.uid)).toEqual(fileRules.map(r => r.uid))
    expect(data.rules.length).toBeGreaterThan(40)
    expect(data.groups.map(g => [g.name, g.interval])).toEqual(file.groups.map(g => [g.name, g.interval]))
  })

  it.each(fileRules.map(r => [r.uid, r]))('says %s as the file does', (_, rule) => {
    const built = data.rules.find(r => r.uid === rule.uid)
    expect(built).toMatchObject({
      title: rule.title,
      group: rule.group,
      hold: rule.for,
      severity: rule.labels.severity,
      subject: rule.labels.entity_type ?? 'device',
      labels: rule.labels,
      summary: rule.annotations.summary.trim(),
      evaluator: 'grafana',
    })
    // The queries are the datasources' nodes, as written; the expression nodes are not queries.
    expect(built.queries.map(q => [q.ref, q.datasource, q.text])).toEqual(
      rule.data.filter(n => n.datasourceUid !== '__expr__').map(n => [n.refId, n.datasourceUid, String(n.model.rawSql ?? n.model.expr).trim()])
    )
    // The threshold is the condition's own: its direction and its number.
    const condition = rule.data.find(n => n.refId === rule.condition).model
    if (condition.type === 'threshold') {
      const { type, params } = condition.conditions[0].evaluator
      expect(built.threshold.endsWith(`${type === 'gt' ? 'above' : 'below'} ${params[0]}`)).toBe(true)
    } else {
      expect(condition.type).toBe('math')
      for (const number of condition.expression.match(/\d+(?:\.\d+)?/g)) expect(built.threshold).toContain(number)
    }
  })

  it('gives every rule the words a row and its drawer need: what fires it, first, then the rest', () => {
    for (const rule of data.rules) {
      expect(rule.fires.length, rule.uid).toBeGreaterThan(10)
      expect(rule.description.startsWith(rule.fires), rule.uid).toBe(true)
      expect(rule.queries.length, rule.uid).toBeGreaterThan(0)
      expect(['critical', 'warning', 'info']).toContain(rule.severity)
      expect(['device', 'gateway', 'platform', 'service_identity']).toContain(rule.subject)
      // A Grafana uid, which is how a platform_alerts row names its rule.
      expect(rule.uid).toMatch(/^[A-Za-z0-9_-]{1,40}$/)
    }
    expect(new Set(data.rules.map(r => r.title)).size).toBe(data.rules.length)
  })

  it('is current: the generator, run with --check as CI runs it, finds nothing to write', () => {
    const run = () => execFileSync(process.execPath, [path.join(ROOT, 'scripts/generate-built-in-alerts.mjs'), '--check'], { encoding: 'utf8' })
    expect(run()).toMatch(/is current/)
  })
})
