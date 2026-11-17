# suite:
#   lanes: unit, stack
#   why: An AASX package can carry its Environment as XML (?format=aasx&serialization=xml), and a bundle
#     is an AASX too. Offline: the XML the writer makes for the Environment the exporter builds is
#     well-formed, in the IDTA namespace, names only elements the vendored XSD defines, and says what the
#     JSON says; the function's source names the two serialisations, the part and the media type, and
#     refuses a value it does not know. Live: the package's relationship chain reaches the XML part,
#     JSON stays the default and unchanged, an unknown value or XML with format=json is a 400 that says
#     what is allowed, and a bundle takes the option too. A package that names one part and holds
#     another is a file no AAS tool opens, and nothing else here would notice.

"""
An AASX package can carry its Environment as XML.

Offline, the writer (_shared/aas/environmentXml.ts) runs in Node over the Environment buildEnvironment()
makes, and the XML is read by a small tree reader below: the standard library's XML parsers are not used,
which the source scan refuses without defusedxml, and the writer's output has no attributes but the
namespace, no comments and no CDATA. It is not validated against the XSD here: no XSD validator is
installed. The Deno test of the writer checks its output against the vendored XSD's sequences and
enumerations, and that is the closest check there is.

Run:  python supabase/functions/aas-export/test_an_aasx_can_carry_its_environment_as_xml.py
"""
import html
import http.client
import io
import json
import os
import re
import shutil
import subprocess
import sys
import unittest
import urllib.parse
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
INDEX = REPO_ROOT / "supabase" / "functions" / "aas-export" / "index.ts"
SHELL = REPO_ROOT / "supabase" / "functions" / "_shared" / "aas" / "shell.ts"
WRITER = REPO_ROOT / "supabase" / "functions" / "_shared" / "aas" / "environmentXml.ts"
XSD = REPO_ROOT / "test-harness" / "schemas" / "AAS_V3_0_XML_Schema.xsd"

NS = "https://admin-shell.io/aas/3/2"
REL = "http://admin-shell.io/aasx/relationships/aas-spec"

SUPABASE_URL = os.getenv("SUPABASE_URL", "http://127.0.0.1:54321")
PUBLISHABLE_KEY = os.getenv("SUPABASE_PUBLISHABLE_KEY", "")
DEMO_EMAIL = os.getenv("AAS_TEST_EMAIL", "admin@aber.local")
DEMO_PASSWORD = os.getenv("AAS_TEST_PASSWORD", "aber123")
EXPORT = f"{SUPABASE_URL}/functions/v1/aas-export"

sys.path.insert(0, str(REPO_ROOT / "test-harness"))
import aas_fixture  # noqa: E402
import stack_sign_in  # noqa: E402


class Node:
    """One element: its name, its attributes, its text and its children."""

    def __init__(self, tag, attrs):
        self.tag, self.attrs, self.text, self.children = tag, attrs, "", []

    def iter(self, tag=None):
        if tag is None or self.tag == tag:
            yield self
        for child in self.children:
            yield from child.iter(tag)

    def find(self, tag):
        return next((c for c in self.children if c.tag == tag), None)


TOKEN_RE = re.compile(r'<\?[\s\S]*?\?>|</([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=]+="[^"]*")*)\s*(/?)>|([^<]+)')


def parse(source):
    """The document's root element. A tag that closes the wrong element raises."""
    top = Node("#document", {})
    stack = [top]
    for match in TOKEN_RE.finditer(source):
        closing, opening, attrs, selfclosed, text = match.groups()
        if closing is not None:
            if stack[-1].tag != closing:
                raise AssertionError(f"</{closing}> closes <{stack[-1].tag}>")
            stack.pop()
        elif opening is not None:
            node = Node(opening, dict(re.findall(r'([^\s=]+)="([^"]*)"', attrs)))
            stack[-1].children.append(node)
            if not selfclosed:
                stack.append(node)
        elif text is not None:
            stack[-1].text += html.unescape(text)
    if len(stack) != 1:
        raise AssertionError(f"<{stack[-1].tag}> is never closed")
    return top.children[0]


def relationships(xml_text):
    """(Type, Target) of each Relationship in an OPC .rels part."""
    return [(r.attrs.get("Type"), r.attrs.get("Target")) for r in parse(xml_text).iter("Relationship")]


def node_strips_types() -> bool:
    node = shutil.which("node")
    if node is None:
        return False
    out = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip()
    major, minor = (int(p) for p in out.lstrip("v").split(".")[:2])
    return (major, minor) >= (22, 6)


