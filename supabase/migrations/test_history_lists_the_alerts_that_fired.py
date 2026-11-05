"""
History lists the alerts that fired (0243): alert_occurrences(), the read behind History's Alerts
tab and the shading of firing periods on its charts.

    python supabase/migrations/test_history_lists_the_alerts_that_fired.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * An occurrence is listed when it overlaps the window [p_from, p_to), not only when it started
    in it: one that started before and ended inside, one still firing, and one that spans the
    whole window. At the edges, one that ended at p_from and one that started at p_to are not.
  * A firing occurrence that a later one of the same fingerprint replaced ends where that one
    starts, and says so; a firing one nothing replaced has no end. A replaced one that ended
    before the window is not listed in it.
  * Newest first. p_sparkplug_ids keeps those devices and gateways. p_limit bounds the rows.
  * Each row is the whole occurrence, every column platform_alerts has, acknowledgement included.
  * RLS by role: an Operator, a Shopfloor Manager and an Auditor read every alert but a machine
    identity's; an Administrator reads that too.
  * The refusals, the grants, one form, STABLE SECURITY INVOKER and a pinned search_path.

The window is in 2001, where no other suite writes, and every test rolls back: platform_alerts is in
the realtime publication, so a committed row reaches every connected dashboard as a firing alert.
"""
import json
import os
import unittest

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", "54322")
DB_NAME = os.getenv("SUPABASE_DB_NAME", "postgres")
DB_USER = os.getenv("SUPABASE_DB_USER", "postgres")
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

FN = "public.alert_occurrences(timestamp with time zone, timestamp with time zone, text[], integer)"

OPERATOR_ID = "a0d17243-0000-4000-8000-0000000243a1"
MANAGER_ID = "a0d17243-0000-4000-8000-0000000243a2"
ADMIN_ID = "a0d17243-0000-4000-8000-0000000243a3"
AUDITOR_ID = "a0d17243-0000-4000-8000-0000000243a4"
PEOPLE = ((OPERATOR_ID, "Operator"), (MANAGER_ID, "Shopfloor_Manager"),
          (ADMIN_ID, "Administrator"), (AUDITOR_ID, "Auditor"))
PRINCIPAL_ID = "a0d17243-0000-4000-8000-0000000243d1"

LATHE = "dev243000000000000000001"
PRESS = "dev243000000000000000002"
GATEWAY = "gwy243000000000000000001"

# The window: 2001-01-01 10:00 to 12:00 UTC.
FROM = "2001-01-01T10:00:00Z"
TO = "2001-01-01T12:00:00Z"


def get_connection():
    conn = psycopg2.connect(host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD)
    conn.autocommit = False
    return conn


class OccurrencesBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure(%s) IS NOT NULL;", (FN,))
        if not self.cur.fetchone()[0]:
            self.skipTest("0243 is not applied to this database")
        self.cur.execute("SET LOCAL timezone = 'UTC';")
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        for user_id, role in PEOPLE:
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id[-4:]}@alert-history.test"))
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                " ON CONFLICT (user_id, role_id) DO NOTHING;", (user_id, roles[role]))

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def occurrence(self, fingerprint, starts_at, ends_at=None, *, status=None, entity_type="device",
                   sparkplug_id=LATHE, entity_id=None, name="Spindle Overload", recorded_at=None):
        """One occurrence, written as its writer would; resolved when it has an end."""
        self.cur.execute(
            "INSERT INTO public.platform_alerts"
            "   (fingerprint, entity_type, entity_id, sparkplug_id, alert_name, severity, status,"
            "    summary, starts_at, ends_at, recorded_at)"
            " VALUES (%s, %s, %s, %s, %s, 'warning', %s, 'fixture', %s, %s, coalesce(%s, %s::timestamptz))"
            " RETURNING id::text;",
            (fingerprint, entity_type, entity_id, sparkplug_id, name,
             status or ("resolved" if ends_at else "firing"), starts_at, ends_at, recorded_at, starts_at))
        return self.cur.fetchone()[0]

    def read(self, p_from=FROM, p_to=TO, ids=None, limit=1000, cur=None):
        """(id, ended_at, replaced) for each row, in the function's order, as the owner reads."""
        (cur or self.cur).execute(
            "SELECT (r.occurrence).id::text, r.ended_at, r.replaced"
            "  FROM public.alert_occurrences(%s, %s, %s, %s) r;", (p_from, p_to, ids, limit))
        return (cur or self.cur).fetchall()

    def ids(self, **kw):
        return [row[0] for row in self.read(**kw)]

    def as_person(self, user_id, sql, args=()):
        """Run `sql` as PostgREST would for a person's token, then return to the owner."""
        self.cur.execute("SAVEPOINT as_person;")
        try:
            self.cur.execute("SELECT set_config('role', 'authenticated', true);")
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                             (json.dumps({"sub": user_id, "role": "authenticated"}),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall()
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT as_person;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT as_person;")
        return rows


class TheOverlapRule(OccurrencesBase):
    def test_an_occurrence_that_overlaps_the_window_is_listed_however_it_started(self):
        inside = self.occurrence("fp-inside", "2001-01-01T10:30:00Z", "2001-01-01T10:40:00Z")
        ends_in = self.occurrence("fp-ends-in", "2001-01-01T09:00:00Z", "2001-01-01T10:05:00Z")
        firing = self.occurrence("fp-firing", "2001-01-01T08:00:00Z")
        spans = self.occurrence("fp-spans", "2001-01-01T09:00:00Z", "2001-01-01T13:00:00Z")
        self.assertCountEqual(self.ids(), [inside, ends_in, firing, spans])

    def test_at_the_edges_the_window_holds_its_start_and_not_its_end(self):
        at_start = self.occurrence("fp-at-start", "2001-01-01T10:00:00Z", "2001-01-01T10:01:00Z")
        last_moment = self.occurrence("fp-last", "2001-01-01T11:59:59Z", "2001-01-01T12:30:00Z")
        ended_at_start = self.occurrence("fp-ended", "2001-01-01T09:00:00Z", "2001-01-01T10:00:00Z")
        started_at_end = self.occurrence("fp-later", "2001-01-01T12:00:00Z", "2001-01-01T12:10:00Z")
        listed = self.ids()
        self.assertIn(at_start, listed)
        self.assertIn(last_moment, listed)
        self.assertNotIn(ended_at_start, listed)
        self.assertNotIn(started_at_end, listed)

    def test_one_wholly_before_or_after_the_window_is_not_listed(self):
        self.occurrence("fp-before", "2001-01-01T08:00:00Z", "2001-01-01T09:00:00Z")
        self.occurrence("fp-after", "2001-01-01T13:00:00Z")
        self.assertEqual(self.read(), [])


class WhenAnOccurrenceEnded(OccurrencesBase):
    def test_a_resolved_occurrence_ended_when_it_resolved(self):
        alert = self.occurrence("fp-resolved", "2001-01-01T10:10:00Z", "2001-01-01T10:20:00Z")
        [(aid, ended, replaced)] = self.read()
        self.assertEqual((aid, ended.isoformat(), replaced), (alert, "2001-01-01T10:20:00+00:00", False))

    def test_a_firing_occurrence_nothing_replaced_has_no_end(self):
        alert = self.occurrence("fp-firing", "2001-01-01T10:10:00Z")
        self.assertEqual(self.read(), [(alert, None, False)])

    def test_a_firing_occurrence_a_later_one_replaced_ends_where_that_one_starts(self):
        first = self.occurrence("fp-again", "2001-01-01T10:10:00Z")
        second = self.occurrence("fp-again", "2001-01-01T11:00:00Z")
        rows = {aid: (ended.isoformat() if ended else None, replaced) for aid, ended, replaced in self.read()}
        self.assertEqual(rows[first], ("2001-01-01T11:00:00+00:00", True))
        self.assertEqual(rows[second], (None, False))

    def test_a_replaced_occurrence_that_ended_before_the_window_is_not_in_it(self):
        # Never resolved, so its ends_at is NULL; it is over once the next one started at 09:30.
        self.occurrence("fp-gone", "2001-01-01T09:00:00Z")
        second = self.occurrence("fp-gone", "2001-01-01T09:30:00Z", "2001-01-01T09:45:00Z")
        self.assertEqual(self.read(), [])
        self.assertNotIn(second, self.ids())

    def test_a_resolved_occurrence_keeps_its_own_end_after_a_later_one(self):
        first = self.occurrence("fp-cycle", "2001-01-01T10:00:00Z", "2001-01-01T10:15:00Z")
        self.occurrence("fp-cycle", "2001-01-01T11:00:00Z")
        rows = {aid: (ended.isoformat() if ended else None, replaced) for aid, ended, replaced in self.read()}
        self.assertEqual(rows[first], ("2001-01-01T10:15:00+00:00", False))


class OrderFilterAndShape(OccurrencesBase):
    def test_newest_first(self):
        early = self.occurrence("fp-a", "2001-01-01T10:05:00Z", "2001-01-01T10:06:00Z")
        late = self.occurrence("fp-b", "2001-01-01T11:05:00Z", "2001-01-01T11:06:00Z")
        middle = self.occurrence("fp-c", "2001-01-01T10:35:00Z")
        self.assertEqual(self.ids(), [late, middle, early])

    def test_the_assets_named_keep_their_alerts_and_drop_the_rest(self):
        lathe = self.occurrence("fp-lathe", "2001-01-01T10:05:00Z")
        press = self.occurrence("fp-press", "2001-01-01T10:06:00Z", sparkplug_id=PRESS)
        gateway = self.occurrence("fp-gwy", "2001-01-01T10:07:00Z", entity_type="gateway", sparkplug_id=GATEWAY)
        platform = self.occurrence("fp-platform", "2001-01-01T10:08:00Z", entity_type="platform", sparkplug_id=None)
        self.assertCountEqual(self.ids(), [lathe, press, gateway, platform])
        self.assertCountEqual(self.ids(ids=[LATHE, GATEWAY]), [lathe, gateway])
        self.assertEqual(self.ids(ids=[PRESS]), [press])
        self.assertEqual(self.ids(ids=[]), [])

    def test_the_limit_keeps_the_newest(self):
        rows = [self.occurrence(f"fp-{i}", f"2001-01-01T10:{10 + i}:00Z") for i in range(5)]
        self.assertEqual(self.ids(limit=2), [rows[4], rows[3]])

    def test_each_row_is_the_whole_occurrence(self):
        alert = self.occurrence("fp-whole", "2001-01-01T10:05:00Z")
        self.cur.execute(
            "UPDATE public.platform_alerts SET acknowledged_at = '2001-01-01T10:06:00Z', acknowledged_by = %s,"
            " acknowledged_by_email = 'manager@alert-history.test', acknowledgement_reason = 'other',"
            " acknowledgement_note = 'the belt is off' WHERE id = %s;", (MANAGER_ID, alert))
        self.cur.execute(
            "SELECT to_jsonb(r.occurrence) FROM public.alert_occurrences(%s, %s) r;", (FROM, TO))
        [(row,)] = self.cur.fetchall()
        self.cur.execute(
            "SELECT array_agg(attname::text) FROM pg_attribute"
            " WHERE attrelid = 'public.platform_alerts'::regclass AND attnum > 0 AND NOT attisdropped;")
        self.assertCountEqual(row.keys(), self.cur.fetchone()[0])
        self.assertEqual((row["id"], row["acknowledged_by_email"], row["acknowledgement_reason"],
                          row["acknowledgement_note"]),
                         (alert, "manager@alert-history.test", "other", "the belt is off"))


class WhoReadsWhat(OccurrencesBase):
    SQL = "SELECT (r.occurrence).id::text FROM public.alert_occurrences(%s, %s) r;"

    def setUp(self):
        super().setUp()
        self.device = self.occurrence("fp-device", "2001-01-01T10:05:00Z")
        self.platform = self.occurrence("fp-platform", "2001-01-01T10:06:00Z", entity_type="platform", sparkplug_id=None)
        self.token = self.occurrence("fp-token", "2001-01-01T10:07:00Z", entity_type="service_identity",
                                     sparkplug_id=None, entity_id=PRINCIPAL_ID, name="Service Token Expiring")

    def seen_by(self, person):
        return [row[0] for row in self.as_person(person, self.SQL, (FROM, TO))]

    def test_every_role_but_the_administrator_reads_all_but_a_machine_identity_s_alert(self):
        for person in (OPERATOR_ID, MANAGER_ID, AUDITOR_ID):
            with self.subTest(person=person):
                self.assertCountEqual(self.seen_by(person), [self.device, self.platform])

    def test_an_administrator_reads_a_machine_identity_s_alert_too(self):
        self.assertCountEqual(self.seen_by(ADMIN_ID), [self.device, self.platform, self.token])

    def test_a_replaced_end_is_found_among_the_rows_the_caller_may_read(self):
        later = self.occurrence("fp-device", "2001-01-01T11:00:00Z")
        rows = self.as_person(
            OPERATOR_ID,
            "SELECT (r.occurrence).id::text, r.ended_at, r.replaced FROM public.alert_occurrences(%s, %s) r;",
            (FROM, TO))
        ends = {aid: (ended.isoformat() if ended else None, replaced) for aid, ended, replaced in rows}
        self.assertEqual(ends[self.device], ("2001-01-01T11:00:00+00:00", True))
        self.assertEqual(ends[later], (None, False))


class TheFunction(OccurrencesBase):
    def test_bounds_out_of_order_and_a_limit_out_of_range_are_refused(self):
        for args in ((TO, FROM, None, 10), (FROM, FROM, None, 10), (None, TO, None, 10),
                     (FROM, None, None, 10), (FROM, TO, None, 0), (FROM, TO, None, 5001), (FROM, TO, None, None)):
            with self.subTest(args=args):
                self.cur.execute("SAVEPOINT refused;")
                with self.assertRaises(psycopg2.Error) as caught:
                    self.cur.execute("SELECT * FROM public.alert_occurrences(%s, %s, %s, %s);", args)
                self.assertEqual(caught.exception.pgcode, "22023")
                self.cur.execute("ROLLBACK TO SAVEPOINT refused;")

    def test_one_stable_invoker_form_with_its_search_path_pinned(self):
        self.cur.execute(
            "SELECT count(*), bool_and(NOT p.prosecdef), bool_and(p.provolatile = 's'),"
            "       bool_and('search_path=public' = ANY (p.proconfig))"
            "  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace"
            " WHERE n.nspname = 'public' AND p.proname = 'alert_occurrences';")
        self.assertEqual(self.cur.fetchone(), (1, True, True, True))

    def test_who_may_call_it(self):
        self.cur.execute(
            "SELECT has_function_privilege('authenticated', %s, 'EXECUTE'),"
            "       has_function_privilege('service_role', %s, 'EXECUTE'),"
            "       has_function_privilege('anon', %s, 'EXECUTE');", (FN, FN, FN))
        self.assertEqual(self.cur.fetchone(), (True, True, False))


if __name__ == "__main__":
    unittest.main()
