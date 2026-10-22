/**
 * The help walker, against trees the build-time parse makes from small fixtures: every construct it
 * draws, heading ids, each kind of link, and the constructs the parse refuses rather than letting
 * reach a reader as their own source text.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { declaration } from '../test/themeColours'
import { HelpMarkdown } from '../components/common/HelpMarkdown'
import { HELP_ROOT, helpCorpus, parseHelp } from '../../helpCorpus.js'
import { HELP_BLOCKS, HELP_INLINES, resolveLink, slugify } from '../help/syntax'
import { repoUrl, sourceRef } from '../help/links'
import { GITHUB_REPO_URL } from '../constants'

const realExecCommand = document.execCommand
afterEach(() => {
  vi.unstubAllGlobals()
  document.execCommand = realExecCommand
})

/** From a file in help/<folder>/ to the repository's root. */
const UP = '../../'

const draw = (source, file = 'guides/fixture') => render(<HelpMarkdown tokens={parseHelp(source, file).tokens} />)

const EVERYTHING = `# Fixture

Intro with **bold**, *italic*, \`a_code_span\`, an escaped \\* star and a hard
break.

## A section

- one
- two
  - nested **bold**
- three

3. third
4. fourth

| Left | Right |
| :--- | ---: |
| \`x\` | 2 |

\`\`\`bash
echo "<hello>" && exit 0
\`\`\`

> A quote with **bold**.

---

### A section

Line one\\
line two.
`

describe('the walker draws every construct the parse keeps', () => {
  it('draws each one as its element', () => {
    const { container } = draw(EVERYTHING)
    // The leading `# ` is the drawer's title, not the body's.
    expect(container.querySelector('h1, h2')).toBeNull()
    expect(container.querySelector('h3').textContent).toBe('A section')
    expect(container.querySelector('h4').textContent).toBe('A section')
    expect(container.querySelector('strong').textContent).toBe('bold')
    expect(container.querySelector('em').textContent).toBe('italic')
    expect(container.querySelector('p code').textContent).toBe('a_code_span')
    expect(container.querySelector('p').textContent).toContain('an escaped * star and a hard break.')
    expect(container.querySelector('blockquote strong').textContent).toBe('bold')
    expect(container.querySelector('hr')).not.toBeNull()
    expect(container.querySelector('br')).not.toBeNull()
  })

  it('nests lists and keeps an ordered list’s first number', () => {
    const { container } = draw(EVERYTHING)
    const [outer, nested] = container.querySelectorAll('ul')
    expect(outer.children).toHaveLength(3)
    expect(nested.closest('li').firstChild.textContent).toBe('two')
    expect(nested.querySelector('strong').textContent).toBe('bold')
    const ol = container.querySelector('ol')
    expect(ol.getAttribute('start')).toBe('3')
    expect(ol.children).toHaveLength(2)
  })

  it('draws a table with its alignment, in a box that scrolls sideways', () => {
    const { container } = draw(EVERYTHING)
    const wrap = container.querySelector('.help-table-wrap')
    expect(wrap.getAttribute('tabindex')).toBe('0')
    const headers = [...wrap.querySelectorAll('th')].map((th) => th.textContent)
    expect(headers).toEqual(['Left', 'Right'])
    const cells = wrap.querySelectorAll('tbody td')
    expect(cells[0].querySelector('code').textContent).toBe('x')
    expect(cells[1].className).toBe('help-align-right')
  })

  // jsdom lays nothing out, so the rule is read from App.css; the line boxes are measured in a browser.
  it('never breaks a code token in a cell inside a word, and scrolls the table instead', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '..', 'App.css'), 'utf8')
    expect(declaration(css, '.help-prose td code', 'overflow-wrap')).toBe('normal')
    for (const selector of ['.help-prose', '.help-prose table', '.help-prose td', '.help-prose code', '.help-prose td code']) {
      expect(declaration(css, selector, 'overflow-wrap') ?? 'normal', selector).not.toBe('anywhere')
      expect(declaration(css, selector, 'word-break') ?? 'normal', selector).toBe('normal')
    }
    expect(declaration(css, '.help-table-wrap', 'overflow-x')).toBe('auto')
  })

  it('lets a code span in a cell wrap after each "/" that ends a segment, and nowhere else', () => {
    const { container } = draw(`| Topic | URL |
| :--- | :--- |
| \`spBv1.0/Aber/NBIRTH/gwy1\` | \`https://app.<domain>/v1/\` |

Also \`spBv1.0/Aber\` in prose.
`)
    const [topic, url] = container.querySelectorAll('td code')
    // The text is unchanged, so a copy is what the page says.
    expect(topic.textContent).toBe('spBv1.0/Aber/NBIRTH/gwy1')
    expect([...topic.childNodes].map((n) => n.nodeName === 'WBR' ? '|' : n.textContent).join(''))
      .toBe('spBv1.0/|Aber/|NBIRTH/|gwy1')
    // Not inside the scheme's `//`, and not after a trailing slash.
    expect(url.textContent).toBe('https://app.<domain>/v1/')
    expect([...url.childNodes].map((n) => n.nodeName === 'WBR' ? '|' : n.textContent).join(''))
      .toBe('https://app.<domain>/|v1/')
    // Prose wraps as text does; only a cell's column is squeezed.
    expect(container.querySelector('p code').querySelector('wbr')).toBeNull()
  })

  it('draws a fenced block as text, with a Copy button that copies it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const { container } = draw(EVERYTHING)
    const pre = container.querySelector('.help-code pre')
    expect(pre.textContent).toBe('echo "<hello>" && exit 0')
    expect(container.querySelector('.help-code-lang').textContent).toBe('bash')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })) })
    expect(writeText).toHaveBeenCalledWith('echo "<hello>" && exit 0')
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('says so when the browser blocks the copy', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
    document.execCommand = vi.fn(() => false)
    draw(EVERYTHING)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy' })) })
    expect(screen.getByRole('status').textContent).toMatch(/select the text/)
  })

  it('draws a type for each entry in the supported lists', () => {
    // A type added to syntax.js without a branch in the walker would pass the build and draw
    // nothing. The fixture exercises every listed type; the parse proves it by keeping them.
    const seen = new Set()
    const visit = (n) => {
      if (typeof n === 'string') { seen.add('text'); return }
      seen.add(n.type)
      for (const c of n.children || []) visit(c)
      for (const item of n.items || []) { seen.add('list_item'); item.forEach(visit) }
      for (const cell of n.header || []) cell.forEach(visit)
      for (const row of n.rows || []) for (const cell of row) cell.forEach(visit)
    }
    parseHelp(`${EVERYTHING}\nSee [the glossary](glossary.md).\n`, 'guides/fixture').tokens.forEach(visit)
    // The parse folds these into what is around them.
    const folded = new Set(['space', 'escape'])
    for (const type of [...HELP_BLOCKS, ...HELP_INLINES].filter((t) => !folded.has(t))) {
      expect(seen.has(type), `the fixture has no ${type}`).toBe(true)
    }
  })
})

