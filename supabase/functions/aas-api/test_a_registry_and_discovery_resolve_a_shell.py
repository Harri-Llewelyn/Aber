# suite:
#   lanes: stack
#   why: The AAS Registry and Discovery on aas-api, against a running stack. A descriptor must name the
#     shell /shells serves, with each endpoint the route that serves it; Discovery must take the
#     serial number on a machine to its shell and never to a replay lane recorded from it, though the
#     lane's birth repeats the number; every role must read the same answers, and a request with no
#     person's or machine identity's token none. IDTA's public test engine holds no Registry or
#     Discovery suite, so this is what reads them on the stack.

"""
A Registry and Discovery resolve a shell (aas-api), against a running stack.

Provisions its own gateway, device and nameplate at pinned ids (never the conformance fixture's, so
the other AAS suites see the device they expect), and a replay lane of the device as the database
owner, since only the owner may make one; removes all of it after. Signs in as each seeded role and
skips a role whose account does not exist. Skipped with no reachable stack.

Run:  python supabase/functions/aas-api/test_a_registry_and_discovery_resolve_a_shell.py
"""
import base64
import http.client
import json
import os
import sys
import unittest
import urllib.parse
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "test-harness"))
import aas_fixture  # noqa: E402  -- after sys.path, by necessity
import stack_exec  # noqa: E402
import stack_sign_in  # noqa: E402

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
PASSWORD = os.getenv("ABER_DEMO_PASSWORD", "aber123")
API = f"{SUPABASE_URL}/functions/v1/aas-api"

ACCOUNTS = {
    "Administrator": "admin@aber.local",
    "Shopfloor_Manager": "manager@aber.local",
    "Operator": "operator@aber.local",
    "Auditor": "auditor@aber.local",
}

GATEWAY_UUID = "1e313000-0000-4000-8000-000000000313"
DEVICE_UUID = "2e313000-0000-4000-8000-000000000313"
# The lane's id must differ from the device's early: the wire id is the first 21 hex digits.
LANE_UUID = "2e313100-0000-4000-8000-000000000313"
GATEWAY_NAME = "AAS_Discovery_Gateway"
DEVICE_NAME = "AAS_Discovery_Device"
SERIAL = "AAS-DISCOVERY-0313"
PRODUCT = "https://aber.example/products/aas-discovery-0313"

# As the database owner: only the seed and ensure_shadow_devices() make a lane. psql reads the ids as
# variables, so no value is formatted into the SQL.
MAKE_LANE = """
INSERT INTO public.devices (id, name, gateway_id, shadow_of, location_scope, cell_id)
SELECT :'lane'::uuid, d.name || ' (replay)', g.id, d.id, d.location_scope, d.cell_id
  FROM public.devices d
 CROSS JOIN LATERAL (SELECT id FROM public.gateways WHERE is_shadow AND NOT is_archived
                      ORDER BY created_at LIMIT 1) g
 WHERE d.id = :'device'::uuid
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.asset_config (asset_id, metric_name, val_string)
SELECT sparkplug_id, 'SERIAL_NUMBER', :'serial' FROM public.devices WHERE id = :'lane'::uuid
ON CONFLICT (asset_id, metric_name) DO UPDATE SET val_string = EXCLUDED.val_string;
SELECT count(*) FROM public.devices WHERE id = :'lane'::uuid AND shadow_of = :'device'::uuid;
"""
REMOVE_LANE = """
DELETE FROM public.asset_config WHERE asset_id IN (SELECT sparkplug_id FROM public.devices WHERE id = :'lane'::uuid);
DELETE FROM public.devices WHERE id = :'lane'::uuid;
"""


def b64url(value):
    return base64.urlsafe_b64encode(value.encode()).decode().rstrip("=")


def call(method, url, token=None, apikey=False):
    """(status, parsed JSON) for one request, sent as a standard AAS client sends it: a bearer, no apikey."""
    parts = urllib.parse.urlsplit(url)
    connect = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    if apikey:
        headers["apikey"] = PUBLISHABLE_KEY
    connection = connect(parts.hostname, parts.port, timeout=60)
    try:
        connection.request(method, parts.path + (f"?{parts.query}" if parts.query else ""), headers=headers)
        response = connection.getresponse()
        raw = response.read() or b"{}"
        try:
            return response.status, json.loads(raw)
        except json.JSONDecodeError:
            return response.status, {"raw": raw.decode(errors="replace")}
    except OSError:
        return 0, {}
    finally:
        connection.close()


