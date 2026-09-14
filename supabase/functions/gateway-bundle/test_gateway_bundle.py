"""
Integration tests for the gateway-bundle edge function.

THE TWO THINGS WORTH PROTECTING HERE, both of which fail quietly:

  * WHO MAY GENERATE A BUNDLE. A bundle contains a live claim on a gateway's identity. If an
    Operator or Auditor could download one, they could enrol an appliance that publishes telemetry
    as that gateway -- and because the broker's roles confine an account to its own edge-node subtree,
    the forged data would be indistinguishable from the real thing at every layer below.

  * THAT THE ARCHIVE IS ACTUALLY AN ARCHIVE. supabase-js's functions.invoke() text-decodes any
    response that is not JSON or octet-stream, which silently corrupts a ZIP -- the download
    succeeds, the file is the right size, and it will not open. The client must use a raw fetch();
    this suite proves the SERVER's half by unzipping what it returns.

Requires the stack up and SUPABASE_PUBLISHABLE_KEY / SUPABASE_SERVICE_ROLE_KEY:

    SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
        python supabase/functions/gateway-bundle/test_gateway_bundle.py
"""
import io
import json
import os
import re
import time
import unittest
from datetime import datetime, timezone
import urllib.error
import urllib.request
import zipfile

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

PHYSICAL_GW = "2c000000-0000-4000-8000-000000000001"
VIRTUAL_GW = "2b000000-0000-4000-8000-000000000001"

ACCOUNTS = {
    "Administrator": "admin@acs-cymru.local",
    "Shopfloor_Manager": "manager@acs-cymru.local",
    "Operator": "operator@acs-cymru.local",
    "Auditor": "auditor@acs-cymru.local",
}
PASSWORD = os.getenv("ACS_DEMO_PASSWORD", "acscymru123")


def rest(path, method="GET", body=None, bearer=None, prefer=None):
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "apikey": PUBLISHABLE_KEY,
            "Authorization": f"Bearer {bearer or SERVICE_ROLE_KEY}",
            "Content-Type": "application/json",
            "X-ACS-Cymru-Actor": "service",
            **({"Prefer": prefer} if prefer else {}),
        },
    )
    with urllib.request.urlopen(req, timeout=15) as response:
        raw = response.read().decode()
        return response.status, (json.loads(raw) if raw.strip() else None)


