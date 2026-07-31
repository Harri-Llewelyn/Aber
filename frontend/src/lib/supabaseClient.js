import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    '[FATAL] Missing required build-time environment variables: VITE_SUPABASE_URL and/or VITE_SUPABASE_ANON_KEY must be provided.'
  );
}

// Re-exported for the one caller that cannot go through supabase-js: an AASX package is a ZIP, and
// functions.invoke() decodes any non-JSON, non-octet-stream response as *text*, which corrupts
// binary. That path builds the request itself and asks for a Blob.
export const SUPABASE_URL = supabaseUrl;
export const SUPABASE_ANON_KEY = supabaseAnonKey;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
