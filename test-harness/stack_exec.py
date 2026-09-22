"""
Reach into the stack's own processes from a suite.

The stack lane has a handful of assertions that cannot be made over the network: a delete spoken
through the credential service's own admin credential, a publish over MQTTS from inside the broker,
a psql as the database owner, a backup file's digest read where the file lives, a service taken
down to prove the caller answers 503. Each is a `kubectl exec` against a workload and container, a
Service whose selector is patched so it has no endpoints, or a pod run with the release's labels so
the collector picks it up.

The suites name a TARGET -- "credential", "broker", "supabase-db", "backup-service" -- and this
module resolves it. KUBE_NAMESPACE and HELM_RELEASE select the release (default aber, both).

Every suite that uses this puts test-harness/ on sys.path first, the way test_backup_service.py
already reaches test_enroll_gateway.py.
"""
import json
import os
import subprocess
import time

NAMESPACE = os.getenv("KUBE_NAMESPACE", "aber")
RELEASE = os.getenv("HELM_RELEASE", "aber")
# The Loki `service` label and the chart's pod selector both come from this trio.
RELEASE_LABELS = {
    "app.kubernetes.io/name": "aber",
    "app.kubernetes.io/instance": RELEASE,
}
# Added to a Service's selector to take it off the network without touching the pod: no pod
# carries it, so the Service has no endpoints and every caller gets connection refused.
STOP_LABEL = "aber.io/stopped"

TARGETS = {
    "credential": {"workload": "deploy/mosquitto", "container": "gateway-credential",
                   "service": f"{RELEASE}-gateway-credential"},
    "broker": {"workload": "deploy/mosquitto", "container": "mosquitto", "service": "mosquitto"},
    "supabase-db": {"workload": "statefulset/supabase-db", "container": "supabase-db", "service": "supabase-db"},
    "backup-service": {"workload": "deploy/backup-service", "container": "backup-service", "service": None},
}


def _kubectl(*args, **kwargs):
    return subprocess.run(["kubectl", "-n", NAMESPACE, *args], capture_output=True, text=True, **kwargs)


def describe(target):
    """The name a failure message should use for the process behind a target."""
    t = TARGETS[target]
    return f"{t['workload']} (container {t['container']}, namespace {NAMESPACE})"


def broker_host():
    """The name the broker's certificate answers to from inside its own container."""
    return "mosquitto"


def run(target, *args, env=None, input=None, check=False):
    """
    Run a command inside the target's container and return the CompletedProcess. `env` is a
    mapping applied to that command only; `input` is fed to its stdin.
    """
    t = TARGETS[target]
    stdin_args = ["-i"] if input is not None else []
    env_prefix = ["env", *[f"{k}={v}" for k, v in (env or {}).items()]] if env else []
    cmd = ["kubectl", "-n", NAMESPACE, "exec", *stdin_args, t["workload"],
           "-c", t["container"], "--", *env_prefix, *args]
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
    Take the target off the network. A workload of its own is scaled to zero; a sidecar cannot be
    stopped alone, so its Service is given a selector no pod matches and its process is told to
    exit, which closes the keep-alive connections an empty Service would otherwise leave answered.
    """
    t = TARGETS[target]
    if target == "credential":
        _kubectl("patch", "svc", t["service"], "--type=merge",
                 "-p", json.dumps({"spec": {"selector": {STOP_LABEL: "by-a-test"}}}))
        # The kubelet restarts the container behind a Service that still points nowhere until `start`.
        run(target, "sh", "-c", "kill -TERM $(pidof node)")
        return
    if target == "backup-service":
        _kubectl("scale", t["workload"], "--replicas=0")
        for _ in range(60):
            if _kubectl("get", t["workload"], "-o", "jsonpath={.status.replicas}").stdout.strip() in ("", "0"):
                return
            time.sleep(1)
        return
    raise NotImplementedError(f"stop() is not defined for {target}")


def start(target):
    """Undo `stop`, and return once the target is up again."""
    t = TARGETS[target]
    if target == "credential":
        _kubectl("patch", "svc", t["service"], "--type=json",
                 "-p", json.dumps([{"op": "remove", "path": "/spec/selector/" + STOP_LABEL.replace("/", "~1")}]))
        # The kubelet's restart back-off doubles on every exit and only resets after ten minutes
        # up, so the third stop in a session waits forty seconds. Wait for the container to be
        # ready, then for the Service to list the pod again.
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
    raise NotImplementedError(f"start() is not defined for {target}")


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
    a ClusterIP Service and nothing else.
    """
    t = TARGETS[target]
    if not t["service"]:
        return ""
    svc = json.loads(_kubectl("get", "svc", t["service"], "-o", "json").stdout or "{}")
    spec = svc.get("spec", {})
    if spec.get("type", "ClusterIP") == "ClusterIP":
        return ""
    return f"{spec.get('type')}: " + ", ".join(
        str(p.get("nodePort") or p.get("port")) for p in spec.get("ports", []))


def default_probe_image():
    """The ingestion daemon's own image, for a probe that must run its formatter."""
    return _kubectl("get", "deploy/ingestion",
                    "-o", "jsonpath={.spec.template.spec.containers[?(@.name=='ingestion')].image}").stdout.strip()


def probe_image_available(image):
    # Present in the node's containerd, which the deployment above proves.
    return bool(image)


def run_probe(name, image, script, component="ingestion", env=None):
    """
    Start a throwaway pod the collector will attribute to `component`, running `script` under sh.
    Returns the CompletedProcess of the start; `remove_probe` cleans up.
    """
    env = env or {}
    remove_probe(name)
    labels = {**RELEASE_LABELS, "app.kubernetes.io/component": component}
    env_args = [f"--env={k}={v}" for k, v in env.items()]
    return _kubectl(
        "run", _pod_name(name), f"--image={image}", "--restart=Never", "--image-pull-policy=IfNotPresent",
        "--labels=" + ",".join(f"{k}={v}" for k, v in labels.items()),
        *env_args, "--command", "--", "sh", "-c", script)


def remove_probe(name):
    _kubectl("delete", "pod", _pod_name(name), "--ignore-not-found", "--now")


def _pod_name(name):
    """A pod name is an RFC 1123 label."""
    return name.replace("_", "-").lower()
