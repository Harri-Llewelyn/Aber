# suite:
#   lanes: unit
#   why: A nameplate that names the IDTA template asserts the template's mandatory elements, so what the
#     exporter writes is held to the template's own file here, element by element: the type, the value
#     type, the id, and that nothing else is in it. A complete and an incomplete nameplate are validated
#     against the official IDTA JSON schema and XSD, because a submodel that claims a template and is not
#     valid AAS is worse than one that claims nothing. Where CI is set, a missing validator or Node fails
#     the suite rather than skipping it.

"""
A complete nameplate names its template, and an incomplete one does not, in both serialisations.

buildEnvironment() and environmentToXml() themselves run in Node, over the template's rows as the
generator reads them from the files kept in scripts/vocabularies/. The Deno tests of the exporter hold
the rule (_shared/aas/nameplate_claim_test.ts); this is the validators' answer about what it writes.

Needs jsonschema and xmlschema, pinned in test-harness/requirements.txt.

Run:  python supabase/functions/aas-export/test_a_complete_nameplate_names_its_template.py
"""
import copy
import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

try:
    import xmlschema
    from jsonschema import Draft201909Validator
except ImportError:  # reported below: a failure under CI, a skip on a laptop
    xmlschema = None

REPO_ROOT = Path(__file__).resolve().parents[3]
AAS = REPO_ROOT / "supabase" / "functions" / "_shared" / "aas"
SCHEMAS = REPO_ROOT / "test-harness" / "schemas"
VOCABULARIES = REPO_ROOT / "scripts" / "vocabularies"

NAMEPLATE = "https://admin-shell.io/idta/nameplate/3/0/Nameplate"
# IDTA 02006, "Mandatory information for address information". No file says so.
MANDATORY_ADDRESS = ("Street", "Zipcode", "CityTown", "NationalCode")

COMPLETE = {
    "uri_of_the_product": "https://example.com/products/lathe/0042",
    "manufacturer_name": "Acme & Sons <Ltd>",
    "manufacturer_product_designation": "Lathe 42",
    "address_street": "1 Example Road",
    "address_zipcode": "SA1 8EN",
    "address_city_town": "Swansea",
    "address_state_county": "West Glamorgan",
    "address_national_code": "GB",
    "manufacturer_product_type": "FM-ABC-1234",
    "order_code_of_manufacturer": "FMABC1234",
    "serial_number": "SN-1",
    "year_of_construction": "2022",
    "date_of_manufacture": "2022-01-01",
    "hardware_version": "1.0",
    "firmware_version": "1.1",
    "software_version": "1.2",
    "country_of_origin": "DE",
}
# The column of each element a nameplate cannot claim the template without.
MANDATORY_COLUMNS = {
    "URIOfTheProduct": "uri_of_the_product", "ManufacturerName": "manufacturer_name",
    "ManufacturerProductDesignation": "manufacturer_product_designation",
    "OrderCodeOfManufacturer": "order_code_of_manufacturer",
    "AddressInformation.Street": "address_street", "AddressInformation.Zipcode": "address_zipcode",
    "AddressInformation.CityTown": "address_city_town", "AddressInformation.NationalCode": "address_national_code",
}


def template(file):
    return json.loads((VOCABULARIES / file).read_text(encoding="utf-8"))["submodels"][0]


NAMEPLATE_TEMPLATE = template("idta-02006-3-0-3-digital-nameplate.json")
CONTACT_TEMPLATE = template("idta-02002-1-0-4-contact-information.json")


def id_of(element):
    keys = element.get("semanticId", {}).get("keys", [])
    return keys[0]["value"] if keys else None


def cardinality(element):
    return next((q["value"] for q in element.get("qualifiers", [])
                 if q["type"] in ("SMT/Cardinality", "Cardinality", "Multiplicity")), None)


def rows(submodel, name, number):
    """The template's rows of idta_template_elements, as far as the exporter reads them."""
    out = []

    def visit(element, parent, index):
        if parent is None:
            path = element["idShort"]
        elif index is not None:
            path = f"{parent}[{index}]"
        else:
            path = f"{parent}.{element['idShort']}"
        out.append({
            "template_id": id_of(submodel), "template_name": name, "template_number": number, "path": path,
            "parent_path": parent, "ordinal": len(out) + 1, "id_short": element.get("idShort"),
            "model_type": element["modelType"],
            "value_type": element.get("valueType") if element["modelType"] == "Property" else None,
            "semantic_id": id_of(element), "cardinality": cardinality(element),
        })
        listed = element["modelType"] == "SubmodelElementList"
        if listed or element["modelType"] == "SubmodelElementCollection":
            for at, child in enumerate(element.get("value", [])):
                visit(child, path, at if listed else None)

    for element in submodel["submodelElements"]:
        visit(element, None, None)
    return out


