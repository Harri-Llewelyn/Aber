/**
 * utils/secondFactor.js: when the sign-in asks for a code, and how GoTrue's factors and answers
 * are shown.
 */
import { describe, expect, it } from 'vitest'
import {
  describeFactorError, factorError, factorLabel, groupedSecret, isCode, nextFactorName, normaliseCode,
  qrImageSource, secondFactorDue, verifiedFactors,
} from '../utils/secondFactor'

const level = (currentLevel, nextLevel, ...methods) =>
  ({ currentLevel, nextLevel, currentAuthenticationMethods: methods.map(method => ({ method, timestamp: 1 })) })

describe('secondFactorDue', () => {
  it('asks a password session of someone with a verified factor', () => {
    expect(secondFactorDue(level('aal1', 'aal2', 'password'))).toBe(true)
    // A recovery link's session too: GoTrue changes the password only at aal2.
    expect(secondFactorDue(level('aal1', 'aal2', 'recovery'))).toBe(true)
  })

  it('asks nothing of a session that gave its code, or of someone with no factor', () => {
    expect(secondFactorDue(level('aal2', 'aal2', 'totp', 'password'))).toBe(false)
    expect(secondFactorDue(level('aal1', 'aal1', 'password'))).toBe(false)
    expect(secondFactorDue(null)).toBe(false)
    expect(secondFactorDue({ currentLevel: null, nextLevel: null, currentAuthenticationMethods: [] })).toBe(false)
  })

  it('never asks a federated sign-in twice', () => {
    expect(secondFactorDue(level('aal1', 'aal2', 'oauth'))).toBe(false)
    expect(secondFactorDue(level('aal1', 'aal2', 'sso/saml'))).toBe(false)
  })
})

describe('codes', () => {
  it('drops the spaces a person types between groups, and wants six digits', () => {
    expect(normaliseCode(' 123 456 ')).toBe('123456')
    expect(isCode('123 456')).toBe(true)
    for (const not of ['12345', '1234567', '12a456', '', null]) expect(isCode(not)).toBe(false)
  })
})

describe('factors', () => {
  const f = (id, status, friendly_name = '', factor_type = 'totp') => ({ id, status, friendly_name, factor_type })

  it('keeps the verified TOTP ones, in GoTrue\'s order', () => {
    const list = [f('a', 'verified'), f('b', 'unverified'), f('c', 'verified', '', 'phone'), f('d', 'verified')]
    expect(verifiedFactors(list).map(x => x.id)).toEqual(['a', 'd'])
    expect(verifiedFactors(undefined)).toEqual([])
  })

  it('names one that has no name', () => {
    expect(factorLabel(f('a', 'verified', '  '))).toBe('Authenticator app')
    expect(factorLabel(f('a', 'verified', 'Work phone'))).toBe('Work phone')
  })

  it('offers the first name nobody has, whatever its case', () => {
    expect(nextFactorName([])).toBe('Authenticator app')
    expect(nextFactorName([f('a', 'verified', 'authenticator APP')])).toBe('Authenticator app 2')
    expect(nextFactorName([f('a', 'verified', 'Authenticator app'), f('b', 'verified', 'Authenticator app 2')]))
      .toBe('Authenticator app 3')
  })

  it('groups the secret in fours', () => {
    expect(groupedSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP')
    expect(groupedSecret('')).toBe('')
  })
})

describe('qrImageSource', () => {
  it('percent-encodes the SVG auth-js leaves raw, so a # cannot end the URL', () => {
    const svg = '<svg><rect style="fill:#000"/></svg>'
    const src = qrImageSource(`data:image/svg+xml;utf-8,${svg}`)
    expect(src).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
    expect(src).not.toContain('#')
    expect(decodeURIComponent(src.slice(src.indexOf(',') + 1))).toBe(svg)
  })

  it('keeps an image data URL as it is, and refuses anything else', () => {
    expect(qrImageSource('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(qrImageSource('javascript:alert(1)')).toBeNull()
    expect(qrImageSource('https://elsewhere.example/qr.svg')).toBeNull()
    expect(qrImageSource(undefined)).toBeNull()
  })
})

describe('GoTrue\'s refusals', () => {
  it('says what to do, keeping GoTrue\'s code', () => {
    const e = factorError({ code: 'mfa_verification_failed', message: 'Invalid TOTP code entered' }, 'fallback')
    expect(e.message).toBe('That code is not right. Enter the code your app shows now.')
    expect(e.code).toBe('mfa_verification_failed')
    expect(describeFactorError({ code: 'something_new', message: 'GoTrue says' }, 'fallback')).toBe('GoTrue says')
    expect(describeFactorError(null, 'fallback')).toBe('fallback')
  })
})
