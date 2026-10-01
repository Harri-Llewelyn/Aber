"""
Contract tests for the broker credential service.

WHAT THIS PROTECTS. The service's whole justification is that it holds LESS authority than the
alternatives: three verbs that name a gateway, spoken to the broker's Dynamic Security plugin as an
account that reaches nothing else. Four properties make that true, and each fails silently if it
regresses:

  * AUTHENTICATION. An unauthenticated issuer lets anything that can reach the port issue a
    Mosquitto account for any edge node, and the gateway's role turns an account into the ability
    to publish Sparkplug telemetry AS that gateway. Nothing errors; the forged telemetry is simply
    indistinguishable from the real thing.

  * NOTHING LOST. The plugin keeps every account it holds across an issue, a re-issue and a
    revocation. This repository once truncated the broker's password file on a re-provision
    (docs/incidents.md); the plugin's document cannot be truncated by a command, and this asserts
    that every account present beforehand is still present afterwards.

  * REVOCATION REFUSES THE NEXT CONNECT and leaves the account listed as disabled. A live session
    being dropped is asserted where a broker can be started for it, scripts/check-broker-config.mjs.

  * THE INVENTORY CARRIES NO HASH. `listClients` returns each client's salt and iterations; the
    service drops them, because the Access Control page shows what it returns.

  * THE ROOT IT REPORTS IS THE ONE THE BROKER PRESENTS, with the pin an appliance computes for
    itself. The trust bundle on the platform repository is published from `GET /ca`, so a wrong
    pin or a stale certificate here reaches every converging appliance as a bundle it refuses --
    or, worse, one it accepts and then cannot connect through.

Requires the stack up on a cluster, and MQTT_CREDENTIAL_SERVICE_TOKEN:

    MQTT_CREDENTIAL_SERVICE_TOKEN=... python gateway-credential/test_gateway_credential.py
"""
import base64
import hashlib
import json
import os
import sys
import unittest
import urllib.error
import urllib.request

try:
    from cryptography import x509
    from cryptography.hazmat.primitives import serialization
except ImportError:  # the pin assertion skips; every other assertion here stands
    x509 = None
    serialization = None

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test-harness"))
import stack_exec  # noqa: E402  -- kubectl exec against the workload that holds the container

TOKEN = os.getenv("MQTT_CREDENTIAL_SERVICE_TOKEN", "")

# Not a real gateway. It needs no database row: this service issues BROKER accounts and knows
# nothing about the gateways table -- binding a device to a gateway is verify_gateway_binding()'s
# job, one layer up. The id only has to satisfy GATEWAY_ID_PATTERN.
TEST_GW = "gwy2f0000000000400080000"


def delete_client(username):
    """
    Remove an account from the plugin, through the service container's own admin credential. The
    service never deletes, so this is the one place a delete is spoken; the per-gateway role is
    left where it is, because deleting a role a client holds took the broker down when measured.
    """
    stack_exec.run(
        "credential", "sh", "-c",
        'mosquitto_ctrl -h "${MQTT_HOST:-mosquitto}" -u "$MQTT_DYNSEC_ADMIN_USER" '
        f'-P "$MQTT_DYNSEC_ADMIN_PASSWORD" dynsec deleteClient {username}',
    )


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
const method = process.env.REQ_METHOD || 'POST';
const body = method === 'GET' ? undefined : process.env.REQ_BODY;
const token = process.env.REQ_TOKEN;
const headers = { 'Content-Type': 'application/json' };
if (token) headers.Authorization = 'Bearer ' + token;
fetch('http://127.0.0.1:9010' + process.env.REQ_PATH, { method, headers, body })
  .then(async (r) => { console.log(r.status); console.log(await r.text()); })
  .catch((e) => { console.log('000'); console.log(JSON.stringify({ error: String(e) })); });
"""


def call(body=None, token=TOKEN, path="/credentials", raw_body=None, method="POST"):
    """
    Call the service FROM INSIDE the container network.

    It publishes no host port -- that is the primary control, not an inconvenience -- so the request
    has to be made from within. A host-side client has nowhere to connect, which is itself asserted
    by test_host_cannot_reach_it_directly.
    """
    env = {
        "REQ_BODY": raw_body if raw_body is not None else json.dumps(body),
        "REQ_PATH": path,
        "REQ_METHOD": method,
    }
    if token is not None:
        env["REQ_TOKEN"] = token

    result = stack_exec.run("credential", "node", "-e", _CLIENT, env=env)
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


def inventory():
    """The broker's own list, as the Access Control page reads it."""
    status, payload = call(path="/clients", method="GET")
    if status != 200:
        raise RuntimeError(f"GET /clients answered {status}: {payload}")
    return payload


def accounts():
    """Usernames the broker holds right now."""
    return [c["username"] for c in inventory()["clients"]]


def client_entry(username):
    return next((c for c in inventory()["clients"] if c["username"] == username), None)


