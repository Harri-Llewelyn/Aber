import { describe, it, expect } from 'vitest'
import {
  MODEL_3D_EXTENSIONS,
  MODEL_3D_CONTENT_TYPES,
  DEFAULT_MODEL_CONTENT_TYPE,
  modelExtension,
  modelContentType,
  isAcceptedModelFile,
  modelFileName,
  modelStoragePath,
  formatFileSize
} from '../utils/model3d'

const DEVICE = '20000000-0000-4000-8000-000000000002'

/**
 * The regex `devices.model_3d_path`'s CHECK constraint enforces (migration 0035). Mirrored here so
 * a change to path composition that the database would reject fails in the unit tests instead of
 * at the first upload against a real stack.
 */
const CHECK_CONSTRAINT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[^/]+\.(gltf|glb|obj|stl)$/i

describe('model3d content types', () => {
  it('maps each accepted extension to its media type', () => {
    expect(modelContentType('a.glb')).toBe('model/gltf-binary')
    expect(modelContentType('a.gltf')).toBe('model/gltf+json')
    expect(modelContentType('a.obj')).toBe('model/obj')
    expect(modelContentType('a.stl')).toBe('model/stl')
  })

  it('covers every advertised extension, so the picker cannot offer an unmappable format', () => {
    for (const ext of MODEL_3D_EXTENSIONS) {
      expect(MODEL_3D_CONTENT_TYPES[ext.replace('.', '')]).toBeTruthy()
    }
  })

  it('is case-insensitive: a name from Windows may be .GLB', () => {
    expect(modelExtension('Model.GLB')).toBe('glb')
    expect(modelContentType('Model.GLB')).toBe('model/gltf-binary')
    expect(isAcceptedModelFile('Model.STL')).toBe(true)
  })

  it('falls back rather than omitting contentType, which would be invalid AAS', () => {
    expect(modelContentType('a.step')).toBe(DEFAULT_MODEL_CONTENT_TYPE)
    expect(modelContentType('noextension')).toBe(DEFAULT_MODEL_CONTENT_TYPE)
    expect(modelContentType(null)).toBe(DEFAULT_MODEL_CONTENT_TYPE)
  })

  it('reads the extension from the last dot, not the first', () => {
    expect(modelExtension('my.model.v2.glb')).toBe('glb')
  })

  it('does not treat a dotfile as having an extension', () => {
    expect(modelExtension('.glb')).toBe('')
    expect(isAcceptedModelFile('.glb')).toBe(false)
  })

  it('rejects unsupported formats', () => {
    expect(isAcceptedModelFile('drawing.step')).toBe(false)
    expect(isAcceptedModelFile('payload.exe')).toBe(false)
    expect(isAcceptedModelFile(undefined)).toBe(false)
  })
})

describe('modelStoragePath', () => {
  it('scopes the object to the device, which is what the storage policy authorises on', () => {
    expect(modelStoragePath(DEVICE, 'cnc.glb')).toBe(`${DEVICE}/cnc.glb`)
  })

  it('produces a path the database CHECK accepts', () => {
    for (const name of ['cnc.glb', 'Robot Arm v2.STL', 'part.obj', 'scene.gltf']) {
      expect(modelStoragePath(DEVICE, name)).toMatch(CHECK_CONSTRAINT)
    }
  })

  it('replaces characters that would need escaping in a public URL', () => {
    // The path is embedded verbatim in an exported AAS File element; a space or a non-ASCII
    // character would have to survive Storage, JSON, the AASX part name and the consumer.
    expect(modelStoragePath(DEVICE, 'Robot Arm v2.glb')).toBe(`${DEVICE}/Robot_Arm_v2.glb`)
    expect(modelStoragePath(DEVICE, 'pièce#1.obj')).toMatch(CHECK_CONSTRAINT)
  })

  it('cannot be made to escape the device prefix', () => {
    // A filename carrying path separators must not place the object under another device.
    const path = modelStoragePath(DEVICE, '../../other-device/evil.glb')
    expect(path).toMatch(CHECK_CONSTRAINT)
    expect(path.startsWith(`${DEVICE}/`)).toBe(true)
    expect(path.split('/')).toHaveLength(2)
  })

  it('normalises the extension to lower case so the content type resolves', () => {
    expect(modelStoragePath(DEVICE, 'Model.GLB')).toBe(`${DEVICE}/Model.glb`)
  })

  it('survives a name that is nothing but separators', () => {
    expect(modelStoragePath(DEVICE, '___.stl')).toBe(`${DEVICE}/model.stl`)
  })
})

describe('modelFileName', () => {
  it('returns the last segment', () => {
    expect(modelFileName(`${DEVICE}/cnc.glb`)).toBe('cnc.glb')
    expect(modelFileName('')).toBe('')
    expect(modelFileName(null)).toBe('')
  })
})

describe('formatFileSize', () => {
  it('formats across units', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(1024)).toBe('1.0 KB')
    expect(formatFileSize(13_002_342)).toBe('12.4 MB')
    expect(formatFileSize(1024 ** 3)).toBe('1.0 GB')
  })

  it('reports an unusable value as unknown rather than as NaN', () => {
    expect(formatFileSize(undefined)).toBe('—')
    expect(formatFileSize(-1)).toBe('—')
    expect(formatFileSize(Number.NaN)).toBe('—')
  })
})
