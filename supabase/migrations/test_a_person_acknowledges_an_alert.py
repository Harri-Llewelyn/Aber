"""
A person acknowledges an alert, with a reason, and the acknowledgement holds until it resolves
(0231, 0232).

    python supabase/migrations/test_a_person_acknowledges_an_alert.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * platform_alerts' five acknowledgement columns, nullable with no default, and their CHECKs: a
    closed set of reasons, a whole acknowledgement, and a note that Other requires.
    platform_alerts_active returns them beside 0220's columns.
  * acknowledge_alert(): an Operator, a Shopfloor Manager and an Administrator each acknowledge; an
    Auditor and a machine identity are refused. A row the caller cannot read is not there. A
    resolved, superseded or already acknowledged row is refused, the last naming who and when.
  * withdraw_alert_acknowledgement(): the acknowledger, a Shopfloor Manager and an Administrator
    withdraw; another Operator is refused.
  * The inheritance trigger: a new occurrence takes the acknowledgement while the one before it is
    firing and acknowledged, and nothing after the fingerprint resolves. The webhook's upsert never
    overwrites an occurrence's own acknowledgement.
  * The audit rows: their action, lane, kind, class and snapshots, and who reads them.
  * An acknowledgement is an UPDATE that the realtime publication carries.

EVERY TEST ROLLS BACK. platform_alerts is in the realtime publication: a committed row reaches every
connected dashboard as a firing alert.
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

OPERATOR_ID = "a0d17231-0000-4000-8000-0000000231a1"
OTHER_OPERATOR_ID = "a0d17231-0000-4000-8000-0000000231a2"
MANAGER_ID = "a0d17231-0000-4000-8000-0000000231a3"
ADMIN_ID = "a0d17231-0000-4000-8000-0000000231a4"
AUDITOR_ID = "a0d17231-0000-4000-8000-0000000231a5"
MACHINE_ID = "a0d17231-0000-4000-8000-0000000231a6"
PRINCIPAL_ID = "a0d17231-0000-4000-8000-0000000231d1"

PEOPLE = (
    (OPERATOR_ID, "Operator"), (OTHER_OPERATOR_ID, "Operator"), (MANAGER_ID, "Shopfloor_Manager"),
    (ADMIN_ID, "Administrator"), (AUDITOR_ID, "Auditor"),
)
REASONS = ["investigating", "known_cause", "planned_work", "sensor_or_model_fault", "threshold_wrong", "other"]
ACK_COLUMNS = [
    "acknowledged_at", "acknowledged_by", "acknowledged_by_email", "acknowledgement_reason", "acknowledgement_note",
]
# The view's columns: 1.7.0's, 0220's, then 0231's.
ACTIVE_VIEW_COLUMNS = [
    "id", "fingerprint", "entity_type", "entity_id", "sparkplug_id", "alert_name", "severity",
    "status", "summary", "starts_at", "ends_at", "recorded_at", "rule_uid", "labels", "values",
] + ACK_COLUMNS

# What the webhook upserts, as PostgREST's merge-duplicates writes it: every column it sends is
# updated on a conflict with the occurrence key, and the acknowledgement is not among them.
UPSERT = """
    INSERT INTO public.platform_alerts
        (fingerprint, entity_type, entity_id, sparkplug_id, alert_name, severity, status, summary,
         starts_at, ends_at, rule_uid, labels, "values")
    VALUES (%(fingerprint)s, %(entity_type)s, %(entity_id)s, %(sparkplug_id)s, %(alert_name)s,
            'warning', %(status)s, 'summary', %(starts_at)s, %(ends_at)s, 'aber-device-offline',
            %(labels)s, NULL)
    ON CONFLICT (fingerprint, starts_at) DO UPDATE SET
        entity_type = EXCLUDED.entity_type, entity_id = EXCLUDED.entity_id,
        sparkplug_id = EXCLUDED.sparkplug_id, alert_name = EXCLUDED.alert_name,
        severity = EXCLUDED.severity, status = EXCLUDED.status, summary = EXCLUDED.summary,
        ends_at = EXCLUDED.ends_at, rule_uid = EXCLUDED.rule_uid, labels = EXCLUDED.labels,
        "values" = EXCLUDED."values"
    RETURNING id
