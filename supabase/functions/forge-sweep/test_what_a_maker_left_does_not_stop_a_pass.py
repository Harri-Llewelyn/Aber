# suite:
#   lanes: stack
#   why: What somebody who held a gateway's repository could leave on it that would keep a pass from
#     putting it right, through the gateway's own forge-api listener, which is stricter about a path than
#     the forge. A rule with a slash in its name is removed. One whose name no path carries costs the
#     repository its deploy keys, is an error, and removes nothing else: a rule named `..` least of all.
#     Proposals turned off are turned on. A repository that was renamed has its name back. Needs the
#     stack, the forge, its SSH address and FORGE_SWEEP_SECRET; signs no persona in to the forge.

"""
A pass gets past what a maker left on a gateway's repository, against the live forge.

    SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... FORGE_SWEEP_SECRET=... \\
      GITEA_TEST_SSH=ssh://git@127.0.0.1:2222 python \\
      supabase/functions/forge-sweep/test_what_a_maker_left_does_not_stop_a_pass.py

The gateway, its key and the person are the suite's own, as test_a_tag_cannot_stand_in_for_a_gateways_branch.py
makes them. Each test enrols it into a new repository, which the person then holds as a maker did before 1.9.1.
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_a_tag_cannot_stand_in_for_a_gateways_branch as tags  # noqa: E402  -- not `from`: it has a test class

ORGANISATION = tags.ORGANISATION
forge = tags.sweeping.forge
OURS = ["**", "appliance", "main"]
OPEN = {"enable_push": True, "priority": -5}


class TestWhatAMakerLeft(tags.GatewayRepository):
    GATEWAY_ID = "7ac1e000-0000-4000-8000-000000000001"
    GATEWAY_NAME = "Test_Forge_What_A_Maker_Left"
    PEOPLE = {"maker": ("left-suite-maker", "managers"), "manager": ("left-suite-manager", "managers")}

    def setUp(self):
        super().setUp()
        self.other = f"line-three-{self.sparkplug_id}"
        for name in (self.repo, self.other):
            forge(f"/repos/{ORGANISATION}/{name}", method="DELETE")
        self.addCleanup(forge, f"/repos/{ORGANISATION}/{self.other}", method="DELETE")
        self.enrol()
        login = self.PEOPLE["maker"][0]
        status, answer = forge(f"{self.path}/collaborators/{login}", method="PUT", body={"permission": "admin"})
        self.assertEqual(status, 204, answer)

    def as_maker(self, path, method, body, expected, at=None):
        status, text = self.as_person("maker", f"{at or self.path}{path}", method=method, body=body)
        self.assertIn(status, expected, f"{method} {path}: {text[:200]}")
        return text

    def sweep(self):
        status, body = tags.sweeping.sweep()
        self.assertEqual(status, 200, body)
        return body

    def rules(self):
        status, rules = forge(f"{self.path}/branch_protections")
        self.assertEqual(status, 200, rules)
        return sorted(r["rule_name"] for r in rules)

    def keys(self):
        status, keys = forge(f"{self.path}/keys")
        self.assertEqual(status, 200, keys)
        return [k["title"] for k in keys]

    def assert_main_takes_no_push(self):
        for who in ("box", "manager"):
            _, code, out = self.push(who, "refs/heads/main")
            self.assertNotEqual(code, 0, f"{who} pushed to main")
            self.assertIn("protected branch", out, who)

    def assert_held(self, body):
        self.assertIn(f"{self.PEOPLE['maker'][0]} from '{self.repo}'", body["removed"], body)
        self.assertFalse(any(entry.startswith(self.repo) for entry in body["errors"]), body)
        self.assertEqual(self.rules(), OURS)
        self.assertEqual(self.keys(), [f"gateway {self.sparkplug_id}"])
        self.assert_main_takes_no_push()

    def test_a_rule_is_removed_whatever_it_is_called(self):
        for name in ("{main,x/y}", "feature/**", "{main,?a=b#c}", "{main,%2e}"):
            self.as_maker("/branch_protections", "POST", {"rule_name": name, **OPEN}, (201,))
        self.assertEqual(self.push("manager", "refs/heads/main")[1], 0, "the rule admitted nobody, so this proves nothing")
        body = self.sweep()
        self.assertIn(f"{self.repo} (rules)", body["protected"], body)
        self.assert_held(body)

    def test_a_rule_no_path_carries_costs_the_keys_and_nothing_else(self):
        for name in ("..", "x/../main", "ma\\x69n"):
            with self.subTest(rule=name):
                self.as_maker("/branch_protections", "POST", {"rule_name": name, **OPEN}, (201,))
                body = self.sweep()
                said = [entry for entry in body["errors"] if entry.startswith(self.repo)]
                self.assertEqual(len(said), 1, body)
                self.assertIn(json.dumps(name), said[0])
                self.assertIn("deploy keys are removed", said[0])
                self.assertEqual(self.rules(), sorted([*OURS, name]), "the repository, and each rule of Aber's, is still there")
                self.assertEqual(self.keys(), [])
                # Nor does enrolling it again hand the appliance one.
                with self.assertRaisesRegex(AssertionError, "gave no repository"):
                    self.enrol()
                self.assertEqual(self.keys(), [])
                # Each starts from a new repository.
                self.assertEqual(forge(self.path, method="DELETE")[0], 204)
                self.enrol()
                login = self.PEOPLE["maker"][0]
                self.assertEqual(forge(f"{self.path}/collaborators/{login}", method="PUT", body={"permission": "admin"})[0], 204)

    def test_proposals_turned_off_are_turned_on_and_the_pass_goes_on(self):
        self.as_maker("/branch_protections", "POST", {"rule_name": "*", **OPEN}, (201,))
        self.as_maker("/branch_protections/main", "PATCH", {"required_approvals": 0}, (200,))
        self.as_maker("", "PATCH", {"has_pull_requests": False}, (200,))
        body = self.sweep()
        for what in ("(proposals)", "(rules)"):
            self.assertIn(f"{self.repo} {what}", body["protected"], body)
        self.assertTrue(forge(self.path)[1]["has_pull_requests"])
        self.assert_held(body)

    def test_a_repository_that_was_renamed_has_its_name_back(self):
        self.as_maker("", "PATCH", {"name": self.other}, (200,))
        at = f"/repos/{ORGANISATION}/{self.other}"
        self.as_maker("/branch_protections", "POST", {"rule_name": "*", **OPEN}, (201,), at=at)
        # The appliance's clone, under the name it was told, follows the rename.
        self.assertEqual(self.push("box", "refs/heads/main")[1], 0, "the rule admitted nobody, so this proves nothing")
        body = self.sweep()
        self.assertIn(f"{self.repo} (name)", body["protected"], body)
        # The forge answers for it under its own name, not by a redirect.
        self.assertEqual(forge(self.path)[1]["name"], self.repo)
        self.assert_held(body)
        _, code, out = self.push("box", "refs/heads/appliance")
        self.assertEqual(code, 0, out)

    def test_a_gateways_key_on_a_repository_that_is_not_one_is_removed(self):
        status, _ = forge(f"/orgs/{ORGANISATION}/repos", method="POST", body={
            "name": self.other, "private": True, "auto_init": True, "default_branch": "main"})
        self.assertEqual(status, 201)
        at = f"/repos/{ORGANISATION}/{self.other}"
        for title in (f"gateway {self.sparkplug_id}", "the site's own"):
            status, answer = forge(f"{at}/keys", method="POST", body={"title": title, "key": self.make_key(title.split()[0]), "read_only": True})
            self.assertEqual(status, 201, answer)
        body = self.sweep()
        self.assertIn(f"{self.other}: 'gateway {self.sparkplug_id}'", body["revoked"], body)
        self.assertEqual([k["title"] for k in forge(f"{at}/keys")[1]], ["the site's own"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
