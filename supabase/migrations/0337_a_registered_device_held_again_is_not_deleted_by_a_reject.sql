-- 0337: A registered device held again is not deleted by a Reject.
--
-- Quarantine holds two kinds of device: one Aber has never admitted, and a registered one held again
-- (requarantined_at, 0328). Reject deleted the row of either, and a registered device takes its schemas,
-- nameplate, links, captures and 3D model with it. A device that is not archived leaves no tombstone
-- that names what went, and the hold can come from another gateway's message.
--
--   * A BEFORE DELETE trigger refuses to delete a device that is in Quarantine, was registered before it
--     was held, and is not archived, with a sentence a person reads: approve it on the Quarantine tab, or
--     archive it and then delete it from Entities.
--   * The owner's own functions are not refused: they run as the table's owner. The merge refuses such a
--     device itself (0328), and the nightly purge deletes only archived devices.
--   * The ordinary path is untouched: an archived device is deleted as before, by Permanent Delete or the
--     purge, and so is a device nobody registered, by Reject or a merge.
--
-- The dashboard offers no Reject for such a device. Its way out is Approve & Onboard.
--
-- Reasoning: supabase/README.md, "A registered device held again is not deleted by a Reject (0337)".
-- Idempotent.

BEGIN;

CREATE OR REPLACE FUNCTION public.refuse_deleting_a_registered_held_device() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  -- Not SECURITY DEFINER, so current_user is the caller's: the table's owner only inside the owner's
  -- own functions, or on the owner's own connection.
  IF OLD.is_quarantined IS TRUE AND OLD.requarantined_at IS NOT NULL AND OLD.is_archived IS NOT TRUE
     AND current_user <> (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID) THEN
    RAISE EXCEPTION '"%" is a registered device held in Quarantine again, so it was not deleted. Approve it on the Quarantine tab to let it in where it was, with its schemas, nameplate and links. Or archive it, and then delete it from Entities.',
      OLD.name USING ERRCODE = 'raise_exception';
  END IF;
  RETURN OLD;
END $$;

ALTER FUNCTION public.refuse_deleting_a_registered_held_device() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.refuse_deleting_a_registered_held_device() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.refuse_deleting_a_registered_held_device() IS 'Refuses to delete a device that is in Quarantine, was registered before it was held (requarantined_at) and is not archived, unless the caller is the table''s owner: the owner''s own functions, such as the merge and the nightly purge. Its way out is Approve & Onboard; to delete it, archive it first (0337).';

SELECT public.replay_trigger('public.devices', 'trg_devices_held_registered_device_is_kept', $ddl$
CREATE TRIGGER trg_devices_held_registered_device_is_kept BEFORE DELETE ON public.devices FOR EACH ROW EXECUTE FUNCTION public.refuse_deleting_a_registered_held_device();
$ddl$);

COMMIT;

-- -------------------------------------------------------------------------------------------------
-- What this file did, and nothing wider.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_fn  regprocedure := 'public.refuse_deleting_a_registered_held_device()'::regprocedure;
  v_src text;
  v_reads text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'public.devices'::regclass
                    AND t.tgname = 'trg_devices_held_registered_device_is_kept'
                    AND t.tgfoid = v_fn
                    AND t.tgenabled = 'O' AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION '0337: public.devices has no enabled trg_devices_held_registered_device_is_kept';
  END IF;

  -- Run as its caller, or every caller would be the owner and nothing would be refused.
  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) THEN
    RAISE EXCEPTION '0337: refuse_deleting_a_registered_held_device() is SECURITY DEFINER';
  END IF;

  v_src := (SELECT prosrc FROM pg_proc WHERE oid = v_fn);
  FOREACH v_reads IN ARRAY ARRAY['OLD.is_quarantined IS TRUE', 'OLD.requarantined_at IS NOT NULL',
                                 'OLD.is_archived IS NOT TRUE', 'current_user <>'] LOOP
    IF position(v_reads IN v_src) = 0 THEN
      RAISE EXCEPTION '0337: refuse_deleting_a_registered_held_device() does not read %', v_reads::text;
    END IF;
  END LOOP;

  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION '0337: an API role may execute refuse_deleting_a_registered_held_device()';
  END IF;
END
$check$;
