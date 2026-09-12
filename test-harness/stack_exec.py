"""
Reach into the stack's own processes from a suite, on either deployment target.

The stack lane has a handful of assertions that cannot be made over the network: a delete spoken
through the credential service's own admin credential, a publish over MQTTS from inside the broker,
a psql as the database owner, a backup file's digest read where the file lives, a service taken
down to prove the caller answers 503. On Compose those are `docker exec`, `docker stop` and
`docker run` against known container names. On Kubernetes they are `kubectl exec` against a
workload and container, a Service whose selector is patched so it has no endpoints, and a pod run
with the release's labels so the collector picks it up.

The suites name a TARGET -- "credential", "broker", "supabase-db", "backup-service" -- and this
module resolves it for the stack in front of it. ACS_STACK selects the target: `compose` (the
default, so an existing invocation is unchanged) or `k8s`. The Compose container names remain
overridable through the same variables the suites always read (CREDENTIAL_CONTAINER and so on);
the Kubernetes side reads KUBE_NAMESPACE and HELM_RELEASE.

Every suite that uses this puts test-harness/ on sys.path first, the way test_backup_service.py
already reaches test_enroll_gateway.py.
"""
import json
import os
import subprocess
import time

STACK = os.getenv("ACS_STACK", "compose")
NAMESPACE = os.getenv("KUBE_NAMESPACE", "acs-cymru")
RELEASE = os.getenv("HELM_RELEASE", "acs-cymru")
# The Loki `service` label and the chart's pod selector both come from this trio.
RELEASE_LABELS = {
    "app.kubernetes.io/name": "acs-cymru",
    "app.kubernetes.io/instance": RELEASE,
}
# Added to a Service's selector to take it off the network without touching the pod: no pod
# carries it, so the Service has no endpoints and every caller gets connection refused, which is
# what a stopped container gives on Compose.
STOP_LABEL = "acs-cymru.io/stopped"

if STACK not in ("compose", "k8s"):
    raise RuntimeError(f"ACS_STACK={STACK!r}: expected 'compose' or 'k8s'")

TARGETS = {
    "credential": {
        "container": os.getenv("CREDENTIAL_CONTAINER", "acs-cymru_gateway_credential"),
        "workload": "deploy/mosquitto",
        "k8s_container": "gateway-credential",
        "service": f"{RELEASE}-gateway-credential",
    },
    "broker": {
        "container": os.getenv("MOSQUITTO_CONTAINER", "acs-cymru_mosquitto"),
        "workload": "deploy/mosquitto",
        "k8s_container": "mosquitto",
        "service": "mosquitto",
    },
    "supabase-db": {
        "container": os.getenv("DB_CONTAINER", "acs-cymru_supabase_db"),
        "workload": "statefulset/supabase-db",
        "k8s_container": "supabase-db",
        "service": "supabase-db",
    },
    "backup-service": {
        "container": os.getenv("BACKUP_CONTAINER", "acs-cymru_backup_service"),
        "workload": "deploy/backup-service",
        "k8s_container": "backup-service",
        "service": None,
    },
}


def _kubectl(*args, **kwargs):
    return subprocess.run(["kubectl", "-n", NAMESPACE, *args], capture_output=True, text=True, **kwargs)


def describe(target):
    """The name a failure message should use for the process behind a target."""
    t = TARGETS[target]
    if STACK == "compose":
        return t["container"]
    return f"{t['workload']} (container {t['k8s_container']}, namespace {NAMESPACE})"


def broker_host():
    """
    The name the broker's certificate answers to from inside its own container. The Compose
    certificate carries `localhost`; the chart's carries the Service name and not the loopback.
    """
    return "localhost" if STACK == "compose" else "mosquitto"


def run(target, *args, env=None, input=None, check=False):
    """
    Run a command inside the target's container and return the CompletedProcess. `env` is a
    mapping applied to that command only; `input` is fed to its stdin.
    """
    t = TARGETS[target]
    if STACK == "compose":
        env_args = [item for k, v in (env or {}).items() for item in ("-e", f"{k}={v}")]
        stdin_args = ["-i"] if input is not None else []
        cmd = ["docker", "exec", *stdin_args, *env_args, t["container"], *args]
    else:
        stdin_args = ["-i"] if input is not None else []
        env_prefix = ["env", *[f"{k}={v}" for k, v in (env or {}).items()]] if env else []
        cmd = ["kubectl", "-n", NAMESPACE, "exec", *stdin_args, t["workload"],
               "-c", t["k8s_container"], "--", *env_prefix, *args]
    result = subprocess.run(cmd, capture_output=True, text=True, input=input)
    if check and result.returncode != 0:
        raise RuntimeError(f"{' '.join(args)} failed in {describe(target)}: {result.stderr.strip()}")
    return result


def output(target, *args, env=None, input=None):
    """`run`, raising on a non-zero exit, returning stdout."""
    return run(target, *args, env=env, input=input, check=True).stdout


def running(target):
    """Whether the target is up and reachable by the rest of the stack."""
    t = TARGETS[target]
    if STACK == "compose":
        r = subprocess.run(["docker", "inspect", "-f", "{{.State.Running}}", t["container"]],
                           capture_output=True, text=True)
        return r.stdout.strip() == "true"
    ready = _kubectl("get", t["workload"], "-o", "jsonpath={.status.readyReplicas}").stdout.strip()
    if ready in ("", "0"):
        return False
    if t["service"]:
        # A stopped sidecar is one whose Service has been taken off the network.
        selector = _kubectl("get", "svc", t["service"], "-o", "jsonpath={.spec.selector}").stdout
        if STOP_LABEL in selector:
            return False
    return True


