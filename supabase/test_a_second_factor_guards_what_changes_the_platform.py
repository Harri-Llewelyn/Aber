"""
With MFA required, a manager's change to the platform needs a session that gave its code, against a
running stack (0251).

A throwaway Shopfloor Manager, made with the secret key and never one of the seeded personas, signs
in with a password and enrols a TOTP factor through GoTrue's factor API, with each code computed
here (RFC 6238, the standard library only). The Settings row security.require_mfa_for_managers is
turned on and off through the API with the secret key. With it on:

  * the consent step (the gateway's consent-gate) refuses the person's aal1 session on both of the
    consent page's calls for Node-RED, with 403 mfa_required and a sentence naming Profile › MFA,
    and admits their aal2 session, whose Node-RED sign-in then completes;
  * Grafana's sign-in passes at aal1, since the switch does not cover it;
  * gateway-bundle, one of the edge functions that change the platform, refuses the aal1 session
    with the same sentence before it reads any gateway, and lets the aal2 session past;
  * turning it on ends the person's Node-RED session, won at aal1 while it was off, so its refresh
    token is refused, while their Grafana session's refresh token goes on working; one
    SESSIONS_ENDED row in their lane says so.

    python supabase/test_a_second_factor_guards_what_changes_the_platform.py

Needs SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY, NODERED_OAUTH_CLIENT_SECRET and
GRAFANA_OAUTH_CLIENT_SECRET (`dev-cluster test` passes them from the cluster's Secret). Turning the
switch on ends every covered person's app sessions but Grafana's, the seeded people's included. The
switch is set back to the value the suite found. At the end the person is removed as Access Control
removes one: the Audit Trail names them, so they cannot be deleted, and they keep no role and cannot
sign in. The Audit Trail keeps the person's role being given and going, the
switch's changes, their approvals of Node-RED and Grafana, and the SESSIONS_ENDED row.
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import struct
import sys
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test-harness"))
import stack_sign_in  # noqa: E402  -- waits out the lane's shared sign-in limit

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
SECRET_KEY = os.getenv("SUPABASE_SECRET_KEY", "")
STRICT = os.getenv("REQUIRE_SEEDED_ACCOUNTS", "").lower() in ("1", "true", "yes")

GRAFANA = "c0ffee00-0000-4000-8000-000000000001"
NODE_RED = "c0ffee00-0000-4000-8000-000000000002"
# Each app's client, how it authenticates at the token endpoint, and the scopes it asks for.
APPS = {
    GRAFANA: {"name": "Grafana", "secret": os.getenv("GRAFANA_OAUTH_CLIENT_SECRET", ""), "auth": "basic",
              "scope": "openid email profile"},
    NODE_RED: {"name": "Node-RED", "secret": os.getenv("NODERED_OAUTH_CLIENT_SECRET", ""), "auth": "post",
               "scope": "openid email profile"},
}

SWITCH = "/rest/v1/system_settings?key=eq.security.require_mfa_for_managers"
# require_mfa()'s sentence (0001), which consent-gate and the functions answer with too.
POINTER = "Profile › MFA"
MFA_REFUSAL_CODE = "mfa_required"
CONSENT = "/auth/v1/oauth/authorizations"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args):
        return None


OPENER = urllib.request.build_opener(_NoRedirect)


def request(path, method="GET", token=None, body=None, form=None, basic=None, key=None, prefer=None):
    """One call through the gateway: (status, headers, text). Redirects are returned, not followed.
    `key` is the apikey, the publishable one by default."""
    headers = {"apikey": key or PUBLISHABLE_KEY}
    data = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if basic:
        headers["Authorization"] = "Basic " + base64.b64encode(f"{basic[0]}:{basic[1]}".encode()).decode()
    if prefer:
        headers["Prefer"] = prefer
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(f"{SUPABASE_URL}{path}", method=method, data=data, headers=headers)
    try:
        with OPENER.open(req, timeout=20) as response:
            return response.status, {k.lower(): v for k, v in response.headers.items()}, response.read().decode()
    except urllib.error.HTTPError as err:
        with err:
            return err.code, {k.lower(): v for k, v in err.headers.items()}, err.read().decode()


def as_service(path, method="GET", body=None, prefer=None):
    """A call with the secret key, which the gateway hands on as the service_role token."""
    return request(path, method=method, token=SECRET_KEY, body=body, key=SECRET_KEY, prefer=prefer)


def must(what, answer, expected=(200,)):
    status, _, text = answer
    if status not in expected:
        raise AssertionError(f"{what}: HTTP {status} {text[:300]}")
    return json.loads(text) if text else None


def totp(secret, step=0):
    """RFC 6238 with GoTrue's parameters: HMAC-SHA1, 30-second steps, six digits. `step` moves the
    counter, so two verifications in one window use different codes."""
    key = base64.b32decode(secret.upper() + "=" * (-len(secret) % 8))
    counter = int(time.time() // 30) + step
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return f"{value % 1_000_000:06d}"


def claims(token):
    payload = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


def set_switch(on):
    rows = must(f"turn the switch {'on' if on else 'off'}",
                as_service(SWITCH, method="PATCH", body={"value": on}, prefer="return=representation"))
    assert rows and rows[0]["value"] is on, f"the switch is not {on}: {rows}"


class AppSignIn:
    """An app's side of the flow: PKCE, the authorize redirect, consent, the code exchange."""

    redirects = {}

    def __init__(self, app_id, person_token):
        self.app_id, self.app = app_id, APPS[app_id]
        self.person_token = person_token
        self.redirect_uri = AppSignIn.redirects[app_id]
        self.verifier = secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(self.verifier.encode()).digest()).decode().rstrip("=")
        self.query = urllib.parse.urlencode({
            "response_type": "code", "client_id": app_id, "redirect_uri": self.redirect_uri,
            "scope": self.app["scope"], "state": secrets.token_urlsafe(12), "code_challenge": challenge,
            "code_challenge_method": "S256",
        })

    def start(self):
        """The authorize step, which names the request the consent page reads."""
        status, headers, text = request(f"/auth/v1/oauth/authorize?{self.query}")
        location = headers.get("location", "")
        assert "authorization_id=" in location, f"authorize answered {status} to {location!r}: {text[:300]}"
        return urllib.parse.parse_qs(urllib.parse.urlparse(location).query)["authorization_id"][0]

    def code(self):
        authorization_id = self.start()
        status, _, text = request(f"{CONSENT}/{authorization_id}", token=self.person_token)
        assert status == 200, f"{self.app['name']}'s sign-in request answered {status}: {text[:300]}"
        callback = json.loads(text).get("redirect_url")
        # A remembered approval answers with the finished redirect; otherwise the consent page asks.
        if not callback:
            status, _, text = request(f"{CONSENT}/{authorization_id}/consent", method="POST",
                                      token=self.person_token, body={"action": "approve"})
            assert status == 200, f"{self.app['name']}'s approval was refused ({status}): {text[:300]}"
            callback = json.loads(text)["redirect_url"]
        return urllib.parse.parse_qs(urllib.parse.urlparse(callback).query)["code"][0]

    def tokens(self):
        form = {"grant_type": "authorization_code", "code": self.code(), "redirect_uri": self.redirect_uri,
                "code_verifier": self.verifier}
        return exchange(self.app_id, form)


