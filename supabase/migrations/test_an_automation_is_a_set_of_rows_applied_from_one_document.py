"""
An automation is a set of rows, applied from one document (0255, 0256, 0257).

    python supabase/migrations/test_an_automation_is_a_set_of_rows_applied_from_one_document.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * The three tables: every signed-in role reads them, nobody writes them directly, anon touches
    nothing, and their CHECKs and keys hold.
  * Who writes: a Shopfloor Manager and an Administrator apply, enable, disable and delete;
    an Operator, an Auditor and a machine identity are refused, and so is anon. With
    security.require_mfa_for_managers on, a covered person needs a session that gave its code.
  * apply_automations(): a dry run writes nothing; one refusal writes nothing at all; a new
    automation, an unchanged one and a changed one are told apart; a re-upload finds an automation
    by its key and keeps the trigger rows that still name the same device and metric; a document
    never deletes what it leaves out; a list of devices is one row each and renders back as a list.
  * automations_document(): the round trip reports every automation unchanged, and names each
    device and its place.
  * The Audit Trail: one row per automation per act, in the asset lane, in the class its action
    has, naming the person, with the automation before and after.
  * The lifecycle: archiving a device archives its trigger rows, restoring brings them back and
    enables nothing, deleting removes them; an automation left with no live trigger is disabled
    with its reason; and the open alerts of whatever stops watching are resolved, and no others.
  * automations_for_entity(): the automations that name a device, and the site-wide ones that apply
    to a modelled one, one row per reason.

EVERY TEST ROLLS BACK. platform_alerts is in the realtime publication: a committed row reaches
every connected dashboard as a firing alert.
"""
import json
import os
import unittest
import uuid

import psycopg2
import psycopg2.errors
from psycopg2.extras import Json

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

OPERATOR_ID = "a0d17257-0000-4000-8000-0000000257a1"
MANAGER_ID = "a0d17257-0000-4000-8000-0000000257a2"
ADMIN_ID = "a0d17257-0000-4000-8000-0000000257a3"
AUDITOR_ID = "a0d17257-0000-4000-8000-0000000257a4"
MACHINE_ID = "a0d17257-0000-4000-8000-0000000257a5"
PEOPLE = ((OPERATOR_ID, "Operator"), (MANAGER_ID, "Shopfloor_Manager"), (ADMIN_ID, "Administrator"),
          (AUDITOR_ID, "Auditor"))

# Differing in the first block: a device's sparkplug_id is its uuid's first 21 hex characters.
DEV_A = "a1d17257-1000-4000-8000-000000000001"
DEV_B = "b1d17257-1000-4000-8000-000000000002"
DEV_C = "c1d17257-1000-4000-8000-000000000003"
METRIC = "Test_0257/Spindle_Temperature"
METRIC_2 = "Test_0257/Spindle_Load"
SWITCH = "security.require_mfa_for_managers"
ACTIONS = ["AUTOMATION_CREATED", "AUTOMATION_CHANGED", "AUTOMATION_ENABLED", "AUTOMATION_DISABLED",
           "AUTOMATION_DELETED"]
ACTION = {"action": "alert", "severity": "warning"}


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


def trigger(device=DEV_A, metric=METRIC, **over):
    t = {"trigger": "threshold", "device": device, "metric": metric, "above": 80, "for": "5m"}
    t.update(over)
    return {k: v for k, v in t.items() if v is not None}


def automation(key="lathe-3-spindle-hot", triggers=None, **over):
    a = {"id": key, "alias": "Lathe 3 spindle bearing hot", "description": "Check the coolant first.",
         "enabled": True, "triggers": [trigger()] if triggers is None else triggers, "actions": [dict(ACTION)]}
    a.update(over)
    return a


class AutomationsBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.apply_automations(jsonb, boolean)') IS NOT NULL;")
        if not self.cur.fetchone()[0]:
            self.skipTest("0256 is not applied to this database")
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        for user_id, role in PEOPLE:
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, self.email(user_id)))
            self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                             " ON CONFLICT (user_id, role_id) DO NOTHING;", (user_id, roles[role]))
        self.cur.execute("INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                         " VALUES (%s, NULL, '', now()) ON CONFLICT (id) DO NOTHING;", (MACHINE_ID,))
        self.cur.execute("UPDATE public.system_settings SET value = 'false'::jsonb WHERE key = %s;", (SWITCH,))

        self.cur.execute("INSERT INTO public.areas (name) VALUES ('Test_0257_Machining') RETURNING id;")
        area = self.cur.fetchone()[0]
        self.cur.execute("INSERT INTO public.cells (name, area_id) VALUES ('Test_0257_Cell_2', %s) RETURNING id;", (area,))
        cell = self.cur.fetchone()[0]
        for device, name in ((DEV_A, "Test_0257_Lathe_3"), (DEV_B, "Test_0257_Lathe_4"), (DEV_C, "Test_0257_Press")):
            self.cur.execute("INSERT INTO public.devices (id, name, cell_id) VALUES (%s, %s, %s);",
                             (device, name, cell if device == DEV_A else None))
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype) VALUES (%s, 10), (%s, 4);", (METRIC, METRIC_2))

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    @staticmethod
    def email(user_id):
        return f"{user_id[-4:]}@automations.test"

    def claims(self, user_id, aal="aal1"):
        self.cur.execute("RESET ROLE;")
        claims = {"sub": user_id, "role": "authenticated", "aal": aal}
        if user_id != MACHINE_ID:
            claims["email"] = self.email(user_id)
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))
        self.cur.execute("SET LOCAL ROLE authenticated;")

    def owner(self):
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")

    def as_person(self, user_id, sql, args=(), aal="aal1"):
        """Run `sql` as PostgREST would for a person's token. A refusal rolls back to the savepoint,
        so the test can go on, and is raised."""
        self.cur.execute("SAVEPOINT automations_call;")
        try:
            self.claims(user_id, aal)
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT automations_call;")
            raise
        finally:
            self.owner()
        self.cur.execute("RELEASE SAVEPOINT automations_call;")
        return rows

    def apply(self, document, dry_run=False, user_id=MANAGER_ID, aal="aal1"):
        return self.as_person(user_id, "SELECT public.apply_automations(%s::jsonb, %s);",
                              (Json(document), dry_run), aal)[0][0]

    def document(self, keys=None, user_id=OPERATOR_ID):
        return self.as_person(user_id, "SELECT public.automations_document(%s);", (keys,))[0][0]

    def row(self, key):
        self.cur.execute("SELECT id, alias, description, enabled FROM public.automations WHERE key = %s;", (key,))
        return self.cur.fetchone()

    def triggers(self, key, archived=False):
        self.cur.execute(
            "SELECT t.id, t.position, t.device_position, t.entity_id::text, t.metric_name, t.comparison,"
            "       t.threshold, t.hold_seconds, t.is_archived"
            "  FROM public.automation_triggers t JOIN public.automations a ON a.id = t.automation_id"
            " WHERE a.key = %s AND (%s OR NOT t.is_archived) ORDER BY t.position, t.device_position;", (key, archived))
        return self.cur.fetchall()

    def counts(self):
        self.cur.execute("SELECT (SELECT count(*) FROM public.automations),"
                         "       (SELECT count(*) FROM public.automation_triggers),"
                         "       (SELECT count(*) FROM public.automation_actions),"
                         "       (SELECT count(*) FROM public.audit_trail WHERE entity_type = 'automations');")
        return self.cur.fetchone()

    def audit(self, action=None):
        self.cur.execute(
            "SELECT action, entity_id::text, audit_domain, changed_by::text, actor_source, old_data, new_data,"
            "       public.audit_event_class(action, entity_type, audit_domain, old_data, new_data)"
            "  FROM public.audit_trail WHERE entity_type = 'automations' AND (%s::text IS NULL OR action = %s)"
            " ORDER BY id;", (action, action))
        return self.cur.fetchall()

    def alert(self, trigger_id, entity_id, metric=METRIC, status="firing"):
        """An occurrence the evaluator would write, firing since an hour ago, as the owner."""
        self.owner()
        self.cur.execute("SELECT sparkplug_id FROM public.devices WHERE id = %s;", (entity_id,))
        sparkplug_id = self.cur.fetchone()[0]
        self.cur.execute(
            "INSERT INTO public.platform_alerts (fingerprint, entity_type, entity_id, sparkplug_id, alert_name,"
            "       severity, status, starts_at, ends_at)"
            " VALUES (public.automation_alert_fingerprint(%s, %s, %s), 'device', %s, %s, 'Spindle hot', 'warning',"
            "         %s, now() - interval '1 hour', CASE WHEN %s = 'resolved' THEN now() END) RETURNING id;",
            (trigger_id, entity_id, metric, entity_id, sparkplug_id, status, status))
        return self.cur.fetchone()[0]

    def alert_status(self, alert_id):
        self.cur.execute("SELECT status, ends_at IS NOT NULL FROM public.platform_alerts WHERE id = %s;", (alert_id,))
        return self.cur.fetchone()

    def assertRefused(self, code, fn, *args, **kwargs):
        with self.assertRaises(psycopg2.Error) as caught:
            fn(*args, **kwargs)
        self.assertEqual(caught.exception.pgcode, code, str(caught.exception))
        return caught.exception


