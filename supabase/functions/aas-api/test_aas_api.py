"""
Tests for the aas-api Edge Function -- the IDTA 02001/02002 read surface.

Two layers, deliberately in one file, matching test_aas_export.py:

  * Offline checks always run. They guard the things that are true of the SOURCE regardless of
    whether a stack is up -- above all that this function is never granted the service-role key,
    which is the entire security argument for it being a separate function.

  * Live checks exercise the deployed function against `Sim_CNC_Mill_01` and validate what comes
    back against the vendored IDTA metamodel schema. They skip when no stack is reachable.

THE TEST THAT MATTERS MOST is TestExportAgreement: it fetches the same asset through aas-export and
through aas-api and asserts the two describe it identically. That agreement is the whole reason the
mapping lives in _shared/aas/shell.ts, and it is the property that would rot silently -- an ERP
reading a live submodel and a partner reading a shipped .aasx would disagree, with both endpoints
reporting success.

Run:  python supabase/functions/aas-api/test_aas_api.py
"""
import base64
import json
import os
import re
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
AAS_SCHEMA_PATH = REPO_ROOT / "tests" / "schemas" / "AAS_V3_0_JSON_Schema.json"
MAIN_INDEX = REPO_ROOT / "supabase" / "functions" / "main" / "index.ts"
API_INDEX = REPO_ROOT / "supabase" / "functions" / "aas-api" / "index.ts"
SHARED_SHELL = REPO_ROOT / "supabase" / "functions" / "_shared" / "aas" / "shell.ts"

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
DEMO_EMAIL = os.getenv("AAS_TEST_EMAIL", "admin@acs-cymru.local")
DEMO_PASSWORD = os.getenv("AAS_TEST_PASSWORD", "acscymru123")
TARGET_DEVICE = os.getenv("AAS_TEST_DEVICE", "Sim_CNC_Mill_01")

API_BASE = f"{SUPABASE_URL}/functions/v1/aas-api"

try:
    from jsonschema import Draft201909Validator
    HAVE_JSONSCHEMA = True
except ImportError:  # pragma: no cover - reported, never silently skipped
    HAVE_JSONSCHEMA = False


def b64url(value: str) -> str:
    """IDTA 02002 encodes every Identifier in a path this way. Unpadded, as the specification shows."""
    return base64.urlsafe_b64encode(value.encode()).decode().rstrip("=")


def request(method: str, url: str, token: str | None, payload: dict | None = None):
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("apikey", ANON_KEY)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if payload is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=45) as res:
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


def get(path: str, token: str | None):
    return request("GET", f"{API_BASE}{path}", token)


def sign_in() -> str | None:
    """A *user* JWT, not the service key: the function calls auth.getUser() on the caller."""
    status, data = request(
        "POST",
        f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
        None,
        {"email": DEMO_EMAIL, "password": DEMO_PASSWORD},
    )
    return data.get("access_token") if status == 200 else None


def find_device(token: str):
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/devices?select=id,name,sparkplug_id&name=eq."
        + urllib.parse.quote(TARGET_DEVICE)
    )
    req.add_header("apikey", ANON_KEY)
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            rows = json.loads(res.read() or b"[]")
            return rows[0] if rows else None
    except Exception:
        return None


TOKEN = sign_in()
DEVICE = find_device(TOKEN) if TOKEN else None
LIVE = TOKEN is not None and DEVICE is not None
SKIP_REASON = f"no reachable stack, or device '{TARGET_DEVICE}' not registered"


def target_shell_id() -> str | None:
    """
    The target device's shell identifier, ASKED FOR rather than composed.

    It is tempting to build it -- `<AAS_BASE_IRI><sparkplug_id>/shell` is the rule shell.ts
    follows -- and that was how this file first did it, with the DEFAULT base hard-coded. On any
    deployment that sets AAS_BASE_IRI to something else, every test built on it would fail and
    report a broken API while the API was answering correctly. The suite would be asserting its
    own guess about configuration.

    /shells already returns real identifiers, so the deployment's own answer is one request away.
    """
    _, body = get("/shells?limit=100", TOKEN)
    for shell in body.get("result", []):
        if shell.get("idShort") == TARGET_DEVICE:
            return shell["id"]
    return None


