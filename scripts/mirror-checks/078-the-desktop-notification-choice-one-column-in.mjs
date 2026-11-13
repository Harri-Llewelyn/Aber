import { compare, need, problems, read, SCHEMA } from './lib.mjs';

// 78. The desktop-notification choice, one column in two places (0264). user_settings.desktop_notifications
// is off by default, and the browser's copy of it (useDesktopNotifications.js) starts off too, so a
// first paint and a row never written agree. The dashboard reads and writes the column by name,
// utils/userSettings.js selecting it and useUserSettings.js saving to it: a name that differs reads
// back as nothing and saves as an error, which the page turns into a choice held in one browser.
export default function check() {
  const declared = [...SCHEMA.matchAll(/ADD COLUMN IF NOT EXISTS (desktop_notifications) boolean DEFAULT (true|false) NOT NULL/g)].at(-1);
  if (!declared) problems.push('could not find user_settings.desktop_notifications in any applied migration -- the file\'s shape changed, so this check is no longer checking anything');
  const hook = need(read('frontend/src/hooks/useDesktopNotifications.js'), /^const DEFAULT_ON = (true|false)$/m,
    'DEFAULT_ON in frontend/src/hooks/useDesktopNotifications.js');
  const selected = need(read('frontend/src/utils/userSettings.js'), /\.select\('([^']*)'\)/, "the columns readUserSettings() selects in frontend/src/utils/userSettings.js");
  const saved = need(read('frontend/src/hooks/useUserSettings.js'), /save\('(desktop_notifications)', next\)/,
    'the column the desktop notifications choice is saved to in frontend/src/hooks/useUserSettings.js');
  if (declared && hook) compare('desktopNotifications', 'the default, in the migrations and the browser copy', hook[1], declared[2]);
  if (declared && selected) compare('desktopNotifications', "whether the dashboard reads the column the migrations add", selected[1].split(',').includes(declared[1]), true);
  if (declared && saved) compare('desktopNotifications', 'the column the dashboard saves and the one the migrations add', saved[1], declared[1]);
}
