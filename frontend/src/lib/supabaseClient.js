import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../config';

// Re-exported for the one caller that cannot go through supabase-js: an AASX package is a ZIP, and
// functions.invoke() decodes any non-JSON, non-octet-stream response as *text*, which corrupts
// binary. That path builds the request itself and asks for a Blob.
//
// Resolution (runtime /config.js, then the build-time inline, then a throw) lives in ../config.js.
// Re-exporting rather than re-reading keeps this module the single import site the rest of the app
// already uses.
export { SUPABASE_URL, SUPABASE_ANON_KEY };

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