SHELL_ID = target_shell_id() if LIVE else None


# =================================================================================================
# Offline
# =================================================================================================

class TestNeverHoldsTheServiceRoleKey(unittest.TestCase):
    """
    The security invariant this function's existence rests on.

    aas-export holds SUPABASE_SERVICE_ROLE_KEY and composes a document after checking the caller's
    role. aas-api is a LIVE READ API over the whole asset space, so it authenticates and then reads
    as the caller and lets RLS answer -- exactly the reasoning fplus-directory's registry entry
    gives. If the key were ever added to this function's entry, every authenticated user's submodel
    lookup would silently become a privileged one, and no other test in this repository would fail.

    ASSERTED AGAINST THE REGISTRY, not against the handler, because envForFunction() in
    main/index.ts forwards ONLY what the registry names. The registry is where the grant actually
    happens; code that never reads the variable would still be running in a worker that has it.
    """

    @classmethod
    def setUpClass(cls):
        cls.source = MAIN_INDEX.read_text(encoding="utf-8")
        match = re.search(r'"aas-api":\s*\[(.*?)\]', cls.source, re.S)
        assert match, "aas-api is not registered in FUNCTION_REGISTRY"
        cls.entry = match.group(1)

    def test_the_registry_entry_does_not_grant_the_service_role_key(self):
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", self.entry)

    def test_the_handler_never_reads_the_service_role_key(self):
        # Belt and braces: the registry is the grant, but a handler reaching for the variable would
        # mean somebody intended it to have one.
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", API_INDEX.read_text(encoding="utf-8"))

    def test_aas_export_still_does_hold_it(self):
        # The contrast is the point, and a refactor that stripped the key from BOTH would make the
        # test above pass while breaking the export.
        match = re.search(r'"aas-export":\s*\[(.*?)\]', self.source, re.S)
        self.assertIsNotNone(match)
        self.assertIn("SUPABASE_SERVICE_ROLE_KEY", match.group(1))


class TestIdentifierNamespaceAgrees(unittest.TestCase):
    """
    Both workers must derive identifiers from the same variables, or the ids this endpoint serves
    are not the ids the exporter mints.

    They are separate workers with separate environments (main/index.ts spawns one per function and
    forwards only what its entry names), so "they read the same module" is NOT sufficient -- the
    module reads Deno.env at load, per worker.
    """

    @classmethod
    def setUpClass(cls):
        source = MAIN_INDEX.read_text(encoding="utf-8")
        cls.entries = {
            name: re.search(rf'"{name}":\s*\[(.*?)\]', source, re.S).group(1)
            for name in ("aas-api", "aas-export")
        }

    def test_both_declare_every_variable_the_identifiers_derive_from(self):
        # AAS_BASE_IRI is the namespace itself; AAS_HISTORIAN_ENDPOINT and AAS_MODEL_PUBLIC_BASE are
        # embedded in submodel element values, so a mismatch shows up as a document difference
        # rather than as a failure.
        for var in ("AAS_BASE_IRI", "AAS_HISTORIAN_ENDPOINT", "AAS_MODEL_PUBLIC_BASE"):
            for name, entry in self.entries.items():
                self.assertIn(var, entry, f"{name} does not declare {var}")

    def test_the_api_does_not_declare_packaging_only_variables(self):
        # AASX packaging lives in aas-export. Declaring these here would suggest this function
        # serves packages, which it deliberately does not.
        for var in ("STORAGE_MODEL_BUCKET", "AAS_MAX_BUNDLED_MODEL_BYTES"):
            self.assertNotIn(var, self.entries["aas-api"])


