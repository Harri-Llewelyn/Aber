"""
Tests for the fplus-directory Edge Function, and above all for its reverse schema lookup.

Two layers in one file, matching test_aas_api.py:

  * Offline checks always run. They guard what is true of the SOURCE with no stack up -- that this
    function is never granted the service-role key, that the token check still happens before any
    routing decision, and that every route it advertises is documented.

  * Live checks exercise the deployed routes at their UNPREFIXED paths, which is how a Factory+
    client reaches them and the only place the fail-closed property can be observed: those routes
    are exempt from the gateway's key-auth, so the function's own bearer check is the whole
    boundary in front of the fleet's address space.

THE TEST THAT MATTERS MOST is TestForwardReverseAgreement. `/v1/schema/{uuid}` is the only route
here that runs the lookup backwards -- from a schema to its assets rather than from an asset to its
schemas -- and the two answers are composed by different queries over the same view. If they ever
disagree, both endpoints go on reporting success: a client integrating against a model would
subscribe to a set of addresses that the devices themselves do not claim to publish. The suite
asserts the round trip rather than either half.

Two members are provisioned, not one, and the second is the point: `device_schemas` unions
`device_submodels` with the legacy 1:1 `devices.schema_id`, and a reverse lookup written against
the join table alone would pass every other check in this file while silently omitting every device
provisioned the older way.

Run:  python supabase/functions/fplus-directory/test_fplus_directory.py
"""
import json
import os
import re
import sys
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
MAIN_INDEX = REPO_ROOT / "supabase" / "functions" / "main" / "index.ts"
DIRECTORY_INDEX = REPO_ROOT / "supabase" / "functions" / "fplus-directory" / "index.ts"
OPENAPI = REPO_ROOT / "docs" / "openapi.yaml"

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
DEMO_EMAIL = os.getenv("DIRECTORY_TEST_EMAIL", "admin@acs-cymru.local")
DEMO_PASSWORD = os.getenv("DIRECTORY_TEST_PASSWORD", "acscymru123")

# THE UNPREFIXED PATHS, not /functions/v1/fplus-directory. Both reach the same handler, but only
# this one is exempt from the gateway's key-auth -- so an anonymous request tested here is refused
# by the FUNCTION, which is the property worth asserting. Through /functions/v1/ the gateway would
# answer first and the test would be checking Kong.
DIRECTORY_BASE = SUPABASE_URL

# A device attached the legacy way, beside the fixture's `device_submodels` one. Pinned and upserted
# for the reason aas_fixture pins its own: a run that dies before teardown must not poison every
# later run with a primary-key collision.
#
# IT DIFFERS FROM THE FIXTURE'S ID IN THE SECOND BYTE, AND IT HAS TO. `devices.sparkplug_id` is
# GENERATED ALWAYS AS `'dev' || substr(hex(id), 1, 21)` under a UNIQUE index, so only the first
# 21 hex characters of a UUID reach the wire. An id that differs from another only in its last
# block -- the obvious way to write a second pinned fixture -- is a distinct primary key that
# generates an IDENTICAL sparkplug_id, and the insert fails on an index nobody was thinking about.
LEGACY_DEVICE_UUID = "2af00000-0000-4000-8000-000000000001"
LEGACY_DEVICE_NAME = "Directory_Legacy_Schema_Device"

# Nothing has this id. Used to assert 404 rather than 500 for an identifier that is well formed and
# simply not here -- the shape a client gets after a schema is deleted underneath it.
ABSENT_UUID = "00000000-0000-4000-8000-00000000dead"


def request(method: str, url: str, token: str | None, payload: dict | None = None,
            headers: dict | None = None, send_apikey: bool = True):
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    if send_apikey and ANON_KEY:
        req.add_header("apikey", ANON_KEY)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if payload is not None:
        req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            raw = res.read() or b"{}"
            return res.status, json.loads(raw)
    except urllib.error.HTTPError as err:
        raw = err.read() or b"{}"
        try:
            return err.code, json.loads(raw)
        except json.JSONDecodeError:
            return err.code, {"raw": raw.decode(errors="replace")}
    except Exception:
        return 0, {}


def get(path: str, token: str | None, send_apikey: bool = True):
    return request("GET", f"{DIRECTORY_BASE}{path}", token, send_apikey=send_apikey)


def sign_in() -> str | None:
    """A *user* JWT, not the service key: every /v1/ route calls auth.getUser() on the caller."""
    status, data = request(
        "POST",
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        None,
        {"email": DEMO_EMAIL, "password": DEMO_PASSWORD},
    )
    return data.get("access_token") if status == 200 else None


