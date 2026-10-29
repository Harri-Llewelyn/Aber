"""
Revoking a person's approval of an app ends the app's access, against a running stack (0217).

A seeded account signs in to Grafana's OAuth client as Grafana does: the authorization-code flow
with PKCE, the consent page's approval, and the code exchanged with the client's secret. The app's
refresh token works. Then the approval is taken back twice over:

  * by the person, through GoTrue's DELETE /user/oauth/grants (Profile's Revoke);
  * by an Administrator, through revoke_app_approval() (the Apps tab's Revoke).

Each time the app's refresh token is refused, its access token is refused at the API, the next
sign-in asks for consent again, and the person's own dashboard session is still served. The
Audit Trail names who revoked it.

    python supabase/test_revoking_an_app_ends_its_refresh_token.py

Needs SUPABASE_PUBLISHABLE_KEY and GRAFANA_OAUTH_CLIENT_SECRET (`dev-cluster test` passes both from
the cluster's Secret). The account's Grafana approval is revoked at the end, as it began.
"""
import base64
import hashlib
import json
import os
import secrets
import sys
import unittest
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test-harness"))
import stack_sign_in  # noqa: E402  -- waits out the lane's shared sign-in limit

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
CLIENT_SECRET = os.getenv("GRAFANA_OAUTH_CLIENT_SECRET", "")
PASSWORD = os.getenv("ABER_SEED_PASSWORD", "aber123")
PERSON = "operator@aber.local"
ADMIN = "admin@aber.local"
GRAFANA = "c0ffee00-0000-4000-8000-000000000001"
SCOPE = "openid email profile"
READ = "/rest/v1/areas?select=id&limit=1"
STRICT = os.getenv("REQUIRE_SEEDED_ACCOUNTS", "").lower() in ("1", "true", "yes")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args):
        return None


OPENER = urllib.request.build_opener(_NoRedirect)


def request(path, method="GET", token=None, body=None, form=None, basic=None):
    """One call through the gateway: (status, headers, text). Redirects are returned, not followed."""
    headers = {"apikey": PUBLISHABLE_KEY}
    data = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if basic:
        headers["Authorization"] = "Basic " + base64.b64encode(f"{basic[0]}:{basic[1]}".encode()).decode()
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    url = path if path.startswith("http") else f"{SUPABASE_URL}{path}"
    req = urllib.request.Request(url, method=method, data=data, headers=headers)
    try:
        with OPENER.open(req, timeout=20) as response:
            return response.status, {k.lower(): v for k, v in response.headers.items()}, response.read().decode()
    except urllib.error.HTTPError as err:
        with err:
            return err.code, {k.lower(): v for k, v in err.headers.items()}, err.read().decode()


def sign_in(email):
    status, body = stack_sign_in.password_grant(SUPABASE_URL, PUBLISHABLE_KEY, email, PASSWORD)
    if status == stack_sign_in.NO_SUCH_ACCOUNT:
        reason = f"could not sign in as {email} ({status}); the seed personas are absent"
        if STRICT:
            raise AssertionError(f"{reason}, and REQUIRE_SEEDED_ACCOUNTS is set")
        raise unittest.SkipTest(reason)
    if status != 200:
        raise AssertionError(stack_sign_in.describe(email, status, body))
    return body["access_token"], body["user"]["id"]


def rpc(token, name, args=None):
    status, _, text = request(f"/rest/v1/rpc/{name}", method="POST", token=token, body=args or {})
    assert status == 200, f"{name} answered {status}: {text[:300]}"
    return json.loads(text)


def revoke_own(token):
    """Profile's Revoke: GoTrue's own endpoint. 404 when nothing is in force."""
    status, _, text = request(f"/auth/v1/user/oauth/grants?client_id={GRAFANA}", method="DELETE", token=token)
    assert status in (204, 404), f"the revoke was refused ({status}): {text[:300]}"
    return status


class AppSignIn:
    """Grafana's side of the flow: PKCE, the authorize redirect, consent, the code exchange."""

    def __init__(self, person_token, redirect_uri):
        self.person_token = person_token
        self.redirect_uri = redirect_uri
        self.verifier = secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(self.verifier.encode()).digest()).decode().rstrip("=")
        self.query = urllib.parse.urlencode({
            "response_type": "code", "client_id": GRAFANA, "redirect_uri": redirect_uri, "scope": SCOPE,
            "state": secrets.token_urlsafe(12), "code_challenge": challenge, "code_challenge_method": "S256",
        })
        self.asked_for_consent = None

    def code(self):
        status, headers, text = request(f"/auth/v1/oauth/authorize?{self.query}")
        location = headers.get("location", "")
        assert "authorization_id=" in location, f"authorize answered {status} to {location!r}: {text[:300]}"
        authorization_id = urllib.parse.parse_qs(urllib.parse.urlparse(location).query)["authorization_id"][0]
        status, _, text = request(f"/auth/v1/oauth/authorizations/{authorization_id}", token=self.person_token)
        assert status == 200, f"the authorization's details answered {status}: {text[:300]}"
        callback = json.loads(text).get("redirect_url")
        # A remembered approval answers with the finished redirect; otherwise the consent page asks.
        self.asked_for_consent = not callback
        if not callback:
            status, _, text = request(
                f"/auth/v1/oauth/authorizations/{authorization_id}/consent", method="POST",
                token=self.person_token, body={"action": "approve"},
            )
            assert status == 200, f"the approval was refused ({status}): {text[:300]}"
            callback = json.loads(text)["redirect_url"]
        return urllib.parse.parse_qs(urllib.parse.urlparse(callback).query)["code"][0]

    def tokens(self):
        status, _, text = request(
            "/auth/v1/oauth/token", method="POST", basic=(GRAFANA, CLIENT_SECRET),
            form={"grant_type": "authorization_code", "code": self.code(), "redirect_uri": self.redirect_uri,
                  "code_verifier": self.verifier},
        )
        assert status == 200, f"the code exchange answered {status}: {text[:300]}"
        body = json.loads(text)
        return body["access_token"], body["refresh_token"]


