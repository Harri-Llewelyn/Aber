/**
 * The rows of a generated `idta_template_elements` block, read back from its SQL. The seed-sync check
 * and the drift checks read what executes, not what the generator would write.
 */
import { COLUMNS } from './idta-template.mjs';

/** The statements of a block's body. Each starts with the INSERT at the start of a line. */
export const splitStatements = (body) => body.split(/^(?=INSERT INTO public\.idta_template_elements )/m).filter(Boolean);

/**
 * One SQL value at `at`: `{ value, next }`. A string with its quotes doubled, a whole number, NULL, or
 * an array of strings cast to text[]. Null when what is there is none of them.
 */
function valueAt(line, at) {
  if (line.startsWith('NULL', at)) return { value: null, next: at + 4 };
  if (line.startsWith('ARRAY[', at)) {
    const value = [];
    let next = at + 'ARRAY['.length;
    while (line[next] !== ']') {
      const item = valueAt(line, next);
      if (item === null || typeof item.value !== 'string') return null;
      value.push(item.value);
      next = line.startsWith(', ', item.next) ? item.next + 2 : item.next;
      if (next >= line.length) return null;
    }
    return line.startsWith(']::text[]', next) ? { value, next: next + ']::text[]'.length } : null;
  }
  if (line[at] === "'") {
    let value = '';
    for (let i = at + 1; i < line.length; i += 1) {
      if (line[i] !== "'") value += line[i];
      else if (line[i + 1] === "'") { value += "'"; i += 1; } else return { value, next: i + 1 };
    }
    return null;
  }
  const number = /^\d+/.exec(line.slice(at, at + 12));
  return number ? { value: Number(number[0]), next: at + number[0].length } : null;
}

/** The values between `at` and the `close` character, separated by `, `. Null when it is not such a list. */
function valuesAt(line, at, close) {
  const values = [];
  for (let next = at; ;) {
    const item = valueAt(line, next);
    if (item === null) return null;
    values.push(item.value);
    if (line.startsWith(', ', item.next)) next = item.next + 2;
    else return line.startsWith(close, item.next) ? values : null;
  }
}

/** A statement's template (`[id, name, number, version]`) and its rows, by column. Null for another form. */
export function rowsOf(statement) {
  const lines = statement.split('\n');
  const select = lines.find((line) => line.startsWith("SELECT '"));
  const first = lines.indexOf('  FROM (VALUES');
  const last = lines.indexOf(`  ) AS e (${COLUMNS.join(', ')})`);
  if (!select || first < 0 || last < first) return null;
  const template = valuesAt(`${select.slice('SELECT '.length, -1)};`, 0, ';');
  if (template === null || template.length !== 4) return null;
  const rows = [];
  for (const line of lines.slice(first + 1, last)) {
    const values = line.startsWith('(') ? valuesAt(line, 1, ')') : null;
    if (values === null || values.length !== COLUMNS.length || !/\),?$/.test(line)) return null;
    rows.push(Object.fromEntries(COLUMNS.map((column, at) => [column, values[at]])));
  }
  return { template, rows };
}
