# Installing Aber

This guide covers what to install where, the two ways to run the server, and what you will see
the first time you sign in. Every option, and the reason for each step, is in the
[runbook](../deploy/k8s/README.md).

## Deployment

An Aber site has two parts, and they are installed differently: **the server needs Kubernetes, and
each gateway needs Docker.**

### The server: Kubernetes

The server is the platform itself: the dashboard, the databases, the broker, ingestion, Node-RED,
Grafana and the forge. It runs on **k3s**, from the Helm chart in
[`deploy/helm/aber`](../deploy/helm/aber); for development the same chart runs on k3d, which is k3s
inside Docker. *Quick start* below covers both. The runbook is
[`deploy/k8s/README.md`](../deploy/k8s/README.md) and the design record is
[`docs/kubernetes-architecture.md`](kubernetes-architecture.md). The server's images are built
for `linux/amd64` only, so it cannot run on a Raspberry Pi.

### Gateways: Docker

A gateway connects a machine's devices to the server. It runs Node-RED under Docker Compose on its
own hardware (a Raspberry Pi, an industrial PC or a spare server) and publishes Sparkplug B to the
server's broker over MQTTS on 8883. It needs no Kubernetes. Create each one in the dashboard
(**Gateways → New Gateway**, **Type** *Remote*), which offers two ways to install it:

- **A command to paste** on a fresh Ubuntu machine, amd64 or arm64. It installs Docker itself, then
  enrols. It is offered only when the server's API has TLS.
- **A bundle**: a folder to copy to any machine that already has Docker and the Compose plugin,
  where `docker compose up -d --build` starts it.

Either way the gateway needs a route to the server's API, to its broker on 8883 and to the forge's
SSH on 22, where it pulls its flow and its platform playbook. Its image is
built on the gateway itself, which is how an arm64 Pi runs it. The runbook is
[`docs/remote-gateways.md`](remote-gateways.md), and the bundle's contents are in
[`forge/gateway-platform/appliance/`](../forge/gateway-platform/appliance). *Host* and *Simulated*
gateways run inside the server and need nothing installed.

---

## Quick start

There are two routes to a running server, for two different jobs. Both install the same Helm chart
onto k3s, and gateways are added afterwards from the dashboard (*Gateways: Docker* above;
[`tutorial/README.md`](../tutorial/README.md) walks through the first one).

| You want to | Route | Images you build |
| :--- | :--- | :--- |
| **Run Aber** on a site | the published chart from GHCR, onto a k3s node | none |
| **Change Aber** on a laptop | `npm run dev:up` from a checkout, onto a k3d cluster | all eleven |

**`npm run dev:up` is the k3d route, not an alternative to it.** k3d runs k3s inside Docker, and the
script creates the k3d cluster `aber`, builds every image from your checkout, imports them and
installs the chart with `values-dev.yaml`, whose credentials and four demo accounts are committed to
git, so never use this route for a stack anyone else can reach.

> **One node with 4 vCPU, 8 GiB and 100 GiB of disk is the measured minimum**; 8 vCPU and 16 GiB is
> comfortable. Under it the stack does not run slowly, it fails to schedule — the chart reserves
> 1.6 vCPU and 3.7 GiB, and pods below that sit `Pending`. Sizing and what grows:
> [`deploy/k8s/README.md`](../deploy/k8s/README.md), *Prerequisites → Hardware*.

The full runbook is [`deploy/k8s/README.md`](../deploy/k8s/README.md).

### Run it on a site

#### Prepare the machine

The server is one Linux machine on amd64, sized as above, with a fixed address on the site network.
These commands assume Ubuntu 22.04 or 24.04 and a user with `sudo`.

**Move the machine's own SSH off port 22 first.** Gateways reach the forge over SSH on 22, and
k3s's ServiceLB gives the forge that port on the machine's address: once Aber is installed, a new
SSH connection to port 22 reaches the forge, not the machine. Connections already open survive.

```bash
echo 'Port 2222' | sudo tee /etc/ssh/sshd_config.d/port.conf
if systemctl is-active --quiet ssh.socket; then      # 24.04 starts sshd from a socket
  sudo systemctl daemon-reload && sudo systemctl restart ssh.socket
else
  sudo systemctl restart ssh
fi
# Check `ssh -p 2222` from another terminal before closing this one.
```

Then k3s, which brings `kubectl` with it, Helm, and Node.js, which runs only `npm run setup` and
needs no `npm install`:

