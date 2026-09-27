# An example custom gateway repository

A gateway whose machinery no standard Node-RED node reaches needs code of its own on the
appliance. This is what that repository looks like. Copy it with the forge's **Use this template**
button, or clone another gateway's repository: the repository *is* the record, and no column
anywhere says which a gateway was seeded from.

```
custom.yml                 the playbook the appliance runs after the platform's
custom/docker-compose.yml  the adapter's own compose project, on the appliance's network
custom/Dockerfile          the base image pinned by digest, resolving on amd64 and arm64
custom/adapter.py          replace read_machine(); keep the rest
```

**There is deliberately no `flows.json` and no `platform.yml` here.** A flow committed from a
template would be deployed over the one enrolment installed, taking the gateway's heartbeat with
it. A `platform.yml` would be kept by enrolment rather than replaced, so a gateway seeded from
this would converge to whatever tag this file was written against. Both arrive on their own:
enrolment seeds the pointer, and the flow is exported from the appliance's own editor.

## The conditions this lane is admitted on

**A container built from a commit, never a payload handed to the appliance.** The image is built
on the appliance from the tagged checkout of the gateway's own repository. That costs no registry,
no new credential and no fourth thing to revoke: the deploy key is all the appliance holds, and a
registry could not have accepted it. Pin the base image by digest, as `custom/Dockerfile` does.

**The adapter holds no credential.** It publishes locally — HTTP here, a local topic would do —
and Node-RED republishes on the one Sparkplug connection the appliance holds. Per-gateway
confinement therefore still means what it says, and schema conformance and quarantine still apply
to everything it produces. A workload that needs its own identity is a second gateway and should
enrol as one.

**It is reviewed like a flow.** `main` is protected; a change is a pull request an administrator
approves. The appliance converges hourly, so a merged change is running within the hour.

**It cannot take the platform with it.** The platform playbook runs first and this one second.
A failure here is recorded separately and never reads as the platform failing to converge — but it
does fail the convergence, so the appliance's own journal and the gateway's `appliance` branch
both show it.

## What the platform hands the playbook

After this gateway's `platform.yml` variables, and therefore winning over them:

| Variable | What it is |
| :--- | :--- |
| `aber_repo_dir` | this checkout on the appliance |
| `aber_compose_dir` | the platform's own compose project |
| `aber_data_dir` | the appliance's `/data`, as the containers see it |
| `aber_state_dir` | everything the platform put on the box |
| `aber_platform_tag` | the platform tag this appliance converged to |

`custom.yml` states no path of its own, which is what lets the platform move one.

## The Node-RED side

The adapter posts to `http://node-red:1880/custom/readings`. Nothing listens there until the
gateway's flow does. In the appliance's editor, add **http in** (`POST /custom/readings`) → a
**function** that shapes the body into a Sparkplug DDATA payload → the existing **mqtt out** node,
then export `flows.json` and propose it as a pull request the same way as any other flow change.

The first DDATA for a device the platform has never heard of puts it in the dashboard's
**quarantine queue**, where an operator approves it and chooses its name and cell. Nothing is
pre-registered, and the adapter calls no REST API to create anything.

## Trying it without a machine

`read_machine()` returns a plausible reading, so the adapter runs anywhere. On an enrolled
appliance:

```bash
cd /var/lib/aber-gateway/data/gitops/repo/custom
ABER_APPLIANCE_NETWORK=aber-gateway_default docker compose up -d --build
docker compose logs -f adapter
```

`sudo aber-gateway-converge` does the same through the platform, which is what the timer runs.
