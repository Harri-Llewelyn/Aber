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

The last class acts as the appliance: it enrols with a key it generated, clones the repository over
SSH with that key, and pushes what it is running to `appliance` the way flow-sync.mjs does, then
asserts that the forge delivered that push and the row records it, that `main` refused the same
key, and that a force-push to `appliance` was refused. It needs GITEA_TEST_SSH, the forge's SSH
address as reachable from this host (`ssh://git@127.0.0.1:2222` behind the dev loop's forward).

Needs the stack, the forge, and GITEA_WEBHOOK_SECRET (the value the edge runtime holds; read it from
.env). Skips without them.

    SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... GITEA_WEBHOOK_SECRET=... \\
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
from test_enroll_gateway import (  # noqa: E402
    PUBLISHABLE_KEY, SERVICE_ROLE_KEY, SUPABASE_URL, delete_broker_account, enroll, rest,
    sign_in, skip_or_fail,
)

WEBHOOK_SECRET = os.getenv("GITEA_WEBHOOK_SECRET", "")
FORGE_URL = os.getenv("GITEA_TEST_URL", "http://127.0.0.1:3003")
FORGE_SSH = os.getenv("GITEA_TEST_SSH", "")
MACHINE_USER = os.getenv("GITEA_MACHINE_USER", "acs_platform")
MACHINE_PASSWORD = os.getenv("GITEA_MACHINE_PASSWORD", "acs-platform-machine-account")
ORGANISATION = os.getenv("GITEA_ORGANISATION", "gateways")

# Differs from every other suite's fixture id in its FIRST block: sparkplug_id is the first 21 hex
# characters of the uuid, so ids that differ only at the end collide on the generated id.
TEST_GW_ID = "f0e9e000-0000-4000-8000-000000000001"
HEAD_COLUMNS = ("forge_head_sha,forge_head_message,forge_head_by,forge_head_at,forge_head_flow_sha256,"
                "forge_appliance_sha,forge_appliance_at,forge_appliance_flow_sha256,"
                # 0106: what converged.json on the appliance branch said.
                "forge_appliance_platform_tag,forge_appliance_platform_outcome,"
                "forge_appliance_converged_at,forge_appliance_custom_outcome,"
                "forge_appliance_custom_revision")


def deliver(body, event="push", secret=WEBHOOK_SECRET, signed=True):
    """POST a delivery the way Gitea does: raw JSON bytes, the event name, the HMAC of the bytes."""
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    headers = {
        "apikey": PUBLISHABLE_KEY,
        "Authorization": f"Bearer {PUBLISHABLE_KEY}",
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


@unittest.skipIf(not SERVICE_ROLE_KEY or not PUBLISHABLE_KEY, "SUPABASE_SERVICE_ROLE_KEY and SUPABASE_PUBLISHABLE_KEY must be set")
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
            "forge_appliance_sha": None, "forge_appliance_at": None, "forge_appliance_flow_sha256": None,
            "forge_appliance_platform_tag": None, "forge_appliance_platform_outcome": None,
            "forge_appliance_converged_at": None, "forge_appliance_custom_outcome": None,
            "forge_appliance_custom_revision": None,
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
            "apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {PUBLISHABLE_KEY}", "Content-Type": "application/json",
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

    def test_a_push_to_the_appliance_branch_lands_beside_main_and_names_nobody(self):
        status, body = deliver(push(self.sparkplug_id, ref="refs/heads/appliance", sha="d" * 40))
        self.assertEqual(status, 200, body)
        self.assertEqual(body["recorded"]["branch"], "appliance", body)
        row = self.head()
        self.assertEqual(row["forge_appliance_sha"], "d" * 40)
        self.assertEqual(row["forge_appliance_at"], "2026-09-10T12:00:00+00:00")
        # The head of main is untouched: the two branches are two columns.
        self.assertIsNone(row["forge_head_sha"])
        self.assertIsNone(row["forge_head_by"])
        # No such repository in the forge, so no converged.json to read (0106). Absent is nulls,
        # never a failed delivery: a non-2xx is what Gitea records as a failed hook, and the flow
        # half of this push landed.
        self.assertIsNone(row["forge_appliance_platform_tag"])
        self.assertIsNone(row["forge_appliance_platform_outcome"])
        self.assertIsNone(row["forge_appliance_custom_outcome"])

    def test_a_push_to_another_branch_is_checked_and_records_nothing(self):
        """
        A proposal branch is no longer ignored: its flows.json is checked and the status main
        requires is posted (TestAProposal covers what the check answers, against a real
        repository). What must still hold here is that NOTHING on the gateway row moves for it --
        main and appliance are the two branches it records.
        """
        status, body = deliver(push(self.sparkplug_id, ref="refs/heads/tighten-poll"))
        self.assertEqual(status, 200, body)
        self.assertIn("checked", body)
        self.assertEqual(body["checked"]["context"], "acs/flow-shape", body)
        self.assertIsNone(self.head()["forge_head_sha"])
        self.assertIsNone(self.head()["forge_appliance_sha"])

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
            skip_or_fail(f"no forge reachable at {FORGE_URL} ({status})")
        try:
            cls.admin_token = sign_in()
        except Exception as err:  # noqa: BLE001
            skip_or_fail(f"could not sign in as the seeded administrator ({err})")
        cls.repo = f"gateway-{cls.sparkplug_id}"
        cls.delete_repo()

    @classmethod
    def tearDownClass(cls):
        cls.delete_repo()
        # The broker account outlives the row; deleted through the service's admin credential.
        delete_broker_account(cls.sparkplug_id)
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

        _, rows = rest("/rpc/issue_gateway_enrollment_token", method="POST", bearer=self.admin_token,
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


class TestAProposal(ForgeEventsBase):
    """
    THE CHECK THAT RUNS BEFORE A MERGE. A flows.json uploaded through the forge's own UI met no
    check until the appliance refused it, which is after an administrator had approved it. Now a
    push to any branch but main and appliance is delivered here, the file at that commit is read,
    and the `acs/flow-shape` status main requires is posted -- so a credential file or a mangled
    export cannot be merged in the first place.

    THE REPOSITORY IS MADE BY HAND AND NOT ENROLLED, which is what makes the proposals possible.
    An enrolled repository's `**` rule admits the two dashboard teams and nobody else, so neither
    the machine account nor a deploy key can push a proposal branch -- a proposal is a person's
    act, through the forge's door, and that policy is asserted where it belongs, in
    TestTheApplianceItself. Here the commits are made directly and the push is delivered signed,
    which exercises the one thing this class is about: read the file, decide, post the status.
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        status, _ = forge_as_machine("/api/v1/version")
        if status != 200:
            skip_or_fail(f"no forge reachable at {FORGE_URL} ({status})")
        cls.repo = f"gateway-{cls.sparkplug_id}"
        forge_as_machine(f"/api/v1/repos/{ORGANISATION}/{cls.repo}", method="DELETE")
        status, made = forge_as_machine(f"/api/v1/orgs/{ORGANISATION}/repos", method="POST", body={
            "name": cls.repo, "private": True, "auto_init": True, "default_branch": "main",
        })
        if status != 201:
            skip_or_fail(f"could not create a repository to propose against: {made}")

    @classmethod
    def tearDownClass(cls):
        forge_as_machine(f"/api/v1/repos/{ORGANISATION}/{cls.repo}", method="DELETE")
        super().tearDownClass()

    def propose(self, branch, content):
        """A commit on a new branch, as a person uploading a file in the forge would make."""
        status, made = forge_as_machine(
            f"/api/v1/repos/{ORGANISATION}/{self.repo}/contents/flows.json", method="POST", body={
                "content": base64.b64encode(content.encode()).decode(),
                "message": f"propose {branch}", "branch": "main", "new_branch": branch,
            })
        self.assertEqual(status, 201, f"the proposal commit was not made: {made}")
        # THE COMMIT's sha, never the blob's: the contents response carries both, and Gitea answers
        # 500 to a status posted against a blob (measured against gitea/gitea:1.27.3).
        status, head = forge_as_machine(f"/api/v1/repos/{ORGANISATION}/{self.repo}/branches/{branch}")
        self.assertEqual(status, 200, head)
        sha = head["commit"]["id"]
        # Signed, as the hook delivers it. The hook itself is registered by enrolment and its
        # filter is asserted in test_forge_sweep; what is exercised here is the handler.
        status, body = deliver(push(self.sparkplug_id, ref=f"refs/heads/{branch}", sha=sha))
        self.assertEqual(status, 200, body)
        return sha, body

    def flow_shape(self, sha):
        """The acs/flow-shape status on a commit, or None if none was posted."""
        status, listed = forge_as_machine(f"/api/v1/repos/{ORGANISATION}/{self.repo}/statuses/{sha}")
        self.assertEqual(status, 200, listed)
        ours = [st for st in listed if st.get("context") == "acs/flow-shape"]
        return ours[0] if ours else None

    def test_a_well_formed_flow_is_marked_successful(self):
        sha, body = self.propose("tighten-poll", '[{"id":"acs-broker","type":"mqtt-broker"}]')
        self.assertEqual(body["checked"]["state"], "success", body)
        self.assertEqual(body["checked"]["context"], "acs/flow-shape", body)
        state = self.flow_shape(sha)
        self.assertIsNotNone(state, "no acs/flow-shape status reached the forge")
        self.assertEqual(state["status"], "success", state)
        # A proposal is not what the appliance deploys, so the row does not move for it.
        self.assertIsNone(self.head()["forge_head_sha"], "a proposal branch moved the gateway row")

    def test_a_credential_file_proposed_as_a_flow_is_refused(self):
        """
        THE ONE THIS EXISTS FOR. flows_cred.json is a map of node id to encrypted credential;
        deployed as a flow it hands the broker node an empty username, the gateway is refused with
        CONNACK 5 with nothing said about why, and the next deploy prunes the ciphertext the
        appliance still holds. The appliance refuses it; now so does the forge, before the merge.
        """
        # The file as Node-RED writes it is a MAP of node id to ciphertext, so it fails the first
        # check: a flow export is an array and this is not one.
        sha, body = self.propose("paste-the-wrong-file", '{"acs-broker":{"user":"x","password":"y"}}')
        self.assertEqual(body["checked"]["state"], "failure", body)
        state = self.flow_shape(sha)
        self.assertIsNotNone(state, "no acs/flow-shape status reached the forge")
        self.assertEqual(state["status"], "failure", state)
        self.assertIn("array", state["description"], state)

        # And the shape that reaches the SECOND check: an array whose every entry is an object
        # with no `type`, which is what a credential file looks like once somebody has wrapped it.
        sha, body = self.propose("wrapped-credentials", '[{"user":"x"},{"user":"y"}]')
        self.assertEqual(body["checked"]["state"], "failure", body)
        self.assertIn("flows_cred", self.flow_shape(sha)["description"])

    def test_a_flow_that_is_not_json_is_refused(self):
        sha, body = self.propose("half-an-export", '[{"id":"a",')
        self.assertEqual(body["checked"]["state"], "failure", body)
        self.assertEqual(self.flow_shape(sha)["status"], "failure")

    def test_a_proposal_that_adds_no_flow_passes(self):
        """
        A repository whose main carries no flows.json yet is the ordinary state of one enrolment
        just created, and a proposal touching something else is not a flow change. Refusing those
        would block every first pull request a gateway ever gets.
        """
        status, _ = forge_as_machine(
            f"/api/v1/repos/{ORGANISATION}/{self.repo}/contents/NOTES.md", method="POST", body={
                "content": base64.b64encode(b"notes").decode(), "message": "notes",
                "branch": "main", "new_branch": "just-notes",
            })
        self.assertEqual(status, 201)
        _, head = forge_as_machine(f"/api/v1/repos/{ORGANISATION}/{self.repo}/branches/just-notes")
        sha = head["commit"]["id"]
        status, body = deliver(push(self.sparkplug_id, ref="refs/heads/just-notes", sha=sha))
        self.assertEqual(status, 200, body)
        self.assertEqual(body["checked"]["state"], "success", body)
        self.assertEqual(self.flow_shape(sha)["status"], "success")


@unittest.skipIf(not FORGE_SSH, "GITEA_TEST_SSH must name the forge's SSH address as reachable from this host")
class TestTheApplianceItself(ForgeEventsBase):
    """
    THE APPLIANCE'S HALF, END TO END. Enrolment registers the key it generated as read-write on
    its own repository and puts three rules on it; this pushes with that key the way flow-sync.mjs
    does and lets the forge's own hook deliver the push. What is asserted is the policy those
    rules are for: `appliance` takes the push and the row records it, `main` refuses the same key,
    a branch outside the two refuses it, and a rewritten `appliance` is refused.
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        status, _ = forge_as_machine("/api/v1/version")
        if status != 200:
            skip_or_fail(f"no forge reachable at {FORGE_URL} ({status})")
        try:
            cls.admin_token = sign_in()
        except Exception as err:  # noqa: BLE001
            skip_or_fail(f"could not sign in as the seeded administrator ({err})")
        cls.repo = f"gateway-{cls.sparkplug_id}"
        cls.delete_repo()
        cls.work = tempfile.mkdtemp(prefix="acs-appliance-")

    @classmethod
    def tearDownClass(cls):
        cls.delete_repo()
        delete_broker_account(cls.sparkplug_id)
        shutil.rmtree(cls.work, ignore_errors=True)
        super().tearDownClass()

    @classmethod
    def delete_repo(cls):
        for owner in (ORGANISATION, MACHINE_USER):
            forge_as_machine(f"/api/v1/repos/{owner}/{cls.repo}", method="DELETE")

    def git(self, *args, cwd=None):
        env = {
            **os.environ,
            "GIT_SSH_COMMAND": f'ssh -i "{self.key}" -o IdentitiesOnly=yes -o UserKnownHostsFile="{self.known_hosts}" '
                               "-o StrictHostKeyChecking=no -o BatchMode=yes",
            "GIT_TERMINAL_PROMPT": "0",
        }
        result = subprocess.run(["git", *args], cwd=cwd or self.clone, env=env, capture_output=True, text=True)
        return result.returncode, (result.stdout + result.stderr).strip()

    def commit(self, message, cwd=None):
        code, out = self.git("-c", f"user.name=gateway {self.sparkplug_id}", "-c", "user.email=appliance@acs-cymru.invalid",
                             "commit", "--quiet", "-m", message, cwd=cwd)
        self.assertEqual(code, 0, out)

    def test_the_appliance_reports_on_its_branch_and_nowhere_else(self):
        self.key = os.path.join(self.work, "id_ed25519")
        self.known_hosts = os.path.join(self.work, "known_hosts")
        subprocess.run(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "test", "-f", self.key], check=True, capture_output=True)
        with open(f"{self.key}.pub", encoding="utf-8") as handle:
            public_key = handle.read().strip()

        _, rows = rest("/rpc/issue_gateway_enrollment_token", method="POST", bearer=self.admin_token,
                       body={"p_gateway_id": TEST_GW_ID, "p_ttl_minutes": 30})
        status, payload = enroll(rows[0]["token"], ssh_public_key=public_key)
        self.assertEqual(status, 200, payload)
        self.assertIsNotNone(payload.get("repository"), payload)

        # What enrolment put on the repository: the key, read-write, and the three rules.
        status, keys = forge_as_machine(f"/api/v1/repos/{ORGANISATION}/{self.repo}/keys")
        self.assertEqual(status, 200, keys)
        self.assertEqual([k["read_only"] for k in keys], [False], keys)
        status, rules = forge_as_machine(f"/api/v1/repos/{ORGANISATION}/{self.repo}/branch_protections")
        self.assertEqual(status, 200, rules)
        by_name = {r["rule_name"]: r for r in rules}
        self.assertEqual(set(by_name), {"main", "appliance", "**"}, by_name.keys())
        self.assertFalse(by_name["main"]["enable_push"])
        self.assertFalse(by_name["main"]["push_whitelist_deploy_keys"])
        self.assertTrue(by_name["appliance"]["push_whitelist_deploy_keys"])
        self.assertFalse(by_name["appliance"]["enable_force_push"])
        self.assertFalse(by_name["**"]["push_whitelist_deploy_keys"])
        self.assertLess(by_name["appliance"]["priority"], by_name["**"]["priority"], "the catch-all must come after the named rule")
        # A PROPOSAL IS A PERSON'S ACT. The catch-all admits the two dashboard teams and nobody
        # else, so neither a deploy key nor the machine account can push a proposal branch.
        self.assertEqual(sorted(by_name["**"]["push_whitelist_teams"]),
                         ["administrators", "managers"], by_name["**"])
        # And main requires the shape check forge-events posts, so a flows.json the appliance
        # would refuse cannot be merged. Measured: a merge is refused 405 with no such status and
        # with a failing one, and succeeds on success.
        self.assertTrue(by_name["main"]["enable_status_check"], by_name["main"])
        self.assertIn("acs/flow-shape", by_name["main"]["status_check_contexts"], by_name["main"])

        # The clone URL names the forge's own address (scp-like when SSH is on 22); from this host
        # the forward answers, for the same repository.
        self.assertIn(f"{ORGANISATION}/{self.repo}", payload["repository"]["ssh_url"])
        url = f"{FORGE_SSH.rstrip('/')}/{ORGANISATION}/{self.repo}.git"
        self.clone = os.path.join(self.work, "repo")
        code, out = self.git("clone", "--quiet", "--branch", "main", "--single-branch", url, self.clone, cwd=self.work)
        self.assertEqual(code, 0, out)

        # As flow-sync.mjs does: the report branch from the root commit, the allowlist, a push.
        root = self.git("rev-list", "--max-parents=0", "HEAD")[1].splitlines()[0]
        self.assertEqual(self.git("checkout", "--quiet", "-B", "appliance", root)[0], 0)
        flow = '[{"id":"acs-broker","type":"mqtt-broker"}]\n'
        with open(os.path.join(self.clone, "flows.json"), "w", encoding="utf-8") as handle:
            handle.write(flow)
        with open(os.path.join(self.clone, "deployed.json"), "w", encoding="utf-8") as handle:
            handle.write('{"revision":null,"source":"enrolment"}\n')
        # The third file on the allowlist (0106): what acs-gateway-converge recorded,
        # including a custom.yml that FAILED, which is the state the Custom row exists for.
        converged = {
            "outcome": "converged", "tag": "v9.9.9", "detail": "ansible-pull succeeded",
            "converged_at": "2026-09-14T10:11:12Z",
            "custom": {"outcome": "failed", "revision": "a" * 40,
                       "detail": "custom.yml exited 2", "ran_at": "2026-09-14T10:11:20Z"},
        }
        with open(os.path.join(self.clone, "converged.json"), "w", encoding="utf-8") as handle:
            handle.write(json.dumps(converged))
        self.git("add", "--", "flows.json", "deployed.json", "converged.json")
        self.commit("Report: running from enrolment")
        code, out = self.git("push", "--quiet", "origin", "appliance:appliance")
        self.assertEqual(code, 0, f"the deploy key could not push the appliance branch: {out}")
        pushed = self.git("rev-parse", "HEAD")[1]

        # The forge delivered it, signed, and the row records the head and the flow's digest.
        deadline = time.time() + 20
        row = self.head()
        while row["forge_appliance_sha"] != pushed and time.time() < deadline:
            time.sleep(1)
            row = self.head()
        self.assertEqual(row["forge_appliance_sha"], pushed, f"the appliance push did not land: {row}")
        self.assertEqual(row["forge_appliance_flow_sha256"], hashlib.sha256(flow.encode()).hexdigest())
        # Read out of converged.json at that same commit, through the machine account
        # (0106). The platform half and the custom half are separate columns, so a failing
        # adapter on a gateway whose platform converged reads as exactly that.
        self.assertEqual(row["forge_appliance_platform_tag"], "v9.9.9")
        self.assertEqual(row["forge_appliance_platform_outcome"], "converged")
        self.assertTrue(row["forge_appliance_converged_at"].startswith("2026-09-14T10:11:12"),
                        row["forge_appliance_converged_at"])
        self.assertEqual(row["forge_appliance_custom_outcome"], "failed")
        self.assertEqual(row["forge_appliance_custom_revision"], "a" * 40)
        # Not None: Gitea resolves a push's hooks when it processes the queued push, so the incident
        # template committed a moment before the hook existed is delivered too, and main's head is
        # filled at enrolment (measured). What must hold is that the appliance push is not it.
        self.assertNotEqual(row["forge_head_sha"], pushed, "a push to appliance must not be recorded as main")

        # The same key on main, with a commit that IS a fast-forward of it, so the refusal can only
        # be the rule's and not git's.
        self.assertEqual(self.git("checkout", "--quiet", "main")[0], 0)
        with open(os.path.join(self.clone, "flows.json"), "w", encoding="utf-8") as handle:
            handle.write(flow)
        self.git("add", "--", "flows.json")
        self.commit("Deploy myself")
        code, out = self.git("push", "--quiet", "origin", "main:main")
        self.assertNotEqual(code, 0, "the deploy key pushed to main")
        self.assertIn("protected branch", out)

        # A branch outside the two: the catch-all, and a slash in the name does not slip past it.
        for other in ("proposal", "feature/x"):
            code, out = self.git("push", "--quiet", "origin", f"main:{other}")
            self.assertNotEqual(code, 0, f"the deploy key pushed to '{other}'")
            self.assertIn("protected branch", out)

        # The platform repository: the same key reads it and cannot write it.
        platform_url = payload["repository"].get("platform_ssh_url")
        if platform_url:
            self.assertIn("/platform/gateway-platform", platform_url.replace(":", "/"))
            self.assertRegex(payload["repository"]["platform_tag"], r"^v\d+\.\d+\.\d+")
            platform_clone = os.path.join(self.work, "platform")
            code, out = self.git("clone", "--quiet", f"{FORGE_SSH.rstrip('/')}/platform/gateway-platform.git", platform_clone, cwd=self.work)
            self.assertEqual(code, 0, f"the deploy key could not read the platform repository: {out}")
            self.assertTrue(os.path.exists(os.path.join(platform_clone, "site.yml")), "the platform repository holds no playbook")
            with open(os.path.join(platform_clone, "site.yml"), "a", encoding="utf-8") as handle:
                handle.write("# from an appliance\n")
            self.git("add", "--", "site.yml", cwd=platform_clone)
            self.commit("Widen myself", cwd=platform_clone)
            code, out = self.git("push", "--quiet", "origin", "HEAD:main", cwd=platform_clone)
            self.assertNotEqual(code, 0, "the deploy key wrote the platform repository")
            self.assertIn("not authorized to write", out)

        # A rewritten appliance branch: append-only means a force-push is refused.
        self.assertEqual(self.git("checkout", "--quiet", "appliance")[0], 0)
        self.git("-c", f"user.name=gateway {self.sparkplug_id}", "-c", "user.email=appliance@acs-cymru.invalid",
                 "commit", "--quiet", "--amend", "-m", "Rewritten")
        code, out = self.git("push", "--quiet", "--force", "origin", "appliance:appliance")
        self.assertNotEqual(code, 0, "the appliance branch took a force-push")
        self.assertIn("force push", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
