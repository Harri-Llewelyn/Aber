import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

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
    if (!runtimeConfig && (!supabaseUrl || !supabaseAnonKey)) {
      throw new Error(
        '[FATAL] Production build failed: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY environment ' +
          'variables are required. Set VITE_RUNTIME_CONFIG=true instead to build a bundle that is ' +
          'configured at deploy time through /config.js.'
      )
    }
  }

  return {
    plugins: [react()],
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