ELEMENTS = (rows(NAMEPLATE_TEMPLATE, "Digital Nameplate", "IDTA 02006")
            + rows(CONTACT_TEMPLATE, "Contact Information", "IDTA 02002"))


def record(nameplate):
    return {
        "device": {"id": "d1", "sparkplug_id": "dev1", "name": "Lathe 1 on the shopfloor"},
        "config": [], "links": [], "catalog": [], "schemas": [], "definitions": [],
        "gateway": {"name": "Line A", "sparkplug_id": "gwy1"},
        "nameplate": nameplate,
        "templates": [{"id_short": e["idShort"], "semantic_id": id_of(e), "description": None}
                      for e in NAMEPLATE_TEMPLATE["submodelElements"]],
        "elements": ELEMENTS,
    }


def node_strips_types() -> bool:
    node = shutil.which("node")
    if node is None:
        return False
    out = subprocess.run([node, "--version"], capture_output=True, text=True).stdout.strip()
    major, minor = (int(p) for p in out.lstrip("v").split(".")[:2])
    return (major, minor) >= (22, 6)


def export(nameplates):
    """What buildEnvironment() and environmentToXml() make of each nameplate, in one run of Node."""
    harness = (
        "globalThis.Deno = { env: { get: () => undefined } };\n"
        f"const shell = await import({json.dumps((AAS / 'shell.ts').as_uri())});\n"
        f"const writer = await import({json.dumps((AAS / 'environmentXml.ts').as_uri())});\n"
        "let text = ''; for await (const chunk of process.stdin) text += chunk;\n"
        "const made = JSON.parse(text).map((record) => {\n"
        "  const { environment, stats } = shell.buildEnvironment(record);\n"
        "  return { environment, stats, xml: writer.environmentToXml(environment) };\n"
        "});\n"
        "process.stdout.write(JSON.stringify(made));\n"
    )
    done = subprocess.run(
        [shutil.which("node"), "--experimental-strip-types", "--input-type=module", "-e", harness],
        input=json.dumps([record(n) for n in nameplates]), capture_output=True, text=True, encoding="utf-8",
        timeout=60,
    )
    if done.returncode != 0:
        raise AssertionError(f"the exporter failed in Node:\n{done.stderr[-2000:]}")
    return json.loads(done.stdout)


def nameplate_of(made):
    return next((s for s in made["environment"]["submodels"] if s["idShort"] == "DigitalNameplate"), None)


def problems_with(submodel, named=NAMEPLATE_TEMPLATE):
    """What keeps a nameplate from being the template its id would name, as sentences. Empty when nothing does."""
    found = []
    known = {e["idShort"]: e for e in named["submodelElements"]}
    contact = {e["idShort"]: e for e in CONTACT_TEMPLATE["submodelElements"][0]["value"]}

    def same(held, element, path):
        for key in ("modelType", "valueType"):
            if element["modelType"] == "Property" or key == "modelType":
                if held.get(key) != element.get(key):
                    found.append(f"{path}: its {key} is {held.get(key)}, the template's {element.get(key)}")
        if id_of(held) != id_of(element):
            found.append(f"{path}: its id is {id_of(held)}, the template's {id_of(element)}")

    held = {e["idShort"]: e for e in submodel["submodelElements"]}
    for id_short, element in held.items():
        if id_short not in known:
            found.append(f"{id_short} is not an element of the template")
        else:
            same(element, known[id_short], id_short)
    for id_short, element in known.items():
        if cardinality(element) in ("One", "OneToMany") and id_short not in held:
            found.append(f"{id_short} is missing")
    address = {e["idShort"]: e for e in held.get("AddressInformation", {}).get("value", [])}
    for id_short, element in address.items():
        if id_short not in contact:
            found.append(f"AddressInformation.{id_short} is not an element of Contact Information")
        else:
            same(element, contact[id_short], f"AddressInformation.{id_short}")
    found += [f"AddressInformation.{n} is missing" for n in MANDATORY_ADDRESS if n not in address]
    return found


class ExportCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        missing = None
        if xmlschema is None:
            missing = "jsonschema or xmlschema is not installed: pip install -r test-harness/requirements.txt"
        elif not node_strips_types():
            missing = "Node 22.6 or later runs TypeScript, and this host's does not"
        if missing:
            # A skip would turn a missing dependency into a green CI step.
            if os.environ.get("CI"):
                raise AssertionError(f"{missing} (CI is set, so this fails rather than skips)")
            raise unittest.SkipTest(missing)
        cls.without = {path: {**COMPLETE, column: None} for path, column in MANDATORY_COLUMNS.items()}
        made = export([COMPLETE, {"manufacturer_name": "Acme", "address_city_town": "Swansea"}, None,
                       *cls.without.values()])
        cls.complete, cls.incomplete, cls.none = made[:3]
        cls.lacking = dict(zip(cls.without, made[3:]))


