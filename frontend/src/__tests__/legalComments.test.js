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
const CHART = fs.readFileSync(path.resolve(__dirname, '../components/common/TimeSeriesChart.jsx'), 'utf8')
const UPLOT_LICENSE = fs.readFileSync(path.resolve(__dirname, '../../node_modules/uplot/LICENSE'), 'utf8')
const EDITOR = fs.readFileSync(path.resolve(__dirname, '../components/common/AutomationEditor.jsx'), 'utf8')
const YAML_FILE = fs.readFileSync(path.resolve(__dirname, '../utils/automationYaml.js'), 'utf8')
const YAML_LICENSE = fs.readFileSync(path.resolve(__dirname, '../../node_modules/yaml/LICENSE'), 'utf8')
const MODULES = path.resolve(__dirname, '../../node_modules')

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

  // uPlot's own header is a plain `/**` comment, which the build drops; its MIT notice travels in
  // the chart's legal comment instead (NOTICE.md, "The dashboard's charts").
  it("TimeSeriesChart.jsx opens with uPlot's licence notice, as the installed package states it", () => {
    const first = /^\/\*![\s\S]*?\*\//.exec(CHART)?.[0] || ''
    const asComment = (text) => text.trim().split('\n').map(line => ` * ${line}`.trimEnd()).join('\n')
    expect(first).toContain('uPlot 1.6.32')
    expect(first).toContain(asComment(UPLOT_LICENSE))
  })

  // CodeMirror and Lezer ship no notice the build keeps: the editor's legal comment carries them all
  // (NOTICE.md, "The Automations page's editor"). Every package of the family the install holds is
  // named there with the copyright line its own LICENSE states, so a package a later release adds
  // fails here until its notice is.
  describe("AutomationEditor.jsx's notice for CodeMirror and Lezer", () => {
    const first = /^\/\*![\s\S]*?\*\//.exec(EDITOR)?.[0] || ''
    const asComment = (text) => text.trim().split('\n').map(line => ` * ${line}`.trimEnd()).join('\n')
    const family = [
      ...['@codemirror', '@lezer'].flatMap(scope =>
        fs.readdirSync(path.join(MODULES, scope)).map(name => `${scope}/${name}`)),
      '@marijn/find-cluster-break', 'crelt', 'style-mod', 'w3c-keyname',
    ]
    const licenceOf = (pkg) => fs.readFileSync(path.join(MODULES, pkg, 'LICENSE'), 'utf8')

    it('opens the file, as a legal comment the build keeps', () => {
      expect(first.startsWith('/*!')).toBe(true)
    })

    it.each(family)('names %s and the copyright its LICENSE states', (pkg) => {
      const copyright = licenceOf(pkg).split('\n').find(line => /^Copyright/.test(line))
      expect(copyright, `${pkg}'s LICENSE has no copyright line`).toBeTruthy()
      expect(first).toContain(copyright)
      // The name as the comment lists it: @codemirror/state is "state" under its scope.
      const short = pkg.replace(/^@(codemirror|lezer)\//, '')
      expect(first.includes(short), `the notice does not name ${pkg}`).toBe(true)
    })

    it('carries the MIT licence text the packages ship, as one copy for them all', () => {
      const text = licenceOf('@codemirror/view')
      const body = text.slice(text.indexOf('Permission is hereby granted'))
      expect(first).toContain(asComment(body))
      for (const pkg of family) expect(licenceOf(pkg)).toContain(body.trim().split('\n').slice(0, 3).join('\n'))
    })
  })

  // yaml's own files carry no notice the build keeps either.
  it("automationYaml.js opens with yaml's licence notice, as the installed package states it", () => {
    const first = /^\/\*![\s\S]*?\*\//.exec(YAML_FILE)?.[0] || ''
    const asComment = (text) => text.trim().split('\n').map(line => ` * ${line}`.trimEnd()).join('\n')
    expect(first).toContain(asComment(YAML_LICENSE))
  })
})
