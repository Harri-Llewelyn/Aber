-- 0079: the Digital Thread gets a shape that can be pruned.
--
-- =================================================================================================
-- THE PROBLEM IS THE SIGNAL, NOT THE NOISE
--
-- `public.digital_thread` is written by `log_digital_thread_event()` on every INSERT/UPDATE/DELETE
-- to `cells`, `gateways` and `devices`, and an UPDATE row carries two complete row snapshots as
-- JSONB. It has no archival path and cannot be pruned cheaply, so on a platform whose stated value
-- is a permanent audit trail, "append-only and unbounded" is a disk-exhaustion path whose only
-- answer is dropping the table.
--
-- THE WRITE RATE IS ALREADY AS LOW AS SUPPRESSION CAN MAKE IT. 0005 suppresses both classes of
-- machine non-event -- an UPDATE that changes nothing, and one that moves only
-- `gateways.last_heartbeat` -- and ingestion.py no longer issues the unchanged device write at all.
-- Measured on the shipped stack: fourteen minutes of steady state with heartbeats and rebirths
-- flowing added ZERO rows.
--
-- That is the point worth being precise about. Suppression bounds the RATE OF NOISE and does
-- nothing about the TOTAL. Every row that survives it is a real change, every real change is kept
-- forever, and the table can only grow. This migration is about the growth of the signal.
--
-- =================================================================================================
-- WHAT THIS DOES NOT DO
--
-- It does not relax the append-only trigger and it grants no application role DELETE. 0003 already
-- settles who may clear audit rows, and says so in its own words: a trigger cannot constrain a role
-- that can issue DDL, so `postgres` and `supabase_admin` are exempt and everyone else is refused.
-- Row-level pruning as an owner is therefore ALREADY SANCTIONED BY DESIGN -- what has been missing
-- is partitioning to make it cheap and a workflow to make it safe. A DELETE over a large
-- unpartitioned audit table is the worst available option: fully logged, heap-bloating, and needing
-- a VACUUM afterwards. DETACH PARTITION is instant, unlogged, and leaves the data queryable.
--
-- Two premises this was filed on have since changed, and are recorded here so the next reader does
-- not go looking for them. `digital_thread` is REPLICA IDENTITY DEFAULT, not FULL -- 0001 returned
-- it to the default when the table was unpublished -- so the "every row is carried in the WAL at
-- full width" argument no longer applies. It is also not a member of `supabase_realtime`.
--
-- =================================================================================================
-- WHY THERE IS A DEFAULT PARTITION, WHICH THE ISSUE DID NOT ASK FOR
--
-- This is the one design decision here that departs from the filed plan, and it is the most
-- important line in the file.
--
-- A range-partitioned table REFUSES a row that no partition accepts. `log_digital_thread_event()`
-- is a trigger on `cells`, `gateways` and `devices`, so an audit INSERT that raises does not fail
-- quietly in a corner -- IT FAILS THE ASSET WRITE THAT CAUSED IT. A missing partition would
-- therefore mean nobody can create a device, archive a cell or approve a quarantine, and the error
-- would name the audit table rather than anything the operator did.
--
-- "Create partitions ahead of need and alert if the next one is missing" makes that outage less
-- likely without making it less severe: the alert fires at the same moment the platform stops
-- accepting writes, and only if somebody is reading it. A DEFAULT partition converts the whole
-- failure class from an outage into a slow, observable degradation -- rows still land, they just
-- land somewhere untidy, and `digital_thread_partition_health` reports it. The scheduled job is
-- still what keeps the default empty; it is no longer what stands between the plant and a stopped
-- line.
--
-- The cost of a default partition is real and is bounded here: attaching a new partition must scan
-- the default to prove no row belongs in the new range. That scan is over a table the maintenance
-- job works to keep EMPTY, so it is a scan of nothing in every state except the one that has
-- already gone wrong.
--
-- =================================================================================================
-- WHY THE CONVERSION IS ONE DO BLOCK
--
-- PostgreSQL cannot convert a populated table to partitioned in place. The sequence is: build the
-- partitioned table beside it, copy, swap names, then rebuild every dependent object. Half of that
-- applied is a database with an audit table that has lost its append-only trigger or its RLS
-- policies -- so it is one statement, which is one transaction, which either happens or does not.
--
-- IT MUST ALSO SURVIVE REPLAY. supabase-db-init runs `for f in /migrations/*.sql` on every boot
-- with ON_ERROR_STOP=1 and there is no applied-migrations ledger, so this file runs again on every
-- start for the life of the deployment. `pg_partitioned_table` is the ledger it does not have: once
-- the table is partitioned the whole block is skipped, and the second boot is a no-op rather than a
-- failure that takes the stack down.


