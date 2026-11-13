import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 64. The i3X server answers browsers from the gateway's origin list, and its README states the
// methods and headers it allows.
//
// Its route bypasses the gateway, so the chart hands it aber.corsOrigins itself. A second list, or
// none, would let the two disagree about which pages may call the platform.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const template = 'deploy/helm/aber/templates/apps/i3x-service.yaml';
  const code = read('i3x/i3x_service.py');
  const readme = read('i3x/README.md');
  const faults = [];
  if (!/- name: I3X_CORS_ORIGINS\n\s+value: \{\{ include "aber\.corsOrigins" \. \| quote \}\}/.test(read(template))) {
    faults.push(`${template} does not set I3X_CORS_ORIGINS from aber.corsOrigins`);
  }
  if (!/os\.getenv\("I3X_CORS_ORIGINS"/.test(code)) {
    faults.push('i3x/i3x_service.py does not read I3X_CORS_ORIGINS');
  }
  for (const name of ['CORS_ALLOW_METHODS', 'CORS_ALLOW_HEADERS']) {
    const value = (code.match(new RegExp(`^${name} = "([^"]+)"$`, 'm')) || [])[1];
    const header = `Access-Control-Allow-${name === 'CORS_ALLOW_METHODS' ? 'Methods' : 'Headers'}`;
    if (!value) faults.push(`i3x/i3x_service.py has no ${name} string literal, so check 64 cannot read it`);
    else if (!readme.includes(`\`${header}: ${value}\``)) faults.push(`i3x/README.md does not say \`${header}: ${value}\``);
  }
  if (faults.length) {
    fail('the i3X server\'s browser origins or its README have drifted:\n' + faults.map((f) => `        ${f}`).join('\n'));
  } else {
    pass('the i3X server takes its browser origins from aber.corsOrigins, and its README states what it allows');
  }
}
