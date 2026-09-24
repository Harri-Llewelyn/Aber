# Static analysis

Nine checks read the source, the schema and the history without running the stack. Each runs in a
pinned container or from a pinned lockfile, and each fails on any finding that is not in its
allow-list. Every allow-list entry carries the reason it was accepted. An entry that no longer
matches anything is reported as stale, so delete it: left in place, it would hide the same finding
if it came back.

```bash
npm run lint              # all nine, one after another, with a summary; --skip=NAME,... to leave some out
npm run lint:db           # the Supabase schema (also runs inside npm run test:db)
npm run lint:historian    # the TimescaleDB schema
npm run lint:js           # ESLint
npm run lint:py           # Ruff
npm run lint:deno         # deno lint
npm run scan:secrets      # gitleaks
npm run scan:config       # trivy config
npm run scan:source       # Semgrep
npm run audit:deps        # npm audit and pip-audit
```

Every check needs Docker. `lint:js` also needs npm, `scan:config` needs helm, and the rulesets,
advisory databases and first ESLint install need network access. CI does not run them yet (#387).

| Check | Tool | What it reads | What it judges | Allow-list |
| :--- | :--- | :--- | :--- | :--- |
| `lint:db` | splinter, plpgsql_check | The chain migrated into the throwaway Postgres of `test:db` | Studio's Security and Performance Advisors, and every PL/pgSQL body | `scripts/lint/database-allowlist.json`, `splinter` and `plpgsql_check` |
| `lint:historian` | splinter | A throwaway historian built the way the maintenance Job builds it | The same advisors. The TimescaleDB image does not ship plpgsql_check, so its PL/pgSQL is not checked | the same file, `historian_splinter` and `historian_plpgsql_check` |
| `lint:js` | ESLint 9 with the React and Hooks plugins | `frontend/src`, `scripts`, `forge` | `eslint:recommended`, React's recommended rules and the rules of hooks. Missing effect dependencies are a warning | none: an inline `eslint-disable-next-line RULE -- reason` |
| `lint:py` | Ruff 0.14.0 | Every `.py` | Pyflakes and the pycodestyle errors (`ruff.toml`), not style | none: an inline `# noqa: CODE -- reason` |
| `lint:deno` | deno lint 2.5.6 | `supabase/functions` | Deno's recommended rules except `no-import-prefix` | none: an inline `// deno-lint-ignore RULE -- reason` |
| `scan:secrets` | gitleaks 8.30.1 | Every commit on every ref, and what is not committed yet | Keys, tokens and passwords, printed redacted | `.gitleaksignore`, by fingerprint, for committed findings only |
| `scan:config` | trivy config 0.74.0 | The chart rendered from `values-prod.yaml.example`, and every Dockerfile | HIGH and CRITICAL misconfiguration: security contexts, root users, host mounts | `scripts/lint/config-allowlist.json`, by check and resource |
| `scan:source` | Semgrep 1.140.0, `p/default` and `p/security-audit` | The tree, except generated files and the chart's Go templates | Injection, unsafe APIs, workflow supply chain, Dockerfile users | `scripts/lint/semgrep-allowlist.json`, by rule, file and the text of the line |
| `audit:deps` | npm audit, pip-audit 2.9.0 | `frontend/package-lock.json`, `ingestion/` and `i3x/requirements.txt` | Known advisories, HIGH and above for npm and all of them for Python | `scripts/lint/dependency-allowlist.json`, by advisory id |

## Accepting a finding

Fix the finding if you can. When the finding is correct but the code is right anyway, add its key
to the allow-list with a reason a reviewer can check. When the finding is a fault being fixed
elsewhere, name the issue: most of `config-allowlist.json` points to #419 and the workflow findings
in `semgrep-allowlist.json` point to #421, so each fix there deletes entries. Never accept a secret
that is not committed yet. Remove it before the commit.

Each key is chosen to survive unrelated edits:

- **Database** keys are splinter's `cache_key` (the lint, the object and its signature) and
  plpgsql_check's function, level and message, never a line number.
- **Semgrep** keys hash the trimmed text of the flagged line. Moving the line keeps its entry, and
  changing it makes the finding new. A line whose text repeats in the same file shares one entry.
- **trivy** keys name the check and the resource (the container of a workload, or the Dockerfile),
  never a line number.

## Before the repository goes public

Publishing exposes every pull request's head, including branches deleted after they merged, and a
normal clone does not fetch them. Scan a mirror clone before the flip:

```bash
git clone --mirror https://github.com/Harri-Llewelyn/Aber.git /tmp/aber-mirror.git
node scripts/scan-secrets.mjs --git-dir=/tmp/aber-mirror.git
```

Once the repository is public, CodeQL, Dependabot alerts and secret scanning are free on GitHub and
cover `scan:source`, `audit:deps` and `scan:secrets` in CI. Until then these scripts are the only
coverage (#387).