-- -------------------------------------------------------------------------------------------------
-- 1. Partition maintenance, defined before the conversion that uses it
-- -------------------------------------------------------------------------------------------------
--
-- Created first because the conversion calls it to build the partitions covering the rows it is
-- about to copy. Written as a function rather than inline so the same code creates the historical
-- partitions, next month's, and whatever the scheduled job needs -- three callers that must agree
-- on the naming and the bounds, or a row lands in a month it did not happen in.

-- A PARTITION DOES NOT INHERIT THE PARENT'S ACL, AND THE DEFAULT IT GETS INSTEAD IS WRONG.
--
-- 0001 settles the audit table's privileges as "read, and nothing that writes", and states the
-- REVOKE explicitly because the image's default privileges hand `service_role` more than any GRANT
-- here names. Those same default privileges apply to EVERY TABLE CREATED AFTERWARDS -- which now
-- includes a new partition every month, created by a cron job, long after anybody is looking.
--
-- Measured on the first conversion, before this existed:
--
--     digital_thread          service_role=rxtm/postgres        <- correct
--     digital_thread_2026_09  service_role=arwdDxtm/postgres    <- everything, including TRUNCATE
--
-- The append-only trigger covers the DELETE, because a row trigger declared on the parent fires for
-- every partition. IT DOES NOT COVER TRUNCATE, which is not a row operation and raises no trigger
-- at all -- so `TRUNCATE public.digital_thread_2026_09` would have erased a month of audit history
-- as a role the platform hands out, leaving the parent's REVOKE looking like it was doing something.
--
-- Nothing needs these tables by name. Every reader goes through the parent, where the ACL and the
-- RLS policies are, so the correct privilege set on a partition is none at all.
CREATE OR REPLACE FUNCTION public.secure_digital_thread_partition(p_partition regclass)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
BEGIN
  EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC', p_partition::text);
  EXECUTE format('REVOKE ALL ON TABLE %s FROM anon, authenticated, service_role', p_partition::text);
END $fn$;

REVOKE ALL ON FUNCTION public.secure_digital_thread_partition(regclass) FROM PUBLIC;

COMMENT ON FUNCTION public.secure_digital_thread_partition(regclass) IS
  'Strip every application-role privilege from one digital_thread partition. Partitions do not inherit the parent ACL and the image default grants service_role ALL -- including TRUNCATE, which no row trigger can refuse. Readers use the parent; a partition needs no grants.';


