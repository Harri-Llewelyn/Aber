import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  entityUrl, proposalUrl, metricUrl, captureSubjectUrl, backupUrl, personUrl, identityUrl
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
  { file: 'components/modals/TelemetryExportModal.jsx', piece: 'Exported ${rows.length}', why: 'a file, in the downloads' },
  { file: 'components/tabs/SchemasTab.jsx', piece: 'Downloaded ${filename}', why: 'a file, in the downloads' },
  { file: 'components/tabs/ArchivesTab.jsx', piece: 'permanently deleted', why: 'the record is gone' },
  { file: 'components/tabs/CaptureTab.jsx', piece: 'Capture deleted.', why: 'the capture is gone' },
  { file: 'components/tabs/AccessControlTab.jsx', piece: '” deleted`', why: 'the read-only broker account is gone' },
  { file: 'components/tabs/DevicesTab.jsx', piece: "Quarantined device '${item.asset_name}' rejected", why: 'a rejected device is deleted' },
  { file: 'components/tabs/SchemasTab.jsx', piece: 'discarded', why: 'a discarded draft is deleted' },
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
  })

  it('finds a backup run, a person and a machine identity', () => {
    expect(backupUrl()).toBe('/backups')
    expect(backupUrl('b-1')).toBe('/backups?run=b-1')
    expect(personUrl('op@site.test')).toBe('/access-control/people?search=op%40site.test&person=op%40site.test')
    expect(personUrl('op@site.test', true)).toBe('/access-control/people?search=op%40site.test&removed=1&person=op%40site.test')
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
    ['components/tabs/BackupsTab.jsx', ["useUrlState('run'"], null],
    ['components/tabs/PeopleSection.jsx', ["useUrlState('removed'", "useUrlState('search'", "useUrlState('person'"], null],
    ['components/tabs/AccessControlTab.jsx', ["useUrlState('withdrawn'"], 'identities'],
  ])('%s reads what its link writes', (file, needles, tab) => {
    const text = source(file)
    for (const needle of needles) expect(text).toContain(needle)
    if (tab) {
      expect(text).toMatch(/\w+_TABS\b[^\n]*from '\.\.\/\.\.\/navigation'/)
      expect(tabLists).toContain(`id: '${tab}'`)
    }
  })
})
