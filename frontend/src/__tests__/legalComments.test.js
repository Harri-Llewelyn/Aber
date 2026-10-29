import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import viteConfig from '../../vite.config.js'

/**
 * The bundle carries the copied icons' notices. Icons.jsx's glyphs are Lucide's (ISC) and
 * Feather's (MIT), both of which ask for their notice in every copy, and a minified build drops
 * every comment the output is not told to keep (NOTICE.md, "The dashboard's icons").
 */

const ICONS = fs.readFileSync(path.resolve(__dirname, '../components/common/Icons.jsx'), 'utf8')

describe('legal comments in the built dashboard', () => {
  it('the build keeps legal comments', async () => {
    const config = typeof viteConfig === 'function'
      ? await viteConfig({ command: 'serve', mode: 'test' })
      : viteConfig
    expect(config.build?.rolldownOptions?.output?.comments?.legal).toBe(true)
  })

  it('Icons.jsx opens with both notices in one legal comment, which is what the build keeps', () => {
    const first = /^\/\*![\s\S]*?\*\//.exec(ICONS)?.[0] || ''
    expect(first).toContain('Copyright (c) 2026 Lucide Icons and Contributors')
    expect(first).toContain('Copyright (c) 2013-2023 Cole Bemis')
    expect(first).toContain('provided that the above\n * copyright notice and this permission notice appear in all copies.')
    expect(first).toContain('The above copyright notice and this permission notice shall be included in all')
  })
})
