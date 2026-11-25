# suite:
#   lanes: stack
#   why: The sweep proposes a gateway's platform bump: a repository whose platform.yml names an older
#     release gets one pull request, the machine account's, and no second one from the next pass. A
#     member of administrators, and nobody before them, approves it and merges it. One a person
#     closed is not opened again, a tag somebody chose is left alone, and an older proposal is closed
#     for the newer one. Nobody else can write the branch it is made from, which is what stops an
#     Administrator approving a change of their own as Aber's. Needs the stack, the forge, the
#     organisation and FORGE_SWEEP_SECRET; signs nobody in.

"""
The platform bump the forge sweep proposes, against the live stack.

    SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... FORGE_SWEEP_SECRET=... \\
      python supabase/functions/forge-sweep/test_forge_sweep_proposes_the_platform_bump.py

The gateway is a row this suite adds and its repository one it makes by hand, on a tag older than the
stack's, so nothing is enrolled. The person is a forge login of the suite's own, seated in
`administrators`: not a dashboard identity, so a pass leaves the seat alone. Each test holds the sweep
lease, as test_forge_sweep.py's do, so the pass whose report it reads is its own.
"""
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_forge_sweep import (  # noqa: E402
    FLOW_SHAPE_CONTEXT, FORGE_URL, MACHINE_USER, ORGANISATION, PLATFORM_ORGANISATION, PLATFORM_REPOSITORY,
    ForgeSweepBase, as_forge_admin, check_sparkplug_id, forge, request, rest, sparkplug_id_of, stack_exec, sweep,
)

# The forge's SSH address from this host, as test_forge_events.py reads it.
FORGE_SSH = os.getenv("GITEA_TEST_SSH", "")

# Must agree with BUMP_BRANCH_PREFIX in _shared/platformBump.ts.
BRANCH_PREFIX = "aber-platform-"
RULE = f"{BRANCH_PREFIX}*"

# Differs from every other suite's fixture id in its first block: sparkplug_id is the first 21 hex
# characters of the uuid.
TEST_GW_ID = "f5b95000-0000-4000-8000-000000000001"
# A login of the suite's own. Not a uuid, so the sweep does not take it out of its team.
APPROVER = "bump-suite-approver"

# Older than any platform, with a comment, a quoted tag, Windows line endings and another `tag`: what
# the one-line change must leave as it was.
OLD_TAG = "v0.0.1"
POINTER = f'# canary\r\nplatform:\r\n  tag: "{OLD_TAG}" # by hand\r\n  vars:\r\n    tag: v0.0.2\r\n'


def pointer_naming(tag):
    return POINTER.replace(f'"{OLD_TAG}"', f'"{tag}"')


def encoded(text):
    return base64.b64encode(text.encode()).decode()


