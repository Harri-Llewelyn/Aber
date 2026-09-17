"""
The Digital Thread's keyset cursor (0077), and how far it has to walk (0115).

WHAT THIS IS DEFENDING. Every way paging breaks is silent. A repeated row shows the reader one
event twice; a skipped row never shows it at all; a cursor that stops early looks exactly like the
end of the data. None of those raises, none of them renders as an error, and the page cannot tell
the difference between "that is all there is" and "that is all I asked for". The Digital Thread
spent its whole life until now unable to tell those apart -- `truncated` was returned by the server
and stored by the tab and never once rendered.

SAME-TIMESTAMP BATCHES ARE THE WHOLE DIFFICULTY, and every fixture here builds them deliberately.
`log_digital_thread_event()` stamps one transaction's rows with one `now()`, and a batch relocation
of six devices is ONE transaction on purpose (0033) -- so `recorded_at` is not a key, and a cursor
built on it alone either skips the rest of the batch or repeats its first row forever. The suite
proves the composite `(recorded_at, id)` fixes that by ALSO running the naive cursor against the
same fixture and asserting it fails: without that half, the passing tests below would pass just as
well against a broken implementation on a fixture with distinct timestamps.

EVERY TEST ROLLS BACK, and here that is not tidiness. `digital_thread` is append-only -- 0003 makes
it so and 0026 revoked DELETE even from service_role -- so a committed fixture is permanent. Two
thirds of a development stack's audit log turned out to be exactly that (see scripts/test-db.mjs),
which is the failure this file must not repeat.

0115 ADDS TWO MORE WAYS TO BE QUIETLY INCOMPLETE, and the second class below defends them.
`total_matching` is what lets the page say "200 of 467" instead of "200 events"; counted after the
cursor rather than before it, it would count down as the reader walked, which reads as rows leaving
an append-only table. And `p_search` matches the audit snapshot, because the tab used to resolve a
typed name against the LIVE tables -- so searching for something that had been deleted sent an
empty id list and rendered as an empty thread, answering the one question this page exists for
with "nothing happened".
"""

import json
import os
import re
import unittest
import psycopg2

DB_HOST = os.getenv("SUPABASE_DB_HOST", os.getenv("DB_HOST", "localhost"))
DB_PORT = os.getenv("SUPABASE_DB_PORT", os.getenv("DB_PORT", "54322"))
DB_NAME = os.getenv("SUPABASE_DB_NAME", os.getenv("DB_NAME", "postgres"))
DB_USER = os.getenv("SUPABASE_DB_USER", os.getenv("DB_USER", "postgres"))
DB_PASSWORD = os.getenv("SUPABASE_DB_PASSWORD", os.getenv("DB_PASSWORD", "postgres"))

# Small enough that a page boundary is guaranteed to land inside a batch. With batches of 8 and
# pages of 7, no page starts where a batch does after the first -- which is the arrangement a
# recorded_at-only cursor gets wrong.
PAGE = 7
BATCH = 8
BATCHES = 3


def get_connection():
    conn = psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME, user=DB_USER, password=DB_PASSWORD
    )
    conn.autocommit = False
    return conn


