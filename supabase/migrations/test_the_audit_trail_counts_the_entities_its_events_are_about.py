# suite:
#   lanes: db
#   why: 0339 -- that audit_trail_page() gives matching_entities, how many entities the matching rows
#     are about, once each however many rows name one, under the same filters, purged rule and
#     policies as total_matching and over the whole match rather than the page; and that every
#     other figure it gave is unchanged.

"""
The Audit Trail counts the entities its events are about (0339).

    python supabase/migrations/test_the_audit_trail_counts_the_entities_its_events_are_about.py

Requires a migrated Supabase database (54322 by default; `npm run test:db` starts a throwaway one).

What is held here:

  * matching_entities counts each entity once, however many rows name it. A device and its nameplate
    are one entity, as they share its id.
  * It follows every filter total_matching follows: the kinds, the actions, the classes, the people,
    the search and the window. A deleted entity is left out unless deleted ones are asked for.
  * It is over the whole match: a page of one, and the next page, give the same figure.
  * The caller's own policies decide it: an Operator, who reads no audit row, counts none, and a
    Shopfloor Manager counts the entities of the rows that role may read.
  * total_matching, purged_assets and the counts are what they were.

EVERY TEST ROLLS BACK. An audit row is permanent.
"""
import json
import os
import unittest

import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

ADMIN = "a0d17280-0000-4000-8000-0000000339a1"
MANAGER = "a0d17280-0000-4000-8000-0000000339a2"
OPERATOR = "a0d17280-0000-4000-8000-0000000339a3"

LIVE_AREA = "a0d17280-0000-4000-8000-0000000339b1"
LIVE_CELL = "a0d17280-0000-4000-8000-0000000339b2"
LIVE_DEVICE = "a0d17280-0000-4000-8000-0000000339b3"
GONE_DEVICE = "a0d17280-0000-4000-8000-0000000339b4"
PERSON = "a0d17280-0000-4000-8000-0000000339b5"
SUBJECTS = [LIVE_AREA, LIVE_CELL, LIVE_DEVICE, GONE_DEVICE, PERSON]
# The rows' hour: planting the live entities writes rows of their own, now, which it leaves out.
HOUR = ("2026-04-01 00:00:00+00", "2026-04-01 01:00:00+00")

# entity, entity_type, action, changed_by, the name in the snapshot. Minutes apart, oldest first.
ROWS = (
    (LIVE_AREA, "areas", "INSERT", ADMIN, "Entities Hall"),
    (LIVE_AREA, "areas", "UPDATE", ADMIN, "Entities Hall"),
    (LIVE_AREA, "areas", "UPDATE", MANAGER, "Entities Hall"),
    (LIVE_CELL, "cells", "INSERT", MANAGER, "Entities Cell"),
    (LIVE_CELL, "cells", "UPDATE", MANAGER, "Entities Cell"),
    (LIVE_DEVICE, "devices", "INSERT", ADMIN, "Entities Pump"),
    (LIVE_DEVICE, "device_nameplate", "UPDATE", ADMIN, "Entities Pump"),
    (GONE_DEVICE, "devices", "INSERT", ADMIN, "Entities Fan"),
    (GONE_DEVICE, "devices", "DELETE", ADMIN, "Entities Fan"),
    (PERSON, "user_roles", "ROLE_GRANTED", ADMIN, None),
)

