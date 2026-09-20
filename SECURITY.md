# Security policy

## Supported versions

**The latest minor release.** A security fix lands there and is not backported to an earlier one.
That is a light obligation in practice, because any 1.x upgrades directly to any later 1.x — the
migration chain replays every file on every boot, so there is no ladder to climb before taking a
fix. [`docs/releases.md`](docs/releases.md) states the window, what makes a release major, and how
a site learns that one matters to it; this document does not invent a second answer.

## Reporting a vulnerability

**Please do not open a public issue for a security vulnerability.**

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/Harri-Llewelyn/ACS-Cymru/security/advisories/new)
— the **Security** tab, then **Report a vulnerability**. That opens a draft advisory visible only to
the maintainers.

<!-- TODO: add a contact address here as a fallback for reporters who cannot use GitHub. -->

Please include the version or commit you are running, the Kubernetes distribution you deploy to,
and enough detail to reproduce. You will get an acknowledgement, and a decision on
whether it is in scope, as soon as is practical — this is a small project without a staffed
security rota, so please do not expect a same-day response.

## Scope

In scope: the code in this repository — the services, the SQL and its RLS policies, the edge
functions and the Helm chart.

Out of scope: vulnerabilities in the third-party images this stack deploys. Report those to their
own projects. See [`NOTICE.md`](NOTICE.md) for what is deployed and under whose licence. Known,
unfixed CVEs in base images are already tracked by the monthly image scan described in
[`docs/testing.md`](docs/testing.md#keeping-the-pinned-versions-current), which deliberately reports
only *fixable* HIGH and CRITICAL findings.

## Two things that are documented, not defects

Both of these are known and written down, so please read them before reporting:

- **`values-dev.yaml` carries working development secrets.** This is deliberate, so a k3d stack
  starts without a setup step. It is **not** a supported state for any deployment another person
  can reach — `npm run setup` writes a values file with every credential regenerated.
- **A working tree holds secrets that `git status` will not show you**, including the Mosquitto CA
  private key. [`docs/handover.md`](docs/handover.md) lists what to purge before transferring one.

## How this stack is secured

The architecture — role model, RLS policies, machine identities, credential issuance and the trust
boundaries between them — is described under **Security model** in the [README](README.md). That
section answers "how does this work"; this document answers "I found a problem, who do I tell".
