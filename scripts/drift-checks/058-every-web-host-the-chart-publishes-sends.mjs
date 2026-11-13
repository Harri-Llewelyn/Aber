import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 58. Every web host the chart publishes sends Strict-Transport-Security under https. The header
// carries no includeSubDomains, so each sibling host sends its own. Each backend aber.ingressRoutes
// names is the gateway (its listeners are check-gateway-surface.mjs's), Grafana (a setting of its
// own), a component whose template sets ABER_STRICT_TRANSPORT_SECURITY from
// aber.strictTransportSecurity and whose own code reads that variable, or an exemption with its reason.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const HELPERS = 'deploy/helm/aber/templates/_helpers.tpl';
  const T = 'deploy/helm/aber/templates/';
  const ENV = /- name: ABER_STRICT_TRANSPORT_SECURITY\n\s+value: \{\{ include "aber\.strictTransportSecurity" \. \| quote \}\}/;
  const SENDERS = {
    'supabase-envoy': { template: `${T}supabase/envoy.yaml`, needs: [/include "aber\.strictTransportSecurity"/] },
    grafana: { template: `${T}obs/grafana.yaml`, needs: [/GF_SECURITY_STRICT_TRANSPORT_SECURITY_MAX_AGE_SECONDS\n\s+value: \{\{ include "aber\.hstsMaxAgeSeconds"/] },
    frontend: { template: `${T}apps/frontend.yaml`, needs: [ENV], code: ['frontend/nginx.conf'] },
    'node-red': { template: `${T}apps/node-red.yaml`, needs: [ENV], code: ['node-red/node-red-init.mjs'] },
    'i3x-service': { template: `${T}apps/i3x-service.yaml`, needs: [ENV], code: ['i3x/i3x_service.py'] },
    'swagger-ui': { template: `${T}obs/swagger-ui.yaml`, needs: [ENV], code: ['swagger-ui/aber-headers.conf.template'] },
    // MQTT over WebSockets serves no page, and Mosquitto adds no header to its upgrade response.
    mosquitto: { exempt: true },
  };
  const helpers = read(HELPERS);
  const start = helpers.indexOf('{{- define "aber.ingressRoutes" -}}');
  const end = helpers.indexOf('{{- define', start + 1);
  const block = start < 0 ? '' : helpers.slice(start, end < 0 ? undefined : end);
  const services = [...new Set([...block.matchAll(/"service" "([a-z0-9-]+)"/g)].map((m) => m[1]))];
  const wrong = [];
  for (const service of services) {
    const sender = SENDERS[service];
    if (!sender) {
      wrong.push(`aber.ingressRoutes publishes ${service}, which no entry here says sends Strict-Transport-Security. ` +
        'Give its container ABER_STRICT_TRANSPORT_SECURITY from aber.strictTransportSecurity, send it, and list it in check 58');
      continue;
    }
    if (sender.exempt) continue;
    const template = read(sender.template);
    if (!sender.needs.every((re) => re.test(template))) {
      wrong.push(`${sender.template} no longer hands ${service} the value aber.strictTransportSecurity renders`);
    }
    for (const file of sender.code || []) {
      if (!read(file).includes('ABER_STRICT_TRANSPORT_SECURITY')) wrong.push(`${file} no longer reads ABER_STRICT_TRANSPORT_SECURITY, so ${service} sends no header`);
    }
  }
  if (!read('swagger-ui/Dockerfile').includes('aber-headers.conf.template')) {
    wrong.push('swagger-ui/Dockerfile no longer copies aber-headers.conf.template, so the documentation host sends no header');
  }
  for (const stale of Object.keys(SENDERS).filter((s) => !services.includes(s))) {
    wrong.push(`check 58 lists ${stale}, which aber.ingressRoutes no longer publishes; remove it`);
  }
  if (!services.length) {
    fail(`check 58 found no "service" in ${HELPERS}'s aber.ingressRoutes, so it checks nothing`);
  } else if (wrong.length) {
    fail('a host the chart publishes may not send Strict-Transport-Security under https:\n' + wrong.map((w) => `        ${w}`).join('\n'));
  } else {
    const exempt = services.filter((s) => SENDERS[s].exempt);
    pass(`${services.length - exempt.length} of the ${services.length} backends the Ingress publishes send ` +
      `Strict-Transport-Security under https; ${exempt.join(', ')} serves no page`);
  }
}
