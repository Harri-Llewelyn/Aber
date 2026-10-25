"""
Signing out ends one session, and the API refuses that session's token at once, against a running
stack (0205).

The dashboard's Sign Out calls GoTrue's /logout with scope=local, which deletes that one session.
This signs in twice as a seeded account, as two browsers would, signs one out the same way, and
reads through the gateway with both tokens. The signed-out token is refused with 401 and the code
session_not_found. The other is still served. Then the second is signed out too.

Only the two sessions opened here are ended. scope=global would end every session the seeded
account holds, including a person's own browser.

    python supabase/test_sign_out_ends_one_session.py
"""
import json
import os
import unittest
import urllib.error
import urllib.request

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
PASSWORD = os.getenv("ABER_SEED_PASSWORD", "aber123")
EMAIL = "auditor@aber.local"
# Any read: the hook runs before PostgREST looks at the path.
READ = "/rest/v1/areas?select=id&limit=1"
STRICT = os.getenv("REQUIRE_SEEDED_ACCOUNTS", "").lower() in ("1", "true", "yes")


def request(path, method="GET", token=None, body=None):
    headers = {"apikey": PUBLISHABLE_KEY}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{SUPABASE_URL}{path}", method=method, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.status, {k.lower(): v for k, v in response.headers.items()}, response.read().decode()
    except urllib.error.HTTPError as err:
        with err:
            return err.code, {k.lower(): v for k, v in err.headers.items()}, err.read().decode()


def sign_in():
    status, _, text = request(
        "/auth/v1/token?grant_type=password", method="POST",
        body={"email": EMAIL, "password": PASSWORD},
    )
    if status != 200:
        reason = f"could not sign in as {EMAIL} ({status}); the seed personas are absent"
        if STRICT:
            raise AssertionError(f"{reason}, and REQUIRE_SEEDED_ACCOUNTS is set")
        raise unittest.SkipTest(reason)
    return json.loads(text)["access_token"]


def sign_out(token):
    """The dashboard's Sign Out: this session only."""
    status, _, text = request("/auth/v1/logout?scope=local", method="POST", token=token)
    assert status == 204, f"the sign-out was refused ({status}): {text[:200]}"


class SignOutEndsOneSession(unittest.TestCase):
    def test_a_signed_out_token_is_refused_and_the_other_session_is_served(self):
        this_browser, other_browser = sign_in(), sign_in()
        try:
            for token in (this_browser, other_browser):
                status, _, text = request(READ, token=token)
                self.assertEqual(status, 200, text[:200])

            sign_out(this_browser)
            status, headers, text = request(READ, token=this_browser)
            self.assertEqual(status, 401, text[:200])
            body = json.loads(text)
            self.assertEqual(body["code"], "session_not_found", body)
            self.assertEqual(body["message"], "this session has ended", body)
            self.assertIn('error="invalid_token"', headers.get("www-authenticate", ""))

            status, _, text = request(READ, token=other_browser)
            self.assertEqual(status, 200, f"signing one session out ended the other: {text[:200]}")
        finally:
            sign_out(other_browser)

        status, _, text = request(READ, token=other_browser)
        self.assertEqual(status, 401, text[:200])


if __name__ == "__main__":
    unittest.main()
