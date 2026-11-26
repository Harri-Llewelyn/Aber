import { compare, lastDefinition, need, problems, read } from './lib.mjs';

// 182. What a submodel template asks of a schema built from it, said the same way twice (0342): the
// database's schema_template_problems(), which refuses the save, and templateProblems(), which the schema
// editor says it with before the save; and the elements a metric can fill and the cardinalities a template
// requires, in schema_template_elements() and template_required_paths() and in utils/idtaTemplates.js. The
// fixture test-harness/fixtures/schema-template-elements.json holds what each rule answers; here the
// sentences and the two lists themselves are compared.
export default function check() {
  const source = read('frontend/src/utils/idtaTemplates.js');
  const sqlProblems = lastDefinition('CREATE OR REPLACE FUNCTION public.schema_template_problems(', '$$;', 'schema_template_problems()');
  const sqlFill = lastDefinition('CREATE OR REPLACE FUNCTION public.schema_template_elements(', '$$;', 'schema_template_elements()');
  const sqlRequired = lastDefinition('CREATE OR REPLACE FUNCTION public.template_required_paths(', '$$;', 'template_required_paths()');
  const js = need(source, /\nexport function templateProblems\(([\s\S]*?)\n}\n/, 'templateProblems() in idtaTemplates.js');
  const fillable = need(source, /export const FILLABLE_MODEL_TYPES = Object\.freeze\(\[([^\]]*)\]\)/, 'FILLABLE_MODEL_TYPES in idtaTemplates.js');
  const required = need(source, /export const REQUIRED_CARDINALITIES = Object\.freeze\(\[([^\]]*)\]\)/, 'REQUIRED_CARDINALITIES in idtaTemplates.js');
  if (!sqlProblems || !sqlFill || !sqlRequired || !js || !fillable || !required) return;

  const fromSql = [...sqlProblems.body.matchAll(/problem := format\('([^']*(?:''[^']*)*)'/g)]
    .map((m) => m[1].replaceAll("''", "'").replaceAll('%s', '{}'));
  const fromJs = [...js[1].matchAll(/`([^`]*)`/g)].map((m) => m[1].replace(/\$\{[^}]*\}/g, '{}'));
  if (fromSql.length < 3) {
    problems.push(`templateProblems: ${fromSql.length} sentences read from ${sqlProblems.file}, so this check is no longer checking anything`);
    return;
  }
  compare('templateProblems', `the reasons, in order, of the editor and ${sqlProblems.file}`, JSON.stringify(fromJs), JSON.stringify(fromSql));

  const list = (text) => [...text.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]).sort().join(', ');
  const types = (body) => need(body, /e\.model_type IN \(([^)]*)\)/, 'the model types a metric can fill');
  const fillSql = types(sqlFill.body);
  const requiredTypes = types(sqlRequired.body);
  const cardinalities = need(sqlRequired.body, /e\.cardinality IN \(([^)]*)\)/, 'the cardinalities a template requires');
  if (!fillSql || !requiredTypes || !cardinalities) return;
  compare('templateElementFill', `the elements a metric can fill, and ${sqlFill.file}'s`, list(fillable[1]), list(fillSql[1]));
  compare('requiredTemplatePaths', `the elements a metric can fill, and ${sqlRequired.file}'s`, list(fillable[1]), list(requiredTypes[1]));
  compare('requiredTemplatePaths', `the cardinalities a template requires, and ${sqlRequired.file}'s`, list(required[1]), list(cardinalities[1]));
}
