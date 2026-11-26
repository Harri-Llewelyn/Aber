-- 0333: A link's kind is one of four.
--
-- links.entity_type says what kind of thing a link is on: an area, a cell, a device or a gateway. Nothing in
-- the database held it to those words. The dashboard sends no other. A script could, and such a row is on no
-- page, because each page reads the links of its own kind.
--
--   * links_entity_type_known holds the column to the four words, for every writer.
--   * A row with another word is neither renamed nor deleted. While there is one, the constraint is NOT VALID:
--     new rows and changed ones are held, and this one stands. Each boot prints a WARNING that names it.
--   * Where there is none, the constraint is validated. A row put right by hand is validated on the next boot.
--
-- Reasoning: supabase/README.md, "A link's kind is one of four (0333)". Idempotent.

-- -------------------------------------------------------------------------------------------------
-- 1. The CHECK
-- -------------------------------------------------------------------------------------------------
-- Added only where it is missing, so a later file that widens it is not undone by the next boot. Added NOT
-- VALID first, so a row it would refuse cannot stop the chain, and from then on no other can arrive. A boot
-- that finds it validated reads no link.
DO $kind$
DECLARE
  v_link record;
  v_odd  boolean := false;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'links_entity_type_known'
                    AND conrelid = 'public.links'::regclass) THEN
    ALTER TABLE public.links
        ADD CONSTRAINT links_entity_type_known CHECK ((entity_type = ANY (ARRAY['area'::text, 'cell'::text, 'device'::text, 'gateway'::text]))) NOT VALID;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conname = 'links_entity_type_known'
                AND conrelid = 'public.links'::regclass
                AND NOT convalidated) THEN
    FOR v_link IN
      SELECT l.id, l.entity_type, l.entity_id
        FROM public.links l
       WHERE l.entity_type <> ALL (ARRAY['area', 'cell', 'device', 'gateway'])
       ORDER BY l.id
    LOOP
      v_odd := true;
      RAISE WARNING '0333: the link % is on % with the id %, which is no kind a link can be on, so no page shows it. Set its entity_type to area, cell, device or gateway, or delete the row. The next boot checks it again.',
        v_link.id, quote_literal(left(v_link.entity_type, 200)), quote_literal(left(v_link.entity_id, 200));
    END LOOP;

    IF NOT v_odd THEN
      ALTER TABLE public.links VALIDATE CONSTRAINT links_entity_type_known;
    END IF;
  END IF;
END
$kind$;

COMMENT ON CONSTRAINT links_entity_type_known ON public.links IS
  'A link is on an area, a cell, a device or a gateway. NOT VALID while a row from an earlier release holds another '
  'word: each boot names that row, and the first boot that finds none validates it (0333).';

-- -------------------------------------------------------------------------------------------------
-- 2. Self-check: the constraint is there and admits the four words. Whether it is validated is the site's
--    rows, so it is not asserted.
-- -------------------------------------------------------------------------------------------------
DO $check$
DECLARE
  v_has  text := public.live_constraint_definition('public.links'::regclass, 'links_entity_type_known');
  v_word text;
BEGIN
  IF v_has IS NULL THEN
    RAISE EXCEPTION '0333: public.links has no links_entity_type_known';
  END IF;
  FOREACH v_word IN ARRAY ARRAY['area', 'cell', 'device', 'gateway'] LOOP
    IF strpos(v_has, quote_literal(v_word) || '::text') = 0 THEN
      RAISE EXCEPTION '0333: links_entity_type_known does not admit %: %', v_word, v_has;
    END IF;
  END LOOP;
END
$check$;
