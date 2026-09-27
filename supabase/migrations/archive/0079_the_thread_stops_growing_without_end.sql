-- 0079: the Digital Thread gets a shape that can be pruned.
--
-- `public.digital_thread` is append-only and unbounded; suppression bounds the rate of noise and
-- nothing about the total. This range-partitions it by month so retention is DETACH PARTITION
-- (instant, unlogged, data still queryable) rather than a DELETE over a large audit table.
--
-- It does not relax the append-only trigger and grants no application role DELETE.
--
-- A DEFAULT PARTITION, because a range-partitioned table refuses a row no partition accepts, and
-- the audit INSERT is a trigger on `cells`, `gateways` and `devices`: a missing partition would
-- fail the asset write that caused it. The default converts that outage into an observable
-- untidiness reported by `digital_thread_partition_health`. Its cost is that attaching a new
-- partition scans the default, which the maintenance job keeps empty.
--
-- The conversion is one DO block (one transaction), because half of it applied is an audit table
-- without its trigger or policies. It survives replay: `pg_partitioned_table` is the ledger, and
-- once the table is partitioned the block is skipped.

-- -------------------------------------------------------------------------------------------------
-- 1. Partition maintenance, defined before the conversion that uses it
-- -------------------------------------------------------------------------------------------------
-- A function, because the conversion, the scheduled job and next month's partition must agree on
-- naming and bounds.

-- A partition does not inherit the parent's ACL; it gets the image's default privileges, which
-- hand `service_role` everything including TRUNCATE. The append-only trigger covers DELETE on
-- every partition; it does not cover TRUNCATE, which is not a row operation. Every reader goes
-- through the parent, so the correct privilege set on a partition is none at all.
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

  -- Comments are carried across, not restated: a COMMENT lives on the object, so dropping the old
  -- table drops every comment with it, and a retyped copy here would silently undo an edit to
  -- 0001 or 0077 on the next boot. check-migration-idempotency.mjs refuses a boot-1/boot-2
  -- difference in comments.
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

  -- 2a. The partition key must be NOT NULL: a NULL key matches no range and would land in the
  -- default forever. Backfilled to now() rather than dropped; an audit row with an unknown
  -- timestamp is still evidence.
  UPDATE public.digital_thread SET recorded_at = now() WHERE recorded_at IS NULL;

  -- 2b. Build the partitioned table beside the original. INCLUDING DEFAULTS carries the nextval()
  -- default on `id`; INCLUDING CONSTRAINTS carries the two CHECKs. Indexes, the primary key,
  -- triggers, policies and grants are rebuilt explicitly below, one at a time rather than with
  -- INCLUDING ALL, so anything added to the table later fails a test instead of being half-copied.
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

  -- 2d. Copy. No trigger exists on the new table yet, so stamp_audit_domain() cannot restate what
  -- an old row is allowed to say. The stored value is the record.
  INSERT INTO public.digital_thread_partitioned
    SELECT * FROM public.digital_thread;

  SELECT count(*) INTO v_rows_after FROM public.digital_thread_partitioned;
  IF v_rows_after <> v_rows_before THEN
    RAISE EXCEPTION '0079: copied % row(s) of % -- refusing to swap', v_rows_after, v_rows_before;
  END IF;

  -- 2e. Detach the sequence: 0001 declares it OWNED BY digital_thread.id, so DROP TABLE would take
  -- it down. Re-owned by the new column below; the sequence object is never recreated.
  ALTER SEQUENCE public.digital_thread_id_seq OWNED BY NONE;

  -- 2f. Swap ------------------------------------------------------------------------------------
  ALTER TABLE public.digital_thread RENAME TO digital_thread_preconversion;
  ALTER TABLE public.digital_thread_partitioned RENAME TO digital_thread;
  DROP TABLE public.digital_thread_preconversion;

  ALTER SEQUENCE public.digital_thread_id_seq OWNED BY public.digital_thread.id;

  -- 2g. Rebuild everything LIKE did not carry. Names are reused exactly, so 0001's guarded PK and
  -- FK blocks and its CREATE INDEX IF NOT EXISTS skip on every later boot. The primary key gains
  -- `recorded_at` because a partitioned table's unique constraints must contain the partition key;
  -- no FK references this table.
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
-- The column and index comments are carried across inside the block above. This one describes
-- the shape 0079 gives the table.

COMMENT ON TABLE public.digital_thread IS 'Append-only audit of every attributed change to cells, gateways and devices, plus the security lane 0070 added. Range-partitioned by month on recorded_at (0079) so retention is DETACH rather than DELETE. Rows are written only by log_digital_thread_event() and its named siblings; UPDATE and DELETE are refused for every role that is not an owner.';

-- -------------------------------------------------------------------------------------------------
-- 4. Keep the partitions ahead of the writes
-- -------------------------------------------------------------------------------------------------
-- Three months of headroom, so the system survives the job being broken for a quarter. Also
-- called at migration time so a fresh database has its partitions before the first write.

SELECT public.ensure_digital_thread_partitions(3);

SELECT public.ensure_cron_job(
  'digital_thread_partitions',
  '20 3 * * *',
  $job$SELECT public.ensure_digital_thread_partitions(3)$job$
);

-- -------------------------------------------------------------------------------------------------
-- 5. Whether any of the above is actually working
-- -------------------------------------------------------------------------------------------------
-- A cron job that stops is silent, and the default partition makes the consequence silent too.
-- This view is what the Grafana rule reads. `default_rows > 0` is the signal: it cannot happen
-- while the job is working, and a row for August sitting in the default is not detached when
-- August is.

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
