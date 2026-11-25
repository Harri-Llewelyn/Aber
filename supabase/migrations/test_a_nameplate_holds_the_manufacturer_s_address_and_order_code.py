# suite:
#   lanes: db
#   why: 0324 -- that a nameplate's order code and the manufacturer's address are stored, proposed,
#     approved and recorded as its other fields are. A column the proposal lane admits and
#     approve_proposal() does not set is an approval that says it applied and changed nothing. And that
#     Contact Information, which gives the address elements their ids, is seeded as its file has it and
#     with no ECLASS text: a wrong id in an export is a claim about the wrong concept.

"""
A nameplate holds the manufacturer's address and order code (0324).

    python supabase/migrations/test_a_nameplate_holds_the_manufacturer_s_address_and_order_code.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).
EVERY TEST ROLLS BACK.
"""
import json
import os
import pathlib
import unittest

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

HERE = pathlib.Path(__file__).resolve().parent
MIGRATION = next(HERE.glob("0324_*.sql")).read_text(encoding="utf-8")
CONTACT_FILE = HERE.parents[1] / "scripts" / "vocabularies" / "idta-02002-1-0-4-contact-information.json"
CONTACT = "https://admin-shell.io/zvei/nameplate/1/0/ContactInformations"

NEW = {
    "order_code_of_manufacturer": "FMABC1234",
    "address_street": "1 Example Road",
    "address_zipcode": "SA1 8EN",
    "address_city_town": "Swansea",
    "address_state_county": "West Glamorgan",
    "address_national_code": "GB",
}
# The dashboard's save: an upsert of the fields, a missing one as NULL.
UPSERT = """
INSERT INTO public.device_nameplate (device_id, serial_number, order_code_of_manufacturer, address_street,
                                     address_zipcode, address_city_town, address_state_county, address_national_code)
VALUES (%(device_id)s, %(serial_number)s, %(order_code_of_manufacturer)s, %(address_street)s, %(address_zipcode)s,
        %(address_city_town)s, %(address_state_county)s, %(address_national_code)s)
ON CONFLICT (device_id) DO UPDATE SET
  serial_number = EXCLUDED.serial_number, order_code_of_manufacturer = EXCLUDED.order_code_of_manufacturer,
  address_street = EXCLUDED.address_street, address_zipcode = EXCLUDED.address_zipcode,
  address_city_town = EXCLUDED.address_city_town, address_state_county = EXCLUDED.address_state_county,
  address_national_code = EXCLUDED.address_national_code
"""
STORED = """
SELECT order_code_of_manufacturer, address_street, address_zipcode, address_city_town, address_state_county,
       address_national_code FROM public.device_nameplate WHERE device_id = %s
"""
# The address elements' ids, as Contact Information's file gives them.
ADDRESS_IDS = {
    "Street": "0173-1#02-AAO128#002",
    "Zipcode": "0173-1#02-AAO129#002",
    "CityTown": "0173-1#02-AAO132#002",
    "StateCounty": "0173-1#02-AAO133#002",
    "NationalCode": "0173-1#02-AAO134#002",
}

MANAGER = "a0d17070-0000-4000-8000-0000000324a1"
OPERATOR = "a0d17070-0000-4000-8000-0000000324a2"
AUDITOR = "a0d17070-0000-4000-8000-0000000324a3"
CELL = "a0d17070-0000-4000-8000-0000000324c1"
# Differs from every other fixture in its first 21 hex characters, which become its sparkplug_id.
DEVICE = "d3240485-0000-4000-8000-0000000324d1"