describe('heading ids', () => {
  it('are GitHub’s slugs, numbered when repeated, so an anchor works in both places', () => {
    const { container } = draw(EVERYTHING)
    const ids = [...container.querySelectorAll('[data-heading]')].map((h) => [h.id, h.dataset.heading])
    expect(ids).toEqual([['help-a-section', 'a-section'], ['help-a-section-1', 'a-section-1']])
    expect(parseHelp(EVERYTHING, 'guides/fixture').titleId).toBe('fixture')
  })

  it('follow the rule for punctuation, code and case', () => {
    expect(slugify('What `enroll-gateway` does, in order')).toBe('what-enroll-gateway-does-in-order')
    expect(slugify('7. The two addresses that must be right')).toBe('7-the-two-addresses-that-must-be-right')
    expect(slugify('Ãrdal / Ærø')).toBe('ãrdal--ærø')
  })
})

describe('links', () => {
  it('opens a link to another help file in the panel, with GitHub as its fallback', () => {
    const { container } = draw('See [the tutorial](tutorial.md) and [quarantine](../pages/devices.md#quarantine).')
    const [tutorial, devices] = container.querySelectorAll('a')
    expect(tutorial.dataset.help).toBe('guides/tutorial')
    expect(tutorial.getAttribute('href')).toBe(repoUrl('help/guides/tutorial.md'))
    expect(devices.dataset.help).toBe('pages/devices#quarantine')
    expect(devices.getAttribute('href')).toBe(repoUrl('help/pages/devices.md', 'quarantine'))
    // Inside the panel: no online mark, because nothing leaves the dashboard.
    expect(tutorial.querySelector('.online-link-mark')).toBeNull()
  })

  it('opens a same-file anchor in the panel too', () => {
    const { container } = draw('Back to [the top](#a-section).\n\n## A section\n')
    expect(container.querySelector('a').dataset.help).toBe('guides/fixture#a-section')
  })

  it('opens a repository path on GitHub at this release, marked as needing the internet', () => {
    const { container } = draw(`Read [the runbook](${UP}docs/remote-gateways.md#7-the-two-addresses-that-must-be-right).`)
    const a = container.querySelector('a')
    expect(a.getAttribute('href')).toBe(`${GITHUB_REPO_URL}/blob/${sourceRef()}/docs/remote-gateways.md#7-the-two-addresses-that-must-be-right`)
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toContain('noopener')
    expect(a.getAttribute('aria-label')).toBe('the runbook (online: opens in a new tab and needs the internet)')
    expect(a.querySelector('.online-link-mark').textContent).toBe('online')
    // The mark is shown and named, never a tooltip.
    expect(a.hasAttribute('title')).toBe(false)
    expect(a.dataset.help).toBeUndefined()
  })

  it('opens another site in a new tab, marked the same way', () => {
    const { container } = draw('See [Sparkplug](https://sparkplug.eclipse.org/).')
    const a = container.querySelector('a')
    expect(a.getAttribute('href')).toBe('https://sparkplug.eclipse.org/')
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.querySelector('.online-link-mark')).not.toBeNull()
    expect(a.hasAttribute('title')).toBe(false)
  })

  it('opens a local address in a new tab without the mark, because it needs no internet', () => {
    const { container } = draw('Open http://app.localhost, then [Prometheus](http://localhost:9090).')
    const links = [...container.querySelectorAll('a')]
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['http://app.localhost', 'http://localhost:9090'])
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank')
      expect(a.querySelector('.online-link-mark')).toBeNull()
    }
  })

  it('resolves against the file’s own folder, as GitHub does', () => {
    expect(resolveLink('README', 'site/install.md#upgrading')).toEqual({ kind: 'help', file: 'site/install', anchor: 'upgrading' })
    expect(resolveLink('README', '../CONTRIBUTING.md#writing-documentation')).toEqual({ kind: 'repo', path: 'CONTRIBUTING.md', anchor: 'writing-documentation' })
    expect(resolveLink('pages/devices', `${UP}deploy/helm/aber/values.yaml`)).toEqual({ kind: 'repo', path: 'deploy/helm/aber/values.yaml', anchor: null })
    expect(resolveLink('pages/devices', '../README.md')).toEqual({ kind: 'help', file: 'README', anchor: null })
    expect(resolveLink('pages/devices', 'mailto:someone@example.invalid').kind).toBe('external')
  })

  it('names the release’s tag on a release build and main on any other', () => {
    expect(sourceRef('1.6.0')).toBe('v1.6.0')
    expect(sourceRef('v1.6.0')).toBe('v1.6.0')
    expect(sourceRef('1.6.0-rc.1')).toBe('v1.6.0-rc.1')
    expect(sourceRef('v1.5.0-12-g04374f9')).toBe('main')
    expect(sourceRef('v1.5.0-12-g04374f9-dirty')).toBe('main')
    expect(sourceRef('v1.5.0-dirty')).toBe('main')
    expect(sourceRef('unknown')).toBe('main')
  })
})