"""


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


def lane_id(fingerprint):
    """The alert's lane in the Audit Trail: md5('platform_alerts:' || fingerprint) as a uuid."""
    import hashlib
    return str(uuid.UUID(hashlib.md5(f"platform_alerts:{fingerprint}".encode()).hexdigest()))


class AcknowledgementBase(unittest.TestCase):
    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        self.cur.execute("SELECT to_regprocedure('public.acknowledge_alert(uuid, text, text)') IS NOT NULL;")
        if not self.cur.fetchone()[0]:
            self.skipTest("0231 is not applied to this database")
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        for user_id, role in PEOPLE:
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, self.email(user_id)),
            )
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                " ON CONFLICT (user_id, role_id) DO NOTHING;",
                (user_id, roles[role]),
            )
        # A machine identity: no email, no password, no identity, and so no role (user_roles
        # refuses it one).
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
            " VALUES (%s, NULL, '', now()) ON CONFLICT (id) DO NOTHING;", (MACHINE_ID,))

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    @staticmethod
    def email(user_id):
        return f"{user_id[-4:]}@acknowledgement.test"

    def upsert(self, fingerprint="fp-0231", starts_at="2026-11-04T09:00:00Z", status="firing",
               ends_at=None, entity_type="device", entity_id=None, sparkplug_id="dev0231000000000400080000",
               alert_name="Device Offline"):
        self.cur.execute(UPSERT, {
            "fingerprint": fingerprint, "entity_type": entity_type, "entity_id": entity_id,
            "sparkplug_id": sparkplug_id, "alert_name": alert_name, "status": status,
            "starts_at": starts_at, "ends_at": ends_at, "labels": Json({"alertname": alert_name}),
        })
        return self.cur.fetchone()[0]

    def resolve(self, fingerprint="fp-0231", starts_at="2026-11-04T09:00:00Z", **kw):
        return self.upsert(fingerprint=fingerprint, starts_at=starts_at, status="resolved",
                           ends_at="2026-11-04T09:30:00Z", **kw)

    def machine_alert(self, fingerprint="fp-0231-token", starts_at="2026-11-04T09:00:00Z"):
        return self.upsert(fingerprint=fingerprint, starts_at=starts_at, entity_type="service_identity",
                           entity_id=PRINCIPAL_ID, sparkplug_id=None, alert_name="Service Token Expiring")

    def as_person(self, user_id, sql, args=()):
        """Run `sql` as PostgREST would for a person's token. A refusal rolls back to the
        savepoint, so the test can go on, and is raised."""
        self.cur.execute("SAVEPOINT acknowledgement_call;")
        try:
            self.cur.execute("SELECT set_config('role', 'authenticated', true);")
            claims = {"sub": user_id, "role": "authenticated"}
            if user_id != MACHINE_ID:
                claims["email"] = self.email(user_id)
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);", (json.dumps(claims),))
            self.cur.execute(sql, args)
            rows = self.cur.fetchall() if self.cur.description else None
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT acknowledgement_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT acknowledgement_call;")
        return rows

    def acknowledge(self, user_id, alert_id, reason="investigating", note=None):
        return self.as_person(
            user_id,
            "SELECT acknowledged_by, acknowledged_by_email, acknowledgement_reason, acknowledgement_note"
            " FROM public.acknowledge_alert(%s, %s, %s);", (alert_id, reason, note))[0]

    def withdraw(self, user_id, alert_id):
        return self.as_person(
            user_id,
            "SELECT acknowledged_at, acknowledged_by, acknowledgement_reason"
            " FROM public.withdraw_alert_acknowledgement(%s);", (alert_id,))[0]

    def row(self, alert_id):
        self.cur.execute(
            "SELECT acknowledged_at IS NOT NULL, acknowledged_by::text, acknowledged_by_email,"
            "       acknowledgement_reason, acknowledgement_note"
            "  FROM public.platform_alerts WHERE id = %s;", (alert_id,))
        return self.cur.fetchone()

    def audit_rows(self, action=None):
        self.cur.execute(
            "SELECT action, entity_type, entity_id::text, audit_domain, changed_by::text, actor_source,"
            "       old_data, new_data,"
            "       public.audit_event_class(action, entity_type, audit_domain, old_data, new_data)"
            "  FROM public.audit_trail"
            " WHERE action IN ('ALERT_ACKNOWLEDGED', 'ALERT_ACKNOWLEDGEMENT_WITHDRAWN')"
            "   AND (%s::text IS NULL OR action = %s)"
            "   AND recorded_at >= now()"
            " ORDER BY id;", (action, action))
        return self.cur.fetchall()

    def assertRefused(self, code, fn, *args, **kwargs):
        with self.assertRaises(psycopg2.Error) as caught:
            fn(*args, **kwargs)
        self.assertEqual(caught.exception.pgcode, code, caught.exception.pgerror)
        return caught.exception


