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
three back the way enrolment set them; a `main` still requiring the shape check under its old name
requires it under the current one; a key somebody re-registered read-only is read-write again;
an archived gateway's key is removed and its repository is put into the forge's archive, read-only
with every branch kept, and taken back out when the gateway is restored (#197); and the database's
own sweep_forge() answers true, which is
"asked" -- that call is asynchronous, and the function itself is what the rest of this file drives
directly.

ONE PASS AT A TIME (0025). A pass claims a lease and a call that finds it held answers
`already_sweeping`. Every test here holds that lease from setUp to cleanup and runs its own passes
under it (`x-sweep-lease`), so the database's own asks -- the schedule, an archive's trigger, one
a previous test queued -- are refused while it runs, and the report a test reads is the report of
the pass that made the change.

Needs the stack, the forge, the seeded personas, the gateways organisation (one enrolment creates
it) and FORGE_SWEEP_SECRET, the value the edge runtime holds (read it from .env). Skips without them.

    SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... FORGE_SWEEP_SECRET=... \\
      python supabase/functions/forge-sweep/test_forge_sweep.py
"""
import base64
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "enroll-gateway"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "forge-membership"))
from test_enroll_gateway import (  # noqa: E402
    PUBLISHABLE_KEY, SERVICE_ROLE_KEY, SUPABASE_URL, delete_broker_account, enroll, rest, sign_in,
)
from test_forge_membership import (  # noqa: E402
    FORGE_URL, MACHINE_PASSWORD, MACHINE_USER, ORGANISATION, PERSONAS, members_of, request, through_the_door,
)
import stack_exec  # noqa: E402  -- on the path test_enroll_gateway puts there

try:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID
except ImportError:  # the two merge tests skip; everything else here stands
    x509 = None

SWEEP_SECRET = os.getenv("FORGE_SWEEP_SECRET", "")
# Must agree with _shared/forge.ts.
PLATFORM_ORGANISATION = "platform"
PLATFORM_REPOSITORY = "gateway-platform"
CUSTOM_EXAMPLE_REPOSITORY = "gateway-custom-example"
FLOW_SHAPE_CONTEXT = "aber/flow-shape"
# The shape check's name before the rename to Aber; the sweep removes it from a rule.
RETIRED_FLOW_SHAPE_CONTEXT = "acs/flow-shape"

# Differs from every other suite's fixture id in its FIRST block: sparkplug_id is the first 21 hex
# characters of the uuid, so ids that differ only at the end collide on the generated id.
TEST_GW_ID = "f5aee000-0000-4000-8000-000000000001"
HAND_MADE_REPOSITORY = "playbook-sweep-test"

# The lease the suite asks for, as the function does (LEASE_SECONDS in index.ts), and how long it
# waits for one: past a lease a dead pass left, so waiting ends in the lease or in a real fault.
LEASE_SECONDS = 300
LEASE_WAIT = LEASE_SECONDS + 30

# The lease the running test holds (ForgeSweepBase.setUp). sweep() runs every pass under it.
held_lease = None


def claim_lease(seconds=LEASE_SECONDS, wait=LEASE_WAIT):
    """The sweep lease, waiting while a pass holds it. Raises when none came within `wait`."""
    deadline = time.monotonic() + wait
    while True:
        _, holder = rest("/rpc/claim_forge_sweep", method="POST", body={"p_seconds": seconds})
        if holder:
            return holder
        if time.monotonic() > deadline:
            raise AssertionError(f"the sweep lease stayed held for {wait}s")
        time.sleep(1)


def release_lease(holder):
    _, released = rest("/rpc/release_forge_sweep", method="POST", body={"p_holder": holder})
    return released


def post_sweep(secret=SWEEP_SECRET, with_secret=True, lease=None):
    """One call to the function, answered as it is."""
    headers = {"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {PUBLISHABLE_KEY}", "Content-Type": "application/json"}
    if with_secret:
        headers["x-sweep-secret"] = secret
    if lease:
        headers["x-sweep-lease"] = lease
    req = urllib.request.Request(f"{SUPABASE_URL}/functions/v1/forge-sweep", method="POST", data=b"{}", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            return response.status, json.loads(response.read().decode())
    except urllib.error.HTTPError as err:
        text = err.read().decode()
        return err.code, (json.loads(text) if text.strip() else None)


def sweep(secret=SWEEP_SECRET, with_secret=True):
    """
    One pass, under the lease the running test holds. With none held, a call that meets another
    pass waits for it and asks again: `already_sweeping` says when to ask, and is never the result.
    """
    deadline = time.monotonic() + LEASE_WAIT
    while True:
        status, body = post_sweep(secret, with_secret, lease=held_lease)
        if status != 200 or not (body or {}).get("already_sweeping") or time.monotonic() > deadline:
            return status, body
        time.sleep(1)


def psql(sql):
    """One statement as the database owner, inside the database pod: net is not exposed."""
    return stack_exec.output("supabase-db", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", sql).strip()


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

    def setUp(self):
        self.hold()
        self.addCleanup(self.let_go)

    def hold(self, wait=LEASE_WAIT):
        global held_lease
        held_lease = claim_lease(wait=wait)

    def let_go(self):
        global held_lease
        if held_lease:
            release_lease(held_lease)
            held_lease = None


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
        for key in ("placed", "removed", "hooked", "protected", "rekeyed", "revoked", "published",
                    "recorded", "warnings", "errors"):
            self.assertIsInstance(body.get(key), list, body)
        # `errors` is what failed. A released tag this build cannot move is not a failure and has no
        # retry that clears it, so it answers in `warnings` and this assertion stays meaningful on a
        # development forge whose playbook has moved on from its tag.
        self.assertEqual(body["errors"], [], body)


class TestOnePassAtATime(ForgeSweepBase):
    """
    THE LEASE (0025). Two passes at once each list what the forge holds and each write what is
    missing: two webhooks on one repository was the case seen. The test holds the lease, which is
    what any call meets while another pass runs.
    """

    def test_a_call_while_another_pass_runs_does_nothing_and_says_so(self):
        started = time.monotonic()
        status, body = post_sweep()
        # 200: pg_net records the status, and a call that found a pass running did not fail.
        self.assertEqual(status, 200, body)
        self.assertEqual(body, {"already_sweeping": True})
        self.assertLess(time.monotonic() - started, 15, "a refused call answered only after a pass")

    def test_a_lease_the_caller_does_not_hold_is_refused(self):
        for lease in (str(uuid.uuid4()), "not-a-lease"):
            status, body = post_sweep(lease=lease)
            self.assertEqual(status, 409, body)

    def test_a_lapsed_lease_is_taken_over_and_a_pass_lets_go_before_it_answers(self):
        # A pass that died holding the lease: claimed for a second and never released.
        self.let_go()
        dead = claim_lease(seconds=1)
        time.sleep(2)

        status, body = sweep()
        self.assertEqual(status, 200, body)
        self.assertIsInstance(body.get("errors"), list, f"no pass ran past a lapsed lease: {body}")
        # Whatever took it over, the dead holder can neither end it nor run under it.
        self.assertFalse(release_lease(dead))
        self.assertEqual(post_sweep(lease=dead)[0], 409)

        # Released before the answer, so the lease is free once any pass the release queued has
        # run. A pass lives at most a minute; a lease left held would last five.
        self.hold(wait=90)

    def test_a_call_the_database_queued_meets_the_lease_and_is_recorded_as_answered(self):
        """
        Refused is not failed. pg_net records the status each call met, and it is the only record
        of a sweep the database asked for, so a refusal there must read as an answer.
        """
        before = int(psql("SELECT coalesce(max(id), 0) FROM net._http_response") or 0)
        status, answer = rest("/rpc/sweep_forge", method="POST", body={})
        self.assertEqual(status, 200, answer)
        self.assertTrue(answer, "sweep_forge() answered false: the Vault holds no sweep secret")
        outcome, deadline = "", time.monotonic() + 75  # the call's own timeout is 60s
        while not outcome and time.monotonic() < deadline:
            time.sleep(1)
            outcome = psql(f"SELECT status_code FROM net._http_response WHERE id > {before} "
                           f"AND content LIKE '%already_sweeping%' ORDER BY id LIMIT 1")
        self.assertEqual(outcome, "200", "the database's call was not answered already_sweeping within 75s")


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
        key_dir = tempfile.mkdtemp(prefix="aber-forge-sweep-")
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

    def test_a_second_push_webhook_of_ours_is_removed(self):
        """
        Two registrations that raced -- two passes, or a pass and an enrolment -- each found no hook
        and each created one, and forge-events then receives every push twice. The sweep keeps the
        one enrolment registered and removes the other.
        """
        self.enrol()
        ours = self.our_hooks()
        if not ours:
            self.skipTest("enrolment registered no hook; GITEA_WEBHOOK_SECRET is unset on this stack")
        (original,) = ours
        status, created = forge(f"/repos/{ORGANISATION}/{self.repo}/hooks", method="POST", body={
            "type": "gitea", "active": True, "events": ["push"], "branch_filter": original["branch_filter"],
            "config": {"url": original["config"]["url"], "content_type": "json", "secret": "a-second-registration"},
        })
        self.assertEqual(status, 201, created)
        self.assertEqual(len(self.our_hooks()), 2)

        status, body = sweep()
        self.assertEqual(status, 200, body)
        self.assertIn(self.repo, body["hooked"], body)
        self.assertEqual([h["id"] for h in self.our_hooks()], [original["id"]])

        status, body = sweep()
        self.assertEqual(status, 200, body)
        self.assertNotIn(self.repo, body["hooked"], body)

    def gateway_row(self):
        _, rows = rest(f"/gateways?id=eq.{TEST_GW_ID}&select=enrolled_at,forge_repository_at")
        return rows[0]

    def test_a_repository_the_row_does_not_know_about_is_recorded(self):
        """
        The self-healing half of `forge_repository_at` (0110). enrolment writes it; this covers the
        two cases enrolment cannot -- a fleet enrolled before the column existed, and an enrolment
        whose own write failed after the repository was created. Seeing the repository is the proof,
        and nothing else on the row distinguishes "no repository" from "no forge on this deployment".
        """
        self.enrol()
        self.assertIsNotNone(self.gateway_row()["forge_repository_at"])

        # The state a database enrolled before 0110 is in: a repository, and a row that says nothing.
        rest(f"/gateways?id=eq.{TEST_GW_ID}", method="PATCH", body={"forge_repository_at": None})
        self.assertIsNone(self.gateway_row()["forge_repository_at"])

        status, body = sweep()
        self.assertEqual(status, 200, body)
        self.assertIn(self.repo, body["recorded"], body)
        self.assertIsNotNone(
            self.gateway_row()["forge_repository_at"],
            "the sweep saw the repository and the row still does not say so",
        )

        # NEVER TWICE, and never moved. A sweep that rewrote the timestamp would walk it forward on
        # every pass, and the enrolment's own -- the accurate one -- would never survive a sweep.
        recorded = self.gateway_row()["forge_repository_at"]
        status, body = sweep()
        self.assertEqual(status, 200, body)
        self.assertNotIn(self.repo, body["recorded"], body)
        self.assertEqual(self.gateway_row()["forge_repository_at"], recorded)

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

    def test_main_requires_the_shape_check_under_its_current_name_only(self):
        """
        The rule a repository enrolled before the rename to Aber carries: the shape check under its
        old name, which nothing posts any more, so no proposal could ever be merged. The sweep
        replaces it and keeps a context an administrator added.
        """
        self.enrol()
        status, _ = forge(f"/repos/{ORGANISATION}/{self.repo}/branch_protections/main", method="PATCH",
                          body={"enable_status_check": True,
                                "status_check_contexts": [RETIRED_FLOW_SHAPE_CONTEXT, "site/extra-check"]})
        self.assertEqual(status, 200)

        status, body = sweep()
        self.assertEqual(status, 200, body)
        self.assertIn(self.repo, body["protected"], body)
        status, main = self.rule("main")
        self.assertEqual(status, 200)
        self.assertTrue(main["enable_status_check"], main)
        self.assertEqual(sorted(main["status_check_contexts"]), sorted([FLOW_SHAPE_CONTEXT, "site/extra-check"]), main)

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
            # Sweeps as well as restoring: since 0114 the pass above also archived the repository.
            self.restore_and_sweep()

    def repository(self):
        status, repo = forge(f"/repos/{ORGANISATION}/{self.repo}")
        self.assertEqual(status, 200, repo)
        return repo

    def restore_and_sweep(self):
        """
        Put the row back AND sweep. Restoring alone leaves the repository read-only in the forge
        until the next pass, and the tests that follow this one in the class would then enrol
        against an archived repository -- which is a real state, and not the one they mean to be
        testing.
        """
        rest(f"/gateways?id=eq.{TEST_GW_ID}", method="PATCH", body={"is_archived": False})
        sweep()

    def test_an_archived_gateway_has_its_repository_archived(self):
        """
        #197, and the half the deploy key never covered. Revoking the key stops the appliance
        reaching the repository; it does nothing about the repository itself, which went on
        reading in the forge's own listing exactly like one in service -- and the forge is where
        the flow and the plant's notes about a gateway live.
        """
        self.enrol()
        self.assertFalse(self.repository()["archived"], "enrolment created an archived repository")
        status, _ = rest(f"/gateways?id=eq.{TEST_GW_ID}", method="PATCH", body={"is_archived": True})
        self.assertIn(status, (200, 204))
        try:
            # The archive asks the database for a sweep too, which meets the lease this test holds.
            status, body = sweep()
            self.assertEqual(status, 200, body)
            self.assertIn(self.repo, body["archived"], body)

            repo = self.repository()
            self.assertTrue(repo["archived"], "the repository of an archived gateway is still live")
            # ARCHIVED, NOT DELETED. The wiki is the one place a plant's notes about a gateway
            # live, and the `appliance` branch is the last thing it reported -- a better record
            # than the heartbeat table, which stops.
            self.assertFalse(repo.get("empty", False), repo)
            status, branches = forge(f"/repos/{ORGANISATION}/{self.repo}/branches")
            self.assertEqual(status, 200, branches)
            self.assertIn("main", [b["name"] for b in branches], branches)

            # The row records what the forge answered, which is what the dashboard reads.
            _, rows = rest(f"/gateways?id=eq.{TEST_GW_ID}&select=forge_archived_at")
            self.assertIsNotNone(rows[0]["forge_archived_at"], rows)
        finally:
            self.restore_and_sweep()

    def test_restoring_the_gateway_takes_its_repository_back_out(self):
        self.enrol()
        # Something the sweep must WRITE on the way back, so this can tell un-archiving FIRST from
        # un-archiving last: Gitea refuses a webhook registration on an archived repository, so a
        # pass that furnished before it un-archived would leave the hook missing and say so in
        # `errors`.
        hooks = self.our_hooks()
        if hooks:
            forge(f"/repos/{ORGANISATION}/{self.repo}/hooks/{hooks[0]['id']}", method="DELETE")

        rest(f"/gateways?id=eq.{TEST_GW_ID}", method="PATCH", body={"is_archived": True})
        status, body = sweep()
        self.assertEqual(status, 200, body)
        self.assertTrue(self.repository()["archived"], body)

        rest(f"/gateways?id=eq.{TEST_GW_ID}", method="PATCH", body={"is_archived": False})
        status, body = sweep()
        self.assertEqual(status, 200, body)
        self.assertIn(self.repo, body["restored"], body)
        self.assertFalse(self.repository()["archived"], "the repository stayed read-only")
        self.assertEqual(body["errors"], [], body)
        if hooks:
            self.assertEqual(
                len(self.our_hooks()), 1,
                "the same pass could not re-register the hook, so it furnished before it "
                "un-archived",
            )

        _, rows = rest(f"/gateways?id=eq.{TEST_GW_ID}&select=forge_archived_at")
        self.assertIsNone(rows[0]["forge_archived_at"], rows)

        # THE KEY DOES NOT COME BACK, and that is the same answer the broker credential gives.
        # Archiving deleted it and the platform keeps no copy of the appliance's public key, so a
        # machine that returns is re-enrolled -- which is also what un-archives the repository
        # without waiting for a sweep.
        self.assertEqual(self.keys(), [], "a deleted deploy key reappeared from somewhere")

    def test_a_second_sweep_leaves_an_archived_repository_alone(self):
        # The reconciliation is against the forge's own answer, so a repository already in the
        # state the row asks for costs a read and no PATCH. Without that, every pass would report
        # a change it did not make -- and the summary is what an operator reads.
        self.enrol()
        rest(f"/gateways?id=eq.{TEST_GW_ID}", method="PATCH", body={"is_archived": True})
        try:
            sweep()
            status, body = sweep()
            self.assertEqual(status, 200, body)
            self.assertNotIn(self.repo, body["archived"], body)
            self.assertEqual(body["errors"], [], "an archived repository is being written to")
        finally:
            self.restore_and_sweep()

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

        status, manifest = forge(f"/repos/{PLATFORM_ORGANISATION}/{PLATFORM_REPOSITORY}/contents/.aber/manifest.json")
        self.assertEqual(status, 200, "main carries no manifest")
        published = json.loads(base64.b64decode(manifest["content"]).decode())
        self.assertRegex(published["digest"], r"^[0-9a-f]{64}$")
        for path in ("site.yml", "roles/converge/files/aber-gateway-converge", "appliance/flow-sync.mjs", "appliance/bootstrap.mjs"):
            status, _ = forge(f"/repos/{PLATFORM_ORGANISATION}/{PLATFORM_REPOSITORY}/contents/{path}")
            self.assertEqual(status, 200, f"{path} is not published")

        status, tags = forge(f"/repos/{PLATFORM_ORGANISATION}/{PLATFORM_REPOSITORY}/tags?limit=50")
        self.assertEqual(status, 200, tags)
        tag = next((t for t in tags if t["name"] == f"v{published['version']}"), None)
        self.assertIsNotNone(tag, f"no tag v{published['version']}: {[t['name'] for t in tags]}")
        status, at_tag = forge(f"/repos/{PLATFORM_ORGANISATION}/{PLATFORM_REPOSITORY}/contents/.aber/manifest.json?ref={tag['name']}")
        self.assertEqual(status, 200)
        at_tag_digest = json.loads(base64.b64decode(at_tag["content"]).decode())["digest"]
        # A TAG IS CREATED ONCE AND NEVER MOVED, so there are exactly two states the sweep promises
        # and this asserts whichever one holds. Either the tag was cut from this build and carries
        # its digest, which is every fresh forge; or the playbook moved on after the tag was cut
        # without the version being bumped, which is every development forge, and then the tag keeps
        # its content and the sweep SAYS SO. Asserting only the first makes the suite red on a forge
        # the sweep handled correctly; dropping the assertion would stop it noticing a moved tag.
        if at_tag_digest == published["digest"]:
            self.assertEqual(body["warnings"], [], "the tag is at this build's content, so nothing was declined")
        else:
            self.assertEqual(len(body["warnings"]), 1, body["warnings"])
            self.assertIn(f"{PLATFORM_ORGANISATION}/{PLATFORM_REPOSITORY} is tagged {tag['name']}", body["warnings"][0])

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

    def test_the_custom_example_is_published_as_a_template_and_never_tagged(self):
        """
        THE SECOND PUBLISHED REPOSITORY (0106). The example a gateway needing code of its own is
        copied from. Tagged or not is what the repository is FOR: the playbook is converged to, so
        an appliance pins a released version of it; the example is copied once by a person, so it
        carries main alone and is marked as a template for the forge's "Use this template".
        """
        status, body = sweep()
        self.assertEqual(status, 200, body)
        self.assertEqual(body["errors"], [], body)

        status, repo = forge(f"/repos/{PLATFORM_ORGANISATION}/{CUSTOM_EXAMPLE_REPOSITORY}")
        self.assertEqual(status, 200, "the custom example does not exist after a sweep")
        self.assertTrue(repo["private"], repo)
        self.assertTrue(repo["template"], "the example must be a template, or nobody can copy it")

        for path in ("README.md", "custom.yml", "custom/docker-compose.yml", "custom/Dockerfile"):
            status, _ = forge(f"/repos/{PLATFORM_ORGANISATION}/{CUSTOM_EXAMPLE_REPOSITORY}/contents/{path}")
            self.assertEqual(status, 200, f"{path} is not published")

        # NOT flows.json and NOT platform.yml. A flow copied from a template would be deployed over
        # the one enrolment installed, and a copied pointer would be KEPT by seedPlatformPointer,
        # pinning every gateway seeded from this to a tag that was current when it was written.
        for path in ("flows.json", "platform.yml"):
            status, _ = forge(f"/repos/{PLATFORM_ORGANISATION}/{CUSTOM_EXAMPLE_REPOSITORY}/contents/{path}")
            self.assertEqual(status, 404, f"{path} must not be in the template")

        status, tags = forge(f"/repos/{PLATFORM_ORGANISATION}/{CUSTOM_EXAMPLE_REPOSITORY}/tags?limit=50")
        self.assertEqual(status, 200, tags)
        self.assertEqual(tags, [], f"the example is copied, not converged to, so it takes no tag: {tags}")

        status, rule = forge(f"/repos/{PLATFORM_ORGANISATION}/{CUSTOM_EXAMPLE_REPOSITORY}/branch_protections/main")
        self.assertEqual(status, 200, rule)
        self.assertEqual(rule["push_whitelist_usernames"], [MACHINE_USER], rule)
        self.assertFalse(rule["push_whitelist_deploy_keys"], rule)

        status, body = sweep()
        self.assertEqual(status, 200, body)
        self.assertEqual(body["published"], [], body)


class TestTheTrustBundle(ForgeSweepBase):
    """
    THE ROOTS EVERY APPLIANCE READS. `trust/` sits on main of the platform repository, written by
    the sweep from the root the broker presents, and is the one thing in that repository an
    appliance reads off a branch rather than off the tag it is pinned to -- because a re-issued
    root has to reach a fleet spread across several platform versions.
    """

    @staticmethod
    def _a_root(days):
        """
        A throwaway self-signed root, valid for `days`. Injected into the published bundle so the
        merge is exercised against more than the one root this stack actually has. EC because it
        is generated per test and nothing here verifies a chain with it.
        """
        key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f"trust-merge-{days}d")])
        not_after = datetime.now(timezone.utc) + timedelta(days=days)
        certificate = (
            x509.CertificateBuilder()
            .subject_name(name).issuer_name(name)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(datetime.now(timezone.utc) - timedelta(days=abs(days) + 1))
            .not_valid_after(not_after)
            .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
            .sign(key, hashes.SHA256())
        )
        pem = certificate.public_bytes(serialization.Encoding.PEM).decode()
        spki = certificate.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )
        return pem, base64.b64encode(hashlib.sha256(spki).digest()).decode(), not_after

    def _publish(self, path, text):
        """Write one file of trust/ on main as the machine account, replacing what is there."""
        full = f"/repos/{PLATFORM_ORGANISATION}/{PLATFORM_REPOSITORY}/contents/trust/{path}"
        status, existing = forge(full)
        body = {
            "content": base64.b64encode(text.encode()).decode(),
            "message": f"Doctor {path} for a merge test",
            "branch": "main",
        }
        if status == 200:
            body["sha"] = existing["sha"]
        status, answer = forge(full, method="PUT" if status == 200 else "POST", body=body)
        self.assertIn(status, (200, 201), answer)

    def _trust(self, path):
        status, body = forge(f"/repos/{PLATFORM_ORGANISATION}/{PLATFORM_REPOSITORY}/contents/trust/{path}")
        return status, (base64.b64decode(body["content"]).decode() if status == 200 else None)

    def test_the_sweep_publishes_the_root_the_broker_presents(self):
        status, body = sweep()
        self.assertEqual(status, 200, body)
        self.assertEqual(body["errors"], [], body)

        status, bundle = self._trust("ca-bundle.pem")
        self.assertEqual(status, 200, "main carries no trust/ca-bundle.pem after a sweep")
        self.assertIn("BEGIN CERTIFICATE", bundle)

        status, manifest = self._trust("manifest.json")
        self.assertEqual(status, 200, "a bundle with no manifest cannot be dated, so none of it expires")
        published = json.loads(manifest)
        self.assertEqual(set(published), {"current", "roots", "published_at"})
        self.assertEqual(len(published["roots"]), bundle.count("BEGIN CERTIFICATE"))
        # The manifest's current root is the first block in the bundle, and it is the one the
        # credential service reports: an appliance verifies against the file, not against this.
        self.assertEqual(published["roots"][0]["spki_sha256"], published["current"])
        self.assertGreater(published["roots"][0]["not_after"], published["published_at"])

    def test_a_second_sweep_publishes_nothing(self):
        # The ordinary pass. The bundle is compared by its bytes rather than by the set of keys,
        # so a root re-issued with the same key still publishes -- and an unchanged one does not.
        sweep()
        status, body = sweep()
        self.assertEqual(status, 200, body)
        self.assertEqual(
            [entry for entry in body["published"] if "trust/" in entry], [],
            f"the bundle was republished with nothing to change: {body['published']}",
        )

    def test_publishing_the_playbook_does_not_delete_the_bundle(self):
        """
        THE ONE THING THAT WOULD BREAK THIS QUIETLY. publishToForge() deletes every file on main
        that this build does not ship, and the bundle is written from the broker rather than from
        the tree. Without the exclusion the two would take turns removing each other's work, and
        an appliance would find trust/ absent on some passes and present on others.
        """
        sweep()
        # Force a republication of the playbook by making main's manifest disagree with the build.
        path = f"/repos/{PLATFORM_ORGANISATION}/{PLATFORM_REPOSITORY}/contents/.aber/manifest.json"
        status, manifest = forge(path)
        self.assertEqual(status, 200, manifest)
        forge(path, method="PUT", body={
            "content": base64.b64encode(json.dumps({"digest": "0" * 64}).encode()).decode(),
            "sha": manifest["sha"],
            "message": "Force a republication",
            "branch": "main",
        })

        status, body = sweep()
        self.assertEqual(status, 200, body)
        self.assertEqual(body["errors"], [], body)
        self.assertTrue(
            any(PLATFORM_REPOSITORY in entry and "trust/" not in entry for entry in body["published"]),
            f"the playbook was not republished, so the exclusion was not exercised: {body}",
        )
        status, bundle = self._trust("ca-bundle.pem")
        self.assertEqual(status, 200, "publishing the playbook deleted the trust bundle")
        self.assertIn("BEGIN CERTIFICATE", bundle)


    @unittest.skipIf(x509 is None, "the `cryptography` package is not installed")
    def test_a_previously_published_root_is_carried_forward(self):
        """
        THE OVERLAP THE WHOLE ROTATION RESTS ON. A bundle carrying only the current root would cut
        off every appliance that has not converged yet the moment the broker's leaf is re-issued.
        One that carries both verifies a broker presenting either, which is what makes publishing
        the new root and switching the leaf to it two independent steps.
        """
        sweep()
        status, current = self._trust("ca-bundle.pem")
        self.assertEqual(status, 200)
        pem, spki, not_after = self._a_root(days=400)

        self._publish("ca-bundle.pem", current + pem)
        self._publish("manifest.json", json.dumps({
            "current": json.loads(self._trust("manifest.json")[1])["current"],
            "roots": json.loads(self._trust("manifest.json")[1])["roots"]
                + [{"spki_sha256": spki, "not_before": "2020-01-01T00:00:00.000Z",
                    "not_after": not_after.isoformat()}],
            "published_at": datetime.now(timezone.utc).isoformat(),
        }, indent=2) + "\n")

        status, body = sweep()
        self.assertEqual(status, 200, body)
        self.assertEqual(body["errors"], [], body)

        _, bundle = self._trust("ca-bundle.pem")
        self.assertIn(pem.strip(), bundle, "the previously published root was dropped while valid")
        _, manifest = self._trust("manifest.json")
        published = json.loads(manifest)
        self.assertIn(spki, [r["spki_sha256"] for r in published["roots"]])
        # The broker's own root stays first and stays `current`: the injected one is history.
        self.assertNotEqual(published["current"], spki)
        self.assertEqual(published["roots"][0]["spki_sha256"], published["current"])

    @unittest.skipIf(x509 is None, "the `cryptography` package is not installed")
    def test_a_root_that_has_expired_leaves_the_bundle(self):
        # The other half: the bundle is bounded. An expired root verifies nothing, so carrying it
        # forever would only make every appliance's trust store grow without limit.
        sweep()
        _, current = self._trust("ca-bundle.pem")
        pem, spki, _ = self._a_root(days=400)
        base = json.loads(self._trust("manifest.json")[1])

        self._publish("ca-bundle.pem", current + pem)
        self._publish("manifest.json", json.dumps({
            "current": base["current"],
            "roots": base["roots"] + [{
                "spki_sha256": spki,
                "not_before": "2020-01-01T00:00:00.000Z",
                # Dated as already gone, which is what the sweep acts on: the certificate's own
                # validity is never parsed here, only what the manifest beside it recorded.
                "not_after": (datetime.now(timezone.utc) - timedelta(days=1)).isoformat(),
            }],
            "published_at": datetime.now(timezone.utc).isoformat(),
        }, indent=2) + "\n")

        status, body = sweep()
        self.assertEqual(status, 200, body)
        _, bundle = self._trust("ca-bundle.pem")
        self.assertNotIn(pem.strip(), bundle, "an expired root was kept in the bundle")
        _, manifest = self._trust("manifest.json")
        self.assertNotIn(spki, [r["spki_sha256"] for r in json.loads(manifest)["roots"]])


class TestTheSchedule(ForgeSweepBase):
    def test_the_database_asks_for_a_sweep(self):
        """
        `true` is "asked", not "swept": net.http_post queues the call. What the call does is what
        every other test here asserts by making it directly.
        """
        status, answer = rest("/rpc/sweep_forge", method="POST", body={})
        self.assertEqual(status, 200, answer)
        self.assertTrue(answer, "sweep_forge() answered false: the Vault holds no sweep secret, so the schedule is inert")

    def test_the_call_the_database_queues_reaches_the_function(self):
        """
        "Asked" is not enough: pg_net records a call that never reached a server in
        net._http_response and tells no one. The address is the Vault's supabase_functions_url,
        which revoke_gateway_credential() posts to as well, so this covers both callers. The test
        holds the lease, so the function answers `already_sweeping` at once, which is an answer.
        """
        before = int(psql("SELECT coalesce(max(id), 0) FROM net._http_response") or 0)
        status, answer = rest("/rpc/sweep_forge", method="POST", body={})
        self.assertEqual(status, 200, answer)
        self.assertTrue(answer, "sweep_forge() answered false: the Vault holds no sweep secret")
        outcomes, deadline = [], time.monotonic() + 75  # the call's own timeout is 60s
        while not outcomes and time.monotonic() < deadline:
            time.sleep(1)
            outcomes = psql(f"SELECT coalesce(status_code::text, error_msg) FROM net._http_response "
                            f"WHERE id > {before} ORDER BY id").splitlines()
        self.assertTrue(outcomes, "pg_net recorded no outcome for the sweep within 75s")
        self.assertEqual([], [o for o in outcomes if not o.isdigit()],
                         "a call the database queued reached no server: check supabase_functions_url in the Vault")

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
