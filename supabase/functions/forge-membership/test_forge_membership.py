"""
The forge's door, end to end, and the room behind it.

Drives the same flow a browser does -- the gateway's redirect, GoTrue's password grant, the consent
endpoint, the callback, the cookies -- for each seeded persona, then asserts what the forge did with
the person who arrived: which team they landed in, or that they were refused. Needs the stack, the
forge and the seeded personas, and skips without any of them.

WHY THIS IS ONE SUITE AND NOT TWO. The membership function is only ever called by the listener, on
the way through the door; testing it in isolation would prove it answers a bearer token, which is
not the property that matters. The property is that a person who signs in sees their repositories,
and that a person whose role has gone stops seeing them -- both of which need the door.
"""

import base64
import http.cookiejar
import json
import os
import unittest
import urllib.error
import urllib.parse
import urllib.request

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
FORGE_URL = os.getenv("GITEA_TEST_URL", "http://localhost:3003")
MACHINE_USER = os.getenv("GITEA_MACHINE_USER", "aber_platform")
MACHINE_PASSWORD = os.getenv("GITEA_MACHINE_PASSWORD", "aber-platform-machine-account")
ORGANISATION = os.getenv("GITEA_ORGANISATION", "gateways")
PASSWORD = os.getenv("ABER_SEED_PASSWORD", "aber123")

# See test_enroll_gateway.py, which carries the reasoning: where the caller installed the forge, an
# unreachable one is a fault, and a setUpClass skip removes the class from a run that still reports
# `OK` and exits 0.
REQUIRE_FORGE = os.getenv("REQUIRE_FORGE") == "1"


def skip_or_fail(message):
    """Skip when a person runs this ad hoc; fail where the forge is guaranteed to be there."""
    if REQUIRE_FORGE:
        raise AssertionError(f"REQUIRE_FORGE=1, so this cannot be skipped: {message}")
    raise unittest.SkipTest(message)

PERSONAS = {
    "Administrator": ("admin@aber.local", "a0000000-0000-0000-0000-000000000001", "administrators"),
    "Shopfloor_Manager": ("manager@aber.local", "a0000000-0000-0000-0000-000000000002", "managers"),
    "Operator": ("operator@aber.local", "a0000000-0000-0000-0000-000000000003", None),
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Every step of the flow is a redirect whose Location is the thing under test."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class HttpTestCookiePolicy(http.cookiejar.DefaultCookiePolicy):
    """
    Send the oauth2 filter's cookies back over http.

    Envoy marks ForgeCodeVerifier and ForgeOauthNonce `secure`, correctly -- a real deployment is
    https. A development stack is http on localhost, and the default policy stores a secure cookie
    but refuses to SEND it over a non-secure connection, so the callback arrives without the code
    verifier and Envoy answers 401. A browser on http://localhost and curl both send them; this
    matches that, and only for this test's own throwaway jar.
    """

    def return_ok_secure(self, cookie, request):
        return True


def cookie_jar():
    return http.cookiejar.CookieJar(policy=HttpTestCookiePolicy())


def request(url, method="GET", headers=None, body=None, jar=None):
    handlers = [NoRedirect()]
    if jar is not None:
        handlers.append(urllib.request.HTTPCookieProcessor(jar))
    opener = urllib.request.build_opener(*handlers)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, method=method, data=data, headers=headers or {})
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with opener.open(req, timeout=20) as response:
            # Header names lower-cased: Envoy sends `location`, GoTrue sends `Location`.
            return response.status, {k.lower(): v for k, v in response.headers.items()}, response.read().decode(errors="replace")
    except urllib.error.HTTPError as err:
        return err.code, {k.lower(): v for k, v in err.headers.items()}, err.read().decode(errors="replace")


def forge_as_machine(path, method="GET"):
    credentials = base64.b64encode(f"{MACHINE_USER}:{MACHINE_PASSWORD}".encode()).decode()
    status, _, text = request(f"{FORGE_URL}{path}", method=method, headers={"Authorization": f"Basic {credentials}"})
    return status, (json.loads(text) if text.strip() else None)


