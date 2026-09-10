"""
The forge's push webhook, against the live stack.

WHAT IS UNDER TEST. forge-events is an open POST behind Envoy's key-auth whose only authentication is
the HMAC Gitea puts on every delivery, and whose effect is a write to a gateway row. So the suite
asserts, in order of what would be worst to get wrong: that an unsigned or mis-signed delivery is
refused; that a signed push to `main` lands on the right gateway with the right fields; that pushes
to other branches, repositories that are not a gateway's, and unknown gateways are ignored with a
200 (a non-2xx is a FAILED delivery on Gitea's hook page, and none of those is a failure); and --
the one that proves the wiring rather than the function -- that a delivery the FORGE itself sends
for a freshly enrolled gateway arrives signed, is verified, and records the branch's real head.

Needs the stack, the forge, and GITEA_WEBHOOK_SECRET (the value the edge runtime holds; read it from
.env). Skips without them.

    SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... GITEA_WEBHOOK_SECRET=... \\
      python supabase/functions/forge-events/test_forge_events.py
"""
import base64
import hashlib
import hmac
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "enroll-gateway"))
from test_enroll_gateway import ANON_KEY, SERVICE_ROLE_KEY, SUPABASE_URL, enroll, rest, sign_in  # noqa: E402

WEBHOOK_SECRET = os.getenv("GITEA_WEBHOOK_SECRET", "")
FORGE_URL = os.getenv("GITEA_TEST_URL", "http://127.0.0.1:3003")
MACHINE_USER = os.getenv("GITEA_MACHINE_USER", "acs_platform")
MACHINE_PASSWORD = os.getenv("GITEA_MACHINE_PASSWORD", "acs-platform-machine-account")
ORGANISATION = os.getenv("GITEA_ORGANISATION", "gateways")

# Differs from every other suite's fixture id in its FIRST block: sparkplug_id is the first 21 hex
# characters of the uuid, so ids that differ only at the end collide on the generated id.
TEST_GW_ID = "f0e9e000-0000-4000-8000-000000000001"
HEAD_COLUMNS = "forge_head_sha,forge_head_message,forge_head_by,forge_head_at,forge_head_flow_sha256"


