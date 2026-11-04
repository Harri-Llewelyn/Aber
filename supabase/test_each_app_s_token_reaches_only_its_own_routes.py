"""
Each app's token reaches only its own routes, against a running stack (0235).

A seeded Shopfloor Manager signs in to each of the stack's four apps as the app does: the
authorization-code flow with PKCE, the consent page's approval, and the code exchanged with the
app's secret, as test_revoking_an_app_ends_its_refresh_token.py does for Grafana. The access token
GoTrue issues names the app in `client_id`. Through the gateway, each app's token:

  * reaches GoTrue, `/auth/v1/user`, where every app's functions check the session, and ends its
    own session there with `/auth/v1/logout`, as forge-signout does;
  * reaches the functions its app calls: grafana-userinfo for Grafana, nodered-userinfo for
    Node-RED. The Studio and forge doors call theirs from their own listeners, so none here;
  * is refused with the gateway's 403 on a PostgREST read, a Storage read, the other app's userinfo
    function, a gated function and an exempt one.

The person's own dashboard token reaches all of those as before. An app's ID token, which Grafana
and Node-RED also hold, is not served as the person.

    python supabase/test_each_app_s_token_reaches_only_its_own_routes.py

Needs SUPABASE_PUBLISHABLE_KEY and each app's client secret: GRAFANA_OAUTH_CLIENT_SECRET,
NODERED_OAUTH_CLIENT_SECRET, STUDIO_OAUTH_CLIENT_SECRET, GITEA_OAUTH_CLIENT_SECRET (`dev-cluster
test` passes them from the cluster's Secret). An app whose client is not registered, Studio's when
Studio is off, is skipped and says so. Each approval this makes is revoked at the end unless it was
in force before, and each app session it opens is signed out.
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
PASSWORD = os.getenv("ABER_SEED_PASSWORD", "aber123")
PERSON = "manager@aber.local"
ADMIN = "admin@aber.local"
STRICT = os.getenv("REQUIRE_SEEDED_ACCOUNTS", "").lower() in ("1", "true", "yes")

# The gateway's own refusal (supabase/envoy.yaml, the API listener's local_reply_config).
APP_REFUSAL = {"message": "This token was issued to an app, and reaches only that app's own routes"}

# Each app's client, how it authenticates at the token endpoint, the scopes it asks for, the
# functions it calls through the API listener, and whether a stack without it is a configuration.
APPS = {
    "Grafana": {"id": "c0ffee00-0000-4000-8000-000000000001", "secret": "GRAFANA_OAUTH_CLIENT_SECRET",
                "auth": "basic", "scope": "openid email profile", "functions": ["grafana-userinfo"],
                "optional": False},
    "Node-RED": {"id": "c0ffee00-0000-4000-8000-000000000002", "secret": "NODERED_OAUTH_CLIENT_SECRET",
                 "auth": "post", "scope": "openid email profile", "functions": ["nodered-userinfo"],
                 "optional": False},
    "Studio's door": {"id": "c0ffee00-0000-4000-8000-000000000003", "secret": "STUDIO_OAUTH_CLIENT_SECRET",
                      "auth": "basic", "scope": "email profile", "functions": [], "optional": True},
    "the forge's door": {"id": "c0ffee00-0000-4000-8000-000000000004", "secret": "GITEA_OAUTH_CLIENT_SECRET",
                         "auth": "basic", "scope": "email profile", "functions": [], "optional": True},
}
USERINFO = ["grafana-userinfo", "nodered-userinfo"]

# What every app's token is refused on, and the dashboard's token reaches.
API_READ = "/rest/v1/areas?select=id&limit=1"
STORAGE_READ = "/storage/v1/bucket"
GATED_FUNCTION = "/functions/v1/fplus-directory/ping"
EXEMPT_FUNCTION = "/functions/v1/aas-api/description"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args):
        return None


OPENER = urllib.request.build_opener(_NoRedirect)


def request(path, method="GET", token=None, body=None, form=None, basic=None, key=True):
    """One call through the gateway: (status, headers, text). Redirects are returned, not followed."""
    headers = {"apikey": PUBLISHABLE_KEY} if key else {}
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
    req = urllib.request.Request(f"{SUPABASE_URL}{path}", method=method, data=data, headers=headers)
    try:
        with OPENER.open(req, timeout=20) as response:
            return response.status, {k.lower(): v for k, v in response.headers.items()}, response.read().decode()
    except urllib.error.HTTPError as err:
        with err:
            return err.code, {k.lower(): v for k, v in err.headers.items()}, err.read().decode()


def claims_of(token):
    """A JWT's payload, unverified: the gateway and GoTrue verify it; this only reads it."""
    payload = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


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


