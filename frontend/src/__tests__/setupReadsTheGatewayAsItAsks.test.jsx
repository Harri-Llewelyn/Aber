import React from 'react'
import { render, screen, fireEvent, within, act, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GatewayBundleModal } from '../components/modals/GatewayBundleModal'
import { AccessControlTab } from '../components/tabs/AccessControlTab'
import { api } from '../api'

/**
 * The setup dialog reads the gateway's two times again each time its question opens, and says whether the
 * setup revokes a credential from those. An appliance can enrol after the page read its row, or with the
 * command the open dialog issued. Until the read answers, and when it fails, the dialog goes by what it
 * has: the row it was given, or after its own issue, an enrolment that has ended.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      get: vi.fn(), gatewayEnrolment: vi.fn(), downloadGatewayBundle: vi.fn(), installCommand: vi.fn(),
      listGatewayCredentials: vi.fn(), listBrokerInventory: vi.fn(), listServicePrincipals: vi.fn(),
      listServiceTokens: vi.fn(), listRevokedServiceTokens: vi.fn(), listRevokedServicePrincipals: vi.fn(),
    }
  }
})

const ID = 'bbbbbbbb-0000-4000-8000-000000001617'
const NAME = 'Production_Flow'
const SPARKPLUG = 'gwybbbbbbbb00004000801617'
const BEFORE = '2026-11-01T09:00:00Z'
const REVOKED = '2026-11-05T09:00:00Z'
const SINCE = '2026-11-06T09:00:00Z'
const REVOKES = /This gateway has already enrolled, so this also revokes the broker credential its appliance is holding\./

const NEVER = { enrolled_at: null, credential_revoked_at: null }
const ENROLLED = { enrolled_at: BEFORE, credential_revoked_at: null }
const ENDED = { enrolled_at: BEFORE, credential_revoked_at: REVOKED }
const ENROLLED_AGAIN = { enrolled_at: SINCE, credential_revoked_at: REVOKED }

const row = (enrolment = NEVER) => ({ gateway_id: ID, gateway_name: NAME, sparkplug_id: SPARKPLUG, ...enrolment })

/** A read that has not answered, with the functions that answer it. */
const pending = () => {
  const read = {}
  read.promise = new Promise((resolve, reject) => { read.answer = resolve; read.fail = reject })
  return read
}
const settle = (change) => act(async () => { change() })

const open = (props = {}) => render(
  <GatewayBundleModal gateway={row()} onClose={vi.fn()} showToast={vi.fn()} installer={{ available: true }} {...props} />
)
const dialog = () => screen.getByRole('dialog')
const field = () => within(dialog()).getByLabelText(`Type ${NAME} to confirm`)
const issue = () => within(dialog()).getByRole('button', { name: /Issue Command/ })
const says = () => REVOKES.test(dialog().textContent.replace(/\s+/g, ' '))

/** Types the name, issues, and waits for the command. */
const issueNow = async () => {
  fireEvent.change(field(), { target: { value: NAME } })
  fireEvent.click(issue())
  return screen.findByRole('button', { name: /Re-issue Command/ })
}
const reissue = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /Re-issue Command/ }))
  return screen.findByLabelText(`Type ${NAME} to confirm`)
}

beforeEach(() => {
  vi.clearAllMocks()
  window.history.replaceState(null, '', '/')
  api.gatewayEnrolment.mockResolvedValue(NEVER)
  api.installCommand.mockImplementation(() => Promise.resolve({
    command: 'curl https://aber.local/install', expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), sparkplugId: SPARKPLUG
  }))
})
afterEach(() => vi.restoreAllMocks())

