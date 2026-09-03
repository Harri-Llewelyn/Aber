-- =============================================================================================
-- 0024_asset_description.sql
--
-- An optional free-text `description` on `devices` and `gateways`.
--
-- WHY IT DID NOT EXIST, AND WHAT REPLACED IT. Both tables carried a `name` and nothing else a human
-- could write. The edit forms filled the gap with read-only identifier blocks -- Sparkplug id,
-- internal UUID -- which is why they were three fields long and only one of them was editable. Those
-- identifiers are on the context drawer beside every other fact about the asset; repeating them
-- inside a form whose purpose is to change things presented them as though they could be changed.
--
-- FREE TEXT, DELIBERATELY, AND IT IS THE ONLY FREE-TEXT COLUMN ON EITHER TABLE. Everything else is
-- either an identifier, an enum with a CHECK, or a foreign key -- because this platform's recurring
-- failure is a semantic hidden in a string somebody typed. This column is exempt precisely because
-- it carries NO semantics: nothing reads it, nothing joins on it, nothing branches on it. It is a
-- note for the next engineer ("spindle rebuilt 2026-03, runs hot"), which is the one thing a
-- constrained vocabulary cannot express.
--
-- If anything ever starts PARSING it, that is the signal to give the concept a column of its own.
--
-- NOT SURFACED IN THE AAS EXPORT. A shell's descriptive text belongs in the IDTA Digital Nameplate
-- (`device_nameplate`, migration 0011), which has typed fields with published IRDIs behind them.
-- Exporting an operator's free-text note as a nameplate property would assert a meaning for it that
-- nobody agreed to -- the same objection that keeps `AssetSparkplugId` from carrying an invented
-- semanticId.
--
-- ---------------------------------------------------------------------------------------------
-- ADD COLUMN IF NOT EXISTS, and no default. The absence of a description and an empty description
-- are the same thing to every reader, so NULL is the honest representation of both -- a `DEFAULT ''`
-- would make every existing row claim to have been described.
--
-- No length CHECK. A cap would have to be a number invented here, and the failure it prevents
-- (somebody pasting a log file in) is one PostgREST's request size limit already bounds.
-- ---------------------------------------------------------------------------------------------

SET search_path TO public;

ALTER TABLE public.devices  ADD COLUMN IF NOT EXISTS description text;
ALTER TABLE public.gateways ADD COLUMN IF NOT EXISTS description text;

COMMENT ON COLUMN public.devices.description IS
  'Optional operator note. Free text, carries no semantics, and is read by nothing -- typed identification belongs in device_nameplate.';
COMMENT ON COLUMN public.gateways.description IS
  'Optional operator note. Free text, carries no semantics, and is read by nothing.';


-- ---------------------------------------------------------------------------------------------
-- NO NEW GRANT OR POLICY, and that is worth stating rather than leaving as an absence.
--
-- RLS policies on both tables are row-scoped (`USING (true)` for authenticated readers, writes gated
-- by role), not column-scoped, so a new column inherits the existing posture exactly. Adding a
-- policy here would create a second thing to keep in step with the first.
--
-- The column IS therefore editable by whoever may already edit the row, which is the intent: a
-- description is the least dangerous thing on either table.
-- ---------------------------------------------------------------------------------------------

-- Self-check. Both columns, both nullable, and no CHECK smuggled in by a later edit.
DO $$
DECLARE
  v_missing TEXT;
BEGIN
  SELECT string_agg(t, ', ' ORDER BY t) INTO v_missing
    FROM unnest(ARRAY['devices', 'gateways']) AS t
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = t AND column_name = 'description'
   );

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '0024 self-check: description column missing on %', v_missing;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name IN ('devices', 'gateways')
       AND column_name = 'description' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION
      '0024 self-check: description is NOT NULL somewhere. Absent and empty are the same thing to '
      'every reader of this column, so NULL has to be allowed';
  END IF;

  RAISE NOTICE '0024 self-check passed: devices.description and gateways.description present and nullable.';
END $$;

NOTIFY pgrst, 'reload schema';
