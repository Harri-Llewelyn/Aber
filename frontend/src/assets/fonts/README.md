# The dashboard's fonts

The dashboard's two typefaces, served from the frontend image rather than from a font CDN, so a
page load fetches nothing from outside the stack. `src/App.css` declares them with `@font-face`;
Vite fingerprints each file into `dist/assets/`.

| File | Family | Subset |
| :--- | :--- | :--- |
| `outfit-latin-wght-normal.woff2` | Outfit, variable weight | latin |
| `outfit-latin-ext-wght-normal.woff2` | Outfit, variable weight | latin-ext |
| `jetbrains-mono-latin-wght-normal.woff2` | JetBrains Mono, variable weight | latin |
| `jetbrains-mono-latin-ext-wght-normal.woff2` | JetBrains Mono, variable weight | latin-ext |

latin-ext carries Welsh's ŵ and ŷ. The browser downloads a subset only when a page uses a character
in its `unicode-range`, so most pages fetch the two latin files alone.

Both families are under the SIL Open Font License 1.1: `outfit-OFL.txt` and `jetbrains-mono-OFL.txt`.
`NOTICE.md` lists them. Each woff2 file also carries its copyright and the licence's URL in its own
metadata.

## Where each file came from

Downloaded on 2026-10-08. Each woff2 file is byte-identical to the Fontsource CDN's
`https://cdn.jsdelivr.net/fontsource/fonts/<family>:vf@latest/<subset>-wght-normal.woff2` on that day.

| File | Source |
| :--- | :--- |
| `outfit-latin-wght-normal.woff2` | https://cdn.jsdelivr.net/npm/@fontsource-variable/outfit@5.3.0/files/outfit-latin-wght-normal.woff2 |
| `outfit-latin-ext-wght-normal.woff2` | https://cdn.jsdelivr.net/npm/@fontsource-variable/outfit@5.3.0/files/outfit-latin-ext-wght-normal.woff2 |
| `jetbrains-mono-latin-wght-normal.woff2` | https://cdn.jsdelivr.net/npm/@fontsource-variable/jetbrains-mono@5.3.0/files/jetbrains-mono-latin-wght-normal.woff2 |
| `jetbrains-mono-latin-ext-wght-normal.woff2` | https://cdn.jsdelivr.net/npm/@fontsource-variable/jetbrains-mono@5.3.0/files/jetbrains-mono-latin-ext-wght-normal.woff2 |
| `outfit-OFL.txt` | https://raw.githubusercontent.com/google/fonts/5e8a3ba899557829a76cfdac30fa512bda91d7ca/ofl/outfit/OFL.txt |
| `jetbrains-mono-OFL.txt` | https://raw.githubusercontent.com/google/fonts/5e8a3ba899557829a76cfdac30fa512bda91d7ca/ofl/jetbrainsmono/OFL.txt |

The `unicode-range` of each `@font-face` rule is the one in the same package's `wght.css`.

## Replacing or adding a file

1. Download the new file from the same package at a pinned version.
2. Check it is a real woff2 file: its first four bytes are `wOF2`.
3. Copy the `unicode-range` from that package's `wght.css` into the rule in `src/App.css`.
4. Update the tables above.

Never point a rule at a CDN URL. `scripts/check-docs-drift.mjs` fails if `index.html` or a
stylesheet names another origin.
