import { fail, HELP_PAGES, HELP_SYNTAX, helpParser, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 108. Every construct in help/ is one the help panel's walker draws. frontend/helpCorpus.js parses
// each file with marked when the bundle is built and stops the build on anything else; this finds
// it without a build. The types are frontend/src/help/syntax.js's, the list the parse and the walker
// (HelpMarkdown.jsx) share. marked is a devDependency of frontend/, so this needs its `npm ci`.
// -------------------------------------------------------------------------------------------------
export default async function check() {
  const helpMarked = helpParser((await import('node:module')).createRequire);
  const helpSyntax = await import(HELP_SYNTAX);
  if (!helpMarked) {
    fail('check 108 parses help/ with marked, a devDependency of the dashboard, and frontend/node_modules has none: run `npm ci` in frontend/');
  } else {
    const { HELP_BLOCKS, HELP_INLINES, unsupported, entityIn } = helpSyntax;
    const offences = [];
    const types = new Set();
    for (const file of HELP_PAGES) {
      const source = read(file);
      const at = (raw) => {
        const i = raw ? source.indexOf(raw) : -1;
        return i < 0 ? file : `${file}:${source.slice(0, i).split('\n').length}`;
      };
      // Children of a heading, a paragraph, a list item's text, a table cell and every inline token
      // are inline; children of a list item and a quote are blocks.
      const visit = (t, inline) => {
        types.add(t.type);
        if (!(inline ? HELP_INLINES : HELP_BLOCKS).includes(t.type)) offences.push(`${at(t.raw)} uses ${unsupported(t.type)}`);
        if (t.task) offences.push(`${at(t.raw)} uses ${unsupported('checkbox')}`);
        const entity = inline && (t.type === 'text' || t.type === 'escape') ? entityIn(t.text) : null;
        if (entity) offences.push(`${at(t.raw)} uses an HTML entity, ${entity}: type the character itself`);
        const blocksInside = t.type === 'list_item' || t.type === 'blockquote';
        for (const c of t.tokens || []) visit(c, !blocksInside);
        for (const item of t.items || []) visit(item, false);
        for (const cell of [...(t.header || []), ...(t.rows || []).flat()]) for (const c of cell.tokens) visit(c, true);
      };
      for (const t of helpMarked.lexer(source)) visit(t, false);
    }
    if (offences.length) {
      fail('help/ uses Markdown the help panel does not draw, and the dashboard build stops on it:\n' +
        [...new Set(offences)].map((o) => `        ${o}`).join('\n') +
        '\n      The walker draws what frontend/src/help/syntax.js lists (frontend/README.md, Contextual help).');
    } else {
      pass(`all ${HELP_PAGES.length} page(s) of help/ use only constructs the help walker draws (${[...types].sort().join(', ')})`);
    }
  }
}
