#!/usr/bin/env node
// The old name of scripts/mint-api-token.mjs, deprecated in 1.7.0 and removed in 1.8.0
// (docs/releases.md, Deprecation). It says so on stderr, then runs the new script in this process,
// so the arguments and the exit code are the same and stdout stays the new script's alone: `--json`
// output still parses.
console.error('scripts/mint-mcp-token.mjs is now scripts/mint-api-token.mjs; the old name is removed in 1.8.0.');

// Dynamic, not a static import: a static one would run the script before the line above.
await import('./mint-api-token.mjs');