def get(path, token):
    return call("GET", f"{API}{path}", token)


def asset_link(name, value):
    return "assetIds=" + b64url(json.dumps({"name": name, "value": value}))


def sign_in(email):
    """A person's token, or None where there is no stack or no such account."""
    try:
        status, data = stack_sign_in.password_grant(SUPABASE_URL, PUBLISHABLE_KEY, email, PASSWORD)
    except OSError:
        return None
    return data.get("access_token") if status == 200 and isinstance(data, dict) else None


def database(sql):
    return stack_exec.output("supabase-db", "psql", "-U", "postgres", "-d", "postgres", "-q", "-At",
                             "-v", "ON_ERROR_STOP=1", "-v", f"device={DEVICE_UUID}", "-v", f"lane={LANE_UUID}",
                             "-v", f"serial={SERIAL}", input=sql)


TOKEN = sign_in(ACCOUNTS["Administrator"])
LIVE = TOKEN is not None and bool(PUBLISHABLE_KEY)
SKIP_REASON = "no reachable stack, or no publishable key to reach it with"


def rest(method, path, payload=None):
    return aas_fixture._request(SUPABASE_URL, TOKEN, PUBLISHABLE_KEY, method, path, payload)


def provision():
    """The gateway, the device with a nameplate that names its serial number and product, and its lane."""
    aas_fixture._upsert(SUPABASE_URL, TOKEN, PUBLISHABLE_KEY, "gateways", {
        "id": GATEWAY_UUID, "name": GATEWAY_NAME, "status": "ONLINE", "deployment": "host",
    }, on_conflict="id")
    aas_fixture._upsert(SUPABASE_URL, TOKEN, PUBLISHABLE_KEY, "devices", {
        "id": DEVICE_UUID, "name": DEVICE_NAME, "gateway_id": GATEWAY_UUID,
        "status": "OFFLINE", "is_quarantined": False,
    }, on_conflict="id")
    aas_fixture._upsert(SUPABASE_URL, TOKEN, PUBLISHABLE_KEY, "device_nameplate", {
        "device_id": DEVICE_UUID, "serial_number": SERIAL, "uri_of_the_product": PRODUCT,
        "manufacturer_name": "Aber Discovery",
    }, on_conflict="device_id")
    made = database(MAKE_LANE).strip().splitlines()
    if not made or made[-1] != "1":
        raise RuntimeError(f"the replay lane was not made: {made}")


def teardown():
    """Best effort, the lane first: it names the device."""
    try:
        database(REMOVE_LANE)
    except RuntimeError:
        pass
    for path in (
        f"/device_nameplate?device_id=eq.{DEVICE_UUID}",
        f"/devices?id=eq.{DEVICE_UUID}",
        f"/gateways?id=eq.{GATEWAY_UUID}",
    ):
        try:
            rest("DELETE", path)
        except aas_fixture.FixtureError:
            pass