class Access(AutomationsBase):
    def test_every_signed_in_role_reads_and_anon_does_not(self):
        self.apply([automation()])
        for user_id in (OPERATOR_ID, MANAGER_ID, ADMIN_ID, AUDITOR_ID, MACHINE_ID):
            for table in ("automations", "automation_triggers", "automation_actions"):
                with self.subTest(user=user_id, table=table):
                    rows = self.as_person(user_id, f"SELECT count(*) FROM public.{table};")
                    self.assertEqual(rows, [(1,)])
        for table in ("automations", "automation_triggers", "automation_actions"):
            self.cur.execute("SAVEPOINT anon_read;")
            self.cur.execute("SET LOCAL ROLE anon;")
            with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
                self.cur.execute(f"SELECT count(*) FROM public.{table};")
            self.cur.execute("ROLLBACK TO SAVEPOINT anon_read;")

    def test_nobody_writes_a_table_directly(self):
        self.apply([automation()])
        statements = [
            "INSERT INTO public.automations (key, alias) VALUES ('direct', 'Direct');",
            "UPDATE public.automations SET alias = 'Changed';",
            "DELETE FROM public.automations;",
            "UPDATE public.automation_triggers SET threshold = 1;",
            "DELETE FROM public.automation_triggers;",
            "UPDATE public.automation_actions SET severity = 'info';",
        ]
        for user_id in (MANAGER_ID, ADMIN_ID):
            for statement in statements:
                with self.subTest(user=user_id, statement=statement):
                    self.assertRefused("42501", self.as_person, user_id, statement)

    def test_anon_may_execute_none_of_the_functions(self):
        for signature in ("apply_automations(jsonb, boolean)", "automations_document(text[])",
                          "set_automation_enabled(text, boolean)", "delete_automation(text)",
                          "automations_for_entity(uuid)", "automation_stored_document(uuid)"):
            with self.subTest(function=signature):
                self.cur.execute("SELECT has_function_privilege('anon', %s, 'EXECUTE'),"
                                 "       has_function_privilege('authenticated', %s, 'EXECUTE');",
                                 (f"public.{signature}", f"public.{signature}"))
                self.assertEqual(self.cur.fetchone(), (False, True))

    def test_only_a_shopfloor_manager_or_an_administrator_writes(self):
        self.apply([automation()], user_id=ADMIN_ID)
        calls = [
            ("SELECT public.apply_automations(%s::jsonb, true);", (Json([automation("other")]),)),
            ("SELECT public.apply_automations(%s::jsonb, false);", (Json([automation("other")]),)),
            ("SELECT public.set_automation_enabled('lathe-3-spindle-hot', false);", ()),
            ("SELECT public.delete_automation('lathe-3-spindle-hot');", ()),
        ]
        for user_id in (OPERATOR_ID, AUDITOR_ID, MACHINE_ID):
            for sql, args in calls:
                with self.subTest(user=user_id, call=sql):
                    self.assertRefused("42501", self.as_person, user_id, sql, args)
        self.assertEqual(self.counts()[0], 1)
        self.as_person(MANAGER_ID, "SELECT public.set_automation_enabled('lathe-3-spindle-hot', false);")
        self.as_person(ADMIN_ID, "SELECT public.set_automation_enabled('lathe-3-spindle-hot', true);")

    def test_with_the_switch_on_a_covered_person_needs_a_session_that_gave_its_code(self):
        self.owner()
        self.cur.execute("UPDATE public.system_settings SET value = 'true'::jsonb WHERE key = %s;", (SWITCH,))
        for user_id in (MANAGER_ID, ADMIN_ID):
            for sql, args in (("SELECT public.apply_automations(%s::jsonb, true);", (Json([automation()]),)),
                              ("SELECT public.set_automation_enabled('x', true);", ()),
                              ("SELECT public.delete_automation('x');", ())):
                with self.subTest(user=user_id, call=sql):
                    err = self.assertRefused("42501", self.as_person, user_id, sql, args)
                    self.assertEqual(err.diag.message_detail, "mfa_required")
        self.assertEqual(self.apply([automation()], user_id=MANAGER_ID, aal="aal2")[0]["status"], "new")
        # Reading is not a write.
        self.assertEqual(self.document(user_id=OPERATOR_ID)["automations"][0]["id"], "lathe-3-spindle-hot")

    def test_the_tables_hold_their_checks(self):
        self.owner()
        self.apply([automation()])
        self.cur.execute("SELECT id FROM public.automations WHERE key = 'lathe-3-spindle-hot';")
        auto = self.cur.fetchone()[0]
        bad = [
            "INSERT INTO public.automations (key, alias) VALUES ('Bad Key', 'x')",
            "INSERT INTO public.automations (key, alias) VALUES ('ok', ' padded')",
            "INSERT INTO public.automations (key, alias) VALUES ('lathe-3-spindle-hot', 'a duplicate key')",
            f"INSERT INTO public.automation_actions (automation_id, position, kind, severity) VALUES ('{auto}', 1, 'alert', 'fatal')",
            f"INSERT INTO public.automation_actions (automation_id, position, kind, severity) VALUES ('{auto}', 0, 'alert', 'info')",
            f"INSERT INTO public.automation_triggers (automation_id, position, kind) VALUES ('{auto}', 0, 'threshold')",
            f"INSERT INTO public.automation_triggers (automation_id, position, kind, entity_id, metric_name, comparison, threshold)"
            f" VALUES ('{auto}', 0, 'threshold', '{DEV_A}', '{METRIC}', 'equals', 5)",
            f"INSERT INTO public.automation_triggers (automation_id, position, kind, entity_id, metric_name, comparison, threshold,"
            f" hold_seconds) VALUES ('{auto}', 0, 'threshold', '{DEV_A}', '{METRIC}', 'above', 5, -1)",
            f"INSERT INTO public.automation_triggers (automation_id, position, kind, entity_id, metric_name, comparison, threshold)"
            f" VALUES ('{auto}', 0, 'threshold', '{DEV_A}', 'Test_0257/Not_In_The_Catalogue', 'above', 5)",
            f"INSERT INTO public.automation_triggers (automation_id, position, kind, entity_id, metric_name, comparison, threshold,"
            f" is_archived) VALUES ('{auto}', 0, 'threshold', '{DEV_A}', '{METRIC}', 'above', 5, true)",
        ]
        for statement in bad:
            with self.subTest(statement=statement):
                self.cur.execute("SAVEPOINT check_row;")
                with self.assertRaises(psycopg2.Error):
                    self.cur.execute(statement)
                self.cur.execute("ROLLBACK TO SAVEPOINT check_row;")
        # A kind with no device and no metric is a site-wide row, and the table takes it.
        self.cur.execute("INSERT INTO public.automation_triggers (automation_id, position, kind) VALUES (%s, 5, 'stopped_reporting');", (auto,))
        # A metric a trigger uses cannot be deleted from the catalogue.
        self.cur.execute("SAVEPOINT metric;")
        with self.assertRaises(psycopg2.errors.ForeignKeyViolation):
            self.cur.execute("DELETE FROM public.metric_catalog WHERE name = %s;", (METRIC,))
        self.cur.execute("ROLLBACK TO SAVEPOINT metric;")


