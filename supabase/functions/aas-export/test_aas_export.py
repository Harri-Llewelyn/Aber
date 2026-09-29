"""
Tests for the aas-export Edge Function.

Two layers, deliberately in one file:

  * Offline checks always run. They guard the Sparkplug -> XSD mapping (which is duplicated between
    Deno and the frontend bundle and would otherwise drift silently), the authorization ladder, and
    the ConceptDescriptions shell.ts builds for a fixture shell (run in Node, which strips the
    types). These need no stack, so they run in the edge-function CI job alongside the auth tests.

  * Live checks invoke the deployed function against a device the suite provisions itself
    (test-harness/aas_fixture.py) and validate the emitted document. They skip when no stack is
    reachable, so the same file is safe in both CI jobs; the e2e job is the one that actually
    exercises them.

Run:  python supabase/functions/aas-export/test_aas_export.py
"""
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
# The official IDTA metamodel schema, vendored verbatim. See test-harness/schemas/README.md for its
# provenance and how to refresh it -- it is never hand-edited.
AAS_SCHEMA_PATH = REPO_ROOT / "test-harness" / "schemas" / "AAS_V3_0_JSON_Schema.json"
TS_MAPPER = REPO_ROOT / "supabase" / "functions" / "_shared" / "aas" / "sparkplugToXsd.ts"
JS_MAPPER = REPO_ROOT / "frontend" / "src" / "utils" / "sparkplugDatatype.js"
TS_MODEL_TYPES = REPO_ROOT / "supabase" / "functions" / "_shared" / "aas" / "model3dContentType.ts"
JS_MODEL_TYPES = REPO_ROOT / "frontend" / "src" / "utils" / "model3d.js"
# The mapping layer moved to _shared/aas/shell.ts when aas-api began sharing it; this is where
# modelledMetrics() now lives, and it is still extracted and EXECUTED rather than grepped.
TS_SHELL = REPO_ROOT / "supabase" / "functions" / "_shared" / "aas" / "shell.ts"
MODELLED_METRICS_FIXTURE = REPO_ROOT / "test-harness" / "fixtures" / "modelled-metrics.json"

MODEL_BUCKET = os.getenv("STORAGE_MODEL_BUCKET", "asset-3d-models")
# The AAS metamodel's idShort pattern, transcribed from the vendored schema. Stricter than it
# looks: it must START WITH A LETTER and be at least two characters, which is why "3DModel" -- the
# obvious name for the element -- is invalid, and why prefixing it with "_" does not rescue it.
ID_SHORT_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_-]*[a-zA-Z0-9_]+$")

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
DEMO_EMAIL = os.getenv("AAS_TEST_EMAIL", "admin@aber.local")
DEMO_PASSWORD = os.getenv("AAS_TEST_PASSWORD", "aber123")
# THE SUITE PROVISIONS ITS OWN SUBJECT, and this is the point of it rather than a detail.
#
# A CONFORMANCE SUITE MUST NOT DEPEND ON SEEDED DEMONSTRATION DATA. A subject the seed stops
# creating, or stops sending a DBIRTH for, leaves the suite naming a device that is not there and
# reporting success anyway -- which is part of why archived migration 0020 exists.
#
# `AAS_TEST_DEVICE` still overrides it, and then NOTHING IS PROVISIONED -- the escape hatch for
# pointing the suite at a real asset is deliberately not also a way to half-create a fixture.
TARGET_DEVICE = os.getenv("AAS_TEST_DEVICE", "")
PROVISION_FIXTURE = not TARGET_DEVICE

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
            {"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {PUBLISHABLE_KEY}"},
        )
        return data.get("access_token") if status == 200 else None
    except Exception:
        return None


def find_device_id(token: str) -> str | None:
    req = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/devices?select=id,name&name=eq."
        + urllib.request.quote(TARGET_DEVICE)
    )
    req.add_header("apikey", PUBLISHABLE_KEY)
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            rows = json.loads(res.read() or b"[]")
            return rows[0]["id"] if rows else None
    except Exception:
        return None


sys.path.insert(0, str(REPO_ROOT / "test-harness"))
import aas_fixture  # noqa: E402  -- after sys.path, by necessity


def provision(token):
    """The fixture device's id, creating it if this run owns it. None when unreachable."""
    global TARGET_DEVICE
    if not PROVISION_FIXTURE:
        return find_device_id(token)
    try:
        device = aas_fixture.ensure(SUPABASE_URL, token, PUBLISHABLE_KEY)
    except Exception as err:  # noqa: BLE001 -- reported, never silently skipped
        print(f"[test_aas_export] could not provision the fixture: {err}")
        return None
    TARGET_DEVICE = device["name"]
    return device["id"]


TOKEN = sign_in()
DEVICE_ID = provision(TOKEN) if TOKEN else None
LIVE = TOKEN is not None and DEVICE_ID is not None
SKIP_REASON = "no reachable stack, or the AAS fixture could not be provisioned"


TS_INDEX = REPO_ROOT / "supabase" / "functions" / "aas-export" / "index.ts"
MIGRATIONS_DIR = REPO_ROOT / "supabase" / "migrations"


def export_gate() -> tuple[list, str]:
    """index.ts's ALLOWED_ROLES and BUNDLE_PERMISSION, read from its source so the mirror cannot drift."""
    text = TS_INDEX.read_text(encoding="utf-8")
    roles = re.search(r"const ALLOWED_ROLES = \[([^\]]*)\]", text)
    permission = re.search(r'const BUNDLE_PERMISSION = "([^"]+)"', text)
    if not (roles and permission):
        raise AssertionError(f"ALLOWED_ROLES or BUNDLE_PERMISSION not found in {TS_INDEX}")
    return re.findall(r'"([A-Za-z_]+)"', roles.group(1)), permission.group(1)


def seeded_role_permissions() -> dict:
    """Role name -> the permission names 0002 grants it. role_permissions is written by no one else."""
    text = (MIGRATIONS_DIR / "0002_seed_data.sql").read_text(encoding="utf-8")
    roles = dict(re.findall(r"INSERT INTO public\.roles VALUES \((\d+), '([A-Za-z_]+)'", text))
    permissions = dict(re.findall(
        r"INSERT INTO public\.permissions VALUES \('([0-9a-f-]{36})', '([a-z_:]+)'", text))
    granted = {name: set() for name in roles.values()}
    for role_id, permission_id in re.findall(
            r"INSERT INTO public\.role_permissions VALUES \((\d+), '([0-9a-f-]{36})'\)", text):
        granted[roles[role_id]].add(permissions[permission_id])
    return granted


def roles_a_policy_admits(policy: str) -> set:
    """
    The roles the latest definition of a SELECT policy admits, across the live migrations in
    filename order: those its has_role() names, and those holding a permission its has_authority()
    names.
    """
    definition = None
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith(f"CREATE POLICY {policy} ON "):
                definition = line
    if definition is None:
        raise AssertionError(f"no CREATE POLICY {policy} in {MIGRATIONS_DIR}")

    def named(fn):
        return {value for array in re.findall(fn + r"\(ARRAY\[([^\]]*)\]", definition)
                for value in re.findall(r"'([A-Za-z_:]+)'::text", array)}

    by_permission = {role for role, held in seeded_role_permissions().items()
                     if held & named("has_authority")}
    return named("has_role") | by_permission


