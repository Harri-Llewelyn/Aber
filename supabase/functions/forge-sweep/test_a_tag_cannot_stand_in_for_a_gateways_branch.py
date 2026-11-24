# suite:
#   lanes: stack
#   why: The tags of a gateway's repository. Branch rules do not cover them, and Git takes a short name
#     for a tag before a branch. After enrolment nobody makes a tag named as a branch the appliance
#     reads, in any case: not its key, not a member of either team, by a push, through the API, or as a
#     release. The key makes no tag at all, and a person still makes every other. A tag planted under
#     such a name is removed by one sweep, with the release made from it, and named with its commit;
#     a rule taken away or widened is put back, and any other is removed. The appliance's report still
#     goes through. Needs the stack, the forge, its SSH address and FORGE_SWEEP_SECRET; signs no
#     persona in to the forge.

"""
No tag stands in for a gateway's branch, against the live forge.

    SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... FORGE_SWEEP_SECRET=... \\
      GITEA_TEST_SSH=ssh://git@127.0.0.1:2222 python \\
      supabase/functions/forge-sweep/test_a_tag_cannot_stand_in_for_a_gateways_branch.py

The gateway is enrolled with a key of the suite's own. The two people are forge logins of its own, one
in each team and neither a dashboard identity, so a pass leaves their seats alone. Every test holds the
sweep lease, as test_forge_sweep.py's do, so the pass whose report it reads is its own.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_forge_sweep as sweeping  # noqa: E402  -- not `from`, which would collect its test classes
from test_enroll_gateway import delete_broker_account, enroll, rest, sign_in  # noqa: E402
from test_forge_membership import MACHINE_USER, ORGANISATION, request, skip_or_fail  # noqa: E402
import stack_exec  # noqa: E402
import stack_sign_in  # noqa: E402

# The forge's SSH address from this host, as test_forge_events.py reads it.
FORGE_SSH = os.getenv("GITEA_TEST_SSH", "")

# Differs from every other suite's fixture id in its first block: sparkplug_id is the first 21 hex
# characters of the uuid.
TEST_GW_ID = "7a95f000-0000-4000-8000-000000000001"

# Must agree with READ_BRANCHES in _shared/forge.ts.
BRANCHES = ("main", "appliance")
# Forge logins of the suite's own, by team.
PEOPLE = {"administrators": "tag-suite-administrator", "managers": "tag-suite-manager"}
REFUSED = "is protected"


def gitea(*args):
    """Gitea's own command line in the forge's pod, as git: it refuses to run as root."""
    return stack_exec.run("forge", "su-exec", "git", "gitea", *args)


@unittest.skipIf(not FORGE_SSH, "GITEA_TEST_SSH must name the forge's SSH address as reachable from this host")
class TestTheTagsOfAGatewaysRepository(sweeping.ForgeSweepBase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        try:
            cls.admin_token = sign_in()
        except stack_sign_in.RateLimited:
            raise
        except Exception as err:  # noqa: BLE001
            skip_or_fail(f"could not sign in as the seeded administrator ({err})")
        cls.work = tempfile.mkdtemp(prefix="aber-tags-")
        cls.addClassCleanup(shutil.rmtree, cls.work, ignore_errors=True)
        rest(f"/gateways?id=eq.{TEST_GW_ID}", method="DELETE")
        status, rows = rest(
            "/gateways", method="POST", prefer="return=representation",
            body={"id": TEST_GW_ID, "name": "Test_Forge_Tags", "status": "OFFLINE", "deployment": "remote"},
        )
        if status >= 300:
            raise unittest.SkipTest(f"could not create the test gateway: {rows}")
        cls.sparkplug_id = rows[0]["sparkplug_id"]
        cls.repo = f"gateway-{cls.sparkplug_id}"
        cls.path = f"/repos/{ORGANISATION}/{cls.repo}"
        # Run in reverse: the repository, the row, then the broker account that outlives it.
        cls.addClassCleanup(delete_broker_account, cls.sparkplug_id)
        cls.addClassCleanup(rest, f"/gateways?id=eq.{TEST_GW_ID}", method="DELETE")
        cls.addClassCleanup(sweeping.forge, cls.path, method="DELETE")
        sweeping.forge(cls.path, method="DELETE")

        # "box" is the appliance, by its deploy key.
        cls.public = {who: cls.make_key(who) for who in ("box", *PEOPLE)}
        _, issued = rest("/rpc/issue_gateway_enrollment_token", method="POST", bearer=cls.admin_token,
                         body={"p_gateway_id": TEST_GW_ID, "p_ttl_minutes": 30})
        status, payload = enroll(issued[0]["token"], ssh_public_key=cls.public["box"])
        if status != 200 or not payload.get("repository"):
            raise AssertionError(f"enrolment gave no repository ({status}): {payload}")
        cls.tokens = {}
        for team in PEOPLE:
            cls.make_person(team)

    @classmethod
    def make_key(cls, who):
        path = os.path.join(cls.work, who)
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", who, "-f", path], check=True, capture_output=True)
        with open(f"{path}.pub", encoding="utf-8") as handle:
            return handle.read().strip()

    @classmethod
    def make_person(cls, team):
        login = PEOPLE[team]
        cls.addClassCleanup(cls.delete_person, team)
        cls.delete_person(team)
        made = gitea("admin", "user", "create", "--username", login, "--email", f"{login}@aber.invalid",
                     "--random-password", "--must-change-password=false")
        if made.returncode != 0:
            raise AssertionError(f"could not make {login}: {made.stdout}{made.stderr}")
        status, answer = sweeping.forge(cls.seat(team), method="PUT")
        if status != 204:
            raise AssertionError(f"could not seat {login} in {team} ({status}): {answer}")
        cls.tokens[team] = gitea("admin", "user", "generate-access-token", "--username", login, "--token-name", "suite",
                                 "--scopes", "write:repository,write:user", "--raw").stdout.strip()
        status, answer = cls.as_person(team, "/user/keys", method="POST", body={"title": "suite", "key": cls.public[team]})
        if status != 201:
            raise AssertionError(f"could not give {login} a key ({status}): {answer}")

    @classmethod
    def seat(cls, team):
        _, teams = sweeping.forge(f"/orgs/{ORGANISATION}/teams?limit=50")
        return f"/teams/{next(t['id'] for t in teams if t['name'] == team)}/members/{PEOPLE[team]}"

    @classmethod
    def delete_person(cls, team):
        """Out of the team first: Gitea keeps a login that is still a member of an organisation."""
        status, _ = sweeping.forge(f"/users/{PEOPLE[team]}")
        if status == 200:
            sweeping.forge(cls.seat(team), method="DELETE")
            gitea("admin", "user", "delete", "--username", PEOPLE[team])

    @classmethod
    def as_person(cls, team, path, method="GET", body=None):
        status, _, text = request(f"{sweeping.FORGE_URL}/api/v1{path}", method=method, body=body,
                                  headers={"Authorization": f"token {cls.tokens[team]}"})
        return status, text

    def git(self, who, *args, cwd=None):
        env = {
            **os.environ,
            "GIT_SSH_COMMAND": f'ssh -i "{os.path.join(self.work, who)}" -o IdentitiesOnly=yes -o UserKnownHostsFile=/dev/null '
                               "-o StrictHostKeyChecking=no -o BatchMode=yes -o LogLevel=ERROR",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_AUTHOR_NAME": who, "GIT_AUTHOR_EMAIL": f"{who}@aber.invalid",
            "GIT_COMMITTER_NAME": who, "GIT_COMMITTER_EMAIL": f"{who}@aber.invalid",
        }
        result = subprocess.run(["git", *args], cwd=cwd or self.work, env=env, capture_output=True, text=True)
        return result.returncode, (result.stdout + result.stderr).strip()

    def refs(self):
        """What the forge holds, as Git says it."""
        code, out = self.git("box", "ls-remote", self.url())
        self.assertEqual(code, 0, out)
        return {ref: sha for sha, ref in (line.split("\t") for line in out.splitlines() if "\t" in line)}

    def url(self):
        return f"{FORGE_SSH.rstrip('/')}/{ORGANISATION}/{self.repo}.git"

    def push(self, who, *refs):
        """Push one commit on top of `main`, which nobody approved, to each ref. The commit, and what Git said."""
        clone = tempfile.mkdtemp(prefix="clone-", dir=self.work)
        code, out = self.git(who, "clone", "--quiet", self.url(), clone)
        self.assertEqual(code, 0, out)
        self.assertEqual(self.git(who, "commit", "--quiet", "--allow-empty", "-m", "never approved", cwd=clone)[0], 0)
        _, sha = self.git(who, "rev-parse", "HEAD", cwd=clone)
        code, out = self.git(who, "push", "--quiet", "origin", *[f"HEAD:{ref}" for ref in refs], cwd=clone)
        return sha, code, out

    def take_the_rules_away(self):
        """The repository as 1.9.0 and before left it."""
        _, rules = sweeping.forge(f"{self.path}/tag_protections")
        for rule in rules:
            self.assertEqual(sweeping.forge(f"{self.path}/tag_protections/{rule['id']}", method="DELETE")[0], 204)

    def rules(self):
        status, rules = sweeping.forge(f"{self.path}/tag_protections")
        self.assertEqual(status, 200, rules)
        return rules

    def test_nobody_makes_a_tag_named_as_a_branch_the_appliance_reads(self):
        for who in ("box", *PEOPLE):
            for name in (*BRANCHES, "Main", "APPLIANCE"):
                _, code, out = self.push(who, f"refs/tags/{name}")
                self.assertNotEqual(code, 0, f"{who} pushed a tag named {name}")
                self.assertIn(REFUSED, out, f"{who}, {name}")
        for team in PEOPLE:
            for name in BRANCHES:
                status, text = self.as_person(team, f"{self.path}/tags", method="POST", body={"tag_name": name, "target": "main"})
                self.assertEqual(status, 422, f"{team} made a tag named {name}: {text[:200]}")
                status, text = self.as_person(team, f"{self.path}/releases", method="POST",
                                              body={"tag_name": name, "target_commitish": "main", "name": "release"})
                self.assertEqual(status, 422, f"{team} made a release of {name}: {text[:200]}")
        self.assertEqual([ref for ref in self.refs() if ref.startswith("refs/tags/")], [])

    def test_the_key_makes_no_tag_and_a_person_makes_every_other(self):
        for name in ("v1", "release/one", "mainline"):
            _, code, out = self.push("box", f"refs/tags/{name}")
            self.assertNotEqual(code, 0, f"the key pushed a tag named {name}")
            self.assertIn(REFUSED, out, name)
        _, code, out = self.push("managers", "refs/tags/v2")
        self.assertEqual(code, 0, out)
        status, text = self.as_person("managers", f"{self.path}/releases", method="POST",
                                      body={"tag_name": "v3", "target_commitish": "main", "name": "release 3"})
        self.assertEqual(status, 201, text[:200])
        status, text = self.as_person("administrators", f"{self.path}/tags", method="POST", body={"tag_name": "v4", "target": "main"})
        self.assertEqual(status, 201, text[:200])
        self.assertLessEqual({"refs/tags/v2", "refs/tags/v3", "refs/tags/v4"}, set(self.refs()))

        # And a pass leaves every one of them.
        status, body = sweeping.sweep()
        self.assertEqual(status, 200, body)
        self.assertFalse(any(entry.startswith(self.repo) for entry in body["untagged"]), body)
        self.assertLessEqual({"refs/tags/v2", "refs/tags/v3", "refs/tags/v4"}, set(self.refs()))

        status, text = self.as_person("managers", f"{self.path}/tags/v2", method="DELETE")
        self.assertEqual(status, 204, text[:200])
        self.as_person("administrators", f"{self.path}/releases/tags/v3", method="DELETE")
        for name in ("v3", "v4"):
            self.as_person("administrators", f"{self.path}/tags/{name}", method="DELETE")

    def test_a_planted_tag_is_removed_by_one_pass_and_named(self):
        self.take_the_rules_away()
        planted = {}
        planted["main"], code, out = self.push("managers", "refs/tags/main")
        self.assertEqual(code, 0, out)
        planted["appliance"], code, out = self.push("box", "refs/tags/appliance")
        self.assertEqual(code, 0, out)
        self.assertNotEqual(self.refs()["refs/tags/main"], self.refs()["refs/heads/main"])
        # Gitea records a pushed tag in a queue, and deletes one it has recorded.
        time.sleep(3)

        status, body = sweeping.sweep()
        self.assertEqual(status, 200, body)
        self.assertIn(f"{self.repo} (tags)", body["protected"], body)
        for name, sha in planted.items():
            self.assertIn(f"{self.repo}: '{name}' at {sha}", body["untagged"], body)
        self.assertEqual([ref for ref in self.refs() if ref.startswith("refs/tags/")], [])
        self.assertFalse(any(entry.startswith(self.repo) for entry in body["errors"]), body)

        # Closed, and quiet.
        _, code, out = self.push("managers", "refs/tags/main")
        self.assertIn(REFUSED, out)
        status, body = sweeping.sweep()
        self.assertEqual(status, 200, body)
        self.assertFalse(any(entry.startswith(self.repo) for entry in body["untagged"]), body)
        self.assertNotIn(f"{self.repo} (tags)", body["protected"], body)

    def test_a_planted_tag_goes_with_the_release_made_from_it(self):
        self.take_the_rules_away()
        status, text = self.as_person("managers", f"{self.path}/releases", method="POST",
                                      body={"tag_name": "main", "target_commitish": "main", "name": "release", "body": "notes"})
        self.assertEqual(status, 201, text[:200])

        status, body = sweeping.sweep()
        self.assertEqual(status, 200, body)
        self.assertTrue(any(entry.startswith(f"{self.repo}: 'main' at ") for entry in body["untagged"]), body)
        self.assertNotIn("refs/tags/main", self.refs())
        _, releases = sweeping.forge(f"{self.path}/releases")
        self.assertEqual([r["tag_name"] for r in releases], [], releases)

    def test_a_widened_rule_is_put_back_and_any_other_is_removed(self):
        before = self.rules()
        self.assertEqual(len(before), 2, before)
        (reserved,) = [r for r in before if r["whitelist_usernames"] == [MACHINE_USER]]
        status, answer = sweeping.forge(f"{self.path}/tag_protections/{reserved['id']}", method="PATCH",
                                        body={"whitelist_teams": ["managers"]})
        self.assertEqual(status, 200, answer)
        status, answer = sweeping.forge(f"{self.path}/tag_protections", method="POST",
                                        body={"name_pattern": "*", "whitelist_teams": ["managers"]})
        self.assertEqual(status, 201, answer)

        status, body = sweeping.sweep()
        self.assertEqual(status, 200, body)
        self.assertIn(f"{self.repo} (tags)", body["protected"], body)

        def shape(rules):
            return sorted((r["name_pattern"], tuple(r["whitelist_usernames"] or []), tuple(sorted(r["whitelist_teams"] or []))) for r in rules)
        self.assertEqual(shape(self.rules()), shape(before))
        _, code, out = self.push("managers", "refs/tags/main")
        self.assertNotEqual(code, 0)
        self.assertIn(REFUSED, out)

    def test_the_appliance_s_report_goes_through_by_its_branch_s_full_name(self):
        sha, code, out = self.push("box", "refs/heads/appliance")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.refs()["refs/heads/appliance"], sha)


if __name__ == "__main__":
    unittest.main(verbosity=2)
