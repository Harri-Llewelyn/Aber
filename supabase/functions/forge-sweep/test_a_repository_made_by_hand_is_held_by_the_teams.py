# suite:
#   lanes: stack
#   why: A gateway's repository somebody made by hand. The forge makes its maker its administrator.
#     Enrolment takes it from them, whatever rules and default branch they left: the rules are Aber's,
#     `main` is the branch the appliance is told, and nothing reaches it without an Administrator's
#     approval, not their push, the key's or a manager's merge. One adopted before 1.9.1 is put right by
#     one sweep, after their role has gone too: their own API token opens nothing, an approval given
#     under their rule is dismissed and a key they added is removed. The approved flow still merges and
#     the appliance's report still goes through. Needs the stack, the forge, its SSH address and
#     FORGE_SWEEP_SECRET; signs no persona in to the forge.

"""
A gateway's repository is held by the forge's teams, and by nobody by name, against the live forge.

    SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... FORGE_SWEEP_SECRET=... \\
      GITEA_TEST_SSH=ssh://git@127.0.0.1:2222 python \\
      supabase/functions/forge-sweep/test_a_repository_made_by_hand_is_held_by_the_teams.py

The gateway, its key and the people are the suite's own, as test_a_tag_cannot_stand_in_for_a_gateways_branch.py
makes them. Each test makes the repository again.
"""
import json
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_a_tag_cannot_stand_in_for_a_gateways_branch as tags  # noqa: E402  -- not `from`: it has a test class

ORGANISATION = tags.ORGANISATION
FLOW_SHAPE_CONTEXT = tags.sweeping.FLOW_SHAPE_CONTEXT
forge = tags.sweeping.forge
OURS = {"main", "appliance", "**"}
PROTECTED = "protected branch"