def stop(target):
    """
    Take the target off the network. On Compose the container is stopped. On Kubernetes a
    workload of its own is scaled to zero; a sidecar cannot be stopped alone, so its Service is
    given a selector no pod matches, which is the same outcome for every caller.
    """
    t = TARGETS[target]
    if STACK == "compose":
        subprocess.run(["docker", "stop", t["container"]], capture_output=True, text=True)
        return
    if target == "credential":
        _kubectl("patch", "svc", t["service"], "--type=merge",
                 "-p", json.dumps({"spec": {"selector": {STOP_LABEL: "by-a-test"}}}))
        # An empty Service stops NEW connections; a caller holding a keep-alive connection to the
        # pod would still be answered. The process is told to exit (it handles SIGTERM), which
        # closes every connection; the kubelet restarts the container, behind a Service that
        # still points nowhere until `start`.
        run(target, "sh", "-c", "kill -TERM $(pidof node)")
        return
    if target == "backup-service":
        _kubectl("scale", t["workload"], "--replicas=0")
        for _ in range(60):
            if _kubectl("get", t["workload"], "-o", "jsonpath={.status.replicas}").stdout.strip() in ("", "0"):
                return
            time.sleep(1)
        return
    raise NotImplementedError(f"stop() is not defined for {target} on Kubernetes")


def start(target):
    """Undo `stop`, and return once the target is up again."""
    t = TARGETS[target]
    if STACK == "compose":
        subprocess.run(["docker", "start", t["container"]], capture_output=True, text=True)
        return
    if target == "credential":
        _kubectl("patch", "svc", t["service"], "--type=json",
                 "-p", json.dumps([{"op": "remove", "path": "/spec/selector/" + STOP_LABEL.replace("/", "~1")}]))
        # The kubelet restarts the container with a back-off that doubles on every exit and only
        # resets after ten minutes up, so the third stop in a session waits forty seconds. Wait for
        # the container to be ready, then for the Service to list the pod again.
        pod_ready = ("get", "pod", "-l", "app.kubernetes.io/component=mosquitto", "-o",
                     "jsonpath={.items[0].status.containerStatuses[?(@.name=='gateway-credential')].ready}")
        for _ in range(300):
            if _kubectl(*pod_ready).stdout.strip() == "true":
                break
            time.sleep(1)
        for _ in range(60):
            if _kubectl("get", "endpoints", t["service"], "-o", "jsonpath={.subsets[*].addresses[*].ip}").stdout.strip():
                return
            time.sleep(1)
        return
    if target == "backup-service":
        _kubectl("scale", t["workload"], "--replicas=1")
        _kubectl("rollout", "status", t["workload"], "--timeout=120s")
        return
    raise NotImplementedError(f"start() is not defined for {target} on Kubernetes")


def wait_until(target, *probe, attempts=30, interval=1.0):
    """Poll a command inside the target until it exits 0. Returns whether it did."""
    for _ in range(attempts):
        if run(target, *probe).returncode == 0:
            return True
        time.sleep(interval)
    return False


def published_ports(target):
    """
    What the host can reach the target on directly. Empty is the answer the exposure tests want:
    on Compose no `ports:` mapping, on Kubernetes a ClusterIP Service and nothing else.
    """
    t = TARGETS[target]
    if STACK == "compose":
        return subprocess.run(["docker", "port", t["container"]], capture_output=True, text=True).stdout.strip()
    if not t["service"]:
        return ""
    svc = json.loads(_kubectl("get", "svc", t["service"], "-o", "json").stdout or "{}")
    spec = svc.get("spec", {})
    if spec.get("type", "ClusterIP") == "ClusterIP":
        return ""
    return f"{spec.get('type')}: " + ", ".join(
        str(p.get("nodePort") or p.get("port")) for p in spec.get("ports", []))


def default_probe_image():
    """
    The ingestion daemon's own image, for a probe that must run its formatter. On Compose it is
    the image `docker compose build` produced; on Kubernetes it is whatever the deployment runs.
    """
    if STACK == "compose":
        return "acs-cymru-ingestion"
    return _kubectl("get", "deploy/ingestion",
                    "-o", "jsonpath={.spec.template.spec.containers[?(@.name=='ingestion')].image}").stdout.strip()


def probe_image_available(image):
    if STACK == "compose":
        return subprocess.run(["docker", "image", "inspect", image],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    # Present in the node's containerd, which the deployment above proves.
    return bool(image)


def run_probe(name, image, script, component="ingestion", env=None):
    """
    Start a throwaway container the collector will attribute to `component`, running `script`
    under sh. Returns the CompletedProcess of the start; `remove_probe` cleans up.
    """
    env = env or {}
    remove_probe(name)
    if STACK == "compose":
        env_args = [item for k, v in env.items() for item in ("-e", f"{k}={v}")]
        return subprocess.run(
            ["docker", "run", "-d", "--name", name,
             "--label", "com.docker.compose.project=acs-cymru",
             # discovery.relabel maps this label to `service`, which the stage.match selector reads.
             "--label", f"com.docker.compose.service={component}",
             *env_args, "--entrypoint", "sh", image, "-c", script],
            capture_output=True, text=True)
    labels = {**RELEASE_LABELS, "app.kubernetes.io/component": component}
    env_args = [f"--env={k}={v}" for k, v in env.items()]
    return _kubectl(
        "run", _pod_name(name), f"--image={image}", "--restart=Never", "--image-pull-policy=IfNotPresent",
        "--labels=" + ",".join(f"{k}={v}" for k, v in labels.items()),
        *env_args, "--command", "--", "sh", "-c", script)


def remove_probe(name):
    if STACK == "compose":
        subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        _kubectl("delete", "pod", _pod_name(name), "--ignore-not-found", "--now")


def _pod_name(name):
    """A container name is free-form; a pod name is an RFC 1123 label."""
    return name.replace("_", "-").lower()