def publish_as(username, password):
    """Publish under the account's own edge node over MQTTS; the exit status is the broker's answer."""
    return stack_exec.run(
        "broker", "mosquitto_pub",
        "--cafile", "/mosquitto/certs/ca.crt", "-h", stack_exec.broker_host(), "-p", "8883",
        "-u", username, "-P", password,
        "-t", f"spBv1.0/Aber/DBIRTH/{username}/probe", "-m", "x",
    )


@unittest.skipIf(not TOKEN, "MQTT_CREDENTIAL_SERVICE_TOKEN is not set")
class CredentialServiceBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        probe = stack_exec.run("credential", "wget", "-qO-", "http://127.0.0.1:9010/healthz")
        if probe.returncode != 0:
            raise unittest.SkipTest(
                f"{stack_exec.describe('credential')} is not answering /healthz -- is the stack up?"
            )

    def tearDown(self):
        """Remove the test account, leaving the broker exactly as it was found."""
        delete_client(TEST_GW)


class TestAuthentication(CredentialServiceBase):
    def test_healthz_is_open_and_says_nothing(self):
        body = stack_exec.output("credential", "wget", "-qO-", "http://127.0.0.1:9010/healthz")
        payload = json.loads(body)
        self.assertEqual(payload["status"], "ok")
        # Liveness ONLY. A health endpoint that leaked the account list would be an
        # unauthenticated read of exactly what the authenticated endpoint protects.
        self.assertEqual(set(payload), {"status"})

    def test_missing_token_is_refused(self):
        status, _ = call({"sparkplug_id": TEST_GW}, token=None)
        self.assertEqual(status, 401)
        self.assertNotIn(TEST_GW, accounts(), "an unauthenticated request issued an account")

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

    def test_the_inventory_needs_the_token_too(self):
        # The list is the map of the site's telemetry authority, and it is behind the same bearer.
        status, _ = call(path="/clients", method="GET", token=None)
        self.assertEqual(status, 401)

    def test_unknown_paths_and_verbs(self):
        status, _ = call({}, path="/anything")
        self.assertEqual(status, 404)
        status, _ = call({}, path="/clients")
        self.assertEqual(status, 405)


class TestValidation(CredentialServiceBase):
    def test_rejects_ids_the_broker_could_not_confine(self):
        # A username that is not a real edge-node id produces an account confined to a subtree
        # nothing publishes to: it authenticates and every message is then dropped.
        for bad in ("val_gateway_01", "GWY120000000000400080000", "gwy123", "", None):
            with self.subTest(sparkplug_id=bad):
                status, payload = call({"sparkplug_id": bad})
                self.assertEqual(status, 400)
                self.assertEqual(payload.get("code"), "invalid_sparkplug_id")

    def test_rejects_a_password_outside_the_alphabet(self):
        # The alphabet is an injection boundary kept because the operator CLI still puts a
        # hand-typed password on a command line; an invalid value should not reach a process.
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
        self.assertTrue(payload["applied_to_running_broker"])
        self.assertEqual(payload["apply_method"], "dynsec")

        after = accounts()
        # THE ASSERTION THE INCIDENT WOULD HAVE NEEDED.
        for account in before:
            self.assertIn(account, after, f"issuing a credential LOST the account {account}")
        self.assertEqual(set(after), set(before) | {TEST_GW})

        # Both roles, so the account is confined to its own edge node and can subscribe.
        entry = client_entry(TEST_GW)
        self.assertEqual(set(entry["roles"]), {"gateway", f"gateway-{TEST_GW}"})
        self.assertFalse(entry["disabled"])

        # And it is a real credential. Published over MQTTS on 8883 under its OWN edge node, which
        # is the only subtree its role permits it.
        publish = publish_as(TEST_GW, payload["password"])
        self.assertEqual(
            publish.returncode, 0,
            f"the issued credential was refused by the broker: {publish.stderr.strip()}",
        )

    def test_reissuing_replaces_rather_than_appends(self):
        _, first = call({"sparkplug_id": TEST_GW})
        before = accounts()

        status, second = call({"sparkplug_id": TEST_GW})
        self.assertEqual(status, 200)
        self.assertTrue(second["replaced"])
        self.assertNotEqual(first["password"], second["password"])

        after = accounts()
        self.assertEqual(len(after), len(before), "re-issuing added a second account")
        self.assertEqual(after.count(TEST_GW), 1)

        self.assertEqual(publish_as(TEST_GW, second["password"]).returncode, 0, "the new password does not work")
        self.assertNotEqual(
            publish_as(TEST_GW, first["password"]).returncode, 0,
            "the SUPERSEDED password still authenticates",
        )

    def test_the_password_is_generated_when_not_supplied(self):
        _, payload = call({"sparkplug_id": TEST_GW})
        # base64url, the alphabet assertSafePassword enforces.
        self.assertRegex(payload["password"], r"^[A-Za-z0-9_-]{16,128}$")