class TestThePlatformBump(ForgeSweepBase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.approver_token = None
        # One pass first: it publishes the playbook, whose tag is what the rest proposes.
        status, body = sweep()
        if status != 200:
            raise AssertionError(f"the sweep answered {status}: {body}")
        status, manifest = forge(f"/repos/{PLATFORM_ORGANISATION}/{PLATFORM_REPOSITORY}/contents/.aber/manifest.json")
        if status != 200:
            raise unittest.SkipTest("this stack publishes no platform playbook, so there is no tag to propose")
        cls.tag = f"v{json.loads(base64.b64decode(manifest['content']).decode())['version']}"
        if not re.fullmatch(r"v\d+\.\d+\.\d+", cls.tag):
            raise unittest.SkipTest(f"this stack's platform is at {cls.tag}, which is not a release, so nothing is proposed")

        cls.repo = f"gateway-{sparkplug_id_of(TEST_GW_ID)}"
        cls.path = f"/repos/{ORGANISATION}/{cls.repo}"
        cls.branch = f"{BRANCH_PREFIX}{cls.tag}"
        # Before the row is made, and after every line that skips. Run in reverse: the repository, then the row.
        cls.addClassCleanup(rest, f"/gateways?id=eq.{TEST_GW_ID}", method="DELETE")
        cls.addClassCleanup(forge, cls.path, method="DELETE")
        # What a run that was killed left behind.
        forge(cls.path, method="DELETE")
        rest(f"/gateways?id=eq.{TEST_GW_ID}", method="DELETE")
        status, rows = rest(
            "/gateways", method="POST", prefer="return=representation",
            body={"id": TEST_GW_ID, "name": "Test_Forge_Platform_Bump", "status": "OFFLINE", "deployment": "remote"},
        )
        if status >= 300:
            raise unittest.SkipTest(f"could not create the test gateway: {rows}")
        check_sparkplug_id(TEST_GW_ID, rows[0]["sparkplug_id"])
        cls.make_approver()

    @classmethod
    def make_approver(cls):
        """A forge login, made as the door makes one, seated in `administrators`, with a token to act with."""
        cls.addClassCleanup(cls.delete_approver)
        cls.delete_approver()
        stack_exec.output("forge", "curl", "-s", "-o", "/dev/null", "-H", f"X-WEBAUTH-USER: {APPROVER}", "http://127.0.0.1:3000/")
        status, answer = forge(cls.seat(), method="PUT")
        if status != 204:
            raise AssertionError(f"could not seat {APPROVER} in administrators ({status}): {answer}")
        # As git: gitea refuses to run as root. It prints the token alone, and the login's deletion
        # takes it.
        cls.approver_token = stack_exec.output(
            "forge", "su-exec", "git", "gitea", "admin", "user", "generate-access-token", "--username", APPROVER,
            "--token-name", "suite", "--scopes", "write:repository,write:issue", "--raw").strip()

    @classmethod
    def seat(cls):
        _, teams = forge(f"/orgs/{ORGANISATION}/teams?limit=50")
        return f"/teams/{next(t['id'] for t in teams if t['name'] == 'administrators')}/members/{APPROVER}"

    @classmethod
    def delete_approver(cls):
        """Out of the team first: Gitea keeps a login that is still a member of an organisation."""
        status, user = forge(f"/users/{APPROVER}")
        if status == 200:
            forge(cls.seat(), method="DELETE")
            as_forge_admin("-o", "/dev/null", "-X", "POST", f"http://127.0.0.1:3000/-/admin/users/{user['id']}/delete")

    @classmethod
    def as_approver(cls, path, method="GET", body=None):
        """The forge's API as the person, as `forge()` is it as the machine account."""
        status, _, text = request(f"{FORGE_URL}/api/v1{path}", method=method, body=body,
                                  headers={"Authorization": f"token {cls.approver_token}"})
        return status, (json.loads(text) if text.strip() else None)

    def make_repository(self, pointer=POINTER):
        """A gateway's repository made before its gateway enrolled, holding `pointer` as its platform.yml."""
        forge(self.path, method="DELETE")
        status, made = forge(f"/orgs/{ORGANISATION}/repos", method="POST", body={
            "name": self.repo, "private": True, "auto_init": True, "default_branch": "main"})
        self.assertEqual(status, 201, made)
        self.addCleanup(forge, self.path, method="DELETE")
        if pointer is None:
            # Protected already, so the pass does not seed the file this is to be without.
            status, rule = forge(f"{self.path}/branch_protections", method="POST",
                                 body={"rule_name": "main", "enable_push": False})
            self.assertEqual(status, 201, rule)
            return
        status, made = forge(f"{self.path}/contents/platform.yml", method="POST",
                             body={"content": encoded(pointer), "branch": "main", "message": "Point at a platform"})
        self.assertEqual(status, 201, made)

    def swept(self):
        """One pass, which did not fail on this repository. Its report."""
        status, body = sweep()
        self.assertEqual(status, 200, body)
        self.assertEqual([e for e in body["errors"] if self.repo in e], [], body)
        return body

    def proposed(self, body):
        return [entry for entry in body["proposed"] if entry.startswith(f"{self.repo}:")]

    def warned(self, body):
        return [entry for entry in body["warnings"] if entry.startswith(f"{self.repo}:")]

    def pulls(self):
        status, pulls = forge(f"{self.path}/pulls?state=all&limit=50")
        self.assertEqual(status, 200, pulls)
        return pulls

    def text_at(self, branch):
        status, file = forge(f"{self.path}/contents/platform.yml?ref={urllib.parse.quote(branch, safe='')}")
        self.assertEqual(status, 200, file)
        return base64.b64decode(file["content"]).decode()

    def until(self, what, ask, seconds=30):
        """Ask until it answers something true, or fail naming it."""
        deadline = time.monotonic() + seconds
        while True:
            answer = ask()
            if answer:
                return answer
            if time.monotonic() > deadline:
                self.fail(f"{what} within {seconds}s")
            time.sleep(0.5)

    def flow_shape(self, sha):
        _, statuses = forge(f"{self.path}/statuses/{sha}")
        return next((s["status"] for s in statuses or [] if s["context"] == FLOW_SHAPE_CONTEXT), None)

    def mergeable(self, number):
        """Gitea tests a new pull request for conflicts after answering; a merge asked before that is 405."""
        return self.until(f"#{number} became mergeable", lambda: forge(f"{self.path}/pulls/{number}")[1].get("mergeable"))

    def test_an_older_gateway_is_proposed_the_platform_once_and_an_administrator_merges_it(self):
        self.make_repository()
        body = self.swept()
        self.assertEqual(len(self.proposed(body)), 1, body)
        self.assertEqual(self.warned(body), [], body)

        (pull,) = self.pulls()
        self.assertEqual((pull["state"], pull["user"]["login"], pull["head"]["label"], pull["base"]["ref"]),
                         ("open", MACHINE_USER, self.branch, "main"), pull)
        self.assertIn(OLD_TAG, pull["body"])
        self.assertIn(self.tag, pull["title"])
        # One line of one file, and every other byte of it as it was.
        _, files = forge(f"{self.path}/pulls/{pull['number']}/files")
        self.assertEqual([(f["filename"], f["additions"], f["deletions"]) for f in files], [("platform.yml", 1, 1)])
        self.assertEqual(self.text_at(self.branch), pointer_naming(self.tag))
        self.assertEqual(self.text_at("main"), POINTER, "the pass changed main itself")

        # The next pass has nothing to say about it.
        body = self.swept()
        self.assertEqual(self.proposed(body), [], body)
        self.assertEqual(len(self.pulls()), 1)

        # The status main requires is posted for the machine account's push as for anybody's.
        _, hooks = forge(f"{self.path}/hooks")
        if not [h for h in hooks if h["config"]["url"].endswith("/forge-events")]:
            self.skipTest("the sweep registered no hook; GITEA_WEBHOOK_SECRET is unset on this stack")
        self.until(f"{FLOW_SHAPE_CONTEXT} was posted", lambda: self.flow_shape(pull["head"]["sha"]) == "success")

        # Not before an Administrator approves it: nor may the machine account approve its own.
        merge = (f"{self.path}/pulls/{pull['number']}/merge", "POST", {"Do": "merge"})
        review = (f"{self.path}/pulls/{pull['number']}/reviews", "POST", {"event": "APPROVED", "body": "ok"})
        self.mergeable(pull["number"])
        status, answer = self.as_approver(*merge)
        self.assertEqual(status, 405, answer)
        status, answer = forge(*review)
        self.assertEqual(status, 422, answer)
        status, answer = self.as_approver(*review)
        self.assertEqual(status, 200, answer)
        self.assertTrue(answer["official"], "an approval by a member of administrators did not count")
        status, answer = self.as_approver(*merge)
        self.assertEqual(status, 200, answer)
        self.assertEqual(self.text_at("main"), pointer_naming(self.tag))

        body = self.swept()
        self.assertEqual(self.proposed(body), [], body)
        self.assertEqual([p["number"] for p in self.pulls()], [pull["number"]])

    def test_nobody_else_can_write_what_is_proposed(self):
        """
        THE BRANCH IS THE MACHINE ACCOUNT'S ALONE. An Administrator who could write it would approve
        their own change as Aber's, which is the rule on `main` undone. A commit is refused, and so is
        a pull request merged into the branch, which is not a push.
        """
        self.make_repository()
        self.swept()
        status, rule = forge(f"{self.path}/branch_protections/{urllib.parse.quote(RULE, safe='')}")
        self.assertEqual(status, 200, rule)
        for allowed in ("push_whitelist_usernames", "merge_whitelist_usernames"):
            self.assertEqual(rule[allowed], [MACHINE_USER], rule)
        for nobody in ("push_whitelist_teams", "merge_whitelist_teams"):
            self.assertEqual(rule[nobody] or [], [], rule)
        for on in ("enable_push", "enable_push_whitelist", "enable_merge_whitelist"):
            self.assertTrue(rule[on], rule)
        for off in ("push_whitelist_deploy_keys", "enable_force_push", "enable_bypass_allowlist"):
            self.assertFalse(rule[off], rule)
        status, catch_all = forge(f"{self.path}/branch_protections/{urllib.parse.quote('**', safe='')}")
        self.assertEqual(status, 200, catch_all)
        self.assertLess(rule["priority"], catch_all["priority"], "the catch-all would decide first")

        _, file = forge(f"{self.path}/contents/platform.yml?ref={self.branch}")
        change = {"content": encoded("platform:\n  tag: mine\n"), "sha": file["sha"], "branch": self.branch, "message": "Mine"}
        status, answer = self.as_approver(f"{self.path}/contents/platform.yml", "PUT", change)
        self.assertEqual(status, 403, f"an Administrator committed to Aber's branch: {answer}")
        status, answer = self.as_approver(f"{self.path}/contents/platform.yml", "PUT", {**change, "new_branch": f"{BRANCH_PREFIX}v99.0.0"})
        self.assertGreaterEqual(status, 400, f"an Administrator made a branch of Aber's: {answer}")

        status, answer = self.as_approver(f"{self.path}/contents/platform.yml", "PUT", {**change, "new_branch": "mine"})
        self.assertEqual(status, 200, answer)
        status, mine = self.as_approver(f"{self.path}/pulls", "POST", {"head": "mine", "base": self.branch, "title": "Into Aber's"})
        self.assertEqual(status, 201, mine)
        self.mergeable(mine["number"])
        for force in (False, True):
            status, answer = self.as_approver(f"{self.path}/pulls/{mine['number']}/merge", "POST", {"Do": "merge", "force_merge": force})
            self.assertEqual(status, 405, f"an Administrator merged into Aber's branch: {answer}")
        self.assertEqual(self.text_at(self.branch), pointer_naming(self.tag))

        # The rule opened by hand is closed again by the next pass.
        status, _ = forge(f"{self.path}/branch_protections/{urllib.parse.quote(RULE, safe='')}", method="PATCH",
                          body={"enable_merge_whitelist": False, "push_whitelist_teams": ["administrators"]})
        self.assertEqual(status, 200)
        body = self.swept()
        self.assertIn(f"{self.repo} (platform bumps)", body["protected"], body)
        status, rule = forge(f"{self.path}/branch_protections/{urllib.parse.quote(RULE, safe='')}")
        self.assertTrue(rule["enable_merge_whitelist"], rule)
        self.assertEqual(rule["push_whitelist_teams"] or [], [], rule)
        self.assertNotIn(f"{self.repo} (platform bumps)", self.swept()["protected"])

    @unittest.skipIf(not FORGE_SSH, "GITEA_TEST_SSH must name the forge's SSH address as reachable from this host")
    def test_the_appliances_key_gains_nothing(self):
        """The writable key an appliance holds on its own repository: no branch of Aber's is open to it."""
        self.make_repository()
        self.swept()
        work = tempfile.mkdtemp(prefix="aber-platform-bump-")
        self.addCleanup(shutil.rmtree, work, ignore_errors=True)
        key, clone = os.path.join(work, "id_ed25519"), os.path.join(work, "repo")
        subprocess.run(["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "test", "-f", key], check=True, capture_output=True)
        with open(f"{key}.pub", encoding="utf-8") as handle:
            public_key = handle.read().strip()
        # After the pass, so no pass registers it on the platform repository; it goes with this one.
        status, answer = forge(f"{self.path}/keys", method="POST", body={"title": "bump suite", "key": public_key, "read_only": False})
        self.assertEqual(status, 201, answer)
        known_hosts = os.path.join(work, "known_hosts")
        env = {**os.environ, "GIT_TERMINAL_PROMPT": "0",
               "GIT_SSH_COMMAND": f'ssh -i "{key}" -o IdentitiesOnly=yes -o UserKnownHostsFile="{known_hosts}" '
                                  "-o StrictHostKeyChecking=no -o BatchMode=yes"}

        def git(*args, cwd=clone):
            result = subprocess.run(["git", *args], cwd=cwd, env=env, capture_output=True, text=True)
            return result.returncode, (result.stdout + result.stderr).strip()

        code, out = git("clone", "--quiet", "--branch", self.branch, f"{FORGE_SSH.rstrip('/')}/{self.path.removeprefix('/repos/')}.git", clone, cwd=work)
        self.assertEqual(code, 0, out)
        code, out = git("-c", "user.name=gateway", "-c", "user.email=appliance@aber.invalid", "commit", "--quiet",
                        "--allow-empty", "-m", "From the appliance")
        self.assertEqual(code, 0, out)
        for push in ([f"HEAD:{self.branch}"], [f"HEAD:refs/heads/{BRANCH_PREFIX}v99.0.0"],
                     ["--delete", self.branch], ["--force", f"origin/main:{self.branch}"]):
            code, out = git("push", "--quiet", "origin", *push)
            self.assertNotEqual(code, 0, f"the deploy key pushed {push}")
            self.assertIn("protected", out, push)
        self.assertEqual(self.text_at(self.branch), pointer_naming(self.tag))

    def test_one_a_person_closed_is_not_opened_again(self):
        self.make_repository()
        self.swept()
        (pull,) = self.pulls()
        status, answer = self.as_approver(f"{self.path}/pulls/{pull['number']}", "PATCH", {"state": "closed"})
        self.assertEqual(status, 201, answer)

        body = self.swept()
        self.assertEqual(self.proposed(body), [], body)
        self.assertEqual([(p["number"], p["state"]) for p in self.pulls()], [(pull["number"], "closed")])

        # They may change their mind, and Aber leaves that open too.
        status, answer = self.as_approver(f"{self.path}/pulls/{pull['number']}", "PATCH", {"state": "open"})
        self.assertEqual(status, 201, answer)
        self.assertEqual(self.proposed(self.swept()), [])
        self.assertEqual([p["state"] for p in self.pulls()], ["open"])

    def test_a_tag_somebody_chose_is_left_alone(self):
        for chosen in ("my-branch", f"{self.tag}-rc.1", "v999.0.0", self.tag):
            with self.subTest(tag=chosen):
                self.make_repository(pointer_naming(chosen))
                body = self.swept()
                self.assertEqual(self.proposed(body), [], body)
                self.assertEqual(self.warned(body), [], body)
                self.assertEqual(self.pulls(), [])
                self.assertEqual(self.text_at("main"), pointer_naming(chosen))

    def test_a_platform_yml_that_cannot_be_changed_is_declined(self):
        for what, pointer in (("missing", None), ("two tags", f"platform:\n  tag: {OLD_TAG}\n  tag: {OLD_TAG}\n")):
            with self.subTest(what):
                self.make_repository(pointer)
                body = self.swept()
                self.assertEqual(self.proposed(body), [], body)
                self.assertEqual(len(self.warned(body)), 1, body)
                self.assertIn("platform.yml", self.warned(body)[0])
                self.assertEqual(self.pulls(), [])

    def test_an_older_proposal_is_closed_for_the_newer_one_and_a_persons_is_left(self):
        self.make_repository()
        self.swept()
        (current,) = self.pulls()
        # What the passes before an upgrade left: the machine account's pull request for an older tag.
        _, file = forge(f"{self.path}/contents/platform.yml?ref=main")
        status, made = forge(f"{self.path}/contents/platform.yml", method="PUT", body={
            "content": encoded(pointer_naming("v0.0.9")), "sha": file["sha"], "branch": "main",
            "new_branch": f"{BRANCH_PREFIX}v0.0.9", "message": "Converge to the platform at v0.0.9"})
        self.assertEqual(status, 200, made)
        status, older = forge(f"{self.path}/pulls", method="POST", body={
            "head": f"{BRANCH_PREFIX}v0.0.9", "base": "main", "title": "Converge to the platform at v0.0.9"})
        self.assertEqual(status, 201, older)
        # And a person's own, which is not Aber's to close.
        status, made = self.as_approver(f"{self.path}/contents/platform.yml", "PUT", {
            "content": encoded(pointer_naming("v0.0.8")), "sha": file["sha"], "branch": "main",
            "new_branch": "by-hand", "message": "By hand"})
        self.assertEqual(status, 200, made)
        status, theirs = self.as_approver(f"{self.path}/pulls", "POST", {"head": "by-hand", "base": "main", "title": "By hand"})
        self.assertEqual(status, 201, theirs)

        body = self.swept()
        self.assertEqual(len(self.proposed(body)), 1, body)
        states = {p["number"]: p["state"] for p in self.pulls()}
        self.assertEqual(states, {current["number"]: "open", older["number"]: "closed", theirs["number"]: "open"})
        _, comments = forge(f"{self.path}/issues/{older['number']}/comments")
        self.assertEqual([c["user"]["login"] for c in comments], [MACHINE_USER], comments)
        self.assertIn(f"#{current['number']}", comments[0]["body"])
        self.assertEqual(self.proposed(self.swept()), [])

    def test_a_branch_of_the_name_that_holds_something_else_is_not_proposed(self):
        self.make_repository()
        _, file = forge(f"{self.path}/contents/platform.yml?ref=main")
        status, made = forge(f"{self.path}/contents", method="POST", body={
            "branch": "main", "new_branch": self.branch, "message": "More than the tag", "files": [
                {"operation": "update", "path": "platform.yml", "sha": file["sha"], "content": encoded(pointer_naming(self.tag))},
                {"operation": "create", "path": "custom.yml", "content": encoded("- hosts: localhost\n")}]})
        self.assertEqual(status, 201, made)
        body = self.swept()
        self.assertEqual(self.proposed(body), [], body)
        self.assertEqual(len(self.warned(body)), 1, body)
        self.assertEqual(self.pulls(), [], "Aber proposed a change it did not make")

    def test_a_branch_a_pass_left_without_its_pull_request_is_proposed(self):
        self.make_repository()
        _, file = forge(f"{self.path}/contents/platform.yml?ref=main")
        status, made = forge(f"{self.path}/contents/platform.yml", method="PUT", body={
            "content": encoded(pointer_naming(self.tag)), "sha": file["sha"], "branch": "main",
            "new_branch": self.branch, "message": f"Converge to the platform at {self.tag}"})
        self.assertEqual(status, 200, made)
        self.assertEqual(len(self.proposed(self.swept())), 1)
        (pull,) = self.pulls()
        self.assertEqual((pull["user"]["login"], pull["head"]["label"]), (MACHINE_USER, self.branch))

    def test_a_gateway_that_is_not_remote_is_proposed_nothing(self):
        self.make_repository()
        status, _ = rest(f"/gateways?id=eq.{TEST_GW_ID}", method="PATCH", body={"deployment": "host"})
        self.assertIn(status, (200, 204))
        try:
            body = self.swept()
            self.assertEqual(self.proposed(body), [], body)
            self.assertEqual(self.pulls(), [])
        finally:
            rest(f"/gateways?id=eq.{TEST_GW_ID}", method="PATCH", body={"deployment": "remote"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