class NameplateCase(unittest.TestCase):
    def setUp(self):
        try:
            self.conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
        except psycopg2.OperationalError as exc:
            raise unittest.SkipTest(f"cannot reach Supabase Postgres ({exc}); is the stack up?") from exc
        self.cur = self.conn.cursor()
        for user_id, role in ((MANAGER, "Shopfloor_Manager"), (OPERATOR, "Operator"), (AUDITOR, "Auditor")):
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING",
                (user_id, f"{user_id}@nameplate-address.test"))
            self.cur.execute("INSERT INTO public.user_roles (user_id, role_id)"
                             " SELECT %s, id FROM public.roles WHERE name = %s", (user_id, role))
        self.cur.execute("INSERT INTO public.cells (id, name) VALUES (%s, 'Nameplate Address Cell 0324')", (CELL,))
        self.cur.execute("INSERT INTO public.devices (id, name, cell_id, location_scope)"
                         " VALUES (%s, 'Nameplate_Address_0324', %s, 'cell')", (DEVICE, CELL))

    def tearDown(self):
        if hasattr(self, "conn"):
            self.conn.rollback()
            self.conn.close()

    def as_user(self, user):
        self.cur.execute("SELECT set_config('role', 'authenticated', true)")
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true)", (json.dumps(
            {"sub": user, "role": "authenticated", "email": f"{user}@nameplate-address.test", "aal": "aal2"}),))

    def as_owner(self):
        self.cur.execute("RESET ROLE")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true)")

    def fetch(self, sql, params=None):
        self.cur.execute(sql, params or ())
        return self.cur.fetchall()

    def stored(self):
        rows = self.fetch(STORED, (DEVICE,))
        return dict(zip(NEW, rows[0])) if rows else None

    def write(self, user, values):
        """One save of the dialog, as the caller."""
        self.as_user(user)
        self.cur.execute(UPSERT, {"device_id": DEVICE, "serial_number": None, **dict.fromkeys(NEW), **values})
        self.as_owner()

    def propose(self, patch, user=OPERATOR):
        self.as_user(user)
        self.cur.execute("INSERT INTO public.change_proposals (entity_type, entity_id, patch, rationale)"
                         " VALUES ('device_nameplate', %s, %s::jsonb, 'read off the plate') RETURNING id",
                         (DEVICE, json.dumps(patch)))
        proposal = self.cur.fetchone()[0]
        self.as_owner()
        return proposal

    def approve(self, proposal, user=MANAGER):
        self.as_user(user)
        self.cur.execute("SELECT public.approve_proposal(%s)", (proposal,))
        self.as_owner()


class TestTheColumns(NameplateCase):
    def test_they_are_optional_text(self):
        self.assertEqual(
            sorted(self.fetch("SELECT column_name, data_type, is_nullable FROM information_schema.columns"
                              " WHERE table_schema = 'public' AND table_name = 'device_nameplate'"
                              "   AND column_name = ANY (%s)", (list(NEW),))),
            sorted((c, "text", "YES") for c in NEW))

    def test_a_manager_writes_them_and_the_row_names_the_manager(self):
        self.write(MANAGER, NEW)
        self.assertEqual(self.stored(), NEW)
        self.assertEqual(self.fetch("SELECT updated_by::text FROM public.device_nameplate WHERE device_id = %s", (DEVICE,)),
                         [(MANAGER,)])

    def test_an_operator_and_an_auditor_still_write_nothing(self):
        for user in (OPERATOR, AUDITOR):
            with self.subTest(user=user):
                self.cur.execute("SAVEPOINT one")
                with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                    self.write(user, NEW)
                self.cur.execute("ROLLBACK TO SAVEPOINT one")
                self.as_owner()

    def test_a_change_to_one_is_one_audit_row_with_both_values(self):
        self.write(MANAGER, {"address_street": "1 Example Road"})
        self.cur.execute("SELECT coalesce(max(id), 0) FROM public.audit_trail")
        last = self.cur.fetchone()[0]
        self.write(MANAGER, {"address_street": "2 Example Road"})
        self.write(MANAGER, {"address_street": "2 Example Road"})
        rows = self.fetch("SELECT action, old_data ->> 'address_street', new_data ->> 'address_street', changed_by::text"
                          "  FROM public.audit_trail WHERE id > %s AND entity_type = 'device_nameplate'", (last,))
        self.assertEqual(rows, [("UPDATE", "1 Example Road", "2 Example Road", MANAGER)])


