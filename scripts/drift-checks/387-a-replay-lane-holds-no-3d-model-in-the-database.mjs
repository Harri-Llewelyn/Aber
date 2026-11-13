import { fail, pass, read, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 387. A replay lane holds no 3D model, in the database. 0294 moves what a lane held before it adds
// devices_a_replay_lane_has_no_model, and adds it NOT VALID and validates it. The same file declares
// is_replay_lane_model_path(), a function that reads devices as the caller and only authenticated executes. In
// storage-policies.sql the asset-3d-models INSERT policy and both halves of its UPDATE policy end by
// calling it, and the SELECT and DELETE policies do not, so a machine can still remove a model that is
// stored under its lane's id. supabase/README.md has the 0294 section, and it names the three.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const sql = read('supabase/migrations/0294_a_replay_lane_holds_no_3d_model_of_its_own.sql');
  const policies = read('supabase/storage-policies.sql');
  const problems387 = [];
  const move = sql.indexOf('DO $move$');
  const add = sql.indexOf('ADD CONSTRAINT devices_a_replay_lane_has_no_model');
  const validate = sql.indexOf('VALIDATE CONSTRAINT devices_a_replay_lane_has_no_model');
  if (move < 0 || add < 0 || validate < 0 || !(move < add && add < validate)) {
    problems387.push('0294 does not move the lanes\' models, then add the CHECK, then validate it');
  }
  if (!/ADD CONSTRAINT devices_a_replay_lane_has_no_model\s+CHECK \(\(\(shadow_of IS NULL\) OR \(model_3d_path IS NULL\)\)\) NOT VALID/.test(sql)) {
    problems387.push('0294 does not add devices_a_replay_lane_has_no_model as CHECK (shadow_of IS NULL OR model_3d_path IS NULL), NOT VALID');
  }
  const declared = sql.match(/CREATE OR REPLACE FUNCTION public\.is_replay_lane_model_path\(p_name text\)[\s\S]*?AS \$\$/)?.[0];
  if (!declared || /SECURITY DEFINER/.test(declared)) {
    problems387.push('0294 does not declare is_replay_lane_model_path(text), or declares it SECURITY DEFINER, which the schema lint would flag');
  }
  if (!sql.includes('REVOKE ALL ON FUNCTION public.is_replay_lane_model_path(text) FROM PUBLIC, anon, service_role;')
      || !sql.includes('GRANT EXECUTE ON FUNCTION public.is_replay_lane_model_path(text) TO authenticated;')) {
    problems387.push('0294 does not leave is_replay_lane_model_path(text) to authenticated alone');
  }
  const refusal = 'AND NOT public.is_replay_lane_model_path(storage.objects.name)';
  // From the policy's own line to the first closing ");" at the end of a line.
  const policy = (name) => {
    const from = policies.indexOf(`CREATE POLICY "${name}" ON storage.objects`);
    const to = from < 0 ? -1 : policies.indexOf(');\n', from);
    return to < 0 ? '' : policies.slice(from, to + 2);
  };
  const count = (text) => text.split(refusal).length - 1;
  for (const [name, want] of [['asset_3d_models_insert_privileged', 1], ['asset_3d_models_update_privileged', 2],
    ['asset_3d_models_select_privileged', 0], ['asset_3d_models_delete_privileged', 0]]) {
    const text = policy(name);
    if (!text) problems387.push(`storage-policies.sql has no ${name} policy`);
    else if (count(text) !== want) {
      problems387.push(`${name} asks is_replay_lane_model_path() ${count(text)} time(s), not ${want}${want ? '' : ', so a machine could not remove a model stored under its lane\'s id'}`);
    }
  }
  const readme = supabaseReadme();
  const from = readme.indexOf('\n### A replay lane holds no 3D model of its own (0294)\n');
  const section = from < 0 ? '' : readme.slice(from, readme.indexOf('\n### ', from + 5));
  if (!section) problems387.push('supabase/README.md has no "A replay lane holds no 3D model of its own (0294)" section');
  for (const word of ['devices_a_replay_lane_has_no_model', 'is_replay_lane_model_path()', 'storage-policies.sql']) {
    if (section && !section.includes(word)) problems387.push(`the 0294 section does not name ${word}`);
  }
  if (!sql.includes('Reasoning: supabase/README.md, "A replay lane holds no 3D model of its own (0294)"')) {
    problems387.push('0294\'s header does not cite its README section by title');
  }
  if (problems387.length) {
    fail('a replay lane\'s 3D model is held out in the database, the storage policy and the README differently:\n' + problems387.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('0294 moves a lane\'s model, then holds none with devices_a_replay_lane_has_no_model, and the asset-3d-models INSERT and UPDATE policies refuse an object under a lane through is_replay_lane_model_path(), as the README says');
  }
}