describe('the appliance enrols while the dialog is open', () => {
  it('says the re-issue revokes, where it was opened straight after registering', async () => {
    open()
    await screen.findByRole('button', { name: /Re-issue Command/ })
    expect(api.gatewayEnrolment).not.toHaveBeenCalled()

    api.gatewayEnrolment.mockResolvedValue(ENROLLED)
    await reissue()
    await waitFor(() => expect(says()).toBe(true))
    expect(api.gatewayEnrolment).toHaveBeenCalledTimes(1)
    expect(api.gatewayEnrolment).toHaveBeenCalledWith(ID)
  })

  it('says so again where the dialog was opened on an enrolled gateway, and issued', async () => {
    api.gatewayEnrolment.mockResolvedValue(ENROLLED)
    open({ gateway: row(ENROLLED), confirmFirst: true })
    expect(says()).toBe(true)
    await issueNow()

    api.gatewayEnrolment.mockResolvedValue(ENROLLED_AGAIN)
    await reissue()
    await waitFor(() => expect(says()).toBe(true))
  })

  it('says so when the other shape is asked for instead', async () => {
    open()
    api.gatewayEnrolment.mockResolvedValue(ENROLLED)
    fireEvent.click(await screen.findByRole('button', { name: /Download the Bundle Instead/ }))
    await waitFor(() => expect(says()).toBe(true))
  })

  it('reads again each time the question opens, and not while the command is shown', async () => {
    open()
    await reissue()
    await settle(() => {})
    expect(says()).toBe(false)
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByRole('button', { name: /Re-issue Command/ })).toBeInTheDocument()
    expect(api.gatewayEnrolment).toHaveBeenCalledTimes(1)

    api.gatewayEnrolment.mockResolvedValue(ENROLLED)
    await reissue()
    await waitFor(() => expect(says()).toBe(true))
    expect(api.gatewayEnrolment).toHaveBeenCalledTimes(2)
  })
})

describe('the appliance has not enrolled with the command the dialog issued', () => {
  it('says nothing of a credential, before the read answers or after', async () => {
    const read = pending()
    api.gatewayEnrolment.mockResolvedValue(ENROLLED)
    open({ gateway: row(ENROLLED), confirmFirst: true })
    await settle(() => {})
    expect(says()).toBe(true)
    await issueNow()
    api.gatewayEnrolment.mockReturnValue(read.promise)
    await reissue()
    expect(says()).toBe(false)
    await settle(() => read.answer(ENDED))
    expect(says()).toBe(false)
  })

  it('says nothing of one when it never enrolled at all', async () => {
    open({ confirmFirst: true })
    await settle(() => {})
    expect(api.gatewayEnrolment).toHaveBeenCalledTimes(1)
    expect(says()).toBe(false)
  })
})

