# suite:
#   lanes: unit
#   why: The XML an AASX package carries as its Environment validates against the official IDTA XSD
#     (test-harness/schemas/AAS_V3_0_XML_Schema.xsd), with xmlschema: the writer's own output for a device
#     with a nameplate, telemetry, KPIs, a derived metric, a 3D model and concept descriptions, and the
#     refusals a broken document gets (an enumerated value that is not one, elements out of order). The
#     Deno test of the writer checks sequences and enumerations with a reader of its own; this is the
#     validator. Where CI is set, a missing xmlschema or Node fails the suite rather than skipping it,
#     which would turn a missing dependency into a green step.

"""
The XML Environment validates against the IDTA XSD.

Needs xmlschema, pinned in test-harness/requirements.txt: `pip install -r test-harness/requirements.txt`.
The writer (_shared/aas/environmentXml.ts) runs in Node over the Environment buildEnvironment() makes,
as test_aas_export.py runs shell.ts.

Run:  python supabase/functions/aas-export/test_the_xml_environment_validates_against_the_idta_xsd.py
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

REPO_ROOT = Path(__file__).resolve().parents[3]
SHELL = REPO_ROOT / "supabase" / "functions" / "_shared" / "aas" / "shell.ts"
WRITER = REPO_ROOT / "supabase" / "functions" / "_shared" / "aas" / "environmentXml.ts"
XSD = REPO_ROOT / "test-harness" / "schemas" / "AAS_V3_0_XML_Schema.xsd"

MTC = "https://aber.local/semantics/mtconnect/v2.0/DataItemType/"


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


# A device that exercises every kind of element the exporter makes: a nameplate with a template concept,
# telemetry, KPIs, a derived metric, a 3D model, and concept descriptions with IEC 61360 content.
RECORD = {
    "device": {"id": "d1", "sparkplug_id": "dev1", "name": "Mill 1", "model_3d_path": "mills/mill.glb",
               "last_birth_metrics": ["Controller/PART_COUNT"]},
    "config": [{"metric_name": "SERIAL_NUMBER", "val_string": "SN-1"},
               {"metric_name": "Systems/TEMPERATURE", "val_double": 41.5}],
    "links": [{"schema_id": "s1", "submodel_key": None}],
    "catalog": [
        metric("Systems/TEMPERATURE", MTC + "TEMPERATURE"),
        metric("OEE/AVAILABILITY", "https://aber.local/semantics/iso22400/AVAILABILITY",
               standard="ISO 22400", units=None),
        metric("Controller/PART_COUNT", None, datatype=8, units=None, standard=None,
               description='A <count> & "more"'),
        {"name": "Controller/PARTS_PER_HOUR", "semantic_id": None, "datatype": 10, "standard": None,
         "deprecated": False, "derivation": {"kind": "counter_rate", "input": "Controller/PART_COUNT"}},
    ],
    "gateway": {"name": "Cell gateway", "sparkplug_id": "gwy1"},
    "nameplate": {"manufacturer_name": "Acme & Sons", "serial_number": "SN-1"},
    "templates": [{"id_short": "ManufacturerName", "semantic_id": "0112/2///61987#ABA565#009",
                   "description": "Legal name of the manufacturer."}],
    "schemas": [{"id": "s1", "schema_name": "Mill_Schema", "semantic_id": "https://example.org/submodels/Mill/1/0",
                 "schema_definition": {"properties": {"Systems/TEMPERATURE": {}, "OEE/AVAILABILITY": {},
                                                      "Controller/PART_COUNT": {}}}}],
    "definitions": [{"semantic_id": MTC + "TEMPERATURE", "name": "TEMPERATURE",
                     "definition": "The temperature of a part of the equipment.", "standard": "MTConnect"}],
}


def run_writer(record: dict) -> str:
    """The XML environmentToXml() writes for what buildEnvironment() makes of `record`, in Node."""
    harness = (
        "globalThis.Deno = { env: { get: () => undefined } };\n"
        f"const shell = await import({json.dumps(SHELL.as_uri())});\n"
        f"const writer = await import({json.dumps(WRITER.as_uri())});\n"
        "let text = ''; for await (const chunk of process.stdin) text += chunk;\n"
        "process.stdout.write(writer.environmentToXml(shell.buildEnvironment(JSON.parse(text)).environment));\n"
    )
    done = subprocess.run(
        [shutil.which("node"), "--experimental-strip-types", "--input-type=module", "-e", harness],
        input=json.dumps(record), capture_output=True, text=True, encoding="utf-8", timeout=60,
    )
    if done.returncode != 0:
        raise AssertionError(f"the XML writer failed in Node:\n{done.stderr[-2000:]}")
    return done.stdout


class TestTheXmlValidatesAgainstTheXsd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        missing = None
        if xmlschema is None:
            missing = "xmlschema is not installed: pip install -r test-harness/requirements.txt"
        elif not node_strips_types():
            missing = "Node 22.6 or later runs TypeScript, and this host's does not"
        if missing:
            # A skip would turn a missing dependency into a green CI step.
            if os.environ.get("CI"):
                raise AssertionError(f"{missing} (CI is set, so this fails rather than skips)")
            raise unittest.SkipTest(missing)
        cls.schema = xmlschema.XMLSchema(str(XSD))
        cls.xml = run_writer(RECORD)

    def test_the_schema_loaded_is_the_vendored_one(self):
        self.assertEqual(self.schema.target_namespace, "https://admin-shell.io/aas/3/2")
        self.assertIn("environment", self.schema.elements)

    def test_the_writers_output_for_a_full_device_is_valid(self):
        errors = [str(e) for e in self.schema.iter_errors(self.xml)]
        self.assertEqual(errors, [])
        # It held every kind of element, so the validation covered them.
        for element in ("<property>", "<submodelElementCollection>", "<file>", "<conceptDescription>",
                        "<dataSpecificationIec61360>", "<assetInformation>", "<kind>"):
            self.assertIn(element, self.xml)

    def test_a_value_outside_an_enumeration_is_refused_and_named(self):
        broken = self.xml.replace("<kind>Instance</kind>", "<kind>Sometimes</kind>")
        self.assertNotEqual(broken, self.xml)
        with self.assertRaises(xmlschema.XMLSchemaValidationError) as caught:
            self.schema.validate(broken)
        message = str(caught.exception)
        self.assertIn("Sometimes", message)
        self.assertIn("Template", message)
        self.assertIn("Instance", message)

    def test_elements_out_of_order_are_refused(self):
        # The shell's idShort moved after its id: the sequence puts idShort first.
        self.assertIn("<idShort>Mill_1</idShort>", self.xml)
        moved = self.xml.replace("<idShort>Mill_1</idShort>", "", 1).replace(
            "</id>", "</id><idShort>Mill_1</idShort>", 1)
        self.assertNotEqual(moved, self.xml)
        with self.assertRaises(xmlschema.XMLSchemaValidationError):
            self.schema.validate(moved)

    def test_a_missing_required_element_is_refused(self):
        without_id = self.xml.replace("<id>https://aber.local/ids/asset/dev1/shell</id>", "", 1)
        self.assertNotEqual(without_id, self.xml)
        with self.assertRaises(xmlschema.XMLSchemaValidationError):
            self.schema.validate(without_id)


if __name__ == "__main__":
    unittest.main()
