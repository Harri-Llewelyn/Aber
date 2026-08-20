"""
Contract tests for the broker credential-issuing service.

WHAT THIS PROTECTS. The service's whole justification is that it holds LESS authority than the
alternatives -- it can add one line to one file and do nothing else. Two properties make that true,
and both fail silently if they regress:

  * AUTHENTICATION. An unauthenticated issuer lets anything that can reach the port mint a Mosquitto
    account for any edge node, and mosquitto.acl's `%u` confinement turns an account into the
    ability to publish Sparkplug telemetry AS that gateway. Nothing errors; the forged telemetry is
    simply indistinguishable from the real thing.

  * NO TRUNCATION. `mosquitto_passwd -b -c` creates the file and discards its contents. A run that
    lost every other gateway's credential does not fail -- Mosquitto keeps authenticated accounts in
    memory, so the fleet keeps working until the next reload, whereupon the broker comes up having
    never heard of any of them. This repository has already hit that once; see the mosquitto-init
    header in docker-compose.yml.

The suite issues real credentials against the running service and asserts BOTH -- including that
every account present beforehand is still present afterwards, which is the assertion the incident
would have needed.

Requires the stack up (`docker compose up -d`) and MQTT_CREDENTIAL_SERVICE_TOKEN from .env:

    MQTT_CREDENTIAL_SERVICE_TOKEN=... python gateway-credential/test_gateway_credential.py
"""
import json
import os
import re
import subprocess
import unittest
import urllib.error
import urllib.request

TOKEN = os.getenv("MQTT_CREDENTIAL_SERVICE_TOKEN", "")
SERVICE_CONTAINER = os.getenv("CREDENTIAL_CONTAINER", "acs-cymru_gateway_credential")
BROKER_CONTAINER = os.getenv("MOSQUITTO_CONTAINER", "acs-cymru_mosquitto")
PASSWORD_FILE = "/mosquitto/config/password_file"

# Not a real gateway. It needs no database row: this service issues BROKER accounts and knows
# nothing about the gateways table -- binding a device to a gateway is verify_gateway_binding()'s
# job, one layer up. The id only has to satisfy GATEWAY_ID_PATTERN.
TEST_GW = "gwy2f0000000000400080000"


