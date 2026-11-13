import { compare, need, problems, read, SCHEMA } from './lib.mjs';

// 64. An area's and a cell's name. Their dialogs hold Save, and say why, with placeNameProblem();
// areas_name_topic_safe and cells_name_topic_safe refuse the name in the database. A character only
// one side refuses is a dialog that blocks a legal name, or one that lets the save fail with a
// constraint error.
export default function check() {
  const js = read('frontend/src/utils/unsPath.js');
  const jsChars = need(js, /^const UNSAFE = \/\[([^\]]+)\]\//m, 'UNSAFE in unsPath.js');
  const jsEmpty = /export const placeNameProblem = [^\n]*!\(name \|\| ''\)\.trim\(\)/.test(js);
  const sorted = (chars) => [...chars].sort().join('');
  for (const table of ['areas', 'cells']) {
    const check = need(
      SCHEMA,
      new RegExp(`CONSTRAINT ${table}_name_topic_safe CHECK \\(\\(\\(name <> ''::text\\) AND \\(name !~ '\\[([^\\]]+)\\]'::text\\)\\)\\)`),
      `${table}_name_topic_safe in the applied chain`
    );
    if (jsChars && check) {
      compare('placeName', `characters the dialog and ${table}_name_topic_safe refuse`, sorted(jsChars[1]), sorted(check[1]));
    }
  }
  if (!jsEmpty) problems.push('placeName: placeNameProblem() no longer refuses the empty name the CHECKs refuse');
}
