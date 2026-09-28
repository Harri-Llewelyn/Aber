import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { AreaPlan } from '../components/common/AreaPlan'

/**
 * A stored plan the browser will not draw. The download succeeds, so the only signal is the
 * image's error event; the area falls back to the outline and says why, rather than showing
 * pins floating over nothing.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, loadAreaPlanUrl: vi.fn().mockResolvedValue('blob:plan-1') }
})

const area = { area_id: 'a', area_name: 'Assembly Hall', plan_path: 'a/plan-1.svg', plan_aspect: 1.5 }

describe('AreaPlan with a plan the browser cannot draw', () => {
  it('shows the outline and the reason once the image errors', async () => {
    render(<AreaPlan area={area} />)
    const plan = document.querySelector('.area-plan')
    expect(plan.style.getPropertyValue('--plan-aspect')).toBe('1.5')
    await waitFor(() => expect(document.querySelector('.area-plan-image')).not.toBeNull())
    expect(plan.dataset.plan).toBe('uploaded')

    fireEvent.error(document.querySelector('.area-plan-image'))

    expect(document.querySelector('.area-plan-image')).toBeNull()
    expect(document.querySelector('.area-plan-outline')).not.toBeNull()
    expect(plan.dataset.plan).toBe('unavailable')
    expect(screen.getByText(/browser cannot draw this plan/)).toBeInTheDocument()
  })
})
