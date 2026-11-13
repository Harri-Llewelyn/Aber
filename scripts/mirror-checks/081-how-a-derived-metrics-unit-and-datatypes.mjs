import { compare, lastDefinition, need, read } from './lib.mjs';

// 81. How a derived metric's unit and datatypes follow its inputs, SQL and JavaScript (0267).
// enforce_derived_metric() sets the unit (an input's unit followed by '/HOUR' for a rate, COUNT for a
// counter with none), reads numbers in a range of Sparkplug codes and states in three, and takes only a
// Double. The dialog shows the unit it will take and offers inputs by the same codes. A unit the dialog
// shows and the database does not set contradicts the row it creates; an input it offers and the
// database refuses fails the save.
export default function check() {
  const trigger = lastDefinition('CREATE OR REPLACE FUNCTION public.enforce_derived_metric(', '$$;', 'enforce_derived_metric()');
  const js = read('frontend/src/utils/derivedMetric.js');
  const suffixJs = need(js, /export const RATE_UNIT_SUFFIX = '([^']+)'/, 'RATE_UNIT_SUFFIX in utils/derivedMetric.js');
  const bareJs = need(js, /export const UNITLESS_COUNTER = '([^']+)'/, 'UNITLESS_COUNTER in utils/derivedMetric.js');
  const typeJs = need(js, /export const DERIVED_DATATYPE = (\d+)/, 'DERIVED_DATATYPE in utils/derivedMetric.js');
  const rangeJs = need(js, /export const NUMBER_DATATYPE_RANGE = \[(\d+), (\d+)\]/, 'NUMBER_DATATYPE_RANGE in utils/derivedMetric.js');
  const statesJs = need(js, /export const STATE_DATATYPES = \[([\d, ]+)\]/, 'STATE_DATATYPES in utils/derivedMetric.js');
  const suffixSql = trigger && need(trigger.body, /c_hour_suffix CONSTANT text := '([^']+)'/, `enforce_derived_metric()'s rate suffix (${trigger.file})`);
  const bareSql = trigger && need(trigger.body, /coalesce\(v_unit, '([^']+)'\) \|\| c_hour_suffix/, `enforce_derived_metric()'s unit for a counter with none (${trigger.file})`);
  const typeSql = trigger && need(trigger.body, /IF NEW\.datatype <> (\d+) THEN/, `enforce_derived_metric()'s datatype (${trigger.file})`);
  const rangeSql = trigger && need(trigger.body, /v_in\.datatype NOT BETWEEN (\d+) AND (\d+) THEN/, `enforce_derived_metric()'s numbers (${trigger.file})`);
  const statesSql = trigger && need(trigger.body, /v_in\.datatype NOT IN \(([\d, ]+)\) THEN/, `enforce_derived_metric()'s states (${trigger.file})`);
  if (suffixJs && bareJs && typeJs && rangeJs && statesJs && suffixSql && bareSql && typeSql && rangeSql && statesSql) {
    compare('derivedUnit', `what follows a rate's unit (${trigger.file})`, suffixJs[1], suffixSql[1]);
    compare('derivedUnit', `the unit of a counter that has none (${trigger.file})`, bareJs[1], bareSql[1]);
    compare('derivedDatatypes', `a derived metric's datatype (${trigger.file})`, typeJs[1], typeSql[1]);
    compare('derivedDatatypes', `the numbers a rate and a sum read (${trigger.file})`, `${rangeJs[1]}-${rangeJs[2]}`, `${rangeSql[1]}-${rangeSql[2]}`);
    compare('derivedDatatypes', `what a time in state reads (${trigger.file})`,
      statesJs[1].replace(/\s/g, ''), statesSql[1].replace(/\s/g, ''));
  }
}
