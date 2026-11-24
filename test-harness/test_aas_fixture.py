# suite:
#   lanes: unit
#   why: The AAS suites' shared subject, against a PostgREST that answers from a list. A subject that
#     could not be finished is removed before the error is raised, since its suite then skips and
#     would leave a gateway and a device on the stack; and a teardown names the fixture's own rows
#     alone, so running a suite on a person's stack takes no other device's birth values with it.

"""
The AAS conformance subject leaves nothing behind when it cannot be finished.

    python test-harness/test_aas_fixture.py
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import aas_fixture  # noqa: E402  -- after sys.path, by necessity

ARGS = ("http://stack.invalid", "a-token", "a-key")


class Stack:
    """Answers each request, and refuses the first write to `refused`."""

    def __init__(self, refused=None):
        self.refused = refused
        self.calls = []

    def __call__(self, _base, _token, _anon, method, path, payload=None, headers=None):
        self.calls.append((method, path))
        if method == "POST" and self.refused and path.startswith(f"/{self.refused}"):
            raise aas_fixture.FixtureError(f"POST {path} -> HTTP 403: refused")
        if method == "GET":
            return []
        return [{"id": "row", "sparkplug_id": aas_fixture.SPARKPLUG_ID, **(payload or {})}]

    def deleted(self):
        return [path for method, path in self.calls if method == "DELETE"]


class TheSubject(unittest.TestCase):
    def ensure(self, refused=None):
        stack = Stack(refused)
        with mock.patch.object(aas_fixture, "_request", stack):
            try:
                return stack, aas_fixture.ensure(*ARGS)
            except aas_fixture.FixtureError as err:
                return stack, err

    def test_a_finished_subject_is_left_in_place(self):
        stack, device = self.ensure()
        self.assertEqual(device["id"], aas_fixture.DEVICE_UUID)
        self.assertEqual(stack.deleted(), [])

    def test_one_that_cannot_be_finished_is_removed_and_the_refusal_is_raised(self):
        for refused in ("gateways", "devices", "schemas", "device_submodels", "device_nameplate", "asset_config"):
            with self.subTest(refused=refused):
                stack, error = self.ensure(refused)
                self.assertIsInstance(error, aas_fixture.FixtureError)
                self.assertIn(f"POST /{refused}", str(error))
                for made in (f"/devices?id=eq.{aas_fixture.DEVICE_UUID}", f"/gateways?id=eq.{aas_fixture.GATEWAY_UUID}"):
                    self.assertIn(made, stack.deleted())

    def test_a_teardown_names_the_fixtures_own_rows_alone(self):
        stack = Stack()
        with mock.patch.object(aas_fixture, "_request", stack):
            aas_fixture.teardown(*ARGS)
        for path in stack.deleted():
            with self.subTest(path=path):
                self.assertRegex(path, r"^/\w+\?\w+=eq\.[^&]+$", "one row's key, not a pattern over the table")
        self.assertIn(f"/asset_config?asset_id=eq.{aas_fixture.SPARKPLUG_ID}", stack.deleted())

    def test_a_teardown_goes_on_when_the_stack_does_not_answer(self):
        with mock.patch.object(aas_fixture, "_request", mock.Mock(side_effect=OSError("no route"))) as asked:
            aas_fixture.teardown(*ARGS)
        self.assertGreater(asked.call_count, 1)

    def test_the_sparkplug_id_is_the_uuids_first_21_hex_digits(self):
        self.assertEqual(aas_fixture.SPARKPLUG_ID, "dev2a0000000000400080000")


if __name__ == "__main__":
    unittest.main(verbosity=2)
