"""
The one-liner, against the live stack.

WHAT IS UNDER TEST. gateway-bundle mints the install command by role (Operator and Auditor get 403
and no token is minted); gateway-install serves the installer, the platform playbook and the
appliance's .env against the enrolment token in a header and refuses without it or with a wrong
one, identically; none of those fetches consumes the token, which enrolment then redeems exactly
as it would a bundle's; and the served installer is the platform playbook's install.sh with the
public values substituted and the token nowhere in its text.

Needs the stack and, on a plain-HTTP platform, ABER_INSTALLER_ALLOW_HTTP on the functions (the dev
values set it). Skips without the stack; a 503 from the command mint skips the class and says why.

    SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \\
      python supabase/functions/gateway-install/test_gateway_install.py
"""
import io
import json
import os
import re
import sys
import unittest
import urllib.error
import urllib.request
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "enroll-gateway"))
from test_enroll_gateway import (  # noqa: E402
    PUBLISHABLE_KEY, SERVICE_ROLE_KEY, SUPABASE_URL, delete_broker_account, enroll, rest, sign_in,
)

# Differs from every other suite's fixture id in its FIRST block (sparkplug_id is the first 21 hex
# characters of the uuid).
TEST_GW_ID = "f7a11000-0000-4000-8000-000000000001"
OPERATOR_EMAIL = os.getenv("ABER_OPERATOR_EMAIL", "operator@aber.local")


