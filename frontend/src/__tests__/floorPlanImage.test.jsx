import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { FloorPlan } from '../components/common/FloorPlan'

/**
 * A stored plan the browser will not draw. The download succeeds, so the only signal is the
 * image's error event; the floor falls back to the outline and says why, rather than showing
 * pins floating over nothing.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, loadFloorPlanUrl: vi.fn().mockResolvedValue('blob:plan-1') }
})

const floor = { floor_id: 'f', area_id: 'a', level: 0, name: 'Ground floor', plan_path: 'a/f/plan-1.svg', plan_aspect: 1.5 }

describe('FloorPlan with a plan the browser cannot draw', () => {
  it('shows the outline and the reason once the image errors', async () => {
    render(<FloorPlan floor={floor} />)
    const plan = document.querySelector('.floor-plan')
    expect(plan.style.getPropertyValue('--plan-aspect')).toBe('1.5')
    await waitFor(() => expect(document.querySelector('.floor-plan-image')).not.toBeNull())
    expect(plan.dataset.plan).toBe('uploaded')

    fireEvent.error(document.querySelector('.floor-plan-image'))

    expect(document.querySelector('.floor-plan-image')).toBeNull()
    expect(document.querySelector('.floor-plan-outline')).not.toBeNull()
    expect(plan.dataset.plan).toBe('unavailable')
    expect(screen.getByText(/browser cannot draw this plan/)).toBeInTheDocument()
  })
})
