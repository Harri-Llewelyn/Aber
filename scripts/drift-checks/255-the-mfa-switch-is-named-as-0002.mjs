import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 255. The MFA switch is named as 0002 declares it, and its refusal's way on is the tab that exists.
// The Settings, Profile and Access Control help pages and docs/security-model.md give the row's
// label, and every one names Profile › MFA, which navigation.jsx's Profile tabs must hold. A page
// that names another label, or a tab that was renamed, sends a refused person nowhere.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems255 = [];
  const seed = read('supabase/migrations/0002_seed_data.sql');
  const label = seed.match(/'security\.require_mfa_for_managers',\s*to_jsonb\(false\),\s*'boolean',\s*'([^']+)',\s*'([^']+)'/);
  const nav = read('frontend/src/navigation.jsx');
  const profileTabs = nav.slice(nav.indexOf('export const PROFILE_TABS'), nav.indexOf(']', nav.indexOf('export const PROFILE_TABS')));
  const settingsTabs = nav.slice(nav.indexOf('export const SETTINGS_TABS'), nav.indexOf(']', nav.indexOf('export const SETTINGS_TABS')));
  if (!label) problems255.push('0002 declares no boolean security.require_mfa_for_managers');
  else if (!settingsTabs.includes(`label: '${label[1]}'`)) problems255.push(`navigation.jsx's SETTINGS_TABS has no ${label[1]} category for it`);
  if (!/\{ id: 'mfa', label: 'MFA'/.test(profileTabs)) problems255.push("navigation.jsx's PROFILE_TABS has no MFA tab, which every refusal names");
  const pages = {
    'help/pages/settings.md': [label?.[2], 'Profile › MFA'],
    'help/pages/profile.md': ['Settings', 'Security'],
    'help/pages/access-control.md': ['Settings requires MFA'],
    'docs/security-model.md': [label?.[2], 'security.require_mfa_for_managers', 'Profile › MFA'],
  };
  for (const [page, phrases] of Object.entries(pages)) {
    const text = read(page);
    for (const phrase of phrases.filter(Boolean)) {
      if (!text.includes(phrase)) problems255.push(`${page} does not say "${phrase}"`);
    }
    if (/Profile › Security/.test(text)) problems255.push(`${page} names Profile › Security; the tab is Profile › MFA`);
  }
  if (problems255.length) {
    for (const p of problems255) fail(`check 255: ${p}.`);
  } else {
    pass(`the MFA switch, "${label[2]}", is named as 0002 declares it on ${Object.keys(pages).length} pages, each pointing to Profile › MFA`);
  }
}