class Applying(AutomationsBase):
    def test_a_dry_run_writes_nothing_and_says_what_it_would_do(self):
        before = self.counts()
        results = self.apply([automation(), automation("press-2-hot", alias="Press 2 hot")], dry_run=True)
        self.assertEqual([(r["index"], r["key"], r["status"], r["id"], r["reasons"]) for r in results],
                         [(0, "lathe-3-spindle-hot", "new", None, []), (1, "press-2-hot", "new", None, [])])
        self.assertEqual(self.counts(), before)

    def test_one_refusal_writes_nothing_at_all(self):
        before = self.counts()
        good, bad = automation(), automation("press-2-hot", alias="")
        results = self.apply([good, bad])
        self.assertEqual([r["status"] for r in results], ["new", "refused"])
        self.assertEqual(results[1]["reasons"][0]["path"], "$[1].alias")
        self.assertEqual(self.counts(), before)
        self.assertEqual([r["status"] for r in self.apply([good])], ["new"])

    def test_a_new_automation_is_written_whole_and_an_unchanged_one_writes_nothing(self):
        results = self.apply([automation(triggers=[trigger(device=[DEV_A, DEV_B], above=None, below=10.5, **{"for": "90s"})])])
        self.assertEqual((results[0]["status"], results[0]["changes"]), ("new", []))
        self.assertIsNotNone(results[0]["id"])
        _, alias, description, enabled = self.row("lathe-3-spindle-hot")
        self.assertEqual((alias, description, enabled), ("Lathe 3 spindle bearing hot", "Check the coolant first.", True))
        rows = self.triggers("lathe-3-spindle-hot")
        self.assertEqual([(r[1], r[2], r[3], r[4], r[5], r[6], r[7]) for r in rows],
                         [(0, 0, DEV_A, METRIC, "below", 10.5, 90), (0, 1, DEV_B, METRIC, "below", 10.5, 90)])
        self.cur.execute("SELECT kind, severity FROM public.automation_actions;")
        self.assertEqual(self.cur.fetchall(), [("alert", "warning")])
        self.assertEqual(len(self.audit()), 1)

        again = self.apply([automation(triggers=[trigger(device=[DEV_A, DEV_B], above=None, below=10.5, **{"for": "90s"})])])
        self.assertEqual((again[0]["status"], again[0]["id"]), ("unchanged", results[0]["id"]))
        self.assertEqual(len(self.audit()), 1, "an unchanged automation wrote an Audit Trail row")

    def test_a_re_upload_finds_the_automation_by_its_key_and_keeps_the_rows_that_still_fit(self):
        self.apply([automation(triggers=[trigger(device=[DEV_A, DEV_B])])])
        before = {r[3]: r[0] for r in self.triggers("lathe-3-spindle-hot")}
        changed = automation(alias="Lathe 3 is hot", triggers=[trigger(device=[DEV_A, DEV_B], above=85, **{"for": "1h"})])
        results = self.apply([changed])
        self.assertEqual((results[0]["status"], results[0]["changes"]), ("changed", ["alias", "triggers"]))
        self.assertEqual(self.counts()[0], 1)
        after = {r[3]: (r[0], r[6], r[7]) for r in self.triggers("lathe-3-spindle-hot")}
        self.assertEqual({k: v[0] for k, v in after.items()}, before, "the rows that name the same device and metric kept their ids")
        self.assertEqual({v[1:] for v in after.values()}, {(85.0, 3600)})
        self.assertEqual(self.row("lathe-3-spindle-hot")[1], "Lathe 3 is hot")
        # A device dropped from the list loses its row; the one that stays keeps its own.
        results = self.apply([automation(alias="Lathe 3 is hot", triggers=[trigger(device=DEV_A, above=85, **{"for": "1h"})])])
        self.assertEqual(results[0]["status"], "changed")
        self.assertEqual({r[3]: r[0] for r in self.triggers("lathe-3-spindle-hot")}, {DEV_A: before[DEV_A]})

    def test_a_document_never_deletes(self):
        self.apply([automation(), automation("press-2-hot", alias="Press 2 hot", triggers=[trigger(DEV_C)])])
        results = self.apply([automation(alias="Only this one is in the file")])
        self.assertEqual([r["status"] for r in results], ["changed"])
        self.assertEqual(self.counts()[:1], (2,))
        self.assertIsNotNone(self.row("press-2-hot"))

    def test_the_switch_is_a_change_of_its_own_in_the_audit_trail(self):
        self.apply([automation()])
        self.assertEqual(self.apply([automation(enabled=False)])[0]["changes"], ["enabled"])
        self.assertEqual(self.apply([automation(enabled=True)])[0]["changes"], ["enabled"])
        self.assertEqual([r[0] for r in self.audit()], ["AUTOMATION_CREATED", "AUTOMATION_DISABLED", "AUTOMATION_ENABLED"])

    def test_the_document_renders_back_and_applies_as_unchanged(self):
        self.apply([automation(triggers=[trigger(device=[DEV_A, DEV_B], **{"for": "60s"}), trigger(DEV_C, METRIC_2, above=None, below=-3.25, **{"for": None})]),
                    automation("press-2-hot", alias="Press 2 hot", description="", enabled=False, triggers=[])])
        document = self.document()
        self.assertEqual([a["id"] for a in document["automations"]], ["lathe-3-spindle-hot", "press-2-hot"])
        first = document["automations"][0]
        self.assertEqual(first["triggers"][0]["device"], [DEV_A, DEV_B])
        self.assertEqual(first["triggers"][0]["for"], "1m", "60s is written as the largest unit that divides it")
        self.assertEqual(first["triggers"][1]["device"], DEV_C)
        self.assertEqual(first["triggers"][1]["below"], -3.25)
        self.assertNotIn("for", first["triggers"][1])
        self.assertEqual(document["automations"][1]["triggers"], [])
        self.assertEqual(document["devices"][DEV_A], {"name": "Test_0257_Lathe_3", "place": "Test_0257_Cell_2 · Test_0257_Machining"})
        self.assertEqual(document["devices"][DEV_B], {"name": "Test_0257_Lathe_4", "place": None})
        results = self.apply(document["automations"], dry_run=True)
        self.assertEqual([r["status"] for r in results], ["unchanged", "unchanged"])
        # Asked for by key, and only those.
        self.assertEqual([a["id"] for a in self.document(["press-2-hot"])["automations"]], ["press-2-hot"])
        self.assertEqual(list(self.document(["press-2-hot"])["devices"]), [])
        self.assertEqual(self.document(["no-such-automation"]), {"automations": [], "devices": {}})

    def test_every_refusal_has_a_path_and_a_sentence_and_all_of_them_are_reported(self):
        results = self.apply([{"id": "Bad", "mode": "single", "triggers": [{"trigger": "state", "above": 1, "below": 2}], "actions": []}])
        paths = sorted(r["path"] for r in results[0]["reasons"])
        self.assertEqual(paths, ["$[0].actions", "$[0].alias", "$[0].id", "$[0].mode", "$[0].triggers[0]",
                                 "$[0].triggers[0].device", "$[0].triggers[0].metric", "$[0].triggers[0].trigger"])
        self.assertTrue(all(r["message"] for r in results[0]["reasons"]))
        self.assertIsNone(results[0]["key"], "a bad id is not echoed as a key")

    def test_a_metric_the_catalogue_lacks_or_a_device_that_is_gone_or_archived_is_refused(self):
        self.owner()
        self.cur.execute("UPDATE public.devices SET is_archived = true, archived_at = now() WHERE id = %s;", (DEV_C,))
        cases = [
            (trigger(DEV_A, "Test_0257/Nothing"), "$[0].triggers[0].metric", "not in the metric catalogue"),
            (trigger(DEV_C), "$[0].triggers[0].device", "is archived"),
            (trigger("e1d17257-1000-4000-8000-0000000000ff"), "$[0].triggers[0].device", "No device has the id"),
            (trigger(DEV_A, METRIC_2, above=1), None, None),
        ]
        self.cur.execute("INSERT INTO public.metric_catalog (name, datatype) VALUES ('Test_0257/Mode', 12);")
        cases.append((trigger(DEV_A, "Test_0257/Mode"), "$[0].triggers[0].metric", "is not a number"))
        for t, path, message in cases:
            with self.subTest(path=path, message=message):
                reasons = self.apply([automation(triggers=[t])], dry_run=True)[0]["reasons"]
                if path is None:
                    self.assertEqual(reasons, [])
                else:
                    self.assertEqual([r["path"] for r in reasons], [path])
                    self.assertIn(message, reasons[0]["message"])

    def test_a_file_is_bounded_by_the_devices_it_names(self):
        triggers = [trigger([str(uuid.uuid4()) for _ in range(500)]) for _ in range(21)]
        results = self.apply([automation(triggers=triggers)], dry_run=True)
        self.assertEqual([(r["index"], r["status"], r["reasons"][0]["path"]) for r in results], [(None, "refused", "$")])
        self.assertIn("10000 devices", results[0]["reasons"][0]["message"])
        self.assertEqual(self.counts()[0], 0)

    def test_two_automations_with_one_id_in_a_file_are_refused(self):
        results = self.apply([automation(), automation(alias="Again")], dry_run=True)
        self.assertEqual([r["status"] for r in results], ["new", "refused"])
        self.assertEqual(results[1]["reasons"][0]["path"], "$[1].id")


