"""
Integration tests for the propose-gateway-flow edge function.

WHAT THIS FUNCTION IS FOR, AND WHAT THE TESTS ARE ACTUALLY GUARDING. Roadmap 7 turns a flow upload
into a COMMIT: a branch in the gateway's own repository with a pull request open against it, so that
"pending approval", "approved" and "undo" are the forge's own states rather than a second workflow
modelled beside a stored blob.

Three properties would fail silently and are therefore asserted rather than eyeballed:

  * `main` MUST NOT MOVE. The appliance converges to whatever `main` holds, so a proposal that
    committed there directly would deploy an unreviewed flow -- the `deploy-nodered` endpoint this
    item retired, rebuilt with a friendlier name. Nothing about a successful-looking response would
    reveal it.
  * `flows_cred.json` MUST BE REFUSED, by shape rather than by filename. Both files sit side by side
    in /data, the credential file is encrypted with a secret that exists only on the appliance, and a
    repository keeps forever what a bucket would let you delete.
  * PROPOSING AND APPROVING ARE DIFFERENT PRIVILEGES. An `Operator` may propose -- that is the whole
    point of the review step -- and nothing this endpoint does may merge.

Requires the stack up, a forge, and the seeded accounts:

    SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_ANON_KEY=... python \
        supabase/functions/propose-gateway-flow/test_propose_gateway_flow.py
"""
import base64
import json
import os
import shutil
import subprocess
import tempfile
import unittest
import urllib.error
import urllib.request

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

FORGE_URL = os.getenv("GITEA_TEST_URL", "http://127.0.0.1:3003")
MACHINE_USER = os.getenv("GITEA_MACHINE_USER", "acs_platform")
MACHINE_PASSWORD = os.getenv("GITEA_MACHINE_PASSWORD", "acs-platform-machine-account")

# Its own gateway rows, and they DIFFER IN THE FIRST BLOCK ON PURPOSE.
#
# `sparkplug_id` is generated from the leading 21 hex characters of the UUID, so the final block is
# not read at all: two fixtures differing only there generate the SAME wire identity and the second
# INSERT fails with a unique violation -- a 409 from PostgREST, thrown from setUp, that says nothing
# about identifiers. Both ids here are also distinct from the 2c/2b/2d blocks the enrolment and
# bundle suites pin, because all of these run against one database.
TEST_GW_ID = "2df10000-0000-4000-8000-000000000001"
NO_REPO_GW_ID = "2df20000-0000-4000-8000-000000000001"

ACCOUNTS = {
    "Administrator": "admin@acs-cymru.local",
    "Operator": "operator@acs-cymru.local",
    "Auditor": "auditor@acs-cymru.local",
}
PASSWORD = os.getenv("ACS_DEMO_PASSWORD", "acscymru123")

A_FLOW = [
    {"id": "tab1", "type": "tab", "label": "Proposed"},
    {"id": "inject1", "type": "inject", "z": "tab1", "name": "tick", "wires": []},
]
# What flows_cred.json looks like once decrypted: an object map whose values carry no `type`.
A_CREDENTIAL_FILE = [{"broker": {"user": "gw", "password": "hunter2"}}]


def rest(path, method="GET", body=None, key=None, bearer=None, prefer=None):
    key = key or SERVICE_ROLE_KEY
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1{path}",
        method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {bearer or key}",
            "Content-Type": "application/json",
            "X-ACS-Cymru-Actor": "service",
            **({"Prefer": prefer} if prefer else {}),
        },
    )
    with urllib.request.urlopen(req, timeout=15) as response:
        raw = response.read().decode()
        return response.status, (json.loads(raw) if raw.strip() else None)


