"""
The Digital Thread's keyset cursor (0077).

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
"""

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
