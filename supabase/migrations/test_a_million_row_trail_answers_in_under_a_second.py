# suite:
#   lanes: db
#   why: 0228's target -- that on a trail of a million rows audit_trail_page() answers a page, its
#     total and its counts in under a second with a class chosen, as an Administrator with the
#     policies on, and that its totals are exact. It attaches ten months of 2001 and drops them, so
#     it belongs on a throwaway database and nowhere else.

"""
A million-row Audit Trail answers a class-filtered page in under a second (0228).

    python supabase/migrations/test_a_million_row_trail_answers_in_under_a_second.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).
NEVER POINT IT AT A STACK ANYBODY USES: it attaches ten months of 2001 to audit_trail and drops them.

What is held here:

  * On a trail of a million rows, audit_trail_page() answers one page, its total_matching and its
    counts in under a second with a class chosen, as an Administrator with the policies on: the page
    the dashboard asks for first, the same with two classes, and the next page.
  * Its totals and counts on that trail are exact.

THE SEED. A million rows in ten monthly partitions of 2001, a hundred thousand each, in the mix a
plant's trail has: half of them device status changes, the rest gateways, cells, metrics, captures,
backups, reads, people and settings, every class among them. Each month is filled as a table of its
own and then attached, so no row trigger runs a million times; the trail's indexes, the five class
indexes included, are built on attach, and VACUUM ANALYZE gives the planner and the index-only scans
what a running stack has. The live devices, gateways and cells the rows name are inserted inside each
test's transaction, and one device in ten is left out so the purged rule has rows to hide.

The ten months are dropped afterwards, as an owner retires whole months: audit_trail is append-only
to every row-level writer. A run killed before then leaves them; the next run drops them first.
The seed's time and every measured call are printed.
"""
import json
import os
import statistics
import time
import unittest

import psycopg2
from psycopg2 import sql

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

ADMIN = "a0d17280-0000-4000-8000-00000228f0a1"
MONTHS = 10
PER_MONTH = 100_000
TARGET_SECONDS = 1.0
LIVE_DEVICES = 1800  # of 2000: the other 200 are deleted
WINDOW = ("2001-01-01 00:00:00+00", "2001-11-01 00:00:00+00")

# By row number % 100: (entity_type, action, class). The kinds and the snapshots are in SEED below.
BUCKETS = (
    [("devices", "UPDATE", "operational")] * 50
    + [("gateways", "UPDATE", "operational")] * 10
    + [("devices", "INSERT", "created")] * 5
    + [("devices", "DELETE", "lifecycle")] * 3
    + [("devices", "UPDATE", "lifecycle")]
    + [("devices", "UPDATE", "configuration")]
    + [("cells", "UPDATE", "operational")] * 3
    + [("cells", "UPDATE", "lifecycle")]
    + [("gateways", "FLOW_DEPLOYED", "operational")] * 3
    + [("captures", "CAPTURE_RECORDED", "created")] * 2
    + [("captures", "CAPTURE_DOWNLOAD_ISSUED", "read")]
    + [("captures", "CAPTURE_DELETED", "lifecycle")]
    + [("backups", "BACKUP_TAKEN", "configuration")] * 3
    + [("service_logs", "SERVICE_LOGS_READ", "read")] * 3
    + [("user_roles", "SESSIONS_ENDED", "configuration")] * 3
    + [("metric_catalog", "UPDATE", "operational")] * 3
    + [("metric_catalog", "UPDATE", "lifecycle")]
    + [("device_submodels", "INSERT", "configuration")] * 2
    + [("system_settings", "UPDATE", "configuration")] * 2
    + [("gateways", "CREDENTIAL_SHOWN", "read")]
    + [("devices", "EXPORTED", "read")]
)
DEVICE_KEYED = {"devices", "device_submodels"}