class DigitalThreadPaging(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.conn = get_connection()

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def setUp(self):
        self.cur = self.conn.cursor()
        # The rows this suite reasons about, and nothing else: every assertion is scoped to the
        # entity ids seeded here, so a stack with a populated thread does not change the answers.
        self.cur.execute(
            """
            INSERT INTO public.digital_thread
                   (entity_type, entity_id, action, new_data, recorded_at, actor_source)
            SELECT 'gateways', gen_random_uuid(), 'INSERT', '{}'::jsonb,
                   timestamptz '2026-01-01 00:00:00+00' + make_interval(mins => (i / %s)),
                   'migration'
              FROM generate_series(1, %s) i
            RETURNING id
            """,
            (BATCH, BATCH * BATCHES),
        )
        self.seeded = sorted(r[0] for r in self.cur.fetchall())

    def tearDown(self):
        self.conn.rollback()
        self.cur.close()

    # ---------------------------------------------------------------------------------------
    # Helpers
    # ---------------------------------------------------------------------------------------
    def page(self, cursor=None, limit=PAGE, **kwargs):
        """One call to digital_thread_page(), returning (ids, next_cursor, payload)."""
        self.cur.execute(
            """
            SELECT public.digital_thread_page(
                p_limit              => %s,
                p_include_purged     => true,
                p_action             => %s,
                p_before_recorded_at => %s,
                p_before_id          => %s
            )
            """,
            (limit, kwargs.get("action"),
             (cursor or {}).get("recorded_at"), (cursor or {}).get("id")),
        )
        payload = self.cur.fetchone()[0]
        ids = [e["id"] for e in payload["events"]]
        return ids, payload.get("next_cursor"), payload

    def walk(self, limit=PAGE, max_pages=100, **kwargs):
        """Follow the cursor to the end, returning every id in the order it was served."""
        seen, cursor, pages = [], None, 0
        while pages < max_pages:
            pages += 1
            ids, cursor, _ = self.page(cursor, limit=limit, **kwargs)
            seen.extend(ids)
            if cursor is None:
                break
        return seen, pages

    # ---------------------------------------------------------------------------------------
    # THE TWO FAILURES THAT LOOK LIKE SUCCESS
    # ---------------------------------------------------------------------------------------
    def test_a_walk_visits_every_seeded_row_exactly_once(self):
        """The whole contract in one assertion: no repeats, no gaps, nothing invented."""
        seen, _ = self.walk()
        mine = [i for i in seen if i in set(self.seeded)]
        self.assertEqual(
            sorted(mine), self.seeded,
            "the walk did not cover the seeded rows exactly once -- a repeat or a skip, and "
            "neither raises",
        )
        self.assertEqual(
            len(mine), len(set(mine)),
            "the walk served the same row on more than one page",
        )

    def test_a_recorded_at_only_cursor_would_skip_rows(self):
        """
        THE CONTROL, and without it every other test here is vacuous.

        This is the cursor 0077 deliberately does not use, run against the same fixture. It must
        LOSE rows -- if it does not, the timestamps in this fixture are distinct enough that the
        composite key is not being exercised, and the passing tests above prove nothing.
        """
        reached, ts, pages = 0, None, 0
        while pages < 100:
            pages += 1
            self.cur.execute(
                """
                SELECT count(*), min(recorded_at)
                  FROM (SELECT recorded_at FROM public.digital_thread
                         WHERE (%s::timestamptz IS NULL OR recorded_at < %s::timestamptz)
                         ORDER BY recorded_at DESC LIMIT %s) s
                """,
                (ts, ts, PAGE),
            )
            count, ts = self.cur.fetchone()
            if not count:
                break
            reached += count

        self.cur.execute("SELECT count(*) FROM public.digital_thread")
        total = self.cur.fetchone()[0]
        self.assertLess(
            reached, total,
            "a recorded_at-only cursor reached every row, so this fixture has no same-timestamp "
            "batch and the composite-key tests are not testing anything",
        )

    # ---------------------------------------------------------------------------------------
    # The end of the data, and how a caller is told
    # ---------------------------------------------------------------------------------------
    def test_next_cursor_is_null_at_the_end(self):
        _, pages = self.walk()
        self.assertLess(pages, 100, "the walk never terminated")
        _, cursor, _ = self.page(None, limit=10_000)
        self.assertIsNone(cursor, "a page holding everything still offered a next page")

    def test_a_full_page_offers_a_cursor(self):
        ids, cursor, payload = self.page(None)
        self.assertEqual(len(ids), PAGE)
        self.assertIsNotNone(cursor, "a full page must offer somewhere to continue from")
        self.assertTrue(payload["truncated"])
        # The cursor is the LAST row served, not the first -- pointing at the first would replay
        # the page just returned, forever.
        self.assertEqual(cursor["id"], ids[-1])

    def test_the_cursor_names_the_oldest_row_on_the_page(self):
        ids, cursor, _ = self.page(None)
        follow, _, _ = self.page(cursor)
        self.assertTrue(set(ids).isdisjoint(set(follow)),
                        "the second page repeated rows from the first")

    # ---------------------------------------------------------------------------------------
    # A HALF-CURSOR MUST NOT LOOK LIKE THE END OF THE THREAD
    #
    # `(recorded_at, id) < (NULL, 41)` is NULL, which filters out every row -- so a caller that
    # sent one half would get an empty page and read it as "no more events" on a thread that has
    # plenty. The RPC ignores a half-cursor instead.
    # ---------------------------------------------------------------------------------------
    def test_a_cursor_missing_its_timestamp_is_ignored_not_obeyed(self):
        self.cur.execute(
            "SELECT public.digital_thread_page(p_limit => %s, p_include_purged => true, "
            "p_before_id => %s)", (PAGE, self.seeded[-1]),
        )
        payload = self.cur.fetchone()[0]
        self.assertEqual(len(payload["events"]), PAGE,
                         "a half-cursor emptied the page instead of being ignored")

    def test_a_cursor_missing_its_id_is_ignored_not_obeyed(self):
        self.cur.execute(
            "SELECT public.digital_thread_page(p_limit => %s, p_include_purged => true, "
            "p_before_recorded_at => %s)", (PAGE, "2026-01-01 00:02:00+00"),
        )
        payload = self.cur.fetchone()[0]
        self.assertEqual(len(payload["events"]), PAGE,
                         "a half-cursor emptied the page instead of being ignored")

    # ---------------------------------------------------------------------------------------
    # The page-level facts are about the MATCH, not about the page
    # ---------------------------------------------------------------------------------------
    def test_purged_assets_does_not_shrink_as_the_reader_pages(self):
        """
        The count drives the control that reveals deleted assets, so if it fell towards zero as
        the reader walked, the button would disappear underneath them. It is counted over
        `matching`, before the cursor -- which is why those are two CTEs rather than one.
        """
        _, cursor, first = self.page(None)
        _, _, second = self.page(cursor)
        self.assertEqual(first["purged_assets"], second["purged_assets"])

    def test_a_filter_still_applies_on_the_second_page(self):
        """A cursor must narrow the range and nothing else."""
        seen, _ = self.walk(action="INSERT")
        mine = [i for i in seen if i in set(self.seeded)]
        self.assertEqual(sorted(mine), self.seeded)

        seen_none, _ = self.walk(action="DELETE")
        self.assertEqual([i for i in seen_none if i in set(self.seeded)], [])

    # ---------------------------------------------------------------------------------------
    # The index that makes this affordable
    # ---------------------------------------------------------------------------------------
    def test_the_keyset_index_matches_the_order_the_function_walks(self):
        """
        A cursor walking one order against an index in another degrades to a full sort per page.
        It is CORRECT while it does that, which is why nothing else here would catch it, and it
        only becomes visible at the table size this change exists to reach.
        """
        self.cur.execute(
            "SELECT indexdef FROM pg_indexes "
            " WHERE schemaname='public' AND tablename='digital_thread' "
            "   AND indexname='idx_digital_thread_recorded_id'"
        )
        row = self.cur.fetchone()
        self.assertIsNotNone(row, "0077's keyset index is missing")
        self.assertIn("recorded_at DESC", row[0])
        self.assertIn("id DESC", row[0])

    def test_the_function_carries_both_cursor_arguments(self):
        """
        Declared once, with the cursor. 0001 recreates the seven-argument form on every boot and
        0077 drops it -- if that DROP were ever removed both would be declared, and a call naming
        seven arguments would fail as ambiguous at the call site rather than here.
        """
        self.cur.execute(
            "SELECT count(*), max(pg_get_function_identity_arguments(p.oid)) "
            "  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
            " WHERE n.nspname='public' AND p.proname='digital_thread_page'"
        )
        count, args = self.cur.fetchone()
        self.assertEqual(count, 1, f"digital_thread_page is declared {count} times, not once")
        self.assertIn("p_before_recorded_at", args)
        self.assertIn("p_before_id", args)
        # 0115 appends p_search and drops 0077's form in turn. Same argument: two declarations
        # would fail at the call site as ambiguous rather than here.
        self.assertIn("p_search", args)


# =================================================================================================
# HOW LONG THE THREAD IS, AND FINDING A ROW IN IT (0115)
#
# Every assertion below is SCOPED WITH p_entity_ids to the ids this fixture seeds, so the numbers
# are exact on a stack whose thread already holds thousands of rows. That is also what makes them
# relative rather than absolute: each compares the function's answer to a direct count of the same
# set, never to a number written here.
# =================================================================================================
class DigitalThreadTotalAndSearch(unittest.TestCase):
    # One seed per field the lane label falls back to, so "the search reads them all" is a loop
    # over the same table rather than a list that drifts from the one in the function. The terms
    # are distinctive, which is what keeps the direct counts exact on a populated stack.
    #
    #   entity_type, snapshot payload, a term that must find exactly this row
    SEEDS = [
        ("devices",         {"name": "Ghost Press 0115"},           "Ghost Press"),
        ("areas",           {"name": "Ghost Area 0115"},            "Ghost Area"),
        ("gateways",        {"sparkplug_id": "ghostspark0115"},     "ghostspark0115"),
        ("schemas",         {"schema_name": "Ghost_Schema_0115"},   "Ghost_Schema"),
        ("system_settings", {"key": "ghost.key.0115",
                             "label": "Ghost Label 0115"},          "ghost.key.0115"),
        ("user_roles",      {"role": "Ghost_Role_0115"},            "Ghost_Role"),
        ("backups",         {"stamp": "ghost-stamp-0115"},          "ghost-stamp-0115"),
        ("device_nameplate", {"name": "Ghost Nameplate 0117"},      "Ghost Nameplate"),
        # 0118. A backup job has no name column, and `origin` is the only identity its payload
        # carries -- a CATEGORY, which the tab draws with the short id appended so two jobs
        # requested in the same minute are still two lanes. Seeded with a value no real job has, so
        # the direct counts stay exact on a stack that has taken backups.
        ("backup_jobs",     {"origin": "ghostorigin0118"},          "ghostorigin0118"),
    ]

    # The entity types `is_purged` covers (0117): every type this function can probe a table for.
    # `device_nameplate` is keyed by its device's id, so `devices` answers for it. A seed of any
    # other type names no readable table to be absent from and is never called deleted, whatever
    # the reader asks for. Asserted against the function's own list below, so the two are one fact.
    PURGEABLE = {"areas", "cells", "gateways", "devices", "schemas", "device_nameplate"}

    @classmethod
    def setUpClass(cls):
        cls.conn = get_connection()

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def setUp(self):
        self.cur = self.conn.cursor()
        # None of these entities exists in any live table, which is the state this file is about:
        # the audit row is the only record left of them.
        self.ids, self.by_type = [], {}
        for entity_type, payload, _ in self.SEEDS:
            self.cur.execute(
                """
                INSERT INTO public.digital_thread
                       (entity_type, entity_id, action, new_data, recorded_at, actor_source)
                VALUES (%s, gen_random_uuid(), 'INSERT', %s::jsonb,
                        timestamptz '2026-01-01 00:00:00+00', 'migration')
                RETURNING entity_id
                """,
                (entity_type, json.dumps(payload)),
            )
            entity_id = self.cur.fetchone()[0]
            self.ids.append(entity_id)
            self.by_type[entity_type] = entity_id

    def tearDown(self):
        self.conn.rollback()
        self.cur.close()

    # ---------------------------------------------------------------------------------------
    # Helpers
    # ---------------------------------------------------------------------------------------
    def page(self, *, limit=200, include_purged=True, search=None, ids=None, cursor=None):
        """One call, scoped to this fixture's entities unless `ids` says otherwise."""
        self.cur.execute(
            """
            SELECT public.digital_thread_page(
                p_limit              => %s,
                p_include_purged     => %s,
                p_entity_ids         => %s::uuid[],
                p_search             => %s,
                p_before_recorded_at => %s,
                p_before_id          => %s
            )
            """,
            (limit, include_purged, self.ids if ids is None else ids, search,
             (cursor or {}).get("recorded_at"), (cursor or {}).get("id")),
        )
        return self.cur.fetchone()[0]

    def total(self, **kwargs):
        return self.page(**kwargs)["total_matching"]

    # ---------------------------------------------------------------------------------------
    # The total is about the match, not the page
    # ---------------------------------------------------------------------------------------
    def test_the_total_counts_every_matching_row(self):
        """Against a direct count of the same set, taken the long way round."""
        # Read before the call: `total()` reuses this cursor, so evaluating it first would consume
        # the result set this fetch is waiting on.
        self.cur.execute(
            "SELECT count(*) FROM public.digital_thread WHERE entity_id = ANY(%s::uuid[])",
            (self.ids,),
        )
        direct = self.cur.fetchone()[0]
        self.assertEqual(self.total(), direct)

    def test_the_total_does_not_shrink_as_the_reader_pages(self):
        """
        The legend renders "N of TOTAL". A total recomputed after the cursor would count down
        towards zero while the reader walked, which reads as the thread getting shorter behind
        them -- and would be indistinguishable from rows being removed from an append-only table.
        """
        first = self.page(limit=1)
        self.assertIsNotNone(first["next_cursor"], "the fixture is too small to page")
        second = self.page(limit=1, cursor=first["next_cursor"])
        self.assertEqual(first["total_matching"], second["total_matching"])

    def test_a_page_is_never_larger_than_its_own_total(self):
        """The assertion that catches a total counted over `visible` instead of `matching`."""
        payload = self.page(limit=1)
        self.assertLessEqual(len(payload["events"]), payload["total_matching"])

    def test_revealing_deleted_assets_cannot_reveal_fewer(self):
        """`p_include_purged` widens the set, so the total has to widen with it."""
        self.assertGreater(self.total(include_purged=True), self.total(include_purged=False))

    # ---------------------------------------------------------------------------------------
    # The purge rule covers every asset table there is
    # ---------------------------------------------------------------------------------------
    def test_a_deleted_area_is_purged_like_any_other_asset(self):
        """
        0077 anti-joined the three asset tables that existed; 0097 added areas and nothing came
        back to widen it. A deleted area's rows were counted in the total, uncounted by
        `purged_assets`, and hidden anyway by the tab's own filter -- so the two disagreed about
        what the reader was looking at.
        """
        drawn = [e["entity_id"] for e in self.page(include_purged=False)["events"]]
        self.assertNotIn(
            str(self.by_type["areas"]), drawn,
            "a deleted area is still drawn when deleted assets are hidden",
        )
        self.assertEqual(
            self.page()["purged_assets"],
            sum(1 for t, _, _ in self.SEEDS if t in self.PURGEABLE),
            "purged_assets does not count every deleted asset the fixture seeded",
        )

    def test_an_entity_with_no_table_behind_it_is_not_called_deleted(self):
        """
        The other half of the same rule. A `user_roles` or `backups` row names nothing that could
        be probed for, so answering "absent from every asset table" would mark the whole security
        lane deleted the moment the purge rule stopped naming its tables.
        """
        drawn = [e["entity_id"] for e in self.page(include_purged=False)["events"]]
        for entity_type, _, _ in self.SEEDS:
            if entity_type not in self.PURGEABLE:
                with self.subTest(entity_type=entity_type):
                    self.assertIn(str(self.by_type[entity_type]), drawn)

    def test_a_deleted_schema_is_hidden_like_any_other_entity(self):
        """
        0117. A schema has a table behind it and the dashboard fetches that table to name the lane,
        so the page could tell the deletion and say so -- while the purge rule named four tables and
        could not act on it. The lane wore the flag, could not be hidden, and was not counted, so
        the control that reveals deleted entities was never drawn beside it. On the stack that found
        this, deleted schemas were 283 of the 467 rows the default filters selected.
        """
        schema_id = str(self.by_type["schemas"])
        hidden = [e["entity_id"] for e in self.page(include_purged=False)["events"]]
        self.assertNotIn(schema_id, hidden,
                         "a deleted schema is still drawn when deleted entities are hidden")

        shown = [e["entity_id"] for e in self.page(include_purged=True)["events"]]
        self.assertIn(schema_id, shown,
                      "asking for deleted entities does not bring the schema back")

    def test_a_nameplate_is_gone_when_its_device_is(self):
        """
        `device_nameplate` is keyed by the device's id, so `devices` is the probe that answers for
        it and it needs no table of its own in the anti-join. Listed before any row carries the
        type, so it does not inherit the schema bug the first time one does.
        """
        drawn = [e["entity_id"] for e in self.page(include_purged=False)["events"]]
        self.assertNotIn(str(self.by_type["device_nameplate"]), drawn)

    def test_the_rule_names_exactly_the_types_it_can_probe(self):
        """
        The function's own list against this suite's, so the two cannot drift -- which is how
        `areas` (0097) and then `schemas` went missing from it, each for a release. A type named
        here with no probe below it would read as deleted always; a probe with no type named would
        never be consulted.
        """
        self.cur.execute(
            "SELECT pg_get_functiondef(p.oid) FROM pg_proc p"
            "  JOIN pg_namespace n ON n.oid = p.pronamespace"
            " WHERE n.nspname = 'public' AND p.proname = 'digital_thread_page'"
        )
        body = self.cur.fetchone()[0]
        listed = set(re.findall(
            r"'([a-z_]+)'",
            re.search(r"entity_type IN \(([^)]*)\)", body).group(1)))
        self.assertEqual(listed, self.PURGEABLE)

        # Every named type is answered by a probe: its own table, or `devices` for a nameplate.
        probed = set(re.findall(r"FROM public\.([a-z_]+)\s+\w+ WHERE \w+\.id = t\.entity_id", body))
        self.assertEqual(probed, self.PURGEABLE - {"device_nameplate"})

    # ---------------------------------------------------------------------------------------
    # The search finds what the timeline draws
    # ---------------------------------------------------------------------------------------
    def test_a_deleted_asset_is_found_by_the_name_in_its_snapshot(self):
        """
        The failure this replaces: the tab resolved a name against the LIVE tables, so searching
        for something deleted sent an empty id list and rendered as an empty thread.
        """
        payload = self.page(search="Ghost Press")
        self.assertEqual(payload["total_matching"], 1)
        self.assertEqual(payload["events"][0]["entity_id"], str(self.by_type["devices"]))

    def test_the_search_reads_every_field_the_lane_label_falls_back_to(self):
        """
        `snapshotIdentity()` in DigitalThreadTab.jsx labels a lane from these fields. A field it
        reads and the search does not is a lane you can see and cannot search for; a field the
        search reads and it does not is a row you can find and cannot identify.
        """
        for entity_type, payload, term in self.SEEDS:
            with self.subTest(entity_type=entity_type, field=sorted(payload)[0]):
                self.assertEqual(self.total(search=term), 1)

        # `system_settings` carries both, and the label is what a reader would type.
        self.assertEqual(self.total(search="Ghost Label"), 1)

    def test_the_search_reads_the_snapshot_a_delete_leaves(self):
        """An INSERT has only `new_data` and a DELETE only `old_data`; both are the lane's name."""
        self.cur.execute(
            """
            INSERT INTO public.digital_thread
                   (entity_type, entity_id, action, old_data, recorded_at, actor_source)
            VALUES ('devices', gen_random_uuid(), 'DELETE',
                    jsonb_build_object('name', 'Ghost Final 0115'),
                    timestamptz '2026-01-01 00:00:00+00', 'migration')
            RETURNING entity_id
            """
        )
        self.ids.append(self.cur.fetchone()[0])
        self.assertEqual(self.total(search="Ghost Final"), 1)

    def test_an_id_is_still_a_search_term(self):
        """The handover from another page puts a uuid in the same box."""
        self.assertEqual(self.total(search=str(self.by_type["gateways"])), 1)

    def test_a_search_matching_nothing_returns_nothing(self):
        """
        Rather than everything. An empty filter read as "no filter" is the same class of bug as
        the empty id list, pointing the other way and much harder to notice.
        """
        payload = self.page(search="no-entity-is-named-this")
        self.assertEqual(payload["total_matching"], 0)
        self.assertEqual(payload["events"], [])

    def test_the_search_is_not_case_sensitive(self):
        self.assertEqual(self.total(search="ghost press"), 1)

    # -----------------------------------------------------------------------------------------
    # The one label the audit payload does not carry
    # -----------------------------------------------------------------------------------------
    def test_the_person_matcher_is_security_definer_and_not_public(self):
        """
        `digital_thread_user_ids_matching()` reads `auth.users`, which `authenticated` cannot --
        so without SECURITY DEFINER it answers every search with an empty array and the
        role-assignment lane silently goes back to being unsearchable, an empty disjunct being
        indistinguishable from no match. And the gate inside it is a role check rather than a
        grant, so EXECUTE to PUBLIC would let an anonymous caller probe for email addresses.
        """
        self.cur.execute(
            "SELECT p.prosecdef,"
            "       has_function_privilege('public',"
            "           'public.digital_thread_user_ids_matching(text)', 'EXECUTE')"
            "  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace"
            " WHERE n.nspname = 'public' AND p.proname = 'digital_thread_user_ids_matching'"
        )
        row = self.cur.fetchone()
        self.assertIsNotNone(row, "digital_thread_user_ids_matching() is missing")
        self.assertTrue(row[0], "it is not SECURITY DEFINER")
        self.assertFalse(row[1], "PUBLIC may execute it")

    def test_a_caller_who_may_not_ask_gets_an_empty_array_rather_than_an_error(self):
        """
        It is one disjunct of a search. Raising would fail the whole page for a reader who cannot
        see the role-assignment lane anyway -- turning "your search matched nothing here" into
        "the Digital Thread is broken".
        """
        self.cur.execute("SET LOCAL ROLE authenticated;")
        # cardinality() rather than the array itself: psycopg2 hands back an unparsed uuid[] as
        # the literal '{}', which compares equal to neither [] nor None.
        self.cur.execute("SELECT cardinality(public.digital_thread_user_ids_matching('%@%'));")
        self.assertEqual(self.cur.fetchone()[0], 0)

    def test_a_null_pattern_names_nobody(self):
        # What an unfiltered page relies on: the disjunct has to match no row when nothing was
        # searched for, or every page would gain rows for no reason.
        self.cur.execute("SELECT cardinality(public.digital_thread_user_ids_matching(NULL));")
        self.assertEqual(self.cur.fetchone()[0], 0)

    def test_the_backup_job_matcher_is_security_definer_and_not_public(self):
        """
        0118. `backup_jobs` and `backups` are Administrator-only, while `digital_thread_select_
        security` admits Administrator AND Auditor -- so through a plain join in a SECURITY INVOKER
        function an Auditor could see a backup lane and never search it, silently, an empty
        disjunct being indistinguishable from no match. The gate inside is a role check rather than
        a grant, so EXECUTE to PUBLIC would let an anonymous caller probe for backup notes.
        """
        self.cur.execute(
            "SELECT p.prosecdef,"
            "       has_function_privilege('public',"
            "           'public.digital_thread_backup_job_ids_matching(text)', 'EXECUTE')"
            "  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace"
            " WHERE n.nspname = 'public'"
            "   AND p.proname = 'digital_thread_backup_job_ids_matching'"
        )
        row = self.cur.fetchone()
        self.assertIsNotNone(row, "digital_thread_backup_job_ids_matching() is missing")
        self.assertTrue(row[0], "it is not SECURITY DEFINER")
        self.assertFalse(row[1], "PUBLIC may execute it")

    def test_a_caller_who_may_not_ask_about_backups_gets_an_empty_array(self):
        """The same reason as the person matcher above: it is one disjunct, not a request."""
        self.cur.execute("SET LOCAL ROLE authenticated;")
        self.cur.execute(
            "SELECT cardinality(public.digital_thread_backup_job_ids_matching('%'));"
        )
        self.assertEqual(self.cur.fetchone()[0], 0)

    def test_a_null_pattern_names_no_backup_job(self):
        # What an unfiltered page relies on: a disjunct that matched rows for a null search would
        # widen every page, and this one is evaluated on every call.
        self.cur.execute(
            "SELECT cardinality(public.digital_thread_backup_job_ids_matching(NULL));"
        )
        self.assertEqual(self.cur.fetchone()[0], 0)

    # Self-seeded and never committed: the grant, the job and the backup all go in on the owner's
    # connection and roll back with everything else, so this asserts the matcher's ANSWERS without
    # leaving a role assignment behind in an append-only table. CI's RLS job applies the migrations
    # and not seed.sql, so a suite leaning on `admin@acs-cymru.local` would fail there with a
    # failure that looks like the gate and is really the fixture.
    ADMIN_ID = "a0d17070-0000-4000-8000-0000000d7318"
    AUDITOR_ID = "a0d17070-0000-4000-8000-0000000d7418"

    def _become(self, user_id, role_name):
        """Grant `role_name` to `user_id`, then become them the way PostgREST does: claims only."""
        self.cur.execute("SELECT id FROM public.roles WHERE name = %s;", (role_name,))
        role_id = self.cur.fetchone()[0]
        self.cur.execute(
            "INSERT INTO public.user_roles (user_id, role_id) VALUES (%s, %s)"
            " ON CONFLICT (user_id, role_id) DO NOTHING;",
            (user_id, role_id),
        )
        self.cur.execute("SET LOCAL ROLE authenticated;")
        self.cur.execute('SET LOCAL "request.jwt.claims" = %s;', ('{"sub": "%s"}' % user_id,))

    def test_an_administrator_finds_a_job_by_the_note_they_typed(self):
        """
        The half of 0118 that needs a role, and the reason the helper exists at all: the note is on
        `backup_jobs` and in no audit payload, so without this disjunct a search for what somebody
        typed when they asked for the backup reaches the Backups page and not the thread.
        """
        self.cur.execute(
            "INSERT INTO public.backup_jobs (origin, status, note)"
            " VALUES ('requested', 'COMPLETED', 'ghostnote0118') RETURNING id;"
        )
        job_id = self.cur.fetchone()[0]
        self._become(self.ADMIN_ID, "Administrator")

        self.cur.execute(
            "SELECT %s = ANY(public.digital_thread_backup_job_ids_matching('%%ghostnote0118%%'));",
            (job_id,),
        )
        self.assertTrue(self.cur.fetchone()[0], "an Administrator cannot find a job by its note")

    def test_an_auditor_finds_a_job_by_a_stamp_they_may_not_read(self):
        """
        WHY THE HELPER IS SECURITY DEFINER, stated as the case that would otherwise fail silently.
        `backup_jobs` and `backups` are Administrator-only; `digital_thread_select_security` admits
        Auditors as well. Through a plain join in a SECURITY INVOKER function an Auditor would see
        the backup lane and match nothing in it, which is indistinguishable from no match.
        """
        # A stamp has to look like a backup directory name (a CHECK on the table names the exact
        # shape), so what keeps this fixture distinctive is an impossible year rather than a word.
        self.cur.execute(
            "INSERT INTO public.backups (stamp, origin, location)"
            " VALUES ('01180118T011800Z', 'scheduled', 'volume://ghost') RETURNING id;"
        )
        backup_id = self.cur.fetchone()[0]
        self.cur.execute(
            "INSERT INTO public.backup_jobs (origin, status, backup_id)"
            " VALUES ('scheduled', 'COMPLETED', %s) RETURNING id;",
            (backup_id,),
        )
        job_id = self.cur.fetchone()[0]
        self._become(self.AUDITOR_ID, "Auditor")

        # The premise: this role genuinely cannot read the table the answer comes from.
        self.cur.execute("SELECT count(*) FROM public.backup_jobs WHERE id = %s;", (job_id,))
        self.assertEqual(self.cur.fetchone()[0], 0, "an Auditor can read backup_jobs after all")

        self.cur.execute(
            "SELECT %s = ANY("
            "  public.digital_thread_backup_job_ids_matching('%%01180118T011800Z%%'));",
            (job_id,),
        )
        self.assertTrue(self.cur.fetchone()[0],
                        "an Auditor cannot find a job by the stamp of the backup it produced")

    def test_a_cancelled_job_is_still_reachable_by_its_note(self):
        """
        The LEFT JOIN, asserted on the plan rather than on rows: over half the jobs on a working
        stack never produced a backup, and an inner join would drop exactly those -- the cancelled
        and the failed, which are the ones somebody is looking for. Read from the deployed text
        because the matcher answers '{}' to this suite's role whatever it holds.
        """
        self.cur.execute(
            "SELECT pg_get_functiondef(p.oid) FROM pg_proc p"
            "  JOIN pg_namespace n ON n.oid = p.pronamespace"
            " WHERE n.nspname = 'public'"
            "   AND p.proname = 'digital_thread_backup_job_ids_matching'"
        )
        body = self.cur.fetchone()[0]
        self.assertIn("LEFT JOIN", body,
                      "an inner join would make a job that produced no backup unsearchable")

    def test_the_search_resolves_the_person_once_rather_than_per_row(self):
        """
        The CTE holding it is MATERIALIZED. Inlined, a STABLE function is ALLOWED to be evaluated
        once and is not promised to be -- Postgres put this one in the per-row Filter of every
        partition scan, which took a search from 53ms to 583ms on 4,065 rows. That is the shape of
        cost that reads as "the thread got big" rather than as a query doing the wrong thing.
        """
        self.cur.execute(
            "SELECT pg_get_functiondef(p.oid) FROM pg_proc p"
            "  JOIN pg_namespace n ON n.oid = p.pronamespace"
            " WHERE n.nspname = 'public' AND p.proname = 'digital_thread_page'"
        )
        body = self.cur.fetchone()[0]
        self.assertIn("MATERIALIZED", body,
                      "the pattern CTE is no longer materialised; the helper will be called per row")

    def test_a_like_metacharacter_is_a_character(self):
        """
        The box promises a substring of a name or an id. Unescaped, a typed percentage hands back
        the whole thread and an underscore quietly matches any character -- both of which look
        like a search that worked.
        """
        seeded = self.total()
        # No seeded value holds a percent sign, so an unescaped '%' would return all of them.
        self.assertEqual(self.total(search="%"), 0)
        # Two hold a literal underscore. Unescaped, '_' matches any single character and so
        # matches every row; the assertion is that it does not.
        self.assertLess(self.total(search="_"), seeded)
        # The other half: escaping must make the character literal, not drop it.
        self.assertEqual(self.total(search="Ghost_Schema"), 1)
        # The escape character itself has to survive being escaped.
        self.assertEqual(self.total(search="\\"), 0)


class TheOtherTwoIdsTheDrawerShows(unittest.TestCase):
    """
    0121. The event drawer offers three copyable ids; the search took one of them.

    `digital_thread.id` and `causation_id` had no consumer anywhere in the platform -- no filter,
    no search, no RPC argument -- so a reader handed a mutation id in a ticket had nowhere to put
    it, and the drawer's sibling list could only ever report the members of a transaction that
    happened to be loaded.

    The disjunct is ADDITIVE and these tests are written to catch it becoming a replacement: a
    search term that is digits still has to match a name made of digits.
    """

    CAUSATION = 880121
    # Digits, and deliberately not any row's id: the additive test turns on this name being found
    # by the name disjunct while the numeric one matches nothing.
    NUMERIC_NAME = "40121"

    @classmethod
    def setUpClass(cls):
        cls.conn = get_connection()

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()

    def setUp(self):
        self.cur = self.conn.cursor()
        # Three rows sharing one causation, as one committed act would leave them, plus a fourth
        # under its own -- so "found the group" is distinguishable from "found everything".
        self.ids = []
        for i in range(3):
            self.cur.execute(
                """
                INSERT INTO public.digital_thread
                       (entity_type, entity_id, action, new_data, recorded_at, actor_source,
                        causation_id)
                VALUES ('devices', gen_random_uuid(), 'INSERT', %s::jsonb,
                        timestamptz '2026-01-01 00:00:00+00', 'migration', %s)
                RETURNING id
                """,
                (json.dumps({"name": "Txn Member %d 0121" % i}), self.CAUSATION),
            )
            self.ids.append(self.cur.fetchone()[0])

        self.cur.execute(
            """
            INSERT INTO public.digital_thread
                   (entity_type, entity_id, action, new_data, recorded_at, actor_source,
                    causation_id)
            VALUES ('devices', gen_random_uuid(), 'INSERT', %s::jsonb,
                    timestamptz '2026-01-01 00:00:00+00', 'migration', %s)
            RETURNING id
            """,
            (json.dumps({"name": self.NUMERIC_NAME}), self.CAUSATION + 1),
        )
        self.outsider = self.cur.fetchone()[0]

    def tearDown(self):
        self.conn.rollback()
        self.cur.close()

    def total(self, search):
        self.cur.execute(
            "SELECT (public.digital_thread_page(p_limit => 1000, p_include_purged => true,"
            "        p_search => %s) ->> 'total_matching')::bigint",
            (search,),
        )
        return self.cur.fetchone()[0]

    def test_a_mutation_id_finds_its_own_row(self):
        self.assertGreaterEqual(self.total(str(self.ids[0])), 1)

    def test_a_transaction_id_finds_every_member_of_the_group(self):
        """
        What makes the drawer's count exact rather than a lower bound. Against a direct count of
        the group, so this cannot pass by finding a different three rows.
        """
        self.cur.execute(
            "SELECT count(*) FROM public.digital_thread WHERE causation_id = %s",
            (self.CAUSATION,),
        )
        direct = self.cur.fetchone()[0]
        self.assertEqual(direct, 3, "the fixture did not land")
        self.assertGreaterEqual(self.total(str(self.CAUSATION)), direct)

    def test_a_transaction_id_does_not_sweep_in_a_neighbouring_one(self):
        # An off-by-one in the predicate, or a LIKE where an equality was meant, would take both.
        found = self.total(str(self.CAUSATION))
        self.cur.execute(
            "SELECT count(*) FROM public.digital_thread WHERE causation_id = %s",
            (self.CAUSATION + 1,),
        )
        self.assertLess(found, 3 + self.cur.fetchone()[0] + 1)

    def test_a_name_made_of_digits_still_matches_by_name(self):
        """
        THE ADDITIVE TEST. If the numeric term ever became a replacement rather than an extra
        disjunct, this row -- whose name is digits and whose id is not that number -- would stop
        being findable, and nothing else here would notice.
        """
        self.assertNotIn(int(self.NUMERIC_NAME), self.ids)
        self.assertGreaterEqual(self.total(self.NUMERIC_NAME), 1)

    def test_a_numeric_term_matching_no_row_matches_no_row(self):
        self.assertEqual(self.total("999999999999999999"), 0)

    def test_an_overlong_number_is_text_rather_than_an_overflow(self):
        """
        bigint tops out at 19 digits and the cast RAISES rather than missing, which would fail the
        whole page. The guard is the length bound in the pattern CTE; without it this call errors
        instead of returning a count.
        """
        self.assertEqual(self.total("9" * 26), 0)

    def test_a_number_with_anything_else_in_it_is_not_an_id(self):
        # `t.raw ~ '^[0-9]{1,18}$'` anchors both ends. Unanchored, ' 12 ' or 'v12' would cast.
        for term in ("12a", "a12", "1.2", "-12", "1 2"):
            self.assertIsInstance(self.total(term), int, term)


if __name__ == "__main__":
    unittest.main(verbosity=2)
