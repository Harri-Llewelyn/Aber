# suite:
#   lanes: db
#   why: 0290 -- display_names_for() names the person who acknowledged an alert, and the person who
#     scheduled or ended a suppression window, to every role that may read that alert or that
#     window, and to no caller who may not: a machine identity's alert is an Administrator's alone,
#     so is its acknowledger's name. The people it names are the rows each role's own read of the
#     table shows, a person with no name or only a picture is left out, and no API role but the
#     signed-in one runs it.

"""
An alert's acknowledger and a suppression window's author are shown by name (0213, 0290).

    python supabase/migrations/test_an_acknowledger_is_shown_by_name.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here: display_names_for() names the person who acknowledged an alert, and the person
who scheduled or ended a suppression window, to a caller who may read that alert or that window, and
only then.

  * Every role reads the name of the person who acknowledged an alert it may read: an Administrator,
    a Shopfloor Manager, an Operator, an Auditor, and a signed-in person with no role at all.
  * An alert about a machine identity is an Administrator's alone to read, so its acknowledger's
    name is an Administrator's alone, and a caller who may not read the alert gets no name for them.
  * Every role reads the name of the person who scheduled or ended a window, as every role reads the
    window.
  * The answer is the rows the read policies show. For each role, the people it reads on the alerts
    table and on the windows table are the people the function names, and nobody else is named
    because of them.
  * A person with no name, and one with only a picture, are left out whatever they did, so the answer
    says nothing about a picture. An id that no alert and no window names is left out.
  * What 0213 gave the function is as it was: a caller's own name, and nobody else's by chance. Its
    other arms (the proposer, the retirer, the person who started a job) are held by
    test_a_person_can_have_a_display_name.py and test_a_person_can_put_a_picture_on_their_account.py.
    No API role but the signed-in one may run it.

EVERY TEST ROLLS BACK. platform_alerts is in the realtime publication: a committed row reaches every
connected dashboard as a firing alert.
"""
import json
import os
import unittest
import uuid

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

ADMIN = "a0d17290-0000-4000-8000-0000000290a1"
MANAGER = "a0d17290-0000-4000-8000-0000000290a2"
OPERATOR = "a0d17290-0000-4000-8000-0000000290a3"
AUDITOR = "a0d17290-0000-4000-8000-0000000290a4"
NO_ROLE = "a0d17290-0000-4000-8000-0000000290a5"
# The people the alerts and the windows name.
ACKER = "a0d17290-0000-4000-8000-0000000290b1"        # acknowledged a device alert
SERVICE_ACKER = "a0d17290-0000-4000-8000-0000000290b2"  # acknowledged a machine identity's alert
SCHEDULER = "a0d17290-0000-4000-8000-0000000290b3"    # scheduled a window
ENDER = "a0d17290-0000-4000-8000-0000000290b4"        # ended it
NAMELESS = "a0d17290-0000-4000-8000-0000000290b5"     # acknowledged an alert, has no display name
PICTURE_ONLY = "a0d17290-0000-4000-8000-0000000290b6"  # acknowledged an alert, has a picture and no name
UNRELATED = "a0d17290-0000-4000-8000-0000000290b7"    # has a name and has done none of it

