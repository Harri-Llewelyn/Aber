"""
Tests for the aas-export Edge Function.

Two layers, deliberately in one file:

  * Offline checks always run. They guard the Sparkplug -> XSD mapping (which is duplicated between
    Deno and the frontend bundle and would otherwise drift silently) and the authorization ladder.
    These need no stack, so they run in the edge-function CI job alongside the other auth tests.

  * Live checks invoke the deployed function against `Simulated_CNC_01` and validate the emitted
    document. They skip when no stack is reachable, so the same file is safe in both CI jobs; the
    e2e job is the one that actually exercises them.

Run:  python supabase/functions/aas-export/test_aas_export.py
"""
import io
import json
import os
import re
import unittest
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
# The official IDTA metamodel schema, vendored verbatim. See tests/schemas/README.md for its
# provenance and how to refresh it -- it is never hand-edited.
AAS_SCHEMA_PATH = REPO_ROOT / "tests" / "schemas" / "AAS_V3_0_JSON_Schema.json"
TS_MAPPER = REPO_ROOT / "supabase" / "functions" / "aas-export" / "sparkplugToXsd.ts"
JS_MAPPER = REPO_ROOT / "frontend" / "src" / "utils" / "sparkplugDatatype.js"

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
ANON_KEY = os.getenv("SUPABASE_ANON_KEY", "")
DEMO_EMAIL = os.getenv("AAS_TEST_EMAIL", "admin@factoryplus.local")
DEMO_PASSWORD = os.getenv("AAS_TEST_PASSWORD", "factoryplus123")
TARGET_DEVICE = os.getenv("AAS_TEST_DEVICE", "Simulated_CNC_01")

try:
    from jsonschema import Draft201909Validator
    HAVE_JSONSCHEMA = True
except ImportError:  # pragma: no cover - reported, never silently skipped
    HAVE_JSONSCHEMA = False

# AAS V3 DataTypeDefXsd. Anything outside this set is an invalid Property valueType, and it fails
# at the consumer rather than at export time -- which is why it is asserted here.
DATA_TYPE_DEF_XSD = {
    "xs:anyURI", "xs:base64Binary", "xs:boolean", "xs:byte", "xs:date", "xs:dateTime", "xs:decimal",
    "xs:double", "xs:duration", "xs:float", "xs:gDay", "xs:gMonth", "xs:gMonthDay", "xs:gYear",
    "xs:gYearMonth", "xs:hexBinary", "xs:int", "xs:integer", "xs:long", "xs:negativeInteger",
    "xs:nonNegativeInteger", "xs:nonPositiveInteger", "xs:positiveInteger", "xs:short", "xs:string",
    "xs:time", "xs:unsignedByte", "xs:unsignedInt", "xs:unsignedLong", "xs:unsignedShort",
}


def parse_xsd_map(path: Path) -> dict:
    """Extract `<code>: '<xs:type>'` pairs from either mapper file."""
    text = path.read_text(encoding="utf-8")
    block = re.search(r"SPARKPLUG_XSD_TYPES[^{]*\{(.*?)\n\}", text, re.S)
    if not block:
        raise AssertionError(f"SPARKPLUG_XSD_TYPES not found in {path}")
    return {
        int(code): xsd
        for code, xsd in re.findall(r"(\d+)\s*:\s*['\"](xs:[A-Za-z]+)['\"]", block.group(1))
    }


def lower_headers(raw) -> dict:
    """HTTP header names are case-insensitive; a dict built from them is not, and this runtime
    returns them lowercased. Normalise once so lookups cannot depend on the casing upstream chose."""
    return {k.lower(): v for k, v in raw.items()}


