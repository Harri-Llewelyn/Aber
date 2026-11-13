import { compare, need, read, SCHEMA } from './lib.mjs';

// 39. The System page's figures, by name. 0223 seeds one directory_figures row per figure, and the
// page reads each row by its key (FIGURE_KEYS in frontend/src/utils/systemFigures.js). A key on one
// side only is a tile that reads "not observed" for ever, which looks like Prometheus not answering.
// The API reference's DirectoryFigure enum names the same seven.
export default function check() {
  const seed = SCHEMA.slice(SCHEMA.lastIndexOf('INSERT INTO public.directory_figures (key) VALUES'));
  const seeded = need(seed, /^INSERT INTO public\.directory_figures \(key\) VALUES([\s\S]*?)ON CONFLICT/,
    'the directory_figures seed in the applied migrations');
  const js = need(read('frontend/src/utils/systemFigures.js'), /export const FIGURE_KEYS = Object\.freeze\(\[([\s\S]*?)\]\)/,
    'FIGURE_KEYS in frontend/src/utils/systemFigures.js');
  const spec = need(read('docs/openapi.yaml'), /\n {4}DirectoryFigure:\n[\s\S]*?enum: \[([^\]]*)\]/,
    "DirectoryFigure's key enum in docs/openapi.yaml");
  if (seeded && js && spec) {
    const keys = (text, re) => [...text.matchAll(re)].map((m) => m[1]).sort().join(', ');
    const sql = keys(seeded[1], /\('([a-z_]+)'\)/g);
    compare('systemFigureKeys', 'the figures the System page reads', keys(js[1], /'([a-z_]+)'/g), sql);
    compare('systemFigureKeys', 'the figures the API reference names', keys(spec[1], /([a-z_]+)/g), sql);
  }
}
