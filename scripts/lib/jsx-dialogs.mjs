/**
 * Reads the dialogs in a JSX source: each <Modal> and <ConfirmModal>, its opening tag with its props
 * as written, and what it holds. Drift checks 530, 544, 561, 572, 573, 577 and 578 use it, and the
 * dashboard's test of every dialog's footer. It is not a parser: it walks the source, skipping string and
 * template literals and tracking braces, which is as much as those sources need, and says so where it
 * cannot read one.
 *
 * node: built-ins only: the drift checks run in CI before any `npm install`.
 */

/** The end of the string literal whose quote is at `i`, or `i` itself when the line holds no closing
 *  quote: then the quote is JSX text, such as an apostrophe. */
function stringEnd(src, i) {
  for (let j = i + 1; j < src.length && src[j] !== '\n'; j++) {
    if (src[j] === '\\') j++;
    else if (src[j] === src[i]) return j;
  }
  return i;
}

/**
 * Walks JSX source from `start`, skipping string and template literals and tracking braces, and
 * returns the first index where `stop(char, depth, index)` holds, or -1. Inside an expression, a
 * quote after a letter is JSX text (an apostrophe), as is one with no closing quote on its line.
 */
function walk(src, start, stop) {
  const stack = [];
  for (let j = start; j < src.length; j++) {
    const c = src[j];
    if (stack[stack.length - 1] === '`') {
      if (c === '\\') j++;
      else if (c === '`') stack.pop();
      else if (c === '$' && src[j + 1] === '{') { stack.push('{'); j++; }
      continue;
    }
    if ((c === '"' || c === "'") && (!stack.length || !/\w/.test(src[j - 1]))) { j = stringEnd(src, j); continue; }
    if (c === '`' && stack.length) { stack.push('`'); continue; }
    if (c === '{') stack.push('{');
    else if (c === '}') stack.pop();
    if (stop(c, stack.length, j)) return j;
  }
  return -1;
}

/** The `>` that ends the JSX opening tag whose `<` is at `start`, or -1. */
export const tagEnd = (src, start) => walk(src, start + 1, (c, depth) => c === '>' && depth === 0);

/** Where top-level prop `name` of an opening tag starts its value, or -1. */
export function propAt(tag, name) {
  const at = walk(tag, 0, (c, depth, j) => depth === 0 && /\s/.test(c) && tag.startsWith(`${name}=`, j + 1));
  return at === -1 ? -1 : at + 1 + name.length + 1;
}

/** A prop's value as written: a string's text, or an expression with its braces. '' when absent. */
export function propText(tag, name) {
  const at = propAt(tag, name);
  if (at === -1) return '';
  if (tag[at] === '{') return tag.slice(at, walk(tag, at, (c, depth) => c === '}' && depth === 0) + 1);
  return tag.slice(at + 1, stringEnd(tag, at));
}

/** A prop's literal string value, `undefined` when it is absent, or null for any other expression. */
export function literalProp(tag, name) {
  if (propAt(tag, name) === -1) return undefined;
  const text = propText(tag, name);
  if (tag[propAt(tag, name)] !== '{') return text;
  return text.match(/^\{\s*(['"])(\w*)\1\s*\}$/)?.[2] ?? null;
}

/** The next `<kind` opening tag at or after `from` (not `<kindOther`), or -1. */
function nextOpening(src, kind, from) {
  for (let at = src.indexOf(`<${kind}`, from); at !== -1; at = src.indexOf(`<${kind}`, at + 1)) {
    if (!/\w/.test(src[at + kind.length + 1] ?? '')) return at;
  }
  return -1;
}

/** The text between an opening tag ending at `from` and its closing tag, for a `kind` element. */
function children(src, from, kind) {
  const close = `</${kind}>`;
  let depth = 1;
  let at = from;
  for (;;) {
    const shut = src.indexOf(close, at);
    if (shut === -1) return null;
    const nested = nextOpening(src, kind, at);
    if (nested !== -1 && nested < shut) {
      const end = tagEnd(src, nested);
      if (end !== -1 && src[end - 1] !== '/') depth++;
      at = end === -1 ? nested + 1 : end + 1;
      continue;
    }
    if (--depth === 0) return src.slice(from, shut);
    at = shut + close.length;
  }
}

/**
 * The dialogs in a source, in the order they open. Each is { kind, line, start, end, tag, body }: the
 * opening tag and what is between it and the closing one ('' when it closes itself), with where the
 * whole element starts and ends. One that cannot be read is { kind, line, problem } instead. A dialog
 * named in a comment line is not one.
 *
 * @param {string} src with LF line endings
 */
export function dialogsIn(src) {
  const found = [];
  for (const m of src.matchAll(/<(Modal|ConfirmModal)\b/g)) {
    const [, kind] = m;
    const lead = src.slice(src.lastIndexOf('\n', m.index) + 1, m.index).trim();
    if (lead.startsWith('*') || lead.startsWith('//')) continue;
    const line = src.slice(0, m.index).split('\n').length;
    const tagStop = tagEnd(src, m.index);
    if (tagStop === -1) { found.push({ kind, line, problem: `could not read the <${kind}> opening tag` }); continue; }
    const tag = src.slice(m.index, tagStop + 1);
    const body = src[tagStop - 1] === '/' ? '' : children(src, tagStop + 1, kind);
    if (body === null) { found.push({ kind, line, problem: `could not find the </${kind}> that closes this dialog` }); continue; }
    const end = src[tagStop - 1] === '/' ? tagStop + 1 : tagStop + 1 + body.length + `</${kind}>`.length;
    found.push({ kind, line, start: m.index, end, tag, body });
  }
  return found;
}

/** The expression that starts at the bracket at `at`, to the one that balances it. */
function balanced(src, at) {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    if ('({['.includes(src[i])) depth++;
    else if (')}]'.includes(src[i]) && --depth === 0) return src.slice(at, i + 1);
  }
  return src.slice(at);
}

/** A source without its JSX and line comments. */
export const withoutComments = (src) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

/**
 * What a dialog's footer may hold, without comments: its `footer` prop as written, or, where the prop is
 * `{footer}`, each expression its source assigns to that name. A footer another component returns is not
 * read.
 */
export function footersOf(src, tag) {
  const text = withoutComments(propText(tag, 'footer'));
  if (text !== '{footer}') return [text];
  return [...src.matchAll(/\bfooter = [^(\n]*\(/g)].map((m) => withoutComments(balanced(src, m.index + m[0].length - 1)));
}