class TestServesOnlyReads(unittest.TestCase):
    """
    Writes are not implemented, and the self-description says so.

    A repository that advertised SSP-001 would be promising POST/PUT/DELETE. Asset data is authored
    through the dashboard, which has the role model and writes `digital_thread`; a write here would
    bypass both.
    """

    def setUp(self):
        self.source = API_INDEX.read_text(encoding="utf-8")

    def test_advertises_the_read_only_profiles(self):
        # SCOPED TO THE PROFILES ARRAY, not the whole file: the comment beside it names SSP-001 to
        # explain why it is not advertised, and asserting over the source would fail on the
        # explanation rather than on the behaviour. It would also print the entire file as the
        # failure message, which is how this was noticed.
        block = re.search(r"profiles:\s*\[(.*?)\]", self.source, re.S)
        self.assertIsNotNone(block, "no profiles array in the /description handler")
        # The advertised profiles are the STRING LITERALS, not the array text: the comment inside
        # the array names SSP-001 to explain why it is absent, and matching the raw text would fail
        # on the explanation.
        advertised = re.findall(r'"(https://admin-shell\.io/[^"]+)"', block.group(1))
        self.assertTrue(advertised, "no profile identifiers advertised")
        for profile in advertised:
            self.assertTrue(profile.endswith("SSP-002"), f"{profile} is not a read-only profile")

    def test_the_mapping_is_imported_rather_than_reimplemented(self):
        # The anti-drift rule, asserted structurally as well as behaviourally (see
        # TestExportAgreement): this file must not grow its own copy of the builders.
        self.assertIn('from "../_shared/aas/shell.ts"', self.source)
        self.assertNotIn("modelType: \"AssetAdministrationShell\"", self.source)


class TestBase64UrlContract(unittest.TestCase):
    """
    Plain base64 is not interchangeable here, and the failure is silent rather than loud.

    `/` is a legal base64 character and a path separator, so an identifier containing one would be
    split across two path segments and the route would simply not match -- a 404 that looks like a
    missing asset rather than an encoding mistake.
    """

    def test_a_shell_identifier_encodes_without_path_separators(self):
        identifier = "https://acs-cymru.local/ids/asset/dev220000000000400080000/shell"
        encoded = b64url(identifier)
        self.assertNotIn("/", encoded)
        self.assertNotIn("+", encoded)
        self.assertNotIn("=", encoded)

    def test_round_trips(self):
        identifier = "https://acs-cymru.local/ids/asset/dev220000000000400080000/submodel/Nameplate"
        padded = b64url(identifier) + "=" * (-len(b64url(identifier)) % 4)
        self.assertEqual(base64.urlsafe_b64decode(padded).decode(), identifier)


# =================================================================================================
# Live
# =================================================================================================