class TheColumns(AcknowledgementBase):
    def test_five_nullable_columns_with_no_default(self):
        self.cur.execute(
            "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns"
            " WHERE table_schema = 'public' AND table_name = 'platform_alerts'"
            "   AND column_name = ANY (%s) ORDER BY column_name;", (ACK_COLUMNS,))
        self.assertEqual(self.cur.fetchall(), [
            ("acknowledged_at", "timestamp with time zone", "YES", None),
            ("acknowledged_by", "uuid", "YES", None),
            ("acknowledged_by_email", "text", "YES", None),
            ("acknowledgement_note", "text", "YES", None),
            ("acknowledgement_reason", "text", "YES", None),
        ])

    def test_each_column_is_described(self):
        for column in ACK_COLUMNS:
            self.cur.execute(
                "SELECT col_description('public.platform_alerts'::regclass, attnum) FROM pg_attribute"
                " WHERE attrelid = 'public.platform_alerts'::regclass AND attname = %s;", (column,))
            self.assertIn("0231", self.cur.fetchone()[0] or "", column)

    def test_the_view_keeps_0220_s_columns_and_returns_the_new_ones(self):
        self.cur.execute(
            "SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute"
            " WHERE attrelid = 'public.platform_alerts_active'::regclass AND attnum > 0 AND NOT attisdropped;")
        self.assertEqual(self.cur.fetchone()[0], ACTIVE_VIEW_COLUMNS)

    def test_an_acknowledged_alert_stays_in_the_view(self):
        alert = self.upsert()
        self.acknowledge(MANAGER_ID, alert, "known_cause", "the feeder is down for a belt change")
        rows = self.as_person(
            OPERATOR_ID,
            "SELECT acknowledgement_reason, acknowledgement_note, acknowledged_by_email, rule_uid"
            "  FROM public.platform_alerts_active WHERE id = %s;", (alert,))
        self.assertEqual(rows, [("known_cause", "the feeder is down for a belt change",
                                 self.email(MANAGER_ID), "aber-device-offline")])

    def test_status_still_admits_only_firing_and_resolved(self):
        self.cur.execute("SELECT public.live_constraint_definition('public.platform_alerts'::regclass,"
                         " 'platform_alerts_status_valid');")
        self.assertEqual(self.cur.fetchone()[0],
                         "CHECK ((status = ANY (ARRAY['firing'::text, 'resolved'::text])))")


