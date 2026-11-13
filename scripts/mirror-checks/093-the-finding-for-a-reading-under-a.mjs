import { compare, need, read } from './lib.mjs';

// 93. The finding for a reading under a derived metric's name, Python and JavaScript. Ingestion
// records code and detail (conformance.py's DERIVED_NAME_CODE and DERIVED_NAME_DETAIL); Validate
// Payload reports the same finding from the names the catalogue holds (DERIVED_NAME in
// utils/payloadConformance.js). A dialog saying other words than the Audit Trail row it predicts
// describes a finding nobody will ever see recorded. The fixture holds the two to one answer for the
// cases it lists; this holds the words themselves, which a case can leave stale.
export default function check() {
  const py = read('ingestion/conformance.py');
  const js = read('frontend/src/utils/payloadConformance.js');
  const codePy = need(py, /^DERIVED_NAME_CODE = "([a-z_]+)"$/m, 'DERIVED_NAME_CODE in conformance.py');
  const detailPy = need(py, /^DERIVED_NAME_DETAIL = \(\s*"([^"]+)"\s*\)$/m, 'DERIVED_NAME_DETAIL in conformance.py');
  const pairJs = need(js, /^const DERIVED_NAME = \['([a-z_]+)', '([^']+)'\]$/m, 'DERIVED_NAME in utils/payloadConformance.js');
  if (codePy && detailPy && pairJs) {
    compare('derivedNameFinding', 'the code of the finding for a derived name (conformance.py)', pairJs[1], codePy[1]);
    compare('derivedNameFinding', 'the words of the finding for a derived name (conformance.py)', pairJs[2], detailPy[1]);
  }
}