@unittest.skipUnless(LIVE, SKIP_REASON)
class TestDescription(unittest.TestCase):
    def test_is_reachable_without_a_user_token(self):
        # By specification: a client reads it to learn what it is talking to before holding a
        # credential. Same argument as fplus-directory's /ping.
        status, body = get("/description", None)
        self.assertEqual(status, 200)
        self.assertIn("profiles", body)

    def test_declares_both_read_only_repository_profiles(self):
        _, body = get("/description", TOKEN)
        joined = " ".join(body["profiles"])
        self.assertIn("AssetAdministrationShellRepositoryServiceSpecification/SSP-002", joined)
        self.assertIn("SubmodelRepositoryServiceSpecification/SSP-002", joined)


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestAuthorization(unittest.TestCase):
    def test_a_request_with_no_token_is_refused(self):
        status, _ = get("/shells", None)
        self.assertEqual(status, 401)

    def test_a_write_is_refused_with_405_not_404(self):
        # 404 would invite a client to retry the URL rather than stop writing.
        status, _ = request("POST", f"{API_BASE}/shells", TOKEN, {})
        self.assertEqual(status, 405)

    def test_the_root_answers_404_and_names_what_is_served(self):
        # 404 because there IS no resource at a repository root and the specification defines no
        # index -- but a 404 with nothing in it strands whoever just found this URL in a config
        # file, so the body lists the routes. Same reasoning as fplus-directory's `served`.
        status, body = get("", TOKEN)
        self.assertEqual(status, 404)
        self.assertIn("/description", body["served"])
        self.assertIn("messages", body)

    def test_every_served_route_is_documented_in_the_openapi_spec(self):
        # The root's list and docs/openapi.yaml are two statements of the same fact, and the drift
        # checker only guarantees that the FUNCTION has a path -- not that each route does.
        spec = (REPO_ROOT / "docs" / "openapi.yaml").read_text(encoding="utf-8")
        _, body = get("", TOKEN)
        for route in body["served"]:
            with self.subTest(route=route):
                # The message is explicit rather than left to assertIn, which would print the
                # whole specification as the "not found in" haystack.
                self.assertTrue(
                    f"/functions/v1/aas-api{route}" in spec,
                    f"docs/openapi.yaml has no path for the served route {route}",
                )

    def test_errors_use_the_specification_message_shape(self):
        # A conformant client parses messages[]; this stack's usual {"error": "..."} would be
        # unreadable to exactly the tools this endpoint exists for.
        status, body = get("/shells?limit=0", TOKEN)
        self.assertEqual(status, 400)
        self.assertIn("messages", body)
        self.assertEqual(body["messages"][0]["messageType"], "Error")


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestShellRoutes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.shell_id = None
        _, body = get("/shells?limit=50", TOKEN)
        for shell in body.get("result", []):
            if shell.get("idShort") == TARGET_DEVICE:
                cls.shell_id = shell["id"]
        cls.encoded = b64url(cls.shell_id) if cls.shell_id else None

    def test_the_listing_is_paginated_in_the_specification_shape(self):
        status, body = get("/shells?limit=2", TOKEN)
        self.assertEqual(status, 200)
        self.assertIn("paging_metadata", body)
        self.assertIn("result", body)
        self.assertLessEqual(len(body["result"]), 2)

    def test_the_cursor_walks_forward_without_repeating(self):
        _, first = get("/shells?limit=2", TOKEN)
        cursor = first["paging_metadata"].get("cursor")
        self.assertIsNotNone(cursor, "expected more than two devices on the demo stack")
        _, second = get(f"/shells?limit=2&cursor={urllib.parse.quote(cursor)}", TOKEN)
        firsts = {s["id"] for s in first["result"]}
        seconds = {s["id"] for s in second["result"]}
        self.assertEqual(firsts & seconds, set())

    def test_the_target_device_publishes_a_shell(self):
        self.assertIsNotNone(self.shell_id, f"{TARGET_DEVICE} is absent from /shells")

    def test_a_shell_resolves_by_its_base64url_identifier(self):
        status, body = get(f"/shells/{self.encoded}", TOKEN)
        self.assertEqual(status, 200)
        self.assertEqual(body["modelType"], "AssetAdministrationShell")
        self.assertEqual(body["id"], self.shell_id)

    def test_asset_information_carries_the_global_asset_id(self):
        _, body = get(f"/shells/{self.encoded}/asset-information", TOKEN)
        self.assertEqual(body["assetKind"], "Instance")
        self.assertIn("globalAssetId", body)

    def test_submodel_refs_are_model_references(self):
        status, body = get(f"/shells/{self.encoded}/submodel-refs", TOKEN)
        self.assertEqual(status, 200)
        self.assertGreater(len(body["result"]), 0)
        for ref in body["result"]:
            self.assertEqual(ref["type"], "ModelReference")
            self.assertEqual(ref["keys"][0]["type"], "Submodel")

    def test_a_submodel_identifier_is_not_accepted_as_a_shell_identifier(self):
        # Both forms parse to the same device, so without the explicit id comparison in the handler
        # a submodel id would resolve here and return the wrong object with status 200.
        _, refs = get(f"/shells/{self.encoded}/submodel-refs", TOKEN)
        submodel_id = refs["result"][0]["keys"][0]["value"]
        status, _ = get(f"/shells/{b64url(submodel_id)}", TOKEN)
        self.assertEqual(status, 404)

    def test_an_unknown_identifier_is_404(self):
        status, _ = get(f"/shells/{b64url('https://example.org/not-ours')}", TOKEN)
        self.assertEqual(status, 404)

    def test_a_malformed_identifier_is_400_not_500(self):
        status, _ = get("/shells/!!!not-base64!!!", TOKEN)
        self.assertEqual(status, 400)