def deliver(body, event="push", secret=WEBHOOK_SECRET, signed=True):
    """POST a delivery the way Gitea does: raw JSON bytes, the event name, the HMAC of the bytes."""
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    headers = {
        "apikey": ANON_KEY,
        "Authorization": f"Bearer {ANON_KEY}",
        "Content-Type": "application/json",
        "X-Gitea-Event": event,
        "X-Gitea-Delivery": "test",
    }
    if signed:
        headers["X-Gitea-Signature"] = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    req = urllib.request.Request(f"{SUPABASE_URL}/functions/v1/forge-events", method="POST", data=raw, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, json.loads(response.read().decode())
    except urllib.error.HTTPError as err:
        text = err.read().decode()
        return err.code, (json.loads(text) if text.strip() else None)


def push(sparkplug_id, ref="refs/heads/main", sha="a" * 40, owner=ORGANISATION, message="Merge pull request #1\n\nDetails.", repository=None):
    """A push payload in the shape Gitea sends (the fields this function reads, at least)."""
    return {
        "ref": ref,
        "before": "b" * 40,
        "after": sha,
        "repository": {
            "name": repository or f"gateway-{sparkplug_id}",
            "default_branch": "main",
            "owner": {"login": owner},
        },
        "head_commit": {
            "id": sha,
            "message": message,
            "timestamp": "2026-09-10T12:00:00Z",
            "committer": {"name": "Some Body", "email": "somebody@acs-cymru.local"},
        },
        "commits": [],
        "pusher": {"login": "a0000000-0000-0000-0000-000000000001", "email": "admin@acs-cymru.local"},
    }


def forge_as_machine(path, method="GET", body=None):
    credentials = base64.b64encode(f"{MACHINE_USER}:{MACHINE_PASSWORD}".encode()).decode()
    headers = {"Authorization": f"Basic {credentials}"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{FORGE_URL}{path}", method=method, headers=headers,
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            text = response.read().decode()
            return response.status, (json.loads(text) if text.strip() else None)
    except urllib.error.HTTPError as err:
        text = err.read().decode()
        return err.code, (json.loads(text) if text.strip() else None)


@unittest.skipIf(not SERVICE_ROLE_KEY or not ANON_KEY, "SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY must be set")
@unittest.skipIf(not WEBHOOK_SECRET, "GITEA_WEBHOOK_SECRET must be set to the value the edge runtime holds")
class ForgeEventsBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            rest("/gateways?limit=1")
        except Exception as err:  # noqa: BLE001 -- any failure here means "no stack"
            raise unittest.SkipTest(f"PostgREST is unreachable at {SUPABASE_URL}: {err}")
        rest(f"/gateways?id=eq.{TEST_GW_ID}", method="DELETE")
        status, rows = rest(
            "/gateways", method="POST", prefer="return=representation",
            body={"id": TEST_GW_ID, "name": "Test_Forge_Events", "status": "OFFLINE", "deployment": "remote"},
        )
        if status >= 300:
            raise unittest.SkipTest(f"could not create the test gateway: {rows}")
        cls.sparkplug_id = rows[0]["sparkplug_id"]

    @classmethod
    def tearDownClass(cls):
        rest(f"/gateways?id=eq.{TEST_GW_ID}", method="DELETE")

    def setUp(self):
        rest(f"/gateways?id=eq.{TEST_GW_ID}", method="PATCH", body={
            "forge_head_sha": None, "forge_head_message": None, "forge_head_by": None,
            "forge_head_at": None, "forge_head_flow_sha256": None,
        })

    def head(self):
        _, rows = rest(f"/gateways?id=eq.{TEST_GW_ID}&select={HEAD_COLUMNS}")
        return rows[0]


class TestTheSignature(ForgeEventsBase):
    def test_an_unsigned_delivery_is_refused(self):
        status, body = deliver(push(self.sparkplug_id), signed=False)
        self.assertEqual(status, 401, body)
        self.assertIsNone(self.head()["forge_head_sha"], "an unsigned delivery wrote to the gateway")

    def test_a_delivery_signed_with_the_wrong_secret_is_refused(self):
        status, body = deliver(push(self.sparkplug_id), secret="not-the-secret")
        self.assertEqual(status, 401, body)
        self.assertIsNone(self.head()["forge_head_sha"])

    def test_the_signature_is_over_the_bytes_sent(self):
        # Sign one body, send another: the same JSON with different whitespace is a different body.
        payload = push(self.sparkplug_id)
        signed_for = json.dumps(payload).encode()
        sent = json.dumps(payload, indent=2).encode()
        headers = {
            "apikey": ANON_KEY, "Authorization": f"Bearer {ANON_KEY}", "Content-Type": "application/json",
            "X-Gitea-Event": "push",
            "X-Gitea-Signature": hmac.new(WEBHOOK_SECRET.encode(), signed_for, hashlib.sha256).hexdigest(),
        }
        req = urllib.request.Request(f"{SUPABASE_URL}/functions/v1/forge-events", method="POST", data=sent, headers=headers)
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(req, timeout=30)
        self.assertEqual(caught.exception.code, 401)


class TestWhatIsRecorded(ForgeEventsBase):
    def test_a_push_to_main_lands_on_the_gateway(self):
        sha = "c0ffee" + "0" * 34
        status, body = deliver(push(self.sparkplug_id, sha=sha, message="Tighten the OPC UA poll\n\nBecause."))
        self.assertEqual(status, 200, body)
        self.assertEqual(body["recorded"]["sparkplug_id"], self.sparkplug_id)

        row = self.head()
        self.assertEqual(row["forge_head_sha"], sha)
        self.assertEqual(row["forge_head_message"], "Tighten the OPC UA poll", "not the first line of the message")
        self.assertEqual(row["forge_head_by"], "admin@acs-cymru.local")
        self.assertTrue(row["forge_head_at"].startswith("2026-09-10T12:00:00"), row["forge_head_at"])
        # No such repository in the forge, so no flows.json to hash: "not known", never "unchanged".
        self.assertIsNone(row["forge_head_flow_sha256"])

    def test_a_push_to_another_branch_is_ignored(self):
        status, body = deliver(push(self.sparkplug_id, ref="refs/heads/tighten-poll"))
        self.assertEqual(status, 200, body)
        self.assertIn("ignored", body)
        self.assertIsNone(self.head()["forge_head_sha"])

    def test_a_deleted_branch_is_ignored(self):
        status, body = deliver(push(self.sparkplug_id, sha="0" * 40))
        self.assertEqual(status, 200, body)
        self.assertIn("ignored", body)
        self.assertIsNone(self.head()["forge_head_sha"])

    def test_a_repository_that_is_not_a_gateways_is_ignored(self):
        for owner, name in ((ORGANISATION, "press-line-playbook"), ("somebody", f"gateway-{self.sparkplug_id}")):
            status, body = deliver(push(self.sparkplug_id, owner=owner, repository=name))
            self.assertEqual(status, 200, body)
            self.assertIn("ignored", body, (owner, name))
        self.assertIsNone(self.head()["forge_head_sha"])

    def test_a_gateway_this_database_does_not_know_is_ignored(self):
        status, body = deliver(push("gwy" + "f" * 21))
        self.assertEqual(status, 200, body)
        self.assertIn("ignored", body)

    def test_an_event_that_is_not_a_push_is_ignored(self):
        status, body = deliver(push(self.sparkplug_id), event="issues")
        self.assertEqual(status, 200, body)
        self.assertIn("ignored", body)
        self.assertIsNone(self.head()["forge_head_sha"])


class TestTheForgeItself(ForgeEventsBase):
    """
    THE WIRING, NOT THE FUNCTION. Enrolment registers the hook on the repository with the secret;
    Gitea's "test delivery" sends a real, signed push for the branch's real head over the forge
    network; and the gateway row ends up naming that head. Everything the other classes assert
    with a hand-built payload, this asserts with the forge's own.
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        status, _ = forge_as_machine("/api/v1/version")
        if status != 200:
            raise unittest.SkipTest(f"no forge reachable at {FORGE_URL} ({status})")
        try:
            cls.admin_token = sign_in()
        except Exception as err:  # noqa: BLE001
            raise unittest.SkipTest(f"could not sign in as the seeded administrator ({err})")
        cls.repo = f"gateway-{cls.sparkplug_id}"
        cls.delete_repo()

    @classmethod
    def tearDownClass(cls):
        cls.delete_repo()
        subprocess.run(
            ["docker", "exec", "acs-cymru_mosquitto", "sh", "-c",
             f"grep -v '^{cls.sparkplug_id}:' /mosquitto/config/password_file > /tmp/pf.$$ "
             f"&& cat /tmp/pf.$$ > /mosquitto/config/password_file && rm -f /tmp/pf.$$"],
            capture_output=True, text=True,
        )
        super().tearDownClass()

    @classmethod
    def delete_repo(cls):
        for owner in (ORGANISATION, MACHINE_USER):
            forge_as_machine(f"/api/v1/repos/{owner}/{cls.repo}", method="DELETE")

    def test_a_delivery_from_the_forge_records_the_real_head(self):
        key_dir = tempfile.mkdtemp(prefix="acs-forge-events-")
        try:
            key_path = os.path.join(key_dir, "id_ed25519")
            subprocess.run(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "test", "-f", key_path], check=True, capture_output=True)
            with open(f"{key_path}.pub", encoding="utf-8") as handle:
                public_key = handle.read().strip()
        finally:
            shutil.rmtree(key_dir, ignore_errors=True)

        _, rows = rest("/rpc/issue_gateway_enrollment_token", method="POST", key=ANON_KEY, bearer=self.admin_token,
                       body={"p_gateway_id": TEST_GW_ID, "p_ttl_minutes": 30})
        status, payload = enroll(rows[0]["token"], ssh_public_key=public_key)
        self.assertEqual(status, 200, payload)
        self.assertIsNotNone(payload.get("repository"), payload)

        # The hook enrolment registered, pointing where the edge runtime listens.
        status, hooks = forge_as_machine(f"/api/v1/repos/{ORGANISATION}/{self.repo}/hooks")
        self.assertEqual(status, 200, hooks)
        ours = [h for h in hooks if h["config"]["url"].endswith("/forge-events")]
        self.assertEqual(len(ours), 1, f"expected exactly one forge-events hook, found {hooks}")
        self.assertIn("push", ours[0]["events"])
        self.assertTrue(ours[0]["active"])

        status, branch = forge_as_machine(f"/api/v1/repos/{ORGANISATION}/{self.repo}/branches/main")
        self.assertEqual(status, 200, branch)
        real_head = branch["commit"]["id"]

        # Gitea's own test delivery: a real push payload for the default branch's head, signed with
        # the hook's secret, delivered over the forge network.
        status, _ = forge_as_machine(f"/api/v1/repos/{ORGANISATION}/{self.repo}/hooks/{ours[0]['id']}/tests", method="POST")
        self.assertEqual(status, 204)

        deadline = time.time() + 20
        row = self.head()
        while row["forge_head_sha"] != real_head and time.time() < deadline:
            time.sleep(1)
            row = self.head()
        self.assertEqual(row["forge_head_sha"], real_head, f"the forge's delivery did not land: {row}")
        self.assertIsNotNone(row["forge_head_at"])
        # A fresh repository carries a README and the incident template, and no flows.json yet.
        self.assertIsNone(row["forge_head_flow_sha256"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
