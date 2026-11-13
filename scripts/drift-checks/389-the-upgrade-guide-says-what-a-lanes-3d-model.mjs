import { fail, pass, read, upgradingGuide } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 389. The upgrade guide says what 0294 does to a replay lane's 3D model, as the file does it. Its
// section says a machine with none takes the lane's model, one with a model keeps it, the older of
// two lanes is the one that moves, and no file is moved, copied or deleted. It lists the lanes that
// hold a model with the join the file moves by, and names the constraint a client meets. The file
// moves in the order the section says, names what it did in a NOTICE, and never touches a file.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const sql = read('supabase/migrations/0294_a_replay_lane_holds_no_3d_model_of_its_own.sql');
  const guide = upgradingGuide();
  const problems389 = [];
  const from = guide.indexOf("\n### From 1.9.0, a replay lane shows its machine's 3D model\n");
  const end = from < 0 ? -1 : guide.indexOf('\n### ', from + 5);
  const section = from < 0 ? '' : guide.slice(from, end < 0 ? undefined : end);
  if (!section) {
    problems389.push('help/site/upgrading.md has no "From 1.9.0, a replay lane shows its machine\'s 3D model" section');
  } else {
    for (const phrase of ['takes the lane\'s model and the lane is cleared', 'the lane\'s is cleared and the device keeps its own',
      'takes the older lane\'s', 'No file is moved, copied or deleted', '`devices_a_replay_lane_has_no_model`', '`0294`']) {
      if (!section.includes(phrase)) problems389.push(`the upgrade guide's lane-model section does not say "${phrase}"`);
    }
    if (!/JOIN public\.devices m ON m\.id = l\.shadow_of\s+WHERE l\.model_3d_path IS NOT NULL/.test(section)) {
      problems389.push('the upgrade guide\'s query does not list the lanes that hold a model by joining on shadow_of');
    }
  }
  if (!/ORDER BY l\.created_at, l\.id/.test(sql)) problems389.push('0294 does not take lanes in the order they were made, so "the older lane\'s" is not what moves');
  if (!/IF FOUND AND v_machine\.shadow_of IS NULL AND v_machine\.model_3d_path IS NULL THEN/.test(sql)) {
    problems389.push('0294 does not move a lane\'s model only to a machine that has none');
  }
  if (!sql.includes('The file stays where it is.') || !sql.includes('The file stays in the bucket.')) {
    problems389.push('0294\'s NOTICEs do not say the file stays');
  }
  if (/storage\.objects/.test(sql.replace(/--[^\n]*/g, '').replace(/'[^']*'/g, ''))) {
    problems389.push('0294 touches storage.objects, but the guide says no file is moved, copied or deleted');
  }
  if (problems389.length) {
    fail('the upgrade guide and 0294 say what happens to a lane\'s 3D model differently:\n' + problems389.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('the upgrade guide says a machine takes its lane\'s 3D model or keeps its own, the older lane\'s moving, and no file touched, as 0294 does');
  }
}