def post_json(url: str, payload: dict | None, headers: dict) -> tuple[int, dict, dict]:
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=body, method="POST")
    for key, value in {**headers, "Content-Type": "application/json"}.items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=45) as res:
            return res.status, json.loads(res.read() or b"{}"), lower_headers(res.headers)
    except urllib.error.HTTPError as err:
        raw = err.read() or b"{}"
        try:
            return err.code, json.loads(raw), lower_headers(err.headers)
        except json.JSONDecodeError:
            return err.code, {"raw": raw.decode(errors="replace")}, lower_headers(err.headers)


def sign_in() -> str | None:
    """A *user* JWT, not the service key: the function calls auth.getUser() on the caller."""
    try:
        status, data, _ = post_json(
            f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
            {"email": DEMO_EMAIL, "password": DEMO_PASSWORD},
            {"apikey": ANON_KEY, "Authorization": f"Bearer {ANON_KEY}"},
        )
        return data.get("access_token") if status == 200 else None
    except Exception:
        return None


def find_device_id(token: str) -> str | None:
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/devices?select=id,name&name=eq."
        + urllib.request.quote(TARGET_DEVICE)
    )
    req.add_header("apikey", ANON_KEY)
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            rows = json.loads(res.read() or b"[]")
            return rows[0]["id"] if rows else None
    except Exception:
        return None


TOKEN = sign_in()
DEVICE_ID = find_device_id(TOKEN) if TOKEN else None
LIVE = TOKEN is not None and DEVICE_ID is not None
SKIP_REASON = f"no reachable stack, or device '{TARGET_DEVICE}' not registered"


def evaluate_aas_export_authorization(user: dict | None, auth_header: str | None) -> tuple[int, str]:
    """Python mirror of the authorization ladder in index.ts, same shape as the sibling tests."""
    if not auth_header:
        return 401, "Missing Authorization header"
    if not user:
        return 401, "Invalid user token"
    role = (user.get("app_metadata") or {}).get("role") or None
    # Wider than approve-quarantine on purpose: an export is a read.
    allowed = ["Administrator", "Shopfloor_Manager", "Operator", "Auditor"]
    if not role or role not in allowed:
        return 403, "Forbidden: Insufficient privileges"
    return 200, "Authorized"


class TestSparkplugXsdMapperParity(unittest.TestCase):
    """The Deno copy and the frontend copy must agree; nothing at runtime would catch a drift."""

    def test_both_mappers_define_the_same_table(self):
        ts, js = parse_xsd_map(TS_MAPPER), parse_xsd_map(JS_MAPPER)
        self.assertTrue(ts, "TypeScript mapper parsed empty")
        self.assertEqual(ts, js, "sparkplugToXsd.ts and sparkplugDatatype.js have drifted")

    def test_every_mapped_type_is_a_valid_aas_value_type(self):
        for code, xsd in parse_xsd_map(TS_MAPPER).items():
            self.assertIn(xsd, DATA_TYPE_DEF_XSD, f"code {code} maps to invalid valueType {xsd}")

    def test_int32_maps_to_xs_int_not_xs_int32(self):
        # `xs:int32` is not an XSD type; it is the plausible-looking name that would make every
        # exported document invalid.
        mapping = parse_xsd_map(TS_MAPPER)
        self.assertEqual(mapping[3], "xs:int")
        self.assertNotIn("xs:int32", mapping.values())


