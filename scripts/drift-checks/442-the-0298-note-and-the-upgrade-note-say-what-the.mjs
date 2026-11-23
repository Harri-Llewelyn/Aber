import { fail, pass, read, supabaseReadme, upgradingGuide } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 442. The 0298 section and its upgrade note say what the migration does: the two columns, the trigger
// that sets them and the CHECK it adds, by the names the file declares; the notice a rewritten key
// prints; that the fill is not an Audit Trail event; and, in the upgrade note, that the AAS API answered
// an old id until 1.10.0, that a file holds only the new one, and the eight hex digits and the stat a
// clash is settled by. The migration's header cites its section by title.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems442 = [];
  const FILE = 'supabase/migrations/0298_a_submodel_s_id_follows_its_schema_s_lineage.sql';
  const sql = read(FILE);
  const SECTION = "### A schema's Submodel id follows its lineage (0298)";
  const GUIDE = "### From 1.9.0, a schema's Submodel ids follow its lineage and carry its version";

  if (!sql.includes(`Reasoning: supabase/README.md, "${SECTION.slice(4)}"`)) problems442.push('the migration\'s header does not cite its section by title');
  for (const name of ['lineage_root_id', 'lineage_name', 'trg_schemas_take_their_lineage', 'trg_schemas_rename_their_lineage', 'schemas_lineage_root_id_fkey', 'device_submodels_key_starts_with_a_letter']) {
    if (!sql.includes(name)) problems442.push(`${FILE} does not declare ${name}`);
  }
  if (!sql.includes("RAISE NOTICE '0298: % device_submodels key(s) began with an underscore")) problems442.push('the migration no longer prints the notice the notes name');
  if (!/ALTER TABLE public\.schemas DISABLE TRIGGER trg_schemas_audit_trail;[\s\S]*ALTER TABLE public\.schemas ENABLE TRIGGER trg_schemas_audit_trail;/.test(sql)) {
    problems442.push('the fill no longer keeps the Audit Trail out of it, which the section says');
  }

  const readme = supabaseReadme();
  const at = readme.indexOf(SECTION);
  const section = at < 0 ? '' : readme.slice(at, readme.indexOf('\n### ', at + 4) < 0 ? undefined : readme.indexOf('\n### ', at + 4));
  if (!section) problems442.push(`supabase/README.md (with the notes folded in) has no "${SECTION}" section`);
  for (const phrase of ['lineage_root_id', 'lineage_name', 'trg_schemas_take_their_lineage', 'device_submodels_key_starts_with_a_letter', 'not an Audit Trail event', '0298:', 'submodel_key_clashes']) {
    if (section && !section.includes(phrase)) problems442.push(`the 0298 section does not mention ${phrase}`);
  }

  const guide = upgradingGuide();
  const gat = guide.indexOf(GUIDE);
  const note = gat < 0 ? '' : guide.slice(gat, guide.indexOf('\n### ', gat + 4) < 0 ? undefined : guide.indexOf('\n### ', gat + 4));
  if (!note) problems442.push(`help/site/upgrading.md (with the notes folded in) has no "${GUIDE}" section`);
  for (const phrase of ['1.10.0', 'administration.version', 'submodel_key_clashes', 'eight hex', 'only the new id', '0298:', 'lineage_root_id']) {
    if (note && !note.includes(phrase)) problems442.push(`the upgrade note does not mention ${phrase}`);
  }

  if (problems442.length) {
    fail('the 0298 section, its upgrade note and the migration disagree:\n' + problems442.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('the 0298 section and its upgrade note name the columns, the trigger and the CHECK the migration declares, the notice it prints, the stat and eight hex digits a clash uses, and 1.10.0 for the old ids; the fill keeps the Audit Trail out');
  }
}