sys.path.insert(0, str(REPO_ROOT / "test-harness"))
import aas_fixture  # noqa: E402  -- after sys.path, by necessity


def rest(method: str, path: str, token: str, payload=None, headers=None):
    return request(method, f"{SUPABASE_URL}/rest/v1{path}", token, payload, headers)


def provision(token):
    """
    The fixture subject plus one legacy-attached device. Returns (schema_id, expected_device_ids).

    THE FIXTURE IS SHARED with the two AAS suites deliberately -- it already provisions a schema
    with a `device_submodels` member at pinned ids, and a second conformance subject would be a
    second thing to keep in step. `ensure` is idempotent and the runner spawns one suite at a time.
    """
    try:
        device = aas_fixture.ensure(SUPABASE_URL, token, ANON_KEY)
    except Exception as err:  # noqa: BLE001 -- reported, never silently skipped
        print(f"[test_fplus_directory] could not provision the fixture: {err}")
        return None, []

    status, rows = rest(
        "GET",
        "/schemas?select=id&schema_name=eq." + urllib.parse.quote(aas_fixture.SCHEMA_NAME),
        token,
    )
    if status != 200 or not rows:
        print("[test_fplus_directory] the fixture schema is not readable")
        return None, []
    schema_id = rows[0]["id"]

    # The legacy arm. `devices.schema_id` and NO device_submodels row, which is the only way the
    # view's second branch is reachable: it requires NOT EXISTS on the join table.
    status, detail = rest("POST", "/devices?on_conflict=id", token, {
        "id": LEGACY_DEVICE_UUID,
        "name": LEGACY_DEVICE_NAME,
        "gateway_id": aas_fixture.GATEWAY_UUID,
        "schema_id": schema_id,
        "status": "ONLINE",
        "is_quarantined": False,
        "connection_method": "MQTT / Sparkplug B",
    }, {"Prefer": "resolution=merge-duplicates,return=representation"})
    if status not in (200, 201):
        # The body, not just the code: PostgREST answers 409 for a unique violation and for a
        # foreign-key one alike, and the two mean opposite things about what went wrong.
        print(f"[test_fplus_directory] could not provision the legacy-attached device: "
              f"{status} {detail}")
        return schema_id, [device["id"]]

    return schema_id, [device["id"], LEGACY_DEVICE_UUID]


def teardown(token):
    """Best effort, and the legacy device first: it references the fixture's gateway and schema."""
    rest("DELETE", f"/devices?id=eq.{LEGACY_DEVICE_UUID}", token)
    aas_fixture.teardown(SUPABASE_URL, token, ANON_KEY)


TOKEN = sign_in()
SCHEMA_ID, EXPECTED_DEVICE_IDS = provision(TOKEN) if TOKEN else (None, [])
LIVE = TOKEN is not None and SCHEMA_ID is not None
SKIP_REASON = "no reachable stack, or the shared AAS fixture could not be provisioned"


# =================================================================================================
# Offline
# =================================================================================================

class TestNeverHoldsTheServiceRoleKey(unittest.TestCase):
    """
    The invariant the whole adapter rests on, and the one a new route is most likely to break.

    A Directory is a live read over the WHOLE address space. Run with the service key it would hand
    every authenticated user a view their RLS policies do not grant them -- and the reverse lookup
    makes that sharper, not softer: "which devices implement this schema" is a fleet-wide question
    whose honest answer differs per caller.

    ASSERTED AGAINST THE REGISTRY, not against the handler, because envForFunction() in
    main/index.ts forwards ONLY what the registry names. The registry is where the grant actually
    happens; code that never reads the variable would still run in a worker that has it.
    """

    @classmethod
    def setUpClass(cls):
        source = MAIN_INDEX.read_text(encoding="utf-8")
        match = re.search(r'"fplus-directory":\s*\[(.*?)\]', source, re.S)
        assert match, "fplus-directory is not registered in FUNCTION_REGISTRY"
        cls.entry = match.group(1)

    def test_the_registry_entry_grants_no_service_role_key(self):
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", self.entry)