class TheChecks(AcknowledgementBase):
    def write(self, **columns):
        """Write the five columns as the owner, past the functions; a column not named is NULL."""
        alert = self.upsert()
        self.cur.execute("SAVEPOINT direct;")
        try:
            self.cur.execute(
                "UPDATE public.platform_alerts"
                "   SET acknowledged_at = %(acknowledged_at)s, acknowledged_by = %(acknowledged_by)s,"
                "       acknowledged_by_email = %(acknowledged_by_email)s,"
                "       acknowledgement_reason = %(acknowledgement_reason)s,"
                "       acknowledgement_note = %(acknowledgement_note)s"
                " WHERE id = %(id)s;",
                {**{c: None for c in ACK_COLUMNS}, **columns, "id": alert})
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT direct;")
            raise
        self.cur.execute("RELEASE SAVEPOINT direct;")

    def test_the_reasons_are_a_closed_set(self):
        self.cur.execute("SELECT public.live_constraint_definition('public.platform_alerts'::regclass,"
                         " 'platform_alerts_acknowledgement_reason_valid');")
        definition = self.cur.fetchone()[0]
        for reason in REASONS:
            self.assertIn(f"'{reason}'::text", definition)
        self.assertRefused("23514", self.write, acknowledged_at="2026-11-04T09:05:00Z",
                           acknowledged_by=MANAGER_ID, acknowledgement_reason="bored")

    def test_an_acknowledgement_is_whole(self):
        self.assertRefused("23514", self.write, acknowledged_at="2026-11-04T09:05:00Z")
        self.assertRefused("23514", self.write, acknowledgement_reason="investigating")
        self.assertRefused("23514", self.write, acknowledgement_note="a note on nothing")
        self.write(acknowledged_at="2026-11-04T09:05:00Z", acknowledged_by=MANAGER_ID,
                   acknowledgement_reason="investigating")

    def test_other_needs_a_note_and_a_note_is_trimmed_and_short(self):
        whole = {"acknowledged_at": "2026-11-04T09:05:00Z", "acknowledged_by": MANAGER_ID}
        self.assertRefused("23514", self.write, acknowledgement_reason="other", **whole)
        self.assertRefused("23514", self.write, acknowledgement_reason="investigating",
                           acknowledgement_note=" padded ", **whole)
        self.assertRefused("23514", self.write, acknowledgement_reason="investigating",
                           acknowledgement_note="x" * 201, **whole)
        self.write(acknowledgement_reason="other", acknowledgement_note="x" * 200, **whole)


class Acknowledging(AcknowledgementBase):
    def test_an_operator_a_manager_and_an_administrator_each_acknowledge(self):
        for n, person in enumerate((OPERATOR_ID, MANAGER_ID, ADMIN_ID)):
            alert = self.upsert(fingerprint=f"fp-0231-{n}")
            by, email, reason, note = self.acknowledge(person, alert, "planned_work", "  shift change  ")
            self.assertEqual((by, email, reason, note),
                             (person, self.email(person), "planned_work", "shift change"))
            self.assertEqual(self.row(alert)[:2], (True, person))

    def test_an_auditor_is_refused(self):
        alert = self.upsert()
        self.assertRefused("42501", self.acknowledge, AUDITOR_ID, alert)
        self.assertEqual(self.row(alert)[0], False)

    def test_a_machine_identity_is_refused(self):
        alert = self.upsert()
        self.assertRefused("42501", self.acknowledge, MACHINE_ID, alert)
        self.assertEqual(self.row(alert)[0], False)

    def test_a_row_the_caller_cannot_read_is_not_there(self):
        alert = self.machine_alert()
        for person in (OPERATOR_ID, MANAGER_ID):
            refusal = self.assertRefused("PGRST", self.acknowledge, person, alert)
            self.assertIn('"P0002"', refusal.pgerror)
        missing = self.assertRefused("PGRST", self.acknowledge, OPERATOR_ID, str(uuid.uuid4()))
        self.assertIn('"P0002"', missing.pgerror)
        self.assertEqual(self.row(alert)[0], False)

    def test_an_administrator_acknowledges_a_machine_identity_s_alert(self):
        alert = self.machine_alert()
        self.assertEqual(self.acknowledge(ADMIN_ID, alert)[0], ADMIN_ID)

    def test_a_resolved_row_is_refused(self):
        alert = self.upsert()
        self.resolve()
        refusal = self.assertRefused("23514", self.acknowledge, OPERATOR_ID, alert)
        self.assertIn("resolved", refusal.pgerror)

    def test_a_superseded_row_is_refused(self):
        older = self.upsert(starts_at="2026-11-04T08:00:00Z")
        self.upsert(starts_at="2026-11-04T09:00:00Z")
        refusal = self.assertRefused("23514", self.acknowledge, OPERATOR_ID, older)
        self.assertIn("newer occurrence", refusal.pgerror)

    def test_an_acknowledged_row_is_refused_naming_who_and_when(self):
        alert = self.upsert()
        self.acknowledge(MANAGER_ID, alert)
        refusal = self.assertRefused("23505", self.acknowledge, OPERATOR_ID, alert, "known_cause")
        self.assertIn(self.email(MANAGER_ID), refusal.pgerror)
        self.assertIn("UTC", refusal.pgerror)
        self.assertEqual(self.row(alert)[1:4], (MANAGER_ID, self.email(MANAGER_ID), "investigating"))

    def test_other_without_a_note_is_refused(self):
        alert = self.upsert()
        self.assertRefused("22023", self.acknowledge, OPERATOR_ID, alert, "other", None)
        self.assertRefused("22023", self.acknowledge, OPERATOR_ID, alert, "other", "   ")
        self.assertEqual(self.acknowledge(OPERATOR_ID, alert, "other", "a loose wire")[2:], ("other", "a loose wire"))

    def test_an_unknown_reason_and_a_long_note_are_refused(self):
        alert = self.upsert()
        self.assertRefused("22023", self.acknowledge, OPERATOR_ID, alert, "Investigating")
        self.assertRefused("22023", self.acknowledge, OPERATOR_ID, alert, None)
        self.assertRefused("22023", self.acknowledge, OPERATOR_ID, alert, "investigating", "x" * 201)

    def test_a_signed_in_reader_cannot_write_the_columns_directly(self):
        alert = self.upsert()
        with self.assertRaises(psycopg2.errors.InsufficientPrivilege):
            self.as_person(MANAGER_ID,
                           "UPDATE public.platform_alerts SET acknowledgement_reason = 'other' WHERE id = %s;",
                           (alert,))