def evaluate_aas_export_authorization(user: dict | None, auth_header: str | None,
                                      fmt: str = "json") -> tuple[int, str]:
    """
    Python mirror of the authorization ladder in index.ts, same shape as the sibling tests. The
    role list and the bundle's permission are index.ts's own; who holds the permission is the seed's.
    """
    if not auth_header:
        return 401, "Missing Authorization header"
    if not user:
        return 401, "Invalid user token"
    role = (user.get("app_metadata") or {}).get("role") or None
    # Wider than approve-quarantine on purpose: an export is a read.
    allowed, bundle_permission = export_gate()
    if not role or role not in allowed:
        return 403, "Forbidden: Insufficient privileges"
    if fmt == "bundle" and bundle_permission not in seeded_role_permissions().get(role, set()):
        return 403, "Forbidden: the bundle carries this device's Audit Trail"
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


def run_modelled_metrics(schemas: list) -> list:
    """
    Run THIS function's own `modelledMetrics()` over `schemas`, in Node, and return its answers.

    BEHAVIOURAL, NOT A grep, and the distinction earned itself here. The two parity checks above
    compare TABLES, which a regex can extract honestly. `modelledMetrics` is a RULE, and the
    divergence it carried -- `typeof [] === "object"`, so an array `properties` yielded its indices
    as metric names -- is invisible to any check that only asks whether both files mention
    `required`. The fixture is asserted by executing the code, in all four languages that
    implement it.

    THE SOURCE IS EXTRACTED FROM _shared/aas/shell.ts rather than copied here. A copy would be a fifth
    implementation, and this file would then prove that the copy agrees with the fixture.

    Only three TypeScript-only tokens appear in the function, and each is stripped explicitly
    rather than by a general-purpose type stripper: a stripper that silently failed would leave a
    syntax error, which is loud, but one that silently succeeded on the WRONG text would not be.
    """
    source = TS_SHELL.read_text(encoding="utf-8")
    match = re.search(r"^export function modelledMetrics\(.*?^\}", source, re.S | re.M)
    if not match:
        raise AssertionError(f"modelledMetrics() not found in {TS_SHELL}")

    js = match.group(0)
    for ts_only, plain in (
        (": Record<string, unknown> | null): string[]", ")"),
        ("new Set<string>()", "new Set()"),
        (" as Record<string, unknown>", ""),
    ):
        if ts_only not in js:
            raise AssertionError(
                f"expected TypeScript token {ts_only!r} in modelledMetrics(); its signature "
                "changed, so this test is no longer stripping what it thinks it is"
            )
        js = js.replace(ts_only, plain)

    harness = (
        js
        + "\nconst input = "
        + json.dumps(schemas)
        + ";\nconsole.log(JSON.stringify(input.map((s) => modelledMetrics(s ?? null))));\n"
    )
    completed = subprocess.run(
        [shutil.which("node"), "-e", harness],
        capture_output=True, text=True, timeout=60, check=True,
    )
    return json.loads(completed.stdout)


@unittest.skipIf(shutil.which("node") is None, "node is not on PATH")
class TestModelledMetricsContract(unittest.TestCase):
    """
    The FOURTH implementation of `modelledMetrics`, held to the same fixture as the other three.

    `frontend/src/utils/deviceTags.js`, `ingestion/validate.py` and `i3x/i3x_service.py` all assert
    `test-harness/fixtures/modelled-metrics.json` in their own runners. This one did not, and it was the
    only one still carrying the array-`properties` divergence the fixture was written to catch --
    for two years of `_comment` explaining the bug, in a file the bug was not checked against.

    WHY IT MATTERED MORE HERE THAN IN THE BROWSER. These names become Submodel Property idShorts in
    an exported AAS shell: a document handed to a third party, asserting metrics no device ever
    published. And `"0"` does not satisfy the AAS idShort pattern (it must begin with a letter), so
    the shell fails validation at the CONSUMER -- the exporter reports success.

    SETS ARE COMPARED, NOT SEQUENCES. This implementation returns a sorted array where the mirrors
    return a set; ordering is a rendering choice and is asserted separately below.
    """

    @classmethod
    def setUpClass(cls):
        cls.fixture = json.loads(MODELLED_METRICS_FIXTURE.read_text(encoding="utf-8"))
        cls.results = run_modelled_metrics(
            [case.get("schema_definition") for case in cls.fixture["cases"]]
        )

    def test_fixture_is_not_empty(self):
        """A contract test exercising nothing reports green while four implementations drift."""
        self.assertGreater(len(self.fixture["cases"]), 5)

    def test_every_case_matches_the_contract(self):
        for case, got in zip(self.fixture["cases"], self.results):
            with self.subTest(case=case["name"]):
                # `expected: null` means "declares neither, cannot be evaluated". The mirrors
                # return None to say so; an AAS Submodel has no way to express it and no caller
                # here distinguishes it, so it renders as no metrics. The NAMES must still agree
                # exactly -- that is the part a consumer of the shell can see.
                expected = sorted(case["expected"] or [])
                self.assertEqual(sorted(got), expected)

    def test_an_array_properties_contributes_nothing(self):
        """
        The regression itself, pinned separately from the fixture sweep so a failure names it.

        `properties: ['A','B']` must model NOTHING. Reading it as {'0','1'} is what shipped.
        """
        self.assertEqual(run_modelled_metrics([{"properties": ["A", "B"]}])[0], [])
        self.assertEqual(
            run_modelled_metrics([{"properties": ["A", "B"], "required": ["Real/METRIC"]}])[0],
            ["Real/METRIC"],
        )

    def test_the_result_is_sorted(self):
        """
        Submodel elements are emitted in this order. Sorting makes an exported shell byte-stable
        across two exports of the same device, which is what lets one be diffed against another.
        """
        got = run_modelled_metrics([{"properties": {"Zeta": {}, "Alpha": {}, "Mu": {}}}])[0]
        self.assertEqual(got, sorted(got))

    def test_no_modelled_name_is_an_array_index(self):
        """
        The regression's SIGNATURE, as a property over every case rather than one input.

        `Object.keys` on an array yields "0", "1", ... -- decimal strings, which no metric name in
        `metric_catalog` can be (0007 constrains the format) and which cannot begin an AAS idShort
        either, since the pattern requires a leading letter. So a bare integer appearing here means
        an array reached `Object.keys` again, whatever shape the schema arrived in.

        Deliberately NOT a full idShort check: the fixture's names are placeholders like "A", and
        asserting the two-character minimum against them would test the fixture, not this code.
        """
        for case, got in zip(self.fixture["cases"], self.results):
            for name in got:
                with self.subTest(case=case["name"], name=name):
                    self.assertFalse(
                        name.isdigit(),
                        f"{name!r} is an array index, not a metric name -- "
                        "an array reached Object.keys()",
                    )


# The IEC 61360 template reference AASc-3a-050 requires, and the types AASc-3a-009 requires a unit
# for. Neither rule is in the JSON schema, which is why they are asserted here.
IEC61360_TEMPLATE = "https://admin-shell.io/DataSpecificationTemplates/DataSpecificationIec61360/3"
IEC61360_NEEDS_UNIT = {
    "INTEGER_MEASURE", "REAL_MEASURE", "RATIONAL_MEASURE", "INTEGER_CURRENCY", "REAL_CURRENCY",
}


def semantic_ids(node) -> set:
    """Every GlobalReference value any `semanticId` in the document names."""
    found = set()
    if isinstance(node, dict):
        for key in (node.get("semanticId") or {}).get("keys", []):
            if key.get("type") == "GlobalReference":
                found.add(key.get("value"))
        for value in node.values():
            found |= semantic_ids(value)
    elif isinstance(node, list):
        for item in node:
            found |= semantic_ids(item)
    return found