def sign_in(email):
    req = urllib.request.Request(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        method="POST",
        data=json.dumps({"email": email, "password": PASSWORD}).encode(),
        headers={"apikey": PUBLISHABLE_KEY, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.loads(response.read().decode())["access_token"]


def download(gateway_id, bearer):
    """
    Fetch the bundle with a RAW request, the way the dashboard must.

    Deliberately not through any SDK: supabase-js's invoke() decodes a non-JSON, non-octet-stream
    body as TEXT and corrupts the archive. The bytes are read here exactly as they arrive.
    """
    req = urllib.request.Request(
        f"{SUPABASE_URL}/functions/v1/gateway-bundle",
        method="POST",
        data=json.dumps({"gateway_id": gateway_id}).encode(),
        headers={
            "apikey": PUBLISHABLE_KEY,
            "Authorization": f"Bearer {bearer}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, response.read(), headers_of(response)
    except urllib.error.HTTPError as err:
        raw = err.read()
        try:
            return err.code, json.loads(raw.decode()), headers_of(err)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return err.code, raw, headers_of(err)


def headers_of(response):
    """
    Response headers, keyed in LOWER CASE.

    HTTP header names are case-insensitive, and this response proves why that matters rather than
    being a technicality: the gateway and the Deno runtime return a MIXTURE -- `Content-Type` capitalised,
    `content-disposition` not -- so `dict(response.headers)["Content-Disposition"]` raises KeyError
    against a response that is perfectly correct. Normalising here keeps the assertions about the
    header's VALUE rather than about whichever component last touched its name.
    """
    return {key.lower(): value for key, value in response.headers.items()}


@unittest.skipIf(not PUBLISHABLE_KEY or not SERVICE_ROLE_KEY,
                 "SUPABASE_PUBLISHABLE_KEY and SUPABASE_SERVICE_ROLE_KEY must be set")
class BundleBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            rest("/gateways?limit=1")
        except Exception as err:  # noqa: BLE001
            raise unittest.SkipTest(f"PostgREST is unreachable at {SUPABASE_URL}: {err}")

        for gid in (PHYSICAL_GW, VIRTUAL_GW):
            rest(f"/gateways?id=eq.{gid}", method="DELETE")

        _, rows = rest(
            "/gateways", method="POST", prefer="return=representation",
            body=[
                {"id": PHYSICAL_GW, "name": "Test Bundle Gateway", "status": "OFFLINE",
                 "deployment": "remote"},
                {"id": VIRTUAL_GW, "name": "Test Bundle Virtual", "status": "OFFLINE",
                 "deployment": "host"},
            ],
        )
        cls.sparkplug_id = next(r["sparkplug_id"] for r in rows if r["id"] == PHYSICAL_GW)

        cls.tokens = {}
        for role, email in ACCOUNTS.items():
            try:
                cls.tokens[role] = sign_in(email)
            except Exception as err:  # noqa: BLE001
                raise unittest.SkipTest(f"could not sign in as {email}: {err}")

    @classmethod
    def tearDownClass(cls):
        for gid in (PHYSICAL_GW, VIRTUAL_GW):
            rest(f"/gateways?id=eq.{gid}", method="DELETE")


def probe(bearer=None):
    """The readiness GET, as the dashboard sends it. Returns (status, body)."""
    headers = {"apikey": PUBLISHABLE_KEY}
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    req = urllib.request.Request(f"{SUPABASE_URL}/functions/v1/gateway-bundle", method="GET", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            return response.status, json.loads(response.read().decode())
    except urllib.error.HTTPError as err:
        raw = err.read().decode()
        return err.code, (json.loads(raw) if raw.strip() else None)


class TestReadiness(BundleBase):
    """
    The GET the Gateways page asks before it offers a remote gateway. CI sets both addresses, so
    the answer here is ready; the shape is what the dashboard reads, and a refusal mints nothing.
    """

    def test_any_signed_in_user_may_ask(self):
        for role in ACCOUNTS:
            with self.subTest(role=role):
                status, body = probe(self.tokens[role])
                self.assertEqual(status, 200, body)
                self.assertIs(body["ready"], True, body)
                self.assertEqual(
                    sorted(a["variable"] for a in body["addresses"]),
                    ["MQTT_PUBLIC_HOST", "SUPABASE_PUBLIC_URL"],
                )
                for address in body["addresses"]:
                    self.assertIsNone(address["problem"], address)
                    self.assertTrue(address["value"], address)

    def test_the_platform_root_is_reported_with_its_expiry_and_pin(self):
        """
        What the Gateways page puts beside each appliance's own reported expiry. Together the two
        say whether a re-issued root has reached that gateway yet, which is the question between
        re-issuing the root and switching the broker's leaf to it.
        """
        status, body = probe(self.tokens["Administrator"])
        self.assertEqual(status, 200, body)
        self.assertIsNotNone(body["ca"], "the stack presents a root; the probe reported none")
        self.assertEqual(set(body["ca"]), {"not_after", "spki_sha256"})
        # A date, and one that has not passed: a platform publishing an expired root would have
        # every appliance reading as ahead of it.
        self.assertGreater(body["ca"]["not_after"], datetime.now(timezone.utc).isoformat())
        # Base64 of a SHA-256, which is 44 characters ending in '='.
        self.assertRegex(body["ca"]["spki_sha256"], r"^[A-Za-z0-9+/]{43}=$")

    def test_the_root_carries_no_private_key(self):
        # The probe is open to any signed-in user. It reports when the root expires and what its
        # public key hashes to, and never the certificate, let alone the key beside it.
        _, body = probe(self.tokens["Operator"])
        self.assertNotIn("ca_cert", body["ca"])
        self.assertNotIn("PRIVATE KEY", json.dumps(body))

    def test_the_probe_answers_promptly_and_says_why_when_it_withholds(self):
        """
        THE READINESS ANSWER REACHES THE PAGE ON LOAD, so it must not be able to hang. It now
        fetches ACS_CA_URL the way stage 0 does -- with redirects disabled, because `curl -fsSL`
        follows none, and a deployment that redirects HTTP to HTTPS on the dashboard's host would
        otherwise mint a command that stops on its first clause, on the appliance, saying only that
        a certificate could not be installed.

        What is asserted here is what holds on every deployment: the probe answers inside its own
        bound, and a withheld command carries a reason an operator can act on. Whether the root is
        fetchable is a property of the deployment, not of this build -- CI's stack mints an
        unpinned command and has no stage 0 to break.
        """
        started = time.monotonic()
        status, body = probe(self.tokens["Administrator"])
        elapsed = time.monotonic() - started
        self.assertEqual(status, 200, body)
        self.assertLess(elapsed, 10, f"the readiness probe took {elapsed:.1f}s; it is asked on page load")
        self.assertIn("available", body["installer"])
        if not body["installer"]["available"]:
            self.assertTrue(body["installer"]["reason"], "a withheld command with no reason is a dead end")

    def test_probe_needs_a_signed_in_user(self):
        status, _ = probe()
        self.assertIn(status, (400, 401))

    def test_probe_mints_nothing(self):
        rest(f"/gateway_enrollment_tokens?gateway_id=eq.{PHYSICAL_GW}", method="DELETE")
        probe(self.tokens["Administrator"])
        _, rows = rest(f"/gateway_enrollment_tokens?gateway_id=eq.{PHYSICAL_GW}&select=id")
        self.assertEqual(rows, [], "the readiness probe minted an enrolment token")


class TestPermissions(BundleBase):
    def test_privileged_roles_may_download(self):
        for role in ("Administrator", "Shopfloor_Manager"):
            with self.subTest(role=role):
                status, body, _ = download(PHYSICAL_GW, self.tokens[role])
                self.assertEqual(status, 200, body)

    def test_operator_and_auditor_are_refused(self):
        """
        A bundle is a live claim on a gateway's identity. An Operator who could download one could
        stand up an appliance publishing telemetry AS that gateway, and the broker's roles would confine
        it to exactly the subtree that makes the forgery credible.
        """
        for role in ("Operator", "Auditor"):
            with self.subTest(role=role):
                status, body, _ = download(PHYSICAL_GW, self.tokens[role])
                self.assertEqual(status, 403, body)
                self.assertIn("Insufficient privileges", body["error"])

    def test_refusal_issues_no_token(self):
        """A 403 must not leave a live claim behind -- otherwise the refusal is only cosmetic."""
        rest(f"/gateway_enrollment_tokens?gateway_id=eq.{PHYSICAL_GW}", method="DELETE")
        download(PHYSICAL_GW, self.tokens["Operator"])
        _, rows = rest(
            f"/gateway_enrollment_tokens?gateway_id=eq.{PHYSICAL_GW}&select=id"
        )
        self.assertEqual(rows, [], "a refused download still minted an enrolment token")

    def test_no_authorization_header(self):
        req = urllib.request.Request(
            f"{SUPABASE_URL}/functions/v1/gateway-bundle",
            method="POST", data=json.dumps({"gateway_id": PHYSICAL_GW}).encode(),
            headers={"apikey": PUBLISHABLE_KEY, "Content-Type": "application/json"},
        )
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(req, timeout=15)
        self.assertIn(caught.exception.code, (400, 401))

    def test_virtual_gateway_is_refused(self):
        status, body, _ = download(VIRTUAL_GW, self.tokens["Administrator"])
        self.assertEqual(status, 400, body)
        self.assertIn("virtual", body["error"].lower())

    def test_unknown_gateway_is_404(self):
        status, body, _ = download("00000000-0000-4000-8000-00000000dead",
                                   self.tokens["Administrator"])
        self.assertEqual(status, 404, body)


class TestArchiveIntegrity(BundleBase):
    def setUp(self):
        status, self.body, self.headers = download(PHYSICAL_GW, self.tokens["Administrator"])
        self.assertEqual(status, 200, self.body)

    def test_binary_response_headers(self):
        self.assertEqual(self.headers["content-type"], "application/zip")
        self.assertIn("attachment; filename=", self.headers["content-disposition"])
        self.assertRegex(self.headers["content-disposition"], r'filename="acs-gateway-[\w.-]+\.zip"')
        # A bundle carries a live claim; nothing may keep a copy.
        self.assertIn("no-store", self.headers["cache-control"])
        # The expiry rides in a header because a binary body has nowhere to carry it.
        self.assertIn("x-acs-token-expires-at", self.headers)
        self.assertIn("x-acs-bundle-version", self.headers)

    def test_is_a_valid_zip(self):
        # The literal PK signature, then a real structural check. A text-decoded archive is the
        # right approximate size and fails both.
        self.assertTrue(self.body.startswith(b"PK"), "response does not begin with a ZIP signature")
        archive = zipfile.ZipFile(io.BytesIO(self.body))
        self.assertIsNone(archive.testzip(), "corrupt archive")

    def test_contains_every_file_the_appliance_needs(self):
        archive = zipfile.ZipFile(io.BytesIO(self.body))
        names = archive.namelist()
        folder = names[0].split("/")[0]
        self.assertTrue(folder.startswith("acs-gateway-"))

        for required in (".env", "docker-compose.yml", "Dockerfile",
                         "bootstrap.mjs", "flows.template.json", "README.md"):
            self.assertIn(f"{folder}/{required}", names, f"{required} is missing from the bundle")

    def test_expands_into_one_named_folder(self):
        """Four appliances provisioned in a morning means four downloads that must be tellable apart."""
        archive = zipfile.ZipFile(io.BytesIO(self.body))
        folders = {name.split("/")[0] for name in archive.namelist()}
        self.assertEqual(len(folders), 1, f"the archive expands into several folders: {folders}")

    def test_template_files_arrive_intact(self):
        archive = zipfile.ZipFile(io.BytesIO(self.body))
        folder = archive.namelist()[0].split("/")[0]

        flows = archive.read(f"{folder}/flows.template.json").decode()
        json.loads(flows)  # must still parse after the round trip
        # PLACEHOLDERS SURVIVE. bootstrap.mjs substitutes them at first boot from the enrolment
        # response, so a template that arrived pre-substituted (or mangled) would produce an
        # appliance pointed at the wrong broker.
        for placeholder in ("__MQTT_HOST__", "__MQTT_TLS_PORT__",
                            "__SPARKPLUG_ID__", "__SPARKPLUG_GROUP__"):
            self.assertIn(placeholder, flows)

        bootstrap = archive.read(f"{folder}/bootstrap.mjs").decode()
        self.assertIn("enroll-gateway", bootstrap)
        self.assertIn("retryable", bootstrap)

        compose = archive.read(f"{folder}/docker-compose.yml").decode()
        self.assertIn("service_completed_successfully", compose)


class TestTokenEmbedding(BundleBase):
    def env_of(self, body):
        archive = zipfile.ZipFile(io.BytesIO(body))
        folder = archive.namelist()[0].split("/")[0]
        return archive.read(f"{folder}/.env").decode()

    def test_env_carries_a_usable_token_and_no_broker_password(self):
        _, body, headers = download(PHYSICAL_GW, self.tokens["Administrator"])
        env = self.env_of(body)

        token = re.search(r"^ACS_ENROLLMENT_TOKEN=([0-9a-f]{64})$", env, re.M)
        self.assertIsNotNone(token, "the bundle carries no enrolment token")

        # THE BUNDLE CONTAINS A CLAIM, NOT A CREDENTIAL. There must be no broker password in it:
        # the appliance obtains one for itself at first boot, which is the entire reason a
        # short-lived single-use token is used instead.
        self.assertNotRegex(env, r"(?i)mqtt_password")
        self.assertNotRegex(env, r"(?i)^ACS_MQTT_PASS")

        self.assertIn("ACS_SUPABASE_PUBLISHABLE_KEY=", env)
        self.assertIn("NODERED_CREDENTIAL_SECRET=", env)
        # The address the APPLIANCE dials -- never the in-stack one, which resolves nowhere useful.
        url = re.search(r"^ACS_SUPABASE_URL=(.+)$", env, re.M).group(1)
        self.assertNotIn("supabase-kong", url)
        self.assertNotIn("127.0.0.1", url)

    def test_the_embedded_token_matches_the_stored_hash(self):
        """The token in the file is the one the database will accept -- not merely well-formed."""
        _, body, _ = download(PHYSICAL_GW, self.tokens["Administrator"])
        token = re.search(r"^ACS_ENROLLMENT_TOKEN=([0-9a-f]{64})$", self.env_of(body), re.M).group(1)

        _, rows = rest(
            "/rpc/consume_gateway_enrollment_token", method="POST", body={"p_token": token},
        )
        self.assertTrue(rows, "the token embedded in the bundle was not accepted")
        self.assertEqual(rows[0]["sparkplug_id"], self.sparkplug_id)

    def test_credential_secret_is_unique_per_bundle(self):
        """
        Generated per bundle and never shared. A constant here would mean one appliance's
        flows_cred.json could be decrypted with any other bundle's .env.
        """
        secrets = set()
        for _ in range(3):
            _, body, _ = download(PHYSICAL_GW, self.tokens["Administrator"])
            secrets.add(
                re.search(r"^NODERED_CREDENTIAL_SECRET=(.+)$", self.env_of(body), re.M).group(1)
            )
        self.assertEqual(len(secrets), 3, "the credential secret repeats across bundles")
        for secret in secrets:
            self.assertRegex(secret, r"^[0-9a-f]{64}$")

    def test_regenerating_invalidates_the_previous_bundle(self):
        """
        Exactly one download is ever redeemable. Otherwise 'regenerate' hands out a second valid
        claim rather than replacing the first, and two appliances could enrol as one gateway.
        """
        _, first, _ = download(PHYSICAL_GW, self.tokens["Administrator"])
        first_token = re.search(
            r"^ACS_ENROLLMENT_TOKEN=([0-9a-f]{64})$", self.env_of(first), re.M).group(1)

        _, second, _ = download(PHYSICAL_GW, self.tokens["Administrator"])
        second_token = re.search(
            r"^ACS_ENROLLMENT_TOKEN=([0-9a-f]{64})$", self.env_of(second), re.M).group(1)

        self.assertNotEqual(first_token, second_token)

        _, stale = rest("/rpc/consume_gateway_enrollment_token", method="POST",
                        body={"p_token": first_token})
        self.assertEqual(stale, [], "the superseded bundle's token is still redeemable")

        _, live = rest("/rpc/consume_gateway_enrollment_token", method="POST",
                       body={"p_token": second_token})
        self.assertTrue(live, "the newest bundle's token was refused")


if __name__ == "__main__":
    unittest.main(verbosity=2)
