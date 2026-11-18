# suite:
#   lanes: unit
#   why: An export's ConceptDescription names a metric's unit twice, as the MTConnect name in free text
#     and, where QUDT has exactly that unit, as a reference to it (`unitId`, 0304). Both the JSON and the
#     XML the exporter writes are validated against the official IDTA schemas, which accept the new
#     shape: a reference with the wrong type, or an element out of order, is refused by the validator and
#     passes the exporter's own assertions. Where CI is set, a missing validator or Node fails the suite
#     rather than skipping it, which would turn a missing dependency into a green step.

"""
The IEC 61360 `unit` and `unitId` of an exported ConceptDescription, validated.

Needs jsonschema and xmlschema (test-harness/requirements.txt) and Node 22.6 or later, which runs the
TypeScript of _shared/aas by stripping its types, as test_aas_export.py runs shell.ts.

Run:  python supabase/functions/aas-export/test_a_concept_description_names_its_unit_and_its_source.py
"""
import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

try:
    import xmlschema
except ImportError:  # reported below: a failure under CI, a skip on a laptop
    xmlschema = None
try:
    from jsonschema import Draft201909Validator
except ImportError:
    Draft201909Validator = None

REPO_ROOT = Path(__file__).resolve().parents[3]
AAS = REPO_ROOT / "supabase" / "functions" / "_shared" / "aas"
JSON_SCHEMA = REPO_ROOT / "test-harness" / "schemas" / "AAS_V3_0_JSON_Schema.json"
XSD = REPO_ROOT / "test-harness" / "schemas" / "AAS_V3_0_XML_Schema.xsd"
CROSSWALK = REPO_ROOT / "scripts" / "vocabularies" / "mtconnect-units-to-qudt.json"

MTC = "https://aber.local/semantics/mtconnect/v2.0/DataItemType/"
QUDT_UNIT = "http://qudt.org/vocab/unit/"


def node_strips_types() -> bool:
    node = shutil.which("node")
    if node is None:
        return False
    out = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip()
    major, minor = (int(p) for p in out.lstrip("v").split(".")[:2])
    return (major, minor) >= (22, 6)


def metric(name, semantic_id, **extra):
    return {"name": name, "semantic_id": semantic_id, "datatype": 10, "units": "CELSIUS",
            "description": f"The {name} reading", "standard": "MTConnect", "deprecated": False, **extra}


def record(**extra):
    """A device with a mapped unit, an unmapped one, a metric with none and the rows a test adds."""
    return {
        "device": {"id": "d1", "sparkplug_id": "dev1", "name": "Mill 1"},
        "config": [],
        "links": [{"schema_id": "s1", "submodel_key": None}],
        "catalog": [
            metric("Systems/TEMPERATURE", MTC + "TEMPERATURE"),
            metric("Axes/ROTATION", MTC + "ANGLE", units="DEGREE_3D"),
            metric("Spindle/SPEED", MTC + "ROTARY_VELOCITY", units="REVOLUTION/MINUTE"),
            metric("Controller/PART_COUNT", MTC + "PART_COUNT", datatype=8, units=None),
        ],
        "gateway": None,
        "nameplate": None,
        "templates": [],
        "schemas": [{"id": "s1", "schema_name": "Mill", "semantic_id": None,
                     "schema_definition": {"properties": {"Systems/TEMPERATURE": {}, "Axes/ROTATION": {},
                                                          "Spindle/SPEED": {}, "Controller/PART_COUNT": {}}}}],
        "definitions": [],
        **extra,
    }


def run_node(record_json: dict, body: str) -> str:
    """Run `body` in Node with `shell` and `writer` imported, over `record_json`, and return its output."""
    harness = (
        "globalThis.Deno = { env: { get: () => undefined } };\n"
        f"const shell = await import({json.dumps((AAS / 'shell.ts').as_uri())});\n"
        f"const writer = await import({json.dumps((AAS / 'environmentXml.ts').as_uri())});\n"
        "let text = ''; for await (const chunk of process.stdin) text += chunk;\n"
        "const environment = shell.buildEnvironment(JSON.parse(text)).environment;\n"
        + body
    )
    done = subprocess.run(
        [shutil.which("node"), "--experimental-strip-types", "--input-type=module", "-e", harness],
        input=json.dumps(record_json), capture_output=True, text=True, encoding="utf-8", timeout=60,
    )
    if done.returncode != 0:
        raise AssertionError(f"Node failed:\n{done.stderr[-2000:]}")
    return done.stdout


def environment_json(record_json: dict) -> dict:
    return json.loads(run_node(record_json, "process.stdout.write(JSON.stringify(environment));\n"))