def docker(container, *args, check=True):
    """Run a command in a container and return stdout."""
    result = subprocess.run(
        ["docker", "exec", container, *args],
        capture_output=True, text=True,
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"{' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def password_file():
    return docker(BROKER_CONTAINER, "cat", PASSWORD_FILE)


def accounts():
    """Usernames currently in the broker's password file."""
    return [
        line.split(":", 1)[0]
        for line in password_file().splitlines()
        if line.strip()
    ]


# The request is made by node INSIDE the service container, not by busybox wget.
#
# BECAUSE wget THROWS THE BODY AWAY ON 4xx. `wget -qO-` exits non-zero and prints nothing for a 400,
# so every assertion about an ERROR RESPONSE -- which is most of this suite -- would have had
# nothing to inspect. The image is built FROM eclipse-mosquitto with node added, so a real HTTP
# client is already present; using it makes status and body available for every case alike.
#
# Arguments arrive through the environment rather than being interpolated into the script, so a
# test payload containing quotes cannot change what the script does.
_CLIENT = """
const body = process.env.REQ_BODY;
const token = process.env.REQ_TOKEN;
const headers = { 'Content-Type': 'application/json' };
if (token) headers.Authorization = 'Bearer ' + token;
fetch('http://127.0.0.1:9010' + process.env.REQ_PATH, { method: 'POST', headers, body })
  .then(async (r) => { console.log(r.status); console.log(await r.text()); })
  .catch((e) => { console.log('000'); console.log(JSON.stringify({ error: String(e) })); });
"""


def call(body, token=TOKEN, path="/credentials", raw_body=None):
    """
    POST to the service FROM INSIDE the container network.

    It publishes no host port -- that is the primary control, not an inconvenience -- so the request
    has to be made from within. A host-side client has nowhere to connect, which is itself asserted
    by test_host_cannot_reach_it_directly.
    """
    env = [
        "-e", f"REQ_BODY={raw_body if raw_body is not None else json.dumps(body)}",
        "-e", f"REQ_PATH={path}",
    ]
    if token is not None:
        env += ["-e", f"REQ_TOKEN={token}"]

    result = subprocess.run(
        ["docker", "exec", *env, SERVICE_CONTAINER, "node", "-e", _CLIENT],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"client failed: {result.stderr.strip()}")

    status_line, _, rest = result.stdout.partition("\n")
    status = int(status_line.strip())
    payload = None
    if rest.strip():
        try:
            payload = json.loads(rest)
        except json.JSONDecodeError:
            payload = {"raw": rest}
    return status, payload


@unittest.skipIf(not TOKEN, "MQTT_CREDENTIAL_SERVICE_TOKEN is not set")
class CredentialServiceBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        probe = subprocess.run(
            ["docker", "exec", SERVICE_CONTAINER, "wget", "-qO-", "http://127.0.0.1:9010/healthz"],
            capture_output=True, text=True,
        )
        if probe.returncode != 0:
            raise unittest.SkipTest(
                f"{SERVICE_CONTAINER} is not answering /healthz -- is the stack up?"
            )

    def tearDown(self):
        """Remove the test account, leaving the broker exactly as it was found."""
        subprocess.run(
            ["docker", "exec", BROKER_CONTAINER, "sh", "-c",
             f"grep -v '^{TEST_GW}:' {PASSWORD_FILE} > /tmp/pf.$$ "
             f"&& cat /tmp/pf.$$ > {PASSWORD_FILE} && rm -f /tmp/pf.$$"],
            capture_output=True, text=True,
        )


class TestAuthentication(CredentialServiceBase):
    def test_healthz_is_open_and_says_nothing(self):
        body = docker(SERVICE_CONTAINER, "wget", "-qO-", "http://127.0.0.1:9010/healthz")
        payload = json.loads(body)
        self.assertEqual(payload["status"], "ok")
        # Liveness and the configured target ONLY. A health endpoint that leaked the account list
        # or the password file's state would be an unauthenticated read of exactly what the
        # authenticated endpoint exists to protect.
        self.assertEqual(set(payload), {"status", "target"})

    def test_missing_token_is_refused(self):
        status, _ = call({"sparkplug_id": TEST_GW}, token=None)
        self.assertEqual(status, 401)
        self.assertNotIn(TEST_GW, accounts(), "an unauthenticated request minted an account")

    def test_wrong_token_is_refused(self):
        status, _ = call({"sparkplug_id": TEST_GW}, token="0" * 32)
        self.assertEqual(status, 401)
        self.assertNotIn(TEST_GW, accounts())

    def test_a_token_of_the_wrong_length_is_refused(self):
        # The constant-time comparison has a length branch; both arms must refuse.
        for bogus in ("short", "0" * 128):
            with self.subTest(length=len(bogus)):
                status, _ = call({"sparkplug_id": TEST_GW}, token=bogus)
                self.assertEqual(status, 401)

    def test_unknown_paths_and_verbs(self):
        status, _ = call({}, path="/anything")
        self.assertEqual(status, 404)


class TestValidation(CredentialServiceBase):
    def test_rejects_ids_the_acl_could_not_confine(self):
        # A username that is not a real edge-node id produces an account confined to a subtree
        # nothing publishes to: it authenticates and every message is then dropped.
        for bad in ("val_gateway_01", "GWY120000000000400080000", "gwy123", "", None):
            with self.subTest(sparkplug_id=bad):
                status, payload = call({"sparkplug_id": bad})
                self.assertEqual(status, 400)
                self.assertEqual(payload.get("code"), "invalid_sparkplug_id")

    def test_rejects_a_password_containing_shell_metacharacters(self):
        # The injection boundary that makes the single-quoted interpolation in hashScript safe.
        status, payload = call({"sparkplug_id": TEST_GW, "password": "a'; id; '"})
        self.assertEqual(status, 400)
        self.assertEqual(payload.get("code"), "invalid_password")
        self.assertNotIn(TEST_GW, accounts())

    def test_rejects_a_non_json_body(self):
        status, payload = call(None, raw_body="not json at all")
        self.assertEqual(status, 400)
        self.assertEqual(payload.get("code"), "invalid_request")


class TestIssuance(CredentialServiceBase):
    def test_issues_a_working_credential_without_losing_any_other(self):
        before = accounts()
        self.assertNotIn(TEST_GW, before)

        status, payload = call({"sparkplug_id": TEST_GW})
        self.assertEqual(status, 200)
        self.assertEqual(payload["sparkplug_id"], TEST_GW)
        self.assertFalse(payload["replaced"])
        self.assertTrue(payload["applied_to_running_broker"], "the broker was not SIGHUPed")

        after = accounts()
        # THE ASSERTION THE INCIDENT WOULD HAVE NEEDED.
        for account in before:
            self.assertIn(account, after, f"issuing a credential LOST the account {account}")
        self.assertEqual(set(after), set(before) | {TEST_GW})

        # And it is a real credential, not merely a line in a file. Published over MQTTS on 8883,
        # under its OWN edge node, which is the only subtree mosquitto.acl permits it.
        publish = subprocess.run(
            ["docker", "exec", BROKER_CONTAINER, "mosquitto_pub",
             "--cafile", "/mosquitto/certs/ca.crt", "-h", "localhost", "-p", "8883",
             "-u", TEST_GW, "-P", payload["password"],
             "-t", f"spBv1.0/ACS-Cymru/DBIRTH/{TEST_GW}/probe", "-m", "x"],
            capture_output=True, text=True,
        )
        self.assertEqual(
            publish.returncode, 0,
            f"the issued credential was refused by the broker: {publish.stderr.strip()}",
        )

    def test_reissuing_replaces_rather_than_appends(self):
        # Mosquitto reads the FIRST match, so an appended second line for the same username would
        # silently pin the OLD password: the rotation reports success and changes nothing.
        _, first = call({"sparkplug_id": TEST_GW})
        before = accounts()

        status, second = call({"sparkplug_id": TEST_GW})
        self.assertEqual(status, 200)
        self.assertTrue(second["replaced"])
        self.assertNotEqual(first["password"], second["password"])

        after = accounts()
        self.assertEqual(len(after), len(before), "re-issuing appended a second account")
        self.assertEqual(after.count(TEST_GW), 1)

        def publish(password):
            return subprocess.run(
                ["docker", "exec", BROKER_CONTAINER, "mosquitto_pub",
                 "--cafile", "/mosquitto/certs/ca.crt", "-h", "localhost", "-p", "8883",
                 "-u", TEST_GW, "-P", password,
                 "-t", f"spBv1.0/ACS-Cymru/DBIRTH/{TEST_GW}/probe", "-m", "x"],
                capture_output=True, text=True,
            ).returncode

        self.assertEqual(publish(second["password"]), 0, "the new password does not work")
        self.assertNotEqual(
            publish(first["password"]), 0,
            "the SUPERSEDED password still authenticates -- the entry was appended, not replaced",
        )

    def test_the_password_is_generated_when_not_supplied(self):
        _, payload = call({"sparkplug_id": TEST_GW})
        # base64url, the alphabet assertSafePassword enforces.
        self.assertRegex(payload["password"], r"^[A-Za-z0-9_-]{16,128}$")


class TestExposure(CredentialServiceBase):
    def test_service_is_not_published_on_the_host(self):
        """
        THE PRIMARY CONTROL, ahead of the bearer token. Publishing 9010 would put credential
        minting on the host interface, and minting is -- through mosquitto.acl's `%u` confinement --
        the ability to publish Sparkplug telemetry as any gateway on the site.
        """
        ports = subprocess.run(
            ["docker", "port", SERVICE_CONTAINER],
            capture_output=True, text=True,
        ).stdout.strip()
        self.assertEqual(ports, "", f"the credential service is published on the host: {ports}")

    def test_host_cannot_reach_it_directly(self):
        with self.assertRaises((urllib.error.URLError, OSError)):
            urllib.request.urlopen("http://127.0.0.1:9010/healthz", timeout=3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