def concept_description_problems(environment: dict) -> list:
    """
    What is wrong with an Environment's ConceptDescriptions, as sentences.

    One per semanticId the shells and submodels carry, and none for anything else (#460). Each
    carries IEC 61360 content with an English preferred name and definition (AASc-3a-002, -008),
    the template reference (-050), and a unit wherever its dataType is a measure (-009).
    """
    problems = []
    descriptions = environment.get("conceptDescriptions")
    if descriptions == []:
        problems.append("conceptDescriptions is present and empty; minItems is 1")
    descriptions = descriptions or []
    ids = [cd.get("id") for cd in descriptions]
    if len(ids) != len(set(ids)):
        problems.append(f"duplicate ConceptDescription ids: {sorted(i for i in ids if ids.count(i) > 1)}")
    referenced = semantic_ids({k: v for k, v in environment.items() if k != "conceptDescriptions"})
    if set(ids) != referenced:
        problems.append(
            f"semanticIds with no ConceptDescription: {sorted(referenced - set(ids))}; "
            f"ConceptDescriptions nothing references: {sorted(set(ids) - referenced)}"
        )
    for cd in descriptions:
        specs = cd.get("embeddedDataSpecifications") or []
        iec = [s for s in specs if (s.get("dataSpecificationContent") or {}).get("modelType")
               == "DataSpecificationIec61360"]
        if len(iec) != 1:
            problems.append(f"{cd.get('id')}: {len(iec)} IEC 61360 specifications, expected 1")
            continue
        template = [k.get("value") for k in iec[0].get("dataSpecification", {}).get("keys", [])]
        content = iec[0]["dataSpecificationContent"]
        if template != [IEC61360_TEMPLATE]:
            problems.append(f"{cd.get('id')}: data specification {template}, not the IEC 61360 template")
        for field in ("preferredName", "definition"):
            if not any(s.get("language") == "en" and s.get("text") for s in content.get(field) or []):
                problems.append(f"{cd.get('id')}: no English {field}")
        if content.get("dataType") in IEC61360_NEEDS_UNIT and not (content.get("unit") or content.get("unitId")):
            problems.append(f"{cd.get('id')}: dataType {content.get('dataType')} with no unit")
    return problems


def node_strips_types() -> bool:
    """Node 22.6 and later run TypeScript by stripping its types; earlier releases cannot."""
    node = shutil.which("node")
    if node is None:
        return False
    out = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip()
    major, minor = (int(p) for p in out.lstrip("v").split(".")[:2])
    return (major, minor) >= (22, 6)


def run_build_environment(record: dict) -> dict:
    """
    Run _shared/aas/shell.ts's own buildEnvironment() over `record`, in Node, and return its result.

    The module is imported, not extracted: Node strips the types, and `Deno.env` -- read at load for
    the AAS_* settings, all of which have defaults -- is the only Deno API it touches.
    """
    harness = (
        "globalThis.Deno = { env: { get: () => undefined } };\n"
        f"const shell = await import({json.dumps(TS_SHELL.as_uri())});\n"
        "let text = ''; for await (const chunk of process.stdin) text += chunk;\n"
        "const built = shell.buildEnvironment(JSON.parse(text));\n"
        "console.log(JSON.stringify({ environment: built.environment, stats: built.stats }));\n"
    )
    completed = subprocess.run(
        [shutil.which("node"), "--experimental-strip-types", "--input-type=module", "-e", harness],
        input=json.dumps(record), capture_output=True, text=True, timeout=60,
    )
    if completed.returncode != 0:
        raise AssertionError(f"buildEnvironment() failed in Node:\n{completed.stderr[-2000:]}")
    return json.loads(completed.stdout)


MTC = "https://aber.local/semantics/mtconnect/v2.0/DataItemType/"
ISO = "https://aber.local/semantics/iso22400/"


def metric(name, semantic_id, datatype, units=None, description=None, standard="MTConnect",
           deprecated=False):
    return {"name": name, "semantic_id": semantic_id, "datatype": datatype, "units": units,
            "description": description, "standard": standard, "deprecated": deprecated}


# One shell's rows, as loadDeviceRecord() returns them: two metrics sharing an MTConnect concept
# with different descriptions, a KPI whose deprecated predecessor shares its id, an operator's
# IRDI, a local extension an operator mapped to a concept of their own (the seed mints none), an
# unmapped metric, two nameplate elements and a schema with an id.
LOCAL_CONCEPT = "urn:example:plant:safety-interlock"
SHELL_RECORD = {
    "device": {"id": "d1", "sparkplug_id": "dev1", "name": "Mill 1", "status": "ONLINE",
               "connection_method": "MQTT / Sparkplug B"},
    "config": [{"metric_name": "SERIAL_NUMBER", "val_string": "SN-1"}],
    "links": [{"schema_id": "s1", "submodel_key": None}],
    "catalog": [
        metric("Axes/X/POSITION", MTC + "POSITION", 10, "MILLIMETER", "Linear position of the X axis"),
        metric("Axes/Y/POSITION", MTC + "POSITION", 10, "MILLIMETER", "Linear position of the Y axis"),
        metric("Controller/EXECUTION", MTC + "EXECUTION", 12, None, "Controller execution state"),
        metric("OEE/EFFECTIVENESS", ISO + "EFFECTIVENESS", 10, "PERCENT", "ISO 22400 effectiveness ratio",
               standard="ISO 22400"),
        metric("OEE/PERFORMANCE", ISO + "EFFECTIVENESS", 10, "PERCENT", "ISO 22400 performance ratio",
               standard="ISO 22400", deprecated=True),
        metric("Spindle/TORQUE", "0173-1#02-AAO677#002", 10, "NEWTON_METER", None),
        metric("safety_interlock", LOCAL_CONCEPT, 11, None, "Safety interlock present", standard=None),
        metric("Custom/UNMAPPED", None, 10, None, None, standard=None),
        metric("SERIAL_NUMBER", MTC + "SERIAL_NUMBER", 12, None, "Manufacturer serial number"),
    ],
    "gateway": None,
    "nameplate": {"manufacturer_name": "Acme"},
    "templates": [
        {"id_short": "ManufacturerName", "semantic_id": "0112/2///61987#ABA565#009",
         "description": "Legal name of the manufacturer."},
        {"id_short": "SerialNumber", "semantic_id": "0112/2///61987#ABA951#009",
         "description": "Serial number of the instance."},
    ],
    "schemas": [{
        "id": "s1", "schema_name": "Mill", "description": "Mill telemetry",
        "semantic_id": "https://example.org/submodels/Mill/1/0",
        "schema_definition": {"properties": {n: {} for n in (
            "Axes/X/POSITION", "Axes/Y/POSITION", "Controller/EXECUTION", "OEE/EFFECTIVENESS",
            "OEE/PERFORMANCE", "Spindle/TORQUE", "safety_interlock", "Custom/UNMAPPED",
        )}},
    }],
}