def sign_in(email, password=PASSWORD):
    req = urllib.request.Request(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        method="POST",
        data=json.dumps({"email": email, "password": password}).encode(),
        headers={"apikey": ANON_KEY, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.loads(response.read().decode())["access_token"]


def propose(gateway_id, flow, bearer):
    """Call the function the way the dashboard does: the anon key plus a user's access token."""
    req = urllib.request.Request(
        f"{SUPABASE_URL}/functions/v1/propose-gateway-flow",
        method="POST",
        data=json.dumps({"gateway_id": gateway_id, "flow": flow}).encode(),
        headers={
            "apikey": ANON_KEY,
            "Authorization": f"Bearer {bearer}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.status, json.loads(response.read().decode())
    except urllib.error.HTTPError as err:
        raw = err.read().decode()
        return err.code, (json.loads(raw) if raw.strip() else None)


def forge(path, method="GET"):
    credentials = base64.b64encode(f"{MACHINE_USER}:{MACHINE_PASSWORD}".encode()).decode()
    req = urllib.request.Request(
        f"{FORGE_URL}{path}", method=method, headers={"Authorization": f"Basic {credentials}"}
    )
    with urllib.request.urlopen(req, timeout=15) as response:
        raw = response.read().decode()
        return json.loads(raw) if raw.strip() else None


@unittest.skipIf(not SERVICE_ROLE_KEY or not ANON_KEY,
                 "SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY must be set")
class ProposeFlowBase(unittest.TestCase):
    """
    A physical gateway that has ENROLLED, because enrolment is what creates its repository.

    Performed here rather than mocked: the repository name is derived from the `sparkplug_id` in
    _shared/forge.ts and shared by both functions precisely so the two cannot disagree, and a test
    that created the repository by hand would stop checking that.
    """

    @classmethod
    def setUpClass(cls):
        try:
            rest("/gateways?limit=1")
        except Exception as err:  # noqa: BLE001 -- any failure here means "no stack"
            raise unittest.SkipTest(f"PostgREST is unreachable at {SUPABASE_URL}: {err}")
        try:
            forge("/api/v1/version")
        except Exception as err:  # noqa: BLE001 -- any failure here means "no forge"
            raise unittest.SkipTest(f"no forge reachable at {FORGE_URL}: {err}")

        rest(f"/gateways?id=eq.{TEST_GW_ID}", method="DELETE")
        status, rows = rest(
            "/gateways", method="POST", prefer="return=representation",
            body={
                "id": TEST_GW_ID,
                "name": "Test_Flow_Proposal",
                "status": "OFFLINE",
                "deployment": "remote",
            },
        )
        if status >= 300:
            raise unittest.SkipTest(f"could not create the test gateway: {rows}")
        cls.sparkplug_id = rows[0]["sparkplug_id"]
        cls.repo = f"gateway-{cls.sparkplug_id}"

        try:
            cls.tokens = {role: sign_in(email) for role, email in ACCOUNTS.items()}
        except Exception as err:  # noqa: BLE001
            raise unittest.SkipTest(f"could not sign in as a seeded account ({err})")

        cls.key_dir = tempfile.mkdtemp(prefix="acs-propose-")
        key = os.path.join(cls.key_dir, "id_ed25519")
        subprocess.run(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "test", "-f", key],
                       check=True, capture_output=True)
        with open(f"{key}.pub", encoding="utf-8") as handle:
            public_key = handle.read().strip()

        _, minted = rest(
            "/rpc/issue_gateway_enrollment_token", method="POST",
            key=ANON_KEY, bearer=cls.tokens["Administrator"],
            body={"p_gateway_id": TEST_GW_ID, "p_ttl_minutes": 30},
        )
        enrol = urllib.request.Request(
            f"{SUPABASE_URL}/functions/v1/enroll-gateway", method="POST",
            data=json.dumps({"token": minted[0]["token"], "ssh_public_key": public_key}).encode(),
            headers={"apikey": ANON_KEY, "Authorization": f"Bearer {ANON_KEY}",
                     "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(enrol, timeout=30) as response:
            payload = json.loads(response.read().decode())
        if not payload.get("repository"):
            raise unittest.SkipTest("enrolment produced no repository -- is the forge configured?")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(getattr(cls, "key_dir", ""), ignore_errors=True)
        try:
            forge(f"/api/v1/repos/{MACHINE_USER}/{cls.repo}", method="DELETE")
        except urllib.error.HTTPError:
            pass
        rest(f"/gateways?id=eq.{TEST_GW_ID}", method="DELETE")
        # The broker account outlives the row, so it is removed explicitly or it accumulates.
        subprocess.run(
            ["docker", "exec", "acs-cymru_mosquitto", "sh", "-c",
             f"grep -v '^{cls.sparkplug_id}:' /mosquitto/config/password_file > /tmp/pf.$$ "
             f"&& cat /tmp/pf.$$ > /mosquitto/config/password_file && rm -f /tmp/pf.$$"],
            capture_output=True, text=True,
        )

    def branches(self):
        return [b["name"] for b in forge(f"/api/v1/repos/{MACHINE_USER}/{self.repo}/branches")]

    def main_commit(self):
        return forge(f"/api/v1/repos/{MACHINE_USER}/{self.repo}/branches/main")["commit"]["id"]


class TestProposal(ProposeFlowBase):
    def test_a_proposal_is_a_branch_and_a_pull_request_and_main_does_not_move(self):
        """
        THE ASSERTION THAT MAKES THE REST MEANINGFUL. Everything else here could pass against a
        function that committed straight to `main` -- and the appliance converges to `main`, so that
        function would deploy an unreviewed flow while reporting success.
        """
        before = self.main_commit()

        status, payload = propose(TEST_GW_ID, A_FLOW, self.tokens["Administrator"])
        self.assertEqual(status, 201, payload)

        pull = payload["pull_request"]
        self.assertTrue(pull["branch"].startswith("proposal/"), pull)
        self.assertIn(pull["branch"], self.branches())
        self.assertEqual(
            before, self.main_commit(),
            "main moved -- a proposal deployed itself without anybody approving it",
        )

        opened = forge(f"/api/v1/repos/{MACHINE_USER}/{self.repo}/pulls/{pull['number']}")
        self.assertEqual(opened["state"], "open")
        self.assertEqual(opened["base"]["ref"], "main")
        self.assertEqual(opened["head"]["ref"], pull["branch"])

    def test_the_proposer_is_named_in_the_pull_request(self):
        """
        The forge cannot know who proposed: every write is made by ONE machine account, and shopfloor
        people deliberately hold no login. Without the name in the body the trail says only that the
        platform committed something. Same decision as 0089 in the approvals queue.
        """
        status, payload = propose(TEST_GW_ID, A_FLOW, self.tokens["Operator"])
        self.assertEqual(status, 201, payload)

        opened = forge(
            f"/api/v1/repos/{MACHINE_USER}/{self.repo}/pulls/{payload['pull_request']['number']}"
        )
        self.assertIn(ACCOUNTS["Operator"], opened["body"])

    def test_an_auditor_may_not_propose(self):
        status, payload = propose(TEST_GW_ID, A_FLOW, self.tokens["Auditor"])
        self.assertEqual(status, 403, payload)

    def test_an_unauthenticated_caller_may_not_propose(self):
        status, payload = propose(TEST_GW_ID, A_FLOW, ANON_KEY)
        self.assertIn(status, (401, 403), payload)


class TestRefusals(ProposeFlowBase):
    def test_a_credentials_file_is_refused_and_no_branch_is_created(self):
        before = set(self.branches())

        status, payload = propose(TEST_GW_ID, A_CREDENTIAL_FILE, self.tokens["Administrator"])

        self.assertEqual(status, 400, payload)
        self.assertIn("flows_cred", payload["details"])
        self.assertEqual(before, set(self.branches()), "a refused proposal still created a branch")

    def test_something_that_is_not_an_array_is_refused(self):
        status, payload = propose(TEST_GW_ID, {"flows": []}, self.tokens["Administrator"])
        self.assertEqual(status, 400, payload)

    def test_a_gateway_with_no_repository_answers_409(self):
        """
        A virtual gateway, or a physical one whose bundle predates the forge. Telling that apart from
        a broken forge is the difference between "re-enrol this appliance" and "page somebody".
        """
        other = NO_REPO_GW_ID
        rest(f"/gateways?id=eq.{other}", method="DELETE")
        rest("/gateways", method="POST",
             body={"id": other, "name": "Test_Flow_No_Repo", "status": "OFFLINE",
                   "deployment": "remote"})
        try:
            status, payload = propose(other, A_FLOW, self.tokens["Administrator"])
            self.assertEqual(status, 409, payload)
            self.assertIn("no repository", payload["error"].lower())
        finally:
            rest(f"/gateways?id=eq.{other}", method="DELETE")


if __name__ == "__main__":
    unittest.main(verbosity=2)