describe('what the parse refuses, so a contributor learns at once', () => {
  const refused = (source) => () => parseHelp(source, 'pages/fixture')

  it('refuses raw HTML, with the file and line', () => {
    expect(refused('Fine.\n\nThen <b>bold</b>.')).toThrow(/help\/pages\/fixture\.md:3: raw HTML/)
    expect(refused('<div>\nblock\n</div>')).toThrow(/raw HTML/)
  })

  it('refuses an image, a task list, an entity and strikethrough', () => {
    expect(refused('![a plan](plan.png)')).toThrow(/an image/)
    expect(refused('- [ ] a task')).toThrow(/task-list checkbox/)
    expect(refused('Tom &amp; Jerry')).toThrow(/HTML entity, &amp;/)
    expect(refused('~~gone~~')).toThrow(/strikethrough/)
  })

  it('refuses a link the panel cannot follow', () => {
    expect(refused('[up](../../../../outside.md)')).toThrow(/climbs out of the repository/)
    expect(refused('[a folder](../guides/)')).toThrow(/not a page/)
    expect(refused('[root](/docs/x.md)')).toThrow(/is absolute/)
  })

  it('never turns raw HTML into markup, because it never gets that far', () => {
    expect(refused('<img src=x onerror="alert(1)">')).toThrow(/raw HTML/)
  })
})

describe('the build-time plugin', () => {
  it('answers a ?help import with the tree, and nothing else', () => {
    const plugin = helpCorpus()
    const watched = []
    const ctx = { addWatchFile: (f) => watched.push(f) }
    const out = plugin.load.call(ctx, `${HELP_ROOT}/guides/glossary.md?help`)
    expect(out.code.startsWith('export default {"title":"Glossary"')).toBe(true)
    // Only what the walker needs ships: no source text, no link list.
    expect(out.code).not.toMatch(/"(raw|links|ids)":/)
    expect(watched.length).toBeGreaterThan(0)
    expect(plugin.load.call(ctx, `${HELP_ROOT}/guides/glossary.md?raw`)).toBeNull()
    expect(() => plugin.load.call(ctx, `${HELP_ROOT}/../frontend/README.md?help`)).toThrow(/page of help\/ only/)
  })
})
