"""
A derived metric is a catalogue row (0267).

    python supabase/migrations/test_a_derived_metric_is_a_catalogue_row.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * each of the three kinds saves, and the row's unit follows its inputs: a rate is the input's unit
    per hour (COUNT when it has none), a ratio has none, a sum takes the one its inputs share;
  * every refusal of the save, with the reason the dialog shows: an input missing, derived or of the
    wrong datatype; a sum whose inputs differ in unit; a state the input cannot report; a name a
    device has declared; a semantic id, a standard or permitted values; a datatype that is not
    Double; a unit that is not the inputs'; and a definition of the wrong shape, which the CHECK holds
    too;
  * fixed once saved: a measured metric cannot become derived, a derived metric's definition and
    unit cannot change, its description and its deprecation can, and a changed definition is a new
    metric the old one names as its replacement; and the unit of a metric a counter rate or a sum is
    built on, a deprecated one included, cannot change, while a metric no derived metric uses, and a
    time in state's input, still can;
  * who writes: an Administrator, with the second factor when it is required; a Shopfloor Manager,
    an Operator, an Auditor and anon are refused, and every signed-in role reads;
  * the Audit Trail files the save as it files any catalogue change.

Each test names its own group and rolls back.
"""
import json
import os
import unittest
import uuid
from pathlib import Path

import psycopg2
import psycopg2.errors

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

MIGRATION = Path(__file__).resolve().parent / "0267_a_derived_metric_is_a_catalogue_row.sql"

DOUBLE, INT32, BOOLEAN, STRING = 10, 3, 11, 12
CHECK_VIOLATION = "23514"
INSUFFICIENT_PRIVILEGE = "42501"
SWITCH = "security.require_mfa_for_managers"

ADMIN_ID = "0267a000-0000-4000-8000-0000000000a1"
MANAGER_ID = "0267a000-0000-4000-8000-0000000000b1"
OPERATOR_ID = "0267a000-0000-4000-8000-0000000000c1"
AUDITOR_ID = "0267a000-0000-4000-8000-0000000000d1"
PEOPLE = {ADMIN_ID: "Administrator", MANAGER_ID: "Shopfloor_Manager", OPERATOR_ID: "Operator",
          AUDITOR_ID: "Auditor"}


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


def counter(name):
    return {"kind": "counter_rate", "input": name}


def in_state(name, *states):
    return {"kind": "time_in_state", "input": name, "states": list(states)}


def total(*inputs):
    """`total(("A", 1), ("B", -1))`: a sum of the named inputs with their signs."""
    return {"kind": "sum", "inputs": [{"metric": m, "sign": s} for m, s in inputs]}


class DerivedBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.enforce_derived_metric()');")
        if self.cur.fetchone()[0] is None:
            self.skipTest("0267 is not applied to this database")
        # A group of this test's own: valid as a catalogue name, and unlike any other suite's.
        self.group = f"T267{uuid.uuid4().hex[:10]}"

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    # ---- fixtures ----------------------------------------------------------------------------
    def name(self, leaf):
        return f"{self.group}/{leaf}"

    def measured(self, leaf, datatype=DOUBLE, units=None, permitted=None):
        """A measured catalogue row, as the owner writes it."""
        self.cur.execute(
            "INSERT INTO public.metric_catalog (name, datatype, units, permitted_values)"
            " VALUES (%s, %s, %s, %s) RETURNING id;",
            (self.name(leaf), datatype, units, permitted),
        )
        return self.cur.fetchone()[0]

    def fixtures(self):
        self.measured("PART_COUNT", units="COUNT")
        self.measured("PIECES")
        self.measured("PHASE_A", units="KILOWATT")
        self.measured("PHASE_B", units="KILOWATT")
        self.measured("PHASE_C", units="KILOWATT")
        self.measured("CURRENT", units="AMPERE")
        self.measured("BARE_A")
        self.measured("BARE_B")
        self.measured("EXECUTION", STRING, permitted=["READY", "ACTIVE", "STOPPED"])
        self.measured("PROGRAM", STRING)
        self.measured("ESTOP", BOOLEAN)
        self.measured("MODE", INT32)

    def save(self, leaf, derivation, **columns):
        """A derived row inserted as the owner; the row's columns as the table now holds them."""
        values = {"name": self.name(leaf), "datatype": DOUBLE, **columns}
        cols = list(values) + ["derivation"]
        self.cur.execute(
            f"INSERT INTO public.metric_catalog ({', '.join(cols)}) VALUES ({', '.join(['%s'] * len(cols))})"
            " RETURNING id, units, derivation;",
            [*values.values(), json.dumps(derivation)],
        )
        return self.cur.fetchone()

    def refused(self, leaf, derivation, fragment, code=CHECK_VIOLATION, **columns):
        """The save is refused with `code` and a message holding `fragment`; returns the message."""
        self.cur.execute("SAVEPOINT refused;")
        with self.assertRaises(psycopg2.Error) as caught:
            self.save(leaf, derivation, **columns)
        self.cur.execute("ROLLBACK TO SAVEPOINT refused;")
        self.assertEqual(caught.exception.pgcode, code, caught.exception.pgerror)
        message = caught.exception.diag.message_primary
        self.assertIn(fragment, message)
        return message

    def update_refused(self, statement, args, fragment):
        """The UPDATE `statement` (its last placeholder the row's id) is refused with a reason holding `fragment`."""
        self.cur.execute("SAVEPOINT refused;")
        with self.assertRaises(psycopg2.Error) as caught:
            self.cur.execute(statement, args)
        self.cur.execute("ROLLBACK TO SAVEPOINT refused;")
        self.assertEqual(caught.exception.pgcode, CHECK_VIOLATION, caught.exception.pgerror)
        self.assertIn(fragment, caught.exception.diag.message_primary)


class EachKindSaves(DerivedBase):
    def test_a_counter_rate_takes_its_inputs_unit_per_hour(self):
        self.fixtures()
        _, units, derivation = self.save("PARTS_PER_HOUR", counter(self.name("PART_COUNT")))
        self.assertEqual(units, "COUNT/HOUR")
        self.assertEqual(derivation, counter(self.name("PART_COUNT")))

    def test_a_counter_with_no_unit_counts_occurrences(self):
        self.fixtures()
        self.assertEqual(self.save("PIECES_PER_HOUR", counter(self.name("PIECES")))[1], "COUNT/HOUR")

    def test_a_counter_in_another_unit_is_that_unit_per_hour(self):
        self.fixtures()
        self.assertEqual(self.save("KWH_RATE", counter(self.name("PHASE_A")))[1], "KILOWATT/HOUR")

    def test_a_time_in_state_has_no_unit(self):
        self.fixtures()
        _, units, derivation = self.save("UPTIME", in_state(self.name("EXECUTION"), "ACTIVE"))
        self.assertIsNone(units)
        self.assertEqual(derivation["states"], ["ACTIVE"])

    def test_a_time_in_state_reads_a_boolean_and_a_string_with_no_permitted_values(self):
        self.fixtures()
        self.save("STOPPED_SHARE", in_state(self.name("ESTOP"), "true"))
        self.save("RUNNING_SHARE", in_state(self.name("PROGRAM"), "O1000", "anything at all"))

    def test_a_sum_takes_the_unit_its_inputs_share(self):
        self.fixtures()
        _, units, _ = self.save("TOTAL", total((self.name("PHASE_A"), 1), (self.name("PHASE_B"), 1),
                                                (self.name("PHASE_C"), 1)))
        self.assertEqual(units, "KILOWATT")

    def test_a_difference_is_a_sum_with_a_negative_sign(self):
        self.fixtures()
        _, units, derivation = self.save("IMBALANCE", total((self.name("PHASE_A"), 1), (self.name("PHASE_B"), -1)))
        self.assertEqual(units, "KILOWATT")
        self.assertEqual([i["sign"] for i in derivation["inputs"]], [1, -1])

    def test_inputs_with_no_unit_give_a_sum_with_none(self):
        self.fixtures()
        self.assertIsNone(self.save("BARE_TOTAL", total((self.name("BARE_A"), 1), (self.name("BARE_B"), 1)))[1])

    def test_a_unit_that_matches_the_inputs_is_accepted(self):
        self.fixtures()
        self.assertEqual(self.save("TOTAL", total((self.name("PHASE_A"), 1), (self.name("PHASE_B"), 1)),
                                    units="KILOWATT")[1], "KILOWATT")

    def test_a_sum_has_two_to_eight_inputs(self):
        for n in range(9):
            self.measured(f"IN_{n}", units="KILOWATT")
        self.save("EIGHT", total(*[(self.name(f"IN_{n}"), 1) for n in range(8)]))
        self.refused("NINE", total(*[(self.name(f"IN_{n}"), 1) for n in range(9)]), "two to 8 inputs")
        self.refused("ONE", total((self.name("IN_0"), 1)), "two to 8 inputs")

    def test_a_measured_row_is_untouched(self):
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, units, semantic_id, semantic_id_type)"
                         " VALUES (%s, %s, 'KILOWATT', 'https://example.org/x', 'IRI') RETURNING derivation, units;",
                         (self.name("MEASURED"), DOUBLE))
        self.assertEqual(self.cur.fetchone(), (None, "KILOWATT"))


