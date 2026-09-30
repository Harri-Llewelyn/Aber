import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { CREDENTIAL_STATES, credentialStateTone, BROKER_STATES, brokerStateTone } from '../utils/credentialState'
import { COLD_STATES, coldStateTone } from '../utils/coldStorage'
import { GATEWAY_TYPES, gatewayTypeTone } from '../utils/gatewayType'
import { TONE_CLASS } from '../components/common/Badge'
import { TOKEN_STATES, tokenStatusTone } from '../utils/serviceIdentities'

/**
 * Every `badge-*` class the dashboard puts on an element has a rule in App.css. An undefined one
 * fails silently: the badge renders untinted and looks like any other. The classes come from two
 * places: names written out in the source, and the tones the helpers return for `badge-${tone}`.
 */

const SRC = path.resolve(__dirname, '..')
const APP_CSS = fs.readFileSync(path.join(SRC, 'App.css'), 'utf8')
const DEFINED = new Set([...APP_CSS.matchAll(/\.(badge-[a-z]+(?:-[a-z]+)*)/g)].map(m => m[1]))

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return ['__tests__', 'test'].includes(entry.name) ? [] : sourceFiles(full)
    return /\.jsx?$/.test(entry.name) ? [full] : []
  })
}

// The lookbehind keeps `trail-badge-*`, a separate family, out of the match.
const WRITTEN = new Set(sourceFiles(SRC).flatMap(file =>
  [...fs.readFileSync(file, 'utf8').matchAll(/(?<![\w-])badge-[a-z]+(?:-[a-z]+)*/g)].map(m => m[0])
))

const TONES = new Set([
  ...Object.values(CREDENTIAL_STATES).map(credentialStateTone),
  ...Object.values(BROKER_STATES).map(brokerStateTone),
  ...Object.values(COLD_STATES).map(coldStateTone),
  ...Object.values(GATEWAY_TYPES).map(gatewayTypeTone),
  ...[null, ...Object.values(TOKEN_STATES).map(state => ({ state, outstanding: 1 }))].map(tokenStatusTone),
].map(tone => `badge-${tone}`))

describe('badge classes', () => {
  it.each([...new Set(Object.values(TONE_CLASS))].sort())('the Badge component class %s has a rule in App.css', (cls) => {
    expect(DEFINED).toContain(cls)
  })

  it.each(['badge-sm', 'badge-archived', 'badge-danger', 'badge-success'])('the shared class %s has a rule in App.css', (cls) => {
    expect(DEFINED).toContain(cls)
  })

  it('has folded badge-offline into badge-danger', () => {
    expect(DEFINED).not.toContain('badge-offline')
    expect(WRITTEN).not.toContain('badge-offline')
  })

  it('finds the written-out classes and the helper tones it checks', () => {
    expect(WRITTEN).toContain('badge-neutral')
    expect(TONES).toContain('badge-ok')
  })

  it.each([...new Set([...WRITTEN, ...TONES])].sort())('%s has a rule in App.css', (cls) => {
    expect(DEFINED, `.${cls} is used by the dashboard and not defined in App.css`).toContain(cls)
  })
})
