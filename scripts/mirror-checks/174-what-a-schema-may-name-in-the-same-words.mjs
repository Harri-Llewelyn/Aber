import { compare, lastDefinition, need, problems, read } from './lib.mjs';

// 174. Why a schema may not name a derived metric, in the same words (0336): the database's
// schema_derived_metric_problems(), which refuses the save, and derivedProblems(), which the schema
// editor says it with before the save. A reason the editor words another way sends a person looking for
// a second problem, and one it does not know is a save that fails after it was said to be sound.
// The fixture test-harness/fixtures/device-derived-metrics.json holds which reason each case has; here
// the sentences themselves are compared, each with its values taken out.
export default function check() {
  const sql = lastDefinition('CREATE OR REPLACE FUNCTION public.schema_derived_metric_problems(', '$$;', 'schema_derived_metric_problems()');
  const js = need(read('frontend/src/utils/derivedMetric.js'), /export function derivedProblems\(([\s\S]*?)\n}\n/, 'derivedProblems() in derivedMetric.js');
  if (!sql || !js) return;

  const fromSql = [...sql.body.matchAll(/problem := format\('((?:[^']|'')*)'/g)].map((m) => m[1].replaceAll("''", "'").replaceAll('%s', '{}'));
  const fromJs = [...js[1].matchAll(/say\(`([^`]*)`\)/g)].map((m) => m[1].replace(/\$\{[^}]*\}/g, '{}'));
  if (fromSql.length < 5) {
    problems.push(`schemaDerivedProblems: ${fromSql.length} sentences read from ${sql.file}, so this check is no longer checking anything`);
    return;
  }
  compare('schemaDerivedProblems', `how many reasons the editor and ${sql.file} know`, fromJs.length, fromSql.length);
  for (const [i, sentence] of [...fromSql].sort().entries()) {
    compare('schemaDerivedProblems', 'a reason a schema may not name a derived metric', [...fromJs].sort()[i], sentence);
  }
}
