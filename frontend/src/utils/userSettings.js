import { supabase } from '../lib/supabaseClient'

/*
 * The signed-in person's `user_settings` row (0188): RLS admits their own row and no other, so
 * every call names the id only to say which row it means. Each throws on a refusal or a network
 * failure; useUserSettings.js decides what the page does then. Not through `api`: these run in the
 * background and do not light the top bar's activity line.
 */

/** The row, or null when this person has none yet. */
export async function readUserSettings(userId) {
  const { data, error } = await supabase
    .from('user_settings')
    .select('theme,sidebar_mode')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  return data ?? null
}

/**
 * The first row, from the browser's own copy. ON CONFLICT DO NOTHING: a row another tab created
 * since this one read is kept, and the caller reads again to find out which won.
 */
export async function seedUserSettings(userId, { theme, sidebarMode }) {
  const { error } = await supabase
    .from('user_settings')
    .upsert({ user_id: userId, theme, sidebar_mode: sidebarMode }, { onConflict: 'user_id', ignoreDuplicates: true })
  if (error) throw error
}

/**
 * One choice. An upsert of that column alone, so it also creates a row the seed never wrote, and
 * leaves the other column as another browser last saved it.
 */
export async function saveUserSetting(userId, column, value) {
  const { error } = await supabase
    .from('user_settings')
    .upsert({ user_id: userId, [column]: value }, { onConflict: 'user_id' })
  if (error) throw error
}