class EverySaveRefusalGivesItsReason(DerivedBase):
    def test_an_input_that_is_not_in_the_catalogue(self):
        self.fixtures()
        message = self.refused("TOTAL", total((self.name("PHASE_A"), 1), (self.name("PHASE_Z"), 1)), "is not in the catalogue")
        self.assertIn(self.name("PHASE_Z"), message)
        self.refused("RATE", counter(self.name("NOT_THERE")), "Add it before building a derived metric on it")

    def test_an_input_that_is_itself_derived(self):
        self.fixtures()
        self.save("PARTS_PER_HOUR", counter(self.name("PART_COUNT")))
        message = self.refused("TOTAL", total((self.name("PARTS_PER_HOUR"), 1), (self.name("PART_COUNT"), 1)),
                               "cannot be built on another")
        self.assertIn(self.name("PARTS_PER_HOUR"), message)
        self.refused("AGAIN", counter(self.name("PARTS_PER_HOUR")), "is itself a derived metric")

    def test_a_deprecated_input_is_still_an_input(self):
        self.fixtures()
        self.cur.execute("UPDATE public.metric_catalog SET deprecated = true WHERE name = %s;", (self.name("PART_COUNT"),))
        self.save("PARTS_PER_HOUR", counter(self.name("PART_COUNT")))

    def test_a_counter_rate_needs_a_number(self):
        self.fixtures()
        self.refused("A", counter(self.name("EXECUTION")), "a counter rate needs a numeric metric, and this one is a string")
        self.refused("B", counter(self.name("ESTOP")), "and this one is a boolean")

    def test_a_sum_needs_numbers(self):
        self.fixtures()
        self.refused("A", total((self.name("PHASE_A"), 1), (self.name("EXECUTION"), 1)), "a sum needs a numeric metric")

    def test_a_time_in_state_needs_a_string_or_a_boolean(self):
        self.fixtures()
        self.refused("A", in_state(self.name("PART_COUNT"), "ACTIVE"), "needs a string or a boolean metric")
        self.refused("B", in_state(self.name("MODE"), "1"), "needs a string or a boolean metric")

    def test_the_inputs_of_a_sum_must_share_a_unit(self):
        self.fixtures()
        message = self.refused("A", total((self.name("PHASE_A"), 1), (self.name("CURRENT"), 1)), "must share one unit")
        self.assertIn("KILOWATT", message)
        self.assertIn("AMPERE", message)
        message = self.refused("B", total((self.name("PHASE_A"), 1), (self.name("BARE_A"), 1)), "must share one unit")
        self.assertIn("no unit", message)

    def test_a_state_the_input_cannot_report(self):
        self.fixtures()
        message = self.refused("A", in_state(self.name("EXECUTION"), "ACITVE"), "is not a value")
        self.assertIn("READY, ACTIVE, STOPPED", message)
        self.refused("B", in_state(self.name("EXECUTION"), "ACTIVE", "RUNNING"), '"RUNNING" is not a value')

    def test_a_boolean_reports_true_or_false(self):
        self.fixtures()
        self.refused("A", in_state(self.name("ESTOP"), "ON"), "a boolean reports true or false")

    def test_a_name_a_device_has_declared(self):
        self.fixtures()
        gateway = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, location_scope, deployment, is_simulated, is_shadow)"
            " VALUES (%s, %s, 'cell', 'remote', false, false);", (gateway, f"T267_GW_{gateway[:8]}"))
        for n in range(2):
            self.cur.execute(
                "INSERT INTO public.devices (id, name, gateway_id, last_birth_metrics, last_birth_metrics_at)"
                " VALUES (%s, %s, %s, %s, now());",
                (str(uuid.uuid4()), f"T267_Press_{n}", gateway, [self.name("PARTS_PER_HOUR")]))
        message = self.refused("PARTS_PER_HOUR", counter(self.name("PART_COUNT")), "a name the device T267_Press_0 and 1 more declare,")
        self.assertIn(self.name("PARTS_PER_HOUR"), message)
        self.save("PARTS_PER_SHIFT", counter(self.name("PART_COUNT")))

    def test_an_archived_device_still_holds_its_name(self):
        self.fixtures()
        gateway = str(uuid.uuid4())
        self.cur.execute(
            "INSERT INTO public.gateways (id, name, location_scope, deployment, is_simulated, is_shadow)"
            " VALUES (%s, %s, 'cell', 'remote', false, false);", (gateway, f"T267_GW_{gateway[:8]}"))
        self.cur.execute(
            "INSERT INTO public.devices (id, name, gateway_id, last_birth_metrics, last_birth_metrics_at,"
            " is_archived, archived_at) VALUES (%s, %s, %s, %s, now(), true, now());",
            (str(uuid.uuid4()), "T267_Old_Press", gateway, [self.name("RATE")]))
        self.refused("RATE", counter(self.name("PART_COUNT")), "the device T267_Old_Press declares")

    def test_no_semantic_id_standard_or_permitted_values(self):
        self.fixtures()
        counted = counter(self.name("PART_COUNT"))
        self.refused("A", counted, "carries no semantic id", semantic_id="https://example.org/rate", semantic_id_type="IRI")
        self.refused("B", counted, "carries no semantic id", semantic_id_type="IRI")
        self.refused("C", counted, "names no standard", standard="MTConnect")
        self.refused("D", counted, "no permitted values", permitted_values=["1"])

    def test_a_derived_metric_is_a_double(self):
        self.fixtures()
        self.refused("A", counter(self.name("PART_COUNT")), "is a Double", datatype=INT32)

    def test_a_unit_that_is_not_the_inputs(self):
        self.fixtures()
        message = self.refused("A", counter(self.name("PART_COUNT")), "takes its unit from its inputs", units="PERCENT")
        self.assertIn("COUNT/HOUR", message)
        self.refused("B", in_state(self.name("EXECUTION"), "ACTIVE"), "takes its unit from its inputs (none)", units="PERCENT")

    def test_a_definition_of_the_wrong_shape(self):
        self.fixtures()
        part = self.name("PART_COUNT")
        for derivation, problem in (
            ({"kind": "average", "input": part}, "its kind is counter_rate, time_in_state or sum"),
            ({"input": part}, "its kind is"),
            ({"kind": "counter_rate", "input": part, "states": ["ACTIVE"]}, "a counter_rate has a kind and an input"),
            ({"kind": "counter_rate", "input": "has a space"}, "its input is a metric name"),
            ({"kind": "time_in_state", "input": part}, "a time_in_state has a kind, an input and states"),
            ({"kind": "time_in_state", "input": part, "states": []}, "at least one"),
            ({"kind": "time_in_state", "input": part, "states": ["A", "A"]}, "each state is named once"),
            ({"kind": "time_in_state", "input": part, "states": [""]}, "non-empty string"),
            ({"kind": "sum", "inputs": [{"metric": part, "sign": 2}, {"metric": part + "2", "sign": 1}]}, "1 or -1"),
            ({"kind": "sum", "inputs": [{"metric": part, "sign": 1}, {"metric": part, "sign": -1}]}, "appears once"),
            ({"kind": "sum", "inputs": [{"metric": part}, {"metric": part + "2", "sign": 1}]}, "a metric and a sign"),
            ({"kind": "sum", "inputs": part}, "two to 8 inputs"),
        ):
            with self.subTest(derivation=derivation):
                message = self.refused("SHAPE", derivation, "is malformed")
                self.assertIn(problem, message)
        self.cur.execute("SAVEPOINT refused;")
        with self.assertRaises(psycopg2.Error) as caught:
            self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, derivation) VALUES (%s, %s, '[]');",
                             (self.name("ARRAY"), DOUBLE))
        self.cur.execute("ROLLBACK TO SAVEPOINT refused;")
        self.assertEqual(caught.exception.pgcode, CHECK_VIOLATION)

    def test_the_check_holds_where_the_trigger_is_not(self):
        """The CHECK is the backstop: with the trigger off, a malformed definition is still refused."""
        self.cur.execute("ALTER TABLE public.metric_catalog DISABLE TRIGGER trg_metric_catalog_derivation;")
        self.cur.execute("SAVEPOINT refused;")
        with self.assertRaises(psycopg2.errors.CheckViolation) as caught:
            self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, derivation) VALUES (%s, %s, %s);",
                             (self.name("CHECK"), DOUBLE, json.dumps({"kind": "average"})))
        self.cur.execute("ROLLBACK TO SAVEPOINT refused;")
        self.assertEqual(caught.exception.diag.constraint_name, "metric_catalog_derivation_shape")


