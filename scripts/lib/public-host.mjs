/**
 * The one answer `npm run setup` asks for: the hostname or IP a physical gateway reaches this
 * machine on. Two variables are written from it, MQTT_PUBLIC_HOST and SUPABASE_PUBLIC_URL, because
 * both name the same machine and the two functions that read them refuse in-stack values. Blank
 * is a legitimate answer: a stack with no appliances works fully without either, and only remote
 * enrolment is withheld. Nothing here guesses; a wrong host produces an appliance that enrols and
 * then connects to nothing.
 */

/** Names that resolve on the Compose network or on this machine, and nowhere a gateway lives. */
export const IN_STACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'mosquitto', 'supabase-kong']);

/** A bare hostname or IPv4 address. No scheme, port or path: those are added or refused here. */
const HOST_SHAPE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/**
 * Validate an answer. Returns `{ host }` for an acceptable one (blank included, as `''`), or
 * `{ error }` saying why it was refused, in words meant for the terminal.
 */
export function parsePublicHost(answer) {
  const host = String(answer ?? '').trim();
  if (!host) return { host: '' };
  if (/^[a-z]+:\/\//i.test(host) || host.includes('/')) {
    return { error: `'${host}' is a URL. Give the hostname or IP alone; the scheme and port are added.` };
  }
  if (host.includes(':')) {
    return { error: `'${host}' carries a port or is IPv6. Give the hostname or IPv4 address alone.` };
  }
  if (!HOST_SHAPE.test(host)) {
    return { error: `'${host}' is not a hostname or IPv4 address.` };
  }
  if (IN_STACK_HOSTS.has(host.toLowerCase())) {
    return {
      error: `'${host}' resolves only on this machine or inside the stack. An appliance cannot reach it; ` +
        'give the LAN name or IP of this machine, or leave it blank.',
    };
  }
  return { host };
}

/**
 * The two assignments a host produces. The API port is read from the template's SUPABASE_URL, so
 * a changed gateway port is followed rather than pinned twice. Plain http: Compose terminates no
 * TLS on the API port; the chart derives its own URL and never runs this.
 */
export function publicAddressLines(host, template) {
  const port = (template.match(/^SUPABASE_URL=\S*:(\d+)\s*$/m) || [])[1] || '54321';
  return {
    MQTT_PUBLIC_HOST: host,
    SUPABASE_PUBLIC_URL: host ? `http://${host}:${port}` : '',
  };
}

/**
 * Whether a working .env can enrol an appliance, judged the way the two functions judge it.
 * Returns the list of problems, empty when both addresses are usable.
 */
export function publicAddressProblems(values) {
  const problems = [];
  const host = (values.MQTT_PUBLIC_HOST || '').trim();
  if (!host) problems.push('MQTT_PUBLIC_HOST is unset');
  else if (IN_STACK_HOSTS.has(host.toLowerCase())) problems.push(`MQTT_PUBLIC_HOST is '${host}', which resolves only inside the stack`);
  const url = (values.SUPABASE_PUBLIC_URL || '').trim();
  if (!url) problems.push('SUPABASE_PUBLIC_URL is unset');
  else if (/supabase-kong|127\.0\.0\.1|localhost|::1/.test(url)) problems.push(`SUPABASE_PUBLIC_URL is '${url}', which resolves only inside the stack`);
  return problems;
}