class Withdrawing(AcknowledgementBase):
    def test_the_acknowledger_withdraws_their_own(self):
        alert = self.upsert()
        self.acknowledge(OPERATOR_ID, alert)
        self.assertEqual(self.withdraw(OPERATOR_ID, alert), (None, None, None))
        self.assertEqual(self.row(alert), (False, None, None, None, None))

    def test_another_operator_is_refused(self):
        alert = self.upsert()
        self.acknowledge(OPERATOR_ID, alert)
        self.assertRefused("42501", self.withdraw, OTHER_OPERATOR_ID, alert)
        self.assertRefused("42501", self.withdraw, AUDITOR_ID, alert)
        self.assertEqual(self.row(alert)[:2], (True, OPERATOR_ID))

    def test_a_manager_and_an_administrator_withdraw_anyone_s(self):
        for n, person in enumerate((MANAGER_ID, ADMIN_ID)):
            alert = self.upsert(fingerprint=f"fp-0231-w{n}")
            self.acknowledge(OPERATOR_ID, alert)
            self.withdraw(person, alert)
            self.assertEqual(self.row(alert)[0], False)

    def test_an_alert_withdrawn_can_be_acknowledged_again(self):
        alert = self.upsert()
        self.acknowledge(OPERATOR_ID, alert)
        self.withdraw(MANAGER_ID, alert)
        self.assertEqual(self.acknowledge(OTHER_OPERATOR_ID, alert, "known_cause")[0], OTHER_OPERATOR_ID)

    def test_nothing_to_withdraw_and_a_resolved_alert_are_refused(self):
        alert = self.upsert()
        self.assertRefused("23514", self.withdraw, MANAGER_ID, alert)
        self.acknowledge(OPERATOR_ID, alert)
        self.resolve()
        self.assertRefused("23514", self.withdraw, MANAGER_ID, alert)
        # The resolved occurrence keeps its acknowledgement as its record.
        self.assertEqual(self.row(alert)[:2], (True, OPERATOR_ID))

    def test_a_machine_identity_s_alert_is_the_administrator_s_alone(self):
        alert = self.machine_alert()
        self.acknowledge(ADMIN_ID, alert)
        refusal = self.assertRefused("PGRST", self.withdraw, MANAGER_ID, alert)
        self.assertIn('"P0002"', refusal.pgerror)
        self.withdraw(ADMIN_ID, alert)


