import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The dashboard's two faces come from the image. A url() Vite cannot resolve is left in the bundle
 * as written and only warned about, so a mistyped file name would ship a page that silently falls
 * back to system fonts; this reads App.css and the files it names.
 */

const SRC = path.resolve(__dirname, '..')
const APP_CSS = fs.readFileSync(path.join(SRC, 'App.css'), 'utf8')
const FACES = [...APP_CSS.matchAll(/@font-face \{([^}]*)\}/g)].map((m) => {
  const prop = (name) => m[1].match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim()
  return {
    family: prop('font-family'),
    weight: prop('font-weight'),
    display: prop('font-display'),
    urls: [...m[1].matchAll(/url\(\s*'([^']+)'\s*\)/g)].map((u) => u[1]),
    range: prop('unicode-range'),
  }
})

describe('@font-face', () => {
  it('declares each face for the latin and latin-ext subsets, at the weights the interface uses', () => {
    const summary = FACES.map((f) => `${f.family} ${f.weight} ${f.urls.join()}`).sort()
    expect(summary).toEqual([
      "'JetBrains Mono' 400 500 ./assets/fonts/jetbrains-mono-latin-ext-wght-normal.woff2",
      "'JetBrains Mono' 400 500 ./assets/fonts/jetbrains-mono-latin-wght-normal.woff2",
      "'Outfit' 300 700 ./assets/fonts/outfit-latin-ext-wght-normal.woff2",
      "'Outfit' 300 700 ./assets/fonts/outfit-latin-wght-normal.woff2",
    ])
  })

  it('shows text in a fallback face while a file downloads', () => {
    for (const f of FACES) expect(f.display, f.urls.join()).toBe('swap')
  })

  it('names files that are in the tree and are woff2', () => {
    for (const url of FACES.flatMap((f) => f.urls)) {
      const file = path.join(SRC, url)
      expect(fs.existsSync(file), `${url} is not in frontend/src`).toBe(true)
      expect(fs.readFileSync(file).subarray(0, 4).toString('latin1'), url).toBe('wOF2')
    }
  })

  // Welsh: ŵ is U+0175 and ŷ is U+0177.
  it('covers the Welsh circumflexed w and y in latin-ext', () => {
    const ext = FACES.filter((f) => f.urls.some((u) => u.includes('latin-ext')))
    expect(ext).toHaveLength(2)
    for (const f of ext) expect(f.range).toMatch(/U\+0100-02BA/)
  })
})
