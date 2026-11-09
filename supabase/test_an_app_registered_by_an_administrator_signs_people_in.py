"""
An app an Administrator registers signs people in with Aber, against a running stack (0260).

The seeded Administrator registers a confidential and a public app with register_app(), the call the
Apps tab's Register App makes, and a seeded Shopfloor Manager signs in to each as the app does: the
authorization-code flow with PKCE, the consent page's approval, the code exchanged. Held here, which
only GoTrue and the gateway together can show:

  * the secret is in the registration's answer and nowhere after it, a name cannot be registered
    twice, and the Audit Trail names the Administrator;
  * discovery names an absolute issuer and endpoints built from it, the access token and the ID token
    carry that issuer as `iss`, and the ID token verifies against the key set;
  * a public app signs in with PKCE alone, and a secret from it, a secret sent the wrong way or a wrong
    code verifier is refused;
  * the app's access token reaches user-info and GET /auth/v1/user, refreshes, and signs out its own
    session, and is refused with the gateway's 403 on PUT /auth/v1/user, the factor routes, the
    approvals, a PostgREST read, a Storage read and an edge function; the ID token is not served as the
    person either;
  * revoking the approval ends the app's session: its refresh token and its access token are refused;
  * a removed app can no longer start a sign-in.

    python supabase/test_an_app_registered_by_an_administrator_signs_people_in.py

Needs SUPABASE_PUBLISHABLE_KEY and the seeded accounts (`dev-cluster test` passes the key). Needs the
Administrator's sign-in to satisfy Settings' second-factor switch: with security.require_mfa_for_managers
on, a password sign-in is aal1 and the registration is refused, so the suite skips and says so. Every app
it registers is removed at the end, which revokes each approval and ends each session.
"""
import base64
import hashlib
import json
import os
import secrets
import sys
import unittest
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "test-harness"))
import test_each_app_s_token_reaches_only_its_own_routes as stack  # noqa: E402  -- its request() and sign-in

try:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
except ImportError:  # the signature is then not checked, and the test says so
    ec = None

CONFIDENTIAL_REDIRECT = "http://localhost:8765/callback"
PUBLIC_REDIRECT = "http://127.0.0.1:8766/callback"
SCOPE = "openid email profile"
ADMIN, PERSON = stack.ADMIN, stack.PERSON
APP_REFUSAL = stack.APP_REFUSAL

# What an outside app's token is refused on: the rest of /auth/v1/, the data APIs and the functions.
REFUSED = [
    ("PUT", "/auth/v1/user", {"data": {"note": "a test"}}),
    ("POST", "/auth/v1/factors", {"factor_type": "totp"}),
    ("GET", "/auth/v1/user/oauth/grants", None),
    ("DELETE", "/auth/v1/user/oauth/grants?client_id=00000000-0000-4000-8000-000000000000", None),
    ("GET", "/auth/v1/reauthenticate", None),
    ("POST", "/auth/v1/logout", None),
    ("POST", "/auth/v1/logout?scope=global", None),
    ("GET", "/auth/v1/oauth/authorizations/not-an-authorization", None),
    ("GET", stack.API_READ, None),
    ("GET", stack.STORAGE_READ, None),
    ("GET", stack.GATED_FUNCTION, None),
    ("GET", stack.EXEMPT_FUNCTION, None),
]


