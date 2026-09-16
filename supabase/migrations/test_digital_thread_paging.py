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
    ]

    # The four asset tables `is_purged` probes. Seeds of any other type name no table to be absent
    # from and are never purged, whatever the reader asks for.
    PURGEABLE = {"areas", "cells", "gateways", "devices"}

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
        be probed for, so answering "absent from all four asset tables" would mark the whole
        security lane deleted the moment the purge rule stopped naming its tables.
        """
        drawn = [e["entity_id"] for e in self.page(include_purged=False)["events"]]
        for entity_type, _, _ in self.SEEDS:
            if entity_type not in self.PURGEABLE:
                with self.subTest(entity_type=entity_type):
                    self.assertIn(str(self.by_type[entity_type]), drawn)

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
