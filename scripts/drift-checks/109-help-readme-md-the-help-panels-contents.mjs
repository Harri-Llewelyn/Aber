import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { allFiles, fail, HELP_PAGES, HELP_SYNTAX, helpParser, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 109. help/README.md, the help panel's contents, lists every page of help/ exactly once, and every
// link in help/ goes where the panel can follow it: a page of help/ and a heading in it, by the ids
// the panel gives its headings, or a file of the repository. Links are resolved by
// frontend/src/help/syntax.js's resolveLink(), as the build resolves them. A repository anchor is
// check 1's. help/ holds pages only: the bundle takes nothing else from it.
// -------------------------------------------------------------------------------------------------
export default async function check() {
  const helpMarked = helpParser((await import('node:module')).createRequire);
  const helpSyntax = await import(HELP_SYNTAX);
  if (!helpMarked) {
    fail('check 109 reads help/ with marked too, and frontend/node_modules has none: run `npm ci` in frontend/');
  } else {
    const { resolveLink, headingIds } = helpSyntax;
    const wrong = [];
    for (const f of allFiles.filter((p) => p.startsWith('help/') && !p.endsWith('.md'))) {
      wrong.push(`${f} is not a page: help/ holds Markdown pages only, and the dashboard bundles nothing else from it`);
    }

    const plain = (tokens = []) => tokens.map((t) => (t.type === 'text' || t.type === 'escape') && !t.tokens ? t.text
      : t.type === 'codespan' ? t.text : t.type === 'br' ? ' ' : plain(t.tokens)).join('');
    const parsed = new Map();
    for (const file of HELP_PAGES) {
      const key = file.slice('help/'.length, -'.md'.length);
      const nextId = headingIds();
      const ids = new Set();
      const links = [];
      const visit = (t) => {
        if (t.type === 'heading') ids.add(nextId(plain(t.tokens).replace(/\s+/g, ' ').trim()));
        if (t.type === 'link') links.push(t.href);
        for (const c of t.tokens || []) visit(c);
        for (const item of t.items || []) visit(item);
        for (const cell of [...(t.header || []), ...(t.rows || []).flat()]) cell.tokens.forEach(visit);
      };
      helpMarked.lexer(read(file)).forEach(visit);
      parsed.set(key, { file, ids, links });
    }

    const counts = { help: 0, repo: 0, external: 0 };
    for (const [key, { file, links }] of parsed) {
      for (const href of links) {
        const to = resolveLink(key, href);
        if (to.kind === 'invalid') { wrong.push(`${file} links to \`${href}\`, which the panel cannot follow: ${to.reason}`); continue; }
        counts[to.kind] += 1;
        if (to.kind === 'help') {
          const target = parsed.get(to.file);
          if (!target) wrong.push(`${file} links to \`${href}\`, and help/${to.file}.md does not exist`);
          else if (to.anchor && !target.ids.has(to.anchor)) wrong.push(`${file} links to \`${href}\`, and help/${to.file}.md has no heading with the id ${to.anchor}`);
        } else if (to.kind === 'repo' && !existsSync(join(REPO, to.path))) {
          wrong.push(`${file} links to \`${href}\`, and ${to.path} does not exist`);
        }
      }
    }

    const CONTENTS = 'README';
    const listed = new Map();
    for (const href of parsed.get(CONTENTS)?.links || []) {
      const to = resolveLink(CONTENTS, href);
      if (to.kind === 'help') listed.set(to.file, (listed.get(to.file) || 0) + 1);
    }
    if (!parsed.has(CONTENTS)) wrong.push('help/README.md is missing, and the help panel draws its contents from it');
    for (const key of [...parsed.keys()].filter((k) => k !== CONTENTS)) {
      const n = listed.get(key) || 0;
      if (n === 0) wrong.push(`help/README.md does not list help/${key}.md, so the panel's contents never show it`);
      if (n > 1) wrong.push(`help/README.md lists help/${key}.md ${n} times; list each page once`);
    }

    if (wrong.length) {
      fail('the help panel cannot reach every page of help/, or a link in help/ goes nowhere it can follow:\n' +
        wrong.map((w) => `        ${w}`).join('\n'));
    } else {
      pass(`help/README.md lists all ${parsed.size - 1} other page(s) of help/ once each, and all ${counts.help + counts.repo + counts.external} link(s) in help/ resolve (${counts.help} in help/, ${counts.repo} to the repository, ${counts.external} to other sites)`);
    }
  }
}
