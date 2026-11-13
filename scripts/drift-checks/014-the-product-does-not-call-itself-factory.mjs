import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 14. The product does not call itself Factory+.
//
// Factory+ is a real external framework this stack implements, and every reference to it as a
// framework is correct: `fplus-directory` serves the Factory+ Directory contract, ingestion.py
// reads the Factory+ payload marker. What is checked is the product naming itself Factory+ in
// the strings a user reads, scoped to the files that carry product identity with a per-file
// reason.
// -------------------------------------------------------------------------------------------------
export default function check() {
  /** file -> why this file's prose is product identity rather than a framework reference. */
  const BRANDED_SURFACES = {
    'grafana/grafana.ini':
      'the [auth.generic_oauth] `name` is the literal text on the Grafana login button',
    'frontend/src/pages/OAuthConsent.jsx':
      'the OAuth consent screen, which names the identity a user is being asked to share',
    'deploy/helm/aber/values.yaml':
      'supabaseStudio.organizationName is displayed in Studio',
    'deploy/k8s/internal-ca.yaml':
      "the root's commonName and organisation are what every trust store in the plant displays",
    'deploy/helm/aber/templates/NOTES.txt':
      'Helm prints it after every install and upgrade, and its first line names the product',
    // Swagger UI renders info.title as the page heading. Whole-file, because every other Factory+
    // reference in this repository is to the framework and belongs in docs/openapi.yaml, which is
    // deliberately not listed.
    'docs/i3x-openapi.yaml':
      'Swagger UI renders info.title as the heading of the published i3X specification',
    'i3x/address_space.py':
      'the i3X displayName and namespace strings are what an i3X client shows for this site',
  };

  const branded = [];
  for (const [file, why] of Object.entries(BRANDED_SURFACES)) {
    let text;
    try {
      text = read(file);
    } catch {
      branded.push(`${file} is listed as a branded surface but does not exist -- update the list`);
      continue;
    }
    if (/Factory\+/.test(text)) {
      const lines = text
        .split('\n')
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => /Factory\+/.test(line))
        .map(([n]) => n);
      branded.push(
        `${file} still calls the product "Factory+" (line${lines.length > 1 ? 's' : ''} ` +
          `${lines.join(', ')}) -- ${why}`
      );
    }
  }

  // The Grafana OAuth client's display name lives in the seed, not in a config file, and it is what
  // the consent screen puts in its heading. DO UPDATE on client_name means the literal here IS the
  // live value on every boot, so checking the literal checks what a user sees.
  const seed = read('supabase/seed.sql') + read('supabase/migrations/0002_seed_data.sql');
  const clientNames = [...seed.matchAll(/'((?:Factory\+|Aber)[^']*)'/g)].map((m) => m[1]);
  const misnamed = clientNames.filter((n) => n.startsWith('Factory+'));
  if (misnamed.length) {
    branded.push(
      `an OAuth client is registered as ${misnamed.map((n) => `"${n}"`).join(', ')} -- that string ` +
        'is the heading on the consent screen. Node-RED\'s client is already "Aber Node-RED".'
    );
  }

  if (branded.length) {
    for (const b of branded) fail(b);
    fail(
      'Factory+ is a framework this stack IMPLEMENTS, and every reference to it as one is correct --\n' +
        '      the Directory adapter, the metric-name format, the Sparkplug payload marker. What must not\n' +
        '      survive is the product naming ITSELF Factory+ in text a user reads. archived migration 0014 renamed\n' +
        '      the semantic identifiers and left the prose behind; users reported the result twice.'
    );
  } else {
    pass(
      `all ${Object.keys(BRANDED_SURFACES).length} user-facing branded surfaces name the product ` +
        'Aber, with framework references left intact'
    );
  }
}
