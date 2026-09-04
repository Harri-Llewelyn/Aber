import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { execFileSync } from 'node:child_process'

/**
 * The version this bundle reports in the account menu (issue #57).
 *
 * TWO SOURCES, IN THIS ORDER, and the order is the whole design:
 *
 *   1. `VITE_APP_VERSION` from the environment. This is the ONLY source a container build has.
 *      frontend/Dockerfile's context is `./frontend`, so `.git` is not in the build at all and
 *      the command below cannot run -- the value has to be handed in from outside.
 *   2. `git describe`, for `npm run dev` and any build run from a working tree. This is what makes
 *      a developer's build label itself without anyone remembering to set a variable.
 *
 * `--tags` counts lightweight tags, `--always` degrades to a bare commit id rather than failing on
 * a repository with no tag yet, and `--dirty` marks a build made over uncommitted edits -- which
 * is precisely the build whose identity is otherwise a lie.
 *
 * FAILURE IS NOT FATAL AND IS NOT DISGUISED. No git, no repository, no tags: the version resolves
 * to `unknown` and src/version.js renders that as the answer. A build that cannot know its version
 * must not invent one -- see the note there.
 */
function resolveAppVersion() {
  const supplied = process.env.VITE_APP_VERSION
  if (typeof supplied === 'string' && supplied.trim() !== '') return supplied.trim()

  try {
    // execFileSync, not execSync: no shell, so nothing here is interpolated into a command line.
    return execFileSync('git', ['describe', '--tags', '--always', '--dirty'], {
      cwd: import.meta.dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '')

  // Fail the build when the bundle would carry no Supabase configuration AND no runtime source is
  // declared -- the combination that produces an image which throws on first load.
  //
  // VITE_RUNTIME_CONFIG=true is the deliberate opt-out: a Kubernetes image bakes nothing and gets
  // its configuration from the /config.js a ConfigMap mounts at deploy time (see src/config.js).
  // Without this escape hatch that build would have to be fed dummy values purely to get past the
  // check, which is worse than not checking -- the dummies end up in the bundle as a fallback that
  // masks a missing ConfigMap instead of surfacing it.
  if (command === 'build') {
    const runtimeConfig =
      (env.VITE_RUNTIME_CONFIG || process.env.VITE_RUNTIME_CONFIG || '').toLowerCase() === 'true'
    const supabaseUrl = env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL
    const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
    // EITHER FORMAT SATISFIES THIS. The bundle needs A gateway credential, not specifically the
    // legacy one -- Supabase deprecates the anon JWT by the end of 2026 and the gateway accepts
    // both at once, so a build given only the publishable key is correct and must not fail here.
    const supabasePublishableKey =
      env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY
    if (!runtimeConfig && (!supabaseUrl || !(supabaseAnonKey || supabasePublishableKey))) {
      throw new Error(
        '[FATAL] Production build failed: VITE_SUPABASE_URL and one of VITE_SUPABASE_ANON_KEY or ' +
          'VITE_SUPABASE_PUBLISHABLE_KEY environment variables are required. Set ' +
          'VITE_RUNTIME_CONFIG=true instead to build a bundle that is configured at deploy time ' +
          'through /config.js.'
      )
    }
  }

  return {
    plugins: [react()],
    // Injected rather than left to Vite's own VITE_* inlining, because the git fallback above has
    // no environment variable behind it -- `define` is what lets one spelling in the app cover the
    // container build and the working-tree build alike.
    define: {
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(resolveAppVersion()),
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
    },
    preview: {
      host: '0.0.0.0',
      port: 3000,
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: './src/test/setup.js',
    },
  }
})