class Writers(AutomationsBase):
    def test_enabling_and_disabling_is_audited_once_and_a_repeat_writes_nothing(self):
        self.apply([automation()])
        row = self.as_person(MANAGER_ID, "SELECT enabled, alias FROM public.set_automation_enabled('lathe-3-spindle-hot', false);")
        self.assertEqual(row, [(False, "Lathe 3 spindle bearing hot")])
        self.as_person(MANAGER_ID, "SELECT public.set_automation_enabled('lathe-3-spindle-hot', false);")
        self.assertEqual([r[0] for r in self.audit("AUTOMATION_DISABLED")], ["AUTOMATION_DISABLED"])
        self.as_person(ADMIN_ID, "SELECT public.set_automation_enabled('lathe-3-spindle-hot', true);")
        enabled = self.audit("AUTOMATION_ENABLED")
        self.assertEqual(len(enabled), 1)
        self.assertEqual(enabled[0][3], ADMIN_ID, "the row names who did it")
        self.assertEqual(enabled[0][5]["enabled"], False)
        self.assertEqual(enabled[0][6]["enabled"], True)
        self.assertEqual(enabled[0][6]["name"], "Lathe 3 spindle bearing hot")

    def test_an_automation_with_no_live_trigger_cannot_be_enabled(self):
        self.apply([automation(triggers=[], enabled=False)])
        err = self.assertRefused("23514", self.as_person, MANAGER_ID, "SELECT public.set_automation_enabled('lathe-3-spindle-hot', true);")
        self.assertIn("no live trigger", err.diag.message_primary)

    def test_an_unknown_key_is_a_404(self):
        for sql in ("SELECT public.set_automation_enabled('nothing', true);", "SELECT public.delete_automation('nothing');"):
            with self.subTest(sql=sql):
                err = self.assertRefused("PGRST", self.as_person, MANAGER_ID, sql)
                self.assertEqual(json.loads(err.diag.message_primary)["code"], "P0002")

    def test_deleting_takes_its_rows_and_leaves_the_automation_as_it_was_in_the_audit_row(self):
        self.apply([automation(triggers=[trigger(device=[DEV_A, DEV_B])])])
        self.as_person(MANAGER_ID, "SELECT public.delete_automation('lathe-3-spindle-hot');")
        self.assertEqual(self.counts()[:3], (0, 0, 0))
        deleted = self.audit("AUTOMATION_DELETED")
        self.assertEqual(len(deleted), 1)
        self.assertEqual((deleted[0][2], deleted[0][3], deleted[0][4], deleted[0][7]), ("asset", MANAGER_ID, "user", "lifecycle"))
        self.assertEqual(deleted[0][5]["triggers"][0]["device"], [DEV_A, DEV_B])
        self.assertIsNone(deleted[0][6])


