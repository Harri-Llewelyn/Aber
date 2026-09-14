"""
The forge sweep (0099), against the live stack.

WHAT IS UNDER TEST. forge-sweep is a POST behind Envoy's key-auth whose only authentication is a
shared secret, and whose effect is to reconcile the forge with user_roles and to furnish the
organisation's repositories. So, in order of what would be worst to get wrong: a call without the
secret, or with the wrong one, is refused and changes nothing; a person whose role was changed in
the database WITHOUT passing the door again is taken out of their team by one sweep, and seated
again when the role returns; a gateway repository whose push webhook was deleted gets it back; a
repository somebody made by hand in the organisation has `main` protected; a gateway repository
whose `appliance` and `**` rules were deleted and whose `main` was opened to deploy keys gets all
three back the way enrolment set them; a key somebody re-registered read-only is read-write again;
an archived gateway's key is removed; and the database's own sweep_forge() answers true, which is
"asked" -- that call is asynchronous, and the function itself is what the rest of this file drives
directly.

Needs the stack, the forge, the seeded personas, the gateways organisation (one enrolment creates
it) and FORGE_SWEEP_SECRET, the value the edge runtime holds (read it from .env). Skips without them.

    SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... FORGE_SWEEP_SECRET=... \\
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
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "enroll-gateway"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "forge-membership"))
from test_enroll_gateway import (  # noqa: E402
    PUBLISHABLE_KEY, SERVICE_ROLE_KEY, SUPABASE_URL, delete_broker_account, enroll, rest, sign_in,
)
from test_forge_membership import (  # noqa: E402
    FORGE_URL, MACHINE_PASSWORD, MACHINE_USER, ORGANISATION, PERSONAS, members_of, request, through_the_door,
)

SWEEP_SECRET = os.getenv("FORGE_SWEEP_SECRET", "")
# Must agree with _shared/forge.ts.
PLATFORM_ORGANISATION = "platform"
PLATFORM_REPOSITORY = "gateway-platform"

# Differs from every other suite's fixture id in its FIRST block: sparkplug_id is the first 21 hex
# characters of the uuid, so ids that differ only at the end collide on the generated id.
TEST_GW_ID = "f5aee000-0000-4000-8000-000000000001"
HAND_MADE_REPOSITORY = "playbook-sweep-test"


def sweep(secret=SWEEP_SECRET, with_secret=True):
    headers = {"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {PUBLISHABLE_KEY}", "Content-Type": "application/json"}
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


@unittest.skipIf(not SERVICE_ROLE_KEY or not PUBLISHABLE_KEY, "SUPABASE_SERVICE_ROLE_KEY and SUPABASE_PUBLISHABLE_KEY must be set")
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

        service = {"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
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
        # The broker account outlives the row; deleted through the service's admin credential.
        delete_broker_account(cls.sparkplug_id)
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
        _, rows = rest("/rpc/issue_gateway_enrollment_token", method="POST", bearer=self.admin_token,
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

    def keys(self):
        status, keys = forge(f"/repos/{ORGANISATION}/{self.repo}/keys")
        self.assertEqual(status, 200, keys)
        return keys

    def rule(self, name):
        status, rule = forge(f"/repos/{ORGANISATION}/{self.repo}/branch_protections/{urllib.parse.quote(name, safe='')}")
        return status, rule

    def test_a_key_downgraded_by_hand_is_registered_read_write_again(self):
        """An enrolment from before the appliance branch left a read-only key; the sweep re-registers it."""
        self.enrol()
        (key,) = self.keys()
        self.assertFalse(key["read_only"], key)
        status, _ = forge(f"/repos/{ORGANISATION}/{self.repo}/keys/{key['id']}", method="DELETE")
        self.assertEqual(status, 204)
        status, _ = forge(f"/repos/{ORGANISATION}/{self.repo}/keys", method="POST",
                          body={"title": key["title"], "key": key["key"], "read_only": True})
        self.assertEqual(status, 201)

        status, body = sweep()
        self.assertEqual(status, 200, body)
        self.assertTrue(any(entry.startswith(self.repo) for entry in body["rekeyed"]), body)
        (restored,) = self.keys()
        self.assertFalse(restored["read_only"], restored)
        self.assertEqual(restored["key"].split()[:2], key["key"].split()[:2], "the sweep must re-register the same material")

    def test_the_rules_are_restored_and_main_is_closed_again(self):
        self.enrol()
        status, _ = self.rule("appliance")
        self.assertEqual(status, 200)
        for name in ("appliance", "**"):
            status, _ = forge(f"/repos/{ORGANISATION}/{self.repo}/branch_protections/{urllib.parse.quote(name, safe='')}", method="DELETE")
            self.assertEqual(status, 204, name)
        # And main opened to deploy keys by hand, which is the one edit that would let the
        # appliance deploy what it reports.
        status, _ = forge(f"/repos/{ORGANISATION}/{self.repo}/branch_protections/main", method="PATCH",
                          body={"enable_push": True, "enable_push_whitelist": True, "push_whitelist_deploy_keys": True})
        self.assertEqual(status, 200)

        status, body = sweep()
        self.assertEqual(status, 200, body)
        self.assertIn(self.repo, body["protected"], body)
        self.assertIn(f"{self.repo} (appliance)", body["protected"], body)
        status, main = self.rule("main")
        self.assertEqual(status, 200)
        self.assertFalse(main["enable_push"], main)
        self.assertFalse(main["push_whitelist_deploy_keys"], main)
        status, appliance = self.rule("appliance")
        self.assertEqual(status, 200)
        self.assertTrue(appliance["push_whitelist_deploy_keys"], appliance)
        status, catch_all = self.rule("**")
        self.assertEqual(status, 200)
        self.assertFalse(catch_all["push_whitelist_deploy_keys"], catch_all)
        self.assertGreater(catch_all["priority"], appliance["priority"])

        status, body = sweep()
        self.assertEqual(status, 200, body)
        self.assertNotIn(self.repo, body["protected"], body)

    def test_an_archived_gateway_holds_no_key(self):
        self.enrol()
        self.assertEqual(len(self.keys()), 1)
        status, _ = rest(f"/gateways?id=eq.{TEST_GW_ID}", method="PATCH", body={"is_archived": True})
        self.assertIn(status, (200, 204))
        try:
            status, body = sweep()
            self.assertEqual(status, 200, body)
            self.assertTrue(any(entry.startswith(self.repo) for entry in body["revoked"]), body)
            self.assertEqual(self.keys(), [], "an archived gateway's appliance can still reach the forge")
        finally:
            rest(f"/gateways?id=eq.{TEST_GW_ID}", method="PATCH", body={"is_archived": False})

    def test_an_enrolled_gateway_reads_the_platform_repository_and_points_at_its_tag(self):
        """
        THE SECOND LINK. Enrolment registers the same key read-only on platform/gateway-platform
        and seeds platform.yml on the gateway's main; archiving the gateway removes that key too.
        """
        self.enrol()
        (own,) = self.keys()
        status, platform_keys = forge(f"/repos/{PLATFORM_ORGANISATION}/{PLATFORM_REPOSITORY}/keys?limit=50")
        self.assertEqual(status, 200, platform_keys)
        ours = [k for k in platform_keys if k["key"].split()[:2] == own["key"].split()[:2]]
        self.assertEqual(len(ours), 1, "the gateway's key is not on the platform repository exactly once")
        self.assertTrue(ours[0]["read_only"], "the platform repository must admit the key read-only")

        status, pointer = forge(f"/repos/{ORGANISATION}/{self.repo}/contents/platform.yml")
        self.assertEqual(status, 200, "platform.yml was not seeded on the gateway's main")
        text = base64.b64decode(pointer["content"]).decode()
        self.assertRegex(text, r"tag: v\d+\.\d+\.\d+")

        status, _ = rest(f"/gateways?id=eq.{TEST_GW_ID}", method="PATCH", body={"is_archived": True})
        self.assertIn(status, (200, 204))
        try:
            status, body = sweep()
            self.assertEqual(status, 200, body)
            self.assertTrue(any(entry.startswith(f"{PLATFORM_ORGANISATION}/{PLATFORM_REPOSITORY}") for entry in body["revoked"]), body)
            _, platform_keys = forge(f"/repos/{PLATFORM_ORGANISATION}/{PLATFORM_REPOSITORY}/keys?limit=50")
            self.assertEqual([k for k in platform_keys if k["title"] == own["title"]], [])
        finally:
            rest(f"/gateways?id=eq.{TEST_GW_ID}", method="PATCH", body={"is_archived": False})

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


class TestThePlatform(ForgeSweepBase):
    """
    THE PLATFORM PLAYBOOK, PUBLISHED. One sweep leaves platform/gateway-platform holding what this
    build ships, tagged at the platform's version, with main admitting the machine account alone,
    and a readers team the admitted roles are seated in. A second sweep publishes nothing.
    """

    def test_one_sweep_publishes_the_playbook_and_tags_it(self):
        status, body = sweep()
        self.assertEqual(status, 200, body)
        self.assertEqual(body["errors"], [], body)

        status, repo = forge(f"/repos/{PLATFORM_ORGANISATION}/{PLATFORM_REPOSITORY}")
        self.assertEqual(status, 200, "the platform repository does not exist after a sweep")
        self.assertTrue(repo["private"])

        status, manifest = forge(f"/repos/{PLATFORM_ORGANISATION}/{PLATFORM_REPOSITORY}/contents/.acs/manifest.json")
        self.assertEqual(status, 200, "main carries no manifest")
        published = json.loads(base64.b64decode(manifest["content"]).decode())
        self.assertRegex(published["digest"], r"^[0-9a-f]{64}$")
        for path in ("site.yml", "roles/converge/files/acs-gateway-converge", "appliance/flow-sync.mjs", "appliance/bootstrap.mjs"):
            status, _ = forge(f"/repos/{PLATFORM_ORGANISATION}/{PLATFORM_REPOSITORY}/contents/{path}")
            self.assertEqual(status, 200, f"{path} is not published")

        status, tags = forge(f"/repos/{PLATFORM_ORGANISATION}/{PLATFORM_REPOSITORY}/tags?limit=50")
        self.assertEqual(status, 200, tags)
        tag = next((t for t in tags if t["name"] == f"v{published['version']}"), None)
        self.assertIsNotNone(tag, f"no tag v{published['version']}: {[t['name'] for t in tags]}")
        status, at_tag = forge(f"/repos/{PLATFORM_ORGANISATION}/{PLATFORM_REPOSITORY}/contents/.acs/manifest.json?ref={tag['name']}")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(base64.b64decode(at_tag["content"]).decode())["digest"], published["digest"])

        status, rule = forge(f"/repos/{PLATFORM_ORGANISATION}/{PLATFORM_REPOSITORY}/branch_protections/main")
        self.assertEqual(status, 200, rule)
        self.assertEqual(rule["push_whitelist_usernames"], [MACHINE_USER], rule)
        self.assertFalse(rule["push_whitelist_deploy_keys"], rule)

        status, teams = forge(f"/orgs/{PLATFORM_ORGANISATION}/teams?limit=50")
        self.assertEqual(status, 200, teams)
        readers = next((t for t in teams if t["name"] == "readers"), None)
        self.assertIsNotNone(readers, teams)
        # Gitea 1.27 reports a team created with per-unit access as permission 'none' and carries
        # the real answer per unit (measured); every unit it holds must be read and none more.
        self.assertTrue(readers["units_map"], readers)
        self.assertEqual(set(readers["units_map"].values()), {"read"}, readers)
        self.assertFalse(readers["can_create_org_repo"], readers)

        # A second pass: the digest matches, so nothing is published again.
        status, body = sweep()
        self.assertEqual(status, 200, body)
        self.assertEqual(body["published"], [], body)
        self.assertEqual(body["errors"], [], body)


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
            rest("/rpc/sweep_forge", method="POST", body={}, bearer=token)
        self.assertEqual(refused.exception.code, 403, "an Administrator's session could ask for a sweep")


if __name__ == "__main__":
    unittest.main(verbosity=2)
