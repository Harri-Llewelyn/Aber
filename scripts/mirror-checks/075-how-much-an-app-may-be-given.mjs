import { compare, lastDefinition, need, problems, read } from './lib.mjs';

// 75. How much an app may be given, three places each (0260). register_app() takes 1 to c_max_uris
// redirect addresses, GoTrue refuses a client with more than ten, and the dialog's redirectAddressesProblem()
// stops at APP_REDIRECT_MAX; the name is 1 to c_max_name characters, and appNameProblem() stops at APP_NAME_MAX.
export default function check() {
  const fn = lastDefinition('CREATE OR REPLACE FUNCTION public.register_app(', '$$;', 'register_app() in the applied chain');
  const js = read('frontend/src/utils/apps.js');
  const sqlUris = fn && need(fn.body, /c_max_uris\s+CONSTANT integer := (\d+);/, 'c_max_uris in register_app()');
  const sqlName = fn && need(fn.body, /c_max_name\s+CONSTANT integer := (\d+);/, 'c_max_name in register_app()');
  const jsUris = need(js, /export const APP_REDIRECT_MAX = (\d+)/, 'APP_REDIRECT_MAX in utils/apps.js');
  const jsName = need(js, /export const APP_NAME_MAX = (\d+)/, 'APP_NAME_MAX in utils/apps.js');
  if (sqlUris && jsUris) compare('appLimits', `most redirect addresses register_app() (${fn.file}) and the dialog take`, jsUris[1], sqlUris[1]);
  if (sqlName && jsName) compare('appLimits', `longest app name register_app() (${fn.file}) and the dialog take`, jsName[1], sqlName[1]);
  // GoTrue's own limit (v2.197.0 validateRedirectURIList): a client with more is refused by its router.
  if (sqlUris && Number(sqlUris[1]) > 10) problems.push(`appLimits: register_app() takes ${sqlUris[1]} redirect addresses, and GoTrue (v2.197.0) refuses a client with more than 10`);
}