```bash
curl -sfL https://get.k3s.io | sh -

# k3s's kubeconfig is root's alone, and its kubectl reads a copy only when KUBECONFIG names it.
mkdir -p ~/.kube
sudo k3s kubectl config view --raw > ~/.kube/config
chmod 600 ~/.kube/config
echo 'export KUBECONFIG=~/.kube/config' >> ~/.bashrc && export KUBECONFIG=~/.kube/config
kubectl get nodes        # one node, Ready

curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

Outside the machine:

- **DNS.** A wildcard record on the site's DNS server, `*.<domain>` to the machine's address. Every
  interface is a host under it (*Where everything is*, below), and every browser and gateway on the
  site has to resolve it.
- **Ports**, reachable from the site network: 80 and 443 for browsers and the API, 8883 for
  gateways' MQTTS, and 22 for gateways' git over SSH to the forge.

#### Install Aber

Run the rest on the machine, as your own user rather than root. The
clone is only for the setup script and two cluster manifests; the chart and Aber's own images are
pulled from GHCR at 1.0.1.

```bash
git clone --branch v1.0.1 https://github.com/Harri-Llewelyn/Aber.git && cd Aber

# Once per cluster: Traefik keeps each client's address, and cert-manager runs the internal CA
# that issues every certificate (deploy/k8s/README.md, "Install" and "TLS").
kubectl apply -f deploy/k8s/traefik-config.yaml
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml
kubectl -n cert-manager wait --for=condition=Available deployment --all --timeout=300s
kubectl apply -f deploy/k8s/internal-ca.yaml
kubectl -n cert-manager wait --for=condition=Ready certificate/aber-ca --timeout=120s

# Credentials minted for this site, and its first administrator's password, written to
# deploy/helm/aber/values-local.yaml (gitignored). The password is also printed.
npm run setup -- --domain=aber.plant.example --admin-email=you@plant.example

# What only the site can say.
cat > site.yaml <<'EOF'
global:
  scheme: https
ingestion:
  primaryHostId: plant1          # both fixed for the life of the site; neither has a default
  sparkplugGroup: plant1
supabaseFunctions:
  aas:
    baseIri: https://plant.example/ids/asset/   # permanent once a shell is exported
ingress:
  tls:
    enabled: true
    certManager:
      clusterIssuer: aber-ca
mosquitto:
  tls:
    enabled: true
    clusterIssuer: aber-ca
    extraIpSans: [10.20.0.50]    # the node's address, which gateways dial
EOF

helm install aber oci://ghcr.io/harri-llewelyn/aber/aber --version 1.0.1 \
  -n aber --create-namespace \
  -f deploy/helm/aber/values-local.yaml -f site.yaml --timeout 15m

# NOT `--wait`: it deadlocks the first install (deploy/k8s/README.md says why).
for w in $(kubectl -n aber get statefulset,deploy -o name); do
  kubectl -n aber rollout status "$w" --timeout=10m
done
helm test aber -n aber
```

Before anyone signs in, install the root certificate in every browser and gateway that will use the
stack (runbook, *TLS → 3*). Then sign in at `https://app.<domain>` with the email you gave
`npm run setup` and the password it printed. db-init creates that account once, as an
`Administrator`; after that it is the site's, and no install or upgrade changes it. To keep the
credentials in a secret store rather than a values file, start from `values-prod.yaml.example` and
set `secrets.existingSecret`.

**The chart validates its own values and fails the render, not the pod**, and the message names the
fix. A missing ingestion id, the forge's route on plain HTTP, broker TLS with no address for
gateways to verify, a partial credential set, a wrong-length Realtime key or an HPA on a
single-writer workload would each otherwise produce a stack that reports healthy and refuses every
request.

### Develop on a laptop

Needs Docker, k3d, `kubectl`, Helm 3 and Node.js. From a checkout:

```bash
npm run dev:up        # cluster if absent, images built and imported, chart installed, helm test
npm run dev:test      # validate.py and the stack lane, against that cluster
npm run dev:forward   # the in-cluster ports on localhost, held until Ctrl+C
npm run dev:reset     # uninstall, drop every volume claim, reinstall: a blank stack
npm run dev:down      # delete the cluster
```

`dev:reset` is the only way back to an empty audit trail, because `audit_trail` is append-only to
every application role. Each step `dev:up` takes is in the runbook, under *Local cluster with k3d*
and *The development loop*.

### Where everything is

On a site every host is under the domain given to `npm run setup`. With `dev:up` it is `localhost`,
which browsers resolve to this machine without a hosts file.

