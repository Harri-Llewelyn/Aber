import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * An action a person takes that writes an Audit Trail row ends with a success toast, and so with an
 * entry in the bell's history. Read from the source, as notificationLinks.test.js reads its calls:
 *
 * 1. What writes a row, from the migrations (the last definition of each function): the functions
 *    that INSERT INTO audit_trail, the tables whose triggers run one, the functions that write those
 *    tables or call those functions, and the edge functions that do either.
 * 2. What reaches them from the dashboard: each method of `apiMethods` in api.js, and each branch of
 *    its get/post/put/delete routers, that calls such a function, writes such a table or fetches
 *    such an edge function; GoTrue's own writes (GOTRUE_WRITES); and the few calls made outside
 *    api.js.
 * 3. Every call of one of those under src/ reaches a `showToast` that can be a success after it, in
 *    the function that makes the call and outside a `catch`. Or TOASTED_BY names the call that
 *    toasts for it, or NO_TOAST gives the reason it cannot.
 *
 * The unit is the call, not the rows it writes: one action that writes ten rows toasts once.
 */
const SRC = path.resolve(__dirname, '..')
const REPO = path.resolve(SRC, '../..')
const MIGRATIONS = path.join(REPO, 'supabase/migrations')
const EDGE_FUNCTIONS = path.join(REPO, 'supabase/functions')

const read = (p) => fs.readFileSync(p, 'utf8')
const sources = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name)
  if (e.isDirectory()) return e.name === '__tests__' || e.name === 'test' ? [] : sources(p)
  return /\.jsx?$/.test(e.name) ? [p] : []
})
const relative = (p) => path.relative(SRC, p).split(path.sep).join('/')
const escape = (s) => s.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')

// --- The schema ----------------------------------------------------------------------------------

const sqlWithoutComments = (sql) => sql.replace(/--[^\n]*/g, '')

/**
 * Functions the reading below counts as writing the trail that write no row, each with its reason:
 * a trigger that fires on their table but records only some changes.
 */
const WRITES_NO_ROW = [
  { name: 'set_own_picture', why: "person_profiles' trigger records a change of display name, and this changes the picture alone" },
]

/** Each function's last definition, the triggers left standing, and what writes the trail. */
function auditWriters() {
  const bodies = new Map()
  const triggers = new Map()
  for (const file of fs.readdirSync(MIGRATIONS).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort()) {
    const sql = read(path.join(MIGRATIONS, file))
    for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.(\w+)\s*\(/gi)) {
      const header = sql.slice(m.index, sql.indexOf(';', m.index))
      const tag = header.match(/\bAS\s+(\$\w*\$)/i)
      if (!tag) continue
      const start = m.index + tag.index + tag[0].length
      bodies.set(m[1], sqlWithoutComments(sql.slice(start, sql.indexOf(tag[1], start))))
    }
    for (const m of sql.matchAll(/DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?public\.(\w+)/gi)) bodies.delete(m[1])
    for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(\w+)[^;]*?\sON\s+(\w+\.)?(\w+)[^;]*?EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(?:public\.)?(\w+)\s*\(/gi)) {
      triggers.set(`${m[2] || 'public.'}${m[3]} ${m[1]}`, m[4])
    }
    for (const m of sql.matchAll(/DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?(\w+)\s+ON\s+(\w+\.)?(\w+)/gi)) {
      triggers.delete(`${m[2] || 'public.'}${m[3]} ${m[1]}`)
    }
  }

  const writers = new Set([...bodies].filter(([, b]) => /INSERT\s+INTO\s+(?:public\.)?audit_trail\b/i.test(b)).map(([n]) => n))
  const tables = new Set([...triggers].filter(([, fn]) => writers.has(fn)).map(([key]) => key.split(' ')[0]))
  const named = [...tables].map(t => (t.startsWith('public.') ? `(?:public\\.)?${escape(t.slice('public.'.length))}` : escape(t)))
  const writesTable = new RegExp(`\\b(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(?:ONLY\\s+)?(?:${named.join('|')})\\b`, 'i')

  // A function that writes an audited table, or calls one that writes the trail, writes it too.
  const functions = new Set(writers)
  for (let grew = true; grew;) {
    grew = false
    const calls = new RegExp(`(?:\\bpublic\\.|[^\\w.])(?:${[...functions].map(escape).join('|')})\\s*\\(`, 'i')
    for (const [name, body] of bodies) {
      if (!functions.has(name) && (writesTable.test(body) || calls.test(body))) { functions.add(name); grew = true }
    }
  }
  const derived = new Set(functions)
  for (const e of WRITES_NO_ROW) functions.delete(e.name)
  return { writers, tables, functions, derived }
}