def sign_in(email):
    status, _, text = request(
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        method="POST", headers={"apikey": PUBLISHABLE_KEY}, body={"email": email, "password": PASSWORD},
    )
    if status != 200:
        raise unittest.SkipTest(f"could not sign in as {email} ({status}); the seed personas are absent")
    return json.loads(text)["access_token"]


def through_the_door(email):
    """Returns (cookie jar, status of GET / with that jar). The jar is the forge session."""
    jar = cookie_jar()
    status, headers, _ = request(f"{FORGE_URL}/", jar=jar)
    assert status == 302, f"the door did not redirect ({status})"
    authorize_url = headers["location"]
    assert "/auth/v1/oauth/authorize" in authorize_url, authorize_url

    token = sign_in(email)
    status, headers, _ = request(authorize_url)
    assert status in (302, 303), f"authorize did not redirect to consent ({status})"
    authorization_id = urllib.parse.parse_qs(urllib.parse.urlparse(headers["location"]).query)["authorization_id"][0]

    # EXACTLY WHAT THE DASHBOARD'S CONSENT PAGE DOES (frontend/src/pages/OAuthConsent.jsx). The GET
    # returns a `redirect_url` straight away when the client is already trusted -- a repeat
    # authorization needs no consent -- and only returns authorization DETAILS the first time, when
    # a POST to approve is required. A test that always POSTed would 400 on the second run of a
    # persona, because the GET had already consumed the authorization.
    bearer = {"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {token}"}
    status, _, text = request(
        f"{SUPABASE_URL}/auth/v1/oauth/authorizations/{authorization_id}", headers=bearer,
    )
    assert status == 200, f"authorization lookup failed ({status}): {text[:200]}"
    body = json.loads(text)
    callback = body.get("redirect_url")
    if not callback:
        status, _, text = request(
            f"{SUPABASE_URL}/auth/v1/oauth/authorizations/{authorization_id}/consent",
            method="POST", headers=bearer, body={"action": "approve"},
        )
        assert status == 200, f"consent refused ({status}): {text[:200]}"
        callback = json.loads(text)["redirect_url"]
    assert callback.startswith(f"{FORGE_URL}/oauth2/callback"), callback

    status, _, _ = request(callback, jar=jar)
    assert status == 302, f"the callback did not complete the login ({status})"
    status, _, _ = request(f"{FORGE_URL}/", jar=jar)
    return jar, status


def team_id(name):
    status, teams = forge_as_machine(f"/api/v1/orgs/{ORGANISATION}/teams?limit=50")
    assert status == 200, teams
    return next(t["id"] for t in teams if t["name"] == name)


def members_of(name):
    status, members = forge_as_machine(f"/api/v1/teams/{team_id(name)}/members?limit=100")
    assert status == 200, members
    return {m["login"] for m in members}


