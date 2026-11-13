import { lastDefinition, need, ok, problems, read } from './lib.mjs';

// 25. An ended session, recorded. end_my_session() (a person's own) and end_person_session() (an
// Administrator's, from the person's drawer) each record the session as its list returned it, and
// the Audit Trail names it with sessionLabel() (utils/sessions.js), the Sessions list's own words.
// A field sessionLabel() reads that a row lacks makes every recorded session "Not recorded"; a
// field list_my_sessions() does not return is one the row was never meant to keep, such as an
// address. person_sessions(), the drawer's list, returns list_my_sessions()'s columns but
// is_current, so an Administrator sees no more of a session than its holder does.
export default function check() {
  const list = lastDefinition('CREATE OR REPLACE FUNCTION public.list_my_sessions()', '$$;', 'list_my_sessions() in the applied chain');
  const columnsOf = (def, name) => {
    const returned = def && need(def.body, /RETURNS TABLE\(([\s\S]*?)\)\s*LANGUAGE/, `the columns ${name} returns (${def.file})`);
    return returned ? returned[1].split(',').map((c) => c.trim().split(/\s+/)[0]) : null;
  };
  const columns = columnsOf(list, 'list_my_sessions()');
  const theirs = lastDefinition('CREATE OR REPLACE FUNCTION public.person_sessions(', '$$;', 'person_sessions() in the applied chain');
  const theirColumns = columnsOf(theirs, 'person_sessions()');
  const labelBody = need(read('frontend/src/utils/sessions.js'), /export function sessionLabel\(session\) \{([\s\S]*?)\n\}/, 'sessionLabel() in frontend/src/utils/sessions.js');
  const labelReads = labelBody ? [...new Set([...labelBody[1].matchAll(/session\??\.([a-z_]+)/g)].map((m) => m[1]))] : null;
  need(read('frontend/src/components/tabs/AuditTrailTab.jsx'), /import \{ sessionLabel \} from '\.\.\/\.\.\/utils\/sessions'/, 'the Audit Trail naming a recorded session with sessionLabel()');
  if (columns && theirColumns) {
    const expected = columns.filter((c) => c !== 'is_current').join(', ');
    if (theirColumns.join(', ') === expected) {
      ok.push(`sessionsEnded: person_sessions() returns list_my_sessions()'s columns but is_current = "${expected}"`);
    } else {
      problems.push(`sessionsEnded: person_sessions() (${theirs.file}) returns "${theirColumns.join(', ')}", not list_my_sessions()'s columns but is_current ("${expected}", ${list.file})`);
    }
  }
  for (const fn of ['end_my_session', 'end_person_session']) {
    const end = lastDefinition(`CREATE OR REPLACE FUNCTION public.${fn}(`, '$$;', `${fn}() in the applied chain`);
    const built = end && need(end.body, /jsonb_build_object\(([^;]*?)\)\s*INTO v_session/, `the session ${fn}() records (${end.file})`);
    const recorded = built ? [...built[1].matchAll(/'([a-z_]+)'\s*,/g)].map((m) => m[1]) : null;
    if (!columns || !recorded || !labelReads) continue;
    const before = problems.length;
    for (const key of recorded.filter((k) => !columns.includes(k))) {
      problems.push(`sessionsEnded: ${fn}() (${end.file}) records ${key}, which list_my_sessions() (${list.file}) does not return`);
    }
    for (const field of labelReads.filter((f) => !recorded.includes(f))) {
      problems.push(`sessionsEnded: sessionLabel() reads ${field}, which ${fn}() (${end.file}) does not record`);
    }
    if (recorded.length === 0) problems.push(`sessionsEnded: found no field ${fn}() (${end.file}) records`);
    if (problems.length === before) {
      ok.push(`sessionsEnded: ${fn}() records ${recorded.join(', ')} of list_my_sessions()'s columns, and sessionLabel() reads ${labelReads.join(', ')}`);
    }
  }
}
