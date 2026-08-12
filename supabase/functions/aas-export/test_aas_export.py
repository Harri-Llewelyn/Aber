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
TS_MODEL_TYPES = REPO_ROOT / "supabase" / "functions" / "aas-export" / "model3dContentType.ts"
JS_MODEL_TYPES = REPO_ROOT / "frontend" / "src" / "utils" / "model3d.js"

MODEL_BUCKET = os.getenv("STORAGE_MODEL_BUCKET", "asset-3d-models")
# The AAS metamodel's idShort pattern, transcribed from the vendored schema. Stricter than it
# looks: it must START WITH A LETTER and be at least two characters, which is why "3DModel" -- the
# obvious name for the element -- is invalid, and why prefixing it with "_" does not rescue it.
ID_SHORT_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_-]*[a-zA-Z0-9_]+$")

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


def parse_model_content_types(path: Path) -> dict:
    """Extract the `<ext>: "<media type>"` table from either 3D content-type module."""
    text = path.read_text(encoding="utf-8")
    block = re.search(r"MODEL_3D_CONTENT_TYPES[^{]*\{(.*?)\}", text, re.S)
    if not block:
        raise AssertionError(f"MODEL_3D_CONTENT_TYPES not found in {path}")
    return dict(re.findall(r"(\w+)\s*:\s*['\"]([\w.+/-]+)['\"]", block.group(1)))


def without_model_reference(environment: dict) -> dict:
    """
    A copy of the Environment with the 3D model's `File.value` removed.

    Bundling a model into an AASX rewrites that one value to a package-relative part name, so the
    packaged Environment is byte-identical to the JSON export EXCEPT there. Comparing with it
    stripped keeps "the package matches the export" assertable without weakening it to a spot
    check -- any other divergence still fails.
    """
    copy = json.loads(json.dumps(environment))
    for submodel in copy.get("submodels", []):
        if submodel.get("idShort") != "VisualRepresentation":
            continue
        for element in submodel.get("submodelElements", []):
            element.pop("value", None)
    return copy


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


