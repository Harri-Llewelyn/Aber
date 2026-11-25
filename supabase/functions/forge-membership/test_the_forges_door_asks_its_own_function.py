# suite:
#   lanes: stack
#   why: The forge's door resolves a path before it asks forge-membership who may pass. The edge runtime
#     answers for the first segment left after the dot segments, so on a raw path the caller would
#     choose the function that admits them. A person whose role has gone since they signed in is refused
#     at every spelling of /../<function>, a request out of the open /api/ prefix meets the sign-in, and
#     a branch name's %2F still reaches the forge. Needs the stack, the forge, the seeded manager and
#     the door's port-forward, since an ingress resolves dot segments itself.

"""
The forge's door asks its own function, whatever path it is sent.

    SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... GITEA_MACHINE_TOKEN=... \\
      python supabase/functions/forge-membership/test_the_forges_door_asks_its_own_function.py

Signs the seeded manager in through the door (test_forge_membership.py), takes the role away in
user_roles, and asks with a raw client for a path that names another function. FORGE_DOOR_URL is a
port-forward of the gateway's forge listener (8002), which `dev-cluster test` opens on 3003: through the
ingress the question would be Traefik's, which resolves dot segments first.
"""
import http.client
import json
import os
import sys
import unittest
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_forge_membership as door  # noqa: E402  -- not `from`, which would collect its test classes

FORGE_DOOR_URL = os.getenv("FORGE_DOOR_URL", "http://127.0.0.1:3003")
# A function that answers 200 to anybody (docs/gateway.md, the exemptions).
OPEN_FUNCTION = "fplus-directory/ping"
SPELLINGS = (
    f"/../{OPEN_FUNCTION}",
    f"/%2e%2e/{OPEN_FUNCTION}",
    f"/.%2e/{OPEN_FUNCTION}",
    f"/..\\{OPEN_FUNCTION}",
    f"/{door.ORGANISATION}/x/../../../{OPEN_FUNCTION}",
    f"/assets/../../{OPEN_FUNCTION}",
)


def ask(path, cookies=None):
    """One GET with the path as written: urllib resolves nothing, but http.client is told to check nothing."""
    host = urllib.parse.urlsplit(door.FORGE_URL).netloc
    at = urllib.parse.urlsplit(FORGE_DOOR_URL)
    connection = http.client.HTTPConnection(at.hostname, at.port, timeout=20)
    try:
        connection.putrequest("GET", path, skip_host=True, skip_accept_encoding=True)
        connection.putheader("Host", host)
        if cookies:
            connection.putheader("Cookie", cookies)
        connection.endheaders()
        response = connection.getresponse()
        return response.status, response.getheader("location") or "", response.read().decode(errors="replace")
    finally:
        connection.close()


class TestTheDoorAsksItsOwnFunction(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not door.PUBLISHABLE_KEY or not door.SERVICE_ROLE_KEY:
            raise unittest.SkipTest("SUPABASE_PUBLISHABLE_KEY and SUPABASE_SERVICE_ROLE_KEY must be set")
        if not door.MACHINE_TOKEN:
            door.skip_or_fail("GITEA_MACHINE_TOKEN is unset; read it from the <release>-forge-token Secret")
        try:
            status, location, _ = ask("/")
        except OSError as err:
            door.skip_or_fail(f"no door at FORGE_DOOR_URL, {FORGE_DOOR_URL} ({err})")
        if status != 302 or "/auth/v1/oauth/authorize" not in location:
            door.skip_or_fail(f"FORGE_DOOR_URL, {FORGE_DOOR_URL}, is not the forge's door ({status})")

    def test_a_dot_segment_out_of_the_open_api_meets_the_sign_in(self):
        for path in ("/api/../user/settings", "/api/%2e%2e/user/settings"):
            status, location, text = ask(path)
            self.assertEqual(status, 302, f"{path} passed the door with no session ({status}): {text[:120]}")
            self.assertIn("/auth/v1/oauth/authorize", location, path)

    def test_a_person_whose_role_has_gone_is_refused_at_every_spelling(self):
        email, sub, _ = door.PERSONAS["Shopfloor_Manager"]
        jar, status = door.through_the_door(email)
        self.assertEqual(status, 200, "the door refused a Shopfloor_Manager")
        cookies = "; ".join(f"{c.name}={c.value}" for c in jar)
        # While the role stands, an escaped slash reaches the forge as it was sent: its own 404, not the door's.
        status, _, text = ask(f"/{door.ORGANISATION}/no-such-repository/src/branch/feature%2Fone", cookies)
        self.assertEqual(status, 404, text[:120])

        service = {"apikey": door.PUBLISHABLE_KEY, "Authorization": f"Bearer {door.SERVICE_ROLE_KEY}",
                   "Prefer": "return=representation"}
        row = f"{door.SUPABASE_URL}/rest/v1/user_roles?user_id=eq.{sub}"
        status, _, text = door.request(f"{row}&select=role_id", headers=service)
        self.assertEqual(status, 200, text[:200])
        (held,) = json.loads(text)
        status, _, text = door.request(f"{door.SUPABASE_URL}/rest/v1/roles?name=eq.Operator&select=id", headers=service)
        operator = json.loads(text)[0]["id"]
        status, _, text = door.request(row, method="PATCH", headers=service, body={"role_id": operator})
        self.assertIn(status, (200, 204), text[:200])
        try:
            for path in SPELLINGS:
                status, _, text = ask(path, cookies)
                self.assertEqual(status, 403, f"{path} was admitted by another function ({status}): {text[:120]}")
                self.assertIn("does not open the forge", text, path)
        finally:
            status, _, text = door.request(row, method="PATCH", headers=service, body={"role_id": held["role_id"]})
            assert status in (200, 204), f"COULD NOT RESTORE the manager persona's role: {text[:200]}"


if __name__ == "__main__":
    unittest.main(verbosity=2)
