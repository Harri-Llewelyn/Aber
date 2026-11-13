import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 64b. The i3X queues' byte ceilings have one default in each place that states it.
//
// values.yaml, the template's dig fallback (for --reuse-values), the service's env fallback, the
// registry's own default and the README's configuration table each carry the two numbers.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const values = read('deploy/helm/aber/values.yaml');
  const template = read('deploy/helm/aber/templates/apps/i3x-service.yaml');
  const service = read('i3x/i3x_service.py');
  const registry = read('i3x/subscriptions.py');
  const readme = read('i3x/README.md');
  const KEYS = [
    ['maxQueuedMiBPerPrincipal', 'I3X_MAX_QUEUED_MIB_PER_PRINCIPAL', 'DEFAULT_MAX_QUEUED_BYTES_PER_PRINCIPAL'],
    ['maxQueuedMiB', 'I3X_MAX_QUEUED_MIB', 'DEFAULT_MAX_QUEUED_BYTES'],
  ];
  const faults = [];
  for (const [key, env, constant] of KEYS) {
    const want = (values.match(new RegExp(`^ {2}${key}: (\\d+)$`, 'm')) || [])[1];
    if (!want) { faults.push(`values.yaml has no i3xService.${key}`); continue; }
    const stated = {
      'the template\'s dig fallback': (template.match(new RegExp(`dig "${key}" (\\d+) `)) || [])[1],
      'i3x_service.py': (service.match(new RegExp(`os\\.getenv\\("${env}"\\) or "(\\d+)"`)) || [])[1],
      'subscriptions.py': (registry.match(new RegExp(`^${constant} = (\\d+) \\* MIB$`, 'm')) || [])[1],
      'i3x/README.md': (readme.match(new RegExp(`^\\| \`${env}\` \\| [^|]+ \\| \`(\\d+)\` \\|`, 'm')) || [])[1],
    };
    for (const [where, got] of Object.entries(stated)) {
      if (got !== want) faults.push(`${where} gives ${key} ${got ?? 'no default'}, values.yaml ${want}`);
    }
  }
  if (faults.length) {
    fail('the i3X queue ceilings\' defaults disagree:\n' + faults.map((f) => `        ${f}`).join('\n'));
  } else {
    pass('the i3X queue ceilings have one default in values.yaml, the template, the service, the registry and the README');
  }
}