class TestTheSourceKeepsItsShape(unittest.TestCase):
    """Properties of the handler that no request can observe until they are already wrong."""

    @classmethod
    def setUpClass(cls):
        cls.source = DIRECTORY_INDEX.read_text(encoding="utf-8")
        body = re.search(
            r"async function schemaMembers\(.*?\n\}\n", cls.source, re.S
        )
        assert body, "schemaMembers() is not in fplus-directory/index.ts"
        cls.members = body.group(0)

    def test_the_bearer_check_still_precedes_every_v1_branch(self):
        # The file's own argument: Kong exempts these routes, so the check is before routing rather
        # than inside each branch -- which is what makes a handler added later authenticated by
        # construction rather than by its author remembering.
        auth = self.source.index('Missing Authorization header')
        self.assertLess(auth, self.source.index('path === "/v1/device"'))
        self.assertLess(auth, self.source.index('path === "/v1/schema"'))

    def test_the_reverse_lookup_reads_the_view_not_the_join_table(self):
        # device_schemas unions the join table with the legacy devices.schema_id. Reading
        # device_submodels alone omits every device provisioned the older way, and reports success.
        self.assertIn('.from("device_schemas")', self.members)
        self.assertNotIn('.from("device_submodels")', self.members)

    def test_the_reverse_lookup_does_not_filter_on_status(self):
        # DELIBERATE, and the opposite of the collection route. An archived schema with devices
        # still attached is a migration that has not finished -- the most useful thing this route
        # can report, and exactly what a status filter would answer 404 to.
        self.assertNotIn('"status"', self.members.replace('"id,schema_name,version,status"', ""))
        self.assertIn("status: schema.status", self.members)

    def test_the_local_namespace_note_is_one_constant(self):
        # It is the sentence that stops a local schemas.id being read as a registered Factory+
        # Schema_UUID. Two literals would be two things to keep in step, and the roadmap entry
        # named exactly this as the caveat any expansion must not drop.
        self.assertEqual(1, self.source.count("not registered Factory+ Schema_UUIDs."))
        self.assertEqual(2, self.source.count("note: LOCAL_SCHEMA_NOTE"))

    def test_every_served_route_is_documented_in_the_openapi_spec(self):
        # The `served` list and docs/openapi.yaml are two statements of the same fact, and the
        # drift checker only guarantees the FUNCTION has a path -- not that each route does.
        # Same reasoning as aas-api's equivalent check.
        spec = OPENAPI.read_text(encoding="utf-8")
        served = re.search(r"served:\s*\[(.*?)\]", self.source, re.S)
        self.assertIsNotNone(served, "the 404 body no longer lists what is served")
        routes = re.findall(r'"([^"]+)"', served.group(1))
        self.assertIn("/v1/schema/{uuid}", routes)
        for route in routes:
            with self.subTest(route=route):
                # `{uuid}` in the source is `{schema_uuid}` / `{instance_uuid}` in the spec, which
                # names each parameter. Compare the literal prefix, which is what routing turns on.
                prefix = route.split("{")[0].rstrip("/")
                self.assertTrue(
                    f"\n  {prefix}" in spec or f"\n  {route}" in spec,
                    f"docs/openapi.yaml documents no path for {route}",
                )


# =================================================================================================
# Live
# =================================================================================================