RECORD = {
    "device": {"id": "d1", "sparkplug_id": "dev1", "name": "Mill 1", "last_birth_metrics": []},
    "config": [{"metric_name": "SERIAL_NUMBER", "val_string": "SN-1"}],
    "links": [{"schema_id": "s1", "submodel_key": None}],
    "catalog": [
        {"name": "Axes/X/POSITION", "semantic_id": "https://aber.local/semantics/mtconnect/v2.0/DataItemType/POSITION",
         "datatype": 10, "units": "MILLIMETER", "description": "Linear position <X> & more", "standard": "MTConnect",
         "deprecated": False},
        {"name": "OEE/AVAILABILITY", "semantic_id": "https://aber.local/semantics/iso22400/AVAILABILITY",
         "datatype": 10, "units": None, "description": None, "standard": "ISO 22400", "deprecated": False},
    ],
    "gateway": {"name": "Cell gateway", "sparkplug_id": "gwy1"},
    "nameplate": {"manufacturer_name": "Acme & Sons"},
    "templates": [],
    "schemas": [{"id": "s1", "schema_name": "Mill_Schema", "semantic_id": "https://example.org/submodels/Mill/1/0",
                 "schema_definition": {"properties": {"Axes/X/POSITION": {}, "OEE/AVAILABILITY": {}}}}],
    "definitions": [],
}


def run_writer(record: dict) -> dict:
    """buildEnvironment() and environmentToXml() themselves, in Node, over `record`."""
    harness = (
        "globalThis.Deno = { env: { get: () => undefined } };\n"
        f"const shell = await import({json.dumps(SHELL.as_uri())});\n"
        f"const writer = await import({json.dumps(WRITER.as_uri())});\n"
        "let text = ''; for await (const chunk of process.stdin) text += chunk;\n"
        "const built = shell.buildEnvironment(JSON.parse(text));\n"
        "console.log(JSON.stringify({ environment: built.environment, xml: writer.environmentToXml(built.environment) }));\n"
    )
    done = subprocess.run(
        [shutil.which("node"), "--experimental-strip-types", "--input-type=module", "-e", harness],
        input=json.dumps(record), capture_output=True, text=True, timeout=60,
    )
    if done.returncode != 0:
        raise AssertionError(f"the XML writer failed in Node:\n{done.stderr[-2000:]}")
    return json.loads(done.stdout)