class TheAuditTrail(AutomationsBase):
    def test_each_act_is_filed_in_the_asset_lane_in_its_own_class(self):
        self.apply([automation()])
        self.apply([automation(alias="Renamed")])
        self.as_person(MANAGER_ID, "SELECT public.set_automation_enabled('lathe-3-spindle-hot', false);")
        self.as_person(MANAGER_ID, "SELECT public.set_automation_enabled('lathe-3-spindle-hot', true);")
        self.as_person(MANAGER_ID, "SELECT public.delete_automation('lathe-3-spindle-hot');")
        rows = self.audit()
        self.assertEqual([(r[0], r[2], r[3], r[4], r[7]) for r in rows], [
            ("AUTOMATION_CREATED", "asset", MANAGER_ID, "user", "created"),
            ("AUTOMATION_CHANGED", "asset", MANAGER_ID, "user", "configuration"),
            ("AUTOMATION_DISABLED", "asset", MANAGER_ID, "user", "operational"),
            ("AUTOMATION_ENABLED", "asset", MANAGER_ID, "user", "operational"),
            ("AUTOMATION_DELETED", "asset", MANAGER_ID, "user", "lifecycle"),
        ])
        changed = rows[1]
        self.assertEqual((changed[5]["alias"], changed[6]["alias"], changed[6]["name"]),
                         ("Lathe 3 spindle bearing hot", "Renamed", "Renamed"))
        for action in ACTIONS:
            self.cur.execute("SELECT count(*) FROM public.audit_trail_action_kinds() WHERE action = %s AND entity_type = 'automations';", (action,))
            self.assertEqual(self.cur.fetchone(), (1,), action)

    def test_the_asset_lane_s_readers_read_them_and_an_operator_does_not(self):
        self.apply([automation()])
        for user_id, expected in ((AUDITOR_ID, 1), (ADMIN_ID, 1), (MANAGER_ID, 1), (OPERATOR_ID, 0)):
            with self.subTest(user=user_id):
                rows = self.as_person(user_id, "SELECT count(*) FROM public.audit_trail WHERE entity_type = 'automations';")
                self.assertEqual(rows, [(expected,)])


