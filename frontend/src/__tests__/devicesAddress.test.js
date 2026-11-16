import { describe, it, expect } from 'vitest'
import { oldDevicesLinkChanges, STATUS_OUT_OF_VOCABULARY, STATUS_UNMODELLED } from '../utils/devicesAddress'

const changes = (search) => oldDevicesLinkChanges(new URLSearchParams(search))

describe('oldDevicesLinkChanges', () => {
  it('has nothing to change in an address that never used ?type=', () => {
    expect(changes('')).toBeNull()
    expect(changes('?group=Axes&status=online')).toBeNull()
  })

  it('moves a metric group to ?group= and drops ?type=', () => {
    expect(changes('?type=Axes')).toEqual({ type: null, group: 'Axes' })
  })

  it('turns each finding into the Status value that holds it', () => {
    expect(changes('?type=Unmodelled')).toEqual({ type: null, status: STATUS_UNMODELLED })
    expect(changes('?type=Out%20of%20vocabulary')).toEqual({ type: null, status: STATUS_OUT_OF_VOCABULARY })
  })

  it('splits a list that held groups and findings', () => {
    expect(changes('?type=Axes,Controller,Unmodelled')).toEqual({
      type: null, group: 'Axes,Controller', status: STATUS_UNMODELLED
    })
  })

  it('keeps what the address already chose, with no value twice', () => {
    expect(changes('?type=Axes,Unmodelled&group=Axes,OEE&status=unborn,unmodelled')).toEqual({
      type: null, group: 'Axes,OEE', status: 'unborn,unmodelled'
    })
  })

  it('keeps a comma inside a group name inside that one value', () => {
    // "Pump, main" is one value: the address writes its comma as %2C, and the parameter's own
    // encoding wraps that once more.
    expect(changes('?type=Pump%252C+main')).toEqual({ type: null, group: 'Pump%2C main' })
  })

  it('drops an empty ?type=', () => {
    expect(changes('?type=')).toEqual({ type: null })
  })
})
