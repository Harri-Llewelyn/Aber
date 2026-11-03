/**
 * common/RefreshButton.jsx: Refresh and its interval as one control, the button reading again now
 * and the select joined to it setting how often that happens by itself.
 */
import React from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { RefreshButton } from '../components/common/RefreshButton'

const CHOICES = [{ value: 0, label: 'Off' }, { value: 30, label: '30 s' }]

const draw = (props = {}) => {
  const onRefresh = vi.fn()
  const onEveryChange = vi.fn()
  render(<RefreshButton onRefresh={onRefresh} every={0} onEveryChange={onEveryChange} choices={CHOICES} {...props} />)
  const group = screen.getByRole('group', { name: 'Refresh' })
  return { onRefresh, onEveryChange, group }
}

describe('the refresh control', () => {
  it('is one group: the button, then the interval joined to it', () => {
    const { group } = draw()
    const parts = [...group.querySelectorAll('button, select')].map(el => el.getAttribute('aria-label') || el.textContent.trim())
    expect(parts).toEqual(['Refresh', 'Refresh automatically'])
    expect(within(group).getByRole('combobox', { name: 'Refresh automatically' })).toHaveDisplayValue('Off')
  })

  it('reads again on the button, and sets the interval in seconds on the select', () => {
    const { onRefresh, onEveryChange, group } = draw()
    fireEvent.click(within(group).getByRole('button', { name: 'Refresh' }))
    expect(onRefresh).toHaveBeenCalledTimes(1)
    fireEvent.change(within(group).getByRole('combobox', { name: 'Refresh automatically' }), { target: { value: '30' } })
    expect(onEveryChange).toHaveBeenCalledWith(30)
  })

  it('draws the interval half as only its chevron while Off, and names the interval once set', () => {
    const { group } = draw()
    expect(group.querySelector('.refresh-split-off')).not.toBeNull()
    const { container } = render(<RefreshButton onRefresh={() => {}} every={30} onEveryChange={() => {}} choices={CHOICES} />)
    expect(container.querySelector('.refresh-split-off')).toBeNull()
    expect(within(container).getByRole('combobox', { name: 'Refresh automatically' })).toHaveDisplayValue('30 s')
  })

  it('holds the button while a read runs, and leaves the interval free', () => {
    const { group } = draw({ busy: true })
    expect(within(group).getByRole('button', { name: 'Refresh' })).toBeDisabled()
    expect(within(group).getByRole('combobox', { name: 'Refresh automatically' })).toBeEnabled()
  })
})