const schema = auditWriters()

/** A statement's text, from `from` to its `;`. */
const statementAt = (text, from) => {
  const end = text.indexOf(';', from)
  return text.slice(from, end < 0 ? text.length : end)
}
const WRITE_VERB = /\.\s*(?:insert|update|upsert|delete)\s*\(/

/** The edge functions that call a function writing the trail, or write an audited table themselves. */
function auditedEdgeFunctions() {
  const audited = new Map()
  for (const dir of fs.readdirSync(EDGE_FUNCTIONS, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name.startsWith('_') || dir.name === 'main') continue
    const files = fs.readdirSync(path.join(EDGE_FUNCTIONS, dir.name)).filter(f => /\.ts$/.test(f) && !/test\.ts$/.test(f))
    const text = files.map(f => read(path.join(EDGE_FUNCTIONS, dir.name, f))).join('\n')
    const rpc = [...text.matchAll(/\.rpc\(\s*["'`](\w+)["'`]/g)].map(m => m[1]).find(n => schema.functions.has(n))
    const table = [...text.matchAll(/\.from\(\s*["'](\w+)["']\s*\)/g)]
      .find(m => schema.tables.has(`public.${m[1]}`) && WRITE_VERB.test(statementAt(text, m.index)))
    if (rpc || table) audited.set(dir.name, rpc ? `${rpc}()` : table[1])
  }
  return audited
}

const edgeFunctions = auditedEdgeFunctions()

/**
 * Calls to GoTrue that write its own tables, which carry triggers of their own. The trigger, not
 * this list, decides whether one writes the trail: a table here with no audit trigger is no write.
 */
const GOTRUE_WRITES = [
  { piece: 'auth.oauth.revokeGrant(', table: 'auth.oauth_consents' },
  { piece: '/consent`', table: 'auth.oauth_consents' },
  { piece: 'auth.mfa.enroll(', table: 'auth.mfa_factors' },
  { piece: 'auth.mfa.challengeAndVerify(', table: 'auth.mfa_factors' },
  { piece: 'auth.mfa.unenroll(', table: 'auth.mfa_factors' },
  { piece: 'auth.updateUser(', table: 'auth.users' },
]

// --- Reading the dashboard's source --------------------------------------------------------------

/**
 * The source twice, at the same offsets. `text` has its comments blanked. `code` also has the inside
 * of each string, template and regex literal blanked (a template's `${}` stays code), so brackets
 * and quotes in them do not count. A quote or a regex that would run past the end of its line is JSX
 * text, not a literal, and so is a quote right after a letter ("doesn't").
 */
function blanked(source) {
  const text = source.split('')
  const out = source.split('')
  const blank = (from, to, ...into) => {
    for (const chars of into) for (let k = from; k < to; k++) if (chars[k] !== '\n') chars[k] = ' '
  }
  const templates = []
  let depth = 0
  let last = ''
  let beforeLast = ''
  const code = (c) => { beforeLast = last; last = c }
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (c === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) {
      const line = source[i + 1] === '/'
      const close = line ? source.indexOf('\n', i) : source.indexOf('*/', i + 2)
      const end = close < 0 ? source.length : close + (line ? 0 : 2)
      blank(i, end, out, text)
      i = end - 1
    } else if (c === '`' || (c === '}' && templates.length && templates[templates.length - 1] === depth)) {
      if (c === '}') { templates.pop(); depth-- }
      let j = i + 1
      for (; j < source.length && source[j] !== '`' && !(source[j] === '$' && source[j + 1] === '{'); j++) if (source[j] === '\\') j++
      blank(i + 1, j, out)
      if (source[j] === '$') { depth++; templates.push(depth); i = j + 1; code('{') } else { i = j; code('`') }
    } else if ((c === "'" || c === '"') && !/[\w$]/.test(source[i - 1] || '')) {
      let j = i + 1
      for (; j < source.length && source[j] !== c && source[j] !== '\n'; j++) if (source[j] === '\\') j++
      if (source[j] === c) { blank(i + 1, j, out); i = j }
      code(c)
    } else if (c === '/' && ('(,=:[!&|?{;+-*%~^'.includes(last) || last === '' || (last === '>' && beforeLast === '=') ||
               /\b(?:return|typeof|case)\s*$/.test(source.slice(Math.max(0, i - 8), i)))) {
      let j = i + 1
      let inClass = false
      for (; j < source.length && source[j] !== '\n'; j++) {
        if (source[j] === '\\') j++
        else if (source[j] === '[') inClass = true
        else if (source[j] === ']') inClass = false
        else if (source[j] === '/' && !inClass) break
      }
      if (source[j] === '/') { blank(i + 1, j, out); i = j }
      code('/')
    } else if (!/\s/.test(c)) {
      if (c === '{') depth++
      else if (c === '}') depth--
      code(c)
    }
  }
  return { text: text.join(''), code: out.join('') }
}

/** Where each bracket closes, by the offset of its opener. */
function closers(code) {
  const close = new Map()
  const open = { '(': [], '[': [], '{': [] }
  const pair = { ')': '(', ']': '[', '}': '{' }
  for (let i = 0; i < code.length; i++) {
    const c = code[i]
    if (open[c]) open[c].push(i)
    else if (pair[c]) { const o = open[pair[c]].pop(); if (o !== undefined) close.set(o, i) }
  }
  return close
}

/** One file, read for its structure: the code, its brackets, its function bodies and its catch blocks. */
function parse(file, source) {
  const { text, code } = blanked(source)
  const close = closers(code)
  const bodies = []
  for (const m of code.matchAll(/=>\s*\{/g)) {
    const at = m.index + m[0].length - 1
    bodies.push([at, close.get(at)])
  }
  for (const m of code.matchAll(/\bfunction\b\s*\*?\s*[\w$]*\s*\(/g)) {
    const params = m.index + m[0].length - 1
    const at = code.slice(close.get(params) + 1).search(/\S/) + close.get(params) + 1
    if (code[at] === '{') bodies.push([at, close.get(at)])
  }
  const catches = []
  for (const m of code.matchAll(/\bcatch\b\s*(\()?/g)) {
    const after = m[1] ? close.get(m.index + m[0].length - 1) + 1 : m.index + m[0].length
    const at = code.slice(after).search(/\S/) + after
    if (code[at] === '{') catches.push([at, close.get(at)])
  }
  /** The top-level arguments of the call whose `(` is at `open`, as source text. */
  const args = (open) => {
    const end = close.get(open)
    const list = []
    let from = open + 1
    let level = 0
    for (let i = open + 1; i < end; i++) {
      if ('([{'.includes(code[i])) level++
      else if (')]}'.includes(code[i])) level--
      else if (code[i] === ',' && level === 0) { list.push(text.slice(from, i).trim()); from = i + 1 }
    }
    list.push(text.slice(from, end).trim())
    return list.filter(Boolean)
  }
  const enclosing = (at) => bodies.filter(([s, e]) => s < at && at < e).sort((a, b) => b[0] - a[0])[0]
  return { file, text, code, close, bodies, catches, args, enclosing }
}

// --- What api.js writes --------------------------------------------------------------------------

const API = parse('api.js', read(path.join(SRC, 'api.js')))

/** What a piece of api.js writes that the trail records, as a phrase, or null. */
function writesOf(code, text, helpers) {
  for (const m of code.matchAll(/\.rpc\(\s*(\S)/g)) {
    const name = `'"`.includes(m[1]) ? text.slice(m.index).match(/\.rpc\(\s*['"](\w+)['"]/)[1] : null
    if (name && schema.functions.has(name)) return `${name}()`
    // A name chosen at run time: any audited function the piece names may be the one.
    if (!name) {
      const named = [...text.matchAll(/['"](\w+)['"]/g)].map(s => s[1]).find(n => schema.functions.has(n))
      if (named) return `${named}()`
    }
  }
  for (const m of code.matchAll(/\.\s*from\(\s*(\S)/g)) {
    // A bucket (`storage.from`) or a constructor's (`Array.from`) is not a table.
    if (/(?:storage|\b[A-Z]\w*)\s*$/.test(code.slice(Math.max(0, m.index - 20), m.index))) continue
    if (!WRITE_VERB.test(statementAt(code, m.index))) continue
    if (!`'"`.includes(m[1])) return 'a table named at run time'
    const table = text.slice(m.index).match(/from\(\s*['"](\w+)['"]/)[1]
    if (schema.tables.has(`public.${table}`)) return table
  }
  for (const m of text.matchAll(/functions\/v1\/([\w-]+)|functions\.invoke\(\s*'([\w-]+)'/g)) {
    const name = m[1] || m[2]
    // A GET reads: an edge function writes on the requests that change something.
    if (edgeFunctions.has(name) && !/\bmethod:\s*'GET'/.test(statementAt(text, m.index))) return `the ${name} edge function`
  }
  for (const g of GOTRUE_WRITES) if (text.includes(g.piece) && schema.tables.has(g.table)) return g.table
  for (const [name, writes] of helpers) if (callsHelper(code, name)) return writes
  return null
}

/** Whether `code` calls the top-level function `name`, rather than a method of that name. */
function callsHelper(code, name) {
  for (let at = code.indexOf(`${name}(`); at >= 0; at = code.indexOf(`${name}(`, at + 1)) {
    if (!/[\w.$]/.test(code[at - 1] || '')) return true
  }
  return false
}

/** api.js's top-level helpers that write: a method that calls one writes too. */
function apiHelpers() {
  const found = new Map()
  const decls = [...API.code.matchAll(/^(?:export )?(?:async )?function (\w+)\s*\(|^(?:export )?const (\w+) = (?:async )?(?:\([^)]*\)|\w+) =>\s*\{/gm)]
  for (let grew = true; grew;) {
    grew = false
    for (const m of decls) {
      const name = m[1] || m[2]
      if (found.has(name)) continue
      const open = m[1] ? API.code.indexOf('{', API.close.get(API.code.indexOf('(', m.index))) : m.index + m[0].length - 1
      const end = API.close.get(open)
      const writes = writesOf(API.code.slice(open, end), API.text.slice(open, end), found)
      if (writes) { found.set(name, writes); grew = true }
    }
  }
  return found
}

const helpers = apiHelpers()

/**
 * Whether `path` meets a router condition, in the shapes api.js writes them: `path === '…'`,
 * `path.startsWith('…')` (or `includes`, `endsWith`), `/…/.test(path)`, `path.match(/…/)`, a `const`
 * holding one of those, and `&&` between them. Null for any other shape.
 */
function meets(condition, path, consts) {
  let met = true
  for (const term of condition.split('&&').map(t => t.trim())) {
    const literal = term.match(/^path(?: === |\.(startsWith|includes|endsWith)\()'([^']*)'\)?$/)
    const pattern = term.match(/^\/(.+)\/([a-z]*)\.test\(path\)$/) || term.match(/^path\.match\(\/(.+)\/([a-z]*)\)$/)
    let result = null
    if (literal) result = literal[1] ? path[literal[1]](literal[2]) : path === literal[2]
    else if (pattern) result = new RegExp(pattern[1], pattern[2]).test(path)
    else if (consts.has(term)) result = meets(consts.get(term), path, consts)
    if (result === null) return null
    met = met && result
  }
  return met
}

/**
 * The members of `apiMethods`, each with what it writes. A router (get/post/put/delete) is split
 * into its branches, each with its condition on `path` and the `const`s before it it reads.
 */
function apiMembers() {
  const open = API.code.indexOf('{', API.code.indexOf('const apiMethods = {'))
  const end = API.close.get(open)
  const starts = [...API.code.slice(open, end).matchAll(/^ {2}(\w+)(?=\s*(?::|\())/gm)].map(m => [m[1], open + m.index])
  const members = new Map()
  starts.forEach(([name, at], k) => {
    const to = k + 1 < starts.length ? starts[k + 1][1] : end
    const code = API.code.slice(at, to)
    const text = API.text.slice(at, to)
    const member = { name, code, writes: writesOf(code, text, helpers), branches: null }
    if (['get', 'post', 'put', 'delete'].includes(name)) {
      member.branches = []
      const consts = new Map()
      for (const m of code.matchAll(/^ {4}(?:if \(|const (\w+) = (?=path\.))/gm)) {
        if (m[1]) { consts.set(m[1], text.slice(m.index + m[0].length, code.indexOf(';', m.index)).trim()); continue }
        const paren = at + m.index + m[0].length - 1
        const condition = API.text.slice(paren + 1, API.close.get(paren))
        const blockEnd = API.close.get(API.code.indexOf('{', API.close.get(paren)))
        const known = new Map(consts)
        member.branches.push({
          condition,
          decidable: meets(condition, '/api/v1/x1', known) !== null,
          // A condition that cannot be decided here may be met.
          test: (p) => meets(condition, p, known) !== false,
          writes: writesOf(API.code.slice(paren, blockEnd), API.text.slice(paren, blockEnd), helpers)
        })
      }
    }
    members.set(name, member)
  })
  // A member that calls another (`addPerson` calls `managePeople`) writes what that one writes.
  for (let grew = true; grew;) {
    grew = false
    for (const member of members.values()) {
      if (member.writes || member.branches) continue
      const called = [...member.code.matchAll(/\bapi\.(\w+)\(/g)].map(m => members.get(m[1])).find(o => o?.writes)
      if (called) { member.writes = called.writes; grew = true }
    }
  }
  return members
}

const members = apiMembers()

/**
 * The branches a router call can reach. A `${}` in its path could be anything, so each is tried
 * as a plain id and as every word the router's conditions name, less any end the text after it
 * supplies (`${type}s` is tried as `area`); a path held in a variable could reach any branch.
 */
function branchesFor(member, pathArg) {
  if (!/^['`]/.test(pathArg)) return member.branches
  const parts = pathArg.slice(1, -1).split(/\$\{[^}]*\}/)
  const words = [...new Set(member.branches.flatMap(b => b.condition.match(/[A-Za-z][\w-]*/g) || []))]
  const values = (next) => ['x1', ...words, ...words.flatMap(w => [...Array(Math.min(w.length, next.length)).keys()]
    .map(k => k + 1).filter(k => w.endsWith(next.slice(0, k))).map(k => w.slice(0, -k)))]
  let paths = [parts[0]]
  for (const part of parts.slice(1)) paths = paths.flatMap(p => values(part).map(w => p + w + part))
  const reached = new Set()
  for (const p of paths) {
    const branch = member.branches.find(b => b.test(p))
    if (branch) reached.add(branch)
  }
  return [...reached]
}

// --- The calls -----------------------------------------------------------------------------------

const TOAST = /\bshowToast(?:Ref\.current)?(?:\?\.)?\(/g

/** Every call under src/ (outside api.js) of something that writes the trail, with what it writes. */
function auditedCalls() {
  return sources(SRC).filter(p => relative(p) !== 'api.js').flatMap(p => {
    const file = relative(p)
    const src = parse(file, read(p))
    const found = []
    const add = (at, open, writes) => found.push({
      file, src, at, open, writes,
      line: src.text.slice(0, at).split('\n').length,
      call: src.text.slice(at, src.close.get(open) + 1).replace(/\s+/g, ' ')
    })
    for (const m of src.code.matchAll(/\bapi\.(\w+)\(/g)) {
      const member = members.get(m[1])
      const open = m.index + m[0].length - 1
      if (!member) continue
      if (member.branches) {
        if (!member.branches.some(b => b.writes)) continue
        const writes = branchesFor(member, src.args(open)[0] || '').map(b => b.writes).find(Boolean)
        if (writes) add(m.index, open, writes)
      } else if (member.writes) add(m.index, open, member.writes)
    }
    // Writes made without api.js: an edge function or RPC called directly, and GoTrue's own.
    for (const m of src.code.matchAll(/\b(?:functions\.invoke|rpc|fetch)\(/g)) {
      const open = m.index + m[0].length - 1
      const call = src.text.slice(m.index - 1, src.close.get(open) + 1)
      const writes = writesOf(src.code.slice(m.index - 1, src.close.get(open) + 1), call, new Map())
      if (writes) add(m.index, open, writes)
    }
    for (const g of GOTRUE_WRITES) {
      for (let at = src.text.indexOf(g.piece); at >= 0; at = src.text.indexOf(g.piece, at + 1)) {
        if (schema.tables.has(g.table) && !found.some(f => f.at <= at && at <= src.close.get(f.open))) {
          const open = src.code.indexOf('(', at)
          add(at, open, g.table)
        }
      }
    }
    return found
  })
}

/** The success toast that follows a call in its own function, outside a `catch`, or null. */
function toastAfter(src, at) {
  const body = src.enclosing(at)
  if (!body) return null
  for (const m of src.code.slice(at, body[1]).matchAll(TOAST)) {
    const where = at + m.index
    if (src.catches.some(([s, e]) => s < where && where < e && s > body[0])) continue
    const type = src.args(where + m[0].length - 1)[1]
    if (type === undefined || type.includes("'success'")) return where
  }
  return null
}

/**
 * Calls whose toast is made elsewhere, by the code they hand the result to. `by.piece` is where that
 * code is: the function it ends in must toast after it, as any call must.
 */
const TOASTED_BY = [
  {
    file: 'hooks/useDisplayNames.js', piece: 'api.setDisplayName(',
    by: { file: 'components/tabs/ProfileTab.jsx', piece: 'await onSave?.(normaliseDisplayName(draft))' },
    why: 'the hook returns the name held, and the Profile row that called it toasts',
  },
  {
    file: 'components/modals/ColdStorageDestinationModal.jsx', piece: 'api.patchSetting(',
    by: { file: 'components/tabs/ColdStorageTab.jsx', piece: 'const onSaved = () => {' },
    why: 'one save writes a setting for each key changed, and the page toasts once for them all',
  },
]

/** Audited calls with no success toast, by file and a piece of the call, each with its reason. */
const NO_TOAST = [
  { file: 'pages/OAuthConsent.jsx', piece: '/consent`', why: 'the page leaves the dashboard for the app that asked' },
  { file: 'components/tabs/SystemLogs.jsx', piece: 'api.readServiceLogs(', why: 'reading logs leaves a trace of the read, not an act the person takes; a toast on every filter change would be noise' },
]

describe('an audited action ends with a success toast', () => {
  const calls = auditedCalls()
  const listed = (list, c) => list.find(e => e.file === c.file && c.call.includes(e.piece))

  it('reads the schema, so a change to how migrations are written cannot leave this checking nothing', () => {
    for (const table of ['areas', 'cells', 'devices', 'gateways', 'metric_catalog', 'schemas', 'system_settings', 'device_nameplate', 'device_submodels']) {
      expect(schema.tables, `${table} carries log_audit_trail_event()`).toContain(`public.${table}`)
    }
    expect(schema.tables).toContain('auth.oauth_consents')
    expect(schema.writers.size).toBeGreaterThanOrEqual(40)
    for (const fn of ['issue_capture_download', 'ensure_shadow_devices', 'show_gateway_credential', 'set_display_name', 'end_my_session']) {
      expect(schema.functions, `${fn}() writes the trail`).toContain(fn)
    }
    expect([...edgeFunctions.keys()]).toEqual(expect.arrayContaining(['manage-people', 'gateway-credential', 'mint-service-token']))
  })

  it('finds the calls, and each router branch it reads has a condition it can test', () => {
    expect(calls.length).toBeGreaterThanOrEqual(80)
    expect(members.get('post').branches.length).toBeGreaterThanOrEqual(15)
    expect(members.get('setAreaPlanRotation').writes).toBe('areas')
    expect(members.get('addPerson').writes).toBe('the manage-people edge function')
    for (const verb of ['get', 'post', 'put', 'delete']) {
      for (const b of members.get(verb).branches) expect(b.decidable, `api.${verb}: if (${b.condition})`).toBe(true)
    }
  })

  it.each(calls.map(c => [`${c.file}:${c.line} ${c.call.slice(0, 60)}`, c]))('%s toasts', (_, c) => {
    if (listed(NO_TOAST, c)) return
    const by = listed(TOASTED_BY, c)?.by
    if (by) {
      const src = parse(by.file, read(path.join(SRC, by.file)))
      const at = src.text.indexOf(by.piece)
      expect(at, `TOASTED_BY: ${by.piece} is not in ${by.file}`).toBeGreaterThanOrEqual(0)
      expect(toastAfter(src, at + by.piece.length),
        `${by.file}: ${by.piece} toasts for ${c.call} (${c.file}), which writes ${c.writes}, and reaches no success toast`).not.toBeNull()
      return
    }
    expect(toastAfter(c.src, c.at),
      `${c.call}\nwrites ${c.writes}, an Audit Trail row, and reaches no success showToast after it in its function. ` +
      'Toast the success (naming the record, with { to }), or add it to NO_TOAST with the reason').not.toBeNull()
  })

  it.each([...NO_TOAST, ...TOASTED_BY].map(e => [`${e.file}: ${e.piece}`, e]))('%s still names an audited call', (_, e) => {
    expect(calls.some(c => c.file === e.file && c.call.includes(e.piece))).toBe(true)
  })

  it.each(WRITES_NO_ROW.map(e => [e.name, e]))('WRITES_NO_ROW %s() is still read as writing the trail', (_, e) => {
    expect(schema.derived).toContain(e.name)
  })
})
