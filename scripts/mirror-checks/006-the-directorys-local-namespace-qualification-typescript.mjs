import { compare, need, read } from './lib.mjs';

// 5. RETIRED BY 0108. `proposable_link_tags()` was dropped with the three link proposal lanes it
// validated for; a link has only ever been attached by the direct edit, which stores `link_tag`
// against no CHECK. The tag vocabulary now lives in EntityLinksModal alone, so there is no second
// copy here to drift from.

// 6. The Directory's local-namespace qualification, TypeScript to Python. `schemas.id` and
// `directory_services.id` are locally minted, and the edge function and `directory_publish.py` both
// attach the qualification; the strings are compared, since two different sentences would read as
// two different claims, and the MQTT half is where it matters most, with no route or documentation
// beside the bytes.
export default function check() {
  const ts = read('supabase/functions/fplus-directory/index.ts');
  const py = read('ingestion/directory_publish.py');
  const tsNote = need(ts, /const LOCAL_SCHEMA_NOTE = "([^"]+)"/, 'LOCAL_SCHEMA_NOTE in fplus-directory/index.ts');
  const pyNote = need(py, /^LOCAL_SCHEMA_NOTE = "([^"]+)"/m, 'LOCAL_SCHEMA_NOTE in directory_publish.py');
  if (tsNote && pyNote) {
    compare('directoryNamespaceNote', 'the local-schema qualification', pyNote[1], tsNote[1]);
  }

  // The service note is a string literal inline in the /v1/service handler rather than a named
  // constant. Checked in the same pair so the second qualification cannot drift.
  const tsService = need(ts, /note: "(Stack service endpoints[^"]+)"/, 'the /v1/service note in fplus-directory/index.ts');
  const pyService = need(py, /^LOCAL_SERVICE_NOTE = "([^"]+)"/m, 'LOCAL_SERVICE_NOTE in directory_publish.py');
  if (tsService && pyService) {
    compare('directoryServiceNote', 'the local-service qualification', pyService[1], tsService[1]);
  }
}