class TestTheProposalLane(NameplateCase):
    def test_every_column_of_a_nameplate_but_the_databases_own_is_proposable(self):
        columns = {r[0] for r in self.fetch(
            "SELECT attname FROM pg_attribute WHERE attrelid = 'public.device_nameplate'::regclass"
            " AND attnum > 0 AND NOT attisdropped")}
        lane = set(self.fetch("SELECT public.proposable_columns('device_nameplate')")[0][0])
        self.assertEqual(lane, columns - {"device_id", "updated_at", "updated_by"})

    def test_an_approval_applies_each_of_them(self):
        self.approve(self.propose(NEW))
        self.assertEqual(self.stored(), NEW)
        self.assertEqual(self.fetch("SELECT updated_by::text FROM public.device_nameplate WHERE device_id = %s", (DEVICE,)),
                         [(OPERATOR,)], "the proposer, as for every nameplate field")

    def test_an_approval_of_one_leaves_the_others_and_the_older_fields(self):
        self.write(MANAGER, {**NEW, "serial_number": "SN-1"})
        self.approve(self.propose({"address_city_town": "Port Talbot"}))
        self.assertEqual(self.stored(), {**NEW, "address_city_town": "Port Talbot"})
        self.assertEqual(self.fetch("SELECT serial_number FROM public.device_nameplate WHERE device_id = %s", (DEVICE,)),
                         [("SN-1",)])

    def test_an_approval_of_an_older_field_leaves_these(self):
        self.write(MANAGER, NEW)
        self.approve(self.propose({"serial_number": "SN-2"}))
        self.assertEqual(self.stored(), NEW)

    def test_an_approval_can_clear_one(self):
        self.write(MANAGER, NEW)
        self.approve(self.propose({"address_state_county": None}))
        self.assertEqual(self.stored(), {**NEW, "address_state_county": None})

    def test_a_column_the_database_writes_is_still_refused(self):
        self.cur.execute("SAVEPOINT one")
        with self.assertRaises(psycopg2.errors.InvalidParameterValue):
            self.propose({"updated_by": MANAGER})
        self.cur.execute("ROLLBACK TO SAVEPOINT one")

    def test_the_other_lanes_are_as_they_were(self):
        before = {"devices": ["name", "description", "cell_id", "area_id", "location_scope", "model_3d_path"],
                  "areas": ["name", "description", "icon"],
                  "cells": ["name", "icon", "area_id", "plan_x", "plan_y", "description"],
                  "gateways": ["name", "description", "cell_id", "area_id", "location_scope", "access_url"],
                  "schemas": []}
        for lane, columns in before.items():
            with self.subTest(lane=lane):
                self.assertEqual(self.fetch("SELECT public.proposable_columns(%s)", (lane,)), [(columns,)])

    def test_approve_proposal_is_0165s_but_for_the_six_columns(self):
        """Read from the files: every other line of the body is the one it was declared from."""
        def body(name):
            text = next(HERE.glob(name)).read_text(encoding="utf-8").replace("\r\n", "\n")
            start = text.index("CREATE OR REPLACE FUNCTION public.approve_proposal(")
            return text[start:text.index("\n$$;", start)].split("\n")
        ours = [line for line in body("0324_*.sql")
                if not any(line.strip().startswith(f"{c} ") for c in NEW)]
        self.assertEqual(ours, body("0165_*.sql"))


