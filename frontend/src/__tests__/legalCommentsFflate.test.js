import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The bundle carries fflate's notice. The package's own files carry none the build keeps, so the
 * module that imports it opens with the MIT licence as a `/*!` legal comment (NOTICE.md, "The AAS
 * reader's unzipper").
 */
const PACKAGE_FILE = fs.readFileSync(path.resolve(__dirname, '../utils/aasPackage.js'), 'utf8')
const LICENSE = fs.readFileSync(path.resolve(__dirname, '../../node_modules/fflate/LICENSE'), 'utf8')

describe("aasPackage.js's notice for fflate", () => {
  const first = /^\/\*![\s\S]*?\*\//.exec(PACKAGE_FILE)?.[0] || ''
  const asComment = (text) => text.trim().split('\n').map(line => ` * ${line}`.trimEnd()).join('\n')

  it('opens the file, as a legal comment the build keeps', () => {
    expect(first.startsWith('/*!')).toBe(true)
  })

  it('carries the licence the installed package ships', () => {
    expect(first).toContain(asComment(LICENSE))
  })

  it('names the package that is imported', () => {
    expect(PACKAGE_FILE).toMatch(/from 'fflate'/)
    expect(first).toContain('fflate')
  })
})
