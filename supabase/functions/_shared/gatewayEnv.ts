/**
 * The appliance's .env: the one file that differs per gateway and the only one carrying the
 * enrolment token. Rendered here because two functions hand it out, the ZIP bundle
 * (gateway-bundle) and the one-liner's token-gated fetch (gateway-install), and the appliance's
 * bootstrap.mjs reads one shape. Every name here is read by bootstrap.mjs: ACS_SUPABASE_URL,
 * ACS_SUPABASE_PUBLISHABLE_KEY, ACS_ENROLLMENT_TOKEN, ACS_AGENT_VERSION, ACS_GATEWAY_NAME and
 * NODERED_CREDENTIAL_SECRET.
 */

/**
 * The bundle's own version, stamped into .env, sent back in a header, and recorded on the gateway
 * at enrolment, so the dashboard can say which vintage an appliance runs. Bump when the template
 * changes in a way a deployed appliance would care about.
 */
export const BUNDLE_VERSION = "1.2.0";

/**
 * 32 bytes of hex. Encrypts the appliance's flows_cred.json; generated per bundle so no two
 * appliances share one, and never transmitted anywhere else.
 */
export function newCredentialSecret(): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(32)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

export interface GatewayEnvInput {
  gatewayName: string;
  sparkplugId: string;
  publicUrl: string;
  publishableKey: string;
  token: string;
  expiresAt: string;
  credentialSecret: string;
  /** How the appliance got it, for the header: the ZIP bundle or the installer. */
  via: "bundle" | "installer";
}

/** The .env text, as a real .env so `docker compose up` works with no editing. */
export function renderGatewayEnv(input: GatewayEnvInput): string {
  return `# =============================================================================
# Aber Remote gateway -- ${input.gatewayName}
#
# GENERATED ${new Date().toISOString()} FOR ONE GATEWAY, by the ${input.via}. Not reusable: the
# token below is single-use and bound to ${input.sparkplugId}.
#
# THE TOKEN EXPIRES ${input.expiresAt}. After that, generate a new bundle or a new install
# command from the gateway's page in the dashboard -- regenerating invalidates this one.
# =============================================================================

# The platform, as reached FROM THIS APPLIANCE.
ACS_SUPABASE_URL=${input.publicUrl}

# Public by construction -- the same key every browser running the dashboard holds. It gets the
# enrolment request past the gateway's key check; the token below is what actually authorises it.
ACS_SUPABASE_PUBLISHABLE_KEY=${input.publishableKey}

# SINGLE USE. Redeemed by bootstrap.mjs on first boot and spent thereafter, whether or not that boot
# succeeded. If bootstrap reports the token was RELEASED (a transient broker outage), this same
# value works again -- just start the container.
#
# THERE IS NO BROKER PASSWORD IN THIS FILE, and there must never be one. The appliance obtains its
# own at first boot, which is the whole reason this is a short-lived claim instead of a credential.
ACS_ENROLLMENT_TOKEN=${input.token}

# Encrypts /data/flows_cred.json on the appliance, where the broker password ends up. GENERATED FOR
# THIS APPLIANCE ALONE: a shared value would let one appliance's credential file be decrypted with
# another's .env. Losing it means re-enrolling -- the broker stores only a hash, so the password
# cannot be recovered from either side.
NODERED_CREDENTIAL_SECRET=${input.credentialSecret}

# Recorded on the gateway at enrolment, so the fleet's vintage is visible from the dashboard.
ACS_AGENT_VERSION=${BUNDLE_VERSION}

# Display name only -- used in the Node-RED editor's title and in bootstrap's output. The gateway's
# real identity is its sparkplug_id, which arrives from enrolment and cannot be set here.
ACS_GATEWAY_NAME=${input.gatewayName}
`;
}