CALLERS = {"Administrator": ADMIN, "Shopfloor_Manager": MANAGER, "Operator": OPERATOR, "Auditor": AUDITOR, None: NO_ROLE}
NAMES = {
    ADMIN: "Ada Admin", MANAGER: "Mair Manager", OPERATOR: "Olwen Operator", AUDITOR: "Aled Auditor", NO_ROLE: "Nia NoRole",
    ACKER: "Gwen Acknowledger", SERVICE_ACKER: "Sam Serviceack", SCHEDULER: "Sian Scheduler", ENDER: "Emrys Ender",
    UNRELATED: "Una Unrelated",
}
EVERYONE = list(CALLERS.values()) + [ACKER, SERVICE_ACKER, SCHEDULER, ENDER, NAMELESS, PICTURE_ONLY, UNRELATED]


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class NamesBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT prosrc FROM pg_proc WHERE oid = 'public.display_names_for(uuid[])'::regprocedure;")
        if "alert_suppression_windows" not in self.cur.fetchone()[0]:
            self.skipTest("0290 is not applied to this database")
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        for user_id in EVERYONE:
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at, last_sign_in_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now(), now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id[-4:]}@names.test"))
        for role, user_id in CALLERS.items():
            if role:
                self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                                 " ON CONFLICT (user_id, role_id) DO NOTHING;", (user_id, roles[role]))
        for user_id, name in NAMES.items():
            self.cur.execute("INSERT INTO public.person_profiles (user_id, display_name) VALUES (%s, %s);", (user_id, name))
        self.cur.execute("INSERT INTO public.person_profiles (user_id, display_name, avatar_path) VALUES (%s, NULL, %s);",
                         (PICTURE_ONLY, f"{PICTURE_ONLY}/avatar"))

        self.cur.execute("INSERT INTO public.devices (name) VALUES ('Test_0290_Press') RETURNING id, sparkplug_id;")
        self.device, sparkplug = self.cur.fetchone()
        self.device_alert = self.alert("fp-device", "device", ACKER, sparkplug_id=sparkplug, entity_id=self.device)
        self.service_alert = self.alert("fp-service", "service_identity", SERVICE_ACKER)
        self.nameless_alert = self.alert("fp-nameless", "device", NAMELESS, sparkplug_id=sparkplug, entity_id=self.device)
        self.picture_alert = self.alert("fp-picture", "device", PICTURE_ONLY, sparkplug_id=sparkplug, entity_id=self.device)
        self.cur.execute(
            "INSERT INTO public.alert_suppression_windows (device_id, starts_at, ends_at, reason, created_by,"
            "       created_by_email, ended_by, ended_by_email)"
            " VALUES (%s, now() - interval '1 hour', now() + interval '1 hour', 'Belt change', %s, 'sched@names.test', %s,"
            "         'ender@names.test');", (self.device, SCHEDULER, ENDER))

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def alert(self, fingerprint, entity_type, acknowledged_by, sparkplug_id=None, entity_id=None):
        """A firing alert, acknowledged by this person."""
        self.cur.execute(
            "INSERT INTO public.platform_alerts (fingerprint, entity_type, entity_id, sparkplug_id, alert_name, severity,"
            "       status, starts_at, acknowledged_at, acknowledged_by, acknowledged_by_email, acknowledgement_reason)"
            " VALUES (%s, %s, %s, %s, 'Temperature High', 'warning', 'firing', '2026-11-12T09:00:00Z',"
            "         '2026-11-12T09:05:00Z', %s, %s, 'known_cause') RETURNING id;",
            (f"{fingerprint}-{uuid.uuid4().hex[:8]}", entity_type, entity_id, sparkplug_id, acknowledged_by,
             f"{acknowledged_by[-4:]}@names.test"))
        return self.cur.fetchone()[0]

    def as_caller(self, user_id, sql, args=()):
        """Run `sql` as this person through the API role, as PostgREST would."""
        self.cur.execute("SAVEPOINT names_call;")
        try:
            self.cur.execute("SET LOCAL ROLE authenticated;")
            self.cur.execute('SET LOCAL "request.jwt.claims" = %s;', (json.dumps({"sub": user_id, "role": "authenticated"}),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
        finally:
            self.cur.execute("RESET ROLE;")
        self.cur.execute("RELEASE SAVEPOINT names_call;")
        return rows

    def named(self, caller, ids=EVERYONE):
        rows = self.as_caller(caller, "SELECT user_id::text, display_name FROM public.display_names_for(%s::uuid[]);", (ids,))
        return dict(rows)


class TheAcknowledgerOfAnAlert(NamesBase):
    def test_every_role_reads_the_name_of_who_acknowledged_an_alert_it_may_read(self):
        for role, caller in CALLERS.items():
            with self.subTest(role=role):
                self.assertEqual(self.named(caller, [ACKER]), {ACKER: NAMES[ACKER]})

    def test_a_machine_identitys_alert_is_an_administrators_alone_so_is_its_acknowledgers_name(self):
        self.assertEqual(self.named(ADMIN, [SERVICE_ACKER]), {SERVICE_ACKER: NAMES[SERVICE_ACKER]})
        for role in ("Shopfloor_Manager", "Operator", "Auditor", None):
            with self.subTest(role=role):
                self.assertEqual(self.named(CALLERS[role], [SERVICE_ACKER]), {},
                                 "a caller who may not read the alert was given the name of its acknowledger")

    def test_the_acknowledger_of_an_alert_a_caller_may_read_is_named_even_when_another_may_not(self):
        """The same person, two alerts: the one the caller may read is enough."""
        self.alert("fp-second", "service_identity", ACKER)
        for role, caller in CALLERS.items():
            with self.subTest(role=role):
                self.assertIn(ACKER, self.named(caller, [ACKER]))

    def test_a_person_with_no_name_or_only_a_picture_is_left_out(self):
        for role, caller in CALLERS.items():
            with self.subTest(role=role):
                self.assertEqual(self.named(caller, [NAMELESS, PICTURE_ONLY]), {})

    def test_an_alert_acknowledged_by_nobody_names_nobody(self):
        self.cur.execute("UPDATE public.platform_alerts SET acknowledged_at = NULL, acknowledged_by = NULL,"
                         " acknowledged_by_email = NULL, acknowledgement_reason = NULL WHERE id = %s;", (self.device_alert,))
        self.assertEqual(self.named(OPERATOR, [ACKER]), {})


class TheAuthorOfAWindow(NamesBase):
    def test_every_role_reads_the_name_of_who_scheduled_or_ended_a_window(self):
        for role, caller in CALLERS.items():
            with self.subTest(role=role):
                self.assertEqual(self.named(caller, [SCHEDULER, ENDER]),
                                 {SCHEDULER: NAMES[SCHEDULER], ENDER: NAMES[ENDER]})

    def test_a_person_who_has_done_neither_is_left_out(self):
        for role, caller in CALLERS.items():
            with self.subTest(role=role):
                self.assertEqual(self.named(caller, [UNRELATED]), {})

    def test_a_window_nobody_ended_names_only_who_scheduled_it(self):
        self.cur.execute("UPDATE public.alert_suppression_windows SET ended_by = NULL, ended_by_email = NULL;")
        self.assertEqual(self.named(OPERATOR, [SCHEDULER, ENDER]), {SCHEDULER: NAMES[SCHEDULER]})


class TheAnswerIsTheRowsThePoliciesShow(NamesBase):
    """For each role, the people the function names for an alert or a window are the people its own
    read of the table shows, so the arms cannot drift from the policies unseen."""

    def test_the_acknowledgers_a_caller_reads_are_the_acknowledgers_it_is_named(self):
        for role, caller in CALLERS.items():
            with self.subTest(role=role):
                seen = {r[0] for r in self.as_caller(
                    caller, "SELECT DISTINCT acknowledged_by::text FROM public.platform_alerts WHERE acknowledged_by = ANY(%s::uuid[]);",
                    (EVERYONE,))}
                self.assertTrue(seen, "the role reads no acknowledged alert")
                # The others have done nothing else the function knows, so the two sets are the same.
                others = [u for u in EVERYONE if u not in CALLERS.values()]
                named = set(self.named(caller, others)) & {ACKER, SERVICE_ACKER, NAMELESS, PICTURE_ONLY}
                self.assertEqual(named, seen & set(NAMES))

    def test_the_authors_a_caller_reads_are_the_authors_it_is_named(self):
        for role, caller in CALLERS.items():
            with self.subTest(role=role):
                seen = {r[0] for r in self.as_caller(
                    caller, "SELECT created_by::text FROM public.alert_suppression_windows"
                            " UNION SELECT ended_by::text FROM public.alert_suppression_windows WHERE ended_by IS NOT NULL;")}
                self.assertEqual(seen, {SCHEDULER, ENDER})
                self.assertEqual(set(self.named(caller, [SCHEDULER, ENDER])), seen)


class WhatItWasBefore(NamesBase):
    def test_a_caller_reads_their_own_name(self):
        for caller in CALLERS.values():
            with self.subTest(caller=caller):
                self.assertEqual(self.named(caller, [caller]), {caller: NAMES[caller]})

    def test_nobody_reads_the_name_of_a_person_who_did_nothing_the_function_knows(self):
        for caller in (MANAGER, OPERATOR, AUDITOR, NO_ROLE):
            with self.subTest(caller=caller):
                self.assertEqual(self.named(caller, [UNRELATED, ADMIN] if caller != ADMIN else [UNRELATED]), {})

    def test_only_the_signed_in_role_may_run_it(self):
        for role, allowed in (("anon", False), ("service_role", False), ("authenticated", True)):
            with self.subTest(role=role):
                self.cur.execute("SELECT has_function_privilege(%s, 'public.display_names_for(uuid[])', 'EXECUTE');", (role,))
                self.assertEqual(self.cur.fetchone()[0], allowed)

    def test_it_is_still_a_security_definer_with_its_search_path_pinned(self):
        self.cur.execute("SELECT prosecdef, proconfig FROM pg_proc WHERE oid = 'public.display_names_for(uuid[])'::regprocedure;")
        definer, config = self.cur.fetchone()
        self.assertTrue(definer)
        self.assertIn("search_path=public", config)


if __name__ == "__main__":
    unittest.main()
