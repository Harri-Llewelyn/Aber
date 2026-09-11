import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * Runtime configuration resolution (src/config.js): one frontend image serves any environment.
 * These pin that runtime wins, build time is the fallback, an unsubstituted template placeholder
 * counts as absent, and the accessor's key list agrees with the placeholder file a deployment
 * overwrites. Every case re-imports the module under vi.resetModules(), because SUPABASE_URL and
 * SUPABASE_ANON_KEY are resolved once at module load.
 */

const GLOBAL_KEY = '__ACS_CYMRU_CONFIG__'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLACEHOLDER_FILE = resolve(HERE, '../../public/config.js')

/** Load a fresh copy of the module with `injected` published as the deployment config. */
async function loadConfig(injected) {
  vi.resetModules()
  if (injected === undefined) {
    delete globalThis[GLOBAL_KEY]
  } else {
    globalThis[GLOBAL_KEY] = injected
  }
  return import('../config.js')
}

afterEach(() => {
  delete globalThis[GLOBAL_KEY]
})

describe('readSetting', () => {
  it('prefers an injected runtime value over the build-time inline', async () => {
    // src/test/setup.js seeds import.meta.env.VITE_SUPABASE_URL with the local demo origin, which
    // stands in for the baked value here.
    const { readSetting } = await loadConfig({ VITE_SUPABASE_URL: 'https://api.factory.example' })
    expect(readSetting('VITE_SUPABASE_URL')).toBe('https://api.factory.example')
  })

  it('falls back to the build-time inline when no config is injected at all', async () => {
    const { readSetting } = await loadConfig(undefined)
    expect(readSetting('VITE_SUPABASE_URL')).toBe('http://127.0.0.1:54321')
  })

  it('falls back when the injected value is blank -- the shipped placeholder', async () => {
    const { readSetting } = await loadConfig({ VITE_SUPABASE_URL: '' })
    expect(readSetting('VITE_SUPABASE_URL')).toBe('http://127.0.0.1:54321')
  })

  it('ignores an unsubstituted template placeholder rather than using it as a value', async () => {
    // A config.js rendered but never substituted is the likely deployment mistake, and a URL of
    // "${VITE_SUPABASE_URL}" is worse than none.
    for (const marker of ['${VITE_SUPABASE_URL}', '__VITE_SUPABASE_URL__']) {
      const { readSetting } = await loadConfig({ VITE_SUPABASE_URL: marker })
      expect(readSetting('VITE_SUPABASE_URL')).toBe('http://127.0.0.1:54321')
    }
  })

  it('returns the supplied fallback when neither source has a value', async () => {
    const { readSetting } = await loadConfig({})
    expect(readSetting('VITE_GITHUB_REPO_URL', 'https://example.invalid/repo')).toBe(
      'https://example.invalid/repo'
    )
  })

  it('tolerates a non-object global instead of throwing', async () => {
    const { readSetting } = await loadConfig('not-an-object')
    expect(readSetting('VITE_SUPABASE_URL')).toBe('http://127.0.0.1:54321')
  })
})

describe('readFlag', () => {
  it('reads "true" as true and anything else as false', async () => {
    const { readFlag } = await loadConfig({ VITE_ENABLE_REALTIME: 'true' })
    expect(readFlag('VITE_ENABLE_REALTIME')).toBe(true)

    const off = await loadConfig({ VITE_ENABLE_REALTIME: 'false' })
    expect(off.readFlag('VITE_ENABLE_REALTIME')).toBe(false)
  })

  it('uses the fallback only when the setting is absent from both sources', async () => {
    // A name that is not a setting, deliberately, so the case does not depend on whether the test
    // environment bakes a value for it.
    const { readFlag } = await loadConfig({})
    expect(readFlag('VITE_NOT_A_SETTING', true)).toBe(true)
    expect(readFlag('VITE_NOT_A_SETTING')).toBe(false)
  })
})

describe('required settings', () => {
  it('throws naming both configuration sources when Supabase is unresolvable', async () => {
    vi.resetModules()
    globalThis[GLOBAL_KEY] = { VITE_SUPABASE_URL: '' }
    const baked = import.meta.env.VITE_SUPABASE_URL
    import.meta.env.VITE_SUPABASE_URL = ''
    try {
      await expect(import('../config.js')).rejects.toThrow(/VITE_SUPABASE_URL is not configured/)
    } finally {
      import.meta.env.VITE_SUPABASE_URL = baked
    }
  })
})

describe('public/config.js placeholder', () => {
  const source = readFileSync(PLACEHOLDER_FILE, 'utf8')

  it('declares exactly the keys the accessor knows about', async () => {
    const { RUNTIME_SETTING_NAMES } = await loadConfig(undefined)

    // Evaluated rather than parsed: this asserts the shipped file is valid script that assigns the
    // expected global, which a regex over the source would not.
    const scope = {}
    // eslint-disable-next-line no-new-func
    new Function('window', source)(scope)

    expect(Object.keys(scope[GLOBAL_KEY]).sort()).toEqual([...RUNTIME_SETTING_NAMES].sort())
  })

  it('ships every value blank, so a baked bundle is unaffected by its presence', () => {
    const scope = {}
    // eslint-disable-next-line no-new-func
    new Function('window', source)(scope)
    expect(Object.values(scope[GLOBAL_KEY]).every((v) => v === '')).toBe(true)
  })

  it('does not clobber a config already injected ahead of it', () => {
    const scope = { [GLOBAL_KEY]: { VITE_SUPABASE_URL: 'https://already.example' } }
    // eslint-disable-next-line no-new-func
    new Function('window', source)(scope)
    expect(scope[GLOBAL_KEY].VITE_SUPABASE_URL).toBe('https://already.example')
  })
})

describe('index.html load order', () => {
  const html = readFileSync(resolve(HERE, '../../index.html'), 'utf8')

  it('loads /config.js as a CLASSIC script, which is what makes it run first', () => {
    // The real invariant is not document order: a classic script is parser-blocking and executes
    // immediately, while a type="module" script is deferred. Adding type="module", defer or async
    // here would make src/config.js evaluate against an unset global.
    const tag = html.match(/<script[^>]*src="\/config\.js"[^>]*>/)
    expect(tag, '/config.js must be loaded from index.html').not.toBeNull()
    expect(tag[0]).not.toMatch(/\b(type=|defer\b|async\b)/)
  })

  it('declares /config.js in <head>, where vite build also injects the bundle', () => {
    // Belt and braces on top of the classic-script rule: `vite build` injects the bundle's own
    // module script into <head>, and a config tag left in <body> would read in the opposite order
    // to the one it executes in.
    const headEnd = html.indexOf('</head>')
    const configTag = html.indexOf('src="/config.js"')
    expect(configTag).toBeGreaterThan(-1)
    expect(configTag).toBeLessThan(headEnd)
  })
})
