# suite:
#   lanes: unit
#   why: The wait test_enroll_gateway.py makes before a class may enrol again under a gateway id: it
#     returns once the credential service has ANSWERED the revoke a delete queued, never because the
#     queue is empty (pg_net takes a request off the queue before the answer), and an answer that
#     does not come fails naming the request and the gateway. The database is stubbed, so the SQL
#     itself is read here and run only by the stack lane's test_enroll_gateway.py.

"""
The control flow of delete_gateway_and_wait_for_revoke(), with the database's answers scripted.
"""
import contextlib
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_enroll_gateway as suite  # noqa: E402

GATEWAY = "2d000000-0000-4000-8000-000000000001"
SPARKPLUG = "gwy2d0000000000400080000"
# What psql -q -At prints for the delete's transaction: the header setting, then the queued ids.
HEADER_LINE = '{"x-aber-actor": "service"}\n'


class FakeDatabase:
    """Scripts the database: the delete's reply first, then one reply per read of net._http_response."""

    def __init__(self, transaction, answers):
        self.transaction = transaction
        self.answers = list(answers)
        self.sql = []

    def __call__(self, sql):
        self.sql.append(sql)
        if len(self.sql) == 1:
            return self.transaction
        return self.answers.pop(0) if self.answers else ""


def wait(database, timeout=30, clock=None):
    """Run the wait against the scripted database, without sleeping for real."""
    with contextlib.ExitStack() as patched:
        patched.enter_context(mock.patch.object(suite, "database", database))
        patched.enter_context(mock.patch.object(suite.time, "sleep"))
        if clock is not None:
            patched.enter_context(mock.patch.object(suite.time, "monotonic", side_effect=clock))
        suite.delete_gateway_and_wait_for_revoke(GATEWAY, SPARKPLUG, timeout=timeout)


class TestWaitForTheRevoke(unittest.TestCase):
    def test_a_gateway_that_never_enrolled_queued_nothing_and_is_not_waited_for(self):
        database = FakeDatabase(HEADER_LINE, [])
        wait(database)
        self.assertEqual(len(database.sql), 1, "net._http_response was read for a revoke nobody queued")

    def test_it_waits_for_every_request_the_delete_queued(self):
        database = FakeDatabase(HEADER_LINE + "41\n42\n", ["", "41\n", "42\n"])
        wait(database)
        reads = database.sql[1:]
        self.assertEqual(len(reads), 3)
        self.assertIn("IN (41, 42)", reads[0])
        self.assertIn("IN (41, 42)", reads[1])
        self.assertIn("IN (42)", reads[2], "a request already answered was asked about again")

    def test_a_queue_that_has_emptied_is_not_an_answer(self):
        # The queue is read once, in the delete's transaction. A later empty queue says only that the
        # worker took the request, and the wait goes on until net._http_response holds its id.
        database = FakeDatabase(HEADER_LINE + "41\n", ["", ""])
        with self.assertRaises(AssertionError):
            wait(database, clock=iter([0, 10, 20, 31, 40]).__next__)
        self.assertTrue(all("http_request_queue" not in sql for sql in database.sql[1:]))

    def test_a_missing_answer_fails_naming_the_request_and_the_gateway(self):
        database = FakeDatabase(HEADER_LINE + "41\n", [])
        with self.assertRaises(AssertionError) as caught:
            wait(database, timeout=30, clock=iter([0, 10, 20, 31]).__next__)
        message = str(caught.exception)
        for named in ("[41]", GATEWAY, SPARKPLUG, "30s"):
            self.assertIn(named, message)

    def test_the_delete_and_the_read_of_the_queue_are_one_transaction(self):
        database = FakeDatabase(HEADER_LINE, [])
        wait(database)
        statements = [part.strip() for part in database.sql[0].split(";") if part.strip()]
        kinds = [s.split()[0] for s in statements]
        self.assertEqual(kinds, ["SELECT", "DELETE", "SELECT"])
        self.assertIn(f"DELETE FROM public.gateways WHERE id = '{GATEWAY}'", statements[1])
        self.assertIn("net.http_request_queue", statements[2])
        self.assertIn("/revoke-gateway-credential", statements[2])
        self.assertIn(SPARKPLUG, statements[2])

    def test_the_delete_is_made_as_the_service_actor(self):
        database = FakeDatabase("", [])
        wait(database)
        self.assertIn("'x-aber-actor', 'service'", database.sql[0])

    def test_a_value_that_is_not_an_id_never_reaches_the_database(self):
        database = FakeDatabase("", [])
        with mock.patch.object(suite, "database", database):
            for gateway, sparkplug in (
                ("'; DROP TABLE public.gateways; --", SPARKPLUG),
                (GATEWAY, "gwy%"),
                (GATEWAY, SPARKPLUG + "0"),
            ):
                with self.subTest(gateway=gateway, sparkplug=sparkplug):
                    with self.assertRaises(ValueError):
                        suite.delete_gateway_and_wait_for_revoke(gateway, sparkplug)
        self.assertEqual(database.sql, [])


class TestIds(unittest.TestCase):
    def test_the_sparkplug_id_is_gwy_and_21_hex_digits_of_the_uuid(self):
        self.assertEqual(suite.sparkplug_id_of(GATEWAY), SPARKPLUG)

    def test_only_digit_lines_are_request_ids(self):
        self.assertEqual(suite.request_ids(HEADER_LINE + "41\n 42 \nnot-an-id\n"), [41, 42])


if __name__ == "__main__":
    unittest.main(verbosity=2)