class Inheritance(AcknowledgementBase):
    def test_a_new_occurrence_inherits_while_the_one_before_is_firing(self):
        first = self.upsert(starts_at="2026-11-04T08:00:00Z")
        self.acknowledge(MANAGER_ID, first, "known_cause", "the feeder is down")
        second = self.upsert(starts_at="2026-11-04T09:00:00Z")
        self.assertEqual(self.row(second), (True, MANAGER_ID, self.email(MANAGER_ID), "known_cause", "the feeder is down"))
        # And the one after that, from the second.
        third = self.upsert(starts_at="2026-11-04T10:00:00Z")
        self.assertEqual(self.row(third)[1], MANAGER_ID)
        self.assertEqual(self.audit_rows("ALERT_ACKNOWLEDGED").__len__(), 1, "inheriting writes no audit row")

    def test_nothing_is_inherited_after_the_fingerprint_resolves(self):
        first = self.upsert(starts_at="2026-11-04T08:00:00Z")
        self.acknowledge(MANAGER_ID, first)
        self.resolve(starts_at="2026-11-04T08:00:00Z")
        second = self.upsert(starts_at="2026-11-04T09:00:00Z")
        self.assertEqual(self.row(second)[0], False)

    def test_a_later_resolve_supersedes_an_older_firing_acknowledged_one(self):
        # A resolve that never arrived leaves the first firing; the second came and went.
        first = self.upsert(starts_at="2026-11-04T07:00:00Z")
        self.acknowledge(MANAGER_ID, first)
        self.upsert(starts_at="2026-11-04T08:00:00Z")
        self.resolve(starts_at="2026-11-04T08:00:00Z")
        third = self.upsert(starts_at="2026-11-04T09:00:00Z")
        self.assertEqual(self.row(third)[0], False)

    def test_a_withdrawn_acknowledgement_is_not_inherited(self):
        first = self.upsert(starts_at="2026-11-04T08:00:00Z")
        self.acknowledge(OPERATOR_ID, first)
        self.withdraw(OPERATOR_ID, first)
        second = self.upsert(starts_at="2026-11-04T09:00:00Z")
        self.assertEqual(self.row(second)[0], False)

    def test_another_fingerprint_inherits_nothing(self):
        first = self.upsert(fingerprint="fp-0231-a", starts_at="2026-11-04T08:00:00Z")
        self.acknowledge(OPERATOR_ID, first)
        other = self.upsert(fingerprint="fp-0231-b", starts_at="2026-11-04T09:00:00Z")
        self.assertEqual(self.row(other)[0], False)

    def test_the_resolve_keeps_the_occurrence_s_acknowledgement(self):
        alert = self.upsert()
        self.acknowledge(OPERATOR_ID, alert, "threshold_wrong")
        self.assertEqual(self.resolve(), alert)
        self.assertEqual(self.row(alert)[:4], (True, OPERATOR_ID, self.email(OPERATOR_ID), "threshold_wrong"))

    def test_a_repeated_notification_brings_no_acknowledgement_back(self):
        first = self.upsert(starts_at="2026-11-04T08:00:00Z")
        self.acknowledge(OPERATOR_ID, first)
        second = self.upsert(starts_at="2026-11-04T09:00:00Z")
        self.withdraw(MANAGER_ID, second)
        # Grafana repeats the second's notification; the first is still firing and acknowledged.
        self.assertEqual(self.upsert(starts_at="2026-11-04T09:00:00Z"), second)
        self.assertEqual(self.row(second)[0], False)

    def test_a_row_that_arrives_resolved_inherits_nothing(self):
        first = self.upsert(starts_at="2026-11-04T08:00:00Z")
        self.acknowledge(OPERATOR_ID, first)
        late = self.resolve(starts_at="2026-11-04T09:00:00Z")
        self.assertEqual(self.row(late)[0], False)

    def test_the_trigger_is_before_insert_for_each_row(self):
        self.cur.execute(
            "SELECT tgtype, p.prosecdef FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid"
            " WHERE t.tgrelid = 'public.platform_alerts'::regclass"
            "   AND t.tgname = 'trg_platform_alerts_inherit_acknowledgement';")
        self.assertEqual(self.cur.fetchall(), [(7, True)])


