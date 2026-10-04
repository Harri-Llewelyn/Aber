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
npm run lint:deno         # deno lint, deno check and deno test
npm run scan:secrets      # gitleaks
npm run scan:config       # trivy config
npm run scan:source       # Semgrep
npm run audit:deps        # npm audit and pip-audit
```

Every check needs Docker. `lint:js` also needs npm, `scan:config` needs helm, and the rulesets,
advisory databases, the first ESLint install and `lint:deno`, which reads the edge functions' npm
registry metadata on every run, need network access.

CI runs all nine on a clean `ubuntu-latest` runner, in two jobs of [`ci.yml`](../.github/workflows/ci.yml):

- **Secret Scan** runs `scan:secrets` on every push, documentation included, over a full clone
  (`fetch-depth: 0`), because a secret pasted into a README is the case it exists for.
- **Static Analysis** runs the other eight with `node scripts/lint-all.mjs --skip=secrets`, on
  every push that changes more than documentation (the `changes` gate that also guards the
  end-to-end stack). Its setup is Node 24 and Helm 3.16.3; Docker is on the runner already.

Nothing is cached between runs: the pinned ESLint installs into `.cache/lint/eslint` each time.

| Check | Tool | What it reads | What it judges | Allow-list |
| :--- | :--- | :--- | :--- | :--- |
| `lint:db` | splinter, plpgsql_check | The chain migrated into the throwaway Postgres of `test:db` | Studio's Security and Performance Advisors, and every PL/pgSQL body | `scripts/lint/database-allowlist.json`, `splinter` and `plpgsql_check` |
| `lint:historian` | splinter | A throwaway historian built the way the maintenance Job builds it | The same advisors. The TimescaleDB image does not ship plpgsql_check, so its PL/pgSQL is not checked | the same file, `historian_splinter` and `historian_plpgsql_check` |
| `lint:js` | ESLint 9 with the React and Hooks plugins | `frontend/src`, `scripts`, `forge` | `eslint:recommended`, React's recommended rules and the rules of hooks. Missing effect dependencies are a warning | none: an inline `eslint-disable-next-line RULE -- reason` |
| `lint:py` | Ruff 0.14.0 | Every `.py` | Pyflakes and the pycodestyle errors (`ruff.toml`), not style | none: an inline `# noqa: CODE -- reason` |
| `lint:deno` | deno lint 2.5.6, and deno check and deno test with the Deno the functions image builds with | `supabase/functions` | Deno's recommended rules except `no-import-prefix`, type errors, and failing `*_test.ts` | none: an inline `// deno-lint-ignore RULE -- reason` |
| `scan:secrets` | gitleaks 8.30.1 | Every commit on every ref, and what is not committed yet | Keys, tokens and passwords, printed redacted | `.gitleaksignore`, by fingerprint, for committed findings only |
| `scan:config` | trivy config 0.74.0 | The chart rendered from `values-prod.yaml.example`, and every Dockerfile | HIGH and CRITICAL misconfiguration: security contexts, root users, host mounts | `scripts/lint/config-allowlist.json`, by check and resource |
| `scan:source` | Semgrep 1.140.0, `p/default` and `p/security-audit` | The tree, except generated files and the chart's Go templates | Injection, unsafe APIs, workflow supply chain, Dockerfile users | `scripts/lint/semgrep-allowlist.json`, by rule, file and the text of the line |
| `audit:deps` | npm audit, pip-audit 2.9.0 | `frontend/package-lock.json`, `ingestion/` and `i3x/requirements.txt` | Known advisories, HIGH and above for npm and all of them for Python | `scripts/lint/dependency-allowlist.json`, by advisory id |

## Accepting a finding

Fix the finding if you can. When the finding is correct but the code is right anyway, add its key
to the allow-list with a reason a reviewer can check. When the finding is a fault being fixed
elsewhere, name the issue: most of `config-allowlist.json` points to #419, so each fix there
deletes entries. Never accept a secret that is not committed yet. Remove it before the commit.

Each key is chosen to survive unrelated edits:

- **Database** keys are splinter's `cache_key` (the lint, the object and its signature) and
  plpgsql_check's function, level and message, never a line number.
- **Semgrep** keys hash the trimmed text of the flagged line. Moving the line keeps its entry, and
  changing it makes the finding new. A line whose text repeats in the same file shares one entry.
- **trivy** keys name the check and the resource (the container of a workload, or the Dockerfile),
  never a line number.

## Against a running stack

Two scans read what the stack serves rather than its source, so neither is part of `npm run lint`:

- **`npm run scan:http`** runs OWASP ZAP's baseline scan (2.17.0) against every host the release's
  Ingress routes: response headers, cookies and CORS, as a browser meets them, through the real
  Host header and the sign-in redirects between hosts. It needs the development cluster up
  (`npm run dev:up`) and reaches it on the k3d network. Its allow-list is
  `scripts/lint/http-allowlist.json`, keyed by host label and ZAP alert reference (`app 10038-1`),
  with a `hosts` map for a host it skips.
- **`npm run scan:images`** scans the third-party images the chart runs; see
  [`testing.md`](testing.md#keeping-the-pinned-versions-current).

`check-gateway-surface.mjs` proves each route sits behind the authentication it should have.
`scan:http` asks the same surface what it tells a browser. Run it after a change to a route, a
proxy or an image that serves pages, and before a release.

## Query performance

`lint:db` gates splinter's WARN and ERROR findings. Its INFO findings, unused indexes and foreign
keys with no covering index, depend on a workload, and a throwaway database has none. The load run
in [`test-harness/README.md`](../test-harness/README.md#what-the-databases-spend-their-time-on)
measured them against `pg_stat_statements` and `index_advisor`, and records which were acted on and
why the rest stand. Repeat that run after a change to a hot path rather than trusting the INFO list.

## GitHub's own scans

Three of GitHub's scans cover ground the checks above also cover, continuously. They are set under
*Settings → Advanced Security*:

| Scan | Covers | Setting |
| :--- | :--- | :--- |
| CodeQL | `scan:source`, more deeply, for JavaScript, TypeScript, Python and the workflows | *Code scanning → CodeQL analysis*, default setup |
| Dependabot alerts | `audit:deps`, continuously from GitHub's advisory database | *Dependabot alerts* on. *Dependabot security updates* and *version updates* are off: Renovate opens the upgrade pull requests, and a second bot would duplicate them |
| Secret scanning | `scan:secrets`, on every push | *Secret Protection* and *Push protection* on |

The CI jobs above stay. gitleaks reads formats GitHub does not recognise, such as this stack's own
service tokens and the broker's Dynamic Security passwords.

A normal clone does not fetch every ref GitHub serves. To scan everything a visitor can fetch,
scan a mirror clone:

```bash
git clone --mirror https://github.com/Harri-Llewelyn/Aber.git /tmp/aber-mirror.git
node scripts/scan-secrets.mjs --git-dir=/tmp/aber-mirror.git
```