def sign_out(token):
    """Ends the one session this token names (scope local), as forge-signout does with the door's."""
    return request("/auth/v1/logout?scope=local", method="POST", token=token)


class AppSignIn:
    """An app's side of the flow: PKCE, the authorize redirect, consent, the code exchange."""

    def __init__(self, app, secret, person_token, redirect_uri):
        self.app, self.secret = app, secret
        self.person_token = person_token
        self.redirect_uri = redirect_uri
        self.verifier = secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(self.verifier.encode()).digest()).decode().rstrip("=")
        self.query = urllib.parse.urlencode({
            "response_type": "code", "client_id": app["id"], "redirect_uri": redirect_uri, "scope": app["scope"],
            "state": secrets.token_urlsafe(12), "code_challenge": challenge, "code_challenge_method": "S256",
        })

    def code(self):
        status, headers, text = request(f"/auth/v1/oauth/authorize?{self.query}")
        location = headers.get("location", "")
        assert "authorization_id=" in location, f"authorize answered {status} to {location!r}: {text[:300]}"
        authorization_id = urllib.parse.parse_qs(urllib.parse.urlparse(location).query)["authorization_id"][0]
        status, _, text = request(f"/auth/v1/oauth/authorizations/{authorization_id}", token=self.person_token)
        assert status == 200, f"the authorization's details answered {status}: {text[:300]}"
        callback = json.loads(text).get("redirect_url")
        # A remembered approval answers with the finished redirect; otherwise the consent page asks.
        if not callback:
            status, _, text = request(
                f"/auth/v1/oauth/authorizations/{authorization_id}/consent", method="POST",
                token=self.person_token, body={"action": "approve"},
            )
            assert status == 200, f"the approval was refused ({status}): {text[:300]}"
            callback = json.loads(text)["redirect_url"]
        return urllib.parse.parse_qs(urllib.parse.urlparse(callback).query)["code"][0]

    def tokens(self):
        form = {"grant_type": "authorization_code", "code": self.code(), "redirect_uri": self.redirect_uri,
                "code_verifier": self.verifier}
        basic = None
        if self.app["auth"] == "basic":
            basic = (self.app["id"], self.secret)
        else:
            form.update({"client_id": self.app["id"], "client_secret": self.secret})
        status, _, text = request("/auth/v1/oauth/token", method="POST", basic=basic, form=form)
        assert status == 200, f"the code exchange answered {status}: {text[:300]}"
        return json.loads(text)


class Stack:
    """The person, their dashboard token, and each registered app's redirect address, read once."""

    ready = False

    @classmethod
    def load(cls):
        if cls.ready:
            return
        if not PUBLISHABLE_KEY:
            reason = "SUPABASE_PUBLISHABLE_KEY is needed"
            if STRICT:
                raise AssertionError(f"{reason}, and REQUIRE_SEEDED_ACCOUNTS is set")
            raise unittest.SkipTest(reason)
        cls.person_token, cls.person_id = sign_in(PERSON)
        admin_token, _ = sign_in(ADMIN)
        cls.registered = {a["id"]: a for a in rpc(admin_token, "list_apps")}
        sign_out(admin_token)
        cls.in_force = {a["client_id"] for a in rpc(cls.person_token, "list_my_app_approvals")}
        cls.ready = True


