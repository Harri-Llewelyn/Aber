import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  entityUrl, proposalUrl, metricUrl, captureSubjectUrl, captureJobUrl, backupUrl, personUrl, identityUrl, changesByUrl, replayLanesUrl,
  automationUrl, automationsUrl, automationsForEntityUrl, automationForTriggerUrl, alertPage
} from '../routes'

/**
 * A notification about a record links to it (#1019). The bell's list keeps the last 50 messages
 * and is read later, from any page, so "Cell 'Press 3' created" is a link to the cell however soon
 * after the save it is read. Read from the source: every `showToast` call under src/ that is not
 * an error passes `{ to }`, or is listed in NO_LINK with the reason it links nowhere. An error is
 * a failure of what the person just tried, on the form they are still looking at, so it needs no
 * link (one whose fix is elsewhere still passes `to`). Comments are blanked first, so a call
 * quoted in one does not count.
 */
const SRC = path.resolve(__dirname, '..')
const sources = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name)
  if (e.isDirectory()) return e.name === '__tests__' || e.name === 'test' ? [] : sources(p)
  return /\.jsx?$/.test(e.name) ? [p] : []
})

const blankComments = (text) => text
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, c => c.replace(/[^\n]/g, ' '))
  .replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' '))
  .replace(/^[ \t]*\/\/.*$/gm, c => c.replace(/[^\n]/g, ' '))

/**
 * The top-level arguments of the call whose `(` ends just before `start`, as source text. Strings,
 * template literals and their `${}` are stepped over, so a comma or a bracket inside one does not
 * split or end the call.
 */
function callArguments(text, start) {
  const args = []
  const templates = []
  let depth = 0
  let from = start
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (c === "'" || c === '"') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++
    } else if (c === '`' || (c === '}' && templates.length && templates[templates.length - 1] === depth)) {
      if (c === '}') { templates.pop(); depth-- }
      for (i++; i < text.length && text[i] !== '`'; i++) {
        if (text[i] === '\\') i++
        else if (text[i] === '$' && text[i + 1] === '{') { depth++; templates.push(depth); i++; break }
      }
    } else if ('([{'.includes(c)) depth++
    else if (')]}'.includes(c)) {
      if (depth === 0) { args.push(text.slice(from, i)); return args }
      depth--
    } else if (c === ',' && depth === 0) { args.push(text.slice(from, i)); from = i + 1 }
  }
  return args
}

