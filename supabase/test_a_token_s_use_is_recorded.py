"""
A service token used through the i3X server shows when it was last used, against a running stack
(0209).

As the seeded Administrator this issues a one-day token for the Read-only API client through
mint-service-token, as the page's Issue Token does. One request to the i3X server with that token
must leave a row in service_token_last_use naming the token, its identity and the current UTC
hour, which the Administrator reads as the token list does. A second request in the hour leaves
the row as it was. The token is revoked at the end, and the i3X server then refuses it.

Each run leaves one TOKEN_MINTED and one TOKEN_REVOKED row in the Audit Trail, as an Issue Token
and a Revoke on the page would.

    python supabase/test_a_token_s_use_is_recorded.py
"""
import json
import os
import sys
import time
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test-harness"))
import stack_sign_in  # noqa: E402  -- waits out the lane's shared sign-in limit

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
I3X_BASE_URL = os.getenv("I3X_BASE_URL", "http://localhost:8090").rstrip("/")
PASSWORD = os.getenv("ABER_SEED_PASSWORD", "aber123")
EMAIL = "admin@aber.local"
READ_ONLY_CLIENT = "b0000000-0000-4000-8000-000000000001"
STRICT = os.getenv("REQUIRE_SEEDED_ACCOUNTS", "").lower() in ("1", "true", "yes")
# The recorder thread calls the database a moment after the request; this is ample.
WAIT_SECONDS = 15


def request(url, method="GET", token=None, body=None, apikey=True):
    """(status, parsed JSON or text) for one call to the stack."""
    headers = {"apikey": PUBLISHABLE_KEY} if apikey else {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, method=method, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            status, text = response.status, response.read().decode()
    except urllib.error.HTTPError as err:
        with err:
            status, text = err.code, err.read().decode()
    try:
        return status, json.loads(text)
    except ValueError:
        return status, text


def sign_in():
    status, body = stack_sign_in.password_grant(SUPABASE_URL, PUBLISHABLE_KEY, EMAIL, PASSWORD)
    if status == stack_sign_in.NO_SUCH_ACCOUNT:
        reason = f"could not sign in as {EMAIL} ({status}); the seed personas are absent"
        if STRICT:
            raise AssertionError(f"{reason}, and REQUIRE_SEEDED_ACCOUNTS is set")
        raise unittest.SkipTest(reason)
    if status != 200:
        raise AssertionError(stack_sign_in.describe(EMAIL, status, body))
    return body["access_token"]


def this_utc_hour():
    return datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)


class ATokensUseIsRecorded(unittest.TestCase):
    def setUp(self):
        status, _ = request(f"{I3X_BASE_URL}/v1/info", apikey=False)
        if status != 200:
            reason = f"the i3X server at {I3X_BASE_URL} answered {status}"
            if STRICT:
                raise AssertionError(reason)
            self.skipTest(reason)
        self.admin = sign_in()
        status, minted = request(f"{SUPABASE_URL}/functions/v1/mint-service-token", method="POST",
                                 token=self.admin, body={"principal_id": READ_ONLY_CLIENT, "days": 1})
        self.assertEqual(status, 200, minted)
        self.token, self.jti = minted["token"], minted["jti"]
        self.addCleanup(self.revoke)

    def revoke(self):
        status, body = request(f"{SUPABASE_URL}/rest/v1/rpc/revoke_service_token", method="POST",
                               token=self.admin, body={"p_jti": self.jti})
        self.assertEqual(status, 200, f"the token could not be revoked: {body}")
        # The server's acceptance cache holds a token for at most 15 seconds.
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            status, _ = request(f"{I3X_BASE_URL}/v1/namespaces", token=self.token, apikey=False)
            if status == 401:
                return
            time.sleep(2)
        self.fail(f"the i3X server still accepts the revoked token ({status})")

    def last_use(self):
        """The token's row, read as the Administrator, as the token list reads it."""
        status, rows = request(f"{SUPABASE_URL}/rest/v1/service_token_last_use"
                               f"?select=jti,principal_id,last_used_at&jti=eq.{self.jti}", token=self.admin)
        self.assertEqual(status, 200, rows)
        return rows[0] if rows else None

    def test_a_request_through_i3x_records_the_hour(self):
        self.assertIsNone(self.last_use(), "a token nobody has used yet has a last use")
        before = this_utc_hour()
        status, body = request(f"{I3X_BASE_URL}/v1/namespaces", token=self.token, apikey=False)
        self.assertEqual(status, 200, body)

        row, deadline = None, time.monotonic() + WAIT_SECONDS
        while row is None and time.monotonic() < deadline:
            time.sleep(1)
            row = self.last_use()
        self.assertIsNotNone(row, f"no last use was recorded within {WAIT_SECONDS} seconds")
        self.assertEqual(row["principal_id"], READ_ONLY_CLIENT)
        recorded = datetime.fromisoformat(row["last_used_at"])
        self.assertIn(recorded, (before, this_utc_hour()), f"{recorded} is not the hour of the request")

        status, _ = request(f"{I3X_BASE_URL}/v1/namespaces", token=self.token, apikey=False)
        self.assertEqual(status, 200)
        time.sleep(3)
        self.assertEqual(self.last_use(), row, "a second request in the hour changed the row")


if __name__ == "__main__":
    unittest.main()