@unittest.skipUnless(LIVE and SHELL_ID, SKIP_REASON)
class TestSubmodelRoutes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.shell_id = SHELL_ID
        _, refs = get(f"/shells/{b64url(cls.shell_id)}/submodel-refs", TOKEN)
        cls.ids = [r["keys"][0]["value"] for r in refs["result"]]
        cls.nameplate = next(i for i in cls.ids if i.endswith("/Nameplate"))

    def test_a_submodel_resolves_by_identifier(self):
        status, body = get(f"/submodels/{b64url(self.nameplate)}", TOKEN)
        self.assertEqual(status, 200)
        self.assertEqual(body["modelType"], "Submodel")
        self.assertEqual(body["idShort"], "DigitalNameplate")

    def test_the_same_submodel_resolves_through_its_shell(self):
        direct = get(f"/submodels/{b64url(self.nameplate)}", TOKEN)[1]
        nested = get(
            f"/shells/{b64url(self.shell_id)}/submodels/{b64url(self.nameplate)}", TOKEN
        )[1]
        self.assertEqual(direct, nested)

    def test_a_submodel_from_another_shell_is_not_reachable_through_this_one(self):
        _, shells = get("/shells?limit=50", TOKEN)
        other = next(s for s in shells["result"] if s["id"] != self.shell_id)
        foreign = other["submodels"][0]["keys"][0]["value"]
        status, _ = get(
            f"/shells/{b64url(self.shell_id)}/submodels/{b64url(foreign)}", TOKEN
        )
        self.assertEqual(status, 404)

    def test_submodel_elements_are_listed_paginated(self):
        status, body = get(
            f"/submodels/{b64url(self.nameplate)}/submodel-elements", TOKEN
        )
        self.assertEqual(status, 200)
        self.assertIn("paging_metadata", body)
        self.assertGreater(len(body["result"]), 0)

    def test_an_element_resolves_by_id_short_path(self):
        status, body = get(
            f"/submodels/{b64url(self.nameplate)}/submodel-elements/SerialNumber", TOKEN
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["idShort"], "SerialNumber")
        self.assertEqual(body["modelType"], "Property")

    def test_a_nested_element_resolves_through_a_dotted_path(self):
        telemetry = next(i for i in self.ids if i.endswith("/OperationalTelemetry"))
        status, body = get(
            f"/submodels/{b64url(telemetry)}/submodel-elements/Metrics.Systems_TEMPERATURE",
            TOKEN,
        )
        self.assertEqual(status, 200)
        self.assertEqual(body["idShort"], "Systems_TEMPERATURE")

    def test_a_path_through_a_leaf_is_404_not_500(self):
        status, _ = get(
            f"/submodels/{b64url(self.nameplate)}/submodel-elements/SerialNumber.Nope", TOKEN
        )
        self.assertEqual(status, 404)

    def test_value_only_flattens_a_submodel_to_its_values(self):
        status, body = get(f"/submodels/{b64url(self.nameplate)}/$value", TOKEN)
        self.assertEqual(status, 200)
        # The ERP-facing shape: read a value by name rather than walking submodelElements[].
        self.assertIn("SerialNumber", body)
        self.assertNotIn("modelType", body)

    def test_value_only_nests_collections(self):
        telemetry = next(i for i in self.ids if i.endswith("/OperationalTelemetry"))
        _, body = get(f"/submodels/{b64url(telemetry)}/$value", TOKEN)
        self.assertIn("Metrics", body)
        self.assertIsInstance(body["Metrics"], dict)

    def test_value_only_on_a_single_element(self):
        _, full = get(
            f"/submodels/{b64url(self.nameplate)}/submodel-elements/SerialNumber", TOKEN
        )
        _, value = get(
            f"/submodels/{b64url(self.nameplate)}/submodel-elements/SerialNumber/$value", TOKEN
        )
        self.assertEqual(value, full["value"])


