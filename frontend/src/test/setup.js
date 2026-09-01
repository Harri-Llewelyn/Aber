import '@testing-library/jest-dom'
import { vi } from 'vitest'

/**
 * `@google/model-viewer`, stubbed for every suite.
 *
 * Model3DViewer imports it dynamically, so without this the real package would be pulled into any
 * test that renders a device with a model attached -- a WebGL renderer, in jsdom, which has no
 * WebGL. It does not fail cleanly: it registers a custom element whose connected callback reaches
 * for a canvas context that is not there, so the failure surfaces somewhere inside the element
 * rather than at the import, and reads as a bug in the component that rendered it.
 *
 * Stubbed GLOBALLY rather than per file, because the trap is silent in the other direction too: a
 * new test that happens to render an attached model would pull in seconds of module evaluation and
 * nobody would connect the slowdown to this. The factory returns an empty module because that is
 * exactly what the real one exports for our purposes -- the package's value is its side effect of
 * defining <model-viewer>, and jsdom treats an undefined custom element as an inert unknown
 * element, which is all these tests need it to be.
 */
vi.mock('@google/model-viewer', () => ({}))

/**
 * A FIXED LOCALE FOR EVERY SUITE, because the runner's is not the same as anybody's laptop.
 *
 * The components format dates with `toLocaleString(undefined, ...)` -- deliberately the VIEWER's
 * locale, which is the right behaviour for a dashboard read on a shopfloor in one country and a
 * head office in another. The consequence is that any test asserting on rendered date text is
 * asserting on the machine that ran it.
 *
 * That is not hypothetical: `captureTab.test.jsx` expected `27 Aug 2026` and passed on every
 * development machine here, while the GitHub runner rendered `Aug 27, 2026` and failed. It went
 * unnoticed for a fortnight because CI could not run at all -- see the PR that added this.
 *
 * PINNED HERE RATHER THAN FIXED IN THE ONE TEST, for the reason the model-viewer stub above gives:
 * the trap is silent in the other direction. The next date assertion somebody writes would pass
 * locally and fail in CI, and the failure names a component rather than a locale.
 *
 * `en-GB` because it is the deployment's own locale -- this is a Welsh manufacturing stack -- so
 * the strings in the tests read the way the people maintaining them expect. THE COMPONENTS ARE
 * NOT CHANGED: `undefined` still reaches Intl in the browser, and a viewer in another locale still
 * gets their own format. Only the test runtime's default is decided.
 *
 * Patching the three `toLocale*` methods rather than `Intl.DateTimeFormat`: `Date.prototype`
 * methods do not route through the global constructor in V8, so replacing `Intl.DateTimeFormat`
 * looks like it works and changes nothing here. An explicit locale passed by a caller still wins,
 * because only an absent one is defaulted.
 */
const TEST_LOCALE = 'en-GB'
for (const method of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
  const original = Date.prototype[method]
  Date.prototype[method] = function (locales, options) {
    return original.call(this, locales ?? TEST_LOCALE, options)
  }
}

/**
 * jsdom gaps that the download paths depend on.
 *
 * Polyfilled HERE rather than in the test files that need them, because the failure modes are
 * both misleading. `URL.createObjectURL` does not exist at all in jsdom, so `vi.spyOn(URL,
 * 'createObjectURL')` throws "createObjectURL does not exist" -- which reads as a broken test
 * rather than a missing browser API, and pushes each test file into assigning the global by hand
 * and having to remember to delete it afterwards. `Blob.prototype.text` is likewise absent, so
 * asserting on downloaded bytes fails with "text is not a function" some way after the code under
 * test has already run correctly.
 *
 * Both are guarded on absence, so a future jsdom that ships them wins and these quietly stop
 * applying rather than shadowing a real implementation.
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
if (!import.meta.env.VITE_SUPABASE_ANON_KEY) {
  import.meta.env.VITE_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJvbGUiOiJhbm9uIiwiZXhwIjoyMDAwMDAwMDAwfQ.Z7KTfqo7mvr4j40uB-6K4f_VVT-d-ISkJ7E5VJ41jt0'
}
