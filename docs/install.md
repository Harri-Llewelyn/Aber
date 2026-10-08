# Installing Aber

Aber has two parts. **The server** runs on one Linux machine on your network, under Kubernetes.
**Gateways** connect your machines to it, and you add them from the dashboard once the server is
running. This guide installs the server, signs you in, and points you at your first gateway.

Every option, and the reason for each step, is in the [runbook](../deploy/k8s/README.md). The server
is installed from the Helm chart in [`deploy/helm/aber`](../deploy/helm/aber), and why it is built that
way is in [`kubernetes-architecture.md`](kubernetes-architecture.md). Words you may not know are in
the [glossary](glossary.md).

## Choose a route

| You want to | Route | What it builds |
| :--- | :--- | :--- |
| **Look at Aber** on your own computer | [*Try it*](#try-it): `npm run try`, the published release on [k3d](glossary.md#k3d) at `localhost` | nothing: the images are downloaded |
| **Run Aber** for real, on a site | [*Run it on a site*](#run-it-on-a-site): the published release, installed on a [k3s](glossary.md#k3s) machine | nothing: the images are downloaded |
| **Work on Aber's code** on a laptop | [*Develop on a laptop*](#develop-on-a-laptop): `npm run dev:up`, on [k3d](glossary.md#k3d) | all eleven images, from your checkout |

**Never use the laptop route for a server other people can reach.** It installs `values-dev.yaml`,
whose passwords and four demo accounts are published in git.

**The machine needs at least 4 CPU cores, 8 GiB of memory and 100 GiB of disk.** 8 cores and 16 GiB
is comfortable. On a smaller machine Aber does not just run slowly: parts of it never start, because
the chart reserves 1.6 CPU cores and 3.7 GiB, and anything that does not fit waits as `Pending`.
The server's images are built for `linux/amd64` only, so it cannot run on a Raspberry Pi. Sizing,
and what grows over time, are in the runbook, *Prerequisites → Hardware*.

---

## Try it

Look at Aber on one computer before you set up a site. A trial runs the published release at
`localhost`, so you need no DNS record, no certificate and no build.

**You need** an amd64 computer, because Aber's images are not built for ARM. Docker must be running,
with at least 4 CPU cores and 8 GiB of memory for Aber. You also need [k3d](glossary.md#k3d),
`kubectl`, Helm, Node.js and git. The command checks for each one first, and says where to get any
that is missing.

```bash
git clone https://github.com/Harri-Llewelyn/Aber.git && cd Aber
npm run try
```

`npm run try` creates a k3d cluster called `aber-try` and creates the trial's passwords with
`npm run setup`. Then it installs the release from GHCR and waits for every part of Aber to start.
The first run downloads every image, which takes several minutes. It ends by printing the address,
an administrator's email and its password.

Open http://app.localhost and sign in with them. To see data, add a Simulated gateway:
**Gateways → New Gateway**. It runs inside Aber, so there is nothing to install. The
[tutorial](../tutorial/README.md) builds a gateway the same way.

**If a port is taken, the command stops and names what holds it.** A trial needs ports 80, 1883 and
8883. A developer's `aber` cluster (*Develop on a laptop*) uses the same ports: stop it first with
`k3d cluster stop aber`.

**A trial is for this computer only.** Remote gateways cannot enrol, because nothing else on the
network can reach `localhost`. Running `npm run try` again upgrades the same trial.

To remove it:

```bash
npm run try:down
```

That deletes the cluster and everything in it. The passwords stay in
`deploy/helm/aber/values-try.yaml`, so the next `npm run try` reuses them. Delete that file to get
new ones.

---

## Run it on a site

**You need** one Linux machine on amd64, sized as above, with a fixed address on the site network.
These commands assume Ubuntu 22.04 or 24.04 and a user with `sudo`. You also need a domain for the
site, such as `aber.plant.example`, on your site's DNS server.

### 1. Move the machine's SSH off port 22

**Skip this step if you create the site's passwords with `npm run setup` (step 5).** Setup puts
the [forge](glossary.md#forge)'s SSH on port 2222, so port 22 stays with the machine's own SSH.
Gateways use 2222 to fetch their flows from the forge.

**If the machine's own SSH is already on 2222, move it back to 22 before you install.** k3s would
give 2222 to the forge, and new SSH connections to the machine would reach the forge instead.

Do this step only if you configure the site another way, from `values-prod.yaml.example` or an
external Secret, and keep the forge on port 22. k3s gives the forge that port on the machine's
address. So once Aber is installed, a new SSH connection to port 22 reaches the forge, not the
machine. Move the machine's own SSH first, to a port the forge does not use. Connections already
open stay up.

```bash
echo 'Port 2022' | sudo tee /etc/ssh/sshd_config.d/port.conf
if systemctl is-active --quiet ssh.socket; then      # 24.04 starts sshd from a socket
  sudo systemctl daemon-reload && sudo systemctl restart ssh.socket
else
  sudo systemctl restart ssh
fi
# Check `ssh -p 2022` from another terminal before closing this one.
```

### 2. Install k3s, Helm and Node.js

k3s brings `kubectl` with it. Node.js runs only `npm run setup` (step 5), which needs no
`npm install`.

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

### 3. Set up DNS and open the ports

Both are done outside the machine:

- **DNS.** Add a wildcard record on the site's DNS server, `*.<domain>`, pointing at the machine's
  address. Every part of Aber is a host under it (see [*Where everything is*](#where-everything-is)),
  and every browser and gateway on the site has to be able to look it up.
- **Ports.** Make these reachable from the site network: 80 and 443 for browsers and the API, 8883
  for gateways' MQTT over TLS, and 2222 for gateways' git over SSH to the forge. If you kept the
  forge on port 22 (step 1), open 22 instead.

### 4. Prepare the cluster

Run the rest on the machine, as your own user rather than root. The clone holds only the setup
script and two cluster files; the chart and Aber's images are downloaded from GHCR at 1.0.2.

These steps are needed once per cluster. Traefik is told to keep each client's address, and
cert-manager runs the [internal CA](glossary.md#internal-ca-and-root-certificate) that issues every
certificate (runbook, *Install* and *TLS*).

```bash
git clone --branch v1.0.2 https://github.com/Harri-Llewelyn/Aber.git && cd Aber

kubectl apply -f deploy/k8s/traefik-config.yaml
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml
kubectl -n cert-manager wait --for=condition=Available deployment --all --timeout=300s
kubectl apply -f deploy/k8s/internal-ca.yaml
kubectl -n cert-manager wait --for=condition=Ready certificate/aber-ca --timeout=120s
```

### 5. Create the site's passwords

`npm run setup` creates every password and key the site needs, and the first administrator's
account. It writes them to `deploy/helm/aber/values-local.yaml`, which git ignores, and prints the
administrator's password. Keep both safe.

```bash
npm run setup -- --domain=aber.plant.example --admin-email=you@plant.example
```

To keep these in a secret store rather than a file, start from `values-prod.yaml.example` and set
`secrets.existingSecret` instead.

### 6. Describe your site

A few settings only you can choose. Write them to `site.yaml`, changing the values to your own:

```bash
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
```

| Setting | What to put |
| :--- | :--- |
| `primaryHostId`, `sparkplugGroup` | A short name for the site. Every gateway's settings carry it, so it can never change |
| `baseIri` | A web address under a domain your organisation controls. Every exported [asset shell](glossary.md#asset-administration-shell-aas) is identified by it, so it cannot change once one has been exported |
| `extraIpSans` | The machine's address. Gateways connect to the broker at it, and the broker's certificate has to name it |
| The rest | Leave as written: they turn on HTTPS and the broker's TLS, using the internal CA from step 4 |

### 7. Install Aber

```bash
helm install aber oci://ghcr.io/harri-llewelyn/aber/aber --version 1.0.2 \
  -n aber --create-namespace \
  -f deploy/helm/aber/values-local.yaml -f site.yaml --timeout 15m

# NOT `--wait`: it deadlocks the first install (deploy/k8s/README.md says why).
for w in $(kubectl -n aber get statefulset,deploy -o name); do
  kubectl -n aber rollout status "$w" --timeout=10m
done
helm test aber -n aber
```

The loop waits for every part of Aber to start, and `helm test` checks the result.

**If a setting is missing or wrong, the install stops before anything starts, and the error says what
to fix.** It catches, for example, a missing site name, the forge offered over plain HTTP, broker TLS
with no address for gateways to check, an incomplete set of passwords, a Realtime key of the wrong
length, or autoscaling on a part of Aber that must run once. Without that check, Aber would come up
looking healthy and refuse every request.

### 8. Install the root certificate

Aber's certificates come from its own internal CA, so browsers and gateways trust them only once they
trust that CA's root certificate. Save it to a file:

```bash
kubectl -n cert-manager get secret aber-ca-key-pair \
  -o jsonpath='{.data.tls\.crt}' | base64 -d > aber-ca.crt
```

Install `aber-ca.crt` in the trust store of every browser, operator laptop and gateway that will
use Aber: by Group Policy on Windows, an MDM profile on macOS, and on Debian or Ubuntu by copying it
to `/usr/local/share/ca-certificates/` and running `update-ca-certificates`. Until you do, every page
shows a certificate warning. Do not get into the habit of clicking past it: it is the warning that
would tell you if someone were intercepting your sign-in (runbook, *TLS → 3*).

### 9. Sign in

Open `https://app.<domain>` and sign in with the email you gave `npm run setup` and the password it
printed. That account is created once, as an `Administrator`. After that it belongs to the site:
no install or upgrade changes it.

Next, build your first machine with the [tutorial](../tutorial/README.md), or
[add a gateway](#add-gateways).

---

## Develop on a laptop

You need Docker, k3d, `kubectl`, Helm 3 and Node.js. From a checkout:

```bash
npm run dev:up        # cluster if absent, images built and imported, chart installed, helm test
npm run dev:test      # validate.py and the stack lane, against that cluster
npm run dev:forward   # the in-cluster ports on localhost, held until Ctrl+C
npm run dev:reset     # uninstall, drop every volume claim, reinstall: a blank stack
npm run dev:down      # delete the cluster
```

`npm run dev:up` is the k3d route: k3d runs k3s inside Docker. The script creates a k3d cluster
called `aber`, builds every image from your checkout, loads them into the cluster, and installs the
chart with `values-dev.yaml`. Everything is served at `localhost`, which needs no DNS: browsers send
every `*.localhost` name to your own machine.

`dev:reset` is the only way back to an empty Audit Trail, because nothing in Aber can delete from it.
Each step `dev:up` takes is in the runbook, under *Local cluster with k3d* and *The development
loop*.

---

## Add gateways

A gateway connects a machine's devices to the server. Create each one in the dashboard:
**Gateways → New Gateway**.

- **A Remote gateway** runs on its own computer beside the machines: a Raspberry Pi, an industrial PC
  or a spare server. It runs Node-RED under Docker Compose and needs no Kubernetes. Its drawer offers
  two ways to set it up:
  - **A command to paste** on a fresh Ubuntu machine, amd64 or arm64. It installs Docker itself, then
    enrols. It is offered only when the server's API uses TLS.
  - **A bundle**: a folder to copy to a machine that already has Docker and the Compose plugin, where
    `docker compose up -d --build` starts it.

  Either way, the gateway needs to reach the server's API, its broker on 8883, and the forge's SSH on
  2222 (22 on a site that kept it there), where it fetches its flow and its platform playbook. Its
  image is built on the gateway itself, which is how an arm64 Pi runs it.
  [`docs/remote-gateways.md`](remote-gateways.md) covers it in
  full, and [`forge/gateway-platform/appliance/`](../forge/gateway-platform/appliance) holds what the
  bundle contains.
- **A Host or Simulated gateway** runs inside the server, in Aber's own Node-RED, and needs nothing
  installed. The [tutorial](../tutorial/README.md) builds one.

---

## Where everything is

On a site, every part of Aber is a host under the domain you gave `npm run setup`. On a laptop it is
`localhost`.

| What | On a site | On a laptop |
| :--- | :--- | :--- |
| Dashboard | `https://app.<domain>` | http://app.localhost |
| API | `https://api.<domain>` | http://api.localhost |
| Node-RED | `https://nodered.<domain>` | http://nodered.localhost |
| Grafana | `https://grafana.<domain>` | http://grafana.localhost |
| Forge (Gitea) | `https://git.<domain>` | http://git.localhost |
| API reference (Swagger UI) | `https://docs.<domain>` | http://docs.localhost |
| i3X | `https://i3x.<domain>` | http://i3x.localhost |
| Supabase Studio, `Administrator` only | off by default; runbook, *Reaching the stack* | http://studio.localhost |
| MQTT broker | the machine's address: 8883 (TLS), which gateways use, and 1883 | `localhost`: 8883 and 1883 |
| Prometheus | `kubectl -n aber port-forward svc/prometheus 9090` | `npm run dev:forward`, then http://localhost:9090 |

**Sign in to the dashboard first.** Node-RED and Grafana use your dashboard sign-in, so opening
either one first shows a "sign in required" message instead of a login form. In Node-RED, choose
**Sign in with Aber**. An `Administrator` can deploy flows; every other role gets a read-only editor.

A Remote gateway runs the flow on the `main` branch of its own repository in the forge. Nobody can
push to that branch directly: a change is a pull request, merged with one approval from the
`administrators` team, which follows each person's role in Aber.

---

## Accounts

**The first administrator** comes from `npm run setup` (step 5), and is the only account a new site
has.

**Demo accounts exist on a development laptop only.** `values-dev.yaml` turns them on
(`supabaseAuth.demoAccounts`), and [`supabase/seed.sql`](../supabase/seed.sql) creates them. The
password for each is `aber123`.

| Email | Role | Access |
| :--- | :--- | :--- |
| `admin@aber.local` | `Administrator` | Full CRUD |
| `manager@aber.local` | `Shopfloor_Manager` | Full CRUD |
| `operator@aber.local` | `Operator` | Read-only + telemetry |
| `auditor@aber.local` | `Auditor` | Audit Trail read-only |

**Adding people** is done in the dashboard, by an `Administrator`: open **Access Control**, then
**People**, then **Add Person**. Give the person's email address and a role.

- With an email relay (`supabaseAuth.smtp` and `secrets.smtpPassword`), the person is sent an
  invitation. They choose their own password from its link.
- Without one, the dashboard shows a password once. Give it to the person yourself.

The same tab changes a person's role, and removes or restores their access. Removing access blocks
the person's sign-in and keeps their account, so the Audit Trail still names them. Sign-up stays
closed (`supabaseAuth.disableSignup`). If you open it instead, a new account has no role until an
`Administrator` gives it one on the **People** tab.

**Forgotten passwords** are reset from the sign-in page (*Forgot your password?*), which emails a link
to `/reset-password`. That needs an email relay: set `supabaseAuth.smtp` and `secrets.smtpPassword`.
Without one, the request fails and the page says to ask an administrator, who can set a new password
through the Auth API or in Studio.

---

## What is normal on a new install

- **A new install is empty.** It has no cells, devices, schemas or metrics, one gateway (the
  Playback gateway, which replays recorded data), and an empty Node-RED editor. The
  [tutorial](../tutorial/README.md) builds your first machine.
- **Node-RED's editor is empty because nothing has been built yet, not because something failed to
  load.** It has no broker connection, so nothing connects and nothing is sent. `node-red-init`
  writes a marker into `/data` when it sets up the blank flow, which is how the two cases are told
  apart.
- **A device Aber does not know waits in the quarantine queue, not on the site map.** Its readings
  are dropped until someone approves it, and on a new install that is often the first thing you
  see. Send messages under any well-formed `dev` id and the device is waiting for you. A device you
  create in the dashboard first is tied to its gateway and skips the queue; the tutorial does it
  that way.
- **`npm run dev:reset`, or deleting the release's volumes, signs everyone out.** It drops the
  database, and every session with it. The dashboard clears the old sign-in and returns to the login
  page.
- **Swagger UI's "Example Value" is an example, not data.** Choose **Execute** and read the
  **Response body** panel.
