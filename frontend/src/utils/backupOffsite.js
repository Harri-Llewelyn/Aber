/**
 * The off-site destination's settings (seeded by 0018), which the Backups page's destination dialog
 * edits. The Settings page does not render them, so each value has one editor. The secret key is in
 * the vault, not here.
 */
export const BACKUP_OFFSITE_SETTING_KEYS = ['endpoint', 'region', 'bucket', 'prefix', 'access_key_id', 'recipient', 'path_style']
  .map(k => `backup_offsite.${k}`)
