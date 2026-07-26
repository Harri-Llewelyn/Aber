import '@testing-library/jest-dom'

if (!import.meta.env.VITE_SUPABASE_URL) {
  import.meta.env.VITE_SUPABASE_URL = 'http://127.0.0.1:54321'
}
if (!import.meta.env.VITE_SUPABASE_ANON_KEY) {
  import.meta.env.VITE_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJvbGUiOiJhbm9uIiwiZXhwIjoyMDAwMDAwMDAwfQ.Z7KTfqo7mvr4j40uB-6K4f_VVT-d-ISkJ7E5VJ41jt0'
}