def exchange(app_id, form):
    """The app at GoTrue's token endpoint, authenticated as the app authenticates."""
    app = APPS[app_id]
    basic = (app_id, app["secret"]) if app["auth"] == "basic" else None
    if not basic:
        form = {**form, "client_id": app_id, "client_secret": app["secret"]}
    return request("/auth/v1/oauth/token", method="POST", basic=basic, form=form)


def refresh(app_id, refresh_token):
    return exchange(app_id, {"grant_type": "refresh_token", "refresh_token": refresh_token})


class ASecondFactorGuardsWhatChangesThePlatform(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        missing = [name for name, value in (
            ("SUPABASE_PUBLISHABLE_KEY", PUBLISHABLE_KEY), ("SUPABASE_SECRET_KEY", SECRET_KEY),
            ("GRAFANA_OAUTH_CLIENT_SECRET", APPS[GRAFANA]["secret"]),
            ("NODERED_OAUTH_CLIENT_SECRET", APPS[NODE_RED]["secret"])) if not value]
        if missing:
            reason = f"{', '.join(missing)} {'is' if len(missing) == 1 else 'are'} needed"
            if STRICT:
                raise AssertionError(f"{reason}, and REQUIRE_SEEDED_ACCOUNTS is set")
            raise unittest.SkipTest(reason)

        found = must("read the switch", as_service(f"{SWITCH}&select=value"))
        assert len(found) == 1, f"0002 declares no security.require_mfa_for_managers: {found}"
        cls.found = found[0]["value"] is True
        cls.person_id = None
        cls.factor = None
        cls.aal2 = None
        try:
            cls.prepare()
        except BaseException:
            # unittest skips tearDownClass when setUpClass fails: put the stack back here instead.
            cls.tearDownClass()
            raise

    @classmethod
    def prepare(cls):
        """The apps' registered addresses, and the person: a Shopfloor Manager with no factor."""
        set_switch(False)
        for app_id in APPS:
            client = must(f"read {APPS[app_id]['name']}'s client", as_service(f"/auth/v1/admin/oauth/clients/{app_id}"))
            uris = client.get("redirect_uris") or []
            uris = uris if isinstance(uris, list) else [u.strip() for u in str(uris).split(",") if u.strip()]
            assert uris, f"{APPS[app_id]['name']}'s client has no redirect address: {client}"
            AppSignIn.redirects[app_id] = uris[0]

        cls.email = f"second-factor-gate-{secrets.token_hex(6)}@aber.local"
        cls.password = secrets.token_urlsafe(24)
        made = must("make the suite's person", as_service(
            "/auth/v1/admin/users", method="POST",
            body={"email": cls.email, "password": cls.password, "email_confirm": True}))
        cls.person_id = made["id"]
        roles = {r["name"]: r["id"] for r in must("read the roles", as_service("/rest/v1/roles?select=id,name"))}
        must("give the person Shopfloor_Manager", as_service(
            "/rest/v1/user_roles", method="POST", prefer="return=minimal",
            body={"user_id": cls.person_id, "role_id": roles["Shopfloor_Manager"]}), expected=(201,))

    @classmethod
    def tearDownClass(cls):
        problems = []
        try:
            set_switch(cls.found)
        except AssertionError as err:
            problems.append(f"{err}; set security.require_mfa_for_managers back to {cls.found} on Settings")
        if cls.person_id:
            status, _, text = as_service(f"/auth/v1/admin/users/{cls.person_id}", method="DELETE")
            if status != 200 and "23503" in text:
                # The Audit Trail names the person (audit_trail_changed_by_fkey), so they cannot be
                # deleted. Remove them as manage-people's "remove" does: no role, sign-in blocked.
                gone, _, why = as_service(f"/rest/v1/user_roles?user_id=eq.{cls.person_id}",
                                          method="DELETE", prefer="return=minimal")
                if gone not in (200, 204):
                    problems.append(f"{cls.email} keeps their role ({gone} {why[:200]}): remove them on Access Control")
                banned, _, why = as_service(f"/auth/v1/admin/users/{cls.person_id}", method="PUT",
                                            body={"ban_duration": "876000h"})
                if banned != 200:
                    problems.append(f"{cls.email} can still sign in ({banned} {why[:200]}): remove them on Access Control")
            elif status != 200:
                problems.append(f"{cls.email} was not deleted ({status} {text[:200]}): delete it with GoTrue's admin API")
        if problems:
            raise AssertionError("; ".join(problems))

    # ---- the person's sessions ----------------------------------------------------------------

    def password_session(self):
        """A password sign-in: aal1, with or without a factor."""
        status, body = stack_sign_in.password_grant(SUPABASE_URL, PUBLISHABLE_KEY, self.email, self.password)
        self.assertEqual(status, 200, stack_sign_in.describe(self.email, status, body))
        return body["access_token"]

    def verify(self, token, factor_id, code):
        challenge = must("challenge the factor", request(f"/auth/v1/factors/{factor_id}/challenge", method="POST",
                                                         token=token, body={}))
        return must("verify the code", request(f"/auth/v1/factors/{factor_id}/verify", method="POST", token=token,
                                               body={"challenge_id": challenge["id"], "code": code}))

    def aal2_session(self):
        """The session that enrolled the factor, raised to aal2 by its first code. Enrolled once."""
        cls = type(self)
        if cls.aal2 is None:
            first = self.password_session()
            enrolled = must("enrol a TOTP factor", request("/auth/v1/factors", method="POST", token=first,
                                                           body={"factor_type": "totp", "friendly_name": "Suite phone"}))
            cls.factor = (enrolled["id"], enrolled["totp"]["secret"])
            cls.aal2 = self.verify(first, cls.factor[0], totp(cls.factor[1]))["access_token"]
            self.assertEqual(claims(cls.aal2)["aal"], "aal2")
        return cls.aal2

    def assert_mfa_refusal(self, answer, what):
        status, headers, text = answer
        self.assertEqual(status, 403, f"{what} was not refused ({status}): {text[:300]}")
        body = json.loads(text)
        self.assertEqual(body.get("error_code") or body.get("code"), MFA_REFUSAL_CODE, f"{what}: {body}")
        self.assertIn(POINTER, body.get("msg") or body.get("details") or "", f"{what} does not say where to add one")
        return headers

    def last_audit_id(self):
        rows = must("read the Audit Trail", as_service("/rest/v1/audit_trail?select=id&order=id.desc&limit=1"))
        return rows[0]["id"] if rows else 0

    # ---- the tests, in order: the first needs a person with no factor yet ----------------------

    def test_1_turning_the_switch_on_ends_the_persons_app_sessions_but_grafanas(self):
        set_switch(False)
        token = self.password_session()
        won = {}
        for app_id in (NODE_RED, GRAFANA):
            status, _, text = AppSignIn(app_id, token).tokens()
            self.assertEqual(status, 200, f"{APPS[app_id]['name']}'s code exchange answered {status}: {text[:300]}")
            status, _, text = refresh(app_id, json.loads(text)["refresh_token"])
            self.assertEqual(status, 200, f"{APPS[app_id]['name']}'s refresh token did not work at first: {text[:300]}")
            won[app_id] = json.loads(text)["refresh_token"]

        since = self.last_audit_id()
        set_switch(True)
        status, _, text = refresh(NODE_RED, won[NODE_RED])
        self.assertIn(status, (400, 401), f"Node-RED's refresh token still works ({status}): {text[:300]}")
        self.assertNotIn("access_token", text)
        status, _, text = refresh(GRAFANA, won[GRAFANA])
        self.assertEqual(status, 200, f"turning the switch on ended Grafana's session too ({status}): {text[:300]}")

        query = urllib.parse.urlencode({
            "select": "changed_by,new_data", "entity_type": "eq.user_roles", "entity_id": f"eq.{self.person_id}",
            "action": "eq.SESSIONS_ENDED", "id": f"gt.{since}",
        })
        rows = must("read the SESSIONS_ENDED row", as_service(f"/rest/v1/audit_trail?{query}"))
        self.assertEqual(len(rows), 1, rows)
        self.assertEqual(rows[0]["new_data"]["email"], self.email)
        self.assertGreaterEqual(rows[0]["new_data"]["sessions_ended"], 1)
        self.assertEqual(rows[0]["new_data"]["reason"], "MFA was turned on in Settings")
        set_switch(False)

    def test_2_the_consent_step_refuses_an_aal1_session_and_admits_aal2(self):
        self.aal2_session()
        set_switch(True)
        token = self.password_session()
        self.assertEqual(claims(token)["aal"], "aal1")
        authorization = AppSignIn(NODE_RED, token).start()
        for method, path, body in (("GET", f"{CONSENT}/{authorization}", None),
                                   ("POST", f"{CONSENT}/{authorization}/consent", {"action": "deny"})):
            headers = self.assert_mfa_refusal(request(path, method=method, token=token, body=body), f"{method} {path}")
            self.assertNotIn("x-envoy-upstream-service-time", headers, f"{method} {path}: GoTrue answered, not the gate")

        raised = self.verify(token, self.factor[0], totp(self.factor[1], step=1))["access_token"]
        self.assertEqual(claims(raised)["aal"], "aal2")
        status, _, text = AppSignIn(NODE_RED, raised).tokens()
        self.assertEqual(status, 200, f"Node-RED's sign-in did not complete at aal2 ({status}): {text[:300]}")
        self.assertEqual(claims(json.loads(text)["access_token"]).get("client_id"), NODE_RED)

    def test_3_grafana_s_sign_in_passes_at_aal1(self):
        set_switch(True)
        token = self.password_session()
        self.assertEqual(claims(token)["aal"], "aal1")
        status, _, text = AppSignIn(GRAFANA, token).tokens()
        self.assertEqual(status, 200, f"Grafana's sign-in did not complete at aal1 ({status}): {text[:300]}")
        self.assertEqual(claims(json.loads(text)["access_token"]).get("client_id"), GRAFANA)

    def test_4_a_function_that_changes_the_platform_refuses_aal1(self):
        aal2 = self.aal2_session()
        set_switch(True)
        token = self.password_session()
        gateway = {"gateway_id": str(uuid.uuid4())}
        self.assert_mfa_refusal(request("/functions/v1/gateway-bundle", method="POST", token=token, body=gateway),
                                "gateway-bundle at aal1")
        status, _, text = request("/functions/v1/gateway-bundle", method="POST", token=aal2, body=gateway)
        self.assertFalse(status == 403 and MFA_REFUSAL_CODE in text,
                         f"gateway-bundle refused an aal2 session for MFA: {text[:300]}")


if __name__ == "__main__":
    unittest.main()