@unittest.skipUnless(LIVE and SHELL_ID and HAVE_JSONSCHEMA, SKIP_REASON + ", or jsonschema is not installed")
class TestMetamodelConformance(unittest.TestCase):
    """
    What this endpoint serves has to satisfy the official metamodel, not merely look like it.

    Validated by reassembling an Environment from the pieces the API serves and running the SAME
    vendored schema the exporter is held to. Reassembly rather than per-fragment validation is
    deliberate: the schema's entry point is the Environment, and validating fragments against
    internal definitions would be asserting against a private part of someone else's schema.
    """

    @classmethod
    def setUpClass(cls):
        cls.schema = json.loads(AAS_SCHEMA_PATH.read_text(encoding="utf-8"))
        shell_id = SHELL_ID
        _, cls.shell = get(f"/shells/{b64url(shell_id)}", TOKEN)
        _, refs = get(f"/shells/{b64url(shell_id)}/submodel-refs", TOKEN)
        cls.submodels = [
            get(f"/submodels/{b64url(r['keys'][0]['value'])}", TOKEN)[1]
            for r in refs["result"]
        ]

    def test_the_vendored_schema_is_present(self):
        self.assertTrue(AAS_SCHEMA_PATH.exists(), f"missing vendored schema at {AAS_SCHEMA_PATH}")

    def test_the_served_graph_validates_as_an_environment(self):
        environment = {
            "assetAdministrationShells": [self.shell],
            "submodels": self.submodels,
        }
        errors = list(Draft201909Validator(self.schema).iter_errors(environment))
        self.assertEqual(
            errors, [], "\n".join(f"{list(e.path)}: {e.message}" for e in errors[:10])
        )


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestExportAgreement(unittest.TestCase):
    """
    THE ANTI-DRIFT TEST, and the justification for _shared/aas/shell.ts existing at all.

    The same asset, fetched two ways: as a document from aas-export and as REST resources from
    aas-api. If these ever disagree, a partner holding an exported .aasx and an ERP querying the
    live endpoint have different answers about the same machine, and BOTH endpoints report success
    -- which is a worse failure than either being unavailable. Nothing else in the suite would
    catch it, because each side is internally consistent.
    """

    @classmethod
    def setUpClass(cls):
        status, body = request(
            "POST",
            f"{SUPABASE_URL}/functions/v1/aas-export",
            TOKEN,
            {"device_id": DEVICE["id"]},
        )
        assert status == 200, f"aas-export returned {status}: {body}"
        cls.exported = body["aas"]

        shell_id = cls.exported["assetAdministrationShells"][0]["id"]
        _, cls.api_shell = get(f"/shells/{b64url(shell_id)}", TOKEN)
        cls.api_submodels = {
            s["id"]: s
            for s in (
                get(f"/submodels/{b64url(sm['id'])}", TOKEN)[1]
                for sm in cls.exported["submodels"]
            )
        }

    def test_the_shell_is_identical(self):
        self.assertEqual(self.api_shell, self.exported["assetAdministrationShells"][0])

    def test_every_exported_submodel_is_served_identically(self):
        for exported in self.exported["submodels"]:
            with self.subTest(submodel=exported["idShort"]):
                self.assertIn(exported["id"], self.api_submodels)
                self.assertEqual(self.api_submodels[exported["id"]], exported)

    def test_neither_side_publishes_a_submodel_the_other_does_not(self):
        _, refs = get(f"/shells/{b64url(self.api_shell['id'])}/submodel-refs", TOKEN)
        served = {r["keys"][0]["value"] for r in refs["result"]}
        exported = {s["id"] for s in self.exported["submodels"]}
        self.assertEqual(served, exported)


if __name__ == "__main__":
    if not HAVE_JSONSCHEMA:
        print("[test_aas_api] jsonschema is not installed; metamodel conformance is SKIPPED")
    runner = unittest.main(verbosity=2, exit=False)
    if not LIVE:
        print(f"[test_aas_api] live checks skipped: {SKIP_REASON}")
    raise SystemExit(0 if runner.result.wasSuccessful() else 1)
