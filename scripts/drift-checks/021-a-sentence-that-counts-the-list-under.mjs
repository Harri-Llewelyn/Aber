import { fail, MARKDOWN, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 21. A sentence that counts the list under it agrees with the list.
//
// "Four things about these dumps are not obvious" stood over eight bullets, two of which this
// repository added itself while rehearsing a restore (#338) and left the count behind. That is the
// drift this whole file exists for: a number a reader cannot tell is stale and will act on -- here,
// by reading four and stopping.
//
// IN SCOPE IS A CLAIM THAT POINTS FORWARD at a list it introduces. A sentence naming a list
// "tabulated above" is excluded because the list below it is a different one, and a claim with no
// list within two lines is not introducing one at all. Items are counted at the first item's
// indent, so a nested table, a sub-list or a continuation paragraph belongs to its bullet rather
// than ending the list.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const itemAt = (line) => {
    const m = line.match(/^(\s*)(?:\d+\.|[-*])\s/);
    return m ? m[1].length : null;
  };

  let claims = 0;
  const offences = [];
  for (const file of MARKDOWN) {
    if (file.startsWith('frontend/dist/')) continue;
    const lines = read(file).split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const m = lines[i].match(/^\s*(?:\*\*)?([A-Z][a-z]+|\d+)\s+(?:rules?|reasons?|things?|steps?|ways?)\b/);
      if (!m) continue;
      const n = WORDS[m[1].toLowerCase()] ?? Number(m[1]);
      if (!n || n > 10) continue;
      if (/\babove\b|\bearlier\b|\bpreviously\b/.test(lines[i])) continue;

      let j = i + 1;
      while (j < lines.length && j <= i + 2 && /^\s*$/.test(lines[j])) j += 1;
      const base = j < lines.length ? itemAt(lines[j]) : null;
      if (base === null) continue;

      let items = 0;
      for (; j < lines.length; j += 1) {
        const line = lines[j];
        if (/^\s*$/.test(line)) continue;
        const at = itemAt(line);
        if (at === base) { items += 1; continue; }
        if (line.match(/^(\s*)/)[1].length > base) continue;
        break;
      }
      claims += 1;
      if (items !== n) {
        offences.push(`${file}:${i + 1} says ${n}, the list under it has ${items}: ${lines[i].trim().slice(0, 70)}`);
      }
    }
  }

  if (offences.length) {
    fail(
      'a sentence counts a list and the list disagrees:\n' +
        offences.map((o) => `        ${o}`).join('\n')
    );
  } else {
    pass(`all ${claims} counted list claim(s) match the list under them`);
  }
}