@unittest.skipUnless(node_strips_types(), "Node 22.6 or later is needed to run shell.ts")
class TestConceptDescriptions(unittest.TestCase):
    """
    The Environment's ConceptDescriptions, from shell.ts's own buildEnvironment() over a fixture.

    Offline, so the metamodel shape is checked without a stack; the live classes below run the
    same checks over a real export. Most semantic ids here resolve nowhere (`aber.local`, an
    operator's IRDI), so the ConceptDescription is the only place a consumer finds their meaning,
    unit and datatype (#460).
    """

    @classmethod
    def setUpClass(cls):
        built = run_build_environment(SHELL_RECORD)
        cls.environment, cls.stats = built["environment"], built["stats"]
        cls.by_id = {cd["id"]: cd for cd in cls.environment.get("conceptDescriptions", [])}

    def content(self, semantic_id):
        return self.by_id[semantic_id]["embeddedDataSpecifications"][0]["dataSpecificationContent"]

    def test_every_semantic_id_has_one_well_formed_concept_description(self):
        self.assertEqual(concept_description_problems(self.environment), [])
        self.assertEqual(self.stats["concept_descriptions"], len(self.by_id))

    @unittest.skipUnless(HAVE_JSONSCHEMA, "jsonschema not installed")
    def test_the_environment_validates_against_the_official_schema(self):
        schema = json.loads(AAS_SCHEMA_PATH.read_text(encoding="utf-8"))
        errors = list(Draft201909Validator(schema).iter_errors(self.environment))
        detail = "\n".join(
            f"  {'/'.join(str(x) for x in e.absolute_path) or '<root>'}: {e.message[:180]}"
            for e in errors[:10]
        )
        self.assertEqual(errors, [], f"AAS V3 schema violations:\n{detail}")

    def test_a_shared_concept_gets_one_description_that_names_no_instance(self):
        # Two POSITION metrics describe their own axes; neither description defines the concept.
        content = self.content(MTC + "POSITION")
        self.assertEqual(content["preferredName"], [{"language": "en", "text": "POSITION"}])
        self.assertEqual(content["definition"][0]["text"], "POSITION, as MTConnect defines it.")
        self.assertEqual((content["unit"], content["dataType"]), ("MILLIMETER", "REAL_MEASURE"))
        self.assertEqual(self.by_id[MTC + "POSITION"]["idShort"], "POSITION")

    def test_a_deprecated_metric_does_not_define_the_concept_its_successor_carries(self):
        content = self.content(ISO + "EFFECTIVENESS")
        self.assertEqual(content["definition"][0]["text"], "ISO 22400 effectiveness ratio")
        self.assertEqual(content["unit"], "PERCENT")

    def test_units_are_carried_as_the_catalog_spells_them(self):
        self.assertEqual(self.content("0173-1#02-AAO677#002")["unit"], "NEWTON_METER")

    def test_an_undescribed_irdi_is_defined_by_its_identifier_alone(self):
        # Its metric is filed under MTConnect, but the IRDI is not MTConnect's to define.
        self.assertEqual(
            self.content("0173-1#02-AAO677#002")["definition"][0]["text"],
            "The concept identified by 0173-1#02-AAO677#002.",
        )

    def test_a_value_without_a_unit_is_not_a_measure(self):
        self.assertEqual(self.content(MTC + "EXECUTION")["dataType"], "STRING")
        self.assertNotIn("unit", self.content(MTC + "EXECUTION"))
        self.assertEqual(self.content(LOCAL_CONCEPT)["dataType"], "BOOLEAN")

    def test_an_irdi_takes_its_name_from_the_metric_or_the_template(self):
        self.assertEqual(self.by_id["0173-1#02-AAO677#002"]["idShort"], "Spindle_TORQUE")
        self.assertEqual(self.by_id["0112/2///61987#ABA565#009"]["idShort"], "ManufacturerName")
        self.assertEqual(
            self.content("0112/2///61987#ABA565#009")["definition"][0]["text"],
            "Legal name of the manufacturer.",
        )

    def test_the_submodel_semantic_id_is_described_by_its_schema(self):
        content = self.content("https://example.org/submodels/Mill/1/0")
        self.assertEqual(content["definition"][0]["text"], "Mill telemetry")
        self.assertNotIn("dataType", content)

    def test_the_key_is_omitted_when_nothing_carries_a_semantic_id(self):
        bare = {**SHELL_RECORD, "catalog": [], "templates": [], "schemas": [], "links": []}
        environment = run_build_environment(bare)["environment"]
        self.assertEqual(semantic_ids(environment), set())
        self.assertNotIn("conceptDescriptions", environment)


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
            for fmt in ("json", "aasx"):
                status, _ = evaluate_aas_export_authorization(
                    {"app_metadata": {"role": role}}, "Bearer x", fmt)
                self.assertEqual(status, 200, f"{role} should be allowed to export {fmt}")

    def test_the_bundle_refuses_an_operator(self):
        # The bundle carries the device's trail, which the asset lane's policy closes to Operator.
        status, message = evaluate_aas_export_authorization(
            {"app_metadata": {"role": "Operator"}}, "Bearer x", "bundle")
        self.assertEqual(status, 403)
        self.assertIn("Audit Trail", message)

    def test_the_bundle_admits_the_roles_that_read_the_trail_and_the_exports(self):
        for role in ("Administrator", "Shopfloor_Manager", "Auditor"):
            status, _ = evaluate_aas_export_authorization(
                {"app_metadata": {"role": role}}, "Bearer x", "bundle")
            self.assertEqual(status, 200, f"{role} should be allowed to take a bundle")

    def test_the_bundle_permission_is_held_by_the_roles_both_policies_admit(self):
        """
        The function gates on one permission; the rule is the roles that may read the trail's
        asset lane AND the export records the trail repeats. A migration that grants the
        permission to another role, or narrows either policy, fails here.
        """
        _, permission = export_gate()
        holders = {role for role, held in seeded_role_permissions().items() if permission in held}
        both = (roles_a_policy_admits("audit_trail_select_asset")
                & roles_a_policy_admits("asset_exports_select_privileged"))
        self.assertEqual(holders, both)
        self.assertEqual(holders, {"Administrator", "Shopfloor_Manager", "Auditor"})

    def test_the_refusal_names_the_trail_and_comes_before_the_service_key(self):
        text = TS_INDEX.read_text(encoding="utf-8")
        gate = text.index('format === "bundle" && !(await callerHolds(supabaseUser, BUNDLE_PERMISSION))')
        self.assertIn("Audit Trail", text[gate:gate + 400])
        self.assertLess(gate, text.index("serviceRoleClient(supabaseUrl"))

    def test_the_trail_part_is_read_as_the_caller(self):
        text = TS_INDEX.read_text(encoding="utf-8")
        self.assertIn("loadTrail(supabaseUser,", text)
        self.assertNotIn("loadTrail(supabaseAdmin", text)


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestAasExportLive(unittest.TestCase):
    """Invokes the deployed function and validates the document it emits."""

    @classmethod
    def setUpClass(cls):
        cls.status, cls.body, cls.headers = post_json(
            f"{SUPABASE_URL}/functions/v1/aas-export",
            {"device_id": DEVICE_ID},
            {"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {TOKEN}"},
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
            f"{SUPABASE_URL}/functions/v1/aas-export", {"device_id": DEVICE_ID}, {"apikey": PUBLISHABLE_KEY})
        self.assertIn(status, (401, 403), "export must not be reachable without a user token")

    def test_rejects_a_non_uuid_device_id(self):
        # The device's NAME, which is a real identifier for it and still not a uuid -- the
        # plausible mistake, rather than an arbitrary bad string.
        status, _, _ = post_json(
            f"{SUPABASE_URL}/functions/v1/aas-export",
            {"device_id": TARGET_DEVICE},
            {"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {TOKEN}"},
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

        These IRDIs come from IDTA 02006-3-0-1 and are seeded by archived migration 0011; the exporter looks
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

    def test_aber_nameplate_properties_are_not_given_invented_identifiers(self):
        """AssetSparkplugId and friends are ours; IDTA defines nothing for them, so they carry
        nothing. An id minted under admin-shell.io for a local concept would be a forgery."""
        elements = {e["idShort"]: e for e in self.submodels["DigitalNameplate"]["submodelElements"]}
        for id_short in ("AssetSparkplugId", "ConnectionMethod", "EdgeGatewayName", "Status"):
            element = elements.get(id_short)
            if element is None:
                continue
            self.assertNotIn(
                "semanticId", element,
                f"{id_short} is a concept of this platform and must not carry a standard identifier",
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
            {"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {TOKEN}"},
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

    def test_every_semantic_id_has_a_concept_description(self):
        self.assertEqual(concept_description_problems(self.body.get("aas", {})), [])

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
        req.add_header("apikey", PUBLISHABLE_KEY)
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
            {"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {TOKEN}"},
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
            {"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {TOKEN}"},
        )
        self.assertEqual(status, 400)
        self.assertIn("format", str(body).lower())


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestMultiSubmodel(unittest.TestCase):
    """One AAS Submodel per schema attached through device_submodels."""

    @classmethod
    def setUpClass(cls):
        _, cls.body, _ = post_json(
            f"{SUPABASE_URL}/functions/v1/aas-export",
            {"device_id": DEVICE_ID},
            {"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {TOKEN}"},
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
    req.add_header("apikey", PUBLISHABLE_KEY)
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
    req.add_header("apikey", PUBLISHABLE_KEY)
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
            req.add_header("apikey", PUBLISHABLE_KEY)
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
            {"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {TOKEN}"},
        )

        req = urllib.request.Request(
            f"{SUPABASE_URL}/functions/v1/aas-export?format=aasx",
            data=json.dumps({"device_id": DEVICE_ID}).encode(), method="POST",
        )
        req.add_header("apikey", PUBLISHABLE_KEY)
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

    def _list_device_folder(self, token=None):
        req = urllib.request.Request(
            f"{SUPABASE_URL}/storage/v1/object/list/{MODEL_BUCKET}",
            data=json.dumps({"prefix": DEVICE_ID, "limit": 100}).encode(), method="POST",
        )
        req.add_header("apikey", PUBLISHABLE_KEY)
        req.add_header("Content-Type", "application/json")
        if token:
            req.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(req, timeout=20) as res:
                return [o.get("name") for o in json.loads(res.read())]
        except urllib.error.HTTPError:
            return []

    def test_the_model_is_readable_with_no_session_and_no_key(self):
        # The AAS contract: an exported File URL resolves for a viewer holding nothing.
        url = f"{SUPABASE_URL}/storage/v1/object/public/{MODEL_BUCKET}/{self.path}"
        with urllib.request.urlopen(url, timeout=20) as res:
            self.assertEqual(res.read(), self.MODEL_BYTES)

    def test_an_anonymous_caller_cannot_list_the_bucket(self):
        # Keys are <device_uuid>/<file>, so a public listing is a public device inventory
        # (storage-policies.sql, asset_3d_models_select_privileged).
        self.assertEqual(self._list_device_folder(), [])

    def test_the_uploader_can_list_the_bucket(self):
        # The control for the test above: the endpoint answers, so an empty list is the policy.
        self.assertIn(self.MODEL_NAME, self._list_device_folder(TOKEN))

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
        # which inside the cluster is a Service name no external consumer can resolve.
        submodel = next(s for s in self.body["aas"]["submodels"] if s["idShort"] == "VisualRepresentation")
        value = submodel["submodelElements"][0]["value"]
        self.assertTrue(value.startswith("http"), value)
        self.assertIn(MODEL_BUCKET, value)
        self.assertTrue(value.endswith(self.MODEL_NAME), value)
        self.assertNotIn("supabase-envoy", value)

    def test_reports_the_model_in_stats(self):
        self.assertTrue(self.body["stats"]["has_3d_model"])

    def test_a_loopback_model_url_is_warned_about_rather_than_shipped_silently(self):
        """
        The JSON export WARNS where the AASX export REFUSES, and the asymmetry is deliberate.

        Self-containment is the entire reason to produce an AASX, so a package whose one File
        element resolves nowhere is worse than no package. A JSON environment is a document that
        references things by URL, and one unreachable reference does not make the rest of it wrong
        -- so it is still emitted.

        WHAT WAS WRONG WAS THE SILENCE. The export succeeded, the file downloaded, and the model
        reference pointed at the exporter's own machine -- discoverable only by opening the shell
        somewhere else and finding a dead link. The person who ran the export is the one best
        placed to fix it and was the last to find out.
        """
        base = os.getenv("AAS_MODEL_PUBLIC_BASE", "")
        loopback = any(h in base for h in ("localhost", "127.0.0.1", "0.0.0.0", "[::1]"))
        if not loopback:
            self.skipTest(f"AAS_MODEL_PUBLIC_BASE is {base!r}, which is not loopback")

        warning = self.body.get("warning")
        self.assertIsNotNone(warning, "a loopback model reference was shipped with no warning")
        # It names the variable AND what to set it to: "configure the public base" is advice
        # nobody can action without knowing it means the address other machines use.
        self.assertIn("AAS_MODEL_PUBLIC_BASE", warning)


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
            {"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {TOKEN}"},
        )
        shorts = [s["idShort"] for s in body["aas"]["submodels"]]
        # Guards the premise: if the fixture left a model attached this test would pass vacuously.
        self.assertFalse(body["stats"]["has_3d_model"], "fixture left a 3D model attached")
        self.assertNotIn("VisualRepresentation", shorts)

        # AND NO LOOPBACK WARNING EITHER. That warning fires on the URL actually emitted, not on
        # configuration in the abstract -- a shell with no VisualRepresentation has no reference
        # that could be unreachable. Without this, an unset AAS_MODEL_PUBLIC_BASE would warn on
        # every export from every device on the stack, which is how a real warning gets ignored.
        self.assertIsNone(body.get("warning"), body.get("warning"))


