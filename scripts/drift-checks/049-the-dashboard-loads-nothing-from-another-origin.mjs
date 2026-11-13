import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 49. The dashboard loads nothing from another origin on a page load.
//
// Its index.html and its stylesheets name no http://, https:// or protocol-relative URL in a
// <link>, a <script src>, an @import or a url(). Every browser that opens a page would otherwise
// contact that host, and a site with no internet route would get a different page.
// deploy/k8s/README.md, "Outbound connections", says so. Comments are not read.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const PAGES = [
    'frontend/index.html',
    ...allFiles.filter((f) => f.startsWith('frontend/src/') && f.endsWith('.css')),
  ];
  // Each ends at an http:, https: or protocol-relative // after the opening quote, if any.
  const REFERENCES = [
    ['<link>', /<link\b[^>]*\bhref\s*=\s*["']?\s*(?:https?:)?\/\//gi],
    ['<script src>', /<script\b[^>]*\bsrc\s*=\s*["']?\s*(?:https?:)?\/\//gi],
    ['@import', /@import\s+(?:url\(\s*)?["']?\s*(?:https?:)?\/\//gi],
    ['url()', /(?<!@import\s+)\burl\(\s*["']?\s*(?:https?:)?\/\//gi],
  ];
  // A comment keeps its newlines, so a line number still points at the source. <!-{2} and -{2}>, not
  // the markers: Semgrep's parser, not Node, reads a regex opening with one as a comment.
  const blank = (text) => text.replace(/<!-{2}[\s\S]*?-{2}>|\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));

  const offences = [];
  for (const file of PAGES) {
    const source = read(file);
    const lines = source.split('\n');
    const text = blank(source);
    for (const [what, pattern] of REFERENCES) {
      for (const m of text.matchAll(pattern)) {
        const line = text.slice(0, m.index).split('\n').length;
        offences.push(`${file}:${line} (${what}): ${lines[line - 1].trim().slice(0, 140)}`);
      }
    }
  }

  if (PAGES.length < 2) {
    fail(`check 49 found ${PAGES.length} dashboard page(s) and stylesheet(s); the file list no longer matches`);
  } else if (offences.length) {
    fail(
      'the dashboard loads something from another origin on every page:\n' +
        [...new Set(offences)].map((o) => `        ${o}`).join('\n') +
        '\n        (serve it from the frontend image instead, as frontend/src/assets/fonts/ does)'
    );
  } else {
    pass(`the dashboard's index.html and ${PAGES.length - 1} stylesheet(s) load nothing from another origin`);
  }
}