class TheAuditRows(AcknowledgementBase):
    def test_an_acknowledgement_is_one_operational_row_in_the_alert_s_lane(self):
        alert = self.upsert(fingerprint="fp-0231-audit")
        self.acknowledge(OPERATOR_ID, alert, "sensor_or_model_fault", "the probe reads 0")
        rows = self.audit_rows()
        self.assertEqual(len(rows), 1)
        action, kind, entity_id, lane, by, source, old, new, cls = rows[0]
        self.assertEqual((action, kind, entity_id, lane, by, source, cls),
                         ("ALERT_ACKNOWLEDGED", "platform_alerts", lane_id("fp-0231-audit"), "asset",
                          OPERATOR_ID, "user", "operational"))
        # The alert's name, its subject and when it started, on both sides; the act on the new one.
        for snapshot in (old, new):
            self.assertEqual(snapshot["alert_name"], "Device Offline")
            self.assertEqual(snapshot["name"], "Device Offline · dev0231000000000400080000")
            self.assertEqual(snapshot["starts_at"], "2026-11-04T09:00:00.000Z")
            self.assertEqual(snapshot["subject_kind"], "device")
            self.assertEqual(snapshot["sparkplug_id"], "dev0231000000000400080000")
            self.assertEqual(snapshot["alert_id"], str(alert))
        self.assertNotIn("reason", old)
        self.assertEqual((new["reason"], new["note"]), ("sensor_or_model_fault", "the probe reads 0"))

    def test_a_withdrawal_holds_what_was_withdrawn_and_whose_it_was(self):
        alert = self.upsert(fingerprint="fp-0231-audit")
        self.acknowledge(OPERATOR_ID, alert, "investigating")
        self.withdraw(MANAGER_ID, alert)
        rows = self.audit_rows("ALERT_ACKNOWLEDGEMENT_WITHDRAWN")
        self.assertEqual(len(rows), 1)
        _, kind, entity_id, lane, by, _, old, new, cls = rows[0]
        self.assertEqual((kind, entity_id, lane, by, cls),
                         ("platform_alerts", lane_id("fp-0231-audit"), "asset", MANAGER_ID, "operational"))
        self.assertEqual((old["reason"], old["acknowledged_by"], old["acknowledged_by_email"]),
                         ("investigating", OPERATOR_ID, self.email(OPERATOR_ID)))
        self.assertNotIn("reason", new)
        self.assertEqual(new["alert_name"], "Device Offline")

    def test_a_gateway_s_alert_names_the_gateway(self):
        self.cur.execute("INSERT INTO public.areas (id, name) VALUES (%s, 'Test_0231_Area');", (str(uuid.uuid4()),))
        self.cur.execute("SELECT id FROM public.areas WHERE name = 'Test_0231_Area';")
        area = self.cur.fetchone()[0]
        cell = str(uuid.uuid4())
        self.cur.execute("INSERT INTO public.cells (id, name, area_id) VALUES (%s, 'Test_0231_Cell', %s);", (cell, area))
        gateway = str(uuid.uuid4())
        self.cur.execute("INSERT INTO public.gateways (id, name, cell_id) VALUES (%s, 'Test_0231_GW', %s)"
                         " RETURNING sparkplug_id;", (gateway, cell))
        wire = self.cur.fetchone()[0]
        alert = self.upsert(fingerprint="fp-0231-gw", entity_type="gateway", entity_id=gateway,
                            sparkplug_id=wire, alert_name="Gateway Clock Skew")
        self.acknowledge(MANAGER_ID, alert)
        new = self.audit_rows()[0][7]
        self.assertEqual((new["name"], new["subject_name"], new["subject_id"]),
                         ("Gateway Clock Skew · Test_0231_GW", "Test_0231_GW", gateway))

    def test_a_machine_identity_s_alert_is_in_its_lane_in_the_security_domain(self):
        alert = self.machine_alert()
        self.acknowledge(ADMIN_ID, alert)
        self.withdraw(ADMIN_ID, alert)
        rows = self.audit_rows()
        self.assertEqual([(r[0], r[1], r[2], r[3], r[8]) for r in rows], [
            ("ALERT_ACKNOWLEDGED", "service_principals", PRINCIPAL_ID, "security", "operational"),
            ("ALERT_ACKNOWLEDGEMENT_WITHDRAWN", "service_principals", PRINCIPAL_ID, "security", "operational"),
        ])
        self.assertEqual(rows[0][7]["name"], "Service Token Expiring")

    def test_who_reads_them(self):
        device_alert = self.upsert(fingerprint="fp-0231-audit")
        self.acknowledge(OPERATOR_ID, device_alert)
        machine_alert = self.machine_alert()
        self.acknowledge(ADMIN_ID, machine_alert)
        read = ("SELECT entity_type FROM public.audit_trail"
                " WHERE action = 'ALERT_ACKNOWLEDGED' AND recorded_at >= now() ORDER BY entity_type;")
        self.assertEqual(self.as_person(MANAGER_ID, read), [("platform_alerts",)])
        self.assertEqual(self.as_person(AUDITOR_ID, read), [("platform_alerts",), ("service_principals",)])
        self.assertEqual(self.as_person(OPERATOR_ID, read), [])

    def test_the_audit_trail_finds_them_in_the_operational_class(self):
        alert = self.upsert(fingerprint="fp-0231-audit")
        self.acknowledge(OPERATOR_ID, alert)
        machine = self.machine_alert()
        self.acknowledge(ADMIN_ID, machine)
        # From this transaction's start, so a used database's own acknowledgements are not counted.
        page = self.as_person(ADMIN_ID,
                              "SELECT public.audit_trail_page(p_limit => 50, p_action => ARRAY['ALERT_ACKNOWLEDGED'],"
                              " p_class => ARRAY['operational'], p_since => now());")[0][0]
        kinds = sorted(e["entity_type"] for e in page["events"])
        self.assertEqual(kinds, ["platform_alerts", "service_principals"])
        self.assertTrue(all(e["class"] == "operational" for e in page["events"]))

    def test_the_map_lists_both_actions_on_both_kinds(self):
        self.cur.execute(
            "SELECT action, entity_type, classes FROM public.audit_trail_action_kinds()"
            " WHERE action LIKE 'ALERT_%' ORDER BY action, entity_type;")
        self.assertEqual(self.cur.fetchall(), [
            ("ALERT_ACKNOWLEDGED", "platform_alerts", ["operational"]),
            ("ALERT_ACKNOWLEDGED", "service_principals", ["operational"]),
            ("ALERT_ACKNOWLEDGEMENT_WITHDRAWN", "platform_alerts", ["operational"]),
            ("ALERT_ACKNOWLEDGEMENT_WITHDRAWN", "service_principals", ["operational"]),
        ])


