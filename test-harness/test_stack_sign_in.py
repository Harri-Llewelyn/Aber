"""
The stack lane's sign-in helper in stack_sign_in.py, with no stack.

Every stack-lane suite that signs in with a password goes through it, so it has two ways to be
wrong: a 429 that fails a suite the next second would have passed, and a 429 read as missing seed
accounts, which skips the suite or blames the wrong thing. The last case runs a real HTTP server, so
the error path urllib takes for a 4xx is the one tested.

Run:  python test-harness/test_stack_sign_in.py
"""
import http.server
import json
import os
import sys
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import stack_sign_in  # noqa: E402

LIMITED = (429, {"code": 429, "error_code": "over_request_rate_limit", "msg": "Request rate limit reached"})
SIGNED_IN = (200, {"access_token": "not-a-real-token", "user": {"id": "00000000-0000-0000-0000-000000000001"}})
NO_ACCOUNT = (400, {"code": 400, "error_code": "invalid_credentials", "msg": "Invalid login credentials"})


class Answers:
    """A stand-in for the POST: hands back the given answers in turn and records each call."""

    def __init__(self, *answers):
        self.answers, self.calls = list(answers), []

    def __call__(self, url, apikey, payload, timeout):
        self.calls.append((url, apikey, payload))
        return self.answers.pop(0)


def grant(post, waits=stack_sign_in.WAITS_S):
    slept = []
    result = stack_sign_in.password_grant("http://stack", "a-publishable-key", "admin@aber.local",
                                          "not-a-real-password", waits=waits, sleep=slept.append, post=post)
    return result, slept


class APasswordGrant(unittest.TestCase):
    def test_a_429_then_a_200_signs_in_after_one_wait(self):
        post = Answers(LIMITED, SIGNED_IN)
        (status, body), slept = grant(post)
        self.assertEqual(status, 200)
        self.assertEqual(body["access_token"], "not-a-real-token")
        self.assertEqual(slept, [2])
        self.assertEqual(len(post.calls), 2)

    def test_the_request_is_a_password_grant_with_the_key(self):
        post = Answers(SIGNED_IN)
        grant(post)
        url, apikey, payload = post.calls[0]
        self.assertEqual(url, "http://stack/auth/v1/token?grant_type=password")
        self.assertEqual(apikey, "a-publishable-key")
        self.assertEqual(payload, {"email": "admin@aber.local", "password": "not-a-real-password"})

    def test_429_after_every_wait_fails_naming_the_status(self):
        post = Answers(LIMITED, LIMITED, LIMITED)
        with self.assertRaises(stack_sign_in.RateLimited) as caught:
            grant(post, waits=(2, 4))
        message = str(caught.exception)
        self.assertIn("(429, rate-limited)", message)
        self.assertIn("over_request_rate_limit", message)
        self.assertIn("3 attempts over 6 s", message)
        self.assertNotIn("absent", message)

    def test_a_rate_limit_is_an_assertion_failure_never_a_skip(self):
        self.assertTrue(issubclass(stack_sign_in.RateLimited, AssertionError))
        self.assertFalse(issubclass(stack_sign_in.RateLimited, unittest.SkipTest))

    def test_the_default_waits_stay_within_half_a_minute(self):
        post = Answers(*[LIMITED] * (len(stack_sign_in.WAITS_S) + 1))
        with self.assertRaises(stack_sign_in.RateLimited):
            grant(post)
        self.assertLessEqual(sum(stack_sign_in.WAITS_S), 30)

    def test_any_other_refusal_goes_back_at_once(self):
        for answer in (NO_ACCOUNT, (500, "upstream connect error"), (503, None)):
            with self.subTest(status=answer[0]):
                (status, body), slept = grant(Answers(answer))
                self.assertEqual((status, body), answer)
                self.assertEqual(slept, [])

    def test_a_missing_account_is_400(self):
        self.assertEqual(NO_ACCOUNT[0], stack_sign_in.NO_SUCH_ACCOUNT)

    def test_describe_says_rate_limited_only_for_a_429(self):
        self.assertEqual(stack_sign_in.describe("a@aber.local", 400, {"msg": "Invalid login credentials"}),
                         "could not sign in as a@aber.local (400): {'msg': 'Invalid login credentials'}")
        self.assertIn("(429, rate-limited)", stack_sign_in.describe("a@aber.local", 429, "slow down"))


class OverHttp(unittest.TestCase):
    """urllib raises HTTPError for a 429 and a 400; the helper must read both as answers."""

    def setUp(self):
        answers = [LIMITED, NO_ACCOUNT]
        self.seen = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(handler):
                length = int(handler.headers["Content-Length"])
                self.seen.append((handler.path, handler.headers["apikey"], json.loads(handler.rfile.read(length))))
                status, body = answers.pop(0)
                payload = json.dumps(body).encode()
                handler.send_response(status)
                handler.send_header("Content-Type", "application/json")
                handler.send_header("Content-Length", str(len(payload)))
                handler.end_headers()
                handler.wfile.write(payload)

            def log_message(handler, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def test_a_429_is_waited_out_and_the_400_returned(self):
        url = f"http://127.0.0.1:{self.server.server_address[1]}"
        slept = []
        status, body = stack_sign_in.password_grant(url, "a-publishable-key", "nobody@aber.local",
                                                    "not-a-real-password", sleep=slept.append)
        self.assertEqual((status, body["error_code"]), (400, "invalid_credentials"))
        self.assertEqual(slept, [2])
        self.assertEqual([path for path, _, _ in self.seen], ["/auth/v1/token?grant_type=password"] * 2)
        self.assertEqual(self.seen[0][1], "a-publishable-key")


if __name__ == "__main__":
    unittest.main(verbosity=2)