# One month's rows. `g` numbers the row across the trail; `b` is its bucket, `j` the device it names.
SEED = """
INSERT INTO public.{table}
  (id, entity_type, entity_id, action, old_data, new_data, actor_source, causation_id, recorded_at, audit_domain)
SELECT nextval('public.audit_trail_id_seq'), r.entity_type, r.entity_id, r.action, r.old_data, r.new_data,
       'user', s.g / 3, %(start)s::timestamptz + s.i * (%(end)s::timestamptz - %(start)s::timestamptz) / 100001,
       public.audit_domain_for(r.entity_type, r.action)
  FROM generate_series(1, %(rows)s) AS n(i)
 CROSS JOIN LATERAL (SELECT n.i AS i, %(offset)s + n.i AS g, (%(offset)s + n.i) %% 100 AS b) s
 CROSS JOIN LATERAL (
   SELECT md5('million-device-' || (s.g %% 2000))::uuid AS dev,
          jsonb_build_object('name', 'Million Device ' || (s.g %% 2000), 'status', 'ONLINE',
                             'is_quarantined', false, 'is_archived', false, 'connection_method', 'sparkplug',
                             'sparkplug_id', 'million' || (s.g %% 2000), 'identity_source', 'dbirth',
                             'location_scope', 'cell', 'conformance_policy', 'audit',
                             'description', 'A device on the million-row trail') AS snap,
          jsonb_build_object('name', 'Million Gateway ' || (s.g %% 50), 'live_status', 'ONLINE',
                             'is_archived', false, 'deployment', 'remote') AS gw
 ) d
 CROSS JOIN LATERAL (
   SELECT CASE WHEN s.b < 50 OR s.b BETWEEN 60 AND 69 OR s.b = 99 THEN 'devices'
               WHEN s.b < 60 OR s.b BETWEEN 74 AND 76 OR s.b = 98 THEN 'gateways'
               WHEN s.b < 74 THEN 'cells'
               WHEN s.b < 81 THEN 'captures'
               WHEN s.b < 84 THEN 'backups'
               WHEN s.b < 87 THEN 'service_logs'
               WHEN s.b < 90 THEN 'user_roles'
               WHEN s.b < 94 THEN 'metric_catalog'
               WHEN s.b < 96 THEN 'device_submodels'
               ELSE 'system_settings' END AS entity_type,
          CASE WHEN s.b < 50 OR s.b BETWEEN 60 AND 69 OR s.b BETWEEN 94 AND 95 OR s.b = 99 THEN d.dev
               WHEN s.b < 60 OR s.b BETWEEN 74 AND 76 OR s.b = 98 THEN md5('million-gateway-' || (s.g %% 50))::uuid
               WHEN s.b < 74 THEN md5('million-cell-' || (s.g %% 100))::uuid
               WHEN s.b < 81 THEN md5('million-capture-' || (s.g %% 500))::uuid
               WHEN s.b < 84 THEN md5('million-backup-' || (s.g %% 300))::uuid
               WHEN s.b < 87 THEN md5('service_logs:million')::uuid
               WHEN s.b < 90 THEN md5('million-person-' || (s.g %% 20))::uuid
               WHEN s.b < 94 THEN md5('million-metric-' || (s.g %% 400))::uuid
               ELSE md5('million-setting-' || (s.g %% 30))::uuid END AS entity_id,
          CASE WHEN s.b < 60 OR s.b BETWEEN 68 AND 73 OR s.b BETWEEN 90 AND 93 OR s.b BETWEEN 96 AND 97 THEN 'UPDATE'
               WHEN s.b < 65 OR s.b BETWEEN 94 AND 95 THEN 'INSERT'
               WHEN s.b < 68 THEN 'DELETE'
               WHEN s.b < 77 THEN 'FLOW_DEPLOYED'
               WHEN s.b < 79 THEN 'CAPTURE_RECORDED'
               WHEN s.b = 79 THEN 'CAPTURE_DOWNLOAD_ISSUED'
               WHEN s.b = 80 THEN 'CAPTURE_DELETED'
               WHEN s.b < 84 THEN 'BACKUP_TAKEN'
               WHEN s.b < 87 THEN 'SERVICE_LOGS_READ'
               WHEN s.b < 90 THEN 'SESSIONS_ENDED'
               WHEN s.b = 98 THEN 'CREDENTIAL_SHOWN'
               ELSE 'EXPORTED' END AS action,
          CASE WHEN s.b < 50 OR s.b BETWEEN 65 AND 69 THEN d.snap
               WHEN s.b < 60 THEN d.gw
               WHEN s.b < 74 THEN jsonb_build_object('name', 'Million Cell', 'is_archived', false)
               WHEN s.b < 77 THEN jsonb_build_object('flow_hash', 'a')
               WHEN s.b = 80 THEN jsonb_build_object('name', 'Million capture')
               WHEN s.b BETWEEN 90 AND 93 THEN jsonb_build_object('name', 'temperature', 'deprecated', false)
               WHEN s.b BETWEEN 96 AND 97 THEN jsonb_build_object('key', 'ui.million', 'value', 1)
               END AS old_data,
          CASE WHEN s.b < 50 THEN d.snap || jsonb_build_object('status', 'OFFLINE')
               WHEN s.b < 60 THEN d.gw || jsonb_build_object('live_status', 'OFFLINE')
               WHEN s.b < 65 THEN d.snap
               WHEN s.b < 68 THEN NULL
               WHEN s.b = 68 THEN d.snap || jsonb_build_object('is_quarantined', true)
               WHEN s.b = 69 THEN d.snap || jsonb_build_object('connection_method', 'opcua')
               WHEN s.b < 73 THEN jsonb_build_object('name', 'Million Line', 'is_archived', false)
               WHEN s.b = 73 THEN jsonb_build_object('name', 'Million Cell', 'is_archived', true)
               WHEN s.b < 77 THEN jsonb_build_object('flow_hash', 'b')
               WHEN s.b < 80 THEN jsonb_build_object('name', 'Million capture', 'message_count', 120)
               WHEN s.b = 80 THEN NULL
               WHEN s.b < 84 THEN jsonb_build_object('stamp', '20010101T000000Z', 'job_id', md5('million-job-' || (s.g %% 300))::uuid)
               WHEN s.b < 87 THEN jsonb_build_object('name', 'ingestion', 'level', 'error', 'range', '1h')
               WHEN s.b < 90 THEN jsonb_build_object('ended', 2)
               WHEN s.b < 93 THEN jsonb_build_object('name', 'temperature_c', 'deprecated', false)
               WHEN s.b = 93 THEN jsonb_build_object('name', 'temperature', 'deprecated', true)
               WHEN s.b < 96 THEN jsonb_build_object('device_id', d.dev, 'schema_id', md5('million-schema')::uuid)
               WHEN s.b < 98 THEN jsonb_build_object('key', 'ui.million', 'value', 2)
               WHEN s.b = 98 THEN jsonb_build_object('name', 'Million Gateway', 'sparkplug_id', 'milliongw')
               ELSE jsonb_build_object('entity_type', 'devices', 'format', 'aasx', 'object_bytes', 4096) END AS new_data
 ) r;
"""