class WhoMayCall(AcknowledgementBase):
    def test_signed_in_people_call_both_and_no_other_role_does(self):
        for fn in ("public.acknowledge_alert(uuid, text, text)", "public.withdraw_alert_acknowledgement(uuid)"):
            self.cur.execute(
                "SELECT has_function_privilege('authenticated', %s, 'EXECUTE'),"
                "       has_function_privilege('anon', %s, 'EXECUTE'),"
                "       has_function_privilege('service_role', %s, 'EXECUTE');", (fn, fn, fn))
            self.assertEqual(self.cur.fetchone(), (True, False, False), fn)

    def test_an_acknowledgement_is_an_update_the_realtime_publication_carries(self):
        # The dashboard's counter subscribes to platform_alerts, so another person's
        # acknowledgement reaches every open dashboard without a reload.
        self.cur.execute(
            "SELECT p.pubupdate, c.relreplident FROM pg_publication p"
            "  JOIN pg_publication_tables t ON t.pubname = p.pubname"
            "  JOIN pg_class c ON c.oid = 'public.platform_alerts'::regclass"
            " WHERE p.pubname = 'supabase_realtime' AND t.schemaname = 'public' AND t.tablename = 'platform_alerts';")
        self.assertEqual(self.cur.fetchone(), (True, "f"))


if __name__ == "__main__":
    unittest.main()