class TheLifecycle(AutomationsBase):
    def setUp(self):
        super().setUp()
        self.apply([
            automation("lathe-3-spindle-hot", triggers=[trigger(DEV_A)]),
            automation("both-lathes", alias="Both lathes", triggers=[trigger([DEV_A, DEV_B]), trigger(DEV_C, METRIC_2, above=1)]),
            automation("press-2-hot", alias="Press 2 hot", triggers=[trigger(DEV_C)]),
        ])

    def archive(self, device, archived=True):
        self.as_person(MANAGER_ID, "UPDATE public.devices SET is_archived = %s, archived_at = CASE WHEN %s THEN now() END"
                                   " WHERE id = %s;", (archived, archived, device))

    def test_archiving_a_device_archives_its_rows_and_disables_what_it_leaves_without_a_trigger(self):
        self.archive(DEV_A)
        self.assertEqual([(r[3], r[8]) for r in self.triggers("lathe-3-spindle-hot", archived=True)], [(DEV_A, True)])
        self.assertEqual(self.triggers("lathe-3-spindle-hot"), [])
        self.assertEqual(self.row("lathe-3-spindle-hot")[3], False)
        # Another trigger keeps the automation on.
        self.assertEqual([r[3] for r in self.triggers("both-lathes")], [DEV_B, DEV_C])
        self.assertEqual([r[3] for r in self.triggers("both-lathes", archived=True) if r[8]], [DEV_A])
        self.assertEqual(self.row("both-lathes")[3], True)
        self.assertEqual(self.row("press-2-hot")[3], True)

        disabled = [r for r in self.audit("AUTOMATION_DISABLED") if r[6]["id"] == "lathe-3-spindle-hot"]
        self.assertEqual(len(disabled), 1)
        self.assertEqual((disabled[0][3], disabled[0][4]), (MANAGER_ID, "user"), "the row names the person who archived the device")
        self.assertIn("Test_0257_Lathe_3", disabled[0][6]["reason"])
        self.assertIn("archived", disabled[0][6]["reason"])
        self.assertEqual(disabled[0][6]["triggers"], [])
        changed = [r for r in self.audit("AUTOMATION_CHANGED") if r[6]["id"] == "both-lathes"]
        self.assertEqual(len(changed), 1)
        self.assertIn("archived", changed[0][6]["reason"])
        # The rendered document leaves the archived row out, and applies as unchanged.
        both = [a for a in self.document()["automations"] if a["id"] == "both-lathes"][0]
        self.assertEqual([t["device"] for t in both["triggers"]], [DEV_B, DEV_C])
        self.assertEqual([r["status"] for r in self.apply([both], dry_run=True)], ["unchanged"])

    def test_restoring_the_device_brings_its_rows_back_and_enables_nothing(self):
        self.archive(DEV_A)
        self.archive(DEV_A, archived=False)
        self.assertEqual([(r[3], r[8]) for r in self.triggers("lathe-3-spindle-hot")], [(DEV_A, False)])
        self.assertEqual(self.row("lathe-3-spindle-hot")[3], False, "a restore does not turn an automation on")
        self.assertEqual([r[3] for r in self.triggers("both-lathes")], [DEV_A, DEV_B, DEV_C])
        restored = [r for r in self.audit("AUTOMATION_CHANGED") if "restored" in r[6].get("reason", "")]
        self.assertEqual(len(restored), 2)
        self.as_person(MANAGER_ID, "SELECT public.set_automation_enabled('lathe-3-spindle-hot', true);")

    def test_deleting_the_device_removes_its_rows_and_says_why(self):
        self.owner()
        self.cur.execute("DELETE FROM public.devices WHERE id = %s;", (DEV_A,))
        self.assertEqual(self.triggers("lathe-3-spindle-hot", archived=True), [])
        self.assertEqual(self.row("lathe-3-spindle-hot")[3], False)
        self.assertEqual([r[3] for r in self.triggers("both-lathes", archived=True)], [DEV_B, DEV_C])
        disabled = [r for r in self.audit("AUTOMATION_DISABLED") if r[6]["id"] == "lathe-3-spindle-hot"]
        self.assertEqual(len(disabled), 1)
        self.assertIn("deleted", disabled[0][6]["reason"])
        self.assertIsNone(disabled[0][3], "a purge by the timer names no person")

    def test_the_alerts_of_a_trigger_that_goes_are_resolved_and_no_others(self):
        lathe = {r[3]: r[0] for r in self.triggers("lathe-3-spindle-hot")}
        both = {(r[3], r[4]): r[0] for r in self.triggers("both-lathes")}
        press = {r[3]: r[0] for r in self.triggers("press-2-hot")}
        a_lathe = self.alert(lathe[DEV_A], DEV_A)
        a_both_a = self.alert(both[(DEV_A, METRIC)], DEV_A)
        a_both_b = self.alert(both[(DEV_B, METRIC)], DEV_B)
        a_press = self.alert(press[DEV_C], DEV_C)
        self.owner()
        self.cur.execute(
            "INSERT INTO public.platform_alerts (fingerprint, entity_type, entity_id, sparkplug_id, alert_name, status, starts_at)"
            " SELECT 'aber-grafana-rule:other', 'device', id, sparkplug_id, 'Device Offline', 'firing', now() FROM public.devices"
            " WHERE id = %s RETURNING id;", (DEV_A,))
        grafana = self.cur.fetchone()[0]

        self.archive(DEV_A)
        for alert in (a_lathe, a_both_a):
            self.assertEqual(self.alert_status(alert), ("resolved", True))
        for alert in (a_both_b, a_press, grafana):
            self.assertEqual(self.alert_status(alert), ("firing", False))

        # Disabling an automation resolves the alerts of every trigger it has.
        self.as_person(MANAGER_ID, "SELECT public.set_automation_enabled('both-lathes', false);")
        self.assertEqual(self.alert_status(a_both_b), ("resolved", True))
        self.assertEqual(self.alert_status(a_press), ("firing", False))

        # Deleting one does, and a document that drops a trigger does.
        self.as_person(MANAGER_ID, "SELECT public.delete_automation('press-2-hot');")
        self.assertEqual(self.alert_status(a_press), ("resolved", True))
        self.assertEqual(self.alert_status(grafana), ("firing", False), "a Grafana row is not an automation's")

    def test_a_document_that_moves_a_trigger_resolves_the_alert_it_had(self):
        press = {r[3]: r[0] for r in self.triggers("press-2-hot")}
        alert = self.alert(press[DEV_C], DEV_C)
        self.apply([automation("press-2-hot", alias="Press 2 hot", triggers=[trigger(DEV_C, above=95)])])
        self.assertEqual(self.alert_status(alert), ("firing", False), "a new threshold keeps the trigger, its id and its alert")
        self.apply([automation("press-2-hot", alias="Press 2 hot", triggers=[trigger(DEV_B)])])
        self.assertEqual(self.alert_status(alert), ("resolved", True))

    def test_deleting_the_device_resolves_the_alert_too(self):
        press = {r[3]: r[0] for r in self.triggers("press-2-hot")}
        alert = self.alert(press[DEV_C], DEV_C)
        self.owner()
        self.cur.execute("DELETE FROM public.devices WHERE id = %s;", (DEV_C,))
        self.assertEqual(self.alert_status(alert), ("resolved", True))

    def test_a_resolved_alert_is_left_as_it_was(self):
        press = {r[3]: r[0] for r in self.triggers("press-2-hot")}
        alert = self.alert(press[DEV_C], DEV_C, status="resolved")
        self.cur.execute("SELECT ends_at FROM public.platform_alerts WHERE id = %s;", (alert,))
        ends = self.cur.fetchone()[0]
        self.as_person(MANAGER_ID, "SELECT public.delete_automation('press-2-hot');")
        self.cur.execute("SELECT ends_at FROM public.platform_alerts WHERE id = %s;", (alert,))
        self.assertEqual(self.cur.fetchone()[0], ends)