class TestRevocation(CredentialServiceBase):
    def test_revoking_disables_and_reissuing_reenables(self):
        _, issued = call({"sparkplug_id": TEST_GW})
        self.assertEqual(publish_as(TEST_GW, issued["password"]).returncode, 0)
        before = accounts()

        status, payload = call({"sparkplug_id": TEST_GW}, path="/revocations")
        self.assertEqual(status, 200)
        self.assertTrue(payload["revoked"])
        self.assertTrue(payload["existed"])

        # Refused at CONNECT, still listed, listed as disabled -- and nothing else lost.
        self.assertNotEqual(publish_as(TEST_GW, issued["password"]).returncode, 0,
                            "a revoked account still authenticates")
        self.assertEqual(set(accounts()), set(before))
        self.assertTrue(client_entry(TEST_GW)["disabled"])

        # A re-issue is the way back: replaced, enabled, and the new password works.
        status, again = call({"sparkplug_id": TEST_GW})
        self.assertEqual(status, 200)
        self.assertTrue(again["replaced"])
        self.assertFalse(client_entry(TEST_GW)["disabled"])
        self.assertEqual(publish_as(TEST_GW, again["password"]).returncode, 0)

    def test_revoking_an_unknown_account_creates_nothing(self):
        before = accounts()
        status, payload = call({"sparkplug_id": TEST_GW}, path="/revocations")
        self.assertEqual(status, 200)
        self.assertFalse(payload["revoked"])
        self.assertFalse(payload["existed"])
        self.assertEqual(accounts(), before)


class TestInventory(CredentialServiceBase):
    def test_the_inventory_carries_roles_and_state_and_no_hash(self):
        call({"sparkplug_id": TEST_GW})
        payload = inventory()
        text = json.dumps(payload)
        for leaked in ("salt", "iterations", '"password"'):
            self.assertNotIn(leaked, text, f"the inventory leaked {leaked}")
        self.assertEqual(set(payload), {"clients", "roles", "read_at"})
        # The platform principals and the policy's roles are there, with their rules.
        self.assertIn("aber_ingestion", [c["username"] for c in payload["clients"]])
        gateway_role = next(r for r in payload["roles"] if r["rolename"] == "gateway")
        self.assertTrue(any(a["topic"] == "spBv1.0/#" for a in gateway_role["acls"]))


class TestCertificateAuthority(CredentialServiceBase):
    """
    `GET /ca` is what forge-sweep publishes the trust bundle from, so an appliance that has never
    been visited learns of a re-issued root through it. Three things have to hold: the pin is the
    one the appliance's own `openssl` computes, the dates are the certificate's and not this
    request's, and a deployment with no root says so rather than answering with a blank.
    """

    def test_the_root_is_returned_with_its_dates_and_its_pin(self):
        status, payload = call(path="/ca", method="GET")
        self.assertEqual(status, 200)
        self.assertIn("BEGIN CERTIFICATE", payload["ca_cert"])
        self.assertEqual(set(payload), {"ca_cert", "not_before", "not_after", "spki_sha256", "read_at"})

        # The window is the certificate's own. A root whose validity had already passed would be
        # published into the bundle and then refused by every appliance that checked it.
        self.assertLess(payload["not_before"], payload["not_after"])
        self.assertGreater(payload["not_after"], payload["read_at"])

        # THE PIN IS THE SubjectPublicKeyInfo'S, computed here by a different implementation. The
        # appliance computes it with an openssl pipeline and _shared/caPin.ts walks the DER in the
        # worker; a service computing a third thing would look right in every response and match
        # nothing that checked it. Skipped rather than weakened where the parser is absent: the
        # broker's own image carries no openssl, so there is nothing to fall back to in-container.
        if x509 is None:
            self.skipTest("the `cryptography` package is not installed; the pin cannot be recomputed")
        certificate = x509.load_pem_x509_certificate(payload["ca_cert"].encode())
        spki = certificate.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )
        self.assertEqual(payload["spki_sha256"], base64.b64encode(hashlib.sha256(spki).digest()).decode())

    def test_the_root_is_the_one_the_broker_presents(self):
        # The whole point of reading it here rather than from a Secret somewhere: this service sits
        # beside the broker, so what it returns is what a gateway will actually be shown.
        presented = stack_exec.output(
            "credential", "sh", "-c",
            'cat "${MQTT_CA_FILE:-/mosquitto/certs/ca.crt}"',
        )
        _, payload = call(path="/ca", method="GET")
        self.assertEqual(payload["ca_cert"].strip(), presented.strip())

    def test_the_root_needs_the_token_and_only_answers_a_GET(self):
        status, _ = call(path="/ca", method="GET", token=None)
        self.assertEqual(status, 401)
        status, _ = call({}, path="/ca")
        self.assertEqual(status, 405)


class TestExposure(CredentialServiceBase):
    def test_service_is_not_published_on_the_host(self):
        """
        THE PRIMARY CONTROL, ahead of the bearer token. Publishing 9010 would put credential
        issuance on the host interface, and issuance is -- through the gateway's role -- the ability
        to publish Sparkplug telemetry as any gateway on the site.
        """
        ports = stack_exec.published_ports("credential")
        self.assertEqual(ports, "", f"the credential service is published on the host: {ports}")

    def test_host_cannot_reach_it_directly(self):
        with self.assertRaises((urllib.error.URLError, OSError)):
            urllib.request.urlopen("http://127.0.0.1:9010/healthz", timeout=3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
