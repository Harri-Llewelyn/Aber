import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { edgeFunctionNames, fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 41. No edge function answers with an error's text.
//
// An unexpected failure answers a fixed sentence and a request id through _shared/failure.ts, and
// the error's message goes to the log (supabase/functions/README.md). The message can name an
// internal host, a table or a constraint, so a response that carries it tells any caller who can
// cause the failure how the platform is built. Two shapes are refused in each function's index.ts,
// and in a module whose handler index.ts passes to Deno.serve (manage-people's people.ts): a
// response built inside a `catch` from the caught error, or from a name assigned from it there; and
// a 5xx response whose arguments read an error's `.message` or `.stack`. A status held in a name
// counts as 5xx when its declaration can give one, unless an `if` comparing that name with a 5xx
// returns between the two (the branch that answers through serverError()). A deliberate 4xx
// sentence the caller can act on is neither. Indirect paths (a helper handed the message) are not
// seen.
// -------------------------------------------------------------------------------------------------
export default function check() {
  /** The source with comments, strings, template text and regex bodies blanked, lengths kept. */
  const codeOnly = (src) => {
    const out = src.split('');
    const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '; };
    const open = []; // braces open inside each template `${...}`
    let i = 0;
    let last = '';
    const template = () => {
      const start = i;
      for (; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === '`') { blank(start, i++); last = '`'; return; }
        if (src[i] === '$' && src[i + 1] === '{') { blank(start, i); i += 2; open.push(0); last = '{'; return; }
      }
      blank(start, i);
    };
    while (i < src.length) {
      const [c, n] = [src[i], src[i + 1]];
      if (c === '/' && (n === '/' || n === '*')) {
        const e = n === '/' ? src.indexOf('\n', i) : src.indexOf('*/', i + 2) + 2;
        const end = e < (n === '/' ? 0 : 2) ? src.length : e;
        blank(i, end); i = end; continue;
      }
      if (c === '"' || c === "'") {
        const start = ++i;
        while (i < src.length && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
        blank(start, i++); last = c; continue;
      }
      if (c === '`') { i++; template(); continue; }
      if (c === '/' && (!last || '(,=:[!&|?{};+-*%<>~^'.includes(last) || /\breturn\s*$/.test(src.slice(i - 8, i)))) {
        const start = ++i;
        for (let inClass = false; i < src.length && src[i] !== '\n' && (inClass || src[i] !== '/'); i++) {
          if (src[i] === '\\') i++;
          else if (src[i] === '[') inClass = true;
          else if (src[i] === ']') inClass = false;
        }
        blank(start, i++); last = '/'; continue;
      }
      if (open.length && c === '{') open[open.length - 1]++;
      if (open.length && c === '}' && open[open.length - 1]-- === 0) { open.pop(); i++; template(); continue; }
      if (!/\s/.test(c)) last = c;
      i++;
    }
    return out.join('');
  };
  /** The index of the bracket that closes the one at `at`. */
  const closing = (code, at) => {
    const pair = { '(': ')', '{': '}' }[code[at]];
    for (let k = at, depth = 0; k < code.length; k++) {
      if (code[k] === code[at]) depth++;
      else if (code[k] === pair && --depth === 0) return k;
    }
    return code.length;
  };
  /** The identifiers a stretch of code names. */
  const names = (text) => new Set(text.match(/[A-Za-z_$][\w$]*/g));

  const offences = [];
  const FIVE_XX = /(?<![\w.])5\d\d(?![\w.])/;
  const entrypoints = [...edgeFunctionNames(), 'main'].map((f) => `supabase/functions/${f}/index.ts`).filter((f) => existsSync(join(REPO, f)));
  // The module a handler is imported from, when index.ts passes that handler to Deno.serve.
  const delegates = entrypoints.flatMap((file) => {
    const src = read(file);
    const served = [...src.matchAll(/\bDeno\.serve\(\s*([A-Za-z_$][\w$]*)\s*\)/g)].map((m) => m[1]);
    return [...src.matchAll(/^import\s*\{([^}]*)\}\s*from\s*"\.\/([\w.-]+\.ts)";/gm)]
      .filter((m) => m[1].split(',').map((n) => n.trim().split(/\s+as\s+/).pop()).some((n) => served.includes(n)))
      .map((m) => posix.join(posix.dirname(file), m[2]));
  });
  const files = [...entrypoints, ...delegates];
  for (const file of files) {
    const code = codeOnly(read(file));
    const blocks = [...code.matchAll(/\bcatch\s*\(\s*(\w+)\s*\)\s*\{/g)].map((m) => {
      const at = m.index + m[0].length - 1;
      const end = closing(code, at);
      const tainted = [m[1]];
      for (const a of code.slice(at, end).matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*([^;]*)/g)) {
        if (tainted.some((t) => names(a[2]).has(t))) tainted.push(a[1]);
      }
      return { at, end, tainted };
    });
    for (const m of code.matchAll(/\b(?:json|jsonResponse|problem)\s*\(|\bnew\s+Response\s*\(/g)) {
      const at = m.index + m[0].length - 1;
      const args = code.slice(at + 1, closing(code, at));
      const line = code.slice(0, m.index).split('\n').length;
      const used = names(args);
      const caught = blocks.filter((b) => m.index > b.at && m.index < b.end).flatMap((b) => b.tainted)
        .find((t) => used.has(t));
      const readsError = /\.(?:message|stack)\b|\bString\s*\(/.test(args);
      // A status passed by name: its last declaration above this call, and whether a comparison
      // with a 5xx between the two sends that case elsewhere.
      const held = /^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(args)?.[1]?.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
      const declared = held
        ? [...code.slice(0, m.index).matchAll(new RegExp(`\\b(?:const|let|var)\\s+${held}\\s*=\\s*([^;]*)`, 'g'))].pop()
        : undefined;
      const guard = held && new RegExp(
        `\\bif\\s*\\(\\s*(?:${held}\\s*(?:===?|>=?)\\s*5\\d\\d|5\\d\\d\\s*(?:===?|<=?)\\s*${held})\\s*\\)\\s*\\{?\\s*return\\b`,
      );
      const heldFiveXx = !!declared && FIVE_XX.test(declared[1])
        && !guard.test(code.slice(declared.index + declared[0].length, m.index));
      if (caught) offences.push(`${file}:${line} answers with \`${caught}\`, the caught error`);
      else if ((FIVE_XX.test(args) || heldFiveXx) && readsError) {
        offences.push(`${file}:${line} answers a 5xx carrying an error's message`);
      }
    }
  }
  if (!files.length) fail('check 41 found no edge function index.ts, so it reads nothing');
  else if (offences.length) {
    fail("an edge function answers with an error's text; use serverError() from _shared/failure.ts:\n" +
      offences.map((o) => `        ${o}`).join('\n'));
  } else {
    pass(`none of ${entrypoints.length} edge function entrypoints, or the ${delegates.length} handler module(s) they delegate to, answers with an error's text`);
  }
}
