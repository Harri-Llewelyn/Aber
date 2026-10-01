"""
GoTrue's sign-in limit is per client, through the path a browser takes, against a running stack.

A probe pod sends wrong-password grants to api.<domain> through Traefik and the gateway until GoTrue
refuses it with 429, then keeps sending five a second so its limit stays spent. While it does, the
host signs in three times through the same Ingress, and each must succeed. The first half fails
when GOTRUE_RATE_LIMIT_HEADER is empty (nothing is limited). The second half fails when Traefik's
Service is on externalTrafficPolicy Cluster: both clients then arrive as the node's pod-network
address and share the limit the probe is holding empty.

The pod sends to the node's address, not Traefik's ClusterIP, because only that path is rewritten
under Cluster; it runs in `default`, outside the release's NetworkPolicy. Its email has no account.
The other suites sign in through the port-forward, where no forwarded header arrives and GoTrue
skips the limit, so the bucket this spends is the pod's alone.

    python supabase/test_auth_rate_limit.py
"""
import http.client
import json
import os
import subprocess
import time
import unittest
import uuid

NAMESPACE = os.getenv("KUBE_NAMESPACE", "aber")
PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
PASSWORD = os.getenv("ABER_SEED_PASSWORD", "aber123")
# Where the host reaches Traefik: k3d publishes the node's :80 on loopback.
INGRESS = os.getenv("INGRESS_TEST_ADDRESS", "127.0.0.1:80")
# GoTrue's Token limiter allows a burst of 30 per client and refills one every two seconds.
BURST_ATTEMPTS = 40
HOLD_SECONDS = 20
HOST_SIGN_INS = 3

PROBE = r"""
import json, os, time, urllib.error, urllib.request
codes, limited = {}, ""
def grant():
    global limited
    req = urllib.request.Request(
        "http://" + os.environ["TARGET"] + "/auth/v1/token?grant_type=password",
        data=json.dumps({"email": os.environ["EMAIL"], "password": "wrong"}).encode(),
        headers={"Host": os.environ["API_HOST"], "apikey": os.environ["KEY"],
                 "Content-Type": "application/json"}, method="POST")
    try:
        status, body = urllib.request.urlopen(req, timeout=10).status, ""
    except urllib.error.HTTPError as e:
        status, body = e.code, e.read().decode()
    codes[status] = codes.get(status, 0) + 1
    if status == 429 and not limited:
        limited = body
for _ in range(int(os.environ["BURST_ATTEMPTS"])):
    grant()
print("HOLDING", flush=True)
end = time.time() + int(os.environ["HOLD_SECONDS"])
while time.time() < end:
    grant()
    time.sleep(0.2)
print(json.dumps({"codes": codes, "limited": limited}), flush=True)
"""


def kubectl(*args, check=True):
    r = subprocess.run(["kubectl", *args], capture_output=True, text=True, timeout=180)
    if check and r.returncode != 0:
        raise AssertionError(f"kubectl {' '.join(args[:4])} failed: {r.stderr.strip()}")
    return r.stdout.strip()


def api_host():
    ingresses = json.loads(kubectl("-n", NAMESPACE, "get", "ingress", "-o", "json"))["items"]
    hosts = [r["host"] for i in ingresses for r in i["spec"].get("rules", []) if r.get("host", "").startswith("api.")]
    if not hosts:
        raise AssertionError(f"no Ingress in {NAMESPACE} routes an api.<domain> host")
    return hosts[0]


def password_grant(host, email, password):
    conn = http.client.HTTPConnection(INGRESS, timeout=15)
    try:
        conn.request("POST", "/auth/v1/token?grant_type=password",
                     body=json.dumps({"email": email, "password": password}),
                     headers={"Host": host, "apikey": PUBLISHABLE_KEY, "Content-Type": "application/json"})
        resp = conn.getresponse()
        return resp.status, resp.read().decode()
    finally:
        conn.close()


def wait_for(pod, predicate, seconds):
    deadline = time.time() + seconds
    while time.time() < deadline:
        state = (kubectl("-n", "default", "get", "pod", pod, "-o", "jsonpath={.status.phase}", check=False),
                 kubectl("-n", "default", "logs", pod, check=False))
        if predicate(*state):
            return state
        time.sleep(1)
    return state


class SignInLimitIsPerClientTestCase(unittest.TestCase):
    def test_a_client_that_exhausts_its_limit_does_not_lock_out_another(self):
        self.assertTrue(PUBLISHABLE_KEY, "SUPABASE_PUBLISHABLE_KEY is not set")
        host = api_host()
        # A node that runs Traefik: under Local, a node without one drops the traffic.
        node = kubectl("-n", "kube-system", "get", "pod", "-l", "app.kubernetes.io/name=traefik",
                       "-o", "jsonpath={.items[0].status.hostIP}")
        image = kubectl("-n", NAMESPACE, "get", "deploy/ingestion",
                        "-o", "jsonpath={.spec.template.spec.containers[?(@.name=='ingestion')].image}")
        pod = f"auth-rate-limit-probe-{uuid.uuid4().hex[:8]}"
        env = {"TARGET": f"{node}:80", "API_HOST": host, "KEY": PUBLISHABLE_KEY,
               "BURST_ATTEMPTS": str(BURST_ATTEMPTS), "HOLD_SECONDS": str(HOLD_SECONDS),
               "EMAIL": f"rate-limit-probe-{uuid.uuid4().hex[:8]}@aber.invalid"}
        try:
            kubectl("-n", "default", "run", pod, f"--image={image}", "--restart=Never",
                    "--image-pull-policy=IfNotPresent", *[f"--env={k}={v}" for k, v in env.items()],
                    "--command", "--", "python", "-c", PROBE)
            phase, logs = wait_for(pod, lambda phase, logs: "HOLDING" in logs or phase in ("Succeeded", "Failed"), 120)
            self.assertIn("HOLDING", logs, f"the probe pod did not reach its hold ({phase}): {logs}")
            host_results = [password_grant(host, "admin@aber.local", PASSWORD) for _ in range(HOST_SIGN_INS)]
            phase, logs = wait_for(pod, lambda phase, _: phase in ("Succeeded", "Failed"), HOLD_SECONDS + 60)
            self.assertEqual(phase, "Succeeded", f"the probe pod ended {phase or 'unfinished'}: {logs}")
        finally:
            kubectl("-n", "default", "delete", "pod", pod, "--ignore-not-found", "--now", check=False)

        result = json.loads(logs.splitlines()[-1])
        codes = {int(k): v for k, v in result["codes"].items()}
        self.assertIn(429, codes,
                      f"one client's wrong-password grants were never refused ({codes}): GoTrue is not "
                      "rate-limiting sign-in. Is GOTRUE_RATE_LIMIT_HEADER set?")
        self.assertIn("over_request_rate_limit", result["limited"])

        refused = [(s, b[:160]) for s, b in host_results if s != 200]
        self.assertEqual(
            refused, [],
            f"{len(refused)} of {HOST_SIGN_INS} sign-ins from a different client were refused while the "
            "probe held its limit spent. The two share one limit, so Traefik is not forwarding each "
            "client's own address: is deploy/k8s/traefik-config.yaml applied?")
        for _, body in host_results:
            self.assertIn("access_token", json.loads(body))


if __name__ == "__main__":
    unittest.main(verbosity=2)
