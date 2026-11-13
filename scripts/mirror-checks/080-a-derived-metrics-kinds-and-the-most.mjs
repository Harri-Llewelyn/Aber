import { compare, lastDefinition, need, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 80. A derived metric's kinds and the most inputs a sum takes, SQL and JavaScript (0267). The shape
// function refuses any kind it does not list and a sum of more inputs than its limit; the Add Derived
// Metric dialog offers DERIVATION_KINDS and stops adding at DERIVED_MAX_INPUTS. A kind the dialog
// offers and the database refuses fails every save; a kind the database admits and the dialog lacks
// can never be added. Compared in order, so the dialog lists them as the function does.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const shape = lastDefinition('CREATE OR REPLACE FUNCTION public.derivation_shape_problem(', '$$;', 'derivation_shape_problem()');
  const js = read('frontend/src/utils/derivedMetric.js');
  const kindsJs = need(js, /export const DERIVATION_KINDS = \[([\s\S]*?)\n\]/, 'DERIVATION_KINDS in utils/derivedMetric.js');
  const maxJs = need(js, /export const DERIVED_MAX_INPUTS = (\d+)/, 'DERIVED_MAX_INPUTS in utils/derivedMetric.js');
  const kindsSql = shape && need(shape.body, /NOT IN \(('counter_rate'[^)]*)\)/, `derivation_shape_problem()'s kinds (${shape.file})`);
  const maxSql = shape && need(shape.body, /c_max_inputs CONSTANT integer := (\d+)/, `derivation_shape_problem()'s input limit (${shape.file})`);
  if (kindsJs && maxJs && kindsSql && maxSql) {
    compare('derivedKinds', `the kinds the dialog offers and the shape function admits (${shape.file})`,
      [...kindsJs[1].matchAll(/id: '([a-z_]+)'/g)].map((m) => m[1]).join(', '),
      [...kindsSql[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).join(', '));
    compare('derivedKinds', `the most inputs a sum takes in the dialog and in the shape function (${shape.file})`, maxJs[1], maxSql[1]);
  }
}
