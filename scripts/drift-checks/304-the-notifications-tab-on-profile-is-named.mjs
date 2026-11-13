import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 304. The Notifications tab on Profile is named as the page draws it. navigation.jsx lists it right
// after Appearance with its description, the search offers it, and ProfileTab.jsx labels its one row
// "Desktop notifications" with an "Allow Notifications" button. The Profile help names the tab, the
// row and the button, and the alert counter's help links to the section that explains them. A tab
// renamed, or a button relabelled, leaves a help page that tells a person to select what is not there.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems304 = [];
  const nav = read('frontend/src/navigation.jsx');
  const tabs = nav.slice(nav.indexOf('export const PROFILE_TABS'), nav.indexOf(']', nav.indexOf('export const PROFILE_TABS')));
  const ids = [...tabs.matchAll(/\{ id: '([a-z-]+)', label: '([^']+)', description: '[^']+'/g)].map((m) => m[1]);
  if (ids.join() !== 'account,appearance,notifications,sessions,mfa,allowed-apps') {
    problems304.push(`navigation.jsx's PROFILE_TABS are ${ids.join(', ') || 'unreadable'}, and the Notifications tab follows Appearance`);
  }
  if (!/\{ id: 'notifications', label: 'Notifications'/.test(tabs)) problems304.push("navigation.jsx's PROFILE_TABS has no Notifications tab");
  if (!/tabCard\('profile', 'notifications'\)/.test(read('frontend/src/searchIndex.js'))) {
    problems304.push("searchIndex.js has no card for Profile's Notifications tab");
  }
  const page = read('frontend/src/components/tabs/ProfileTab.jsx');
  const row = /label="(Desktop notifications)"/.exec(page)?.[1];
  const button = /\n\s+(Allow Notifications)\n\s+<\/button>/.exec(page)?.[1];
  if (!row) problems304.push('ProfileTab.jsx has no Desktop notifications row');
  if (!button) problems304.push('ProfileTab.jsx has no Allow Notifications button');
  const help = read('help/pages/profile.md');
  for (const phrase of ['**Notifications** tab', row && `**${row}**`, button && `**${button}**`, '## Desktop notifications'].filter(Boolean)) {
    if (!help.includes(phrase)) problems304.push(`help/pages/profile.md does not say "${phrase}"`);
  }
  if (!read('help/pages/site-map.md').includes('(profile.md#desktop-notifications)')) {
    problems304.push("help/pages/site-map.md's alert counter does not link to profile.md#desktop-notifications");
  }
  if (problems304.length) {
    for (const m of problems304) fail(`check 304: ${m}.`);
  } else {
    pass(`Profile's Notifications tab follows Appearance, and the help names its "${row}" row and "${button}" button and links to them from the alert counter`);
  }
}
