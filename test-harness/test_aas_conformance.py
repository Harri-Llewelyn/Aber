# suite:
#   lanes: unit
#   why: The verdict CI states about aas-api against IDTA's test engine, read from the engine's own
#     result tree. A recorded pass that fails, or a server error anywhere, must fail the run, and an
#     operation that starts to pass must be named rather than fail it, or the README's statement of
#     what passes goes stale. Runs without the engine: it judges the JSON the engine writes.

"""
aas_conformance.py judges the engine's results as the README states them.

    python test-harness/test_aas_conformance.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import aas_conformance  # noqa: E402  -- after sys.path, by necessity

INFO, WARNING, ERROR, CRITICAL = 0, 1, 2, 3


def node(message, level=INFO, *children):
    return {"m": message, "l": max([level, *(c["l"] for c in children)]), "s": list(children)}


def profile(*ops, reached=True):
    """One profile's tree as execute_tests() writes it: the reach check, an operation each, the summary."""
    return node(
        "Checking compliance to a profile", INFO,
        node("Trying to reach http://aas-api.test", INFO if reached else CRITICAL,
             node("OK" if reached else "Failed to reach", INFO if reached else CRITICAL)),
        *ops,
        node("Summary:", INFO, node("Positive tests passed: 1 / 1")),
    )


def op(name, level=INFO, leaf="Fetch: OK"):
    return node(f"Checking {name}", INFO, node("Positive Tests", INFO, node(leaf, level)))


PASSING = {"aas-repository": ["GetDescription", "GetAssetInformation"]}
KNOWN = {"GetSubmodelById-Metadata": "the modifier is not served"}


def judge(*ops, reached=True):
    return aas_conformance.judge({"aas-repository": profile(*ops, reached=reached)}, PASSING, KNOWN)


class TestTheVerdict(unittest.TestCase):

    def test_what_was_recorded_is_as_recorded(self):
        verdict, problems, lines = judge(op("GetDescription"), op("GetAssetInformation"),
                                         op("GetSubmodelById-Metadata", ERROR, "Got unexpected status code 404"))
        self.assertEqual((verdict, problems), ("As recorded", []))
        self.assertIn("aas-repository: 2 of 3 operations pass", lines)
        self.assertIn("  fails: GetSubmodelById-Metadata -- the modifier is not served", lines)

    def test_every_operation_passing_is_compliant(self):
        verdict, problems, _ = judge(op("GetDescription"), op("GetAssetInformation"))
        self.assertEqual((verdict, problems), ("Compliant", []))

    def test_a_recorded_pass_that_fails_regresses(self):
        verdict, problems, _ = judge(op("GetDescription"), op("GetAssetInformation", ERROR, "Got unexpected status code 404"))
        self.assertEqual(verdict, "Regressed")
        self.assertEqual(len(problems), 1)
        self.assertIn("GetAssetInformation passed and now fails", problems[0])
        self.assertIn("Got unexpected status code 404", problems[0])

    def test_a_server_error_fails_whatever_the_operation(self):
        verdict, problems, _ = judge(op("GetDescription"), op("GetAssetInformation"),
                                     op("GetSubmodelById-Metadata", CRITICAL, "Got unexpected status code 500"))
        self.assertEqual(verdict, "Regressed")
        self.assertIn("server error", problems[0])

    def test_an_operation_that_starts_to_pass_is_named_and_does_not_fail(self):
        verdict, problems, lines = judge(op("GetDescription"), op("GetAssetInformation"), op("GetSubmodelById-Metadata"))
        self.assertEqual((verdict, problems), ("Compliant", []))
        self.assertIn("  NOW PASSES: GetSubmodelById-Metadata; record it in PASSING and the README", lines)

    def test_a_warning_is_a_pass(self):
        verdict, _, _ = judge(op("GetDescription", WARNING), op("GetAssetInformation"))
        self.assertEqual(verdict, "Compliant")

    def test_a_recorded_operation_that_was_not_run_regresses(self):
        verdict, problems, _ = judge(op("GetDescription"))
        self.assertEqual(verdict, "Regressed")
        self.assertIn("GetAssetInformation passed and was not run", problems[0])

    def test_a_server_the_engine_did_not_reach_regresses(self):
        verdict, problems, _ = judge(reached=False)
        self.assertEqual(verdict, "Regressed")
        self.assertIn("did not reach the server", problems[0])


class TestTheRecord(unittest.TestCase):

    def test_no_operation_is_both_recorded_as_passing_and_explained_as_failing(self):
        for name, ops in aas_conformance.PASSING.items():
            self.assertEqual(set(ops) & set(aas_conformance.KNOWN_FAILURES), set(), name)

    def test_the_profiles_are_the_two_repository_read_profiles_aas_api_declares(self):
        index = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "supabase", "functions", "aas-api", "index.ts")
        with open(index, encoding="utf-8") as handle:
            source = handle.read()
        for profile_id in aas_conformance.PROFILES.values():
            self.assertTrue(profile_id.endswith("SSP-002"), profile_id)
            self.assertIn(f'"{profile_id}"', source, f"aas-api does not declare {profile_id}")


if __name__ == "__main__":
    unittest.main()
