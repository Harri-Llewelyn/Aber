import { compare, need, read, SCHEMA } from './lib.mjs';

// 15. A person's display name. The dashboard's forms and manage-people's `add` refuse a name before
// sending it, with displayNameProblem(); person_profiles' CHECKs refuse it in the database. A
// character or a length only one side refuses is a form that blocks a legal name, or an add that
// creates the account and then fails to name it.
export default function check() {
  const sides = [
    ['frontend/src/utils/displayName.js', read('frontend/src/utils/displayName.js')],
    ['supabase/functions/manage-people/displayName.ts', read('supabase/functions/manage-people/displayName.ts')],
  ];
  const sqlClass = need(
    SCHEMA,
    /CONSTRAINT person_profiles_display_name_printable CHECK \(display_name !~ '\[([^\]]+)\]'\)/,
    'person_profiles_display_name_printable in the applied chain'
  );
  const sqlLength = need(
    SCHEMA,
    /CONSTRAINT person_profiles_display_name_length CHECK \(char_length\(display_name\) BETWEEN 1 AND (\d+)\)/,
    'person_profiles_display_name_length in the applied chain'
  );
  for (const [file, source] of sides) {
    const jsClass = need(source, /DISPLAY_NAME_FORBIDDEN = \/\[([^\]]+)\]\//, `DISPLAY_NAME_FORBIDDEN in ${file}`);
    const jsLength = need(source, /DISPLAY_NAME_MAX = (\d+)/, `DISPLAY_NAME_MAX in ${file}`);
    if (jsClass && sqlClass) compare('displayName', `characters ${file} and the CHECK refuse`, jsClass[1], sqlClass[1]);
    if (jsLength && sqlLength) compare('displayName', `longest name ${file} and the CHECK allow`, jsLength[1], sqlLength[1]);
  }
}
