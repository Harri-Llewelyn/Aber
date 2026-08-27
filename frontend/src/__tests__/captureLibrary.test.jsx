import React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CaptureLibrary } from '../components/common/CaptureLibrary'
import { capturePath, CAPTURE_VERSION } from '../api'
import { api } from '../api'

/**
 * The broker capture library on the gateway panel.
 *
 * WHAT THIS PROTECTS, and none of it is that the list renders.
 *
 *   1. THE EMPTY LIST IS NOT A DENIAL. storage-api applies the SELECT policy and returns an EMPTY
 *      ARRAY to an unauthorised caller rather than an error, so a component that inferred authority
 *      from the list length would tell an Operator "no captures exist" about a gateway that has
 *      several. `canRead` is passed in for that reason and the panel disappears entirely without it.
 *
 *   2. THE AUDITOR CANNOT DELETE. Read-only is the whole point of the role, and a read-only role
 *      that can remove evidence is not one. The storage policy is the control; this makes the UI
 *      agree so the button is absent rather than present and failing.
 *
 *   3. THE UPLOAD REFUSES A FILE THAT IS NOT A CAPTURE. The bucket accepts several JSON-ish MIME
 *      types because browsers report a hand-picked .json inconsistently, so the type is close to no
 *      check at all -- and a wrong file is otherwise discovered when somebody tries to PLAY it,
 *      which is both the worst moment and the furthest from the mistake.
 *
 *   4. THE PATH CANNOT ESCAPE ITS PREFIX. A slash in a filename is a folder separator to storage,
 *      which would file the object outside the prefix RLS checks -- refused for a reason the name
 *      does not suggest.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      listCaptures: vi.fn(),
      uploadCapture: vi.fn(),
      captureUrl: vi.fn(),
      deleteCapture: vi.fn(),
    }
  }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { storage: { from: vi.fn() } }
}))

const GW = {
  gateway_id: 'gggggggg-0000-4000-8000-000000000001',
  gateway_name: 'Playback_Lab',
  sparkplug_id: 'gwy110000000000400080000',
  is_simulated: true,
  is_virtual: false,
  is_archived: false,
}

const CAPTURE = {
  name: '2026-08-27T10-00-00-000Z-morning.capture.json',
  path: 'gwy110000000000400080000/2026-08-27T10-00-00-000Z-morning.capture.json',
  size: 20480,
  createdAt: '2026-08-27T10:00:00Z',
}

const show = async (props = {}) => {
  const merged = { gateway: GW, canRead: true, canManage: true, showToast: vi.fn(), ...props }
  render(<CaptureLibrary {...merged} />)
  if (merged.canRead) await waitFor(() => expect(api.listCaptures).toHaveBeenCalled())
  return merged
}

beforeEach(() => {
  vi.clearAllMocks()
  api.listCaptures.mockResolvedValue([CAPTURE])
})

describe('role gating', () => {

  it('renders nothing at all without read authority', async () => {
    // FAILURE 1. Not an empty panel and not a locked one -- the storage policy grants an Operator
    // nothing, and a disabled control invites a request for access that was never intended.
    const { container } = render(
      <CaptureLibrary gateway={GW} canRead={false} canManage={false} showToast={vi.fn()} />
    )
    expect(container.firstChild).toBeNull()
    expect(api.listCaptures).not.toHaveBeenCalled()
  })

  it('shows no delete button to a reader who cannot manage', async () => {
    // FAILURE 2. The Auditor case.
    await show({ canManage: false })
    await waitFor(() => expect(screen.getByTitle(/Download this capture/i)).toBeTruthy())
    expect(screen.queryByTitle(/Delete this capture/i)).toBeNull()
  })

  it('explains the missing dropzone to a read-only role', async () => {
    // Otherwise the absence reads as a broken feature rather than as a role boundary.
    await show({ canManage: false })
    expect(screen.getByText(/Read-only: your role can download captures/i)).toBeInTheDocument()
  })

  it('offers upload and delete to a manager', async () => {
    await show()
    await waitFor(() => expect(screen.getByTitle(/Delete this capture/i)).toBeTruthy())
    expect(screen.getByText(/Drop a capture here/i)).toBeInTheDocument()
  })
})

describe('the simulated-gateway warning', () => {

  it('is absent for a gateway that is marked simulated', async () => {
    await show()
    expect(screen.queryByText(/not marked simulated/i)).toBeNull()
  })

  it('warns when the target gateway is not marked simulated', async () => {
    // THE ONE THING THAT CHANGES WHAT PLAYBACK MEANS. The data is ingested identically either way
    // -- which is the point of the feature -- so the flag is the only thing telling replayed
    // readings from observed ones, and playing onto an unflagged gateway loses that distinction
    // silently.
    await show({ gateway: { ...GW, is_simulated: false } })
    expect(screen.getByText(/not marked simulated/i)).toBeInTheDocument()
  })

  it('warns rather than blocking, because filing a capture is not what plays it', async () => {
    await show({ gateway: { ...GW, is_simulated: false } })
    expect(screen.getByText(/Drop a capture here/i)).toBeInTheDocument()
  })
})

describe('listing and actions', () => {

  it('says how many are stored', async () => {
    await show()
    await waitFor(() => expect(screen.getByText('1 stored')).toBeTruthy())
  })

  it('tells an empty library how to fill itself', async () => {
    api.listCaptures.mockResolvedValue([])
    await show()
    await waitFor(() => expect(screen.getByText(/No captures yet/i)).toBeTruthy())
    expect(screen.getByText(/capture\.py record/)).toBeInTheDocument()
  })

  it('opens a signed URL to download', async () => {
    // SIGNED because the bucket is private -- there is no public URL to compose.
    api.captureUrl.mockResolvedValue('https://example.test/signed')
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    await show()
    await waitFor(() => expect(screen.getByTitle(/Download this capture/i)).toBeTruthy())
    fireEvent.click(screen.getByTitle(/Download this capture/i))
    await waitFor(() => expect(api.captureUrl).toHaveBeenCalledWith(CAPTURE.path))
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://example.test/signed', '_blank', 'noopener'))
    open.mockRestore()
  })

  it('refreshes after a delete', async () => {
    api.deleteCapture.mockResolvedValue()
    await show()
    await waitFor(() => expect(screen.getByTitle(/Delete this capture/i)).toBeTruthy())
    fireEvent.click(screen.getByTitle(/Delete this capture/i))
    await waitFor(() => expect(api.deleteCapture).toHaveBeenCalledWith(CAPTURE.path))
    await waitFor(() => expect(api.listCaptures).toHaveBeenCalledTimes(2))
  })

  it('surfaces a list failure instead of showing an empty library', async () => {
    // An error and an empty prefix must not look the same: one is "nothing here", the other is
    // "we do not know".
    api.listCaptures.mockRejectedValue(new Error('storage unreachable'))
    await show()
    await waitFor(() => expect(screen.getByText(/storage unreachable/)).toBeTruthy())
  })
})

describe('capturePath', () => {

  it('files the object under the gateway prefix', () => {
    const p = capturePath('gwy110000000000400080000', 'morning.json', new Date('2026-08-27T10:00:00Z'))
    expect(p.startsWith('gwy110000000000400080000/')).toBe(true)
    expect(p.endsWith('.capture.json')).toBe(true)
  })

  it('sorts chronologically by name', () => {
    // `list()` is ordered by name, so this is what makes "newest first" true without reading
    // metadata for every object.
    const early = capturePath('gwy1', 'a', new Date('2026-08-27T09:00:00Z'))
    const late = capturePath('gwy1', 'a', new Date('2026-08-27T11:00:00Z'))
    expect(early < late).toBe(true)
  })

  it('slugs a slash out of the label', () => {
    // FAILURE 4. Storage reads `/` as a folder separator, so this would file the object one level
    // deeper -- outside the prefix the RLS policy checks, where the insert is refused for a reason
    // the filename does not suggest.
    const p = capturePath('gwy1', 'morning shift / line 2.json')
    expect(p.split('/').length).toBe(2)
    expect(p).not.toContain(' ')
  })

  it('does not double the extension', () => {
    const p = capturePath('gwy1', 'shift.capture.json')
    expect(p.match(/\.capture\.json/g)).toHaveLength(1)
  })

  it('falls back to a usable name when the label slugs away to nothing', () => {
    // A file called "___.json" would otherwise produce a key ending in a bare hyphen.
    const p = capturePath('gwy1', '///.json')
    expect(p).toMatch(/-capture\.capture\.json$/)
  })
})

describe('the upload validation contract', () => {
  // Asserted through the component so the error actually reaches the operator: api.uploadCapture
  // is where the check lives, and a component that swallowed its rejection would leave a failed
  // upload looking like a slow one.

  const drop = async (message) => {
    api.uploadCapture.mockRejectedValue(new Error(message))
    const props = await show()
    const input = document.querySelector('input[type="file"]')
    const file = new File(['{}'], 'thing.json', { type: 'application/json' })
    fireEvent.change(input, { target: { files: [file] } })
    return props
  }

  it('shows the reason a file was refused', async () => {
    await drop('That file carries no acs_capture_version, so it is not a broker capture.')
    await waitFor(() => expect(screen.getByText(/not a broker capture/i)).toBeTruthy())
  })

  it('toasts the refusal as well as showing it', async () => {
    const props = await drop('That capture contains no messages, so there would be nothing to play back.')
    await waitFor(() => expect(props.showToast).toHaveBeenCalledWith(
      expect.stringMatching(/nothing to play back/i), 'error'
    ))
  })

  it('reports the message count on success', async () => {
    // The one number that says the capture is worth keeping, and the cheapest confirmation that
    // the file parsed as what it claimed to be.
    api.uploadCapture.mockResolvedValue({ path: 'gwy1/x.capture.json', messages: 412 })
    const props = await show()
    const input = document.querySelector('input[type="file"]')
    fireEvent.change(input, { target: { files: [new File(['{}'], 'a.json')] } })
    await waitFor(() => expect(props.showToast).toHaveBeenCalledWith(
      expect.stringMatching(/412 messages/), 'success'
    ))
  })

  it('pins the version the stack reads against capture.py', () => {
    // Mirrors CAPTURE_VERSION in ingestion/capture.py, which is the authority. There is no import
    // path from Python into the bundle, so this is duplicated -- and a drift makes the upload
    // accept a file `capture.py play` would then refuse.
    expect(CAPTURE_VERSION).toBe(1)
  })
})