class FixedOnceSaved(DerivedBase):
    def test_a_measured_metric_cannot_become_derived(self):
        self.fixtures()
        measured = self.measured("LATER")
        self.update_refused("UPDATE public.metric_catalog SET derivation = %s WHERE id = %s;",
                            (json.dumps(counter(self.name("PART_COUNT"))), measured),
                            "A measured metric cannot become a derived one")

    def test_a_derived_definition_cannot_be_changed_or_removed(self):
        self.fixtures()
        derived, _, _ = self.save("UPTIME", in_state(self.name("EXECUTION"), "ACTIVE"))
        change = "UPDATE public.metric_catalog SET derivation = %s WHERE id = %s;"
        self.update_refused(change, (json.dumps(in_state(self.name("EXECUTION"), "READY")), derived),
                            "definition cannot be changed")
        self.update_refused("UPDATE public.metric_catalog SET derivation = NULL WHERE id = %s;", (derived,),
                            "definition cannot be changed")
        self.update_refused(change, (json.dumps(counter(self.name("PART_COUNT"))), derived),
                            "deprecate this one with the new one as its replacement")

    def test_a_derived_unit_follows_its_inputs(self):
        self.fixtures()
        derived, _, _ = self.save("PARTS_PER_HOUR", counter(self.name("PART_COUNT")))
        self.update_refused("UPDATE public.metric_catalog SET units = 'PERCENT' WHERE id = %s;", (derived,),
                            "unit follows its inputs and cannot be changed")
        self.update_refused("UPDATE public.metric_catalog SET units = NULL WHERE id = %s;", (derived,),
                            "unit follows its inputs")

    def test_a_derived_metric_still_takes_no_semantic_id_afterwards(self):
        self.fixtures()
        derived, _, _ = self.save("PARTS_PER_HOUR", counter(self.name("PART_COUNT")))
        self.update_refused("UPDATE public.metric_catalog SET semantic_id = 'https://example.org/x',"
                            " semantic_id_type = 'IRI' WHERE id = %s;", (derived,), "carries no semantic id")

    def test_its_name_and_datatype_stay_frozen_as_for_every_metric(self):
        self.fixtures()
        derived, _, _ = self.save("PARTS_PER_HOUR", counter(self.name("PART_COUNT")))
        self.cur.execute("SAVEPOINT refused;")
        with self.assertRaises(psycopg2.Error):
            self.cur.execute("UPDATE public.metric_catalog SET name = %s WHERE id = %s;", (self.name("OTHER"), derived))
        self.cur.execute("ROLLBACK TO SAVEPOINT refused;")

    def test_a_description_and_a_deprecation_can_change(self):
        self.fixtures()
        derived, _, _ = self.save("PARTS_PER_HOUR", counter(self.name("PART_COUNT")))
        self.cur.execute("UPDATE public.metric_catalog SET description = 'Parts an hour' WHERE id = %s;", (derived,))
        self.cur.execute("UPDATE public.metric_catalog SET deprecated = true WHERE id = %s;", (derived,))
        self.cur.execute("UPDATE public.metric_catalog SET deprecated = false, superseded_by = NULL WHERE id = %s"
                         " RETURNING deprecated, derivation;", (derived,))
        self.assertEqual(self.cur.fetchone(), (False, counter(self.name("PART_COUNT"))))

    def test_a_changed_definition_is_a_new_metric_the_old_one_names_as_its_replacement(self):
        self.fixtures()
        old, _, _ = self.save("UPTIME", in_state(self.name("EXECUTION"), "ACTIVE"))
        new, _, _ = self.save("UPTIME_2", in_state(self.name("EXECUTION"), "ACTIVE", "READY"))
        self.cur.execute("UPDATE public.metric_catalog SET deprecated = true, superseded_by = %s WHERE id = %s"
                         " RETURNING deprecated, superseded_by;", (new, old))
        self.assertEqual(self.cur.fetchone(), (True, new))
        self.cur.execute("SELECT count(*) FROM public.metric_catalog WHERE name LIKE %s AND derivation IS NOT NULL;",
                         (self.group + "/%",))
        self.assertEqual(self.cur.fetchone()[0], 2)

    def test_a_measured_metric_still_edits_as_before(self):
        self.fixtures()
        measured = self.measured("EDITED")
        self.cur.execute("UPDATE public.metric_catalog SET semantic_id = 'https://example.org/x', semantic_id_type = 'IRI',"
                         " units = 'KILOWATT', deprecated = true WHERE id = %s RETURNING derivation;", (measured,))
        self.assertIsNone(self.cur.fetchone()[0])


