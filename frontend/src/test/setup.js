import '@testing-library/jest-dom'

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
