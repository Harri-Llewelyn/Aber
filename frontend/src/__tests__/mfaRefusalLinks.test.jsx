/**
 * A refusal by the MFA switch links to Profile › MFA wherever it is shown as a toast: the shared
 * toast path recognises the sentence the database, the edge functions and the consent step all
 * answer with, so no page recognises it itself.
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { destinationOf, MFA_TAB_URL, useToast } from '../hooks/useToast'
import { isMfaRequired, MFA_REQUIRED_MESSAGE } from '../utils/secondFactor'

describe('the MFA refusal', () => {
  it('is recognised in a message that carries it, and nowhere else', () => {
    expect(isMfaRequired(MFA_REQUIRED_MESSAGE)).toBe(true)
    expect(isMfaRequired(`${MFA_REQUIRED_MESSAGE} (reference 1a2b3c4d)`)).toBe(true)
    expect(isMfaRequired('new row violates row-level security policy for table "areas"')).toBe(false)
    expect(isMfaRequired(undefined)).toBe(false)
  })

  it('names Profile › MFA, where a person adds an authenticator', () => {
    expect(MFA_REQUIRED_MESSAGE).toContain('Profile › MFA')
    expect(MFA_TAB_URL).toBe('/profile/mfa')
  })

  it("links an error or a warning to Profile › MFA, and keeps a link it was given", () => {
    expect(destinationOf(MFA_REQUIRED_MESSAGE, 'error', undefined)).toBe(MFA_TAB_URL)
    expect(destinationOf(MFA_REQUIRED_MESSAGE, 'warning', undefined)).toBe(MFA_TAB_URL)
    expect(destinationOf(MFA_REQUIRED_MESSAGE, 'error', '/devices')).toBe('/devices')
    expect(destinationOf(MFA_REQUIRED_MESSAGE, 'success', undefined)).toBeUndefined()
    expect(destinationOf('Could not save.', 'error', undefined)).toBeUndefined()
  })

  it('reaches the toast and its history entry', () => {
    const { result } = renderHook(() => useToast())
    act(() => { result.current.showToast(MFA_REQUIRED_MESSAGE, 'error') })
    expect(result.current.toasts[0].to).toBe(MFA_TAB_URL)
    expect(result.current.history[0].to).toBe(MFA_TAB_URL)
  })
})