describe('the row the page read is old', () => {
  it('says what it revokes once the read answers, for one that has enrolled since', async () => {
    const read = pending()
    api.gatewayEnrolment.mockReturnValue(read.promise)
    open({ confirmFirst: true })
    expect(says()).toBe(false)
    // No spinner and nothing held back meanwhile.
    expect(dialog()).not.toHaveAttribute('aria-busy', 'true')
    expect(field()).toBeEnabled()
    await settle(() => read.answer(ENROLLED))
    expect(says()).toBe(true)
  })

  it('stops saying it for one whose credential has been revoked since', async () => {
    const read = pending()
    api.gatewayEnrolment.mockReturnValue(read.promise)
    open({ gateway: row(ENROLLED), confirmFirst: true })
    expect(says()).toBe(true)
    await settle(() => read.answer(ENDED))
    expect(says()).toBe(false)
  })

  it('says it from Access Control, whose list is as the page loaded it', async () => {
    api.listGatewayCredentials.mockResolvedValue([{
      id: ID, name: NAME, issued_at: null, sparkplug_id: SPARKPLUG, sparkplug_group: 'Aber', deployment: 'remote',
      is_shadow: false, is_archived: false, status: 'PENDING_ENROLLMENT', live_status: 'PENDING_ENROLLMENT', ...NEVER
    }])
    api.listBrokerInventory.mockResolvedValue({ clients: [], roles: [], read_at: BEFORE })
    for (const read of ['get', 'listServicePrincipals', 'listServiceTokens', 'listRevokedServiceTokens', 'listRevokedServicePrincipals']) {
      api[read].mockResolvedValue([])
    }
    api.gatewayEnrolment.mockResolvedValue(ENROLLED)
    window.history.replaceState(null, '', '/access-control/credentials')
    render(<AccessControlTab showToast={vi.fn()} hasPermission={() => true} userRole="Administrator" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Bundle' }))
    await waitFor(() => expect(says()).toBe(true))
    expect(api.gatewayEnrolment).toHaveBeenCalledWith(ID)
  })
})

describe('the read fails, or finds nothing', () => {
  const FAILURES = [
    ['fails', () => Promise.reject(new Error('Failed to fetch'))],
    ['throws', () => { throw new Error('offline') }],
    ['finds no gateway', () => Promise.resolve(null)],
  ]

  it.each(FAILURES)('goes by the row when it %s', async (_, answer) => {
    api.gatewayEnrolment.mockImplementation(answer)
    const { unmount } = open({ gateway: row(ENROLLED), confirmFirst: true })
    await settle(() => {})
    expect(says()).toBe(true)
    unmount()
    open({ confirmFirst: true })
    await settle(() => {})
    expect(says()).toBe(false)
    // Nothing is said of the failure: the question stands, and the name can be typed.
    expect(within(dialog()).queryByRole('alert')).toBeNull()
  })

  it.each(FAILURES)('goes by its own issue when a later one %s', async (_, answer) => {
    api.gatewayEnrolment.mockResolvedValue(ENROLLED)
    open({ gateway: row(ENROLLED), confirmFirst: true })
    await issueNow()
    api.gatewayEnrolment.mockImplementation(answer)
    await reissue()
    await settle(() => {})
    expect(says()).toBe(false)
  })

  it.each(FAILURES)('goes by the last answer when the next one %s', async (_, answer) => {
    open()
    api.gatewayEnrolment.mockResolvedValue(ENROLLED)
    await reissue()
    await waitFor(() => expect(says()).toBe(true))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    api.gatewayEnrolment.mockImplementation(answer)
    await reissue()
    await settle(() => {})
    expect(says()).toBe(true)
  })
})

describe('an answer that comes late', () => {
  it('is dropped once the command it was asked before is issued', async () => {
    const before = pending()
    api.gatewayEnrolment.mockReturnValue(before.promise)
    open({ gateway: row(ENROLLED), confirmFirst: true })
    await issueNow()
    const after = pending()
    api.gatewayEnrolment.mockReturnValue(after.promise)
    await reissue()
    // The first question's answer, of before the issue.
    await settle(() => before.answer(ENROLLED))
    expect(says()).toBe(false)
    await settle(() => after.answer(ENROLLED_AGAIN))
    expect(says()).toBe(true)
  })

  it('is dropped when the dialog has closed', async () => {
    const read = pending()
    api.gatewayEnrolment.mockReturnValue(read.promise)
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = open({ confirmFirst: true })
    unmount()
    await settle(() => read.answer(ENROLLED))
    expect(said).not.toHaveBeenCalled()
  })
})

describe('the typed gate', () => {
  it('asks for the name whatever the read answers, and keeps what was typed', async () => {
    const read = pending()
    api.gatewayEnrolment.mockReturnValue(read.promise)
    open({ confirmFirst: true })
    expect(issue()).toBeDisabled()
    fireEvent.change(field(), { target: { value: NAME.slice(0, 4) } })
    await settle(() => read.answer(ENROLLED))
    expect(says()).toBe(true)
    expect(field()).toHaveValue(NAME.slice(0, 4))
    expect(issue()).toBeDisabled()
    expect(api.installCommand).not.toHaveBeenCalled()

    fireEvent.change(field(), { target: { value: NAME } })
    expect(issue()).toBeEnabled()
  })

  it('does not wait for the read', async () => {
    api.gatewayEnrolment.mockReturnValue(pending().promise)
    open({ confirmFirst: true })
    await issueNow()
    expect(api.installCommand).toHaveBeenCalledWith(ID)
  })
})
