import { fail, pass, read, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 628. The shell and i3X are each given what names the other. A shell's i3X history link is built
// from AAS_I3X_HISTORY_ENDPOINT, which shell.ts reads in aas-export and in aas-api alike, so both
// registry entries in main/index.ts name it (a worker is given only what its entry names) and the chart
// sets it. The i3X server names each device's shell under AAS_BASE_IRI, which the chart must give it
// from the value aas-export is given, or the two would name different shells. The README names both.
// -------------------------------------------------------------------------------------------------
/** A function's entry in main/index.ts's registry, from its name to the line that closes it. */
const entryOf = (registry, name) => {
  const start = registry.indexOf(`\n  "${name}": [`);
  const end = start < 0 ? -1 : registry.indexOf('\n  ],', start);
  return end < 0 ? undefined : registry.slice(start, end);
};

export default function check() {
  const problems628 = [];
  const shell = read('supabase/functions/_shared/aas/shell.ts');
  if (!shell.includes('Deno.env.get("AAS_I3X_HISTORY_ENDPOINT")')) {
    problems628.push('shell.ts no longer reads AAS_I3X_HISTORY_ENDPOINT, so this check is no longer checking anything');
  }
  const registry = read('supabase/functions/main/index.ts');
  for (const name of ['aas-export', 'aas-api']) {
    const entry = entryOf(registry, name);
    if (!entry) problems628.push(`could not read the ${name} entry out of main/index.ts`);
    else if (!entry.includes('"AAS_I3X_HISTORY_ENDPOINT"')) problems628.push(`${name}'s entry in main/index.ts does not name AAS_I3X_HISTORY_ENDPOINT, so its shells name no i3X history`);
  }

  const functions = read('deploy/helm/aber/templates/supabase/functions.yaml');
  if (!functions.includes('- name: AAS_I3X_HISTORY_ENDPOINT\n')) problems628.push('templates/supabase/functions.yaml does not set AAS_I3X_HISTORY_ENDPOINT');
  const base = '- name: AAS_BASE_IRI\n              value: {{ .Values.supabaseFunctions.aas.baseIri | quote }}';
  if (!functions.includes(base)) problems628.push('templates/supabase/functions.yaml no longer sets AAS_BASE_IRI from supabaseFunctions.aas.baseIri');
  if (!read('deploy/helm/aber/templates/apps/i3x-service.yaml').includes(base)) {
    problems628.push("templates/apps/i3x-service.yaml does not set AAS_BASE_IRI from supabaseFunctions.aas.baseIri, so i3X names other shells than aas-export's");
  }
  if (!read('i3x/i3x_service.py').includes('AAS_BASE_IRI = os.getenv("AAS_BASE_IRI")')) problems628.push('i3x_service.py does not read AAS_BASE_IRI');

  const readme = supabaseReadme();
  if (!readme.includes('`AAS_I3X_HISTORY_ENDPOINT`')) problems628.push('supabase/README.md does not name AAS_I3X_HISTORY_ENDPOINT');
  if (!read('i3x/README.md').includes('`aasShellId`')) problems628.push('i3x/README.md does not name aasShellId');

  if (problems628.length) {
    fail(`The shell and i3X are not each given what names the other:\n${problems628.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass('aas-export and aas-api are given AAS_I3X_HISTORY_ENDPOINT, the i3X server the AAS_BASE_IRI they are given, and both READMEs say so');
  }
}