class TestBothSerialisationsAreValid(ExportCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.json_schema = Draft201909Validator(
            json.loads((SCHEMAS / "AAS_V3_0_JSON_Schema.json").read_text(encoding="utf-8")))
        cls.xsd = xmlschema.XMLSchema(str(SCHEMAS / "AAS_V3_0_XML_Schema.xsd"))

    def each(self):
        return {"complete": self.complete, "incomplete": self.incomplete, "with no nameplate value": self.none}.items()

    def test_the_json_validates_against_the_idta_schema(self):
        for what, made in self.each():
            with self.subTest(what):
                errors = [f"{list(e.path)}: {e.message}" for e in self.json_schema.iter_errors(made["environment"])]
                self.assertEqual(errors, [])

    def test_the_xml_validates_against_the_idta_xsd(self):
        for what, made in self.each():
            with self.subTest(what):
                self.assertEqual([str(e) for e in self.xsd.iter_errors(made["xml"])], [])

    def test_the_xml_says_what_the_json_says_of_the_claim(self):
        self.assertIn(f"<value>{NAMEPLATE}</value>", self.complete["xml"])
        self.assertIn("<multiLanguageProperty>", self.complete["xml"])
        self.assertNotIn(NAMEPLATE, self.incomplete["xml"])
        self.assertNotIn(NAMEPLATE, self.none["xml"])

    def test_a_broken_document_is_refused_so_the_validators_check_something(self):
        broken = copy.deepcopy(self.complete["environment"])
        next(e for e in broken["submodels"][0]["submodelElements"] if e["idShort"] == "ManufacturerName")["value"] = "Acme"
        self.assertNotEqual(list(self.json_schema.iter_errors(broken)), [])
        self.assertNotEqual(list(self.xsd.iter_errors(
            self.complete["xml"].replace("<text>Swansea</text>", "<text></text>"))), [])


class TestAClaimIsTheTemplates(ExportCase):
    def test_a_complete_nameplate_names_the_template_and_is_it(self):
        self.assertEqual(id_of(nameplate_of(self.complete)), NAMEPLATE)
        self.assertEqual(problems_with(nameplate_of(self.complete)), [])
        self.assertEqual((self.complete["stats"]["claimed_templates"],
                          self.complete["stats"]["nameplate_missing_elements"]), (1, 0))

    def test_an_incomplete_one_names_none_and_is_not_it(self):
        self.assertNotIn("semanticId", nameplate_of(self.incomplete))
        self.assertNotEqual(problems_with(nameplate_of(self.incomplete)), [])
        self.assertEqual((self.incomplete["stats"]["claimed_templates"],
                          self.incomplete["stats"]["nameplate_missing_elements"]), (0, 6))

    def test_the_claim_is_made_exactly_where_the_template_s_own_file_finds_nothing_wrong(self):
        for path, made in self.lacking.items():
            with self.subTest(without=path):
                self.assertEqual(problems_with(nameplate_of(made)), [f"{path} is missing"])
                self.assertNotIn("semanticId", nameplate_of(made))
                self.assertEqual(made["stats"]["nameplate_missing_elements"], 1)

    def test_the_mandatory_columns_here_are_the_templates_and_the_specifications(self):
        stated = [e["idShort"] for e in NAMEPLATE_TEMPLATE["submodelElements"]
                  if cardinality(e) in ("One", "OneToMany") and e["idShort"] != "AddressInformation"]
        self.assertEqual(sorted(MANDATORY_COLUMNS), sorted(stated + [f"AddressInformation.{n}" for n in MANDATORY_ADDRESS]))

    def test_every_id_in_a_complete_nameplate_has_a_concept_description(self):
        carried = set()

        def walk(node):
            if isinstance(node, dict):
                if id_of(node):
                    carried.add(id_of(node))
                for value in node.values():
                    walk(value)
            elif isinstance(node, list):
                for item in node:
                    walk(item)
        walk(self.complete["environment"]["submodels"])
        self.assertEqual(carried, {c["id"] for c in self.complete["environment"]["conceptDescriptions"]})
        self.assertIn(NAMEPLATE, carried)

    def test_no_other_submodel_claims_anything(self):
        others = [s for s in self.complete["environment"]["submodels"] if s["idShort"] != "DigitalNameplate"]
        self.assertEqual([s["idShort"] for s in others], ["PlatformConnection"])
        self.assertEqual([s["idShort"] for s in others if "semanticId" in s], [])

    def test_the_device_s_own_name_is_in_no_nameplate(self):
        for made in (self.complete, self.incomplete, *self.lacking.values()):
            self.assertNotIn("Lathe 1 on the shopfloor", json.dumps(nameplate_of(made)))


if __name__ == "__main__":
    unittest.main(verbosity=2)
