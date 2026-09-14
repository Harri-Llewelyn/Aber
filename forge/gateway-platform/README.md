# The platform playbook

What every appliance converges to, as an Ansible playbook the appliance pulls and runs on itself.
The platform publishes this directory into the forge as `platform/gateway-platform` (the
`appliance/` files also reach an appliance by the ZIP bundle and the installer), commits it to
`main` whenever the running platform's copy differs, and tags it `v<version>` once per platform
version. **The fleet tracks a tag, and the pointer is per gateway:** `platform.yml` in each
gateway's own repository names the tag that appliance converges to, changed by pull request through
the lane the forge already has. Nothing tracks `main` of this repository.

```
site.yml            the playbook: hosts localhost, four roles, in this order
install.sh          the one-liner's installer, served by the platform to a fresh appliance
roles/base          packages, unattended-upgrades without reboot, chrony
roles/docker        Ubuntu's docker.io and the Compose plugin, held out of unattended upgrades
roles/appliance     the compose project under /opt/acs-gateway, from appliance/ (the bundle template)
roles/converge      the acs-gateway-converge script and its systemd timer
appliance/          the compose project the appliance runs; also what the ZIP bundle ships
platform.yml.example  what a gateway repository's platform.yml looks like
```

## Two playbooks, and the split is the security boundary

This is the **platform** playbook: one repository the whole fleet reads, in its own organisation
so the `gateways` organisation's rules (both teams may create repositories; the sweep protects
whatever it finds) do not apply to it. `main` here admits pushes from the machine account and
nobody else, because its content comes from the platform's own repository, where it is reviewed.

An optional **custom** playbook lives in a gateway's own repository beside its flow, as
`custom.yml` at the root, and runs after this one. Every gateway runs the platform playbook;
"custom" is a gateway whose repository also carries a playbook, not a choice between two. Its
reviewed lane is the one `main` already has: a pull request an administrator approves.

**What it is run with.** From the puller's checkout of the gateway's `main`, so `roles/`, `files/`
and `templates/` beside it resolve; as root; with the `vars` from that gateway's `platform.yml`,
and then the paths the platform owns — `acs_state_dir`, `acs_data_dir`, `acs_compose_dir`,
`acs_repo_dir` and `acs_platform_tag`. The paths are passed last, so a custom playbook can read
where the platform put things and cannot move them.

**What it cannot do to the platform.** It is not attempted when the platform run failed, because
the platform is what puts Docker, the compose project and those directories in place, and a custom
playbook run without them fails for the platform's reason while reporting its own. Its outcome is
recorded separately in `converged.json`, so a gateway's own broken playbook never reads as the
platform failing to converge. Its exit status is the script's: a failure has to reach the timer's
unit status, or the only record is a field in the forge nobody is watching.

## How an appliance gets here

The dashboard shows a command to paste on a fresh Ubuntu machine. It fetches the platform's root
over plain HTTP, checks its public key against the pin minted beside the token, installs it, and
then fetches `install.sh` from the platform over TLS with the token in a header. The installer
puts the packages the playbook needs in place, fetches this playbook (as a zip, from the platform:
the forge refuses anonymous reads and the appliance has no key yet), runs it, writes the
appliance's `.env`, and enrols by starting the compose project. Install first, enrol last: every
step before enrolment can be re-run with the same command, and the token is spent only by the
enrolment. The runbook is in `docs/physical-gateways.md`.

## How an appliance runs it

`acs-gateway-converge` (installed by the `converge` role, run by its timer hourly and at boot):

1. reads `platform.yml` from the appliance's checkout of its own repository's `main`
   (`/var/lib/acs-gateway/data/gitops/repo/platform.yml`), which `flow-sync` keeps current;
2. runs `ansible-pull` against this repository at that tag, over SSH with the appliance's own
   deploy key and the forge's pinned host key, the same identity and the same verification the
   puller uses; the key is read-only here and read-write on the gateway's own repository;
3. runs `custom.yml` from that same checkout, when the repository carries one;
4. records what it did in `/var/lib/acs-gateway/data/gitops/converged.json`, which the puller
   pushes to the gateway's `appliance` branch, so the forge shows which tag each appliance ran
   and what its own playbook did:

```json
{
  "outcome": "converged", "tag": "v0.1.0", "detail": "ansible-pull succeeded",
  "converged_at": "2026-09-14T11:00:07Z",
  "custom": { "outcome": "failed", "revision": "…", "detail": "custom.yml exited 2", "ran_at": "…" }
}
```

`custom` is `null` when the repository carries no playbook of its own, and when the platform run
failed before one could be attempted.

A fleet bump is one pull request per gateway, or a scripted batch; a canary is one gateway. The
checkout step 3 runs from is at the head of the tracked branch whatever the puller decided about
the flow: a flow refused for its shape does not hold the checkout back, because what is on `main`
is what was approved either way.

## What is decided here

- **Ubuntu and Ubuntu Server** are the operating system, amd64 and arm64 alike.
- **`ansible-pull`, not Ansible**: outbound only, no inventory, self-healing on a timer,
  idempotent by construction.
- **`unattended-upgrades` without automatic reboot**, and Docker's packages are held out of it:
  a convergence run does not expect the engine to change under it. They move when the tag does.
- **Docker from Ubuntu's own archive** (`docker.io`, `docker-compose-v2`), not Docker's
  repository: no third-party apt source to trust, and the versions Ubuntu ships are the ones its
  security team patches.
- **`chrony` is the time source**, pointed at what `platform.yml` names (`chrony_servers`) or
  Ubuntu's pool by default. The platform measures each appliance's clock offset and alerts on it;
  this is the fix.
- **The compose volume is a bind mount** under `/var/lib/acs-gateway/data`, so the host's
  converge script can reach the deploy key, the host key and the repository checkout that
  `bootstrap.mjs` wrote inside the container.

## Running it by hand

On an appliance that already holds an enrolment (the bundle's `/data`, or the installer's):

```bash
sudo ansible-pull -U ssh://git@<forge>/platform/gateway-platform.git -C v0.1.0 site.yml
```

Elsewhere, to check the playbook parses (what CI runs):

```bash
docker run --rm -v "$PWD/forge/gateway-platform:/pb:ro" python:3.12-slim \
  sh -c 'pip -q install ansible-core && cd /pb && ansible-playbook --syntax-check site.yml'
```