class TestContactInformation(NameplateCase):
    def test_the_address_elements_carry_the_ids_the_file_gives_them(self):
        rows = self.fetch("SELECT id_short, semantic_id, model_type, cardinality FROM public.idta_template_elements"
                          " WHERE template_id = %s AND parent_path = 'ContactInformation' AND id_short = ANY (%s)",
                          (CONTACT, list(ADDRESS_IDS)))
        self.assertEqual({r[0]: r[1] for r in rows}, ADDRESS_IDS)
        # Multi-language, and optional in this template: the Nameplate's specification asks for four.
        self.assertEqual({r[2:] for r in rows}, {("MultiLanguageProperty", "ZeroToOne")})

    def test_every_element_of_the_file_is_a_row_in_its_order_under_its_parent(self):
        environment = json.loads(CONTACT_FILE.read_text(encoding="utf-8"))
        expected = []

        def visit(element, parent):
            path = element["idShort"] if parent is None else f"{parent}.{element['idShort']}"
            stated = [q["value"] for q in element.get("qualifiers", []) if q["type"] == "Multiplicity"]
            expected.append((path, parent, element["modelType"],
                             element["semanticId"]["keys"][0]["value"], stated[0]))
            if element["modelType"] == "SubmodelElementCollection":
                for child in element.get("value", []):
                    visit(child, path)
        for element in environment["submodels"][0]["submodelElements"]:
            visit(element, None)
        rows = self.fetch("SELECT path, parent_path, model_type, semantic_id, cardinality"
                          "  FROM public.idta_template_elements WHERE template_id = %s ORDER BY ordinal", (CONTACT,))
        self.assertEqual([tuple(r) for r in rows], expected)
        self.assertEqual(
            self.fetch("SELECT DISTINCT template_name, template_number, template_version"
                       "  FROM public.idta_template_elements WHERE template_id = %s", (CONTACT,)),
            [("Contact Information", "IDTA 02002", "1.0.4")])

    def test_no_row_holds_an_eclass_definition(self):
        texts = [r[0] for r in self.fetch("SELECT definition FROM public.idta_template_elements"
                                          " WHERE template_id = %s AND definition IS NOT NULL", (CONTACT,))]
        self.assertEqual([t for t in texts if "ECLASS definition" in t], [])
        environment = json.loads(CONTACT_FILE.read_text(encoding="utf-8"))
        self.assertEqual([c["id"] for c in environment["conceptDescriptions"] if "0173-" in c["id"] or "0112/" in c["id"]], [])
        # What the file says of Language itself stays; the sentence that quoted ECLASS is gone.
        self.assertIn("Note: language codes defined accord. to ISO 639-1.", texts)

    def test_the_earlier_templates_are_as_0320_leaves_them(self):
        self.assertEqual(
            self.fetch("SELECT template_number, count(*) FROM public.idta_template_elements"
                       " WHERE template_number <> 'IDTA 02002' GROUP BY 1 ORDER BY 1"),
            [("IDTA 02006", 36), ("IDTA 02017", 360)])


class TestReplay(NameplateCase):
    def test_replaying_the_migration_rewrites_no_row_and_keeps_a_nameplate(self):
        self.write(MANAGER, NEW)
        elements = "SELECT ctid::text, xmin::text, e.* FROM public.idta_template_elements e ORDER BY template_id, ordinal"
        before = self.fetch(elements)
        plate = self.fetch("SELECT ctid::text, n.* FROM public.device_nameplate n WHERE device_id = %s", (DEVICE,))
        self.cur.execute(MIGRATION)
        self.assertEqual(self.fetch(elements), before)
        self.assertEqual(self.fetch("SELECT ctid::text, n.* FROM public.device_nameplate n WHERE device_id = %s", (DEVICE,)), plate)
        self.assertEqual(self.stored(), NEW)

    def test_replay_puts_back_a_row_that_was_changed_or_removed(self):
        read = "SELECT * FROM public.idta_template_elements WHERE template_id = %s ORDER BY ordinal"
        before = self.fetch(read, (CONTACT,))
        self.cur.execute("DELETE FROM public.idta_template_elements WHERE template_id = %s AND id_short = 'Street'", (CONTACT,))
        self.cur.execute("UPDATE public.idta_template_elements SET definition = 'edited by hand'"
                         " WHERE template_id = %s AND id_short = 'Zipcode'", (CONTACT,))
        self.cur.execute(MIGRATION)
        self.assertEqual(self.fetch(read, (CONTACT,)), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