class ForAnEntity(AutomationsBase):
    def reasons(self, device):
        rows = self.as_person(OPERATOR_ID, "SELECT key, enabled, reason FROM public.automations_for_entity(%s);", (device,))
        return [tuple(r) for r in rows]

    def test_the_automations_that_name_a_device(self):
        self.apply([automation("a-lathe", triggers=[trigger([DEV_A, DEV_B]), trigger(DEV_A, METRIC_2, above=1)], alias="A"),
                    automation("b-off", alias="B", enabled=False, triggers=[trigger(DEV_A)])])
        self.assertEqual(self.reasons(DEV_A), [("a-lathe", True, "named"), ("b-off", False, "named")])
        self.assertEqual(self.reasons(DEV_B), [("a-lathe", True, "named")])
        self.assertEqual(self.reasons(DEV_C), [])
        self.assertEqual(self.reasons(str(uuid.uuid4())), [])

    def test_an_archived_trigger_no_longer_applies(self):
        self.apply([automation("a-lathe", triggers=[trigger([DEV_A, DEV_B])])])
        self.as_person(MANAGER_ID, "UPDATE public.devices SET is_archived = true, archived_at = now() WHERE id = %s;", (DEV_A,))
        self.assertEqual(self.reasons(DEV_A), [])
        self.assertEqual(self.reasons(DEV_B), [("a-lathe", True, "named")])

    def test_a_site_wide_row_applies_to_a_modelled_device_and_to_no_other(self):
        self.apply([automation("a-lathe", alias="Named", triggers=[trigger(DEV_A)])])
        self.owner()
        self.cur.execute("INSERT INTO public.automations (key, alias) VALUES ('every-device', 'Every device') RETURNING id;")
        site = self.cur.fetchone()[0]
        self.cur.execute("INSERT INTO public.automation_triggers (automation_id, position, kind) VALUES (%s, 0, 'stopped_reporting');", (site,))
        self.cur.execute("INSERT INTO public.schemas (schema_name, schema_definition) VALUES ('Test_0257_Schema', '{}'::jsonb) RETURNING id;")
        schema = self.cur.fetchone()[0]
        self.cur.execute("INSERT INTO public.device_submodels (device_id, schema_id) VALUES (%s, %s);", (DEV_A, schema))
        self.assertEqual(self.reasons(DEV_A), [("a-lathe", True, "named"), ("every-device", True, "site-wide")])
        self.assertEqual(self.reasons(DEV_B), [], "a device with no schema attached is not modelled")


class TheFingerprint(AutomationsBase):
    def test_it_is_composed_in_one_function(self):
        self.owner()
        trigger_id, entity = str(uuid.uuid4()), str(uuid.uuid4())
        self.cur.execute("SELECT public.automation_alert_fingerprint(%s, %s, 'Spindle/LOAD'),"
                         "       public.automation_alert_fingerprint(%s, NULL, NULL),"
                         "       public.platform_alert_confirmation_window(public.automation_alert_fingerprint(%s, %s, 'x'));",
                         (trigger_id, entity, trigger_id, trigger_id, entity))
        full, prefix, window = self.cur.fetchone()
        self.assertEqual(full, f"condition:{trigger_id}:{entity}:Spindle/LOAD")
        self.assertEqual(prefix, f"condition:{trigger_id}:")
        self.assertTrue(full.startswith(prefix))
        self.assertIsNone(window, "0247 expects the condition: prefix and sends no reminder for it yet")


if __name__ == "__main__":
    unittest.main(verbosity=2)
