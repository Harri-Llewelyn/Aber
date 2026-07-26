import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    '[FATAL] Missing required build-time environment variables: VITE_SUPABASE_URL and/or VITE_SUPABASE_ANON_KEY must be provided.'
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