class TestTheDoor(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not PUBLISHABLE_KEY or not SERVICE_ROLE_KEY:
            raise unittest.SkipTest("SUPABASE_PUBLISHABLE_KEY and SUPABASE_SERVICE_ROLE_KEY must be set")
        status, _ = forge_as_machine("/api/v1/version")
        if status != 200:
            skip_or_fail(f"no forge reachable at {FORGE_URL} ({status})")
        # NOT gated by REQUIRE_FORGE, unlike the guard above. A forge that is up but holds no
        # gateway organisation is a stack with no gateways enrolled yet, which a fresh install is
        # and which no amount of forge availability changes; the lane does not order the suites,
        # so gating this would make the door's result depend on which suite ran first.
        status, _ = forge_as_machine(f"/api/v1/orgs/{ORGANISATION}")
        if status != 200:
            raise unittest.SkipTest(
                f"the '{ORGANISATION}' organisation does not exist yet; enrol one gateway to create it"
            )

    def test_an_administrator_lands_in_the_administrators_team(self):
        email, sub, team = PERSONAS["Administrator"]
        _, status = through_the_door(email)
        self.assertEqual(status, 200, "the door refused an Administrator")
        # Placement happens on the requests the landing page makes, which a browser makes and this
        # does not; one more request through the door stands in for them.
        request(f"{FORGE_URL}/repo/search?q=gateway", jar=self.jar_for(email))
        self.assertIn(sub, members_of(team))
        self.assertNotIn(sub, members_of("managers"))

    def test_a_manager_lands_in_the_managers_team_and_not_the_other(self):
        email, sub, team = PERSONAS["Shopfloor_Manager"]
        jar, status = through_the_door(email)
        self.assertEqual(status, 200, "the door refused a Shopfloor_Manager")
        request(f"{FORGE_URL}/repo/search?q=gateway", jar=jar)
        self.assertIn(sub, members_of(team))
        self.assertNotIn(sub, members_of("administrators"))

    def test_an_operator_completes_the_flow_and_meets_the_403(self):
        """
        THE WHOLE POINT OF AUTHENTICATING BEFORE AUTHORISING. Every persona can complete the OAuth
        flow -- that is GoTrue's decision, and it is right -- and the listener's RBAC is what turns
        a valid session into a refusal. An Operator in no team is the corollary.
        """
        email, sub, _ = PERSONAS["Operator"]
        _, status = through_the_door(email)
        self.assertEqual(status, 403, "the door admitted an Operator")
        self.assertNotIn(sub, members_of("administrators"))
        self.assertNotIn(sub, members_of("managers"))

    def test_a_forged_identity_header_from_outside_is_not_a_login(self):
        """
        Gitea trusts X-WEBAUTH-USER from any peer (measured), so the ONLY thing between
        the internet and any identity is that the header never reaches Gitea except as written by
        the listener from a verified token.
        """
        status, headers, _ = request(f"{FORGE_URL}/", headers={"X-WEBAUTH-USER": "gitea_admin"})
        self.assertEqual(status, 302, "a request with a forged header was answered rather than sent to log in")
        self.assertIn("/auth/v1/oauth/authorize", headers.get("location", ""))
        status, _, text = request(f"{FORGE_URL}/api/v1/user", headers={"X-WEBAUTH-USER": "gitea_admin"})
        self.assertEqual(status, 403, text[:120])

    def test_a_role_removed_since_sign_in_is_refused_and_unseated_at_once(self):
        """
        REVOCATION IS IMMEDIATE HERE, where Studio's door honours a token until it expires. The
        manager's role is taken away in user_roles, their existing forge session makes one more
        request, and that request is refused AND takes them out of the managers team -- so an SSH
        key they had added stops working now rather than at the next visit.
        """
        email, sub, team = PERSONAS["Shopfloor_Manager"]
        jar, status = through_the_door(email)
        self.assertEqual(status, 200)
        request(f"{FORGE_URL}/repo/search?q=gateway", jar=jar)
        self.assertIn(sub, members_of(team))

        service = {"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
                   "Prefer": "return=representation"}
        status, _, text = request(f"{SUPABASE_URL}/rest/v1/user_roles?user_id=eq.{sub}&select=role_id", headers=service)
        self.assertEqual(status, 200, text[:200])
        rows = json.loads(text)
        self.assertEqual(len(rows), 1, rows)
        original_role_id = rows[0]["role_id"]
        status, _, text = request(f"{SUPABASE_URL}/rest/v1/roles?name=eq.Operator&select=id", headers=service)
        operator_role_id = json.loads(text)[0]["id"]

        status, _, text = request(
            f"{SUPABASE_URL}/rest/v1/user_roles?user_id=eq.{sub}", method="PATCH",
            headers=service, body={"role_id": operator_role_id},
        )
        self.assertIn(status, (200, 204), text[:200])
        try:
            status, _, _ = request(f"{FORGE_URL}/repo/search?q=gateway", jar=jar)
            self.assertEqual(status, 403, "a demoted manager's live session was still admitted")
            self.assertNotIn(sub, members_of(team), "a demoted manager was left in the managers team")
        finally:
            status, _, text = request(
                f"{SUPABASE_URL}/rest/v1/user_roles?user_id=eq.{sub}", method="PATCH",
                headers=service, body={"role_id": original_role_id},
            )
            assert status in (200, 204), f"COULD NOT RESTORE the manager persona's role: {text[:200]}"

    def test_a_session_ended_elsewhere_sends_the_browser_back_through_the_door(self):
        """
        THE DOOR HOLDS A COOKIE GoTrue NO LONGER HONOURS, and this is what happens next. A dashboard
        sign-out revokes the GoTrue session; the forge's cookie is Envoy's own and survives it, its
        token still verifies locally, and only the membership step notices. A 401 from it would
        reach the browser as a JSON body with the cookie still set -- stuck until it expires. So a
        dead session is a redirect to the door's sign-out, which clears the cookies and lands on a
        fresh login. Found by exactly that sequence on a laptop.
        """
        email, _, _ = PERSONAS["Administrator"]
        jar, status = through_the_door(email)
        self.assertEqual(status, 200)

        # End every session this persona holds, the way a global dashboard sign-out does. The forge
        # cookie in `jar` is untouched by this, which is the whole point.
        token = sign_in(email)
        status, _, text = request(
            f"{SUPABASE_URL}/auth/v1/logout?scope=global", method="POST",
            headers={"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {token}"},
        )
        self.assertIn(status, (200, 204), text[:200])

        status, headers, text = request(f"{FORGE_URL}/", jar=jar)
        self.assertEqual(status, 302, f"a dead session was not sent back through the door ({status}): {text[:120]}")
        self.assertEqual(headers.get("location"), "/oauth2/signout")

        status, headers, _ = request(f"{FORGE_URL}/oauth2/signout", jar=jar)
        self.assertEqual(status, 302)
        self.assertFalse(
            any(c.name.startswith("ForgeBearerToken") for c in jar),
            "the sign-out did not clear the door's bearer cookie",
        )
        status, headers, _ = request(f"{FORGE_URL}/", jar=jar)
        self.assertEqual(status, 302)
        self.assertIn("/auth/v1/oauth/authorize", headers.get("location", ""), "the door did not start a fresh login")

    def test_signing_out_of_the_forge_signs_out_of_the_platform(self):
        """
        GITEA'S OWN SIGN-OUT LINK, which did nothing: under reverse-proxy authentication the next
        request re-signs the person in, and the door's sign-out alone lets the still-alive
        dashboard session sign them in again after a flicker. The forge has no session of its own,
        so its sign-out is the platform's -- every GoTrue session the person holds ends, the door's
        cookies are cleared, and the fresh login meets a dashboard with nobody signed in.
        """
        email, _, _ = PERSONAS["Shopfloor_Manager"]
        jar, status = through_the_door(email)
        self.assertEqual(status, 200)

        # A dashboard session of the same person, alive before the click.
        dashboard = sign_in(email)
        me = {"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {dashboard}"}
        status, _, _ = request(f"{SUPABASE_URL}/auth/v1/user", headers=me)
        self.assertEqual(status, 200)

        # The click. Gitea 1.27's link is a plain GET on this path.
        status, headers, _ = request(f"{FORGE_URL}/user/logout", jar=jar)
        self.assertEqual(status, 302)
        self.assertEqual(headers.get("location"), "/oauth2/signout")

        status, _, text = request(f"{SUPABASE_URL}/auth/v1/user", headers=me)
        self.assertIn(status, (401, 403), f"the dashboard session survived the forge's sign-out: {text[:120]}")

        status, _, _ = request(f"{FORGE_URL}/oauth2/signout", jar=jar)
        self.assertEqual(status, 302)
        self.assertFalse(
            any(c.name.startswith("ForgeBearerToken") for c in jar),
            "the door's bearer cookie survived the sign-out",
        )

    # -- helpers ---------------------------------------------------------------------------------

    _jars = {}

    def jar_for(self, email):
        if email not in self._jars:
            self._jars[email], _ = through_the_door(email)
        return self._jars[email]


if __name__ == "__main__":
    unittest.main(verbosity=2)