def b64url(data):
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def unb64url(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def verify_es256(token, jwks):
    """Whether the ES256 signature of `token` verifies with the key its kid names in `jwks`."""
    header_b64, payload_b64, signature_b64 = token.split(".")
    header = json.loads(unb64url(header_b64))
    key = next(k for k in jwks["keys"] if k.get("kid") == header.get("kid"))
    public = ec.EllipticCurvePublicNumbers(
        int.from_bytes(unb64url(key["x"]), "big"), int.from_bytes(unb64url(key["y"]), "big"), ec.SECP256R1(),
    ).public_key()
    raw = unb64url(signature_b64)
    der = encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
    public.verify(der, f"{header_b64}.{payload_b64}".encode(), ec.ECDSA(hashes.SHA256()))
    return True


class Flow:
    """An app's side of the sign-in: PKCE, the authorize redirect, the person's consent, the exchange."""

    def __init__(self, app, person_token):
        self.app, self.person_token = app, person_token
        self.verifier = secrets.token_urlsafe(48)
        self.nonce = secrets.token_urlsafe(12)
        self.state = secrets.token_urlsafe(12)
        challenge = b64url(hashlib.sha256(self.verifier.encode()).digest())
        self.query = urllib.parse.urlencode({
            "response_type": "code", "client_id": app["id"], "redirect_uri": app["redirect"], "scope": SCOPE,
            "state": self.state, "nonce": self.nonce, "code_challenge": challenge, "code_challenge_method": "S256",
        })
        self.consent_page = None

    def code(self):
        status, headers, text = stack.request(f"/auth/v1/oauth/authorize?{self.query}")
        location = headers.get("location", "")
        assert "authorization_id=" in location, f"authorize answered {status} to {location!r}: {text[:300]}"
        authorization_id = urllib.parse.parse_qs(urllib.parse.urlparse(location).query)["authorization_id"][0]
        status, _, text = stack.request(f"/auth/v1/oauth/authorizations/{authorization_id}", token=self.person_token)
        refused_for_mfa(status, text)
        assert status == 200, f"the authorization's details answered {status}: {text[:300]}"
        self.consent_page = json.loads(text)
        callback = self.consent_page.get("redirect_url")
        if not callback:
            status, _, text = stack.request(
                f"/auth/v1/oauth/authorizations/{authorization_id}/consent", method="POST",
                token=self.person_token, body={"action": "approve"},
            )
            refused_for_mfa(status, text)
            assert status == 200, f"the approval was refused ({status}): {text[:300]}"
            callback = json.loads(text)["redirect_url"]
        returned = urllib.parse.parse_qs(urllib.parse.urlparse(callback).query)
        assert returned["state"][0] == self.state, "the sign-in did not return the state it was given"
        return returned["code"][0]

    def exchange(self, code=None, verifier=None, secret="as-registered", method="as-registered"):
        """The token endpoint's (status, parsed answer) for this app's code exchange, or a variant of it."""
        form = {"grant_type": "authorization_code", "code": code or self.code(), "redirect_uri": self.app["redirect"],
                "code_verifier": verifier or self.verifier}
        return token_call(self.app, form, secret, method)

    def tokens(self):
        status, answer = self.exchange()
        assert status == 200, f"the code exchange answered {status}: {answer}"
        return answer


def token_call(app, form, secret="as-registered", method="as-registered"):
    """One call to the token endpoint as `app` authenticates: Basic for a confidential app, the client
    id in the body for a public one. `secret` and `method` override either, to show a variant refused."""
    form = dict(form)
    secret = app["secret"] if secret == "as-registered" else secret
    method = ("basic" if app["secret"] else "none") if method == "as-registered" else method
    basic = None
    if method == "basic":
        basic = (app["id"], secret)
    else:
        form["client_id"] = app["id"]
        if method == "post":
            form["client_secret"] = secret
        elif secret:
            form["client_secret"] = secret
    status, _, text = stack.request("/auth/v1/oauth/token", method="POST", basic=basic, form=form)
    try:
        return status, json.loads(text)
    except ValueError:
        return status, text


def refused_for_mfa(status, text):
    """The consent step asks the person's second factor while Settings requires one; this suite signs in
    by password, so the run is skipped rather than failed."""
    if status == 403 and "mfa_required" in text:
        raise unittest.SkipTest("Settings requires a second factor and a password sign-in has none: "
                                "turn security.require_mfa_for_managers off for this run")


def person_request(path, token, method="GET", body=None):
    return stack.request(path, method=method, token=token, body=body)


class RegisteredApps(unittest.TestCase):
    apps = {}
    removed = False

    @classmethod
    def setUpClass(cls):
        if not stack.PUBLISHABLE_KEY:
            reason = "SUPABASE_PUBLISHABLE_KEY is needed"
            if stack.STRICT:
                raise AssertionError(f"{reason}, and REQUIRE_SEEDED_ACCOUNTS is set")
            raise unittest.SkipTest(reason)
        cls.admin_token, cls.admin_id = stack.sign_in(ADMIN)
        cls.person_token, cls.person_id = stack.sign_in(PERSON)
        cls.suffix = secrets.token_hex(3)
        cls.ids = []
        try:
            cls.apps["confidential"] = cls.register(f"Run Test Viewer {cls.suffix}", CONFIDENTIAL_REDIRECT, "confidential")
            cls.apps["public"] = cls.register(f"Run Test Plant App {cls.suffix}", PUBLIC_REDIRECT, "public")
        except BaseException:
            cls.tearDownClass()
            raise
        status, _, text = stack.request("/auth/v1/.well-known/openid-configuration")
        assert status == 200, f"discovery answered {status}: {text[:200]}"
        cls.discovery = json.loads(text)
        status, _, text = stack.request("/auth/v1/.well-known/jwks.json")
        assert status == 200, f"the key set answered {status}: {text[:200]}"
        cls.jwks = json.loads(text)

    @classmethod
    def tearDownClass(cls):
        # remove_app() revokes every approval of the app and ends every session it holds.
        for app_id in getattr(cls, "ids", []):
            stack.request("/rest/v1/rpc/remove_app", method="POST", token=cls.admin_token, body={"p_client_id": app_id})
        if getattr(cls, "admin_token", None):
            stack.sign_out(cls.admin_token)
        if getattr(cls, "person_token", None):
            stack.sign_out(cls.person_token)

    @classmethod
    def register(cls, name, redirect, kind):
        status, _, text = stack.request(
            "/rest/v1/rpc/register_app", method="POST", token=cls.admin_token,
            body={"p_name": name, "p_redirect_uris": [redirect], "p_client_type": kind},
        )
        if status != 200:
            if "mfa_required" in text:
                raise unittest.SkipTest("Settings requires a second factor and a password sign-in has none: "
                                        "turn security.require_mfa_for_managers off for this run")
            raise AssertionError(f"register_app answered {status}: {text[:300]}")
        answer = json.loads(text)
        cls.ids.append(answer["id"])
        return {"id": answer["id"], "name": name, "redirect": redirect, "kind": kind, "secret": answer["client_secret"],
                "answer": answer}

    def app_bearer(self, kind="confidential"):
        return Flow(self.apps[kind], self.person_token).tokens()

    # -- registration -----------------------------------------------------------------------------

    def test_the_secret_is_in_the_answer_once_and_in_no_read_after_it(self):
        confidential, public = self.apps["confidential"], self.apps["public"]
        self.assertRegex(confidential["secret"], r"^[A-Za-z0-9_-]{43}$")
        self.assertIsNone(public["secret"], "a public app has no secret")
        self.assertEqual(confidential["answer"]["client_type"], "confidential")
        apps = {a["id"]: a for a in stack.rpc(self.admin_token, "list_apps")}
        for app in (confidential, public):
            listed = apps[app["id"]]
            self.assertEqual((listed["registration_type"], listed["part_of_stack"]), ("manual", False))
            self.assertEqual(listed["redirect_uris"], [app["redirect"]])
        self.assertEqual(apps[confidential["id"]]["client_type"], "confidential")
        self.assertEqual(apps[public["id"]]["client_type"], "public")
        everything = json.dumps(apps) + json.dumps(stack.rpc(self.admin_token, "app_approvals", {"p_client_id": confidential["id"]}))
        self.assertNotIn(confidential["secret"], everything)

    def test_a_name_cannot_be_registered_twice(self):
        status, _, text = stack.request(
            "/rest/v1/rpc/register_app", method="POST", token=self.admin_token,
            body={"p_name": self.apps["confidential"]["name"].lower(), "p_redirect_uris": [CONFIDENTIAL_REDIRECT],
                  "p_client_type": "public"},
        )
        self.assertEqual(status, 409, text)
        self.assertIn("is already registered", text)

    def test_only_an_administrator_registers(self):
        status, _, text = stack.request(
            "/rest/v1/rpc/register_app", method="POST", token=self.person_token,
            body={"p_name": f"Not Allowed {self.suffix}", "p_redirect_uris": [CONFIDENTIAL_REDIRECT], "p_client_type": "public"},
        )
        self.assertEqual(status, 403, text)

    def test_the_audit_trail_names_the_administrator_and_holds_no_secret(self):
        app = self.apps["confidential"]
        status, _, text = stack.request(
            f"/rest/v1/audit_trail?entity_id=eq.{app['id']}&select=action,changed_by,actor_source,new_data",
            token=self.admin_token,
        )
        if status != 200:
            self.skipTest(f"the Administrator could not read the Audit Trail ({status})")
        rows = json.loads(text)
        registered = [r for r in rows if r["action"] == "APP_REGISTERED"]
        self.assertEqual(len(registered), 1, rows)
        self.assertEqual((registered[0]["changed_by"], registered[0]["actor_source"]), (self.admin_id, "user"))
        self.assertEqual(registered[0]["new_data"]["name"], app["name"])
        self.assertNotIn(app["secret"], text)

    # -- discovery and the sign-in ----------------------------------------------------------------

    def test_discovery_names_an_absolute_issuer_and_endpoints_built_from_it(self):
        issuer = self.discovery["issuer"]
        self.assertRegex(issuer, r"^https?://[^/]+/auth/v1$", "an absolute issuer, the public auth address")
        for key, path in [("authorization_endpoint", "/oauth/authorize"), ("token_endpoint", "/oauth/token"),
                          ("userinfo_endpoint", "/oauth/userinfo"), ("jwks_uri", "/.well-known/jwks.json")]:
            self.assertEqual(self.discovery[key], issuer + path, key)
        self.assertNotIn("registration_endpoint", self.discovery, "dynamic registration stays off")
        self.assertIn("S256", self.discovery["code_challenge_methods_supported"])

    def test_a_confidential_app_signs_a_person_in_and_the_id_token_verifies(self):
        app = self.apps["confidential"]
        flow = Flow(app, self.person_token)
        tokens = flow.tokens()
        self.assertEqual(flow.consent_page["client"]["name"], app["name"], "the consent page shows the app's own name")
        issuer = self.discovery["issuer"]

        access = stack.claims_of(tokens["access_token"])
        self.assertEqual((access["client_id"], access["sub"], access["iss"], access["aal"]),
                         (app["id"], self.person_id, issuer, "aal1"))

        self.assertIn("id_token", tokens, "the openid scope was asked for")
        header = json.loads(unb64url(tokens["id_token"].split(".")[0]))
        self.assertEqual(header["alg"], "ES256")
        self.assertIn(header["kid"], [k["kid"] for k in self.jwks["keys"]])
        claims = stack.claims_of(tokens["id_token"])
        self.assertEqual((claims["iss"], claims["aud"], claims["sub"], claims["nonce"]),
                         (issuer, app["id"], self.person_id, flow.nonce))
        self.assertGreater(claims["exp"], claims["iat"])
        if ec is None:
            self.skipTest("the `cryptography` package is not installed: the ID token's signature was not checked")
        self.assertTrue(verify_es256(tokens["id_token"], self.jwks))

    def test_a_public_app_signs_in_with_pkce_alone_and_a_wrong_step_is_refused(self):
        app = self.apps["public"]
        flow = Flow(app, self.person_token)
        code = flow.code()
        status, answer = flow.exchange(code=code, secret="a-secret-a-public-app-has-none")
        self.assertEqual(status, 400, answer)
        status, answer = flow.exchange(code=code, verifier=secrets.token_urlsafe(48))
        self.assertEqual(status, 400, "a wrong code verifier")
        self.assertIn("invalid_grant", json.dumps(answer))
        # The code that failed twice may be spent or not; a fresh sign-in shows the right way.
        tokens = Flow(app, self.person_token).tokens()
        self.assertEqual(stack.claims_of(tokens["access_token"])["client_id"], app["id"])
        self.assertIn("refresh_token", tokens)

    def test_a_confidential_app_must_authenticate_the_way_it_is_registered(self):
        app = self.apps["confidential"]
        flow = Flow(app, self.person_token)
        code = flow.code()
        status, answer = flow.exchange(code=code, method="post")
        self.assertEqual(status, 400, "a secret in the body, where the app is registered for Basic")
        status, answer = flow.exchange(code=code, secret="not-the-secret")
        self.assertEqual(status, 400, "the wrong secret")
        status, answer = flow.exchange(code=code, method="none", secret="")
        self.assertEqual(status, 400, "no secret at all")

    # -- what the token reaches -------------------------------------------------------------------

    def test_the_access_token_reaches_the_sign_in_endpoints(self):
        tokens = self.app_bearer()
        status, _, text = person_request("/auth/v1/oauth/userinfo", tokens["access_token"])
        self.assertEqual(status, 200, text)
        info = json.loads(text)
        self.assertEqual(info["sub"], self.person_id)
        self.assertIn("email", info, "the email scope was allowed")
        status, _, text = person_request("/auth/v1/user", tokens["access_token"])
        self.assertEqual(status, 200, text)
        self.assertEqual(json.loads(text)["id"], self.person_id)

    def test_the_access_token_is_refused_everything_else(self):
        tokens = self.app_bearer()
        for method, path, body in REFUSED:
            with self.subTest(request=f"{method} {path}"):
                status, _, text = person_request(path, tokens["access_token"], method, body)
                self.assertEqual(status, 403, text)
                self.assertEqual(json.loads(text), APP_REFUSAL, "the gateway's own refusal, not an upstream's")

    def test_a_spelling_the_gateway_does_not_name_is_refused_too(self):
        tokens = self.app_bearer()
        for path in ("/auth/v1/user/", "/auth/v1//user", "/auth/v1/User", "/auth/v1/oauth/userinfo/"):
            with self.subTest(path=path):
                status, _, text = person_request(path, tokens["access_token"])
                self.assertEqual(status, 403, text)

    def test_the_id_token_is_not_served_as_the_person(self):
        tokens = self.app_bearer()
        for path in (stack.API_READ, stack.STORAGE_READ):
            status, _, text = person_request(path, tokens["id_token"])
            self.assertNotEqual(status, 200, f"{path} served an ID token: {text[:200]}")

    def test_the_dashboard_token_is_unchanged(self):
        status, _, text = person_request(stack.API_READ, self.person_token)
        self.assertEqual(status, 200, text)
        status, _, text = person_request("/auth/v1/user", self.person_token)
        self.assertEqual(status, 200, text)

    # -- the session ------------------------------------------------------------------------------

    def test_the_app_refreshes_its_token_and_signs_its_own_session_out(self):
        app = self.apps["confidential"]
        tokens = self.app_bearer()
        status, answer = token_call(app, {"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]})
        self.assertEqual(status, 200, answer)
        self.assertNotEqual(answer["refresh_token"], tokens["refresh_token"], "each refresh returns a new one")
        self.assertEqual(stack.claims_of(answer["access_token"])["client_id"], app["id"])
        status, _, text = person_request("/auth/v1/logout?scope=local", answer["access_token"], "POST")
        self.assertEqual(status, 204, text)
        status, _, _ = person_request("/auth/v1/oauth/userinfo", answer["access_token"])
        self.assertIn(status, (401, 403), "the session the logout ended")
        # The person's own session is not the one it ended.
        status, _, text = person_request("/auth/v1/user", self.person_token)
        self.assertEqual(status, 200, text)

    def test_revoking_the_approval_ends_the_app_s_session(self):
        app = self.apps["public"]
        tokens = self.app_bearer("public")
        status, _, _ = person_request("/auth/v1/oauth/userinfo", tokens["access_token"])
        self.assertEqual(status, 200)
        ended = stack.rpc(self.admin_token, "revoke_app_approval", {"p_user_id": self.person_id, "p_client_id": app["id"]})
        self.assertGreaterEqual(ended, 1, "the app held a session for the person")
        status, answer = token_call(app, {"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"]})
        self.assertEqual(status, 400, answer)
        status, _, _ = person_request("/auth/v1/oauth/userinfo", tokens["access_token"])
        self.assertIn(status, (401, 403), "its access token names a session that no longer exists")
        # The app asks the person again, and a second approval works.
        again = Flow(app, self.person_token)
        again.tokens()
        self.assertIsNone(again.consent_page.get("redirect_url"), "the consent page asked again")

    # -- removing it ------------------------------------------------------------------------------

    def test_a_removed_app_can_no_longer_start_a_sign_in(self):
        gone = self.register(f"Run Test Removed {self.suffix}", CONFIDENTIAL_REDIRECT, "confidential")
        Flow(gone, self.person_token).tokens()
        result = stack.rpc(self.admin_token, "remove_app", {"p_client_id": gone["id"]})
        self.assertEqual(result["name"], gone["name"])
        self.assertGreaterEqual(result["approvals_ended"], 1)
        self.assertGreaterEqual(result["sessions_ended"], 1)
        status, _, text = stack.request(f"/auth/v1/oauth/authorize?{Flow(gone, self.person_token).query}")
        self.assertEqual(status, 400, text)
        listed = {a["id"] for a in stack.rpc(self.admin_token, "list_apps")}
        self.assertNotIn(gone["id"], listed)
        # Its name is free again.
        again = self.register(gone["name"], CONFIDENTIAL_REDIRECT, "public")
        self.assertNotEqual(again["id"], gone["id"])


if __name__ == "__main__":
    unittest.main()