class TestModel3DContentTypeParity(unittest.TestCase):
    """
    The Deno copy and the frontend copy of the 3D media-type table must agree.

    Same arrangement -- and same hazard -- as the Sparkplug/XSD mappers above: an edge worker
    cannot import the frontend bundle, so the table is duplicated, and nothing at runtime would
    notice a drift. A disagreement is not cosmetic here: the browser labels the stored object with
    one type and the exporter publishes another, so a consumer picks the wrong loader.
    """

    def test_both_tables_agree(self):
        ts = parse_model_content_types(TS_MODEL_TYPES)
        js = parse_model_content_types(JS_MODEL_TYPES)
        self.assertTrue(ts, "TypeScript content-type table parsed empty")
        self.assertEqual(ts, js, "model3dContentType.ts and model3d.js have drifted")

    def test_covers_every_format_the_ui_accepts(self):
        table = parse_model_content_types(TS_MODEL_TYPES)
        self.assertEqual(set(table), {"glb", "gltf", "obj", "stl"})

    def test_gltf_types_are_the_registered_ones(self):
        # RFC 9245. The binary and JSON forms are DIFFERENT media types, and swapping them makes a
        # viewer try to parse a binary container as text.
        table = parse_model_content_types(TS_MODEL_TYPES)
        self.assertEqual(table["glb"], "model/gltf-binary")
        self.assertEqual(table["gltf"], "model/gltf+json")


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

    def test_nameplate_elements_carry_published_idta_identifiers(self):
        """
        The IDTA elements say what they mean, using IDTA's own identifiers.

        These IRDIs come from IDTA 02006-3-0-1 and are seeded by migration 0011; the exporter looks
        them up rather than hard-coding them, so this asserts the lookup actually reached the
        table. A missing semanticId here means the join silently produced nothing, which is exactly
        the failure that would otherwise ship as a valid-looking shell full of anonymous strings.
        """
        elements = {e["idShort"]: e for e in self.submodels["DigitalNameplate"]["submodelElements"]}
        expected = {
            "SerialNumber": "0112/2///61987#ABA951#009",
            "ManufacturerProductDesignation": "0112/2///61987#ABA567#009",
            "FirmwareVersion": "0112/2///61987#ABA302#006",
        }
        for id_short, irdi in expected.items():
            element = elements.get(id_short)
            if element is None:
                continue  # Only emitted when a value exists; absence is covered elsewhere.
            keys = element.get("semanticId", {}).get("keys", [])
            self.assertTrue(keys, f"{id_short} carries no semanticId")
            self.assertEqual(keys[0]["value"], irdi, f"{id_short} carries the wrong identifier")
            self.assertEqual(element["semanticId"]["type"], "ExternalReference")

    def test_nameplate_does_not_claim_the_idta_template(self):
        """
        The submodel carries NO semanticId, and that is a deliberate refusal.

        Naming https://admin-shell.io/idta/nameplate/3/0/Nameplate would assert conformance to a
        template whose mandatory elements include AddressInformation, which this platform does not
        model. A consumer trusting the id would validate the shell against the template and fail.
        Element-level identifiers say what each property means without making that claim.
        """
        nameplate = self.submodels["DigitalNameplate"]
        self.assertNotIn(
            "semanticId", nameplate,
            "the Nameplate submodel must not claim an IDTA template it cannot fully populate",
        )

    def test_factoryplus_nameplate_properties_are_not_given_invented_identifiers(self):
        """AssetSparkplugId and friends are ours; IDTA defines nothing for them, so they carry
        nothing. An id minted under admin-shell.io for a local concept would be a forgery."""
        elements = {e["idShort"]: e for e in self.submodels["DigitalNameplate"]["submodelElements"]}
        for id_short in ("AssetSparkplugId", "ConnectionMethod", "EdgeGatewayName", "Status"):
            element = elements.get(id_short)
            if element is None:
                continue
            self.assertNotIn(
                "semanticId", element,
                f"{id_short} is a Factory+ concept and must not carry a standard identifier",
            )

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
        # Compared with the 3D model's File.value stripped: bundling deliberately rewrites that
        # one value to a package-relative path (TestVisualRepresentation asserts it is the only
        # such difference). Everything else must still match exactly.
        self.assertEqual(without_model_reference(packaged), without_model_reference(body.get("aas", {})),
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


def _storage_request(method: str, path: str, data=None, content_type=None):
    req = urllib.request.Request(f"{SUPABASE_URL}/storage/v1{path}", data=data, method=method)
    req.add_header("apikey", ANON_KEY)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    if content_type:
        req.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as err:
        return err.code, err.read()


def _patch_device(payload: dict):
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/devices?id=eq.{DEVICE_ID}",
        data=json.dumps(payload).encode(),
        method="PATCH",
    )
    req.add_header("apikey", ANON_KEY)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=20) as res:
        return res.status


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestVisualRepresentation(unittest.TestCase):
    """
    A device carrying a 3D model exports a VisualRepresentation submodel holding an AAS `File`.

    This attaches a real object to the real device and removes it again, rather than asserting
    against a fixture: the point is that Storage, the RLS policies, the column's CHECK and the
    exporter's URL composition all line up, and only an end-to-end attachment exercises that.
    Scoped to this run's own artefact and cleaned up in tearDownClass, per the discipline
    validate.py is held to.
    """

    MODEL_NAME = "test_visual_model.glb"
    # A minimal glTF binary header. Not a loadable model -- nothing here parses it -- but it makes
    # the object's bytes recognisably what they claim to be rather than arbitrary filler.
    MODEL_BYTES = b"glTF" + (2).to_bytes(4, "little") + (20).to_bytes(4, "little") + bytes(8)

    @classmethod
    def setUpClass(cls):
        cls.path = f"{DEVICE_ID}/{cls.MODEL_NAME}"
        cls.previous = None

        status, body = _storage_request(
            "POST", f"/object/{MODEL_BUCKET}/{cls.path}",
            data=cls.MODEL_BYTES, content_type="model/gltf-binary",
        )
        if status not in (200, 201):
            # x-upsert lets a leftover from an interrupted run be replaced rather than blocking it.
            #
            # THE HEADER WAS MISSING, so this fallback could never do what its comment claimed: a
            # bare PUT to a path with no object answers 400 "Object not found", and the real reason
            # the POST failed was reported as that instead. It masked a five-byte bucket limit on
            # Kubernetes for as long as this suite was unreachable.
            req = urllib.request.Request(
                f"{SUPABASE_URL}/storage/v1/object/{MODEL_BUCKET}/{cls.path}",
                data=cls.MODEL_BYTES, method="PUT",
            )
            req.add_header("apikey", ANON_KEY)
            req.add_header("Authorization", f"Bearer {TOKEN}")
            req.add_header("Content-Type", "model/gltf-binary")
            req.add_header("x-upsert", "true")
            with urllib.request.urlopen(req, timeout=30) as res:
                status = res.status
        cls.upload_status = status

        _patch_device({"model_3d_path": cls.path})

        _, cls.body, _ = post_json(
            f"{SUPABASE_URL}/functions/v1/aas-export",
            {"device_id": DEVICE_ID},
            {"apikey": ANON_KEY, "Authorization": f"Bearer {TOKEN}"},
        )

        req = urllib.request.Request(
            f"{SUPABASE_URL}/functions/v1/aas-export?format=aasx",
            data=json.dumps({"device_id": DEVICE_ID}).encode(), method="POST",
        )
        req.add_header("apikey", ANON_KEY)
        req.add_header("Authorization", f"Bearer {TOKEN}")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=60) as res:
            cls.aasx_headers = lower_headers(res.headers)
            cls.zip = zipfile.ZipFile(io.BytesIO(res.read()))

    @classmethod
    def tearDownClass(cls):
        # Detach BEFORE deleting the object, the same order the UI uses: the reverse would leave
        # the row briefly pointing at nothing, and an export in that window publishes a dead link.
        try:
            _patch_device({"model_3d_path": None})
            _storage_request("DELETE", f"/object/{MODEL_BUCKET}/{cls.path}")
        except Exception:  # pragma: no cover - cleanup must not mask a real failure
            pass

    # -- the JSON export -------------------------------------------------------------------

    def test_the_model_uploaded(self):
        self.assertIn(self.upload_status, (200, 201), "could not place the test model in Storage")

    def test_emits_a_visual_representation_submodel(self):
        shorts = [s["idShort"] for s in self.body["aas"]["submodels"]]
        self.assertIn("VisualRepresentation", shorts)

    def test_carries_a_file_element_with_the_right_media_type(self):
        submodel = next(s for s in self.body["aas"]["submodels"] if s["idShort"] == "VisualRepresentation")
        element = submodel["submodelElements"][0]
        self.assertEqual(element["modelType"], "File")
        self.assertEqual(element["contentType"], "model/gltf-binary")

    def test_the_file_id_short_is_valid_aas(self):
        # "3DModel" reads as the obvious name and is INVALID: an idShort must start with a letter.
        # Asserted directly so a regression names the cause rather than surfacing as a generic
        # schema failure, and so nobody "fixes" it back to a leading digit.
        submodel = next(s for s in self.body["aas"]["submodels"] if s["idShort"] == "VisualRepresentation")
        id_short = submodel["submodelElements"][0]["idShort"]
        self.assertEqual(id_short, "Model3D")
        self.assertRegex(id_short, ID_SHORT_RE)
        self.assertNotRegex("3DModel", ID_SHORT_RE)

    def test_every_id_short_in_the_document_is_valid(self):
        for node in TestAasExportLive.walk(self.body.get("aas", {})):
            if "idShort" in node:
                self.assertRegex(node["idShort"], ID_SHORT_RE, f"invalid idShort {node['idShort']!r}")

    def test_json_export_references_an_absolute_public_url(self):
        # The JSON form has no package to be relative to, so the value must be dereferenceable on
        # its own -- and must be built from the configured public base, not from SUPABASE_URL,
        # which inside Docker is a hostname no external consumer can resolve.
        submodel = next(s for s in self.body["aas"]["submodels"] if s["idShort"] == "VisualRepresentation")
        value = submodel["submodelElements"][0]["value"]
        self.assertTrue(value.startswith("http"), value)
        self.assertIn(MODEL_BUCKET, value)
        self.assertTrue(value.endswith(self.MODEL_NAME), value)
        self.assertNotIn("supabase-kong", value)

    def test_reports_the_model_in_stats(self):
        self.assertTrue(self.body["stats"]["has_3d_model"])

    @unittest.skipUnless(HAVE_JSONSCHEMA, "jsonschema not installed")
    def test_json_export_still_validates_against_the_official_schema(self):
        schema = json.loads(AAS_SCHEMA_PATH.read_text(encoding="utf-8"))
        errors = list(Draft201909Validator(schema).iter_errors(self.body["aas"]))
        detail = "\n".join(
            f"  {'/'.join(str(x) for x in e.absolute_path) or '<root>'}: {e.message[:180]}"
            for e in errors[:10]
        )
        self.assertEqual(len(errors), 0, f"AAS V3 schema violations:\n{detail}")

    # -- the AASX package ------------------------------------------------------------------

    def test_bundles_the_model_into_the_package(self):
        self.assertIn(f"aasx/files/{self.path}", self.zip.namelist())
        self.assertEqual(self.zip.read(f"aasx/files/{self.path}"), self.MODEL_BYTES)

    def test_declares_the_supplementary_relationship_from_the_spec_part(self):
        # A supplementary file belongs to the Environment that references it, so its relationship
        # lives in the SPEC part's rels -- not the origin's. A reader following the chain from the
        # origin would never reach it otherwise.
        self.assertIn("aasx/_rels/aasenv-root.json.rels", self.zip.namelist())
        rels = self.zip.read("aasx/_rels/aasenv-root.json.rels").decode()
        self.assertIn("aas-suppl", rels)
        self.assertIn(f"/aasx/files/{self.path}", rels)

    def test_content_types_declares_the_bundled_part(self):
        # OPC requires a media type for every part. .glb is not one of the defaults, so without an
        # Override the package is malformed.
        content_types = self.zip.read("[Content_Types].xml").decode()
        self.assertIn(f'PartName="/aasx/files/{self.path}"', content_types)
        self.assertIn('ContentType="model/gltf-binary"', content_types)

    def test_packaged_reference_is_package_relative(self):
        packaged = json.loads(self.zip.read("aasx/aasenv-root.json"))
        submodel = next(s for s in packaged["submodels"] if s["idShort"] == "VisualRepresentation")
        self.assertEqual(submodel["submodelElements"][0]["value"], f"/aasx/files/{self.path}")

    def test_the_model_reference_is_the_only_difference_from_the_json_export(self):
        # Bundling rewrites exactly one value. Asserted as a whole-document diff rather than by
        # checking that one field, so a second unintended divergence cannot slip past.
        packaged = json.loads(self.zip.read("aasx/aasenv-root.json"))

        self.assertEqual(without_model_reference(packaged), without_model_reference(self.body["aas"]))
        # And that the values really did differ, so the comparison above is not passing because
        # both sides were stripped of something that was already identical.
        packaged_value = next(
            s for s in packaged["submodels"] if s["idShort"] == "VisualRepresentation"
        )["submodelElements"][0]["value"]
        json_value = next(
            s for s in self.body["aas"]["submodels"] if s["idShort"] == "VisualRepresentation"
        )["submodelElements"][0]["value"]
        self.assertNotEqual(packaged_value, json_value)

    def test_reports_the_bundling_in_the_stats_header(self):
        stats = json.loads(self.aasx_headers.get("x-aas-stats", "{}"))
        self.assertTrue(stats.get("has_3d_model"))
        self.assertTrue(stats.get("bundled_3d_model"))

    @unittest.skipUnless(HAVE_JSONSCHEMA, "jsonschema not installed")
    def test_packaged_payload_validates_against_the_official_schema(self):
        schema = json.loads(AAS_SCHEMA_PATH.read_text(encoding="utf-8"))
        packaged = json.loads(self.zip.read("aasx/aasenv-root.json"))
        errors = list(Draft201909Validator(schema).iter_errors(packaged))
        self.assertEqual(len(errors), 0, f"{[e.message[:160] for e in errors[:5]]}")


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestNoVisualRepresentationWithoutAModel(unittest.TestCase):
    """
    A device with no model emits NO VisualRepresentation submodel.

    An empty one would assert the aspect exists and then fail to describe it -- the same rule that
    omits an unmapped `semanticId` and drops an empty collection, and the reason a blank File
    element is not emitted as a placeholder instead.
    """

    def test_absent_when_no_model_is_attached(self):
        # Detach explicitly rather than assuming the fixture's state. Test classes run in
        # alphabetical order, which puts this one before TestVisualRepresentation today -- but
        # depending on that would make the test order-fragile, and a developer who attached a
        # model through the UI would see a spurious failure here.
        _patch_device({"model_3d_path": None})

        _, body, _ = post_json(
            f"{SUPABASE_URL}/functions/v1/aas-export",
            {"device_id": DEVICE_ID},
            {"apikey": ANON_KEY, "Authorization": f"Bearer {TOKEN}"},
        )
        shorts = [s["idShort"] for s in body["aas"]["submodels"]]
        # Guards the premise: if the fixture left a model attached this test would pass vacuously.
        self.assertFalse(body["stats"]["has_3d_model"], "fixture left a 3D model attached")
        self.assertNotIn("VisualRepresentation", shorts)


if __name__ == "__main__":
    if not LIVE:
        print(f"[test_aas_export] live checks skipped: {SKIP_REASON}")
    if not HAVE_JSONSCHEMA:
        print("[test_aas_export] jsonschema not installed: official-schema validation skipped")
    unittest.main(verbosity=2)
