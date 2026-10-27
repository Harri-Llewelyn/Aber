"""
A person enrols a second factor, signs in with its code, and an Administrator resets it, against a
running stack (0216).

The chart sets GoTrue's GOTRUE_MFA_* variables: TOTP on, phone and WebAuthn off. This drives
GoTrue's factor API through the gateway as the dashboard's auth-js does, and computes each code
here from the factor's secret (RFC 6238, the standard library only):

  * a throwaway Auditor signs in (aal1), enrols a TOTP factor, is refused a wrong code, and a right
    one raises the session to aal2 with `totp` in its amr;
  * signing in again with the password alone is aal1 again, and a code raises it to aal2;
  * phone and WebAuthn enrolment are refused;
  * the seeded Administrator's Reset MFA (manage-people `reset-mfa`) removes the factor, writes one
    MFA_RESET row naming them, and leaves the person's session signed in; a sign-in after it is
    aal1 with no factor. Your own reset, and anyone else's but an Administrator's, are refused.

The account is prepared by the Administrator through the API (added the first time, restored and
given a new password after that), and put away at the end: any factor left reset, its sessions
signed out and its access removed. Each run leaves its People rows (PERSON_ADDED or
ACCESS_RESTORED, PASSWORD_SET, ACCESS_REMOVED) and one MFA_RESET row in the Audit Trail, more
after a run that stopped part-way.

    python supabase/test_a_person_can_enrol_a_second_factor.py
"""
import base64
import hashlib
import hmac
import json
import os
import struct
import time
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timezone

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
PASSWORD = os.getenv("ABER_SEED_PASSWORD", "aber123")
ADMIN_EMAIL = "admin@aber.local"
SUITE_EMAIL = "second-factor-suite@aber.local"
STRICT = os.getenv("REQUIRE_SEEDED_ACCOUNTS", "").lower() in ("1", "true", "yes")
# Any read: the token is served or it is not.
READ = "/rest/v1/areas?select=id&limit=1"


def request(path, method="GET", token=None, body=None):
    """(status, parsed JSON or text) for one call through the gateway."""
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
            status, text = response.status, response.read().decode()
    except urllib.error.HTTPError as err:
        with err:
            status, text = err.code, err.read().decode()
    try:
        return status, json.loads(text) if text else None
    except ValueError:
        return status, text


