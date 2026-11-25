import { describe, it, expect, vi, beforeEach } from 'vitest'
import { api } from '../api'
import { supabase } from '../lib/supabaseClient'

/** The setup dialog's read of one gateway: the two times, from the gateway's own row, and nothing else. */

vi.mock('../lib/supabaseClient', () => ({ supabase: { from: vi.fn() } }))

const ID = 'bbbbbbbb-0000-4000-8000-000000001617'
const answering = (answer) => {
  const read = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() }
  read.select.mockReturnValue(read)
  read.eq.mockReturnValue(read)
  read.maybeSingle.mockResolvedValue(answer)
  supabase.from.mockReturnValue(read)
  return read
}

beforeEach(() => vi.clearAllMocks())

describe('api.gatewayEnrolment()', () => {
  it('reads the two times of that gateway alone', async () => {
    const times = { enrolled_at: '2026-11-01T09:00:00Z', credential_revoked_at: null }
    const read = answering({ data: times, error: null })
    await expect(api.gatewayEnrolment(ID)).resolves.toEqual(times)
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(supabase.from).toHaveBeenCalledWith('gateways')
    expect(read.select).toHaveBeenCalledWith('enrolled_at,credential_revoked_at')
    expect(read.eq.mock.calls).toEqual([['id', ID]])
  })

  it('answers null for a gateway that is gone', async () => {
    answering({ data: null, error: null })
    await expect(api.gatewayEnrolment(ID)).resolves.toBeNull()
  })

  it('throws what went wrong, which the dialog takes as no answer', async () => {
    answering({ data: null, error: { message: 'permission denied' } })
    await expect(api.gatewayEnrolment(ID)).rejects.toThrow('permission denied')
    answering({ data: null, error: {} })
    await expect(api.gatewayEnrolment(ID)).rejects.toThrow("Could not read the gateway's enrolment")
  })
})