# ---- The bundle: the AASX with its history inside ------------------------------------------------
TS_BUNDLE = REPO_ROOT / "supabase" / "functions" / "_shared" / "aas" / "bundle.ts"


def run_bundle_helpers(script: str) -> dict:
    """
    Execute the pure half of _shared/aas/bundle.ts in Node and return what `script` prints.

    EXECUTED, NOT GREPPED, for the reason run_modelled_metrics() gives. The pure functions sit
    before the loaders in that file by design (its header says so), so the harness takes the text
    from the first constant up to the first loader's interface, plus buildBundleManifest() and the
    interface it reads, and runs it with Node's own type stripping. Every type in that half is
    erasable syntax -- interfaces, annotations, `as const` -- which is what the flag strips; an
    `enum` or a parameter property would fail loudly here rather than silently pass.

    `script` runs after the module's own text and must print ONE JSON document.
    """
    source = TS_BUNDLE.read_text(encoding="utf-8")
    pure_start = source.index("export const BUNDLE_SCHEMA")
    pure_end = source.index("export interface TelemetryPart")
    manifest = re.search(
        r"^export interface ManifestInput \{.*?^export function buildBundleManifest\(.*?^\}",
        source, re.S | re.M,
    )
    if not manifest:
        raise AssertionError(f"buildBundleManifest() not found in {TS_BUNDLE}")
    harness = source[pure_start:pure_end] + "\n" + manifest.group(0) + "\n" + script + "\n"

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "bundle_harness.ts"
        path.write_text(harness, encoding="utf-8")
        completed = subprocess.run(
            [shutil.which("node"), "--experimental-strip-types", str(path)],
            capture_output=True, text=True, timeout=60, check=True,
        )
    return json.loads(completed.stdout)