def environment_xml(record_json: dict) -> str:
    return run_node(record_json, "process.stdout.write(writer.environmentToXml(environment));\n")


def content(environment: dict, semantic_id: str) -> dict:
    (concept,) = [c for c in environment["conceptDescriptions"] if c["id"] == semantic_id]
    return concept["embeddedDataSpecifications"][0]["dataSpecificationContent"]


class ConceptDescriptionTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        missing = None
        if xmlschema is None or Draft201909Validator is None:
            missing = "jsonschema and xmlschema are needed: pip install -r test-harness/requirements.txt"
        elif not node_strips_types():
            missing = "Node 22.6 or later runs TypeScript, and this host's does not"
        if missing:
            # A skip would turn a missing dependency into a green CI step.
            if os.environ.get("CI"):
                raise AssertionError(f"{missing} (CI is set, so this fails rather than skips)")
            raise unittest.SkipTest(missing)
        cls.json_schema = Draft201909Validator(json.loads(JSON_SCHEMA.read_text(encoding="utf-8")))
        cls.xsd = xmlschema.XMLSchema(str(XSD))


class TestUnitId(ConceptDescriptionTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.environment = environment_json(record())
        cls.xml = environment_xml(record())

    def test_a_unit_that_maps_is_exported_as_text_and_as_a_reference_to_the_qudt_unit(self):
        temperature = content(self.environment, MTC + "TEMPERATURE")
        self.assertEqual(temperature["unit"], "CELSIUS")
        self.assertEqual(temperature["unitId"], {
            "type": "ExternalReference",
            "keys": [{"type": "GlobalReference", "value": QUDT_UNIT + "DEG_C"}]})
        speed = content(self.environment, MTC + "ROTARY_VELOCITY")
        self.assertEqual((speed["unit"], speed["unitId"]["keys"][0]["value"]), ("REVOLUTION/MINUTE", QUDT_UNIT + "REV-PER-MIN"))

    def test_a_unit_the_crosswalk_maps_to_none_keeps_its_text_and_has_no_reference(self):
        rotation = content(self.environment, MTC + "ANGLE")
        self.assertEqual(rotation["unit"], "DEGREE_3D")
        self.assertNotIn("unitId", rotation)
        self.assertNotIn("unit", content(self.environment, MTC + "PART_COUNT"))

    def test_the_json_validates_against_the_idta_schema(self):
        self.assertEqual([e.message for e in self.json_schema.iter_errors(self.environment)], [])

    def test_the_xml_validates_against_the_idta_xsd_with_the_reference_after_the_unit(self):
        self.assertEqual([str(e) for e in self.xsd.iter_errors(self.xml)], [])
        compact = "".join(part.strip() for part in self.xml.splitlines())
        self.assertIn("<unit>CELSIUS</unit><unitId><type>ExternalReference</type><keys><key>"
                      f"<type>GlobalReference</type><value>{QUDT_UNIT}DEG_C</value></key></keys></unitId>", compact)

    def test_the_validators_refuse_a_reference_that_is_not_one(self):
        broken = json.loads(json.dumps(self.environment))
        content(broken, MTC + "TEMPERATURE")["unitId"] = {"type": "Sometimes", "keys": []}
        self.assertTrue(list(self.json_schema.iter_errors(broken)))
        wrong = self.xml.replace("<type>ExternalReference</type>", "<type>Sometimes</type>", 1)
        self.assertNotEqual(wrong, self.xml)
        with self.assertRaises(xmlschema.XMLSchemaValidationError):
            self.xsd.validate(wrong)

    def test_every_unit_the_crosswalk_maps_is_exported_as_the_unit_it_names(self):
        crosswalk = json.loads(CROSSWALK.read_text(encoding="utf-8"))["units"]
        # One metric, with an id of its own, for each of the 100 names, exported in one run.
        catalog = [metric(f"Fixture/READING_{i}", f"{MTC}FIXTURE_{i}", units=name) for i, name in enumerate(crosswalk)]
        made = environment_json(record(
            catalog=catalog,
            schemas=[{"id": "s1", "schema_name": "F", "semantic_id": None,
                      "schema_definition": {"properties": {m["name"]: {} for m in catalog}}}]))
        self.assertEqual(list(self.json_schema.iter_errors(made)), [])
        for i, (name, entry) in enumerate(crosswalk.items()):
            with self.subTest(unit=name):
                described = content(made, f"{MTC}FIXTURE_{i}")
                if entry["unit"]:
                    self.assertEqual(described["unitId"]["keys"][0]["value"], entry["unit"])
                else:
                    self.assertNotIn("unitId", described)


if __name__ == "__main__":
    unittest.main()