def totp(secret, step=0, at=None):
    """RFC 6238 with GoTrue's parameters: HMAC-SHA1, 30-second steps, six digits, at `at` (now by
    default). `step` moves the counter, so two verifications in one window can use different codes."""
    key = base64.b32decode(secret.upper() + "=" * (-len(secret) % 8))
    counter = int((time.time() if at is None else at) // 30) + step
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return f"{value % 1_000_000:06d}"


def claims(token):
    payload = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


def methods(token):
    return [entry.get("method") for entry in claims(token).get("amr") or []]


def sign_in(email, password, skip_reason=None):
    status, body = request("/auth/v1/token?grant_type=password", method="POST",
                           body={"email": email, "password": password})
    if status != 200:
        if skip_reason:
            reason = f"could not sign in as {email} ({status}); {skip_reason}"
            if STRICT:
                raise AssertionError(f"{reason}, and REQUIRE_SEEDED_ACCOUNTS is set")
            raise unittest.SkipTest(reason)
        raise AssertionError(f"could not sign in as {email} ({status}): {body}")
    return body["access_token"]


def must(what, answer):
    status, body = answer
    if not 200 <= status < 300:
        raise AssertionError(f"{what}: HTTP {status} {str(body)[:300]}")
    return body


class TheCodesAreRfc6238s(unittest.TestCase):
    """RFC 6238 appendix B's SHA-1 vectors, cut to six digits, so a refusal below is GoTrue's."""

    def test_the_appendix_vectors(self):
        secret = base64.b32encode(b"12345678901234567890").decode()
        for at, code in ((59, "287082"), (1111111109, "081804"), (1234567890, "005924"), (2000000000, "279037")):
            with self.subTest(at=at):
                self.assertEqual(totp(secret, at=at), code)


class ASecondFactorEnrolsAndResets(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.admin = sign_in(ADMIN_EMAIL, PASSWORD, "the seed personas are absent")
        cls.admin_id = claims(cls.admin)["sub"]
        cls.person_id = None
        cls.person_tokens = []
        cls.password = cls.prepare_person()
        # A factor a failed run left behind would answer the enrolment below with a name conflict.
        token = cls.person_sign_in()
        user = must("read the suite account", request("/auth/v1/user", token=token))
        if user.get("factors"):
            must("reset a factor an earlier run left", cls.manage({"action": "reset-mfa", "user_id": cls.person_id}))

    @classmethod
    def tearDownClass(cls):
        problems = []
        if cls.person_id:
            # A run that stopped part-way may have left a factor; a finished one reset it.
            left = True
            if cls.person_tokens:
                status, user = request("/auth/v1/user", token=cls.person_tokens[-1])
                left = status != 200 or bool((user or {}).get("factors"))
                status, body = request("/auth/v1/logout?scope=global", method="POST", token=cls.person_tokens[-1])
                if status not in (204, 401, 403):
                    problems.append(f"the suite account's sessions were not signed out ({status} {body})")
            if left:
                status, body = cls.manage({"action": "reset-mfa", "user_id": cls.person_id})
                if status != 200:
                    problems.append(f"the suite account's factor may remain ({status} {body})")
            status, body = cls.manage({"action": "remove", "user_id": cls.person_id})
            if status != 200:
                problems.append(f"the suite account may still have access ({status} {body}): remove it on People")
        request("/auth/v1/logout?scope=local", method="POST", token=cls.admin)
        if problems:
            raise AssertionError("; ".join(problems))

    @classmethod
    def manage(cls, body, token=None):
        return request("/functions/v1/manage-people", method="POST", token=token or cls.admin, body=body)

    @classmethod
    def prepare_person(cls):
        """The suite's Auditor, with access and a password only this run knows."""
        people = must("list the people", request("/rest/v1/rpc/list_people", method="POST", token=cls.admin, body={}))
        person = next((p for p in people or [] if (p.get("email") or "").lower() == SUITE_EMAIL), None)
        password = None
        if person is None:
            added = must("add the suite account", cls.manage({"action": "add", "email": SUITE_EMAIL, "role": "Auditor"}))
            cls.person_id = added["user_id"]
            password = added.get("password")
        else:
            cls.person_id = person["user_id"]
            if person.get("status") == "removed":
                must("restore the suite account", cls.manage({"action": "restore", "user_id": cls.person_id}))
        if not password:
            password = must("give the suite account a password",
                            cls.manage({"action": "set-password", "user_id": cls.person_id}))["password"]
        return password

    @classmethod
    def person_sign_in(cls):
        token = sign_in(SUITE_EMAIL, cls.password)
        cls.person_tokens.append(token)
        return token

    def challenge_and_verify(self, token, factor_id, code):
        challenge = must("challenge the factor",
                         request(f"/auth/v1/factors/{factor_id}/challenge", method="POST", token=token, body={}))
        return request(f"/auth/v1/factors/{factor_id}/verify", method="POST", token=token,
                       body={"challenge_id": challenge["id"], "code": code})

    def test_a_factor_is_enrolled_asked_for_at_sign_in_and_reset_by_an_administrator(self):
        started = datetime.now(timezone.utc)

        # Enrolment, from a password session.
        first = self.person_sign_in()
        self.assertEqual(claims(first)["aal"], "aal1")
        self.assertIn("password", methods(first))
        enrolled = must("enrol a TOTP factor", request("/auth/v1/factors", method="POST", token=first,
                                                       body={"factor_type": "totp", "friendly_name": "Suite phone"}))
        self.assertEqual(enrolled["type"], "totp")
        secret = enrolled["totp"]["secret"]
        self.assertIn("<svg", enrolled["totp"]["qr_code"], "GoTrue sends the QR code as SVG")
        self.assertTrue(enrolled["totp"]["uri"].startswith("otpauth://totp/"), enrolled["totp"]["uri"])
        factor_id = enrolled["id"]

        right = totp(secret)
        wrong = f"{(int(right) + 1) % 1_000_000:06d}"
        status, body = self.challenge_and_verify(first, factor_id, wrong)
        self.assertEqual(status, 422, body)
        self.assertEqual(body.get("error_code"), "mfa_verification_failed", body)

        status, verified = self.challenge_and_verify(first, factor_id, right)
        self.assertEqual(status, 200, verified)
        self.person_tokens.append(verified["access_token"])
        self.assertEqual(claims(verified["access_token"])["aal"], "aal2")
        self.assertIn("totp", methods(verified["access_token"]))
        user = must("read the account", request("/auth/v1/user", token=verified["access_token"]))
        self.assertEqual([(f["id"], f["status"]) for f in user.get("factors") or []], [(factor_id, "verified")])

        # A new sign-in is aal1 until its code, which GoTrue then accepts.
        again = self.person_sign_in()
        self.assertEqual(claims(again)["aal"], "aal1")
        status, raised = self.challenge_and_verify(again, factor_id, totp(secret, step=1))
        self.assertEqual(status, 200, raised)
        signed_in = raised["access_token"]
        self.person_tokens.append(signed_in)
        self.assertEqual(claims(signed_in)["aal"], "aal2")

        # The chart turns the other kinds off.
        for kind, extra, code in (("phone", {"phone": "+447700900123"}, "mfa_phone_enroll_not_enabled"),
                                  ("webauthn", {}, "mfa_webauthn_enroll_not_enabled")):
            with self.subTest(kind=kind):
                status, body = request("/auth/v1/factors", method="POST", token=signed_in,
                                       body={"factor_type": kind, "friendly_name": f"Suite {kind}", **extra})
                self.assertEqual(status, 422, body)
                self.assertEqual(body.get("error_code"), code, body)

        # Only an Administrator resets one, and never their own.
        status, _ = self.manage({"action": "reset-mfa", "user_id": self.person_id}, token=signed_in)
        self.assertEqual(status, 403)
        status, body = self.manage({"action": "reset-mfa", "user_id": self.admin_id})
        self.assertEqual(status, 403, body)

        # Reset MFA: the factor goes, the session stays, and the trail says so.
        reset = must("reset the factor", self.manage({"action": "reset-mfa", "user_id": self.person_id}))
        self.assertEqual(reset, {"user_id": self.person_id, "factors_removed": 1})
        user = must("read the account after the reset", request("/auth/v1/user", token=signed_in))
        self.assertEqual(user.get("factors") or [], [])
        status, body = request(READ, token=signed_in)
        self.assertEqual(status, 200, f"Reset MFA ended the session: {body}")

        rows = must("read the Audit Trail", request(
            "/rest/v1/audit_trail?select=new_data,changed_by,recorded_at"
            f"&entity_id=eq.{self.person_id}&action=eq.MFA_RESET&order=id.desc&limit=1", token=self.admin))
        self.assertEqual(len(rows), 1)
        self.assertGreaterEqual(datetime.fromisoformat(rows[0]["recorded_at"]), started.replace(microsecond=0))
        self.assertEqual(rows[0]["changed_by"], self.admin_id)
        self.assertEqual(rows[0]["new_data"], {"email": SUITE_EMAIL, "factors_removed": 1})

        # With no factor, the password alone signs in and nothing asks for more.
        after = self.person_sign_in()
        self.assertEqual(claims(after)["aal"], "aal1")
        user = must("read the account after signing in again", request("/auth/v1/user", token=after))
        self.assertEqual([f for f in user.get("factors") or [] if f.get("status") == "verified"], [])


if __name__ == "__main__":
    unittest.main()