class TestARepositoryMadeByHand(tags.GatewayRepository):
    GATEWAY_ID = "7ab0e000-0000-4000-8000-000000000001"
    GATEWAY_NAME = "Test_Forge_Made_By_Hand"
    PEOPLE = {
        "administrator": ("hand-suite-administrator", "administrators"),
        "maker": ("hand-suite-maker", "managers"),
        "manager": ("hand-suite-manager", "managers"),
    }

    def setUp(self):
        super().setUp()
        forge(self.path, method="DELETE")
        # A test that took the maker's role away gave it back, or died first.
        self.assertEqual(forge(self.seat("maker"), method="PUT")[0], 204)

    def made_by_the_maker(self):
        status, text = self.as_person("maker", f"/orgs/{ORGANISATION}/repos", method="POST", body={
            "name": self.repo, "private": True, "auto_init": True, "default_branch": "main"})
        self.assertEqual(status, 201, text[:200])
        self.assertTrue(json.loads(text)["permissions"]["admin"], "the forge no longer makes a maker the administrator")

    def as_maker(self, path, method, body, expected):
        status, text = self.as_person("maker", f"{self.path}{path}", method=method, body=body)
        self.assertIn(status, expected, f"{method} {path}: {text[:200]}")
        return text

    def move_the_default_branch(self):
        _, code, out = self.push("maker", "refs/heads/trunk")
        self.assertEqual(code, 0, out)
        for _ in range(20):
            text = self.as_maker("", "PATCH", {"default_branch": "trunk"}, (200,))
            if json.loads(text)["default_branch"] == "trunk":
                return
            time.sleep(0.5)
        self.fail("the forge did not move the default branch")

    def rules(self):
        status, rules = forge(f"{self.path}/branch_protections")
        self.assertEqual(status, 200, rules)
        return {r["rule_name"]: r for r in rules}

    def propose(self, who, branch):
        """A proposal by a person, with the shape status `main` requires."""
        sha, code, out = self.push(who, f"refs/heads/{branch}")
        self.assertEqual(code, 0, out)
        for _ in range(20):
            status, text = self.as_person(who, f"{self.path}/pulls", method="POST", body={"title": branch, "head": branch, "base": "main"})
            if status == 201:
                break
            time.sleep(0.5)
        self.assertEqual(status, 201, text[:200])
        status, answer = forge(f"{self.path}/statuses/{sha}", method="POST", body={"context": FLOW_SHAPE_CONTEXT, "state": "success"})
        self.assertEqual(status, 201, answer)
        return json.loads(text)["number"], sha

    def merge(self, who, number):
        """The merge's answer, once Gitea has finished looking at the proposal."""
        for _ in range(30):
            status, text = self.as_person(who, f"{self.path}/pulls/{number}/merge", method="POST", body={"do": "merge"})
            if status == 200 or "try again" not in text.lower():
                return status, text
            time.sleep(0.5)
        return status, text

    def approve(self, who, number):
        status, text = self.as_person(who, f"{self.path}/pulls/{number}/reviews", method="POST", body={"event": "APPROVED", "body": ""})
        self.assertEqual(status, 200, text[:200])

    def assert_held(self):
        """What is true of any gateway's repository after an enrolment or a pass."""
        status, holders = forge(f"{self.path}/collaborators")
        self.assertEqual((status, holders), (200, []))
        rules = self.rules()
        self.assertLessEqual(OURS, set(rules))
        main = rules["main"]
        self.assertFalse(main["enable_push"], main)
        self.assertGreaterEqual(main["required_approvals"], 1, main)
        self.assertTrue(main["enable_approvals_whitelist"], main)
        self.assertEqual((main["approvals_whitelist_teams"], main["approvals_whitelist_username"] or []), (["administrators"], []), main)
        self.assertTrue(main["dismiss_stale_approvals"], main)
        self.assertFalse(main["enable_bypass_allowlist"], main)
        self.assertEqual(main["unprotected_file_patterns"], "", main)
        self.assertLess(main["priority"], rules["**"]["priority"])
        self.assertLess(rules["appliance"]["priority"], rules["**"]["priority"])
        self.assertEqual(forge(self.path)[1]["default_branch"], "main")

    def assert_only_an_approval_reaches_main(self):
        before = self.refs()["refs/heads/main"]
        for who in ("box", "maker", "manager", "administrator"):
            _, code, out = self.push(who, "refs/heads/main")
            self.assertNotEqual(code, 0, f"{who} pushed to main")
            self.assertIn(PROTECTED, out, who)
        for path, method, body in (
            ("/branch_protections/main", "PATCH", {"required_approvals": 0}),
            ("/branch_protections", "POST", {"rule_name": "mai?", "enable_push": True}),
            ("/tag_protections", "POST", {"name_pattern": "*", "whitelist_teams": ["managers"]}),
            ("", "PATCH", {"default_branch": "trunk"}),
        ):
            self.as_maker(path, method, body, (403, 404))

        number, _ = self.propose("manager", "a-flow")
        self.approve("maker", number)
        status, text = self.merge("manager", number)
        self.assertEqual(status, 405, f"a manager's approval was enough: {text[:200]}")
        self.assertEqual(self.refs()["refs/heads/main"], before)
        # And the approved flow still arrives.
        self.approve("administrator", number)
        status, text = self.merge("manager", number)
        self.assertEqual(status, 200, text[:200])
        self.assertNotEqual(self.refs()["refs/heads/main"], before)

    def assert_the_report_goes_through(self):
        sha, code, out = self.push("box", "refs/heads/appliance")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.refs()["refs/heads/appliance"], sha)
        _, code, out = self.push("manager", "refs/heads/appliance", onto="appliance")
        self.assertIn(PROTECTED, out, "a person wrote the appliance's branch")

    def test_enrolment_takes_it_from_its_maker_whatever_they_left(self):
        self.made_by_the_maker()
        self.move_the_default_branch()
        self.as_maker("/branch_protections", "POST", {
            "rule_name": "main", "enable_push": True, "enable_push_whitelist": True,
            "push_whitelist_usernames": [self.PEOPLE["maker"][0]], "push_whitelist_deploy_keys": True,
            "required_approvals": 0, "unprotected_file_patterns": "**", "enable_bypass_allowlist": True,
            "bypass_allowlist_teams": ["managers"], "priority": 2000}, (201,))
        self.as_maker("/branch_protections", "POST", {"rule_name": "mai?", "enable_push": True, "priority": 1}, (201,))
        self.as_maker("/branch_protections", "POST", {"rule_name": "MAIN", "enable_push": True, "priority": 1}, (201,))
        self.assertEqual(self.push("maker", "refs/heads/main")[1], 0, "the maker's own rule did not admit them, so this proves nothing")

        told = self.enrol()
        self.assertEqual(told["branch"], "main", told)
        self.assert_held()
        self.assertEqual(set(self.rules()), OURS | {"trunk"})
        self.assert_only_an_approval_reaches_main()
        self.assert_the_report_goes_through()
        # The branch an appliance could have been told asks for the approval too.
        _, code, out = self.push("maker", "refs/heads/trunk", onto="trunk")
        self.assertIn(PROTECTED, out, "trunk takes a push")

    def test_enrolment_seeds_a_repository_whose_maker_s_rule_kept_everyone_else_out(self):
        self.made_by_the_maker()
        self.as_maker("/branch_protections", "POST", {
            "rule_name": "**", "enable_push": True, "enable_push_whitelist": True,
            "push_whitelist_usernames": [self.PEOPLE["maker"][0]], "priority": 1}, (201,))
        self.enrol()
        self.assert_held()
        self.assertEqual(set(self.rules()), OURS)
        status, tree = forge(f"{self.path}/git/trees/main?recursive=true")
        self.assertEqual(status, 200, tree)
        self.assertIn(".gitea/ISSUE_TEMPLATE/incident.md", [e["path"] for e in tree["tree"]])

    def adopted_before(self):
        """As 1.9.0 left a repository its maker made: enrolled, with the maker still its administrator."""
        self.enrol()
        login = self.PEOPLE["maker"][0]
        status, answer = forge(f"{self.path}/collaborators/{login}", method="PUT", body={"permission": "admin"})
        self.assertEqual(status, 204, answer)

    def test_a_sweep_takes_it_from_its_maker_after_their_role_has_gone(self):
        self.adopted_before()
        login = self.PEOPLE["maker"][0]
        self.move_the_default_branch()
        self.as_maker("/branch_protections/main", "PATCH", {
            "required_approvals": 1, "enable_approvals_whitelist": False, "dismiss_stale_approvals": False}, (200,))
        # An approval their rule counted, which the rule put back would go on counting.
        number, _ = self.propose("manager", "approved-by-the-maker")
        self.approve("maker", number)
        self.as_maker("/keys", "POST", {"title": "a key of the maker's", "key": self.make_key("extra"), "read_only": True}, (201,))
        # Their role goes. The forge's API still knows their token, and they are still its administrator.
        self.assertEqual(forge(self.seat("maker"), method="DELETE")[0], 204)
        self.addCleanup(forge, self.seat("maker"), method="PUT")
        self.as_maker("/branch_protections/main", "PATCH", {
            "unprotected_file_patterns": "**", "enable_bypass_allowlist": True, "bypass_allowlist_teams": ["managers"]}, (200,))
        self.as_maker("/branch_protections", "POST", {"rule_name": "mai?", "enable_push": True, "priority": 1}, (201,))
        self.assertEqual(self.push("box", "refs/heads/main")[1], 0, "the key was kept out, so this proves nothing")

        status, body = tags.sweeping.sweep()
        self.assertEqual(status, 200, body)
        self.assertIn(f"{login} from '{self.repo}'", body["removed"], body)
        for entry in (self.repo, f"{self.repo} (rules)", f"{self.repo} (default branch)"):
            self.assertIn(entry, body["protected"], body)
        self.assertIn(f"{self.repo}: 'a key of the maker's'", body["revoked"], body)
        self.assertFalse(any(entry.startswith(self.repo) for entry in body["errors"]), body)
        self.assert_held()

        # Their token opens nothing, and neither does what they approved.
        self.as_maker("/branch_protections/main", "PATCH", {"required_approvals": 0}, (403, 404))
        self.as_maker("", "GET", None, (404,))
        status, text = self.merge("manager", number)
        self.assertEqual(status, 405, f"the maker's approval still counts: {text[:200]}")
        for who in ("box", "manager"):
            _, code, out = self.push(who, "refs/heads/main")
            self.assertIn(PROTECTED, out, who)
        self.approve("administrator", number)
        status, text = self.merge("manager", number)
        self.assertEqual(status, 200, text[:200])
        self.assert_the_report_goes_through()
        status, keys = forge(f"{self.path}/keys")
        self.assertEqual([k["title"] for k in keys], [f"gateway {self.sparkplug_id}"], keys)

        status, body = tags.sweeping.sweep()
        self.assertEqual(status, 200, body)
        for field in ("removed", "protected", "revoked", "errors"):
            self.assertFalse(any(self.repo in entry for entry in body[field]), f"{field}: {body}")

    def test_an_archived_gateway_s_repository_is_taken_from_its_maker_too(self):
        """Who holds it could take it out of the forge's archive."""
        self.adopted_before()
        login = self.PEOPLE["maker"][0]
        row = f"/gateways?id=eq.{self.GATEWAY_ID}"
        self.assertIn(tags.rest(row, method="PATCH", body={"is_archived": True})[0], (200, 204))
        self.addCleanup(tags.rest, row, method="PATCH", body={"is_archived": False})
        status, body = tags.sweeping.sweep()
        self.assertEqual(status, 200, body)
        self.assertIn(f"{login} from '{self.repo}'", body["removed"], body)
        self.assertIn(self.repo, body["archived"], body)
        self.assertEqual(forge(f"{self.path}/collaborators"), (200, []))
        self.as_maker("", "PATCH", {"archived": False}, (403, 404))

    def test_a_rule_that_only_tightens_main_stays(self):
        self.enrol()
        status, answer = forge(f"{self.path}/branch_protections/main", method="PATCH", body={
            "required_approvals": 2, "status_check_contexts": [FLOW_SHAPE_CONTEXT, "site/extra-check"],
            "protected_file_patterns": "custom.yml", "unprotected_file_patterns": "*.md"})
        self.assertEqual(status, 200, answer)
        status, body = tags.sweeping.sweep()
        self.assertEqual(status, 200, body)
        self.assertIn(self.repo, body["protected"], body)
        main = self.rules()["main"]
        self.assertEqual((main["required_approvals"], main["protected_file_patterns"], main["unprotected_file_patterns"]),
                         (2, "custom.yml", ""), main)
        self.assertEqual(sorted(main["status_check_contexts"]), sorted([FLOW_SHAPE_CONTEXT, "site/extra-check"]), main)
        self.assert_held()


if __name__ == "__main__":
    unittest.main(verbosity=2)