class AnInputKeepsItsUnit(DerivedBase):
    CHANGE = "UPDATE public.metric_catalog SET units = %s WHERE name = %s;"

    def test_the_unit_of_a_counter_rate_s_input_cannot_change(self):
        self.fixtures()
        self.save("PARTS_PER_HOUR", counter(self.name("PART_COUNT")))
        self.update_refused(self.CHANGE, ("UNIT", self.name("PART_COUNT")),
                            f"{self.name('PART_COUNT')} is an input of the derived metric {self.name('PARTS_PER_HOUR')},"
                            " so its unit cannot change")

    def test_the_unit_of_a_sum_s_input_cannot_change_whichever_input_it_is(self):
        self.fixtures()
        self.save("TOTAL", total((self.name("PHASE_A"), 1), (self.name("PHASE_B"), -1)))
        for leaf in ("PHASE_A", "PHASE_B"):
            with self.subTest(input=leaf):
                self.update_refused(self.CHANGE, ("WATT", self.name(leaf)),
                                    f"is an input of the derived metric {self.name('TOTAL')}, so its unit cannot change")

    def test_a_deprecated_derived_metric_still_holds_its_inputs_unit(self):
        self.fixtures()
        self.save("TOTAL", total((self.name("PHASE_A"), 1), (self.name("PHASE_B"), 1)), deprecated=True)
        self.update_refused(self.CHANGE, ("WATT", self.name("PHASE_A")), "so its unit cannot change")

    def test_the_reason_names_one_derived_metric_and_how_many_more(self):
        self.fixtures()
        self.save("ALPHA_RATE", counter(self.name("PHASE_A")))
        self.save("BETA_TOTAL", total((self.name("PHASE_A"), 1), (self.name("PHASE_B"), 1)))
        self.save("GAMMA_IMBALANCE", total((self.name("PHASE_A"), 1), (self.name("PHASE_C"), -1)))
        self.cur.execute("SAVEPOINT refused;")
        with self.assertRaises(psycopg2.Error) as caught:
            self.cur.execute(self.CHANGE, ("WATT", self.name("PHASE_A")))
        self.cur.execute("ROLLBACK TO SAVEPOINT refused;")
        self.assertEqual(caught.exception.pgcode, CHECK_VIOLATION)
        message = caught.exception.diag.message_primary
        self.assertIn(f"the derived metric {self.name('ALPHA_RATE')} and 2 more, so its unit cannot change", message)
        self.assertIn("nothing is stored", message)

    def test_a_refused_change_leaves_the_unit_and_the_derived_row_as_they_were(self):
        self.fixtures()
        self.save("TOTAL", total((self.name("PHASE_A"), 1), (self.name("PHASE_B"), 1)))
        self.update_refused(self.CHANGE, ("WATT", self.name("PHASE_A")), "so its unit cannot change")
        self.cur.execute("SELECT units FROM public.metric_catalog WHERE name = %s;", (self.name("PHASE_A"),))
        self.assertEqual(self.cur.fetchone()[0], "KILOWATT")

    def test_a_measured_metric_no_derived_metric_uses_still_changes_its_unit(self):
        self.fixtures()
        self.save("PARTS_PER_HOUR", counter(self.name("PART_COUNT")))
        for units in ("WATT", None, "AMPERE"):
            with self.subTest(units=units):
                self.cur.execute(self.CHANGE, (units, self.name("CURRENT")))
                self.assertEqual(self.cur.rowcount, 1)
        self.cur.execute("SELECT units FROM public.metric_catalog WHERE name = %s;", (self.name("CURRENT"),))
        self.assertEqual(self.cur.fetchone()[0], "AMPERE")

    def test_an_input_still_takes_every_other_edit_and_a_unit_it_already_has(self):
        self.fixtures()
        self.save("TOTAL", total((self.name("PHASE_A"), 1), (self.name("PHASE_B"), 1)))
        self.cur.execute("UPDATE public.metric_catalog SET description = 'Phase A', units = 'KILOWATT',"
                         " semantic_id = 'https://example.org/phase-a', semantic_id_type = 'IRI', deprecated = true"
                         " WHERE name = %s;", (self.name("PHASE_A"),))
        self.assertEqual(self.cur.rowcount, 1)

    def test_a_time_in_state_input_still_takes_a_permitted_values_edit_and_a_unit(self):
        """A time in state has no unit to follow, and the states it counts are not held to the list."""
        self.fixtures()
        self.save("UPTIME", in_state(self.name("EXECUTION"), "ACTIVE"))
        self.cur.execute("UPDATE public.metric_catalog SET permitted_values = %s WHERE name = %s;",
                         (["READY", "ACTIVE", "STOPPED", "FEED_HOLD"], self.name("EXECUTION")))
        self.assertEqual(self.cur.rowcount, 1)
        self.cur.execute(self.CHANGE, ("COUNT", self.name("EXECUTION")))
        self.assertEqual(self.cur.rowcount, 1)