def refresh(refresh_token):
    """The app renewing its access, as Grafana does with its client secret."""
    return request(
        "/auth/v1/oauth/token", method="POST", basic=(GRAFANA, CLIENT_SECRET),
        form={"grant_type": "refresh_token", "refresh_token": refresh_token},
    )


class RevokingAnAppEndsItsRefreshToken(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not PUBLISHABLE_KEY or not CLIENT_SECRET:
            reason = "SUPABASE_PUBLISHABLE_KEY and GRAFANA_OAUTH_CLIENT_SECRET are needed"
            if STRICT:
                raise AssertionError(f"{reason}, and REQUIRE_SEEDED_ACCOUNTS is set")
            raise unittest.SkipTest(reason)
        cls.person_token, cls.person_id = sign_in(PERSON)
        cls.admin_token, cls.admin_id = sign_in(ADMIN)
        apps = {a["id"]: a for a in rpc(cls.admin_token, "list_apps")}
        assert GRAFANA in apps, "list_apps() does not list Grafana's client"
        cls.redirect_uri = apps[GRAFANA]["redirect_uris"][0]
        # Start from no approval, so the first sign-in is asked for one.
        revoke_own(cls.person_token)

    @classmethod
    def tearDownClass(cls):
        revoke_own(cls.person_token)

    def signed_in_app(self):
        """The app signed in as the person, its refresh token proven to work once."""
        app = AppSignIn(self.person_token, self.redirect_uri)
        access, refresh_token = app.tokens()
        self.assertTrue(app.asked_for_consent, "the consent page did not ask, so an approval was still in force")
        status, _, text = refresh(refresh_token)
        self.assertEqual(status, 200, f"the app's refresh token did not work before any revoke: {text[:300]}")
        body = json.loads(text)
        status, _, text = request(READ, token=body["access_token"])
        self.assertEqual(status, 200, f"the app's access token was not served: {text[:300]}")
        return body["access_token"], body["refresh_token"]

    def assert_access_ended(self, access, refresh_token):
        status, _, text = refresh(refresh_token)
        self.assertIn(status, (400, 401), f"the app's refresh token still works ({status}): {text[:300]}")
        self.assertNotIn("access_token", text)
        status, _, text = request(READ, token=access)
        self.assertEqual(status, 401, f"the app's access token is still served: {text[:300]}")
        self.assertEqual(json.loads(text).get("code"), "session_not_found", text[:300])
        status, _, text = request(READ, token=self.person_token)
        self.assertEqual(status, 200, f"the revoke ended the person's own dashboard session: {text[:300]}")
        listed = rpc(self.person_token, "list_my_app_approvals")
        self.assertNotIn(GRAFANA, [a["client_id"] for a in listed])

    def last_audit_id(self):
        status, _, text = request("/rest/v1/audit_trail?select=id&order=id.desc&limit=1", token=self.admin_token)
        self.assertEqual(status, 200, text[:300])
        rows = json.loads(text)
        return rows[0]["id"] if rows else 0

    def audit_rows(self, since):
        query = urllib.parse.urlencode({
            "select": "action,changed_by,new_data", "entity_id": f"eq.{self.person_id}",
            "action": "in.(APP_APPROVED,APP_APPROVAL_REVOKED)", "id": f"gt.{since}", "order": "id",
        })
        status, _, text = request(f"/rest/v1/audit_trail?{query}", token=self.admin_token)
        self.assertEqual(status, 200, text[:300])
        return [r for r in json.loads(text) if (r["new_data"] or {}).get("app", {}).get("id") == GRAFANA]

    def test_1_the_persons_own_revoke_ends_the_apps_refresh_token(self):
        since = self.last_audit_id()
        access, refresh_token = self.signed_in_app()
        self.assertEqual(revoke_own(self.person_token), 204)
        self.assert_access_ended(access, refresh_token)
        self.assertEqual([(r["action"], r["changed_by"]) for r in self.audit_rows(since)],
                         [("APP_APPROVED", self.person_id), ("APP_APPROVAL_REVOKED", self.person_id)])

    def test_2_an_administrators_revoke_ends_it_too(self):
        since = self.last_audit_id()
        access, refresh_token = self.signed_in_app()
        ended = rpc(self.admin_token, "revoke_app_approval", {"p_user_id": self.person_id, "p_client_id": GRAFANA})
        self.assertGreaterEqual(ended, 1)
        self.assert_access_ended(access, refresh_token)
        self.assertEqual([(r["action"], r["changed_by"]) for r in self.audit_rows(since)],
                         [("APP_APPROVED", self.person_id), ("APP_APPROVAL_REVOKED", self.admin_id)])


if __name__ == "__main__":
    unittest.main()