def run_trail_loader() -> list:
    """
    Run bundle.ts's own loadTrail() in Node against a client that records every call made on it,
    and return those calls. The query is what decides which rows the part can hold.
    """
    source = TS_BUNDLE.read_text(encoding="utf-8")
    loader = re.search(r"^export async function loadTrail\(.*?^\}", source, re.S | re.M)
    if not loader:
        raise AssertionError(f"loadTrail() not found in {TS_BUNDLE}")
    harness = loader.group(0) + """
const calls = [];
const query = new Proxy({}, { get: (_, name) => (...args) => {
  calls.push([name, ...args]);
  return name === "limit" ? Promise.resolve({ data: [], error: null }) : query;
} });
const client = { from: (table) => { calls.push(["from", table]); return query; } };
loadTrail(client, "dev-1", 5).then(() => console.log(JSON.stringify(calls)));
"""
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "trail_harness.ts"
        path.write_text(harness, encoding="utf-8")
        completed = subprocess.run(
            [shutil.which("node"), "--experimental-strip-types", str(path)],
            capture_output=True, text=True, timeout=60, check=True,
        )
    return json.loads(completed.stdout)


@unittest.skipIf(shutil.which("node") is None, "node is not on PATH")
class TestBundleHelpers(unittest.TestCase):
    """The pure functions the bundle is assembled from, run against fixed inputs."""

    @classmethod
    def setUpClass(cls):
        cls.out = run_bundle_helpers("""
const rows = [
  { time: "2026-09-01T10:00:00Z", metric_name: "Spindle/Speed", val_double: 1200.5, val_string: null, val_bool: null },
  { time: "2026-09-01T10:00:01Z", metric_name: "Job,Name", val_double: null, val_string: 'say "hi"', val_bool: null },
  { time: "2026-09-01T10:00:02Z", metric_name: "Note", val_double: null, val_string: "two\\nlines", val_bool: true },
];
const part = (n, oldest, newest, extra = {}) => ({ rows: Array.from({ length: n }, (_, i) => ({ i })), oldest, newest, truncated: false, ...extra });
const base = {
  takenAt: "2026-09-19T10:00:00.000Z",
  takenBy: { id: "user-1", email: "ops@example.test" },
  device: { id: "dev-1", name: "CNC_01", sparkplug_id: "abc123", created_at: "2026-01-01T00:00:00Z", is_archived: true, archived_at: "2026-09-01T00:00:00Z", model_3d_path: null },
  gateway: { name: "Line_A", sparkplug_id: "gw1" },
  caps: { telemetry: 3, trail: 2 },
  raw: part(2, "2026-09-01T10:00:00Z", "2026-09-01T10:00:01Z"),
  hourly: part(1, "2026-09-01T10:00:00Z", "2026-09-01T10:00:00Z"),
  trail: { rows: [{ id: 1 }], truncated: false },
  horizons: { telemetry: "2026-08-01T00:00:00Z", telemetry_1h: null },
  cold: { objects: [{ object_key: "2026/08/telemetry-x.parquet" }], unavailable: null },
  bundled3dModel: false,
};
const capped = {
  ...base,
  raw: part(3, "2026-09-01T10:00:00Z", "2026-09-01T10:00:02Z", { truncated: true }),
  trail: { rows: [{ id: 1 }, { id: 2 }], truncated: true },
  cold: { objects: [], unavailable: "cold_storage_rows refused: permission denied" },
  device: { ...base.device, model_3d_path: "models/x.glb" },
};
console.log(JSON.stringify({
  csv: csvOf(rows, RAW_COLUMNS),
  empty_csv: csvOf([], HOURLY_COLUMNS),
  coverage_full: describeCoverage(2, 3, "a", "b", "h"),
  coverage_cut: describeCoverage(3, 3, "a", "b", null),
  coverage_unknown: describeCoverage(0, 3, null, null, undefined),
  key: exportObjectKey("abc123", "2026-09-19T10:00:00.000Z"),
  bounded: [boundedInt(undefined, 7), boundedInt("0", 7), boundedInt("12", 7), boundedInt("abc", 7), boundedInt("-3", 7)],
  parts: BUNDLE_PARTS,
  schema: BUNDLE_SCHEMA,
  manifest: buildBundleManifest(base),
  manifest_capped: buildBundleManifest(capped),
}));
""")

    # -- csvOf: RFC 4180, so the part opens in anything ----------------------------------------
    def test_csv_quotes_only_what_needs_quoting_and_ends_lines_with_crlf(self):
        lines = self.out["csv"].split("\r\n")
        self.assertEqual(lines[0], "time,metric_name,val_double,val_string,val_bool")
        self.assertEqual(lines[1], "2026-09-01T10:00:00Z,Spindle/Speed,1200.5,,")
        # A comma in a value, and a doubled quote inside a quoted one.
        self.assertEqual(lines[2], '2026-09-01T10:00:01Z,"Job,Name",,"say ""hi""",')
        # A bare LF inside a value stays inside its quotes, so it is not a record boundary; the
        # record still ends with CRLF, which is why splitting on CRLF leaves one trailing empty line.
        self.assertEqual(lines[3], '2026-09-01T10:00:02Z,Note,,"two\nlines",true')
        self.assertEqual(lines[4:], [""], "every record, the last included, ends with CRLF")

    def test_an_empty_relation_is_a_header_alone(self):
        # The rollup's own columns (timescaledb/aggregates.sql), less asset_id, which the manifest
        # states once; a column named here that the view lacks fails the whole bundle with a 500.
        self.assertEqual(self.out["empty_csv"], ",".join([
            "bucket", "metric_name", "avg_double", "min_double", "max_double",
            "last_double", "last_string", "last_bool", "n_double", "n_rows",
        ]) + "\r\n")

    # -- describeCoverage: the three-valued horizon and the cap ---------------------------------
    def test_coverage_says_when_it_was_cut_and_when_it_was_not(self):
        full, cut = self.out["coverage_full"], self.out["coverage_cut"]
        self.assertFalse(full["truncated"])
        self.assertIn("Every row", full["note"])
        self.assertTrue(cut["truncated"])
        self.assertIn("Cut at 3 rows", cut["note"])
        self.assertIn("older than a", cut["note"])

    def test_coverage_tells_an_unanswered_horizon_from_an_empty_relation(self):
        # undefined is "the lookup did not answer"; null is "the relation is empty". The dialog on
        # the Devices page acts on the same distinction (0111).
        self.assertEqual(self.out["coverage_unknown"]["relation_reaches_back_to"], "unknown")
        self.assertIsNone(self.out["coverage_cut"]["relation_reaches_back_to"])
        self.assertEqual(self.out["coverage_full"]["relation_reaches_back_to"], "h")

    # -- exportObjectKey and boundedInt -----------------------------------------------------------
    def test_object_key_sits_under_the_asset_prefix_with_a_filename_safe_stamp(self):
        self.assertEqual(self.out["key"], "assets/abc123/2026-09-19T10-00-00-000Z.aasx")

    def test_a_cap_from_the_environment_is_a_positive_integer_or_the_fallback(self):
        self.assertEqual(self.out["bounded"], [7, 7, 12, 7, 7])

    # -- buildBundleManifest ----------------------------------------------------------------------
    def test_manifest_names_its_schema_and_every_part_under_the_supplement_directory(self):
        m = self.out["manifest"]
        self.assertEqual(m["schema"], "aber/asset-bundle/1")
        self.assertEqual(m["schema"], self.out["schema"])
        for name, path in self.out["parts"].items():
            self.assertTrue(path.startswith("aasx/files/aber/"), f"{name}: {path}")
        self.assertEqual(m["parts"]["environment"], "aasx/aasenv-root.json")
        self.assertEqual(m["parts"]["audit_trail"], self.out["parts"]["trail"])
        self.assertEqual(m["parts"]["telemetry_raw"], self.out["parts"]["raw"])
        self.assertEqual(m["parts"]["telemetry_1h"], self.out["parts"]["hourly"])

    def test_manifest_states_the_historian_key_and_the_coverage_of_each_telemetry_part(self):
        m = self.out["manifest"]
        self.assertEqual(m["telemetry"]["asset_id"], "abc123")
        self.assertEqual(m["telemetry"]["raw"]["rows"], 2)
        self.assertEqual(m["telemetry"]["raw"]["relation_reaches_back_to"], "2026-08-01T00:00:00Z")
        self.assertIsNone(m["telemetry"]["hourly"]["relation_reaches_back_to"])
        self.assertEqual(m["audit_trail"], {"rows": 1, "cap": 2, "truncated": False})
        self.assertEqual(m["device"]["gateway"], {"name": "Line_A", "sparkplug_id": "gw1"})
        self.assertEqual(m["taken_by"], {"id": "user-1", "email": "ops@example.test"})

    def test_manifest_names_the_cold_objects_and_never_claims_to_hold_them(self):
        # The no-read-back rule of the cold tier, restated in the one document a reader of the
        # bundle will open: the objects are listed, and a sentence says they were not read back.
        m = self.out["manifest"]
        self.assertEqual(m["cold_objects"], [{"object_key": "2026/08/telemetry-x.parquet"}])
        self.assertTrue(any("never read back" in s for s in m["not_included"]), m["not_included"])
        self.assertTrue(any("1-minute and 5-minute" in s for s in m["not_included"]))

    def test_an_uncut_bundle_lists_only_the_two_standing_exclusions(self):
        # The rollups and the cold objects are always stated; nothing else is, or every manifest
        # would carry warnings that mean nothing.
        self.assertEqual(len(self.out["manifest"]["not_included"]), 2, self.out["manifest"]["not_included"])

    def test_every_cap_that_was_hit_is_a_sentence_rather_than_a_silent_tail(self):
        m = self.out["manifest_capped"]
        sentences = m["not_included"]
        self.assertTrue(any(s.startswith("raw telemetry older than 2026-09-01T10:00:00Z") and "cap of 3 rows" in s for s in sentences), sentences)
        self.assertTrue(any(s.startswith("audit trail rows after the first 2") for s in sentences), sentences)
        self.assertTrue(any(s.startswith("the cold catalogue: cold_storage_rows refused") for s in sentences), sentences)
        self.assertTrue(any(s.startswith("the 3D model: not bundled") for s in sentences), sentences)
        self.assertTrue(m["telemetry"]["raw"]["truncated"])
        self.assertFalse(m["telemetry"]["hourly"]["truncated"])

    # -- loadTrail: the asset lane of one device, whoever asks ----------------------------------
    def test_the_trail_loader_asks_for_the_asset_lane_only(self):
        # An Administrator or an Auditor may read the security lane too; the part never holds it.
        calls = run_trail_loader()
        self.assertEqual(calls[0], ["from", "audit_trail"])
        filters = [c[1:] for c in calls if c[0] == "eq"]
        self.assertIn(["entity_id", "dev-1"], filters)
        self.assertIn(["audit_domain", "asset"], filters)


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestAssetBundle(unittest.TestCase):
    """
    `format=bundle` against the deployed function: the same AASX with the four supplementary parts,
    a stored copy in the cold tier's bucket, and a row in `asset_exports`.

    The stored object is deleted on teardown, as the Administrator the suite signs in as (the
    bucket's delete policy admits that role alone). The `asset_exports` row cannot be: the table has
    no write policy for any role, by design, so a run leaves one row that names a device the fixture
    then deletes -- which is precisely the state the Archived Entities page's second card exists to
    show, and is harmless on the ephemeral stacks this class runs against.
    """

    @classmethod
    def setUpClass(cls):
        req = urllib.request.Request(
            f"{SUPABASE_URL}/functions/v1/aas-export?format=bundle",
            data=json.dumps({"device_id": DEVICE_ID}).encode(),
            method="POST",
        )
        req.add_header("apikey", PUBLISHABLE_KEY)
        req.add_header("Authorization", f"Bearer {TOKEN}")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=120) as res:
            cls.status = res.status
            cls.headers = lower_headers(res.headers)
            cls.payload = res.read()
        cls.zip = zipfile.ZipFile(io.BytesIO(cls.payload))
        cls.stats = json.loads(cls.headers.get("x-aas-stats", "{}"))
        cls.bundle = cls.stats.get("bundle", {})

    @classmethod
    def tearDownClass(cls):
        key = cls.bundle.get("object_key")
        bucket = cls.bundle.get("bucket")
        if not (cls.bundle.get("stored") and key and bucket):
            return
        req = urllib.request.Request(f"{SUPABASE_URL}/storage/v1/object/{bucket}/{key}", method="DELETE")
        req.add_header("apikey", PUBLISHABLE_KEY)
        req.add_header("Authorization", f"Bearer {TOKEN}")
        try:
            urllib.request.urlopen(req, timeout=30).read()
        except urllib.error.URLError as err:  # pragma: no cover - reported, never silently skipped
            print(f"[test_aas_export] bundle object {key} not removed: {err}")

    def rest_get(self, path: str):
        req = urllib.request.Request(f"{SUPABASE_URL}/rest/v1{path}")
        req.add_header("apikey", PUBLISHABLE_KEY)
        req.add_header("Authorization", f"Bearer {TOKEN}")
        with urllib.request.urlopen(req, timeout=30) as res:
            return json.loads(res.read())

    def manifest(self) -> dict:
        return json.loads(self.zip.read("aasx/files/aber/manifest.json"))

    def test_is_still_an_aasx_with_a_bundle_filename(self):
        self.assertEqual(self.status, 200)
        self.assertIn("asset-administration-shell-package", self.headers.get("content-type", ""))
        self.assertIn("-bundle.aasx", self.headers.get("content-disposition", ""))
        self.assertIsNone(self.zip.testzip(), "corrupt archive")
        # The OPC chain the plain package carries, untouched by the supplements.
        for part in ("_rels/.rels", "aasx/aasx-origin", "aasx/_rels/aasx-origin.rels", "aasx/aasenv-root.json"):
            self.assertIn(part, self.zip.namelist())

    def test_carries_the_four_supplementary_parts(self):
        names = self.zip.namelist()
        for part in (
            "aasx/files/aber/manifest.json",
            "aasx/files/aber/audit-trail.json",
            "aasx/files/aber/telemetry-raw.csv",
            "aasx/files/aber/telemetry-1h.csv",
        ):
            self.assertIn(part, names)

    def test_manifest_describes_this_device_and_agrees_with_the_parts(self):
        m = self.manifest()
        self.assertEqual(m["schema"], "aber/asset-bundle/1")
        self.assertEqual(m["device"]["id"], DEVICE_ID)
        self.assertEqual(m["telemetry"]["asset_id"], m["device"]["sparkplug_id"])
        trail = json.loads(self.zip.read("aasx/files/aber/audit-trail.json"))
        self.assertIsInstance(trail, list)
        self.assertEqual(m["audit_trail"]["rows"], len(trail))
        # A CSV part's rows are its lines less the header; both parts are oldest-first.
        raw_lines = self.zip.read("aasx/files/aber/telemetry-raw.csv").decode().split("\r\n")
        self.assertEqual(raw_lines[0], "time,metric_name,val_double,val_string,val_bool")
        self.assertEqual(m["telemetry"]["raw"]["rows"], len([line for line in raw_lines[1:] if line]))
        # The hourly header is the rollup's own columns: the first live run of this class found a
        # column the view does not have, and PostgREST fails the whole request for one.
        hourly_lines = self.zip.read("aasx/files/aber/telemetry-1h.csv").decode().split("\r\n")
        self.assertEqual(hourly_lines[0], "bucket,metric_name,avg_double,min_double,max_double,last_double,last_string,last_bool,n_double,n_rows")
        self.assertEqual(m["telemetry"]["hourly"]["rows"], len([line for line in hourly_lines[1:] if line]))
        # The fixture just arrived: nothing has been read from it, so the fixture also proves the
        # two standing exclusions are stated on an otherwise empty bundle.
        self.assertTrue(any("never read back" in s for s in m["not_included"]))

    def test_the_trail_part_holds_the_fixture_s_own_creation(self):
        # The fixture INSERTed the device through PostgREST, which the audit trigger recorded, so
        # the part is never empty for a device that exists at all.
        trail = json.loads(self.zip.read("aasx/files/aber/audit-trail.json"))
        self.assertTrue(any(row.get("entity_id") == DEVICE_ID for row in trail), trail[:3])

    def test_reports_the_stored_copy_in_the_stats_header(self):
        self.assertIn("bundle", self.stats, self.stats)
        b = self.bundle
        for key in ("raw_rows", "hourly_rows", "trail_rows", "cold_objects", "truncated", "stored", "bucket", "object_key", "taken_at"):
            self.assertIn(key, b, b)
        self.assertTrue(b["stored"], f"the bundle was not stored: {b.get('reason')}")
        self.assertTrue(b["object_key"].startswith("assets/"), b["object_key"])
        self.assertEqual(b["sha256"], hashlib.sha256(self.payload).hexdigest())

    def test_records_the_export_where_a_tombstone_can_find_it(self):
        rows = self.rest_get(f"/asset_exports?entity_id=eq.{DEVICE_ID}&select=entity_type,object_bucket,object_key,sha256,format,stats")
        match = [r for r in rows if r["object_key"] == self.bundle["object_key"]]
        self.assertEqual(len(match), 1, rows)
        row = match[0]
        self.assertEqual(row["entity_type"], "devices")
        self.assertEqual(row["format"], "aasx")
        self.assertEqual(row["object_bucket"], self.bundle["bucket"])
        self.assertEqual(row["sha256"], self.bundle["sha256"])
        self.assertEqual(row["stats"]["raw_rows"], self.bundle["raw_rows"])

    def test_the_export_is_on_the_audit_trail(self):
        rows = self.rest_get(f"/audit_trail?entity_id=eq.{DEVICE_ID}&action=eq.EXPORTED&select=action,entity_type,new_data")
        self.assertTrue(rows, "no EXPORTED row for the device")
        self.assertTrue(any((r.get("new_data") or {}).get("object_key") == self.bundle["object_key"] for r in rows), rows)

    def test_the_trail_part_holds_the_asset_lane_only(self):
        # Taken as an Administrator, who may read the security lane as well.
        trail = json.loads(self.zip.read("aasx/files/aber/audit-trail.json"))
        self.assertEqual({row.get("audit_domain") for row in trail}, {"asset"})


