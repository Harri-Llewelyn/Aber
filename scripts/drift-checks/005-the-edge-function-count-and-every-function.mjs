import { edgeFunctionNames, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 5. The edge-function count, and every function named in the topology diagram.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const fns = edgeFunctionNames();
  const readme = read('docs/architecture.md');
  // A word not in this map parses as NaN and fails loudly, but reads as a documentation error.
  // Extended past the current count.
  const WORDS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    // AND IT WAS NOT EXTENDED FAR ENOUGH, which the note above predicted. The thirteenth function
    // arrived, the README was updated correctly to "thirteen", and this map answered NaN -- so the
    // guard reported the README as wrong while quoting the right number back at the reader.
    thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  };
  // The count in docs/architecture.md's design-ethos sentence ("... eighteen edge functions, an i3X
  // server and a React dashboard"). A page the pattern no longer matches fails rather than skipping.
  const claimed = readme.match(/(\w+) edge functions, an i3X server/);
  if (!claimed) {
    fail('docs/architecture.md states no "<n> edge functions, an i3X server"; check 5 cannot verify the count');
  } else {
    const n = WORDS[claimed[1].toLowerCase()] ?? Number(claimed[1]);
    if (n !== fns.length) fail(`docs/architecture.md claims "${claimed[1]} edge functions"; ${fns.length} exist: ${fns.join(', ')}`);
  }
  const unnamed = fns.filter((f) => !readme.includes(f));
  if (unnamed.length) fail(`docs/architecture.md never names edge function(s): ${unnamed.join(', ')}`);
  if (!unnamed.length) pass(`docs/architecture.md names all ${fns.length} edge functions`);
}