| Interface | Site | Laptop |
| :--- | :--- | :--- |
| Dashboard | `https://app.<domain>` | http://app.localhost |
| API | `https://api.<domain>` | http://api.localhost |
| Node-RED | `https://nodered.<domain>` | http://nodered.localhost |
| Grafana | `https://grafana.<domain>` | http://grafana.localhost |
| Forge (Gitea) | `https://git.<domain>` | http://git.localhost |
| API reference (Swagger UI) | `https://docs.<domain>` | http://docs.localhost |
| i3X | `https://i3x.<domain>` | http://i3x.localhost |
| Supabase Studio, `Administrator` only | off by default; runbook, *Reaching the stack* | http://studio.localhost |
| MQTT broker | the node's address: 8883 (TLS), which gateways use, and 1883 | `localhost`: 8883 and 1883 |
| Prometheus | `kubectl -n aber port-forward svc/prometheus 9090` | `npm run dev:forward`, then http://localhost:9090 |

**Sign in to the React dashboard first.** Node-RED and Grafana both federate to Supabase Auth, and
the consent step needs your dashboard session — going straight to either shows a "sign in required"
prompt rather than a login form. In Node-RED, click **Sign in with Aber**; Administrator can
deploy, every other role gets a read-only editor (`nodered-userinfo` maps Administrator to full
permissions and every other role to `read`). An appliance deploys the flow on the `main` branch of
its gateway repository in the forge, where pushes are disabled and a merge needs one approval from
the `administrators` team, which `forge-membership` fills from each person's Postgres role.

**Demo accounts, on a laptop only** — seeded by [`supabase/seed.sql`](../supabase/seed.sql) while
`supabaseAuth.demoAccounts` is on, which `values-dev.yaml` alone sets, password `aber123`:

| Email | Role | Access |
| :--- | :--- | :--- |
| `admin@aber.local` | `Administrator` | Full CRUD |
| `manager@aber.local` | `Shopfloor_Manager` | Full CRUD |
| `operator@aber.local` | `Operator` | Read-only + telemetry |
| `auditor@aber.local` | `Auditor` | Audit Trail read-only |

**Further people** are added outside the dashboard for now
([#705](https://github.com/Harri-Llewelyn/Aber/issues/705)): sign-up is closed
(`supabaseAuth.disableSignup`), so an account is created with GoTrue's admin API or in Studio, and
its role is a row in `public.user_roles`. Where sign-up is opened, a self-registered account gets
read-only `Operator` from the `handle_new_user` trigger, and an `Administrator` must promote it.

**Forgotten passwords** are reset from the sign-in card (*Forgot your password?*), which asks
GoTrue to email a link to `/reset-password`. The link is sent over SMTP, so set
`supabaseAuth.smtp` and `secrets.smtpPassword` in values. With no relay configured the request
fails and the card tells the user to ask an administrator, who can set a password through the Auth
API or Studio instead.

---

## Expected behaviour (not defects)

- **`npm run dev:reset`, or deleting the release's volumes, invalidates every logged-in browser.** It drops the database, and
  with it `auth.sessions`. The dashboard clears the stale tokens and returns to the login screen.
- **Swagger UI's "Example Value" is documentation, not data.** Press **Execute** and read the
  **Response body** panel.
- **A fresh install has no cells, no devices and no schemas, one gateway (the seeded Playback
  gateway, which publishes recorded captures), and Node-RED opens on an empty editor.**
  It used to come up with a four-cell simulated shopfloor seeded by `0002` and a Node-RED publishing
  under four gateway identities, which meant every install began with assets
  nobody had asked for and an Audit Trail already describing them. All of it is gone rather than
  opt-in: the demonstration floor, the simulator flow, the provisioning script and the seeded
  schemas. [`tutorial/README.md`](../tutorial/README.md) walks through building one machine by hand
  instead, which is the same knowledge without the plant. Archived `0040` and `0073` retired the
  assets and the schemas from databases that already had them.
- **Node-RED's editor is empty, and that is the seeded state rather than a failed mount.** It
  declares no broker nodes, so nothing connects and nothing publishes; `node-red-init` writes a
  marker into `/data` recording that it seeded a blank flow, which is what tells the two cases
  apart. Before this, a default stack ran a simulator against gateways that did not exist and
  ingestion discarded every message as an *"unregistered edge node"* — correct behaviour, and an
  odd thing to be doing before anyone had asked for it.
- **An unrecognised device appears in the quarantine queue, not on the shopfloor map.** That is the
  zero-touch onboarding path working: a device that announces itself under an id nobody registered
  is held and its telemetry dropped until an `Administrator` approves it. With no seeded assets
  this is now the **first** thing a new user meets rather than a footnote — publish under any
  well-formed `dev`-prefixed id and it is waiting for you. A device you register in the dashboard
  first is bound to its gateway and bypasses the queue, which is the other half of the same path
  and the one the tutorial walks through.