def walk(path, token, limit=100):
    """Every item of a paged list, following its cursor."""
    items, cursor = [], None
    for _ in range(1000):
        query = f"{'&' if '?' in path else '?'}limit={limit}" + (f"&cursor={urllib.parse.quote(cursor, safe='')}" if cursor else "")
        status, body = get(path + query, token)
        assert status == 200, f"{path}: {status} {body}"
        items.extend(body["result"])
        cursor = (body.get("paging_metadata") or {}).get("cursor")
        if not cursor:
            return items
    raise AssertionError(f"{path} did not end in 1000 pages")


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestARegistryAndDiscoveryResolveAShell(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        try:
            provision()
        except Exception as err:  # noqa: BLE001 -- the fixture's own fault, said rather than hidden
            teardown()
            raise unittest.SkipTest(f"could not provision the device and its lane: {err}") from err
        cls.addClassCleanup(teardown)
        devices = rest("GET", f"/devices?select=id,sparkplug_id&id=in.({DEVICE_UUID},{LANE_UUID})")
        wire = {row["id"]: row["sparkplug_id"] for row in devices}
        cls.wire, cls.lane_wire = wire[DEVICE_UUID], wire[LANE_UUID]
        # The shells' ids as /shells serves them, never composed: AAS_BASE_IRI is the deployment's.
        shells = {shell["idShort"]: shell for shell in walk("/shells", TOKEN)}
        cls.shell = shells[DEVICE_NAME]
        cls.lane_shell = next(s for s in shells.values()
                              if s["assetInformation"]["globalAssetId"].endswith(cls.lane_wire))

    # ---- The Registry ---------------------------------------------------------------------------

    def test_the_description_declares_the_registry_and_no_discovery_profile(self):
        status, body = call("GET", f"{API}/description")
        self.assertEqual(status, 200, body)
        self.assertIn("https://admin-shell.io/aas/API/3/0/AssetAdministrationShellRegistryServiceSpecification/SSP-002",
                      body["profiles"])
        self.assertFalse([p for p in body["profiles"] if "Discovery" in p], body["profiles"])

    def test_a_descriptor_names_the_shell_and_the_routes_that_serve_it(self):
        status, descriptor = get(f"/shell-descriptors/{b64url(self.shell['id'])}", TOKEN)
        self.assertEqual(status, 200, descriptor)
        asset = self.shell["assetInformation"]
        self.assertEqual(descriptor["id"], self.shell["id"])
        self.assertEqual(descriptor["idShort"], self.shell["idShort"])
        self.assertEqual(descriptor["globalAssetId"], asset["globalAssetId"])
        self.assertEqual(descriptor["specificAssetIds"], asset["specificAssetIds"])
        self.assertEqual([d["id"] for d in descriptor["submodelDescriptors"]],
                         [ref["keys"][0]["value"] for ref in self.shell["submodels"]])

        endpoints = [(descriptor["endpoints"][0], f"/functions/v1/aas-api/shells/{b64url(self.shell['id'])}", self.shell)]
        for submodel in descriptor["submodelDescriptors"]:
            _, served = get(f"/submodels/{b64url(submodel['id'])}", TOKEN)
            self.assertEqual(submodel["idShort"], served["idShort"])
            self.assertEqual(submodel.get("semanticId"), served.get("semanticId"))
            endpoints.append((submodel["endpoints"][0], f"/functions/v1/aas-api/submodels/{b64url(submodel['id'])}", served))
        for endpoint, path, expected in endpoints:
            with self.subTest(href=endpoint["protocolInformation"]["href"]):
                self.assertIn(endpoint["interface"], ("AAS-3.0", "SUBMODEL-3.0"))
                href = urllib.parse.urlsplit(endpoint["protocolInformation"]["href"])
                self.assertEqual(href.path, path)
                # The gateway's public address, never the in-cluster one a client cannot resolve.
                self.assertNotIn("supabase", href.hostname or "")
                self.assertEqual(endpoint["protocolInformation"]["endpointProtocol"], href.scheme.upper())
                status, body = call("GET", f"{SUPABASE_URL}{href.path}", TOKEN)
                self.assertEqual((status, body), (200, expected))

    def test_the_registry_lists_what_shells_lists_a_page_at_a_time(self):
        shells = [s["id"] for s in walk("/shells", TOKEN, limit=7)]
        descriptors = [d["id"] for d in walk("/shell-descriptors", TOKEN, limit=7)]
        self.assertEqual(descriptors, shells)
        self.assertIn(self.lane_shell["id"], descriptors)

    def test_a_lanes_descriptor_names_no_specific_asset_id(self):
        status, descriptor = get(f"/shell-descriptors/{b64url(self.lane_shell['id'])}", TOKEN)
        self.assertEqual(status, 200, descriptor)
        self.assertNotIn("specificAssetIds", descriptor)

    # ---- Discovery ------------------------------------------------------------------------------

    def test_the_serial_number_finds_the_device_and_not_its_lane(self):
        status, body = get(f"/lookup/shells?{asset_link('partInstanceId', SERIAL)}", TOKEN)
        self.assertEqual(status, 200, body)
        self.assertEqual(body["result"], [self.shell["id"]])

    def test_every_link_must_hold(self):
        both = f"{asset_link('partInstanceId', SERIAL)}&{asset_link('uriOfTheProduct', PRODUCT)}"
        self.assertEqual(get(f"/lookup/shells?{both}", TOKEN)[1]["result"], [self.shell["id"]])
        other = f"{asset_link('partInstanceId', SERIAL)}&{asset_link('sparkplugId', self.lane_wire)}"
        self.assertEqual(get(f"/lookup/shells?{other}", TOKEN)[1]["result"], [])

    def test_a_lane_is_not_indexed(self):
        for name, value in (("sparkplugId", self.lane_wire),
                            ("globalAssetId", self.lane_shell["assetInformation"]["globalAssetId"])):
            with self.subTest(name=name):
                self.assertEqual(get(f"/lookup/shells?{asset_link(name, value)}", TOKEN)[1]["result"], [])
        status, body = get(f"/lookup/shells/{b64url(self.lane_shell['id'])}", TOKEN)
        self.assertEqual(status, 404, body)

    def test_a_shells_links_are_its_global_asset_id_and_its_specific_asset_ids(self):
        status, links = get(f"/lookup/shells/{b64url(self.shell['id'])}", TOKEN)
        self.assertEqual(status, 200, links)
        asset = self.shell["assetInformation"]
        self.assertEqual(links, [{"name": "globalAssetId", "value": asset["globalAssetId"]}, *asset["specificAssetIds"]])
        for link in links:
            with self.subTest(link=link["name"]):
                found = get(f"/lookup/shells?{asset_link(link['name'], link['value'])}", TOKEN)[1]["result"]
                self.assertIn(self.shell["id"], found)

    def test_assetids_that_are_not_an_encoded_specific_asset_id_are_a_400(self):
        status, body = get("/lookup/shells?assetIds=not-base64url!", TOKEN)
        self.assertEqual(status, 400, body)
        self.assertEqual(body["messages"][0]["messageType"], "Error")

    # ---- Who reads what -------------------------------------------------------------------------

    def test_every_role_reads_the_same_descriptor_and_the_same_lookup(self):
        _, descriptor = get(f"/shell-descriptors/{b64url(self.shell['id'])}", TOKEN)
        _, page = get("/shell-descriptors?limit=5", TOKEN)
        for role, email in ACCOUNTS.items():
            if role == "Administrator":
                continue
            token = sign_in(email)
            if token is None:
                self.skipTest(f"the seeded {role} account ({email}) could not sign in")
            with self.subTest(role=role):
                self.assertEqual(get(f"/shell-descriptors/{b64url(self.shell['id'])}", token), (200, descriptor))
                self.assertEqual(get("/shell-descriptors?limit=5", token), (200, page))
                self.assertEqual(get(f"/lookup/shells?{asset_link('partInstanceId', SERIAL)}", token)[1]["result"],
                                 [self.shell["id"]])

    def test_a_request_with_no_persons_token_reads_nothing(self):
        for path in ("/shell-descriptors", f"/lookup/shells?{asset_link('partInstanceId', SERIAL)}"):
            with self.subTest(path=path, bearer="none"):
                status, body = call("GET", f"{API}{path}")
                self.assertEqual(status, 401, body)
                self.assertEqual(body["messages"][0]["text"], "Missing Authorization header")
            with self.subTest(path=path, bearer="the publishable key"):
                status, body = call("GET", f"{API}{path}", PUBLISHABLE_KEY, apikey=True)
                self.assertEqual(status, 401, body)

    def test_the_writes_are_refused_with_the_reason(self):
        for method, path in (("POST", "/shell-descriptors"), ("DELETE", f"/shell-descriptors/{b64url(self.shell['id'])}"),
                             ("POST", f"/lookup/shells/{b64url(self.shell['id'])}"),
                             ("DELETE", f"/lookup/shells/{b64url(self.shell['id'])}")):
            with self.subTest(method=method, path=path):
                status, body = call(method, f"{API}{path}", TOKEN)
                self.assertEqual(status, 405, body)
                self.assertIn("read-only", body["messages"][0]["text"])
                self.assertIn("Audit Trail", body["messages"][0]["text"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
