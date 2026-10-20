import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CaptureTab } from '../components/tabs/CaptureTab'

/**
 * A failed or stopped job stays on the Capture page for fifteen minutes after it finished, for the
 * operator who started it and has not come back yet. The other suites check a fresh one and one an
 * hour old; these hold the edge, for a recording and for a playback.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      get: vi.fn(),
      listCaptures: vi.fn(),
      activeCaptureJob: vi.fn(),
      recentCaptureJobs: vi.fn(),
      activePlaybackJob: vi.fn(),
      recentPlaybackJobs: vi.fn(),
      playbackTargets: vi.fn(),
      playbackWorkerStatus: vi.fn(),
      playbackStaleCredentials: vi.fn(),
      ensureShadowLanes: vi.fn(),
      captureUrl: vi.fn()
    }
  }
})

vi.mock('../hooks/useRealtimeTable', () => ({ useRealtimeTable: vi.fn() }))

import { api } from '../api'

const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000).toISOString()

const capture = (id, minutes) => ({
  id, status: 'FAILED', subject_sparkplug_id: 'gwy150000000000400080000',
  gateways: { name: 'Line 1 Gateway' }, error: `capture ${id} went wrong`, finished_at: minutesAgo(minutes)
})

const playback = (id, minutes, status = 'FAILED') => ({
  id, status, target_edge_node_id: 'gwy160000000000400080000', gateways: { name: 'Playback' },
  messages_sent: 2, messages_total: 9, messages_out_of_window: 0,
  error: status === 'FAILED' ? `playback ${id} went wrong` : null, finished_at: minutesAgo(minutes)
})

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  api.get.mockResolvedValue([])
  api.listCaptures.mockResolvedValue([])
  api.activeCaptureJob.mockResolvedValue(null)
  api.recentCaptureJobs.mockResolvedValue([])
  api.activePlaybackJob.mockResolvedValue(null)
  api.recentPlaybackJobs.mockResolvedValue([])
  api.playbackStaleCredentials.mockResolvedValue([])
})

const renderTab = () => render(<CaptureTab showToast={vi.fn()} userRole="Administrator" />)

describe('the fifteen minutes a finished job stays on the page', () => {
  it('shows a recording that failed fourteen minutes ago and not one that failed sixteen ago', async () => {
    api.recentCaptureJobs.mockResolvedValue([capture('job-14', 14), capture('job-16', 16)])
    renderTab()
    expect(await screen.findByText(/capture job-14 went wrong/)).toBeInTheDocument()
    expect(screen.queryByText(/capture job-16 went wrong/)).toBeNull()
  })

  it('holds a failed playback to the same window', async () => {
    api.recentPlaybackJobs.mockResolvedValue([playback('play-14', 14), playback('play-16', 16)])
    renderTab()
    expect(await screen.findByText(/playback play-14 went wrong/)).toBeInTheDocument()
    expect(screen.queryByText(/playback play-16 went wrong/)).toBeNull()
  })

  it('holds a stopped playback to the same window', async () => {
    api.recentPlaybackJobs.mockResolvedValue([
      playback('play-stop-14', 14, 'CANCELLED'),
      { ...playback('play-stop-16', 16, 'CANCELLED'), messages_sent: 7 }
    ])
    renderTab()
    expect(await screen.findByText(/2 of 9 messages published before it was stopped/)).toBeInTheDocument()
    expect(screen.queryByText(/7 of 9 messages/)).toBeNull()
  })
})
