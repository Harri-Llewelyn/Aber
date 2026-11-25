-- 0332: A nameplate and an attached schema stay with their device.
--
-- device_nameplate's key and device_submodels' device are a foreign key, device_id, which refuse_key_change()
-- (0325) does not read. A Shopfloor Manager's session could PATCH either to another device. The Audit Trail
-- filed the move under the new device alone, so the first device's lane still showed a nameplate, or a
-- schema attached, that it no longer had.
--
--   * refuse_device_change() refuses an UPDATE that changes device_id, for every role, as 0325 refuses an id:
--     the same code and the same words, naming the device. An UPDATE that sets device_id to the value it has
--     passes, as a whole-row PATCH and an upsert do.
--   * One trigger on each of the two tables, the only ones whose device_id a person's session may UPDATE.
--
-- No role is exempt. No migration and no function that runs as the owner changes either column: a merge from
-- Quarantine deletes the discovered device's rows with it and leaves the target's own.
--
-- Reasoning: supabase/README.md, "A nameplate and an attached schema stay with their device (0332)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The refusal
-- -------------------------------------------------------------------------------------------------
-- A function of its own beside refuse_key_change(), which compares id and names a record by a column of its
-- row. These rows have no name, so the message names the device. TG_ARGV[0] is what the row is, as it reads
-- before that name. The caller reads the name with its own rights, and the id stands in where it may not.
CREATE OR REPLACE FUNCTION public.refuse_device_change() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  v_device text;
BEGIN
  IF NEW.device_id IS NOT DISTINCT FROM OLD.device_id THEN
    RETURN NEW;
  END IF;

  SELECT d.name INTO v_device FROM public.devices d WHERE d.id = OLD.device_id;

  RAISE EXCEPTION 'the device_id of % "%" cannot be changed. Other records and other systems find it by this id.',
    TG_ARGV[0], COALESCE(v_device, OLD.device_id::text)
    USING ERRCODE = 'check_violation',
          HINT = 'Leave device_id out of the change, or send the device_id the record has. To move it, remove it and make it again on the other device.';
END $$;

ALTER FUNCTION public.refuse_device_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_device_change() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.refuse_device_change() IS 'Refuses an UPDATE that changes a row''s device_id, for every role, and names what the row is (its argument) and the device. An UPDATE that sets device_id to the value it has passes. A move is a removal and a new row, which the Audit Trail files under both devices (0332).';

-- -------------------------------------------------------------------------------------------------
-- 2. One trigger per table
-- -------------------------------------------------------------------------------------------------
-- UPDATE OF device_id, so a write that leaves device_id out of its SET list runs none of it.
SELECT public.replay_trigger('public.device_nameplate', 'trg_device_nameplate_device_cannot_change', $ddl$
CREATE TRIGGER trg_device_nameplate_device_cannot_change BEFORE UPDATE OF device_id ON public.device_nameplate FOR EACH ROW EXECUTE FUNCTION public.refuse_device_change('the nameplate of');
$ddl$);

SELECT public.replay_trigger('public.device_submodels', 'trg_device_submodels_device_cannot_change', $ddl$
CREATE TRIGGER trg_device_submodels_device_cannot_change BEFORE UPDATE OF device_id ON public.device_submodels FOR EACH ROW EXECUTE FUNCTION public.refuse_device_change('a schema attached to');
$ddl$);

-- -------------------------------------------------------------------------------------------------
-- 3. Self-check: each table's trigger is there and calls the function, and no API role may call it.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['device_nameplate', 'device_submodels'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                    WHERE t.tgrelid = format('public.%I', v_table)::regclass
                      AND t.tgname = format('trg_%s_device_cannot_change', v_table)
                      AND t.tgfoid = 'public.refuse_device_change()'::regprocedure
                      AND t.tgenabled = 'O' AND NOT t.tgisinternal) THEN
      RAISE EXCEPTION '0332: public.% has no enabled trg_%_device_cannot_change', v_table, v_table;
    END IF;
  END LOOP;

  IF has_function_privilege('anon', 'public.refuse_device_change()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.refuse_device_change()', 'EXECUTE') THEN
    RAISE EXCEPTION '0332: an API role may execute refuse_device_change()';
  END IF;
END
$check$;