def mint(bearer, gateway_id=TEST_GW_ID):
    req = urllib.request.Request(
        f"{SUPABASE_URL}/functions/v1/gateway-bundle",
        method="POST",
        data=json.dumps({"gateway_id": gateway_id, "format": "command"}).encode(),
        headers={"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {bearer}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, json.loads(response.read().decode())
    except urllib.error.HTTPError as err:
        text = err.read().decode()
        return err.code, (json.loads(text) if text.strip() else None)


def fetch(token, query="", with_header=True):
    """Fetch the way the pasted command and the installer do: the apikey, and the token in a header."""
    headers = {"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {PUBLISHABLE_KEY}"}
    if with_header:
        headers["X-Enrolment-Token"] = token
    req = urllib.request.Request(f"{SUPABASE_URL}/functions/v1/gateway-install{query}", method="GET", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, response.read(), {k.lower(): v for k, v in response.headers.items()}
    except urllib.error.HTTPError as err:
        raw = err.read()
        try:
            return err.code, json.loads(raw.decode()), {k.lower(): v for k, v in err.headers.items()}
        except (json.JSONDecodeError, UnicodeDecodeError):
            return err.code, raw, {}


@unittest.skipIf(not PUBLISHABLE_KEY or not SERVICE_ROLE_KEY, "SUPABASE_PUBLISHABLE_KEY and SUPABASE_SERVICE_ROLE_KEY must be set")
class InstallerBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            rest("/gateways?limit=1")
        except Exception as err:  # noqa: BLE001
            raise unittest.SkipTest(f"PostgREST is unreachable at {SUPABASE_URL}: {err}")
        try:
            cls.admin_token = sign_in()
        except Exception as err:  # noqa: BLE001
            raise unittest.SkipTest(f"could not sign in as the seeded administrator ({err})")
        rest(f"/gateways?id=eq.{TEST_GW_ID}", method="DELETE")
        status, rows = rest(
            "/gateways", method="POST", prefer="return=representation",
            body={"id": TEST_GW_ID, "name": "Test_Installer", "status": "OFFLINE", "deployment": "remote"},
        )
        if status >= 300:
            raise unittest.SkipTest(f"could not create the test gateway: {rows}")
        cls.sparkplug_id = rows[0]["sparkplug_id"]
        status, minted = mint(cls.admin_token)
        if status == 503:
            raise unittest.SkipTest(f"this deployment cannot mint the install command: {minted}")
        assert status == 200, minted
        cls.minted = minted

    @classmethod
    def tearDownClass(cls):
        rest(f"/gateways?id=eq.{TEST_GW_ID}", method="DELETE")


class TestTheCommand(InstallerBase):
    def test_the_command_names_the_token_the_installer_and_where_to_fetch_it(self):
        minted = self.minted
        self.assertRegex(minted["token"], r"^[0-9a-f]{64}$")
        self.assertEqual(minted["sparkplug_id"], self.sparkplug_id)
        self.assertIn("/functions/v1/gateway-install", minted["install_url"])
        command = minted["command"]
        self.assertIn(f'X-Enrolment-Token: {minted["token"]}', command)
        self.assertIn(f"ABER_ENROLMENT_TOKEN={minted['token']}", command)
        self.assertIn(minted["install_url"], command)
        self.assertTrue(command.endswith(" bash"), command)
        # Stage 0 is present exactly when there is a root to pin.
        if minted["ca_pin"]:
            self.assertIn(minted["ca_url"], command)
            self.assertIn(f'= "{minted["ca_pin"]}"', command)
            self.assertIn("update-ca-certificates", command)
            self.assertIn(f"ABER_CA_PIN={minted['ca_pin']}", command)
            self.assertTrue(minted["install_url"].startswith("https://"), "a pinned command must fetch the installer over TLS")
        else:
            self.assertNotIn("update-ca-certificates", command)

    def test_an_operator_is_refused_and_no_token_is_minted(self):
        try:
            operator = sign_in(OPERATOR_EMAIL)
        except Exception as err:  # noqa: BLE001
            self.skipTest(f"could not sign in as the seeded operator ({err})")
        status, body = mint(operator)
        self.assertEqual(status, 403, body)
        # The administrator's token from setUpClass is still the live one: a refusal minted nothing.
        status, _, _ = fetch(self.minted["token"])
        self.assertEqual(status, 200, "the refused mint consumed the live token")


class TestWhatIsServed(InstallerBase):
    def test_the_installer_is_served_with_the_public_values_and_never_the_token(self):
        status, body, headers = fetch(self.minted["token"])
        self.assertEqual(status, 200, body)
        self.assertIn("text/x-shellscript", headers.get("content-type", ""))
        self.assertIn("no-store", headers.get("cache-control", ""))
        script = body.decode()
        self.assertTrue(script.startswith("#!/bin/bash"))
        self.assertTrue(script.rstrip().endswith('aber_install "$@"'), "the body must be a function invoked on the last line")
        self.assertNotIn("__PLATFORM_URL__", script)
        self.assertNotIn("__PUBLISHABLE_KEY__", script)
        self.assertIn(self.sparkplug_id, script)
        self.assertIn(PUBLISHABLE_KEY, script)
        self.assertNotIn(self.minted["token"], script, "the token rides in the environment, never in the script's text")

    def test_the_env_carries_the_token_and_a_fresh_secret_each_time(self):
        status, first, headers = fetch(self.minted["token"], "?file=env")
        self.assertEqual(status, 200, first)
        self.assertIn("no-store", headers.get("cache-control", ""))
        text = first.decode()
        self.assertIn(f"ABER_ENROLLMENT_TOKEN={self.minted['token']}", text)
        self.assertIn("ABER_GATEWAY_NAME=Test_Installer", text)
        self.assertIn(f"ABER_SUPABASE_PUBLISHABLE_KEY={PUBLISHABLE_KEY}", text)
        secret = re.search(r"^NODERED_CREDENTIAL_SECRET=([0-9a-f]{64})$", text, re.M)
        self.assertIsNotNone(secret, "no credential secret in the .env")
        status, second, _ = fetch(self.minted["token"], "?file=env")
        self.assertEqual(status, 200)
        other = re.search(r"^NODERED_CREDENTIAL_SECRET=([0-9a-f]{64})$", second.decode(), re.M)
        self.assertNotEqual(secret.group(1), other.group(1), "the secret must be generated per fetch; the installer keeps the first")

    def test_the_platform_playbook_is_served_as_a_zip(self):
        status, body, headers = fetch(self.minted["token"], "?file=platform.zip")
        self.assertEqual(status, 200, body)
        self.assertEqual(headers.get("content-type"), "application/zip")
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            names = set(archive.namelist())
        for expected in ("site.yml", "install.sh", "roles/converge/files/aber-gateway-converge", "appliance/bootstrap.mjs", "appliance/docker-compose.yml"):
            self.assertIn(expected, names)

    def test_an_unknown_file_is_a_404(self):
        status, body, _ = fetch(self.minted["token"], "?file=flows_cred.json")
        self.assertEqual(status, 404, body)


class TestTheGate(InstallerBase):
    def test_no_header_wrong_shape_and_unknown_token_are_refused_identically(self):
        answers = []
        for token, with_header in ((self.minted["token"], False), ("not-a-token", True), ("0" * 64, True)):
            status, body, _ = fetch(token, with_header=with_header)
            self.assertEqual(status, 401, body)
            answers.append(body)
        self.assertEqual(len({json.dumps(a, sort_keys=True) for a in answers}), 1, "refusals must not say which reason applied")
        for query in ("?file=env", "?file=platform.zip"):
            status, _, _ = fetch("0" * 64, query)
            self.assertEqual(status, 401)

    def test_fetching_does_not_consume_the_token_and_enrolment_then_does(self):
        for query in ("", "?file=platform.zip", "?file=env"):
            status, _, _ = fetch(self.minted["token"], query)
            self.assertEqual(status, 200)
        status, payload = enroll(self.minted["token"])
        self.assertEqual(status, 200, payload)
        try:
            self.assertEqual(payload["sparkplug_id"], self.sparkplug_id)
            # Spent by enrolment: the installer route now refuses it, like everything else.
            status, body, _ = fetch(self.minted["token"])
            self.assertEqual(status, 401, body)
        finally:
            delete_broker_account(self.sparkplug_id)


if __name__ == "__main__":
    unittest.main(verbosity=2)
