import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * A 3D model replaced by a file of another name takes the old file with it, once the device's row names
 * the new one, as a replaced area plan does. A failed delete is not fatal. The rollback of a failed write
 * never deletes the file the row still names.
 */

const store = vi.hoisted(() => ({ log: [], row: null, readError: null, writeError: null, hidden: false, remove: null }))

vi.mock('../lib/supabaseClient', () => {
  const devices = () => {
    const query = { patch: null }
    const builder = {
      select: () => (query.patch ? write(query.patch) : builder),
      update: (patch) => { query.patch = patch; return builder },
      eq: (column, value) => { query.where = [column, value]; return builder },
      maybeSingle: async () => {
        store.log.push(['read', query.where])
        return store.readError ? { data: null, error: store.readError } : { data: store.row && { ...store.row }, error: null }
      }
    }
    const write = async (patch) => {
      store.log.push(['write', patch])
      if (store.writeError) return { data: null, error: store.writeError }
      if (store.hidden) return { data: [], error: null }
      Object.assign(store.row, patch)
      return { data: [{ id: 'dev-1', ...store.row }], error: null }
    }
    return builder
  }
  const bucket = {
    upload: async (path) => { store.log.push(['upload', path]); return { error: null } },
    remove: (paths) => {
      store.log.push(['remove', paths])
      return store.remove ? store.remove() : Promise.resolve({ data: paths.map((name) => ({ name })), error: null })
    }
  }
  return {
    SUPABASE_URL: 'http://stack.test',
    SUPABASE_GATEWAY_KEY: 'sb_publishable_test',
    supabase: {
      from: vi.fn((table) => { if (table !== 'devices') throw new Error(table); return devices() }),
      storage: { from: vi.fn((name) => { store.bucket = name; return bucket }) },
      auth: { getSession: vi.fn() }
    }
  }
})

import { api } from '../api'

const DEVICE = '20000000-0000-4000-8000-000000001616'
const at = (name, device = DEVICE) => `${device}/${name}`
const file = (name) => new File(['x'], name, { type: 'model/gltf-binary' })
const removed = () => store.log.filter(([what]) => what === 'remove').map(([, paths]) => paths)
const steps = () => store.log.map(([what]) => what)

beforeEach(() => {
  Object.assign(store, { log: [], row: { model_3d_path: at('cnc.glb') }, readError: null, writeError: null, hidden: false, remove: null })
})

describe('api.uploadDeviceModel()', () => {
  it('deletes the file it replaced, once the row names the new one', async () => {
    const answer = await api.uploadDeviceModel(DEVICE, file('cnc-v2.glb'))
    expect(steps()).toEqual(['upload', 'read', 'write', 'remove'])
    expect(store.log[0][1]).toBe(at('cnc-v2.glb'))
    expect(store.log[1][1]).toEqual(['id', DEVICE])
    expect(store.log[2][1]).toEqual({ model_3d_path: at('cnc-v2.glb') })
    expect(removed()).toEqual([[at('cnc.glb')]])
    expect(store.bucket).toBe('asset-3d-models')
    expect(answer).toEqual({ path: at('cnc-v2.glb'), device: { id: 'dev-1', model_3d_path: at('cnc-v2.glb') } })
  })

  it('deletes what the row names, not what the page showed, wherever it is stored', async () => {
    // A model stored under a replay lane's id before a lane held none of its own.
    const underALane = at('cnc.glb', '30000000-0000-4000-8000-000000001616')
    store.row.model_3d_path = underALane
    await api.uploadDeviceModel(DEVICE, file('cnc-v2.glb'))
    expect(removed()).toEqual([[underALane]])
  })

  it('deletes nothing when the new file has the name of the old, which it overwrote', async () => {
    await api.uploadDeviceModel(DEVICE, file('cnc.glb'))
    expect(steps()).toEqual(['upload', 'read', 'write'])
  })

  it('deletes nothing for a device that had no model', async () => {
    store.row.model_3d_path = null
    await api.uploadDeviceModel(DEVICE, file('cnc.glb'))
    expect(removed()).toEqual([])
  })

  it.each([
    ['answers an error', () => Promise.resolve({ data: null, error: { message: 'Object not found' } })],
    ['fails', () => Promise.reject(new Error('Failed to fetch'))],
  ])('is done all the same when the delete %s', async (_, answer) => {
    store.remove = answer
    await expect(api.uploadDeviceModel(DEVICE, file('cnc-v2.glb'))).resolves.toMatchObject({ path: at('cnc-v2.glb') })
    expect(store.row.model_3d_path).toBe(at('cnc-v2.glb'))
  })

  it('deletes nothing it did not read the name of', async () => {
    store.readError = { message: 'Failed to fetch' }
    await expect(api.uploadDeviceModel(DEVICE, file('cnc-v2.glb'))).resolves.toMatchObject({ path: at('cnc-v2.glb') })
    expect(removed()).toEqual([])
  })
})

describe('a row write that fails', () => {
  it('takes the new file away and leaves the old one', async () => {
    store.writeError = { message: 'permission denied for table devices' }
    await expect(api.uploadDeviceModel(DEVICE, file('cnc-v2.glb'))).rejects.toThrow('permission denied for table devices')
    expect(removed()).toEqual([[at('cnc-v2.glb')]])
  })

  it('does the same when it changed no row', async () => {
    store.hidden = true
    await expect(api.uploadDeviceModel(DEVICE, file('cnc-v2.glb'))).rejects.toThrow('Could not attach the model to the device')
    expect(removed()).toEqual([[at('cnc-v2.glb')]])
  })

  it.each([['fails', { writeError: { message: 'timeout' } }], ['changes no row', { hidden: true }]])(
    'never deletes a file of the same name, which the row still names, when it %s', async (_, how) => {
      Object.assign(store, how)
      await expect(api.uploadDeviceModel(DEVICE, file('cnc.glb'))).rejects.toThrow()
      expect(removed()).toEqual([])
    })

  it('deletes nothing when the read failed too, so what the row names is not known', async () => {
    Object.assign(store, { readError: { message: 'offline' }, writeError: { message: 'offline' } })
    await expect(api.uploadDeviceModel(DEVICE, file('cnc.glb'))).rejects.toThrow('offline')
    expect(removed()).toEqual([])
  })
})