PAGE = (
    "SELECT public.audit_trail_page(p_limit => 200, p_class => %(classes)s::text[], p_counts => %(counts)s,"
    " p_since => %(since)s::timestamptz, p_until => %(until)s::timestamptz,"
    " p_before_recorded_at => %(before_at)s::timestamptz, p_before_id => %(before_id)s::bigint);"
)


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    return conn


def month(m):
    """The bounds of the m'th month of 2001, from 1."""
    nxt = f"2001-{m + 1:02d}-01" if m < 12 else "2002-01-01"
    return f"2001-{m:02d}-01 00:00:00+00", f"{nxt} 00:00:00+00"


def partitions():
    return [f"audit_trail_million_{m:02d}" for m in range(1, MONTHS + 1)]


def expected_counts():
    """The seed's events by class, kind and action, with the deleted devices' rows left out."""
    out = {"class": {}, "entity_type": {}, "action": {}}
    hidden = 0
    for g in range(1, MONTHS * PER_MONTH + 1):
        kind, action, cls = BUCKETS[g % 100]
        if kind in DEVICE_KEYED and g % 2000 >= LIVE_DEVICES:
            hidden += 1
            continue
        for key, value in (("class", cls), ("entity_type", kind), ("action", action)):
            out[key][value] = out[key].get(value, 0) + 1
    return out, hidden