@unittest.skipUnless(LIVE, SKIP_REASON)
class TestFailsClosed(unittest.TestCase):
    """
    The new route is exempt from key-auth like every other `/v1/` path, so this is the only thing
    in front of it. validate.py check 11b asserts the same property for /v1/device; a route added
    later is the case that check cannot cover.
    """

    def test_an_anonymous_request_is_refused(self):
        status, _ = get(f"/v1/schema/{SCHEMA_ID}", None, send_apikey=False)
        self.assertEqual(status, 401)

    def test_an_apikey_alone_is_not_enough(self):
        # The gateway would accept this; the function must not. A Supabase apikey identifies a
        # project, not a person, and RLS has nobody to answer for.
        status, _ = get(f"/v1/schema/{SCHEMA_ID}", None)
        self.assertEqual(status, 401)


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestReverseLookup(unittest.TestCase):
    def test_it_returns_the_schema_and_its_members(self):
        status, body = get(f"/v1/schema/{SCHEMA_ID}", TOKEN)
        self.assertEqual(status, 200)
        self.assertEqual(body["uuid"], SCHEMA_ID)
        self.assertEqual(body["name"], aas_fixture.SCHEMA_NAME)
        self.assertEqual(body["status"], "active")
        self.assertIsInstance(body["devices"], list)

    def test_it_carries_the_local_namespace_qualification(self):
        # The caveat the roadmap entry called load bearing: a bare UUID with no note asserts an
        # interoperability that does not exist.
        _, body = get(f"/v1/schema/{SCHEMA_ID}", TOKEN)
        self.assertEqual(body["namespace"], "local")
        self.assertIn("not registered Factory+ Schema_UUIDs", body["note"])

    def test_it_finds_a_device_attached_through_device_submodels(self):
        _, body = get(f"/v1/schema/{SCHEMA_ID}", TOKEN)
        self.assertIn(EXPECTED_DEVICE_IDS[0], [d["uuid"] for d in body["devices"]])

    @unittest.skipUnless(len(EXPECTED_DEVICE_IDS) > 1, "the legacy-attached device was not provisioned")
    def test_it_finds_a_device_attached_through_the_legacy_column(self):
        # The specific omission a reverse lookup written against device_submodels would make, and
        # the one no other assertion in this file would notice.
        _, body = get(f"/v1/schema/{SCHEMA_ID}", TOKEN)
        self.assertIn(LEGACY_DEVICE_UUID, [d["uuid"] for d in body["devices"]])

    def test_each_member_carries_a_resolvable_sparkplug_address(self):
        # The reason a client asked: it holds a Schema_UUID and wants the addresses publishing to
        # it. A member with no address is a device the caller cannot then subscribe to.
        _, body = get(f"/v1/schema/{SCHEMA_ID}", TOKEN)
        for device in body["devices"]:
            with self.subTest(device=device["uuid"]):
                self.assertTrue(device["address"]["group_id"])
                self.assertTrue(device["address"]["node_id"])
                self.assertTrue(device["address"]["device_id"])


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestForwardReverseAgreement(unittest.TestCase):
    """
    The property that would rot silently, and the reason this suite exists.

    /v1/device/{uuid} reports a device's schemas; /v1/schema/{uuid} reports a schema's devices. The
    two are composed by different queries and nothing else compares them. A disagreement is not an
    error at either endpoint -- both answer 200 -- so it would be discovered by a client that had
    already integrated against it.
    """

    def test_every_member_claims_the_schema_when_asked_directly(self):
        _, body = get(f"/v1/schema/{SCHEMA_ID}", TOKEN)
        self.assertTrue(body["devices"], "the fixture provisioned no readable members")
        for device in body["devices"]:
            with self.subTest(device=device["uuid"]):
                status, forward = get(f"/v1/device/{device['uuid']}", TOKEN)
                self.assertEqual(status, 200)
                self.assertIn(SCHEMA_ID, forward["schemas"])

    def test_the_member_list_is_embedded_with_its_full_schema_set(self):
        # Each member reports ALL its schemas, not the one filtered on -- the same set /v1/device
        # gives. A route that echoed back its own filter would look right and mislead any caller
        # deciding what else a device implements.
        _, body = get(f"/v1/schema/{SCHEMA_ID}", TOKEN)
        for device in body["devices"]:
            with self.subTest(device=device["uuid"]):
                _, forward = get(f"/v1/device/{device['uuid']}", TOKEN)
                self.assertEqual(sorted(device["schemas"]), sorted(forward["schemas"]))


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestRejectsWhatItCannotAnswer(unittest.TestCase):
    def test_a_schema_name_is_refused_with_a_pointer(self):
        # A client holding `schema_name` is holding the wrong identifier. Saying which one is right
        # is the same courtesy /v1/device pays a caller who sent a sparkplug_id.
        status, body = get(f"/v1/schema/{urllib.parse.quote(aas_fixture.SCHEMA_NAME)}", TOKEN)
        self.assertEqual(status, 400)
        self.assertIn("/v1/schema", body["hint"])

    def test_an_unknown_uuid_is_404_not_500(self):
        status, body = get(f"/v1/schema/{ABSENT_UUID}", TOKEN)
        self.assertEqual(status, 404)
        self.assertIn("No such schema", body["error"])

    def test_the_collection_still_answers_and_is_unchanged(self):
        # The new branch matches a PREFIX. The bare collection must not have been captured by it.
        status, body = get("/v1/schema", TOKEN)
        self.assertEqual(status, 200)
        self.assertEqual(body["namespace"], "local")
        self.assertIn(SCHEMA_ID, [s["uuid"] for s in body["schemas"]])

    def test_the_404_body_advertises_the_new_route(self):
        status, body = get("/v1/nonesuch", TOKEN)
        self.assertEqual(status, 404)
        self.assertIn("/v1/schema/{uuid}", body["served"])


if __name__ == "__main__":
    result = unittest.main(exit=False, verbosity=2).result
    # AFTER the report, so a failing run still leaves its console output intact -- the reason
    # python-suites.mjs spawns `python <file>` rather than collecting with pytest.
    if LIVE:
        teardown(TOKEN)
    sys.exit(0 if result.wasSuccessful() else 1)