const CALL = /\bshowToast(?:Ref\.current)?(?:\?\.)?\(/g

function notifications() {
  return sources(SRC).flatMap(p => {
    const text = blankComments(fs.readFileSync(p, 'utf8'))
    const file = path.relative(SRC, p).split(path.sep).join('/')
    return [...text.matchAll(CALL)].map(m => {
      const args = callArguments(text, m.index + m[0].length).map(a => a.trim())
      return {
        file,
        line: text.slice(0, m.index).split('\n').length,
        call: args.join(', ').replace(/\s+/g, ' '),
        error: args[1] === "'error'",
        linked: /(^|[{,\s])to\s*[:,}]/.test(args[2] || '')
      }
    })
  })
}

/**
 * Messages that link nowhere, by file and a piece of the call, each with its reason. An entry
 * here is a decision: a message about a record that still exists does not belong in this list.
 */
const NO_LINK = [
  { file: 'components/modals/BugReportModal.jsx', piece: 'Redirected to GitHub', why: 'hands off to GitHub, in a new tab' },
  { file: 'components/modals/ChangePasswordModal.jsx', piece: 'Your password is changed', why: 'the person\'s own password: nothing to open' },
  { file: 'components/modals/DeviceExportModal.jsx', piece: 'Bundle downloaded for', why: 'a file, in the downloads' },
  { file: 'components/modals/DeviceExportModal.jsx', piece: 'Bundle exported for', why: 'a file, in the downloads' },
  { file: 'components/modals/DeviceExportModal.jsx', piece: '${label} exported for', why: 'a file, in the downloads' },
  { file: 'components/modals/DeviceExportModal.jsx', piece: 'unmappedWarning,', why: 'given only to a reader who cannot open the Metrics page' },
  { file: 'components/modals/GatewayBundleModal.jsx', piece: 'Bundle downloaded for', why: 'a file, in the downloads' },
  { file: 'components/tabs/SchemasTab.jsx', piece: 'Downloaded ${filename}', why: 'a file, in the downloads' },
  { file: 'components/tabs/ArchivesTab.jsx', piece: 'permanently deleted', why: 'the record is gone' },
  { file: 'components/tabs/CaptureTab.jsx', piece: 'Capture deleted.', why: 'the capture and its record are gone' },
  { file: 'components/tabs/AccessControlTab.jsx', piece: '” deleted`', why: 'the read-only broker account is gone' },
  { file: 'components/tabs/DevicesTab.jsx', piece: "Quarantined device '${item.asset_name}' rejected", why: 'a rejected device is deleted' },
  { file: 'components/tabs/SchemasTab.jsx', piece: 'discarded', why: 'a discarded draft is deleted' },
  { file: 'components/tabs/AutomationsTab.jsx', piece: 'Exported ${', why: 'a file, in the downloads' },
]

describe('a notification about a record links to it', () => {
  const all = notifications()
  const unlinked = all.filter(n => !n.error && !n.linked)
  const listed = (n) => NO_LINK.find(e => e.file === n.file && n.call.includes(e.piece))

  it('finds the calls, so a change to how they are written cannot leave this checking nothing', () => {
    expect(all.length).toBeGreaterThanOrEqual(150)
    expect(all.filter(n => n.linked).length).toBeGreaterThanOrEqual(60)
  })

  it.each(unlinked.map(n => [`${n.file}:${n.line}`, n]))('%s passes `to`, or NO_LINK says why not', (_, n) => {
    expect(listed(n), `${n.call}\nlinks nowhere: give it { to } (routes.js), or add it to NO_LINK with the reason`).toBeTruthy()
  })

  // A recording, a playback and the stop of either open the job; a download and an upload, which
  // make no job, open the subject whose capture it is; a deleted capture is in NO_LINK.
  it.each([
    ['Recording ', "captureJobUrl('capture'"],
    ['Stopping. The recorder finishes', "captureJobUrl('capture'"],
    ['That capture had already finished', "captureJobUrl('capture'"],
    ['Playing back the capture', "captureJobUrl('playback'"],
    ['Stopping the playback', "captureJobUrl('playback'"],
    ['That playback had already finished', "captureJobUrl('playback'"],
    ['Downloading the capture of', 'captureSubjectUrl('],
    ['Uploaded ', 'captureSubjectUrl('],
  ])('the Capture page says %s and links to %s', (piece, link) => {
    const call = all.find(n => n.file === 'components/tabs/CaptureTab.jsx' && n.call.includes(piece))
    expect(call, `no showToast call says ${piece}`).toBeTruthy()
    expect(call.call).toContain(link)
  })

  it.each(NO_LINK.map(e => [`${e.file}: ${e.piece}`, e]))('NO_LINK %s still names a call', (_, e) => {
    expect(unlinked.some(n => listed(n) === e)).toBe(true)
  })
})

/**
 * Where the links go. Each address is one the page at the other end reads: the parameter that
 * opens a record's drawer or filters to it, and the tab it is on. Checked against the page's
 * source too, so a page that renames its parameter breaks here rather than in a link that quietly
 * opens nothing.
 */
describe('where a notification links to', () => {
  it('names each record by the address its page opens it from', () => {
    expect(entityUrl('cell', 'c-1')).toBe('/cells?search=c-1')
    expect(entityUrl('area', 'a-1')).toBe('/areas?search=a-1')
    expect(entityUrl('device', 'd-1')).toBe('/devices?search=d-1')
    expect(entityUrl('gateway', 'g-1')).toBe('/gateways?search=g-1')
    expect(entityUrl('schema', 's-1')).toBe('/schemas?search=s-1')
    expect(entityUrl('capture', 'x')).toBeNull()
    expect(entityUrl('cell', undefined)).toBeNull()
  })

  it('puts a proposal, a metric and a capture subject on the tab that holds them', () => {
    expect(proposalUrl('p-1')).toBe('/approvals?proposal=p-1')
    expect(proposalUrl('p-1', true)).toBe('/approvals/decided?proposal=p-1')
    expect(metricUrl('m-1')).toBe('/metrics?metric=m-1')
    expect(metricUrl('m-1', true)).toBe('/metrics/deprecated?metric=m-1')
    expect(captureSubjectUrl('gateway', 'g-1')).toBe('/capture?subject=g-1')
    expect(captureSubjectUrl('device', 'd-1')).toBe('/capture/device?subject=d-1')
    // The lanes Prepare replay lanes made, on the Devices page, which hides lanes by default.
    expect(replayLanesUrl('g-1')).toBe('/devices?gateway=g-1&replay=1')
  })

  it('opens a recording or a playback on the tab of its kind, narrowed to that job', () => {
    const job = '7d2c0000-0000-4000-8000-000000000001'
    expect(captureJobUrl('capture', job)).toBe(`/capture/captures?job=${job}`)
    expect(captureJobUrl('playback', job)).toBe(`/capture/playbacks?job=${job}`)
    // With no job known, the tab of its kind and no narrowing.
    expect(captureJobUrl('capture', undefined)).toBe('/capture/captures')
    expect(captureJobUrl('playback', '')).toBe('/capture/playbacks')
  })

  it('opens the job a capture or playback alert names, on its kind\'s tab, narrowed to it', () => {
    const job = '7d2c0000-0000-4000-8000-000000000002'
    const alert = (rule_uid, label) => ({ rule_uid, labels: { alertname: 'Capture or Playback Failed', job: label }, entity_type: 'gateway' })
    for (const rule of ['aber-job-failed', 'aber-job-stuck']) {
      expect(alertPage(alert(rule, `capture job ${job}`))).toEqual({ to: `/capture/captures?job=${job}`, title: 'Show this capture on the Capture page' })
      expect(alertPage(alert(rule, `playback job ${job}`))).toEqual({ to: `/capture/playbacks?job=${job}`, title: 'Show this playback on the Capture page' })
    }
    // Only a label composed as platform_health_rows() composes it, on a rule that names a job.
    expect(alertPage(alert('aber-job-failed', 'recording job x'))).toBeNull()
    expect(alertPage(alert('aber-job-failed', `capture job ${job} extra`))).toBeNull()
    expect(alertPage(alert('aber-gateway-stale', `capture job ${job}`))).toBeNull()
    // The playback worker not reporting has no job to name: the Playbacks tab.
    expect(alertPage({ rule_uid: 'aber-playback-worker-stale' }).to).toBe('/capture/playbacks')
  })

  it('opens an automation by its id, and the list on what applies to one device or one alert', () => {
    expect(automationsUrl()).toBe('/automations')
    expect(automationUrl('lathe-3-spindle-hot')).toBe('/automations/lathe-3-spindle-hot')
    // /automations/new is the starter, so an automation whose id is new says it is that one.
    expect(automationUrl('new')).toBe('/automations/new?open=1')
    const device = '3f1c9a6e-2b4d-4e8a-9c71-5d0e8f2a4b13'
    expect(automationsForEntityUrl(device)).toBe(`/automations?entity=${device}`)
    const trigger = 'aaaaaaaa-0000-4000-8000-000000000001'
    expect(automationForTriggerUrl(trigger)).toBe(`/automations?trigger=${trigger}`)
  })

  it('opens the automation that raised an alert, found by the trigger its fingerprint names', () => {
    const trigger = 'aaaaaaaa-0000-4000-8000-000000000001'
    const raised = { fingerprint: `condition:${trigger}:3f1c9a6e-2b4d-4e8a-9c71-5d0e8f2a4b13:Spindle/BEARING_TEMPERATURE`, entity_type: 'device', sparkplug_id: 'devlathe' }
    expect(alertPage(raised)).toEqual({ to: `/automations?trigger=${trigger}`, title: 'Show the automation that raised this alert' })
    // Only a fingerprint composed as automation_alert_fingerprint() composes it.
    expect(alertPage({ fingerprint: 'condition:not-a-trigger:x:y', entity_type: 'device' })).toBeNull()
    expect(alertPage({ fingerprint: 'grafana-rule-1', entity_type: 'device' })).toBeNull()
    expect(alertPage({ fingerprint: `${trigger}:x`, entity_type: 'device' })).toBeNull()
    expect(alertPage(undefined)).toBeNull()
  })

  it('finds a backup run, a person and a machine identity', () => {
    expect(backupUrl()).toBe('/backups')
    expect(backupUrl('b-1')).toBe('/backups?run=b-1')
    // A person by their user id, which outlives a change of address, and no search: People opens
    // the drawer for whoever the list holds, filtered or not.
    const id = 'a0000000-0000-4000-8000-000000000003'
    expect(personUrl(id)).toBe(`/access-control/people?person=${id}`)
    expect(personUrl(id, true)).toBe(`/access-control/people?removed=1&person=${id}`)
    expect(changesByUrl(id)).toBe(`/audit-trail?changed_by=${id}`)
    expect(identityUrl('Line 4 report', true)).toBe('/access-control/identities?search=Line+4+report&withdrawn=1')
  })

  const source = (file) => fs.readFileSync(path.join(SRC, file), 'utf8')
  // A page's tab ids live in navigation.jsx, which the sidebar and the tab bar both read (#900), so
  // a tab file proves it reads the link's tab by importing its list from there.
  const tabLists = source('navigation.jsx')
  it.each([
    ['components/tabs/ApprovalsTab.jsx', ["useUrlState('proposal'"], 'decided'],
    ['components/tabs/MetricsTab.jsx', ["useUrlState('metric'"], 'deprecated'],
    ['components/tabs/CaptureTab.jsx', ["useUrlState('subject'"], 'device'],
    // A job's link names the tab of its kind and the job, which the tab lists alone.
    ['components/tabs/CaptureTab.jsx', ["useUrlState('job'", "useUrlState('search'"], 'captures'],
    ['components/tabs/CaptureTab.jsx', ["useUrlState('job'"], 'playbacks'],
    ['components/tabs/BackupsTab.jsx', ["useUrlState('run'"], null],
    ['components/tabs/DevicesTab.jsx', ["useUrlList('gateway'", "useUrlState('replay'"], null],
    ['components/tabs/PeopleSection.jsx', ["useUrlState('removed'", "useUrlState('search'", "useUrlState('person'"], null],
    ['components/tabs/AccessControlTab.jsx', ["useUrlState('withdrawn'"], 'identities'],
    // The list reads the filter its device's link writes, and the alert's link names a trigger.
    ['components/tabs/AutomationsTab.jsx', ["useUrlState('entity'", "params.get('trigger')"], null],
  ])('%s reads what its link writes', (file, needles, tab) => {
    const text = source(file)
    for (const needle of needles) expect(text).toContain(needle)
    if (tab) {
      expect(text).toMatch(/\w+_TABS\b[^\n]*from '\.\.\/\.\.\/navigation'/)
      expect(tabLists).toContain(`id: '${tab}'`)
    }
  })
})
