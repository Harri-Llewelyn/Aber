import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '')

  if (command === 'build') {
    const supabaseUrl = env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL
    const supabaseAnonKey = env.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error(
        '[FATAL] Production build failed: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY environment variables are required.'
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