DEMO_PASSWORD_FOR_ROLES = os.getenv("ABER_DEMO_PASSWORD", DEMO_PASSWORD)


def sign_in_as(email: str) -> str | None:
    try:
        status, data, _ = post_json(
            f"{SUPABASE_URL}/auth/v1/token?grant_type=password",
            {"email": email, "password": DEMO_PASSWORD_FOR_ROLES},
            {"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {PUBLISHABLE_KEY}"},
        )
        return data.get("access_token") if status == 200 else None
    except Exception:
        return None


def take_bundle(token: str) -> tuple[int, bytes, dict]:
    req = urllib.request.Request(
        f"{SUPABASE_URL}/functions/v1/aas-export?format=bundle",
        data=json.dumps({"device_id": DEVICE_ID}).encode(), method="POST",
    )
    for key, value in {"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {token}",
                       "Content-Type": "application/json"}.items():
        req.add_header(key, value)
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            return res.status, res.read(), lower_headers(res.headers)
    except urllib.error.HTTPError as err:
        return err.code, err.read(), lower_headers(err.headers)


@unittest.skipUnless(LIVE, SKIP_REASON)
class TestAssetBundleByRole(unittest.TestCase):
    """
    The bundle is for the roles that may read what it holds. A Shopfloor_Manager takes one whose
    trail is the asset lane; an Operator is refused the bundle and still gets the shell. Signs in
    as the seeded demo accounts, and skips where they do not exist.
    """

    @classmethod
    def setUpClass(cls):
        cls.manager = sign_in_as("manager@aber.local")
        cls.operator = sign_in_as("operator@aber.local")
        if not (cls.manager and cls.operator):
            raise unittest.SkipTest("the seeded manager and operator accounts could not sign in")
        cls.status, cls.payload, cls.headers = take_bundle(cls.manager)
        cls.bundle = json.loads(cls.headers.get("x-aas-stats", "{}")).get("bundle", {})

    @classmethod
    def tearDownClass(cls):
        # As the Administrator: the bucket's delete policy admits that role alone.
        key, bucket = cls.bundle.get("object_key"), cls.bundle.get("bucket")
        if not (cls.bundle.get("stored") and key and bucket):
            return
        req = urllib.request.Request(f"{SUPABASE_URL}/storage/v1/object/{bucket}/{key}", method="DELETE")
        req.add_header("apikey", PUBLISHABLE_KEY)
        req.add_header("Authorization", f"Bearer {TOKEN}")
        try:
            urllib.request.urlopen(req, timeout=30).read()
        except urllib.error.URLError as err:  # pragma: no cover - reported, never silently skipped
            print(f"[test_aas_export] bundle object {key} not removed: {err}")

    def test_a_shopfloor_manager_takes_a_bundle_of_the_asset_lane(self):
        self.assertEqual(self.status, 200, self.payload[:300])
        trail = json.loads(zipfile.ZipFile(io.BytesIO(self.payload)).read("aasx/files/aber/audit-trail.json"))
        self.assertTrue(trail, "the fixture's own creation is on the trail")
        self.assertEqual({row.get("audit_domain") for row in trail}, {"asset"})

    def test_an_operator_is_refused_the_bundle_with_a_reason(self):
        status, body, _ = take_bundle(self.operator)
        self.assertEqual(status, 403, body[:300])
        self.assertIn("Audit Trail", json.loads(body).get("error", ""))

    def test_an_operator_still_takes_the_shell(self):
        status, body, _ = post_json(
            f"{SUPABASE_URL}/functions/v1/aas-export", {"device_id": DEVICE_ID},
            {"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {self.operator}"},
        )
        self.assertEqual(status, 200, body)


if __name__ == "__main__":
    if not LIVE:
        print(f"[test_aas_export] live checks skipped: {SKIP_REASON}")
    if not HAVE_JSONSCHEMA:
        print("[test_aas_export] jsonschema not installed: official-schema validation skipped")
    # Teardown AFTER the report, so a failing run still leaves its console output intact -- and
    # only when this run created the subject, or the AAS_TEST_DEVICE escape hatch would delete
    # somebody's real asset. `exit=False` keeps the teardown reachable, so the exit status is
    # set here from the result; the runner reads nothing else.
    result = None
    try:
        result = unittest.main(verbosity=2, exit=False).result
    finally:
        if LIVE and PROVISION_FIXTURE:
            aas_fixture.teardown(SUPABASE_URL, TOKEN, PUBLISHABLE_KEY)
    sys.exit(0 if result is not None and result.wasSuccessful() else 1)