@unittest.skipUnless(node_strips_types(), "Node 22.6 or later runs TypeScript; this host's does not")
class TestTheWriter(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.built = run_writer(RECORD)
        cls.root = parse(cls.built["xml"])
        cls.defined = set(re.findall(r'<xs:element name="([A-Za-z0-9_]+)"', XSD.read_text(encoding="utf-8")))

    def test_it_is_well_formed_in_the_idta_namespace(self):
        self.assertEqual(self.root.tag, "environment")
        self.assertEqual(self.root.attrs, {"xmlns": NS})
        self.assertTrue(self.built["xml"].startswith('<?xml version="1.0" encoding="UTF-8"?>\n'))

    def test_every_element_is_one_the_vendored_xsd_defines(self):
        used = {e.tag for e in self.root.iter()}
        self.assertEqual(sorted(used - self.defined), [])
        # The namespace is declared once, on the root, and every element below inherits it: the
        # schema's elementFormDefault is qualified.
        self.assertTrue(all(not e.attrs for e in self.root.iter() if e is not self.root))

    def test_it_says_what_the_json_says(self):
        def texts(name):
            return sorted(e.text for e in self.root.iter(name) if e.text.strip())

        env = self.built["environment"]
        ids = sorted([s["id"] for s in env["submodels"]] + [s["id"] for s in env["assetAdministrationShells"]]
                     + [c["id"] for c in env.get("conceptDescriptions", [])])
        self.assertEqual(texts("id"), ids)
        self.assertEqual(texts("idShort"), sorted(self.find_all(env, "idShort")))
        self.assertEqual(texts("globalAssetId"), [env["assetAdministrationShells"][0]["assetInformation"]["globalAssetId"]])

    @staticmethod
    def find_all(node, key):
        found = []
        if isinstance(node, dict):
            for k, v in node.items():
                if k == key and isinstance(v, str):
                    found.append(v)
                else:
                    found.extend(TestTheWriter.find_all(v, key))
        elif isinstance(node, list):
            for v in node:
                found.extend(TestTheWriter.find_all(v, key))
        return found

    def test_text_that_looks_like_markup_is_data(self):
        descriptions = [e.text for e in self.root.iter("text")]
        self.assertIn("Linear position <X> & more", descriptions)
        manufacturer = [p.find("value").text for p in self.root.iter("property")
                        if p.find("idShort") is not None and p.find("idShort").text == "ManufacturerName"]
        self.assertEqual(manufacturer, ["Acme & Sons"])
        # On the wire it is escaped, so the document stays well-formed.
        self.assertIn("Acme &amp; Sons", self.built["xml"])
        self.assertIn("Linear position &lt;X&gt; &amp; more", self.built["xml"])

    def test_an_element_the_mapping_does_not_list_is_an_error(self):
        harness = (
            "globalThis.Deno = { env: { get: () => undefined } };\n"
            f"const writer = await import({json.dumps(WRITER.as_uri())});\n"
            "try { writer.environmentToXml({ submodels: [{ modelType: 'Submodel', id: 'x', qualifiers: [{}] }] }); "
            "console.log('no error'); } catch (e) { console.log(String(e.message)); }\n"
        )
        done = subprocess.run(
            [shutil.which("node"), "--experimental-strip-types", "--input-type=module", "-e", harness],
            capture_output=True, text=True, timeout=60)
        self.assertIn('a key "qualifiers"', done.stdout)


class TestTheReaderItself(unittest.TestCase):
    def test_it_reads_a_tree_and_refuses_a_tag_that_closes_the_wrong_element(self):
        root = parse('<?xml version="1.0"?>\n<a x="1"><b>1 &amp; 2</b><c/></a>')
        self.assertEqual(
            (root.tag, root.attrs, [c.tag for c in root.children], root.find("b").text),
            ("a", {"x": "1"}, ["b", "c"], "1 & 2"),
        )
        with self.assertRaises(AssertionError):
            parse("<a><b></a></b>")
        with self.assertRaises(AssertionError):
            parse("<a><b></b>")


class TestTheSource(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = INDEX.read_text(encoding="utf-8")

    def test_the_two_serialisations_the_part_and_the_media_type(self):
        self.assertIn('json: { part: AASX_SPEC_PART, extension: "json", contentType: "application/json" }', self.source)
        self.assertIn('xml: { part: "aasx/data.xml", extension: "xml", contentType: "text/xml" }', self.source)
        self.assertIn('const AASX_SPEC_PART = "aasx/aasenv-root.json";', self.source)

    def test_an_unknown_value_is_a_400_naming_both(self):
        self.assertIn("serialization must be 'json' or 'xml'", self.source)
        self.assertIn("Object.hasOwn(SERIALIZATIONS, requestedSerialization)", self.source)

    def test_xml_is_for_a_package_not_for_the_json_format(self):
        self.assertIn("serialization === \"xml\" && format === \"json\"", self.source)

    def test_both_packagings_take_the_option(self):
        self.assertEqual(self.source.count("buildAasxPackage(environment, supplements, serialization)"), 2)

    def test_the_writer_is_not_asked_for_json(self):
        self.assertIn('serialization === "xml" ? environmentToXml(environment) : JSON.stringify(environment, null, 2)', self.source)


def request(url, token, payload=None):
    """(status, body, lower-cased headers) for one POST to the stack: the URL is split and connected to."""
    parts = urllib.parse.urlsplit(url)
    connect = http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    headers = {"apikey": PUBLISHABLE_KEY, "Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    body = json.dumps(payload).encode() if payload is not None else None
    connection = connect(parts.hostname, parts.port, timeout=60)
    try:
        connection.request("POST", parts.path + (f"?{parts.query}" if parts.query else ""), body=body, headers=headers)
        response = connection.getresponse()
        return response.status, response.read(), {k.lower(): v for k, v in response.getheaders()}
    except OSError:
        return 0, b"", {}
    finally:
        connection.close()


def sign_in():
    try:
        status, data = stack_sign_in.password_grant(SUPABASE_URL, PUBLISHABLE_KEY, DEMO_EMAIL, DEMO_PASSWORD)
    except OSError:
        return None
    return data.get("access_token") if status == 200 and isinstance(data, dict) else None


TOKEN = sign_in() if PUBLISHABLE_KEY else None
DEVICE = None
if TOKEN:
    try:
        DEVICE = aas_fixture.ensure(SUPABASE_URL, TOKEN, PUBLISHABLE_KEY)
    except Exception as err:  # noqa: BLE001 -- reported, never silently skipped
        print(f"[test_an_aasx_can_carry_its_environment_as_xml] could not provision the fixture: {err}")
LIVE = TOKEN is not None and DEVICE is not None


def package(query, payload=None):
    return request(f"{EXPORT}{query}", TOKEN, payload or {"device_id": DEVICE["id"]})


@unittest.skipUnless(LIVE, "no reachable stack, or the AAS fixture could not be provisioned")
class TestTheDeployedFunction(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        status, body, headers = package("?format=aasx&serialization=xml")
        assert status == 200, f"aasx xml {status}: {body[:300]!r}"
        cls.xml_package = zipfile.ZipFile(io.BytesIO(body))
        cls.xml_headers = headers
        status, body, _ = package("?format=aasx")
        assert status == 200, f"aasx {status}"
        cls.json_package = zipfile.ZipFile(io.BytesIO(body))
        status, body, _ = request(EXPORT, TOKEN, {"device_id": DEVICE["id"]})
        cls.exported = json.loads(body)["aas"]

    def rels(self, archive, name):
        return relationships(archive.read(name).decode("utf-8"))

    def test_the_origin_relationship_reaches_the_xml_part_and_no_json_part_is_there(self):
        self.assertIn((REL, "/aasx/data.xml"), self.rels(self.xml_package, "aasx/_rels/aasx-origin.rels"))
        names = self.xml_package.namelist()
        self.assertIn("aasx/data.xml", names)
        self.assertNotIn("aasx/aasenv-root.json", names)

    def test_the_content_types_name_the_xml_part(self):
        root = parse(self.xml_package.read("[Content_Types].xml").decode("utf-8"))
        defaults = {d.attrs["Extension"]: d.attrs["ContentType"] for d in root.iter("Default")}
        self.assertEqual(defaults.get("xml"), "text/xml")
        self.assertEqual(defaults.get("rels"), "application/vnd.openxmlformats-package.relationships+xml")
        self.assertNotIn("json", defaults, "an XML package declares no JSON part")

    def test_the_part_is_the_environment_as_the_json_export_has_it(self):
        root = parse(self.xml_package.read("aasx/data.xml").decode("utf-8"))
        self.assertEqual(root.tag, "environment")
        self.assertEqual(root.attrs, {"xmlns": NS})
        ids = sorted(e.text for e in root.iter("id"))
        expected = sorted(
            [s["id"] for s in self.exported["submodels"]]
            + [s["id"] for s in self.exported["assetAdministrationShells"]]
            + [c["id"] for c in self.exported.get("conceptDescriptions", [])]
        )
        self.assertEqual(ids, expected)

    def test_json_stays_the_default_and_an_explicit_json_is_the_same_package(self):
        self.assertIn("aasx/aasenv-root.json", self.json_package.namelist())
        self.assertNotIn("aasx/data.xml", self.json_package.namelist())
        status, body, _ = package("?format=aasx&serialization=json")
        self.assertEqual(status, 200)
        explicit = zipfile.ZipFile(io.BytesIO(body))
        self.assertEqual(explicit.read("aasx/aasenv-root.json"), self.json_package.read("aasx/aasenv-root.json"))
        self.assertEqual(explicit.read("[Content_Types].xml"), self.json_package.read("[Content_Types].xml"))

    def test_the_option_is_read_from_the_body_as_format_is(self):
        status, body, _ = request(f"{EXPORT}?format=aasx", TOKEN, {"device_id": DEVICE["id"], "serialization": "xml"})
        self.assertEqual(status, 200)
        self.assertIn("aasx/data.xml", zipfile.ZipFile(io.BytesIO(body)).namelist())

    def test_the_stats_header_still_comes_with_the_package(self):
        self.assertIn("submodels", json.loads(self.xml_headers["x-aas-stats"]))

    def test_an_unknown_serialisation_is_a_400_naming_the_two(self):
        status, body, _ = package("?format=aasx&serialization=yaml")
        self.assertEqual(status, 400)
        message = json.loads(body)["error"]
        self.assertIn("'json'", message)
        self.assertIn("'xml'", message)

    def test_xml_with_the_json_format_is_a_400(self):
        status, body, _ = package("?format=json&serialization=xml")
        self.assertEqual(status, 400)
        self.assertIn("aasx", json.loads(body)["error"])

    def test_a_bundle_takes_the_option_too(self):
        status, body, _ = package("?format=bundle&serialization=xml")
        self.assertEqual(status, 200, body[:300])
        archive = zipfile.ZipFile(io.BytesIO(body))
        self.assertIn((REL, "/aasx/data.xml"), self.rels(archive, "aasx/_rels/aasx-origin.rels"))
        self.assertIn("aasx/data.xml", archive.namelist())
        self.assertNotIn("aasx/aasenv-root.json", archive.namelist())
        # The bundle's own parts keep their own media types.
        root = parse(archive.read("[Content_Types].xml").decode("utf-8"))
        overrides = {o.attrs["PartName"] for o in root.iter("Override")}
        self.assertTrue(any(name.endswith(".json") for name in overrides), overrides)


if __name__ == "__main__":
    unittest.main()
