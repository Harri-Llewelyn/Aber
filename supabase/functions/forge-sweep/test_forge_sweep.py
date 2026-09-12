"""
The forge sweep (0099), against the live stack.

WHAT IS UNDER TEST. forge-sweep is a POST behind Envoy's key-auth whose only authentication is a
shared secret, and whose effect is to reconcile the forge with user_roles and to furnish the
organisation's repositories. So, in order of what would be worst to get wrong: a call without the
secret, or with the wrong one, is refused and changes nothing; a person whose role was changed in
the database WITHOUT passing the door again is taken out of their team by one sweep, and seated
again when the role returns; a gateway repository whose push webhook was deleted gets it back; a
repository somebody made by hand in the organisation has `main` protected; and the database's own
sweep_forge() answers true, which is "asked" -- that call is asynchronous, and the function itself
is what the rest of this file drives directly.

Needs the stack, the forge, the seeded personas, the gateways organisation (one enrolment creates
it) and FORGE_SWEEP_SECRET, the value the edge runtime holds (read it from .env). Skips without them.

    SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... FORGE_SWEEP_SECRET=... \\
      python supabase/functions/forge-sweep/test_forge_sweep.py
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "enroll-gateway"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "forge-membership"))
from test_enroll_gateway import ANON_KEY, SERVICE_ROLE_KEY, SUPABASE_URL, enroll, rest, sign_in  # noqa: E402
from test_forge_membership import (  # noqa: E402
    FORGE_URL, MACHINE_PASSWORD, MACHINE_USER, ORGANISATION, PERSONAS, members_of, request, through_the_door,
)

SWEEP_SECRET = os.getenv("FORGE_SWEEP_SECRET", "")

# Differs from every other suite's fixture id in its FIRST block: sparkplug_id is the first 21 hex
# characters of the uuid, so ids that differ only at the end collide on the generated id.
TEST_GW_ID = "f5aee000-0000-4000-8000-000000000001"
HAND_MADE_REPOSITORY = "playbook-sweep-test"


def sweep(secret=SWEEP_SECRET, with_secret=True):
    headers = {"apikey": ANON_KEY, "Authorization": f"Bearer {ANON_KEY}", "Content-Type": "application/json"}
    if with_secret:
        headers["x-sweep-secret"] = secret
    req = urllib.request.Request(f"{SUPABASE_URL}/functions/v1/forge-sweep", method="POST", data=b"{}", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            return response.status, json.loads(response.read().decode())
    except urllib.error.HTTPError as err:
        text = err.read().decode()
        return err.code, (json.loads(text) if text.strip() else None)


def forge(path, method="GET", body=None):
    credentials = base64.b64encode(f"{MACHINE_USER}:{MACHINE_PASSWORD}".encode()).decode()
    headers = {"Authorization": f"Basic {credentials}"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{FORGE_URL}/api/v1{path}", method=method, headers=headers,
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            text = response.read().decode()
            return response.status, (json.loads(text) if text.strip() else None)
    except urllib.error.HTTPError as err:
        text = err.read().decode()
        return err.code, (json.loads(text) if text.strip() else None)


@unittest.skipIf(not SERVICE_ROLE_KEY or not ANON_KEY, "SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY must be set")
@unittest.skipIf(not SWEEP_SECRET, "FORGE_SWEEP_SECRET must be set to the value the edge runtime holds")
class ForgeSweepBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            rest("/gateways?limit=1")
        except Exception as err:  # noqa: BLE001 -- any failure here means "no stack"
            raise unittest.SkipTest(f"PostgREST is unreachable at {SUPABASE_URL}: {err}")
        status, _ = forge("/version")
        if status != 200:
            raise unittest.SkipTest(f"no forge reachable at {FORGE_URL} ({status})")
        status, _ = forge(f"/orgs/{ORGANISATION}")
        if status != 200:
            raise unittest.SkipTest(f"the '{ORGANISATION}' organisation does not exist yet; enrol one gateway to create it")


class TestTheSecret(ForgeSweepBase):
    def test_a_call_without_the_secret_is_refused(self):
        status, body = sweep(with_secret=False)
        self.assertEqual(status, 401, body)

    def test_a_call_with_the_wrong_secret_is_refused(self):
        status, body = sweep(secret="not-the-secret")
        self.assertEqual(status, 401, body)

    def test_a_call_with_the_secret_answers_a_summary(self):
        status, body = sweep()
        self.assertEqual(status, 200, body)
        for key in ("placed", "removed", "hooked", "protected", "errors"):
            self.assertIsInstance(body.get(key), list, body)
        self.assertEqual(body["errors"], [], body)


class TestMembership(ForgeSweepBase):
    """
    THE CASE THE DOOR CANNOT COVER. forge-membership unseats a person on their next request; a
    person who never makes one keeps their seat, and their SSH key with it. Here the manager's role
    is changed directly in user_roles and NO request passes the door before the sweep runs.
    """

    def test_a_role_changed_behind_the_door_is_reconciled_by_the_sweep(self):
        email, sub, team = PERSONAS["Shopfloor_Manager"]
        try:
            jar, status = through_the_door(email)
        except unittest.SkipTest:
            raise
        self.assertEqual(status, 200, "the door refused a Shopfloor_Manager")
        request(f"{FORGE_URL}/repo/search?q=gateway", jar=jar)
        self.assertIn(sub, members_of(team))

        service = {"apikey": SERVICE_ROLE_KEY, "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
                   "Prefer": "return=representation"}
        status, _, text = request(f"{SUPABASE_URL}/rest/v1/user_roles?user_id=eq.{sub}&select=role_id", headers=service)
        self.assertEqual(status, 200, text[:200])
        original_role_id = json.loads(text)[0]["role_id"]
        status, _, text = request(f"{SUPABASE_URL}/rest/v1/roles?name=eq.Operator&select=id", headers=service)
        operator_role_id = json.loads(text)[0]["id"]

        status, _, text = request(
            f"{SUPABASE_URL}/rest/v1/user_roles?user_id=eq.{sub}", method="PATCH",
            headers=service, body={"role_id": operator_role_id},
        )
        self.assertIn(status, (200, 204), text[:200])
        try:
            status, body = sweep()
            self.assertEqual(status, 200, body)
            self.assertTrue(any(entry.startswith(sub) for entry in body["removed"]), body)
            self.assertNotIn(sub, members_of(team), "a demoted manager kept their seat through a sweep")
        finally:
            status, _, text = request(
                f"{SUPABASE_URL}/rest/v1/user_roles?user_id=eq.{sub}", method="PATCH",
                headers=service, body={"role_id": original_role_id},
            )
            assert status in (200, 204), f"COULD NOT RESTORE the manager persona's role: {text[:200]}"

        # The role is back and the person has still not passed the door: the sweep seats them.
        status, body = sweep()
        self.assertEqual(status, 200, body)
        self.assertTrue(any(entry.startswith(sub) for entry in body["placed"]), body)
        self.assertIn(sub, members_of(team))

    def test_a_member_who_is_not_a_dashboard_identity_is_left_alone(self):
        """A person seated by hand in the forge's UI is not this function's to unseat."""
        status, teams = forge(f"/orgs/{ORGANISATION}/teams?limit=50")
        self.assertEqual(status, 200, teams)
        managers = next(t["id"] for t in teams if t["name"] == "managers")
        status, _ = forge(f"/teams/{managers}/members/{MACHINE_USER}", method="PUT")
        self.assertIn(status, (204, 200), status)
        try:
            status, body = sweep()
            self.assertEqual(status, 200, body)
            self.assertIn(MACHINE_USER, members_of("managers"))
        finally:
            forge(f"/teams/{managers}/members/{MACHINE_USER}", method="DELETE")


class TestRepositories(ForgeSweepBase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        try:
            cls.admin_token = sign_in()
        except Exception as err:  # noqa: BLE001
            raise unittest.SkipTest(f"could not sign in as the seeded administrator ({err})")
        rest(f"/gateways?id=eq.{TEST_GW_ID}", method="DELETE")
        status, rows = rest(
            "/gateways", method="POST", prefer="return=representation",
            body={"id": TEST_GW_ID, "name": "Test_Forge_Sweep", "status": "OFFLINE", "deployment": "remote"},
        )
        if status >= 300:
            raise unittest.SkipTest(f"could not create the test gateway: {rows}")
        cls.sparkplug_id = rows[0]["sparkplug_id"]
        cls.repo = f"gateway-{cls.sparkplug_id}"
        cls.delete_repositories()

    @classmethod
    def tearDownClass(cls):
        cls.delete_repositories()
        # The broker account outlives the row; deleted through the service container's admin
        # credential, as test_enroll_gateway.py does.
        subprocess.run(
            ["docker", "exec", "acs-cymru_gateway_credential", "sh", "-c",
             'mosquitto_ctrl -h "${MQTT_HOST:-mosquitto}" -u "$MQTT_DYNSEC_ADMIN_USER" '
             f'-P "$MQTT_DYNSEC_ADMIN_PASSWORD" dynsec deleteClient {cls.sparkplug_id}'],
            capture_output=True, text=True,
        )
        rest(f"/gateways?id=eq.{TEST_GW_ID}", method="DELETE")

    @classmethod
    def delete_repositories(cls):
        for owner in (ORGANISATION, MACHINE_USER):
            forge(f"/repos/{owner}/{cls.repo}", method="DELETE")
        forge(f"/repos/{ORGANISATION}/{HAND_MADE_REPOSITORY}", method="DELETE")

    def enrol(self):
        key_dir = tempfile.mkdtemp(prefix="acs-forge-sweep-")
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

    def our_hooks(self):
        status, hooks = forge(f"/repos/{ORGANISATION}/{self.repo}/hooks")
        self.assertEqual(status, 200, hooks)
        return [h for h in hooks if h["config"]["url"].endswith("/forge-events")]

    def test_a_deleted_push_webhook_is_registered_again(self):
        self.enrol()
        ours = self.our_hooks()
        if not ours:
            self.skipTest("enrolment registered no hook; GITEA_WEBHOOK_SECRET is unset on this stack")
        status, _ = forge(f"/repos/{ORGANISATION}/{self.repo}/hooks/{ours[0]['id']}", method="DELETE")
        self.assertEqual(status, 204)
        self.assertEqual(self.our_hooks(), [])

        status, body = sweep()
        self.assertEqual(status, 200, body)
        self.assertIn(self.repo, body["hooked"], body)
        restored = self.our_hooks()
        self.assertEqual(len(restored), 1, restored)
        self.assertIn("push", restored[0]["events"])
        self.assertTrue(restored[0]["active"])

        # A second pass finds nothing to do on this repository.
        status, body = sweep()
        self.assertEqual(status, 200, body)
        self.assertNotIn(self.repo, body["hooked"], body)
        self.assertNotIn(self.repo, body["protected"], body)

    def test_a_hand_made_repository_has_main_protected(self):
        status, created = forge(f"/orgs/{ORGANISATION}/repos", method="POST",
                                body={"name": HAND_MADE_REPOSITORY, "private": True, "auto_init": True, "default_branch": "main"})
        self.assertEqual(status, 201, created)
        status, _ = forge(f"/repos/{ORGANISATION}/{HAND_MADE_REPOSITORY}/branch_protections/main")
        self.assertEqual(status, 404, "a fresh repository should carry no protection yet")

        status, body = sweep()
        self.assertEqual(status, 200, body)
        self.assertIn(HAND_MADE_REPOSITORY, body["protected"], body)
        status, protection = forge(f"/repos/{ORGANISATION}/{HAND_MADE_REPOSITORY}/branch_protections/main")
        self.assertEqual(status, 200, protection)
        self.assertFalse(protection["enable_push"], protection)
        self.assertEqual(protection["required_approvals"], 1, protection)
        self.assertIn("administrators", protection["approvals_whitelist_teams"], protection)

        # A playbook is not a gateway: no incident template was committed to it.
        status, _ = forge(f"/repos/{ORGANISATION}/{HAND_MADE_REPOSITORY}/contents/.gitea/ISSUE_TEMPLATE/incident.md")
        self.assertEqual(status, 404)
        # And no hook: only a gateway's repository has a row to record a push on.
        status, hooks = forge(f"/repos/{ORGANISATION}/{HAND_MADE_REPOSITORY}/hooks")
        self.assertEqual(status, 200, hooks)
        self.assertEqual(hooks, [])


class TestTheSchedule(ForgeSweepBase):
    def test_the_database_asks_for_a_sweep(self):
        """
        `true` is "asked", not "swept": net.http_post queues the call. What the call does is what
        every other test here asserts by making it directly.
        """
        status, answer = rest("/rpc/sweep_forge", method="POST", body={})
        self.assertEqual(status, 200, answer)
        self.assertTrue(answer, "sweep_forge() answered false: the Vault holds no sweep secret, so the schedule is inert")

    def test_a_user_cannot_ask(self):
        try:
            token = sign_in()
        except Exception as err:  # noqa: BLE001
            self.skipTest(f"could not sign in as the seeded administrator ({err})")
        # `rest()` raises on a 4xx, and the 4xx is the answer under test.
        with self.assertRaises(urllib.error.HTTPError) as refused:
            rest("/rpc/sweep_forge", method="POST", body={}, key=ANON_KEY, bearer=token)
        self.assertEqual(refused.exception.code, 403, "an Administrator's session could ask for a sweep")


if __name__ == "__main__":
    unittest.main(verbosity=2)