class AnAppsToken:
    """The routes one app's token reaches. A subclass names the app."""

    APP = None

    @classmethod
    def setUpClass(cls):
        Stack.load()
        app = APPS[cls.APP]
        secret = os.getenv(app["secret"], "")
        missing = (f"{cls.APP}'s client is not registered on this stack" if app["id"] not in Stack.registered
                   else f"{app['secret']} is not set" if not secret else None)
        if missing:
            if STRICT and not app["optional"]:
                raise AssertionError(f"{missing}, and REQUIRE_SEEDED_ACCOUNTS is set")
            raise unittest.SkipTest(f"{missing}: {cls.APP}'s routes cannot be probed here")
        cls.app = app
        body = AppSignIn(app, secret, Stack.person_token, Stack.registered[app["id"]]["redirect_uris"][0]).tokens()
        cls.token = body["access_token"]
        cls.id_token = body.get("id_token")

    @classmethod
    def tearDownClass(cls):
        """The app's token ends its own session, as forge-signout ends the door's; then the approval
        this made goes."""
        token = getattr(cls, "token", None)
        if not token:
            return
        try:
            status, _, text = sign_out(token)
            assert status == 204, f"/auth/v1/logout refused {cls.APP}'s token ({status}): {text[:200]}"
        finally:
            if cls.app["id"] not in Stack.in_force:
                request(f"/auth/v1/user/oauth/grants?client_id={cls.app['id']}", method="DELETE",
                        token=Stack.person_token)

    def assert_refused(self, path, method="GET", key=True):
        status, headers, text = request(path, method=method, token=self.token, key=key)
        self.assertEqual(status, 403, f"{self.APP}'s token reached {path} ({status}): {text[:200]}")
        self.assertEqual(json.loads(text), APP_REFUSAL, f"{path} refused {self.APP}'s token, but not as the gateway does")
        self.assertNotIn("x-envoy-upstream-service-time", headers, f"{path}: the refusal came from upstream")

    def test_its_token_names_the_app(self):
        claims = claims_of(self.token)
        self.assertEqual(claims.get("client_id"), self.app["id"], "GoTrue no longer names the app in client_id")
        self.assertEqual(claims.get("sub"), Stack.person_id)

    def test_it_reaches_its_session_at_gotrue(self):
        status, _, text = request("/auth/v1/user", token=self.token)
        self.assertEqual(status, 200, f"/auth/v1/user refused {self.APP}'s token ({status}): {text[:200]}")
        self.assertEqual(json.loads(text)["id"], Stack.person_id)

    def test_it_reaches_the_functions_its_app_calls(self):
        if not self.app["functions"]:
            self.skipTest(f"{self.APP} calls its functions from its own listener, not through the API one")
        for fn in self.app["functions"]:
            # As the app calls it: Grafana and Node-RED send the bearer, and Node-RED the key too.
            for key in (True, False):
                status, _, text = request(f"/functions/v1/{fn}", token=self.token, key=key)
                self.assertEqual(status, 200, f"{fn} refused {self.APP}'s token ({status}): {text[:200]}")
                self.assertEqual(json.loads(text)["sub"], Stack.person_id)

    def test_it_is_refused_on_the_other_apps_functions(self):
        for fn in (f for f in USERINFO if f not in self.app["functions"]):
            self.assert_refused(f"/functions/v1/{fn}")
            self.assert_refused(f"/functions/v1/{fn}", key=False)

    def test_it_is_refused_on_the_api_storage_and_every_other_function(self):
        for path in (API_READ, STORAGE_READ, GATED_FUNCTION, EXEMPT_FUNCTION):
            self.assert_refused(path)
        self.assert_refused("/rest/v1/rpc/list_my_app_approvals", method="POST")

    def test_its_id_token_is_not_served_as_the_person(self):
        # The ID token names the app as its audience, not in client_id. It must not open what the
        # person's own session opens.
        if not self.id_token:
            self.skipTest(f"{self.APP} asks for no openid scope, so it holds no ID token")
        status, _, text = request("/rest/v1/rpc/list_my_app_approvals", method="POST", token=self.id_token, body={})
        self.assertNotEqual(status, 200, f"{self.APP}'s ID token was served as the person: {text[:200]}")


class GrafanasToken(AnAppsToken, unittest.TestCase):
    APP = "Grafana"


class NodeRedsToken(AnAppsToken, unittest.TestCase):
    APP = "Node-RED"


class StudiosDoorsToken(AnAppsToken, unittest.TestCase):
    APP = "Studio's door"


class TheForgesDoorsToken(AnAppsToken, unittest.TestCase):
    APP = "the forge's door"


class ADashboardTokenIsUnchanged(unittest.TestCase):
    """The same person's own session reaches every route an app's token is refused on."""

    @classmethod
    def setUpClass(cls):
        Stack.load()

    def test_it_reaches_the_api_storage_and_the_functions(self):
        for path, method in ((API_READ, "GET"), (STORAGE_READ, "GET"), (GATED_FUNCTION, "GET"),
                             (EXEMPT_FUNCTION, "GET"), ("/rest/v1/rpc/list_my_app_approvals", "POST"),
                             ("/auth/v1/user", "GET")):
            status, _, text = request(path, method=method, token=Stack.person_token, body={} if method == "POST" else None)
            self.assertEqual(status, 200, f"the dashboard's token was refused on {path} ({status}): {text[:200]}")
        self.assertEqual(claims_of(Stack.person_token).get("client_id"), None, "a dashboard token names an app")

    def test_it_reaches_both_userinfo_functions(self):
        for fn in USERINFO:
            status, _, text = request(f"/functions/v1/{fn}", token=Stack.person_token)
            self.assertEqual(status, 200, f"{fn} refused the dashboard's token ({status}): {text[:200]}")


def tearDownModule():
    if Stack.ready:
        sign_out(Stack.person_token)


if __name__ == "__main__":
    unittest.main(verbosity=2)
