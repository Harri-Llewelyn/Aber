import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 607. Every check_violation a trigger can raise on an approval from Quarantine is classed: shown to the
// person, or not. The approval updates a device's gateway, cell and area, and a merge deletes a device,
// so the triggers are those of public.devices that fire on either. refusals.ts shows the sentences that
// end as its ARCHIVED_PLACE lists them, and no shown sentence names a table, a column or a function. The
// function's README and the API reference say what is answered.
// -------------------------------------------------------------------------------------------------

const REFUSALS = 'supabase/functions/approve-quarantine/refusals.ts';
const README = 'supabase/functions/approve-quarantine/README.md';
const REFERENCE = 'docs/openapi.yaml';

/** The trigger functions that refuse with a sentence, and whether a person is shown it. */
const CLASSED = {
  refuse_filing_in_an_archived_cell: true,
  refuse_assigning_to_an_archived_gateway: true,
  refuse_area_wide_in_an_archived_area: true,
  // Their words name a table and a column. The dialog offers neither choice.
  refuse_hand_assigning_a_replay_lane: false,
  refuse_hand_making_a_replay_lane: false,
};

/** What no sentence a person is shown may hold: an identifier, or a function's call. */
const IDENTIFIER = /[a-z]+(?:_[a-z]+)+|\(\)|^devices:/;

/** One statement of plpgsql from `at`, as its quoted text and the code around it: `''` is a quote inside. */
function statement(sql, at) {
  let code = '';
  let quoted = '';
  let open = false;
  for (let i = at; i < sql.length; i += 1) {
    if (sql[i] === "'") {
      if (open && sql[i + 1] === "'") { quoted += "'"; i += 1; } else open = !open;
    } else if (open) quoted += sql[i];
    else if (sql[i] === ';') break;
    else code += sql[i];
  }
  return { code, quoted };
}

export default function check() {
  const problems607 = [];
  const lf = (path) => read(path).replace(/\r\n/g, '\n');
  const migrations = allFiles.filter((f) => /^supabase\/migrations\/[0-9]{4}_.*\.sql$/.test(f)).sort();
  const sources = new Map(migrations.map((f) => [f, lf(f)]));

  // The triggers of public.devices an approval or a merge fires, by the function each calls.
  const functions = new Set();
  for (const sql of sources.values()) {
    for (const m of sql.matchAll(/CREATE TRIGGER \w+ (?:BEFORE|AFTER) ([A-Z a-z_,]+?) ON public\.devices FOR EACH ROW(?: WHEN \([^\n]*?\))? EXECUTE FUNCTION public\.(\w+)\(/g)) {
      const events = m[1];
      const columns = /UPDATE OF ([a-z_, ]+)/.exec(events)?.[1].split(',').map((c) => c.trim().replace(/ OR.*/, ''));
      const updates = /\bUPDATE\b/.test(events) && (!columns || columns.some((c) => ['gateway_id', 'cell_id', 'area_id', 'location_scope', 'name', 'is_quarantined'].includes(c)));
      if (updates || /\bDELETE\b/.test(events)) functions.add(m[2]);
    }
  }
  if (functions.size < 8) problems607.push(`read only ${functions.size} trigger functions of public.devices out of the migrations, so this check is no longer checking anything`);

  /** A function's body as the last migration that declares it has it. */
  const body = (fn) => {
    const declares = `CREATE OR REPLACE FUNCTION public.${fn}(`;
    const file = migrations.filter((f) => sources.get(f).includes(declares)).at(-1);
    if (!file) return '';
    const from = sources.get(file).slice(sources.get(file).lastIndexOf(declares));
    const quote = /AS (\$\w*\$)/.exec(from)?.[1];
    const start = from.indexOf(quote) + quote.length;
    return from.slice(start, from.indexOf(quote, start));
  };
  /** Each check_violation it raises. Adjacent literals join, as the database joins them; ERRCODE's is the last. */
  const CODE = 'check_violation';
  const refusalsOf = (fn) => [...body(fn).matchAll(/RAISE EXCEPTION/g)]
    .map((m) => statement(body(fn), m.index))
    .filter(({ code, quoted }) => /USING\s+ERRCODE\s*=/.test(code) && quoted.endsWith(CODE))
    .map(({ quoted }) => {
      const sentence = quoted.slice(0, -CODE.length);
      // A CASE among the arguments leaves its own words after the sentence, which ends with its last full stop.
      return sentence.slice(0, sentence.lastIndexOf('.') + 1);
    });

  const endings = [...(lf(REFUSALS).match(/const ARCHIVED_PLACE = \[([\s\S]*?)\];/)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (!endings.length) problems607.push(`could not read ARCHIVED_PLACE out of ${REFUSALS}`);

  const shown = [];
  for (const fn of [...functions].sort()) {
    const sentences = refusalsOf(fn);
    if (!sentences.length) continue;
    if (!(fn in CLASSED)) {
      problems607.push(`${fn}() refuses an approval in a sentence this check does not class: name it here, and in ${REFUSALS} if a person can act on it`);
      continue;
    }
    for (const sentence of sentences) {
      const isShown = endings.some((ending) => sentence.endsWith(ending));
      if (isShown !== CLASSED[fn]) problems607.push(`${fn}() is ${CLASSED[fn] ? 'not shown' : 'shown'} by ${REFUSALS}: "…${sentence.slice(-60)}"`);
      if (isShown) {
        shown.push(sentence);
        const named = IDENTIFIER.exec(sentence)?.[0];
        if (named) problems607.push(`${fn}()'s sentence is shown to a person and names ${named}`);
      }
    }
  }
  for (const fn of Object.keys(CLASSED)) {
    if (!functions.has(fn) || !refusalsOf(fn).length) problems607.push(`${fn}() no longer refuses an approval: take it off this check's list, and off ${README}`);
    if (!lf(README).includes(`\`${fn}()\``)) problems607.push(`${README} does not list ${fn}()`);
  }
  for (const ending of endings) {
    if (!shown.some((s) => s.endsWith(ending))) problems607.push(`${REFUSALS} shows a sentence ending "${ending}", which no trigger writes`);
  }

  const reference = lf(REFERENCE);
  const at = reference.indexOf('  /functions/v1/approve-quarantine:');
  const operation = reference.slice(at, reference.indexOf('\n  /functions/', at + 1));
  for (const says of ['The gateway, the cell or the area named is archived.', 'data:\n                    type: object', 'discarded_device_id:']) {
    if (!operation.includes(says)) problems607.push(`${REFERENCE}'s approve-quarantine does not say: ${says.replace(/\s+/g, ' ')}`);
  }

  if (problems607.length) {
    fail('What an approval from Quarantine is refused with is not classed, or is said otherwise:\n' + problems607.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`approve-quarantine shows ${shown.length} of the sentences a trigger refuses an approval with, none of which names a table or a column, and its README and the API reference say so`);
  }
}