CREATE OR REPLACE FUNCTION public.ensure_digital_thread_partition(p_month timestamp with time zone)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  -- BOUNDS ARE COMPUTED IN UTC, NOT IN THE SESSION'S ZONE. date_trunc('month', ...) on a timestamptz
  -- truncates in TimeZone, so a session in Europe/London would put the boundary an hour out for half
  -- the year -- and which partition a row lands in would depend on who happened to be connected when
  -- the partition was made. The round trip through AT TIME ZONE 'UTC' pins it.
  v_from timestamp with time zone := (date_trunc('month', p_month AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC';
  v_to   timestamp with time zone;
  v_name text;
BEGIN
  v_to   := v_from + interval '1 month';
  v_name := 'digital_thread_' || to_char(v_from AT TIME ZONE 'UTC', 'YYYY_MM');

  IF to_regclass('public.' || quote_ident(v_name)) IS NOT NULL THEN
    RETURN false;
  END IF;

  EXECUTE format(
    'CREATE TABLE public.%I PARTITION OF public.digital_thread FOR VALUES FROM (%L) TO (%L)',
    v_name, v_from, v_to
  );
  -- Before it can hold a row. The window is inside this transaction either way, but the ordering
  -- is what makes "a partition is never reachable directly" true by construction rather than by
  -- the maintenance job finishing.
  PERFORM public.secure_digital_thread_partition(format('public.%I', v_name)::regclass);
  RETURN true;
END $fn$;

REVOKE ALL ON FUNCTION public.ensure_digital_thread_partition(timestamp with time zone) FROM PUBLIC;

COMMENT ON FUNCTION public.ensure_digital_thread_partition(timestamp with time zone) IS
  'Create the monthly digital_thread partition containing the given instant, if absent. Returns true if one was created. Bounds are computed in UTC so which partition a row lands in does not depend on the session TimeZone.';


CREATE OR REPLACE FUNCTION public.ensure_digital_thread_partitions(p_months_ahead integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  v_created integer := 0;
  v_i integer;
BEGIN
  IF p_months_ahead IS NULL OR p_months_ahead < 0 THEN
    RAISE EXCEPTION 'ensure_digital_thread_partitions: months ahead must not be negative (got %)', p_months_ahead;
  END IF;

  -- THE CURRENT MONTH IS INCLUDED RATHER THAN ASSUMED. A stack restored from a dump taken months ago
  -- comes up with every partition ending in the past, and the first asset write would meet the
  -- default partition instead of a fresh one.
  FOR v_i IN 0..p_months_ahead LOOP
    IF public.ensure_digital_thread_partition(now() + (v_i || ' months')::interval) THEN
      v_created := v_created + 1;
    END IF;
  END LOOP;

  RETURN v_created;
END $fn$;

REVOKE ALL ON FUNCTION public.ensure_digital_thread_partitions(integer) FROM PUBLIC;

COMMENT ON FUNCTION public.ensure_digital_thread_partitions(integer) IS
  'Create this month''s digital_thread partition and the next p_months_ahead of them. Idempotent; returns how many were actually created. Called by the digital_thread_partitions cron job and by 0079 itself.';


-- -------------------------------------------------------------------------------------------------
-- 2. The conversion
-- -------------------------------------------------------------------------------------------------

DO $mig$
DECLARE
  v_min   timestamp with time zone;
  v_max   timestamp with time zone;
  v_month timestamp with time zone;
  v_rows_before bigint;
  v_rows_after  bigint;
  v_comments    jsonb;
  v_key         text;
  v_val         text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_partitioned_table WHERE partrelid = 'public.digital_thread'::regclass
  ) THEN
    RAISE NOTICE '0079: digital_thread is already partitioned; nothing to convert.';
    RETURN;
  END IF;

  SELECT count(*) INTO v_rows_before FROM public.digital_thread;
  RAISE NOTICE '0079: converting digital_thread to monthly partitions (% existing row(s))', v_rows_before;

  -- COMMENTS ARE CARRIED ACROSS, NOT RESTATED, and CI found out why it matters. A COMMENT lives on
  -- the object, so dropping the old table drops every comment with it -- including the one 0077
  -- puts on `idx_digital_thread_recorded_id`. Rebuilding the index without it leaves boot 1 with no
  -- comment, while boot 2 has one: 0077's `CREATE INDEX IF NOT EXISTS` skips, and its unconditional
  -- `COMMENT ON INDEX` lands. The schema then differs between two runs of the same chain, which is
  -- drift by definition and is exactly what check-migration-idempotency.mjs refuses.
  --
  -- COPIED RATHER THAN RETYPED, deliberately. Writing the text out here would put a second copy of
  -- every comment in a file that runs AFTER the one that owns them -- so editing 0001 or 0077 would
  -- be silently undone by a stale duplicate on the next boot. Reading them from the catalogue means
  -- a comment added to this table in a year is preserved by code written today.
  SELECT coalesce(jsonb_object_agg(key, description), '{}'::jsonb) INTO v_comments
    FROM (
      -- Indexes, keyed by name: they are rebuilt below under exactly these names.
      SELECT 'index:' || c.relname AS key, d.description
        FROM pg_index x
        JOIN pg_class c ON c.oid = x.indexrelid
        JOIN pg_description d ON d.objoid = c.oid AND d.classoid = 'pg_class'::regclass
       WHERE x.indrelid = 'public.digital_thread'::regclass
      UNION ALL
      -- Columns, keyed by name: the new table has the same ones, in the same order.
      SELECT 'column:' || a.attname, d.description
        FROM pg_attribute a
        JOIN pg_description d ON d.objoid = a.attrelid AND d.classoid = 'pg_class'::regclass
                             AND d.objsubid = a.attnum
       WHERE a.attrelid = 'public.digital_thread'::regclass AND a.attnum > 0
    ) AS carried;

  -- 2a. The partition key must be NOT NULL -----------------------------------------------------
  --
  -- `recorded_at` is `timestamp with time zone DEFAULT now()` with no constraint, so it is nullable
  -- and a row could in principle carry NULL. A NULL partition key matches no range and would land in
  -- the default partition forever. Backfilled to now() rather than dropped: an audit row with an
  -- unknown timestamp is still evidence that something happened, and discarding it to tidy the
  -- schema would be the one edit this table exists to prevent.
  UPDATE public.digital_thread SET recorded_at = now() WHERE recorded_at IS NULL;

  -- 2b. Build the partitioned table beside the original -----------------------------------------
  --
  -- INCLUDING DEFAULTS carries the nextval() default on `id`; INCLUDING CONSTRAINTS carries the two
  -- CHECKs on actor_source and audit_domain. Indexes, the primary key, triggers, policies and grants
  -- are NOT carried by LIKE and are rebuilt explicitly below -- listed one at a time rather than
  -- with INCLUDING ALL so that anything added to the table later fails a test instead of being
  -- silently half-copied here.
  CREATE TABLE public.digital_thread_partitioned (
    LIKE public.digital_thread INCLUDING DEFAULTS INCLUDING CONSTRAINTS
  ) PARTITION BY RANGE (recorded_at);

  ALTER TABLE public.digital_thread_partitioned ALTER COLUMN recorded_at SET NOT NULL;

  -- 2c. The default partition, and then one per month --------------------------------------------
  --
  -- The default is created FIRST and on purpose: between this statement and the loop below there is
  -- no window in which a row could be refused, and the order costs nothing.
  CREATE TABLE public.digital_thread_default PARTITION OF public.digital_thread_partitioned DEFAULT;

  -- The historical range comes from the rows themselves. An empty table still gets this month and
  -- the next three from the call after the swap.
  SELECT min(recorded_at), max(recorded_at) INTO v_min, v_max FROM public.digital_thread;

  IF v_min IS NOT NULL THEN
    v_month := (date_trunc('month', v_min AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC';
    WHILE v_month <= v_max LOOP
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.digital_thread_partitioned '
        || 'FOR VALUES FROM (%L) TO (%L)',
        'digital_thread_' || to_char(v_month AT TIME ZONE 'UTC', 'YYYY_MM'),
        v_month, v_month + interval '1 month'
      );
      v_month := v_month + interval '1 month';
    END LOOP;
  END IF;

  -- 2d. Copy ------------------------------------------------------------------------------------
  --
  -- No trigger exists on the new table yet, which is what makes this a copy rather than a re-audit:
  -- stamp_audit_domain() would recompute `audit_domain` from the classifier as it stands TODAY, and
  -- silently restate what an old row is allowed to say. The stored value is the record.
  INSERT INTO public.digital_thread_partitioned
    SELECT * FROM public.digital_thread;

  SELECT count(*) INTO v_rows_after FROM public.digital_thread_partitioned;
  IF v_rows_after <> v_rows_before THEN
    RAISE EXCEPTION '0079: copied % row(s) of % -- refusing to swap', v_rows_after, v_rows_before;
  END IF;

  -- 2e. Detach the sequence before the old table takes it down with it ---------------------------
  --
  -- 0001 declares `ALTER SEQUENCE digital_thread_id_seq OWNED BY digital_thread.id`, so DROP TABLE
  -- on the original would drop the sequence -- and with it the numbering that every existing
  -- causation_id and every foreign reader has been reading. Released here and re-owned by the new
  -- column below, which also preserves its current value: the sequence object is never recreated.
  ALTER SEQUENCE public.digital_thread_id_seq OWNED BY NONE;

  -- 2f. Swap ------------------------------------------------------------------------------------
  ALTER TABLE public.digital_thread RENAME TO digital_thread_preconversion;
  ALTER TABLE public.digital_thread_partitioned RENAME TO digital_thread;
  DROP TABLE public.digital_thread_preconversion;

  ALTER SEQUENCE public.digital_thread_id_seq OWNED BY public.digital_thread.id;

  -- 2g. Rebuild everything LIKE did not carry ----------------------------------------------------
  --
  -- NAMES ARE REUSED EXACTLY, and that is what keeps 0001 replayable. Its PK and FK blocks are
  -- guarded on `conname` against `public.digital_thread`, and its indexes are CREATE INDEX IF NOT
  -- EXISTS, so on every later boot 0001 finds each object already present and skips it. A rename
  -- here would make 0001 try to add a second primary key to a table that has one.
  --
  -- The primary key gains `recorded_at` because a partitioned table's unique constraints must
  -- contain the partition key. Nothing selects `digital_thread` by a single-column foreign key --
  -- there is no FK anywhere referencing this table -- and `WHERE id = n` is unaffected.
  ALTER TABLE public.digital_thread
    ADD CONSTRAINT digital_thread_pkey PRIMARY KEY (id, recorded_at);

  ALTER TABLE public.digital_thread
    ADD CONSTRAINT digital_thread_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES auth.users(id);

  CREATE INDEX IF NOT EXISTS idx_digital_thread_causation
    ON public.digital_thread USING btree (causation_id) WHERE (causation_id IS NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_digital_thread_domain
    ON public.digital_thread USING btree (audit_domain, recorded_at DESC);
  CREATE INDEX IF NOT EXISTS idx_digital_thread_recorded_id
    ON public.digital_thread USING btree (recorded_at DESC, id DESC);

  -- The comments captured above, put back on the objects that now carry those names.
  FOR v_key, v_val IN SELECT key, value FROM jsonb_each_text(v_comments) LOOP
    IF v_key LIKE 'index:%' THEN
      EXECUTE format('COMMENT ON INDEX public.%I IS %L', substr(v_key, 7), v_val);
    ELSE
      EXECUTE format('COMMENT ON COLUMN public.digital_thread.%I IS %L', substr(v_key, 8), v_val);
    END IF;
  END LOOP;

  -- The two triggers, in the same shape 0001 declares them. Row-level BEFORE triggers on a
  -- partitioned table are a PostgreSQL 13 feature and this image is 17; they are declared on the
  -- parent and fire for every partition, so a partition added next year inherits them rather than
  -- being an unaudited hole.
  CREATE TRIGGER trg_digital_thread_append_only
    BEFORE DELETE OR UPDATE ON public.digital_thread
    FOR EACH ROW EXECUTE FUNCTION public.enforce_digital_thread_append_only();

  CREATE TRIGGER trg_digital_thread_stamp_domain
    BEFORE INSERT ON public.digital_thread
    FOR EACH ROW EXECUTE FUNCTION public.stamp_audit_domain();

  -- RLS is NOT inherited from anything and is off by default on a new table. Forgetting this line
  -- would publish every security-domain audit row to every authenticated reader.
  ALTER TABLE public.digital_thread ENABLE ROW LEVEL SECURITY;

  CREATE POLICY digital_thread_select_asset ON public.digital_thread
    FOR SELECT TO authenticated
    USING (((audit_domain = 'asset'::text)
        AND public.has_role(ARRAY['Administrator'::text, 'Shopfloor_Manager'::text, 'Auditor'::text])));

  CREATE POLICY digital_thread_select_security ON public.digital_thread
    FOR SELECT TO authenticated
    USING (((audit_domain = 'security'::text)
        AND public.has_role(ARRAY['Administrator'::text, 'Auditor'::text])));

  -- The ACL 0001 settles on: read for the two application roles, and nothing that writes. The
  -- REVOKE is not redundant with the GRANT above it -- the image's default privileges hand
  -- service_role more than the GRANT names, which is why 0001 states both.
  GRANT SELECT, REFERENCES, TRIGGER, MAINTAIN ON TABLE public.digital_thread TO service_role;
  GRANT SELECT ON TABLE public.digital_thread TO authenticated;
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.digital_thread FROM service_role;

  ALTER TABLE public.digital_thread REPLICA IDENTITY DEFAULT;

  -- Every partition built above, including the default one. Done after the swap so `pg_inherits`
  -- is asked about the table that is now `digital_thread` rather than about the scaffolding name.
  PERFORM public.secure_digital_thread_partition(i.inhrelid::regclass)
    FROM pg_inherits i WHERE i.inhparent = 'public.digital_thread'::regclass;

  RAISE NOTICE '0079: digital_thread partitioned; % row(s) preserved', v_rows_after;
END $mig$;


-- -------------------------------------------------------------------------------------------------
-- 3. The one comment this file owns
-- -------------------------------------------------------------------------------------------------
--
-- The column and index comments are CARRIED ACROSS the conversion inside the block above rather than
-- retyped here -- see the note there for why a second copy in this file would be actively harmful.
-- This one is different: it is the only comment 0079 originates, because it describes the shape 0079
-- gives the table and no earlier migration has anything to say about partitioning.

COMMENT ON TABLE public.digital_thread IS 'Append-only audit of every attributed change to cells, gateways and devices, plus the security lane 0070 added. Range-partitioned by month on recorded_at (0079) so retention is DETACH rather than DELETE. Rows are written only by log_digital_thread_event() and its named siblings; UPDATE and DELETE are refused for every role that is not an owner.';


-- -------------------------------------------------------------------------------------------------
-- 4. Keep the partitions ahead of the writes
-- -------------------------------------------------------------------------------------------------
--
-- Three months of headroom rather than one. The job runs daily, so one month would already be
-- enough for the schedule to keep up; three is what makes the system survive the job being BROKEN
-- -- a stack that boots with pg_cron misconfigured, or a background worker that has been failing
-- silently since a restart, has a quarter to be noticed in rather than a fortnight.
--
-- Also called here, at migration time, so a fresh database has its partitions before the first
-- write rather than at 03:20 tomorrow.

SELECT public.ensure_digital_thread_partitions(3);

SELECT public.ensure_cron_job(
  'digital_thread_partitions',
  '20 3 * * *',
  $job$SELECT public.ensure_digital_thread_partitions(3)$job$
);


-- -------------------------------------------------------------------------------------------------
-- 5. Whether any of the above is actually working
-- -------------------------------------------------------------------------------------------------
--
-- A cron job that stops running is silent -- 0025's own header says so -- and the default partition
-- means the consequence is silent too. That is the trade this design makes, and it is only a good
-- one if something reports the degradation. This view is that something, and it is what the Grafana
-- rule reads.
--
-- `default_rows > 0` is the signal that matters: it cannot happen while the job is working, and it
-- is the exact state in which retention by DETACH stops being complete, because a row for August
-- sitting in the default partition is not detached when August is.

CREATE OR REPLACE VIEW public.digital_thread_partition_health AS
SELECT
  (SELECT count(*)
     FROM pg_class c
     JOIN pg_inherits i ON i.inhrelid = c.oid
    WHERE i.inhparent = 'public.digital_thread'::regclass) AS partition_count,
  (SELECT count(*) FROM public.digital_thread_default) AS default_rows,
  -- Months of headroom: how far the newest bound reaches beyond the current month. Read off the
  -- catalogue rather than from the names, so a partition made by hand still counts.
  (SELECT max((regexp_replace(pg_get_expr(c.relpartbound, c.oid),
                              '^FOR VALUES FROM \(''([^'']+)''\) TO \(''([^'']+)''\).*$', '\2'))::timestamptz)
     FROM pg_class c
     JOIN pg_inherits i ON i.inhrelid = c.oid
    WHERE i.inhparent = 'public.digital_thread'::regclass
      AND pg_get_expr(c.relpartbound, c.oid) NOT LIKE 'DEFAULT%') AS covered_until;

COMMENT ON VIEW public.digital_thread_partition_health IS
  'Whether digital_thread partitioning is keeping up. default_rows > 0 means the maintenance job has stopped and retention by DETACH is no longer complete; covered_until is the instant beyond which new rows fall to the default partition. Read by the Grafana rule "Digital Thread Partitions Falling Behind".';

-- READABLE WITHOUT ANY PRIVILEGE ON THE TABLE IT COUNTS. A view runs with its OWNER's rights --
-- `security_invoker` is off by default -- so granting SELECT here does not hand the reader access
-- to `digital_thread` or to the default partition, which is what makes it safe to point Grafana at.
REVOKE ALL ON public.digital_thread_partition_health FROM PUBLIC;
GRANT SELECT ON public.digital_thread_partition_health TO service_role;

-- GUARDED, LIKE EVERY OTHER grafana_reader GRANT IN 0001. An empty BI_READER_PASSWORD skips the
-- role entirely (0027), so an unguarded GRANT would abort the migration -- and therefore the boot --
-- on every stack that never configured Grafana's reader.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
    EXECUTE 'GRANT SELECT ON public.digital_thread_partition_health TO grafana_reader';
  END IF;
END $grant$;
