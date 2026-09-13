import '@testing-library/jest-dom'
import { vi } from 'vitest'

/**
 * `@google/model-viewer`, stubbed for every suite. Model3DViewer imports it dynamically; the real
 * package is a WebGL renderer whose custom element fails inside its connected callback under jsdom.
 * The empty module is enough, since jsdom treats an undefined custom element as an inert unknown
 * element.
 */
vi.mock('@google/model-viewer', () => ({}))

/**
 * A fixed locale for every suite. The components format dates with `toLocaleString(undefined,
 * ...)`, the viewer's locale, so a test asserting on rendered date text otherwise asserts on the
 * machine that ran it (CI once rendered `Aug 27, 2026` where laptops rendered `27 Aug 2026`).
 * `en-GB` is the deployment's own locale. The components are not changed. The three `toLocale*`
 * methods are patched rather than `Intl.DateTimeFormat`, which `Date.prototype` does not route
 * through in V8; an explicit locale from a caller still wins.
 */
const TEST_LOCALE = 'en-GB'
for (const method of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
  const original = Date.prototype[method]
  Date.prototype[method] = function (locales, options) {
    return original.call(this, locales ?? TEST_LOCALE, options)
  }
}

/**
 * jsdom gaps the download paths depend on: `URL.createObjectURL` does not exist, so spying on it
 * throws, and `Blob.prototype.text` is absent. Both are guarded on absence so a future jsdom that
 * ships them wins.
 */
if (typeof URL.createObjectURL !== 'function') {
  // Backed by a real registry rather than returning a constant: two downloads in one test must not
  // collide on the same URL, and revoking one must not invalidate the other.
  const objectUrls = new Map()
  let sequence = 0
  URL.createObjectURL = (object) => {
    const url = `blob:jsdom/${++sequence}`
    objectUrls.set(url, object)
    return url
  }
  URL.revokeObjectURL = (url) => { objectUrls.delete(url) }
} else if (typeof URL.revokeObjectURL !== 'function') {
  // Guarded separately: an implementation that has one and not the other would otherwise leave
  // downloadJSON()'s cleanup call throwing.
  URL.revokeObjectURL = () => {}
}

if (typeof Blob !== 'undefined' && typeof Blob.prototype.text !== 'function') {
  // FileReader is the one path jsdom does implement for reading a Blob, so the polyfill goes
  // through it -- the Blob under assertion stays a real Blob built by the code under test.
  Blob.prototype.text = function readBlobAsText() {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(reader.error)
      reader.readAsText(this)
    })
  }
}

if (!import.meta.env.VITE_SUPABASE_URL) {
  import.meta.env.VITE_SUPABASE_URL = 'http://127.0.0.1:54321'
}
if (!import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY) {
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test'
}