class AMillionRows(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.admin = get_connection()
        cls.admin.autocommit = True
        cur = cls.admin.cursor()
        cls.drop_partitions(cur)
        started = time.perf_counter()
        for m, table in enumerate(partitions(), start=1):
            start, end = month(m)
            name = sql.Identifier(table)
            bound = sql.Identifier(f"{table}_bound")
            cur.execute(sql.SQL("CREATE TABLE public.{} (LIKE public.audit_trail INCLUDING DEFAULTS INCLUDING CONSTRAINTS);")
                        .format(name))
            # The partition's own bound as a CHECK, so attaching it needs no scan to prove it.
            cur.execute(sql.SQL("ALTER TABLE public.{} ADD CONSTRAINT {}"
                                " CHECK (recorded_at >= %s::timestamptz AND recorded_at < %s::timestamptz);")
                        .format(name, bound), (start, end))
            cur.execute(sql.SQL(SEED).format(table=name),
                        {"start": start, "end": end, "rows": PER_MONTH, "offset": (m - 1) * PER_MONTH})
            cur.execute(sql.SQL("ALTER TABLE public.audit_trail ATTACH PARTITION public.{} FOR VALUES FROM (%s) TO (%s);")
                        .format(name), (start, end))
            cur.execute(sql.SQL("ALTER TABLE public.{} DROP CONSTRAINT {};").format(name, bound))
        for table in partitions():
            cur.execute(sql.SQL("VACUUM ANALYZE public.{};").format(sql.Identifier(table)))
        cls.seed_seconds = time.perf_counter() - started
        print(f"\n  seeded {MONTHS * PER_MONTH:,} rows in {MONTHS} months in {cls.seed_seconds:.1f} s", flush=True)
        cls.expected, cls.hidden = expected_counts()

    @classmethod
    def tearDownClass(cls):
        cls.drop_partitions(cls.admin.cursor())
        cls.admin.close()

    @staticmethod
    def drop_partitions(cur):
        for table in partitions():
            cur.execute(sql.SQL("DROP TABLE IF EXISTS public.{};").format(sql.Identifier(table)))

    def setUp(self):
        self.conn = get_connection()
        self.conn.autocommit = False
        self.cur = self.conn.cursor()
        try:
            self.live_entities()
        except Exception:
            # tearDown does not run after a failed setUp, and an open transaction would hold the
            # rows every later test inserts.
            self.conn.rollback()
            self.conn.close()
            raise

    def live_entities(self):
        self.cur.execute("SELECT id, name FROM public.roles WHERE name = 'Administrator';")
        role = self.cur.fetchone()[0]
        self.cur.execute(
            "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
            " VALUES (%s, 'million@classes.test', 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;", (ADMIN,))
        self.cur.execute("INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                         " ON CONFLICT (user_id, role_id) DO NOTHING;", (ADMIN, role))
        # The entities the rows name, inside this transaction: every cell and gateway, and 1800 of
        # the 2000 devices.
        self.cur.execute("INSERT INTO public.cells (id, name) SELECT md5('million-cell-' || j)::uuid,"
                         " 'Million Cell ' || j FROM generate_series(0, 99) j;")
        self.cur.execute("INSERT INTO public.gateways (id, name, cell_id) SELECT md5('million-gateway-' || j)::uuid,"
                         " 'Million Gateway ' || j, md5('million-cell-' || j)::uuid FROM generate_series(0, 49) j;")
        self.cur.execute("INSERT INTO public.devices (id, name, cell_id) SELECT md5('million-device-' || j)::uuid,"
                         " 'Million Device ' || j, md5('million-cell-' || (j %% 100))::uuid"
                         " FROM generate_series(0, %s) j;", (LIVE_DEVICES - 1,))
        self.cur.execute("SELECT set_config('role', 'authenticated', true);")
        self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                         (json.dumps({"sub": ADMIN, "role": "authenticated"}),))

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def call(self, classes=None, counts=True, window=(None, None), cursor=None):
        args = {"classes": classes, "counts": counts, "since": window[0], "until": window[1],
                "before_at": (cursor or {}).get("recorded_at"), "before_id": (cursor or {}).get("id")}
        started = time.perf_counter()
        self.cur.execute(PAGE, args)
        payload = self.cur.fetchone()[0]
        return payload, time.perf_counter() - started

    def timed(self, label, **kwargs):
        """A warm-up call, then three timed ones; their median, and every time, printed."""
        self.call(**kwargs)
        runs = [self.call(**kwargs) for _ in range(3)]
        seconds = [s for _, s in runs]
        print(f"  {label}: " + ", ".join(f"{s * 1000:.0f} ms" for s in seconds), flush=True)
        return runs[-1][0], statistics.median(seconds)

    def test_one_class_its_page_its_total_and_its_counts(self):
        """The first page the dashboard asks for with Lifecycle chosen, over all time."""
        payload, seconds = self.timed("All time, Lifecycle, with the counts", classes=["lifecycle"])
        self.assertEqual(len(payload["events"]), 200)
        self.assertTrue(all(e["class"] == "lifecycle" for e in payload["events"]))
        self.assertGreaterEqual(payload["total_matching"], self.expected["class"]["lifecycle"])
        self.assertLess(seconds, TARGET_SECONDS)

    def test_two_classes(self):
        payload, seconds = self.timed("All time, Read and Lifecycle, with the counts", classes=["read", "lifecycle"])
        self.assertEqual({e["class"] for e in payload["events"]} - {"read", "lifecycle"}, set())
        self.assertLess(seconds, TARGET_SECONDS)

    def test_the_next_page(self):
        """Show more: the cursor, without the counts."""
        first, _ = self.call(classes=["lifecycle"])
        payload, seconds = self.timed("All time, Lifecycle, the next page", classes=["lifecycle"], counts=False,
                                      cursor=first["next_cursor"])
        self.assertEqual(len(payload["events"]), 200)
        self.assertLess(seconds, TARGET_SECONDS)

    def test_nothing_chosen_is_measured(self):
        """The default first page, every class counted. Printed, not asserted: the target is a class's."""
        payload, _ = self.timed("All time, nothing chosen, with the counts")
        self.assertEqual(len(payload["events"]), 200)

    def test_the_totals_and_the_counts_are_exact(self):
        """Over the ten months alone, so no other suite's rows are counted."""
        payload, _ = self.call(classes=["lifecycle"], window=WINDOW)
        self.assertEqual(payload["total_matching"], self.expected["class"]["lifecycle"])
        self.assertEqual(payload["counts"]["class"], self.expected["class"])
        # The deleted devices the chosen class's rows name: device j appears in bucket j % 100.
        def gone(cls):
            return len({j for j in range(LIVE_DEVICES, 2000)
                        if BUCKETS[j % 100][0] in DEVICE_KEYED and cls in (None, BUCKETS[j % 100][2])})

        self.assertEqual(payload["purged_assets"], gone("lifecycle"))
        lifecycle = [b for b in BUCKETS if b[2] == "lifecycle"]
        self.assertEqual(set(payload["counts"]["action"]), {b[1] for b in lifecycle})
        self.assertEqual(set(payload["counts"]["entity_type"]), {b[0] for b in lifecycle})
        everything, _ = self.call(window=WINDOW)
        self.assertEqual(everything["total_matching"], MONTHS * PER_MONTH - self.hidden)
        self.assertEqual(everything["purged_assets"], gone(None))
        self.assertEqual(everything["counts"]["entity_type"], self.expected["entity_type"])
        self.assertEqual(everything["counts"]["action"], self.expected["action"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