class WhoWrites(DerivedBase):
    def setUp(self):
        super().setUp()
        self.cur.execute("SELECT name, id FROM public.roles;")
        roles = dict(self.cur.fetchall())
        for user_id, role in PEOPLE.items():
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id}@derived.test"),
            )
            self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                             " ON CONFLICT DO NOTHING;", (user_id, roles[role]))
        self.switch(False)

    def switch(self, on):
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("UPDATE public.system_settings SET value = %s::jsonb WHERE key = %s;",
                         ("true" if on else "false", SWITCH))

    def as_person(self, user_id, aal="aal1", role="authenticated"):
        self.cur.execute("RESET ROLE;")
        claims = {"sub": user_id, "role": role, "aal": aal}
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))
        self.cur.execute("SELECT set_config('role', %s, true);", (role,))

    def insert_as(self, leaf, user_id, **who):
        self.as_person(user_id, **who)
        self.cur.execute("SAVEPOINT attempt;")
        try:
            self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, derivation) VALUES (%s, %s, %s)"
                             " RETURNING id;", (self.name(leaf), DOUBLE, json.dumps(counter(self.name("PART_COUNT")))))
            return self.cur.fetchone()[0], None
        except psycopg2.Error as err:
            self.cur.execute("ROLLBACK TO SAVEPOINT attempt;")
            return None, err
        finally:
            self.cur.execute("RESET ROLE;")

    def test_an_administrator_adds_one(self):
        self.fixtures()
        row, err = self.insert_as("PARTS_PER_HOUR", ADMIN_ID)
        self.assertIsNone(err)
        self.assertIsNotNone(row)

    def test_a_manager_an_operator_and_an_auditor_are_refused(self):
        self.fixtures()
        for user_id in (MANAGER_ID, OPERATOR_ID, AUDITOR_ID):
            with self.subTest(user=user_id):
                _, err = self.insert_as("PARTS_PER_HOUR", user_id)
                self.assertEqual(err.pgcode, INSUFFICIENT_PRIVILEGE)

    def test_anon_is_refused(self):
        self.fixtures()
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SET LOCAL ROLE anon;")
        self.cur.execute("SAVEPOINT attempt;")
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, derivation) VALUES (%s, %s, %s);",
                             (self.name("X"), DOUBLE, json.dumps(counter(self.name("PART_COUNT")))))
        self.cur.execute("ROLLBACK TO SAVEPOINT attempt;")
        self.cur.execute("RESET ROLE;")

    def test_with_the_second_factor_required_a_first_factor_session_is_refused(self):
        self.fixtures()
        self.switch(True)
        _, err = self.insert_as("PARTS_PER_HOUR", ADMIN_ID, aal="aal1")
        self.assertEqual(err.pgcode, INSUFFICIENT_PRIVILEGE)
        self.assertIn("MFA is required", err.diag.message_primary)
        row, err = self.insert_as("PARTS_PER_HOUR", ADMIN_ID, aal="aal2")
        self.assertIsNone(err)
        self.assertIsNotNone(row)

    def test_an_administrator_sees_the_trigger_s_reason(self):
        self.fixtures()
        self.as_person(ADMIN_ID)
        self.cur.execute("SAVEPOINT attempt;")
        with self.assertRaises(psycopg2.Error) as caught:
            self.cur.execute("INSERT INTO public.metric_catalog (name, datatype, derivation) VALUES (%s, %s, %s);",
                             (self.name("X"), DOUBLE, json.dumps(counter(self.name("NOT_THERE")))))
        self.cur.execute("ROLLBACK TO SAVEPOINT attempt;")
        self.assertEqual(caught.exception.pgcode, CHECK_VIOLATION)
        self.assertIn("is not in the catalogue", caught.exception.diag.message_primary)

    def test_every_signed_in_role_reads_a_derived_row(self):
        self.fixtures()
        self.save("PARTS_PER_HOUR", counter(self.name("PART_COUNT")))
        for user_id in PEOPLE:
            with self.subTest(user=user_id):
                self.as_person(user_id)
                self.cur.execute("SELECT derivation, units FROM public.metric_catalog WHERE name = %s;",
                                 (self.name("PARTS_PER_HOUR"),))
                self.assertEqual(self.cur.fetchall(), [(counter(self.name("PART_COUNT")), "COUNT/HOUR")])
                self.cur.execute("RESET ROLE;")

    def test_the_audit_trail_files_the_save_as_any_catalogue_change(self):
        self.fixtures()
        row, err = self.insert_as("PARTS_PER_HOUR", ADMIN_ID)
        self.assertIsNone(err)
        self.cur.execute("SELECT action, changed_by::text, new_data -> 'derivation', new_data ->> 'units', audit_domain"
                         " FROM public.audit_trail WHERE entity_type = 'metric_catalog' AND entity_id = %s;", (row,))
        action, changed_by, derivation, units, domain = self.cur.fetchone()
        self.assertEqual((action, changed_by, units), ("INSERT", ADMIN_ID, "COUNT/HOUR"))
        self.assertEqual(derivation, counter(self.name("PART_COUNT")))
        self.assertEqual(domain, "asset", "filed where every catalogue change is")


class Replay(DerivedBase):
    def test_the_migration_replays_to_the_same_objects(self):
        """db-init replays every file on every boot: the run must neither fail nor re-create a thing."""
        self.cur.execute("SELECT t.oid, c.oid FROM pg_trigger t, pg_constraint c"
                         " WHERE t.tgname = 'trg_metric_catalog_derivation'"
                         " AND c.conname = 'metric_catalog_derivation_shape';")
        before = self.cur.fetchall()
        self.assertEqual(len(before), 1)
        self.cur.execute(MIGRATION.read_text(encoding="utf-8"))
        self.cur.execute("SELECT t.oid, c.oid FROM pg_trigger t, pg_constraint c"
                         " WHERE t.tgname = 'trg_metric_catalog_derivation'"
                         " AND c.conname = 'metric_catalog_derivation_shape';")
        self.assertEqual(self.cur.fetchall(), before)


if __name__ == "__main__":
    unittest.main()