class TestAasExportAuthorization(unittest.TestCase):
    def test_missing_auth_header_returns_401(self):
        status, message = evaluate_aas_export_authorization({}, None)
        self.assertEqual(status, 401)
        self.assertIn("Missing Authorization header", message)

    def test_invalid_token_returns_401(self):
        status, message = evaluate_aas_export_authorization(None, "Bearer nope")
        self.assertEqual(status, 401)
        self.assertIn("Invalid user token", message)

    def test_unmapped_role_returns_403(self):
        status, message = evaluate_aas_export_authorization({"app_metadata": {}}, "Bearer x")
        self.assertEqual(status, 403)

    def test_unknown_role_returns_403(self):
        status, _ = evaluate_aas_export_authorization(
            {"app_metadata": {"role": "Intruder"}}, "Bearer x")
        self.assertEqual(status, 403)

    def test_read_roles_are_allowed(self):
        for role in ("Administrator", "Shopfloor_Manager", "Operator", "Auditor"):
            status, _ = evaluate_aas_export_authorization(
                {"app_metadata": {"role": role}}, "Bearer x")
            self.assertEqual(status, 200, f"{role} should be allowed to export")


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestAasExportLive(unittest.TestCase):
    """Invokes the deployed function and validates the document it emits."""

    @classmethod
    def setUpClass(cls):
        cls.status, cls.body, cls.headers = post_json(
            f"{SUPABASE_URL}/functions/v1/aas-export",
            {"device_id": DEVICE_ID},
            {"apikey": ANON_KEY, "Authorization": f"Bearer {TOKEN}"},
        )
        cls.aas = cls.body.get("aas", {})
        cls.submodels = {s.get("idShort"): s for s in cls.aas.get("submodels", [])}

    @classmethod
    def by_role(cls, role):
        """
        Submodels playing a given role, found by idShort SUFFIX.

        The exporter keeps the bare well-known name while one schema is attached and qualifies it
        with the schema key once there are several -- so `OperationalTelemetry` and
        `Simulated_CNC_01_Schema_OperationalTelemetry` are the same role. Matching on the suffix
        makes these assertions hold in both configurations instead of only the single-schema one.
        """
        return [s for k, s in cls.submodels.items() if k == role or k.endswith(f"_{role}")]

    @staticmethod
    def walk(node):
        """Every dict in the document, so structural rules can be asserted over all of it."""
        if isinstance(node, dict):
            yield node
            for value in node.values():
                yield from TestAasExportLive.walk(value)
        elif isinstance(node, list):
            for item in node:
                yield from TestAasExportLive.walk(item)

    def test_returns_200_json(self):
        self.assertEqual(self.status, 200, f"body={self.body}")
        self.assertIn("application/json", self.headers.get("content-type", ""))
        self.assertTrue(self.body.get("success"))

    def test_rejects_unauthenticated_call(self):
        status, _, _ = post_json(
            f"{SUPABASE_URL}/functions/v1/aas-export", {"device_id": DEVICE_ID}, {"apikey": ANON_KEY})
        self.assertIn(status, (401, 403), "export must not be reachable without a user token")

    def test_rejects_a_non_uuid_device_id(self):
        status, _, _ = post_json(
            f"{SUPABASE_URL}/functions/v1/aas-export",
            {"device_id": "Simulated_CNC_01"},
            {"apikey": ANON_KEY, "Authorization": f"Bearer {TOKEN}"},
        )
        self.assertEqual(status, 400)

    def test_has_aas_v3_root_structures(self):
        self.assertIn("assetAdministrationShells", self.aas)
        self.assertIn("submodels", self.aas)
        shell = self.aas["assetAdministrationShells"][0]
        self.assertEqual(shell["modelType"], "AssetAdministrationShell")
        self.assertIn("assetInformation", shell)
        self.assertEqual(shell["assetInformation"]["assetKind"], "Instance")

    def test_global_asset_id_is_built_from_the_sparkplug_id(self):
        shell = self.aas["assetAdministrationShells"][0]
        global_asset_id = shell["assetInformation"]["globalAssetId"]
        self.assertTrue(global_asset_id.startswith("http"))
        self.assertIn(self.body["device"]["sparkplug_id"], global_asset_id)

    def test_shell_references_every_submodel_it_emits(self):
        shell = self.aas["assetAdministrationShells"][0]
        referenced = {k["value"] for ref in shell["submodels"] for k in ref["keys"]}
        emitted = {s["id"] for s in self.aas["submodels"]}
        self.assertEqual(referenced, emitted, "shell references and emitted submodels disagree")

    def test_composes_the_three_expected_submodels(self):
        self.assertIn("DigitalNameplate", self.submodels)
        for role in ("OperationalTelemetry", "KeyPerformanceIndicators"):
            self.assertTrue(self.by_role(role), f"no submodel plays the {role} role")

    def test_nameplate_carries_identity(self):
        elements = {e["idShort"] for e in self.submodels["DigitalNameplate"]["submodelElements"]}
        for expected in ("SerialNumber", "FirmwareVersion", "AssetSparkplugId"):
            self.assertIn(expected, elements)

    def test_telemetry_holds_metrics_and_a_linked_segment(self):
        # The one carrying a Segments collection: with several schemas attached only the telemetry
        # aspects have one, and any of them is a valid subject for this assertion.
        telemetry = next(
            s for s in self.by_role("OperationalTelemetry")
            if any(c["idShort"] == "Segments" for c in s["submodelElements"])
        )
        collections = {c["idShort"]: c for c in telemetry["submodelElements"]}
        self.assertIn("Metrics", collections)
        self.assertGreater(len(collections["Metrics"]["value"]), 0, "no telemetry metrics emitted")

        segments = collections["Segments"]["value"]
        linked = next(s for s in segments if s["idShort"] == "LinkedSegment")
        endpoint = next(p for p in linked["value"] if p["idShort"] == "Endpoint")
        self.assertTrue(str(endpoint["value"]).startswith("http"))

    def test_telemetry_values_are_never_inlined(self):
        # IDTA 02008's LinkedSegment exists precisely so bulk history stays in the historian. A
        # shell that embedded samples would be unbounded in size. Checked across the whole document
        # rather than one submodel, so no aspect can smuggle records in.
        whole = json.dumps(self.aas)
        self.assertNotIn("InternalSegment", whole)
        self.assertNotIn('"records"', whole)

    def test_kpi_submodel_holds_the_iso_22400_factors(self):
        elements = {
            e["idShort"]
            for s in self.by_role("KeyPerformanceIndicators")
            for e in s["submodelElements"]
        }
        for expected in ("OEE_AVAILABILITY", "OEE_EFFECTIVENESS", "OEE_QUALITY"):
            self.assertIn(expected, elements)

    def test_every_property_declares_a_valid_value_type(self):
        for node in self.walk(self.aas):
            if node.get("modelType") == "Property":
                self.assertIn(node.get("valueType"), DATA_TYPE_DEF_XSD,
                              f"{node.get('idShort')} has valueType {node.get('valueType')}")

    def test_no_empty_semantic_id_is_ever_emitted(self):
        # A missing mapping must omit the field, not emit a Reference with no keys -- that asserts
        # a mapping exists and then fails to name it.
        for node in self.walk(self.aas):
            if "semanticId" in node:
                self.assertIsNotNone(node["semanticId"], f"{node.get('idShort')} has null semanticId")
                self.assertTrue(node["semanticId"].get("keys"),
                                f"{node.get('idShort')} has an empty semanticId Reference")
                for key in node["semanticId"]["keys"]:
                    self.assertTrue(key.get("value"), "semanticId key carries no value")

    def test_id_shorts_are_valid_aas_identifiers(self):
        for node in self.walk(self.aas):
            if "idShort" in node:
                self.assertRegex(node["idShort"], r"^[A-Za-z_][A-Za-z0-9_]*$",
                                 f"invalid idShort {node['idShort']}")

    def test_reports_unmapped_semantic_ids_rather_than_hiding_them(self):
        self.assertIn("unmapped_semantic_ids", self.body.get("stats", {}))


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestAasExportSchemaConformance(unittest.TestCase):
    """
    Validates the emitted document against the OFFICIAL IDTA AAS V3 JSON Schema.

    Hand-written structural assertions catch shape errors but not spec violations. This caught
    three real ones the first time it ran: Property.value must be a STRING (never a number and
    never null -- the metamodel expresses "unset" by omitting the field), SubmodelElementCollection
    .value is minItems:1, and conceptDescriptions is minItems:1 so an empty array is invalid.
    """

    @classmethod
    def setUpClass(cls):
        cls.status, cls.body, _ = post_json(
            f"{SUPABASE_URL}/functions/v1/aas-export",
            {"device_id": DEVICE_ID},
            {"apikey": ANON_KEY, "Authorization": f"Bearer {TOKEN}"},
        )

    def test_schema_file_is_vendored(self):
        self.assertTrue(AAS_SCHEMA_PATH.exists(), f"missing vendored schema at {AAS_SCHEMA_PATH}")
        schema = json.loads(AAS_SCHEMA_PATH.read_text(encoding="utf-8"))
        # Guards against a truncated or wrong-version download rather than trusting the filename.
        self.assertIn("admin-shell.io/aas/3", schema.get("$id", ""))
        self.assertIn("Environment", schema.get("definitions", {}))

    @unittest.skipUnless(HAVE_JSONSCHEMA, "jsonschema not installed")
    def test_export_has_zero_schema_violations(self):
        schema = json.loads(AAS_SCHEMA_PATH.read_text(encoding="utf-8"))
        errors = list(Draft201909Validator(schema).iter_errors(self.body.get("aas", {})))
        detail = "\n".join(
            f"  {'/'.join(str(x) for x in e.absolute_path) or '<root>'}: {e.message[:180]}"
            for e in errors[:10]
        )
        self.assertEqual(len(errors), 0, f"AAS V3 schema violations:\n{detail}")

    @unittest.skipUnless(HAVE_JSONSCHEMA, "jsonschema not installed")
    def test_property_values_are_strings_or_absent(self):
        # The specific rule the first validation run failed on, asserted directly so a regression
        # names the cause rather than surfacing as a generic "not valid under any of the schemas".
        for node in TestAasExportLive.walk(self.body.get("aas", {})):
            if node.get("modelType") == "Property" and "value" in node:
                self.assertIsInstance(
                    node["value"], str,
                    f"{node.get('idShort')} carries a non-string value {node['value']!r}")

    def test_no_empty_collections_are_emitted(self):
        for node in TestAasExportLive.walk(self.body.get("aas", {})):
            if node.get("modelType") == "SubmodelElementCollection":
                self.assertTrue(node.get("value"),
                                f"{node.get('idShort')} is an empty SubmodelElementCollection")
        # conceptDescriptions is minItems:1, so it is omitted rather than emitted empty.
        self.assertNotEqual(self.body.get("aas", {}).get("conceptDescriptions"), [])


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestAasxPackage(unittest.TestCase):
    """The AASX (Open Packaging Conventions / ISO 29500) container."""

    @classmethod
    def setUpClass(cls):
        req = urllib.request.Request(
            f"{SUPABASE_URL}/functions/v1/aas-export?format=aasx",
            data=json.dumps({"device_id": DEVICE_ID}).encode(),
            method="POST",
        )
        req.add_header("apikey", ANON_KEY)
        req.add_header("Authorization", f"Bearer {TOKEN}")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=45) as res:
            cls.status = res.status
            cls.headers = lower_headers(res.headers)
            cls.payload = res.read()
        cls.zip = zipfile.ZipFile(io.BytesIO(cls.payload))

    def test_returns_a_package_with_download_headers(self):
        self.assertEqual(self.status, 200)
        self.assertIn("asset-administration-shell-package", self.headers.get("content-type", ""))
        self.assertIn(".aasx", self.headers.get("content-disposition", ""))

    def test_is_a_valid_zip_archive(self):
        self.assertIsNone(self.zip.testzip(), "corrupt archive")

    def test_carries_the_opc_discovery_chain(self):
        # Every part is load-bearing: a reader walks .rels -> aasx-origin -> aas-spec to find the
        # payload without knowing our filenames. A missing link makes the package unreadable.
        names = set(self.zip.namelist())
        for required in (
            "[Content_Types].xml",
            "_rels/.rels",
            "aasx/aasx-origin",
            "aasx/_rels/aasx-origin.rels",
            "aasx/aasenv-root.json",
        ):
            self.assertIn(required, names, f"missing OPC part {required}")

    def test_origin_part_is_empty_and_relationships_point_at_the_payload(self):
        self.assertEqual(self.zip.read("aasx/aasx-origin"), b"")
        self.assertIn("aasx-origin", self.zip.read("_rels/.rels").decode())
        self.assertIn("aasenv-root.json", self.zip.read("aasx/_rels/aasx-origin.rels").decode())

    def test_content_types_declares_every_extension_used(self):
        content_types = self.zip.read("[Content_Types].xml").decode()
        self.assertIn('Extension="rels"', content_types)
        self.assertIn('Extension="json"', content_types)

    def test_payload_matches_the_json_export(self):
        packaged = json.loads(self.zip.read("aasx/aasenv-root.json"))
        _, body, _ = post_json(
            f"{SUPABASE_URL}/functions/v1/aas-export",
            {"device_id": DEVICE_ID},
            {"apikey": ANON_KEY, "Authorization": f"Bearer {TOKEN}"},
        )
        self.assertEqual(packaged, body.get("aas"),
                         "the packaged Environment differs from the JSON export")

    @unittest.skipUnless(HAVE_JSONSCHEMA, "jsonschema not installed")
    def test_packaged_payload_validates_against_the_official_schema(self):
        schema = json.loads(AAS_SCHEMA_PATH.read_text(encoding="utf-8"))
        packaged = json.loads(self.zip.read("aasx/aasenv-root.json"))
        self.assertEqual(list(Draft201909Validator(schema).iter_errors(packaged)), [])

    def test_rejects_an_unknown_format(self):
        status, body, _ = post_json(
            f"{SUPABASE_URL}/functions/v1/aas-export?format=xlsx",
            {"device_id": DEVICE_ID},
            {"apikey": ANON_KEY, "Authorization": f"Bearer {TOKEN}"},
        )
        self.assertEqual(status, 400)
        self.assertIn("format", str(body).lower())


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestMultiSubmodel(unittest.TestCase):
    """Phase 5: one AAS Submodel per schema attached through device_submodels."""

    @classmethod
    def setUpClass(cls):
        _, cls.body, _ = post_json(
            f"{SUPABASE_URL}/functions/v1/aas-export",
            {"device_id": DEVICE_ID},
            {"apikey": ANON_KEY, "Authorization": f"Bearer {TOKEN}"},
        )

    def test_reports_how_many_schemas_are_attached(self):
        self.assertIn("attached_schemas", self.body.get("stats", {}))
        self.assertGreaterEqual(self.body["stats"]["attached_schemas"], 1)

    def test_emits_at_least_one_submodel_per_attached_schema(self):
        # Plus the Nameplate, which is composed from the device row rather than from a schema.
        attached = self.body["stats"]["attached_schemas"]
        self.assertGreaterEqual(self.body["stats"]["submodels"], attached + 1)

    def test_submodel_ids_are_unique(self):
        ids = [s["id"] for s in self.body["aas"]["submodels"]]
        self.assertEqual(len(ids), len(set(ids)), "two submodels share an id")

    def test_submodel_id_shorts_are_unique(self):
        # Two schemas attached to one device must not both claim `OperationalTelemetry`.
        shorts = [s["idShort"] for s in self.body["aas"]["submodels"]]
        self.assertEqual(len(shorts), len(set(shorts)), "two submodels share an idShort")


if __name__ == "__main__":
    if not LIVE:
        print(f"[test_aas_export] live checks skipped: {SKIP_REASON}")
    if not HAVE_JSONSCHEMA:
        print("[test_aas_export] jsonschema not installed: official-schema validation skipped")
    unittest.main(verbosity=2)