PAGE = (
    "SELECT public.audit_trail_page(p_entity_ids => %(ids)s::uuid[], p_include_purged => %(purged)s,"
    " p_entity_type => %(kinds)s::text[], p_action => %(actions)s::text[], p_changed_by => %(people)s::uuid[],"
    " p_class => %(classes)s::text[], p_search => %(search)s, p_limit => %(limit)s, p_counts => %(counts)s,"
    " p_since => %(since)s::timestamptz, p_until => %(until)s::timestamptz,"
    " p_before_recorded_at => %(before_at)s::timestamptz, p_before_id => %(before_id)s::bigint);"
)


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class Entities(unittest.TestCase):
    """Three people with roles, the live entities, and the rows, inside a transaction rolled back after."""

    def setUp(self):
        self.conn = get_connection()
        self.cur = self.conn.cursor()
        try:
            self.plant()
        except Exception:
            self.conn.rollback()
            self.conn.close()
            raise

    def plant(self):
        self.cur.execute("SELECT id, name FROM public.roles;")
        roles = {name: rid for rid, name in self.cur.fetchall()}
        for user_id, role in ((ADMIN, "Administrator"), (MANAGER, "Shopfloor_Manager"), (OPERATOR, "Operator")):
            self.cur.execute(
                "INSERT INTO auth.users (id, email, encrypted_password, created_at)"
                " VALUES (%s, %s, 'not-a-real-hash', now()) ON CONFLICT (id) DO NOTHING;",
                (user_id, f"{user_id}@entities.test"),
            )
            self.cur.execute(
                "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
                " ON CONFLICT (user_id, role_id) DO NOTHING;",
                (user_id, roles[role]),
            )
        self.cur.execute("INSERT INTO public.areas (id, name) VALUES (%s, 'Entities Hall');", (LIVE_AREA,))
        self.cur.execute("INSERT INTO public.cells (id, name) VALUES (%s, 'Entities Cell');", (LIVE_CELL,))
        self.cur.execute("INSERT INTO public.devices (id, name, cell_id, location_scope) VALUES (%s, 'Entities Pump', %s, 'cell');",
                         (LIVE_DEVICE, LIVE_CELL))
        for i, (entity, kind, action, actor, name) in enumerate(ROWS):
            self.cur.execute(
                "INSERT INTO public.audit_trail"
                "  (entity_type, entity_id, action, new_data, changed_by, actor_source, recorded_at)"
                " VALUES (%s, %s, %s, %s::jsonb, %s, 'user',"
                "         timestamptz '2026-04-01 00:00:00+00' + make_interval(mins => %s));",
                (kind, entity, action, json.dumps({"name": name} if name else {}), actor, i),
            )

    def tearDown(self):
        self.conn.rollback()
        self.conn.close()

    def as_person(self, user_id, sql, args):
        """Run `sql` as PostgREST would for a token naming `user_id`. Returns the first column of the first row."""
        self.cur.execute("SAVEPOINT entities_call;")
        try:
            self.cur.execute("SELECT set_config('role', 'authenticated', true);")
            self.cur.execute("SELECT set_config('request.jwt.claims', %s, true);",
                             (json.dumps({"sub": user_id, "role": "authenticated"}),))
            self.cur.execute(sql, args)
            value = self.cur.fetchone()[0]
        except psycopg2.Error:
            self.cur.execute("ROLLBACK TO SAVEPOINT entities_call;")
            raise
        self.cur.execute("RESET ROLE;")
        self.cur.execute("SELECT set_config('request.jwt.claims', '', true);")
        self.cur.execute("RELEASE SAVEPOINT entities_call;")
        return value

    def page(self, *, as_user=ADMIN, purged=False, kinds=None, actions=None, people=None, classes=None,
             search=None, limit=200, counts=True, window=HOUR, cursor=None):
        args = {"ids": SUBJECTS, "purged": purged, "kinds": kinds, "actions": actions, "people": people,
                "classes": classes, "search": search, "limit": limit, "counts": counts,
                "since": window[0], "until": window[1],
                "before_at": (cursor or {}).get("recorded_at"), "before_id": (cursor or {}).get("id")}
        return self.as_person(as_user, PAGE, args)

    def test_each_entity_is_counted_once_and_a_device_with_its_nameplate_is_one(self):
        payload = self.page()
        # The deleted device is hidden: an area, a cell, the live device and the person.
        self.assertEqual(payload["total_matching"], 8)
        self.assertEqual(payload["matching_entities"], 4)
        self.assertEqual({e["entity_id"] for e in payload["events"]}, {LIVE_AREA, LIVE_CELL, LIVE_DEVICE, PERSON})

    def test_a_deleted_entity_counts_only_when_deleted_ones_are_asked_for(self):
        self.assertEqual(self.page()["purged_assets"], 1)
        shown = self.page(purged=True)
        self.assertEqual(shown["total_matching"], 10)
        self.assertEqual(shown["matching_entities"], 5)
        self.assertEqual(shown["purged_assets"], 1)

    def test_it_follows_every_filter_the_total_follows(self):
        cases = {
            "kinds": (dict(kinds=["areas", "cells"]), 5, 2),
            "actions": (dict(actions=["INSERT"]), 3, 3),
            "people": (dict(people=[MANAGER]), 3, 2),
            "classes": (dict(classes=["created"]), 3, 3),
            "search": (dict(search="Entities Pump"), 2, 1),
            "window": (dict(window=("2026-04-01 00:03:00+00", "2026-04-01 00:06:00+00")), 4, 2),
            "nothing matches": (dict(actions=["EXPORTED"]), 0, 0),
        }
        for name, (filters, total, entities) in cases.items():
            with self.subTest(name):
                payload = self.page(**filters)
                self.assertEqual(payload["total_matching"], total)
                self.assertEqual(payload["matching_entities"], entities)

    def test_it_is_over_the_whole_match_not_the_page(self):
        first = self.page(limit=1)
        self.assertEqual(len(first["events"]), 1)
        self.assertEqual(first["matching_entities"], 4)
        following = self.page(limit=1, counts=False, cursor=first["next_cursor"])
        self.assertEqual(len(following["events"]), 1)
        self.assertEqual(following["matching_entities"], 4)

    def test_the_callers_own_policies_decide_it(self):
        nobody = self.page(as_user=OPERATOR)
        self.assertEqual(nobody["total_matching"], 0)
        self.assertEqual(nobody["matching_entities"], 0)
        # A Shopfloor Manager counts the entities of the rows that role reads, deleted ones left out.
        manager = self.page(as_user=MANAGER)
        readable = self.as_person(
            MANAGER,
            "SELECT count(DISTINCT t.entity_id) FROM public.audit_trail t"
            " WHERE t.entity_id = ANY (%s::uuid[]) AND t.entity_id <> %s"
            "   AND t.recorded_at >= %s::timestamptz AND t.recorded_at <= %s::timestamptz;",
            (SUBJECTS, GONE_DEVICE, *HOUR))
        self.assertEqual(manager["matching_entities"], readable)
        self.assertLessEqual(manager["matching_entities"], 4)

    def test_the_other_figures_are_unchanged(self):
        payload = self.page(purged=True)
        self.assertEqual(payload["counts"]["class"], {"created": 4, "operational": 4, "lifecycle": 1, "configuration": 1})
        self.assertEqual(payload["counts"]["entity_type"],
                         {"areas": 3, "cells": 2, "devices": 3, "device_nameplate": 1, "user_roles": 1})
        self.assertIsNone(payload["next_cursor"])
        self.assertFalse(payload["truncated"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
